/**
 * Hidden suite for `TokenCipher` and `sameKeyId`.
 *
 * Keys are fixed: K1 is bytes 0..31, K2 bytes 32..63, K3 bytes 255..224 (whose
 * base64 uses `+` and `/`, so it has a distinct URL-safe spelling). Where the
 * spec defines the ciphertext exactly (AES-256-GCM over the raw key, no AAD,
 * `v1:` + base64 of iv ‖ tag ‖ data), expected values are computed with
 * `node:crypto` from a fixed IV.
 */

import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { test } from "node:test";

import {
  createTokenCipher,
  sameKeyId,
  TokenCipherError,
} from "../../src/cipher.js";
import type { TokenCipher } from "../../src/cipher.js";

const K1 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const K2 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";
const K1_ID = "0ebcb5deb52c";
const K2_ID = "e32ee159945f";
const UNDERSCORE_ID = "c7c96dffcd9c";

const K1_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const K2_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => 32 + i));
const K3_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));
const K3 = K3_BYTES.toString("base64");
const K3_URL = K3_BYTES.toString("base64url");

const UNRECOGNISED = "Unrecognised token encoding; expected v1.";
const TRUNCATED = "Encrypted token is truncated.";
const UNAUTHENTICATED =
  "Encrypted token could not be authenticated; the key may have changed.";

function keyLengthMessage(n: number): string {
  return `TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded; got ${n}.`;
}

function throwsCipherError(fn: () => unknown, message: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof TokenCipherError, "not a TokenCipherError");
    assert.ok(error instanceof Error);
    assert.equal(error.name, "TokenCipherError");
    assert.equal(error.message, message);
    return true;
  });
}

function encrypt(cipher: TokenCipher, plaintext: string): string {
  const ciphertext = cipher.encrypt(plaintext);
  assert.equal(typeof ciphertext, "string");
  return ciphertext as string;
}

function bodyBytes(ciphertext: string): Buffer {
  assert.ok(ciphertext.startsWith("v1:"));
  return Buffer.from(ciphertext.slice(3), "base64");
}

/** The spec's ciphertext, built with node:crypto from a fixed IV. */
function referenceCiphertext(key: Buffer, iv: Buffer, plaintext: string): string {
  const gcm = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([gcm.update(plaintext, "utf8"), gcm.final()]);
  const tag = gcm.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, data]).toString("base64")}`;
}

/** Decrypts the spec's layout with node:crypto. */
function referenceDecrypt(key: Buffer, ciphertext: string): string {
  const bytes = bodyBytes(ciphertext);
  const gcm = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  gcm.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([gcm.update(bytes.subarray(28)), gcm.final()]).toString("utf8");
}

const FIXED_IV = Buffer.from("000102030405060708090a0b", "hex");

// ---- TokenCipherError ------------------------------------------------------------

// Extends "[unhappy-1] a key of the wrong decoded length throws TokenCipherError":
// the class itself keeps any message and names itself.
test("[unhappy-1] TokenCipherError keeps the message it is given and is named TokenCipherError", () => {
  const error = new TokenCipherError("anything at all: 42");
  assert.ok(error instanceof Error);
  assert.ok(error instanceof TokenCipherError);
  assert.equal(error.name, "TokenCipherError");
  assert.equal(error.message, "anything at all: 42");
});

// ---- createTokenCipher: accepted keys ---------------------------------------------

// Extends "[happy-1] an accepted key yields its default key id": a key not in
// the public table, written four ways, always gives the same 12-hex id.
test("[happy-1] a third key's default id is 12 lowercase hex, distinct, and the same for every spelling", () => {
  const spellings = [
    K3,
    K3.replace(/=+$/, ""),
    `${K3}=`,
    K3_URL,
    `\t${K3_URL}\r\n`,
    ` ${K3} `,
  ];
  const ids = spellings.map((key) => createTokenCipher(key).keyId);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{12}$/);
    assert.equal(id, ids[0]);
  }
  assert.notEqual(ids[0], K1_ID);
  assert.notEqual(ids[0], K2_ID);
  assert.notEqual(ids[0], UNDERSCORE_ID);
});

// Extends "[happy-1] ... base64url alphabet": the same bytes in the standard
// alphabet ("/" for "_") are the same key, so the same default id.
test("[happy-1] 43 slashes in the standard alphabet are the same key as 43 underscores", () => {
  assert.equal(createTokenCipher(`${"/".repeat(43)}=`).keyId, UNDERSCORE_ID);
  assert.equal(createTokenCipher("/".repeat(43)).keyId, UNDERSCORE_ID);
  assert.equal(createTokenCipher(`  ${"_".repeat(43)}==\n`).keyId, UNDERSCORE_ID);
});

// Extends "[happy-1] ... surrounding whitespace" and "padding doubled" with K2.
test("[happy-1] K2 with its padding missing, doubled or wrapped in whitespace keeps its id", () => {
  for (const key of [
    K2.replace(/=$/, ""),
    `${K2}=`,
    `\n\t${K2}\t\n`,
    `   ${K2.replace(/=$/, "")}   `,
  ]) {
    assert.equal(createTokenCipher(key).keyId, K2_ID, JSON.stringify(key));
  }
});

test("[happy-1] an empty options object gives the default key id", () => {
  assert.equal(createTokenCipher(K1, {}).keyId, K1_ID);
  assert.equal(createTokenCipher(K2, {}).keyId, K2_ID);
});

// ---- createTokenCipher: rejected keys ---------------------------------------------

// Extends "[unhappy-1] a key of the wrong decoded length throws TokenCipherError"
// with other lengths, so a check of the string length alone is caught.
const otherRejectedKeys: Array<[string, string, number]> = [
  ["1 byte", Buffer.alloc(1, 7).toString("base64"), 1],
  ["16 bytes", K1_BYTES.subarray(0, 16).toString("base64"), 16],
  ["24 bytes (32 characters)", K1_BYTES.subarray(0, 24).toString("base64"), 24],
  ["30 bytes", K1_BYTES.subarray(0, 30).toString("base64"), 30],
  ["31 bytes without padding", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHg", 31],
  ["31 bytes in base64url", K3_BYTES.subarray(0, 31).toString("base64url"), 31],
  ["34 bytes", Buffer.alloc(34, 1).toString("base64"), 34],
  ["64 bytes", Buffer.concat([K1_BYTES, K2_BYTES]).toString("base64"), 64],
  ["whitespace only, tabs and newlines", "\t\n \r\n", 0],
  ["33 bytes wrapped in whitespace", "  AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g\n", 33],
];

for (const [why, key, n] of otherRejectedKeys) {
  test(`[unhappy-1] a key of another wrong decoded length throws TokenCipherError: ${why}`, () => {
    throwsCipherError(() => createTokenCipher(key), keyLengthMessage(n));
  });
}

// ---- key ids ----------------------------------------------------------------------

// Extends "[happy-2] an explicit key id replaces the default": an explicit id
// that is another key's default is still used as given.
test("[happy-2] an explicit key id that is another key's default id replaces K1's default", () => {
  assert.equal(createTokenCipher(K1, { keyId: K2_ID }).keyId, K2_ID);
  assert.equal(createTokenCipher(K2, { keyId: K1_ID }).keyId, K1_ID);
  assert.equal(createTokenCipher(K3_URL, { keyId: "rotated-2026-12" }).keyId, "rotated-2026-12");
});

// Extends "[boundary-1] the key id is used as given" with values the public
// table does not try: nothing is trimmed, folded or truncated.
const otherKeyIds: Array<[string, string]> = [
  ["surrounding spaces", "  prod  "],
  ["upper case", "PROD-Key"],
  ["a newline", "\n"],
  ["non-ASCII", "ключ-🔑"],
  ["1000 characters", "x".repeat(1000)],
  ["looks like a ciphertext", "v1:AAAA"],
  ["the key itself", K1],
];

for (const [why, keyId] of otherKeyIds) {
  test(`[boundary-1] the key id is used as given: ${why}`, () => {
    assert.equal(createTokenCipher(K1, { keyId }).keyId, keyId);
  });
}

test("[boundary-1] an undefined key id gives each key its own default", () => {
  assert.equal(createTokenCipher(K2, { keyId: undefined }).keyId, K2_ID);
  assert.equal(createTokenCipher("_".repeat(43), { keyId: undefined }).keyId, UNDERSCORE_ID);
});

// Extends "[unhappy-2] only the key is checked": other bad keys with good ids.
const badKeysWithIds: Array<[string, string, string, number]> = [
  ["whitespace key with a good id", "   ", "prod", 0],
  ["hex key with an id", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "k1", 48],
  ["33-byte key with K1's default id", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g", K1_ID, 33],
];

for (const [why, key, keyId, n] of badKeysWithIds) {
  test(`[unhappy-2] only the key is checked: ${why}`, () => {
    throwsCipherError(() => createTokenCipher(key, { keyId }), keyLengthMessage(n));
  });
}

// ---- round trip -------------------------------------------------------------------

// Extends "[happy-3] round trip" with other plaintexts and sizes.
const otherPlaintexts: Array<[string, string]> = [
  ["one character", "a"],
  ["15 bytes", "x".repeat(15)],
  ["16 bytes", "x".repeat(16)],
  ["17 bytes", "x".repeat(17)],
  ["contains colons and looks like a ciphertext", "v1:AAECAwQ=:more"],
  ["NUL and control characters", "a\u0000b\r\n\t"],
  ["300000 four-byte characters", "🔑".repeat(300000)],
  ["mixed scripts", "日本語 العربية Ελληνικά"],
];

for (const [why, plaintext] of otherPlaintexts) {
  test(`[happy-3] round trip: ${why}`, () => {
    const cipher = createTokenCipher(K1);
    assert.equal(cipher.decrypt(encrypt(cipher, plaintext)), plaintext);
  });
}

test("[happy-3] round trip under K2, K3 and an explicit key id", () => {
  for (const cipher of [
    createTokenCipher(K2),
    createTokenCipher(K3_URL),
    createTokenCipher(K1, { keyId: "" }),
  ]) {
    for (const plaintext of ["", "secret", "tökén 🔑"]) {
      assert.equal(cipher.decrypt(encrypt(cipher, plaintext)), plaintext);
    }
  }
});

// The body is decoded "with the same leniency as the key", so a valid body
// respelled unpadded, URL-safe or with surrounding whitespace still decrypts.
test("[happy-3] decrypt accepts the body unpadded, in base64url and with surrounding whitespace", () => {
  const cipher = createTokenCipher(K3);
  const bytes = bodyBytes(encrypt(cipher, "secret"));
  const standard = bytes.toString("base64");
  for (const body of [
    standard.replace(/=+$/, ""),
    bytes.toString("base64url"),
    ` ${standard}\n`,
  ]) {
    assert.equal(cipher.decrypt(`v1:${body}`), "secret", JSON.stringify(body));
  }
});

// The spec fixes the cipher completely apart from the IV, so a ciphertext
// built with node:crypto must decrypt, under any spelling of the key.
test("[happy-3] decrypt reads a reference AES-256-GCM ciphertext built with node:crypto", () => {
  const reference = referenceCiphertext(K1_BYTES, FIXED_IV, "eyJhbGciOiJIUzI1NiJ9.access");
  assert.equal(createTokenCipher(K1).decrypt(reference), "eyJhbGciOiJIUzI1NiJ9.access");

  const k3Reference = referenceCiphertext(K3_BYTES, FIXED_IV, "tökén 🔑");
  assert.equal(createTokenCipher(K3_URL).decrypt(k3Reference), "tökén 🔑");
});

// ---- layout -----------------------------------------------------------------------

// Extends "[happy-4] the ciphertext has the documented layout": the parts are
// iv ‖ tag ‖ data under the raw key with no AAD, which node:crypto confirms.
// An implementation that puts the tag last, derives the key, or binds the key
// id as AAD passes its own round trip and fails here.
test("[happy-4] node:crypto decrypts the cipher's output as iv ‖ tag ‖ data under the raw key", () => {
  for (const [key, bytes] of [
    [K1, K1_BYTES],
    [K2, K2_BYTES],
    [K3_URL, K3_BYTES],
  ] as const) {
    const cipher = createTokenCipher(key, { keyId: "prod" });
    for (const plaintext of ["secret", "", "tökén 🔑", "x".repeat(1000)]) {
      assert.equal(referenceDecrypt(bytes, encrypt(cipher, plaintext)), plaintext);
    }
  }
});

test("[happy-4] the layout length follows the UTF-8 length for many plaintexts", () => {
  const cipher = createTokenCipher(K2);
  for (const plaintext of ["a", "ab", "abc", "é", "🔑🔑", "x".repeat(1000), "€".repeat(77)]) {
    const ciphertext = encrypt(cipher, plaintext);
    const body = ciphertext.slice(3);
    const size = 28 + Buffer.byteLength(plaintext, "utf8");
    assert.ok(ciphertext.startsWith("v1:"));
    assert.equal(body.length, 4 * Math.ceil(size / 3));
    assert.match(body, /^[A-Za-z0-9+/]*={0,2}$/);
    const bytes = Buffer.from(body, "base64");
    assert.equal(bytes.length, size);
    assert.equal(bytes.toString("base64"), body);
  }
});

test("[happy-4] the ciphertext contains no key id, default or explicit, and not the key", () => {
  for (const keyId of [undefined, "kid-unique-777"]) {
    const cipher = createTokenCipher(K2, { keyId });
    const ciphertext = encrypt(cipher, "secret-token-value");
    assert.equal(ciphertext.includes(cipher.keyId), false);
    assert.equal(ciphertext.includes(K2), false);
    assert.equal(ciphertext.includes("secret"), false);
    assert.equal(ciphertext.split(":").length, 2);
  }
});

// Extends "[boundary-2] the empty plaintext has no data bytes": other keys,
// and the 28 bytes are an iv and the GCM tag of nothing.
test("[boundary-2] the empty plaintext is 28 bytes of iv and tag under every key", () => {
  for (const [key, bytes] of [
    [K2, K2_BYTES],
    [K3, K3_BYTES],
  ] as const) {
    const ciphertext = encrypt(createTokenCipher(key, { keyId: "x" }), "");
    assert.equal(ciphertext.length, 43);
    assert.equal(ciphertext.slice(3).length, 40);
    assert.ok(ciphertext.endsWith("=="));
    assert.equal(bodyBytes(ciphertext).length, 28);
    assert.equal(referenceDecrypt(bytes, ciphertext), "");
  }
});

test("[boundary-2] a reference empty-plaintext ciphertext decrypts to the empty string", () => {
  const reference = referenceCiphertext(K1_BYTES, FIXED_IV, "");
  assert.equal(bodyBytes(reference).length, 28);
  assert.equal(createTokenCipher(K1).decrypt(reference), "");
});

// ---- freshness --------------------------------------------------------------------

// Extends "[happy-5] encrypting the same plaintext twice gives different
// ciphertexts": many calls, every IV distinct, across ciphers of one key.
test("[happy-5] fifty encryptions of one plaintext all have distinct IVs and all decrypt", () => {
  const a = createTokenCipher(K1);
  const b = createTokenCipher(K1);
  const ciphertexts = Array.from({ length: 50 }, (_, i) => encrypt(i % 2 === 0 ? a : b, "secret"));
  assert.equal(new Set(ciphertexts).size, 50);
  const ivs = ciphertexts.map((c) => bodyBytes(c).subarray(0, 12).toString("hex"));
  assert.equal(new Set(ivs).size, 50);
  for (const ciphertext of ciphertexts) {
    assert.equal(a.decrypt(ciphertext), "secret");
  }
});

// ---- other ciphers of the same key -------------------------------------------------

// Extends "[happy-6] a ciphertext is readable by another cipher built from the
// same key": the standard and URL-safe spellings of K3 are one key.
test("[happy-6] the standard and URL-safe spellings of one key read each other's ciphertexts", () => {
  const standard = createTokenCipher(K3);
  const urlSafe = createTokenCipher(`  ${K3_URL}  `);
  assert.equal(urlSafe.keyId, standard.keyId);
  assert.equal(urlSafe.decrypt(standard.encrypt("secret")), "secret");
  assert.equal(standard.decrypt(urlSafe.encrypt("tökén 🔑")), "tökén 🔑");
});

test("[happy-6] a cipher from unpadded K2 reads padded K2's ciphertext", () => {
  const padded = createTokenCipher(K2);
  const unpadded = createTokenCipher(`\n${K2.replace(/=$/, "")}`);
  assert.equal(unpadded.decrypt(padded.encrypt("x".repeat(5000))), "x".repeat(5000));
});

// Extends "[happy-7] the key id does not affect decryption".
test("[happy-7] ciphers of one key with many key ids all read each other", () => {
  const ciphers = ["a", "b", "", "k:1", K2_ID, undefined].map((keyId) =>
    createTokenCipher(K2, { keyId }),
  );
  for (const writer of ciphers) {
    const ciphertext = encrypt(writer, "secret");
    for (const reader of ciphers) {
      assert.equal(reader.decrypt(ciphertext), "secret");
    }
  }
});

// Extends "[boundary-3] null passes through both directions".
test("[boundary-3] null passes through repeatedly and leaves the cipher working", () => {
  const cipher = createTokenCipher(K3_URL, { keyId: "" });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(cipher.encrypt(null), null);
    assert.equal(cipher.decrypt(null), null);
  }
  assert.equal(cipher.decrypt(cipher.encrypt("after")), "after");
  assert.equal(cipher.keyId, "");
});

// ---- decrypt rejections ----------------------------------------------------------

// Extends "[unhappy-3] an unrecognised encoding" with other schemes.
const otherUnrecognised: Array<[string, () => string]> = [
  ["a URL", () => "https://acme.atlassian.net"],
  ["a JWT with no colon", () => "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"],
  ["empty scheme", () => `:${encrypt(createTokenCipher(K1), "s").slice(3)}`],
  ["v10", () => `v10${encrypt(createTokenCipher(K1), "s").slice(2)}`],
  ["v", () => `v${encrypt(createTokenCipher(K1), "s").slice(2)}`],
  ["prefixed v1", () => `xv1${encrypt(createTokenCipher(K1), "s").slice(2)}`],
  ["space before the colon", () => `v1 ${encrypt(createTokenCipher(K1), "s").slice(2)}`],
  ["trailing newline in the scheme", () => `v1\n${encrypt(createTokenCipher(K1), "s").slice(2)}`],
  ["semicolon separator", () => `v1;${encrypt(createTokenCipher(K1), "s").slice(3)}`],
  ["the body alone", () => encrypt(createTokenCipher(K1), "s").slice(3)],
  ["only whitespace", () => "   "],
];

for (const [why, ciphertext] of otherUnrecognised) {
  test(`[unhappy-3] an unrecognised encoding: ${why}`, () => {
    const cipher = createTokenCipher(K1);
    const value = ciphertext();
    throwsCipherError(() => cipher.decrypt(value), UNRECOGNISED);
  });
}

// Extends "[unhappy-4] a truncated ciphertext" with other short bodies.
const otherTruncated: Array<[string, () => string]> = [
  ["one byte", () => `v1:${Buffer.alloc(1).toString("base64")}`],
  ["the iv alone", () => `v1:${FIXED_IV.toString("base64")}`],
  ["27 bytes unpadded", () => `v1:${Buffer.alloc(27, 9).toString("base64")}`],
  ["27 bytes in base64url", () => `v1:${Buffer.alloc(27, 0xff).toString("base64url")}`],
  ["whitespace body", () => "v1:   "],
  [
    "the first 27 bytes of this cipher's own ciphertext",
    () => {
      const bytes = bodyBytes(encrypt(createTokenCipher(K1), "secret"));
      return `v1:${bytes.subarray(0, 27).toString("base64")}`;
    },
  ],
];

for (const [why, ciphertext] of otherTruncated) {
  test(`[unhappy-4] a truncated ciphertext: ${why}`, () => {
    const cipher = createTokenCipher(K1);
    const value = ciphertext();
    throwsCipherError(() => cipher.decrypt(value), TRUNCATED);
  });
}

// Extends "[unhappy-5] a ciphertext under another key fails authentication".
test("[unhappy-5] ciphertexts under other keys fail authentication in every direction", () => {
  const ciphers = [createTokenCipher(K1), createTokenCipher(K2), createTokenCipher(K3_URL)];
  for (const [i, writer] of ciphers.entries()) {
    for (const [j, reader] of ciphers.entries()) {
      if (i === j) {
        continue;
      }
      for (const plaintext of ["secret", "x".repeat(2000)]) {
        const ciphertext = encrypt(writer, plaintext);
        throwsCipherError(() => reader.decrypt(ciphertext), UNAUTHENTICATED);
      }
    }
  }
});

test("[unhappy-5] a reference ciphertext under K2 fails authentication under K1", () => {
  const reference = referenceCiphertext(K2_BYTES, FIXED_IV, "secret");
  throwsCipherError(() => createTokenCipher(K1).decrypt(reference), UNAUTHENTICATED);
});

// Extends "[unhappy-6] the same key id over a different key fails authentication".
test("[unhappy-6] an empty shared key id over different keys fails authentication", () => {
  const a = createTokenCipher(K3, { keyId: "" });
  const b = createTokenCipher(K1, { keyId: "" });
  throwsCipherError(() => b.decrypt(encrypt(a, "secret")), UNAUTHENTICATED);
  throwsCipherError(() => a.decrypt(encrypt(b, "")), UNAUTHENTICATED);
});

// Extends "[boundary-4] 28 bytes that are not a ciphertext fail authentication".
const otherNonCiphertexts: Array<[string, string]> = [
  ["28 0xff bytes in base64url", Buffer.alloc(28, 0xff).toString("base64url")],
  ["28 patterned bytes", Buffer.from(Array.from({ length: 28 }, (_, i) => i * 7)).toString("base64")],
  ["29 zero bytes", Buffer.alloc(29).toString("base64")],
  ["100 zero bytes", Buffer.alloc(100).toString("base64")],
];

for (const [why, body] of otherNonCiphertexts) {
  test(`[boundary-4] bytes that are not a ciphertext fail authentication: ${why}`, () => {
    throwsCipherError(() => createTokenCipher(K1).decrypt(`v1:${body}`), UNAUTHENTICATED);
  });
}

// Extends "[unhappy-7] a tampered byte fails authentication": every byte and
// both ends of each part, plus cutting and extending the data.
test("[unhappy-7] flipping any bit of any byte fails authentication", () => {
  const cipher = createTokenCipher(K1);
  const original = bodyBytes(encrypt(cipher, "secret"));
  for (let offset = 0; offset < original.length; offset += 1) {
    for (const bit of [0x01, 0x80]) {
      const bytes = Buffer.from(original);
      bytes[offset] = (bytes[offset] ?? 0) ^ bit;
      const tampered = `v1:${bytes.toString("base64")}`;
      assert.throws(
        () => cipher.decrypt(tampered),
        (error: unknown) => {
          assert.ok(error instanceof TokenCipherError, `offset ${offset}`);
          assert.equal(error.message, UNAUTHENTICATED);
          assert.equal(error.message.includes("secret"), false);
          assert.equal(error.message.includes(K1), false);
          return true;
        },
      );
    }
  }
});

test("[unhappy-7] dropping or appending a data byte fails authentication", () => {
  const cipher = createTokenCipher(K2);
  const bytes = bodyBytes(encrypt(cipher, "secret"));
  throwsCipherError(
    () => cipher.decrypt(`v1:${bytes.subarray(0, bytes.length - 1).toString("base64")}`),
    UNAUTHENTICATED,
  );
  throwsCipherError(
    () => cipher.decrypt(`v1:${Buffer.concat([bytes, Buffer.from([0])]).toString("base64")}`),
    UNAUTHENTICATED,
  );
  // Swapping tag and data positions is not the documented layout.
  const swapped = Buffer.concat([bytes.subarray(0, 12), bytes.subarray(28), bytes.subarray(12, 28)]);
  throwsCipherError(() => cipher.decrypt(`v1:${swapped.toString("base64")}`), UNAUTHENTICATED);
});

test("[unhappy-7] a tampered long token's error message holds neither the plaintext nor the key", () => {
  const cipher = createTokenCipher(K3_URL);
  const plaintext = "refresh-token-abcdef-0123456789";
  const bytes = bodyBytes(encrypt(cipher, plaintext));
  bytes[40] = (bytes[40] ?? 0) ^ 0x10;
  assert.throws(
    () => cipher.decrypt(`v1:${bytes.toString("base64")}`),
    (error: unknown) => {
      assert.ok(error instanceof TokenCipherError);
      assert.equal(error.message, UNAUTHENTICATED);
      for (const secret of [plaintext, K3, K3_URL]) {
        assert.equal(error.message.includes(secret), false);
      }
      return true;
    },
  );
});

// Extends "[unhappy-8] the scheme is checked before the length, and the length
// before authentication".
test("[unhappy-8] a wrong scheme over 28 or more bytes reports the scheme, not authentication", () => {
  const cipher = createTokenCipher(K1);
  throwsCipherError(() => cipher.decrypt(`v2:${Buffer.alloc(28).toString("base64")}`), UNRECOGNISED);
  throwsCipherError(() => cipher.decrypt(`V1:${encrypt(cipher, "secret").slice(3)}`), UNRECOGNISED);
  throwsCipherError(() => cipher.decrypt("x:"), UNRECOGNISED);
});

test("[unhappy-8] a short body under the right scheme reports truncation, not authentication", () => {
  const cipher = createTokenCipher(K2);
  const foreign = bodyBytes(encrypt(createTokenCipher(K1), "secret"));
  for (const size of [0, 1, 12, 27]) {
    throwsCipherError(
      () => cipher.decrypt(`v1:${foreign.subarray(0, size).toString("base64")}`),
      TRUNCATED,
    );
  }
  throwsCipherError(
    () => cipher.decrypt(`v1:${foreign.subarray(0, 28).toString("base64")}`),
    UNAUTHENTICATED,
  );
});

// ---- statelessness -----------------------------------------------------------------

// "A cipher keeps no mutable state": a failed decrypt does not affect later calls.
test("[happy-3] a failed decrypt does not affect later calls on the same cipher", () => {
  const cipher = createTokenCipher(K1);
  const before = encrypt(cipher, "before");
  throwsCipherError(() => cipher.decrypt(encrypt(createTokenCipher(K2), "x")), UNAUTHENTICATED);
  throwsCipherError(() => cipher.decrypt("v1:"), TRUNCATED);
  throwsCipherError(() => cipher.decrypt("nope"), UNRECOGNISED);
  assert.equal(cipher.decrypt(before), "before");
  assert.equal(cipher.decrypt(encrypt(cipher, "after")), "after");
  assert.equal(cipher.keyId, K1_ID);
});

// ---- sameKeyId ----------------------------------------------------------------------

// Extends "[happy-8] comparing key ids" with other identical pairs.
const otherIdentical: Array<[string, string]> = [
  ["e32ee159945f", "e32ee159945f"],
  ["Prod", "Prod"],
  [" prod ", " prod "],
  ["ключ-🔑", "ключ-🔑"],
  ["k".repeat(10000), "k".repeat(10000)],
];

for (const [left, right] of otherIdentical) {
  test(`[happy-8] comparing identical key ids: ${JSON.stringify(left.slice(0, 12))} (${left.length} chars)`, () => {
    assert.equal(sameKeyId(left, right), true);
  });
}

// Extends "[boundary-5] comparing key ids": near misses a loose comparison
// (lower-casing, trimming, prefix, length, normalisation) gets wrong.
const nearMisses: Array<[string, string, string]> = [
  ["empty and one character", "", "a"],
  ["one character and empty", "a", ""],
  ["prefix", "prod", "prod-2"],
  ["upper-case left", "PROD", "prod"],
  ["leading space", " prod", "prod"],
  ["same length, different", "0ebcb5deb52c", "e32ee159945f"],
  ["last character of a long id", `${"k".repeat(9999)}a`, `${"k".repeat(9999)}b`],
  ["NFC and NFD", "é", "é"],
  ["ß and SS", "ß", "SS"],
  ["Turkish dotless i", "ı", "i"],
  ["null character suffix", "prod", "prod\u0000"],
];

for (const [why, left, right] of nearMisses) {
  test(`[boundary-5] comparing near-miss key ids: ${why}`, () => {
    assert.equal(sameKeyId(left, right), false);
    assert.equal(sameKeyId(right, left), false);
  });
}

test("[boundary-5] a default key id equals itself and no other key's", () => {
  assert.equal(sameKeyId(createTokenCipher(K1).keyId, K1_ID), true);
  assert.equal(sameKeyId(createTokenCipher(K2).keyId, K1_ID), false);
});
