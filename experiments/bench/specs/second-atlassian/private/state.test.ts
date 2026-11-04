import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { signState, verifyState } from "../../src/jira/state.js";

/**
 * Hidden suite for the signed OAuth `state` of the Jira connect flow. See
 * spec.md: `base64url(JSON payload) "." base64url(HMAC-SHA256)`, no padding.
 */

const SECRET = "0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "another-secret-another-secret-xx";
const BASE = {
  organizationId: "org_1",
  userId: "user_1",
  returnTo: "/settings/jira",
} as const;
const T = 1700000000000;

/** signState(SECRET, { ...BASE, issuedAt: T, nonce: "AAAAAAAAAAAAAAAAAAAAAA" }) */
const KNOWN =
  "eyJvcmdhbml6YXRpb25JZCI6Im9yZ18xIiwidXNlcklkIjoidXNlcl8xIiwicmV0dXJuVG8iOiIvc2V0dGluZ3MvamlyYSIsImlzc3VlZEF0IjoxNzAwMDAwMDAwMDAwLCJub25jZSI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUEifQ.Urh3QevT-f-UKuDamXCEWtrqVSKKyJdzD09Kp0ROuIA";

const STATE_KEYS = ["issuedAt", "nonce", "organizationId", "returnTo", "userId"];
const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

interface Fields {
  organizationId: string;
  userId: string;
  returnTo: string;
  issuedAt: number;
  nonce: string;
}

/** base64url (no padding) of the UTF-8 bytes of `text`. */
function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** base64url (no padding) of HMAC-SHA256(secret, payload). */
function hmac(secret: string, payload: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(payload, "ascii"))
    .digest("base64url");
}

/** A correctly signed value whose payload segment is exactly `payload`. */
function signedSegment(payload: string, secret: string = SECRET): string {
  return `${payload}.${hmac(secret, payload)}`;
}

/** A correctly signed value whose payload is exactly `json`. */
function signedRaw(json: string, secret: string = SECRET): string {
  return signedSegment(encode(json), secret);
}

/** The value the spec's wire format defines for these five fields. */
function wire(secret: string, fields: Fields): string {
  const json = JSON.stringify({
    organizationId: fields.organizationId,
    userId: fields.userId,
    returnTo: fields.returnTo,
    issuedAt: fields.issuedAt,
    nonce: fields.nonce,
  });
  return signedRaw(json, secret);
}

/** Splits a value at its last `.`. */
function split(value: string): { payload: string; signature: string } {
  const at = value.lastIndexOf(".");
  return { payload: value.slice(0, at), signature: value.slice(at + 1) };
}

function payloadText(value: string): string {
  return Buffer.from(split(value).payload, "base64url").toString("utf8");
}

function payloadOf(value: string): Record<string, unknown> {
  return JSON.parse(payloadText(value)) as Record<string, unknown>;
}

function fields(overrides: Partial<Fields> = {}): Fields {
  return { ...BASE, issuedAt: T, nonce: "n1", ...overrides };
}

/** The fixture most scenarios start from. */
function signedN1(secret: string = SECRET): string {
  return signState(secret, fields());
}

const okN1 = { ok: true, state: fields() } as const;
const BAD = { ok: false, reason: "bad-signature" } as const;
const MALFORMED = { ok: false, reason: "malformed" } as const;
const EXPIRED = { ok: false, reason: "expired" } as const;
const WRONG_USER = { ok: false, reason: "wrong-user" } as const;

/** A JSON state text with the given raw field fragments. */
function stateJson(parts: Record<string, string>): string {
  const all: Record<string, string> = {
    organizationId: '"org_1"',
    userId: '"user_1"',
    returnTo: '"/"',
    issuedAt: "1700000000000",
    nonce: '"n1"',
    ...parts,
  };
  return (
    "{" +
    Object.entries(all)
      .filter(([, raw]) => raw !== "")
      .map(([key, raw]) => `${JSON.stringify(key)}:${raw}`)
      .join(",") +
    "}"
  );
}

// ---- @happy 5: the wire format ---------------------------------------------

// Extends "[happy-5] a fully specified state signs to the known value": other
// values, covering every padding length, payloads whose base64 needs `-`/`_`,
// non-ASCII text and characters JSON must escape.
test("[happy-5] other fully specified states sign to the wire-format value", () => {
  const returnTos = [
    "/",
    "/a",
    "/aa",
    "/aaa",
    "/~~~",
    "/ä€🔑",
    '/"quoted"\\back',
    "/line\nbreak\ttab\u0001",
    "/  ",
  ];
  let sawUrlSafe = false;
  for (const returnTo of returnTos) {
    const state = fields({ returnTo, nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    const value = signState(SECRET, state);
    assert.equal(value, wire(SECRET, state), `returnTo ${JSON.stringify(returnTo)}`);
    assert.doesNotMatch(value, /[=+/]/);
    if (/[-_]/.test(split(value).payload)) sawUrlSafe = true;
  }
  assert.ok(sawUrlSafe, "some payload needed the URL-safe alphabet");
});

// Extends "[happy-5] the payload is the fixed-order JSON ...": other ids and
// timestamps, still exactly JSON.stringify of the five keys in order.
test("[happy-5] the payload text is JSON.stringify of the five keys in the fixed order", () => {
  const states: Fields[] = [
    { organizationId: "o", userId: "u", returnTo: "r", issuedAt: 0, nonce: "x" },
    {
      organizationId: "org_ünï",
      userId: "用户",
      returnTo: "https://app.lunox.work/x?y=1",
      issuedAt: 1234567890123,
      nonce: "-_-_-_-_-_-_",
    },
    fields({ issuedAt: 1700000000000.25 }),
  ];
  for (const state of states) {
    const value = signState(SECRET, state);
    assert.equal(
      payloadText(value),
      JSON.stringify({
        organizationId: state.organizationId,
        userId: state.userId,
        returnTo: state.returnTo,
        issuedAt: state.issuedAt,
        nonce: state.nonce,
      }),
    );
    const { signature } = split(value);
    assert.equal(signature.length, 43);
    assert.equal(value.split(".").length, 2);
  }
});

// ---- @happy 6: deterministic -----------------------------------------------

// Extends "[happy-6] signing the same five fields twice gives the same
// string": more calls, other states, and each field taking part in the value.
test("[happy-6] repeated signing is stable and every field changes the value", () => {
  const base = fields();
  const reference = signState(SECRET, base);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(signState(SECRET, { ...base }), reference);
  }
  const variants: Fields[] = [
    fields({ organizationId: "org_2" }),
    fields({ userId: "user_2" }),
    fields({ returnTo: "/settings/jirb" }),
    fields({ issuedAt: T + 1 }),
    fields({ nonce: "n2" }),
  ];
  const seen = new Set([reference]);
  for (const variant of variants) {
    const value = signState(SECRET, variant);
    assert.equal(value, signState(SECRET, variant));
    assert.equal(value, wire(SECRET, variant));
    seen.add(value);
  }
  assert.equal(seen.size, variants.length + 1);
});

// ---- @happy 7: the signature depends on the secret ------------------------

// Extends "[happy-7] another secret keeps the payload and gives the known
// signature": non-ASCII secrets (UTF-8 key bytes) and secrets longer than the
// 64-byte HMAC block, which must not be truncated.
test("[happy-7] non-ASCII and long secrets sign with the UTF-8 HMAC of the full secret", () => {
  const long = SECRET.repeat(4);
  const secrets = [
    "ключ-секрет-🔑-ünïcödé",
    "é",
    "Ã©",
    long + "A",
    long + "B",
    "x".repeat(1000),
  ];
  const payload = split(signedN1()).payload;
  const signatures = new Set<string>();
  for (const secret of secrets) {
    const value = signedN1(secret);
    assert.equal(split(value).payload, payload);
    assert.equal(split(value).signature, hmac(secret, payload), `secret ${secret.slice(0, 20)}`);
    signatures.add(split(value).signature);
  }
  assert.equal(signatures.size, secrets.length);
});

// ---- @happy 8: an omitted nonce --------------------------------------------

// Extends "[happy-8] an omitted nonce is a fresh 12-char base64url value each
// call": many more calls, all distinct, all canonical 9-byte encodings.
test("[happy-8] fifty omitted nonces are all distinct canonical 9-byte base64url values", () => {
  const nonces = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    const value = signState(SECRET, { ...BASE, issuedAt: T });
    const nonce = payloadOf(value).nonce;
    assert.equal(typeof nonce, "string");
    assert.match(nonce as string, /^[A-Za-z0-9_-]{12}$/);
    const bytes = Buffer.from(nonce as string, "base64url");
    assert.equal(bytes.length, 9);
    assert.equal(bytes.toString("base64url"), nonce);
    assert.equal(value, wire(SECRET, fields({ nonce: nonce as string })));
    nonces.add(nonce as string);
  }
  assert.equal(nonces.size, 50);
});

// Both issuedAt and nonce omitted: the nonce is still generated.
test("[happy-8] a nonce is generated when issuedAt is omitted too", (t) => {
  t.mock.method(Date, "now", () => T);
  const first = signState(SECRET, BASE);
  const second = signState(SECRET, BASE);
  const n1 = payloadOf(first).nonce as string;
  const n2 = payloadOf(second).nonce as string;
  assert.match(n1, /^[A-Za-z0-9_-]{12}$/);
  assert.match(n2, /^[A-Za-z0-9_-]{12}$/);
  assert.notEqual(n1, n2);
  assert.deepEqual(verifyState(SECRET, first, "user_1", T), {
    ok: true,
    state: { ...BASE, issuedAt: T, nonce: n1 },
  });
});

// ---- @happy 9: an omitted issuedAt -----------------------------------------

// Extends "[happy-9] an omitted issuedAt is Date.now()": the clock is read at
// each call, not once, and other clock values are used as given.
test("[happy-9] each call reads the clock at that call", (t) => {
  const readings = [T + 123457, 5, T - 1000, 1800000000000];
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  for (const expected of readings) {
    clock = expected;
    const value = signState(SECRET, { ...BASE, nonce: "n1" });
    const issuedAt = payloadOf(value).issuedAt;
    assert.ok(Number.isInteger(issuedAt));
    assert.equal(issuedAt, expected);
    assert.equal(value, wire(SECRET, fields({ issuedAt: expected })));
  }
});

// The clock-stamped value lives exactly the stated lifetime from that reading.
test("[happy-9] a clock-stamped value expires 600000 ms after the clock reading", (t) => {
  const N = T + 123457;
  t.mock.method(Date, "now", () => N);
  const value = signState(SECRET, { ...BASE, nonce: "n1" });
  assert.deepEqual(verifyState(SECRET, value, "user_1", N + 600000), {
    ok: true,
    state: fields({ issuedAt: N }),
  });
  assert.deepEqual(verifyState(SECRET, value, "user_1", N + 600001), EXPIRED);
});

// ---- @boundary 5: extra input properties are not signed -------------------

// Extends "[boundary-5] extra input properties are left out of the payload":
// more and odder extras, including a `toJSON` that would hijack a naive
// JSON.stringify of the input.
test("[boundary-5] many extra input properties, toJSON included, are left out", () => {
  const value = signState(SECRET, {
    ...fields(),
    extra: "x",
    admin: true,
    nested: { userId: "user_2" },
    list: [1, 2, 3],
    issuedat: 1,
    "nonce ": "n2",
    toJSON: () => "hijacked",
  } as never);
  assert.deepEqual(Object.keys(payloadOf(value)), [
    "organizationId",
    "userId",
    "returnTo",
    "issuedAt",
    "nonce",
  ]);
  assert.equal(value, signedN1());
});

// Extends "[boundary-5] an extra input property does not change the signed
// value": an extra on an input inheriting from another object.
test("[boundary-5] the value depends on the five fields only, whatever else the input holds", () => {
  const withExtras = signState(SECRET, {
    ...fields({ returnTo: "/x" }),
    secret: SECRET,
    organization: { id: "org_2" },
  } as never);
  assert.equal(withExtras, wire(SECRET, fields({ returnTo: "/x" })));
  assert.deepEqual(Object.keys(payloadOf(withExtras)).sort(), STATE_KEYS);
});

// ---- @boundary 6: returnTo is carried verbatim -----------------------------

// Extends both "[boundary-6] ... round-trips verbatim" tests: more returnTo
// values, including protocol-relative and script URLs, quotes, escapes,
// dots, newlines, emoji and a lone surrogate.
test("[boundary-6] many more returnTo values sign to the wire format and round-trip verbatim", () => {
  for (const returnTo of [
    "//evil.example/",
    "javascript:alert(1)",
    '/"q"\\b',
    "/line\nbreak",
    "/🔑/€",
    ".",
    "..",
    "/a..b.",
    "/%2e%2e/",
    " /padded ",
    "/\ud800",
  ]) {
    const state = fields({ returnTo });
    const value = signState(SECRET, state);
    assert.equal(value, wire(SECRET, state), `returnTo ${JSON.stringify(returnTo)}`);
    assert.deepEqual(
      verifyState(SECRET, value, "user_1", T),
      { ok: true, state },
      `returnTo ${JSON.stringify(returnTo)}`,
    );
  }
});

// ---- @boundary 7: signState does not validate its input -------------------

// Extends "[boundary-7] empty secret, ids and nonce sign without throwing":
// the empty secret is an HMAC key like any other, and everything empty at
// once still signs and verifies.
test("[boundary-7] an empty secret signs with HMAC under an empty key, and an all-empty state verifies", () => {
  const value = signState("", fields());
  assert.equal(value, wire("", fields()));

  const empty: Fields = {
    organizationId: "",
    userId: "",
    returnTo: "",
    issuedAt: T,
    nonce: "",
  };
  let signed = "";
  assert.doesNotThrow(() => {
    signed = signState("", empty);
  });
  assert.equal(signed, wire("", empty));
  assert.deepEqual(verifyState("", signed, "", T), { ok: true, state: empty });
});

// Extends "[boundary-7] odd issuedAt values sign without throwing ...": other
// out-of-range numbers, and -Infinity written as null.
test("[boundary-7] other odd issuedAt values sign and verify as expired or malformed", () => {
  for (const issuedAt of [-1e15, -0.5, 0.25, Number.MAX_VALUE, Number.MIN_VALUE, T + 60001.5]) {
    let value = "";
    assert.doesNotThrow(() => {
      value = signState(SECRET, fields({ issuedAt }));
    });
    assert.equal(value, wire(SECRET, fields({ issuedAt })));
    assert.deepEqual(verifyState(SECRET, value, "user_1", T), EXPIRED, `issuedAt ${issuedAt}`);
  }
  let value = "";
  assert.doesNotThrow(() => {
    value = signState(SECRET, fields({ issuedAt: Number.NEGATIVE_INFINITY }));
  });
  assert.equal(payloadOf(value).issuedAt, null);
  assert.deepEqual(verifyState(SECRET, value, "user_1", T), MALFORMED);
});

// ---- @boundary 8: no length limit ------------------------------------------

// Extends "[boundary-8] a 4001-character returnTo signs to a 5507-character
// value": a value well past any plausible limit.
test("[boundary-8] a 100001-character returnTo signs to the full wire value and verifies", () => {
  const returnTo = "/" + "a.b".repeat(33333) + "a";
  assert.equal(returnTo.length, 100001);
  const state = fields({ returnTo });
  const value = signState(SECRET, state);
  const json = JSON.stringify(state);
  assert.equal(value.length, Math.ceil((Buffer.byteLength(json) * 4) / 3) + 1 + 43);
  assert.equal(value, wire(SECRET, {
    organizationId: state.organizationId,
    userId: state.userId,
    returnTo,
    issuedAt: T,
    nonce: "n1",
  }));
  assert.deepEqual(verifyState(SECRET, value, "user_1", T), { ok: true, state });
});

// Extends "[boundary-8] a long returnTo comes back intact": long values in
// every string field of a correctly signed payload.
test("[boundary-8] long ids and nonce in a signed payload verify intact", () => {
  const state: Fields = {
    organizationId: "o".repeat(20000),
    userId: "u".repeat(20000),
    returnTo: "/" + "r".repeat(20000),
    issuedAt: T,
    nonce: "n".repeat(20000),
  };
  assert.deepEqual(
    verifyState(SECRET, wire(SECRET, state), state.userId, T),
    { ok: true, state },
  );
});

// ---- @happy 10: a freshly signed value verifies ----------------------------

// Extends "[happy-10] a freshly signed value verifies to its five fields":
// other states and other moments inside the window.
test("[happy-10] other signed states verify to their own five fields", () => {
  const states: Fields[] = [
    fields({ organizationId: "org_42", returnTo: "/boards/7" }),
    fields({ userId: "üser_🔑", nonce: "AbCdEfGhIjKl" }),
    { organizationId: "o", userId: "u", returnTo: "/", issuedAt: 1234567890123, nonce: "z" },
  ];
  for (const state of states) {
    const value = signState(SECRET, state);
    for (const offset of [0, 1, 1000, 599999]) {
      assert.deepEqual(
        verifyState(SECRET, value, state.userId, state.issuedAt + offset),
        { ok: true, state },
      );
    }
  }
});

// Extends "[happy-10] the known wire-format value verifies": a correctly
// signed payload the module did not produce (other key order, whitespace,
// UTF-8 text) verifies to its decoded fields; the HMAC is over the segment as
// received, not over a re-encoding.
test("[happy-10] a correctly signed payload in another key order and spacing verifies to its fields", () => {
  const json =
    '{ "nonce" : "n1", "issuedAt" : 1700000000000, "returnTo" : "/ä", "userId" : "ü_1", "organizationId" : "org_1" }';
  assert.deepEqual(verifyState(SECRET, signedRaw(json), "ü_1", T + 1000), {
    ok: true,
    state: {
      organizationId: "org_1",
      userId: "ü_1",
      returnTo: "/ä",
      issuedAt: T,
      nonce: "n1",
    },
  });
});

// ---- @happy 11: now defaults to the current time ---------------------------

// Extends both "[happy-11] verifyState without now ..." tests: the clock is
// read at every call, on both edges of the window.
test("[happy-11] verifyState without now reads the clock at each call", (t) => {
  const readings = [T, T - 60001, T - 60000, T + 600000, T + 600001, T + 5];
  const expected = [okN1, EXPIRED, okN1, okN1, EXPIRED, okN1];
  let clock = T;
  t.mock.method(Date, "now", () => clock);
  const value = signedN1();
  for (let i = 0; i < readings.length; i += 1) {
    clock = readings[i]!;
    assert.deepEqual(verifyState(SECRET, value, "user_1"), expected[i], `clock ${readings[i]}`);
  }
});

// ---- @boundary 9: verification is stateless -------------------------------

// Extends "[boundary-9] the same value verifies twice with equal results":
// many verifications, interleaved with failed ones, and two values sharing a
// nonce.
test("[boundary-9] a value keeps verifying across many calls interleaved with failures", () => {
  const value = signedN1();
  const sameNonce = signState(SECRET, fields({ organizationId: "org_2" }));
  for (let i = 0; i < 10; i += 1) {
    assert.deepEqual(verifyState(SECRET, value, "user_2", T), WRONG_USER);
    assert.deepEqual(verifyState(SECRET, value, "user_1", T + 600001), EXPIRED);
    assert.deepEqual(verifyState(OTHER_SECRET, value, "user_1", T), BAD);
    assert.deepEqual(verifyState(SECRET, value, "user_1", T + i), okN1);
    assert.deepEqual(verifyState(SECRET, sameNonce, "user_1", T + i), {
      ok: true,
      state: fields({ organizationId: "org_2" }),
    });
  }
});

// ---- @boundary 10: age and skew boundaries ---------------------------------

// Extends "[boundary-10] now at T, at T + 600000 and at T - 60000 is inside
// the window" and "one millisecond past either edge is expired": another
// issuedAt, and one millisecond inside each edge.
test("[boundary-10] the window edges hold for other issuedAt values", () => {
  for (const issuedAt of [0, T + 12345, 1]) {
    const value = signState(SECRET, fields({ issuedAt }));
    const ok = { ok: true, state: fields({ issuedAt }) };
    for (const now of [issuedAt, issuedAt + 1, issuedAt + 599999, issuedAt + 600000, issuedAt - 1, issuedAt - 59999, issuedAt - 60000]) {
      assert.deepEqual(verifyState(SECRET, value, "user_1", now), ok, `issuedAt ${issuedAt} now ${now}`);
    }
    for (const now of [issuedAt + 600001, issuedAt - 60001, issuedAt + 1e9, issuedAt - 1e9]) {
      assert.deepEqual(verifyState(SECRET, value, "user_1", now), EXPIRED, `issuedAt ${issuedAt} now ${now}`);
    }
  }
});

// Extends "[boundary-10] one millisecond past either edge is expired":
// fractions of a millisecond past each edge, and infinite clocks.
test("[boundary-10] fractional and infinite nows are judged by the exact comparisons", () => {
  const value = signedN1();
  assert.deepEqual(verifyState(SECRET, value, "user_1", T + 600000.5), EXPIRED);
  assert.deepEqual(verifyState(SECRET, value, "user_1", T - 60000.5), EXPIRED);
  assert.deepEqual(verifyState(SECRET, value, "user_1", T + 599999.5), okN1);
  assert.deepEqual(verifyState(SECRET, value, "user_1", T - 59999.5), okN1);
  assert.deepEqual(verifyState(SECRET, value, "user_1", Number.POSITIVE_INFINITY), EXPIRED);
  assert.deepEqual(verifyState(SECRET, value, "user_1", Number.NEGATIVE_INFINITY), EXPIRED);
});

// A fractional issuedAt from a signed payload, against fractional nows.
test("[boundary-10] a fractional issuedAt is compared exactly at both edges", () => {
  const issuedAt = T + 0.5;
  const value = signedRaw(stateJson({ issuedAt: String(issuedAt) }));
  const ok = {
    ok: true,
    state: { organizationId: "org_1", userId: "user_1", returnTo: "/", issuedAt, nonce: "n1" },
  };
  assert.deepEqual(verifyState(SECRET, value, "user_1", T + 600000.5), ok);
  assert.deepEqual(verifyState(SECRET, value, "user_1", T + 600000.75), EXPIRED);
  assert.deepEqual(verifyState(SECRET, value, "user_1", T - 59999.5), ok);
  assert.deepEqual(verifyState(SECRET, value, "user_1", T - 59999.75), EXPIRED);
});

// Extends "[boundary-10] a NaN now is never expired": with another issuedAt
// far from anything, a NaN now still gives ok.
test("[boundary-10] a NaN now is never expired, whatever issuedAt is", () => {
  for (const issuedAt of [0, -1e12, 1e15]) {
    assert.deepEqual(
      verifyState(SECRET, signState(SECRET, fields({ issuedAt })), "user_1", Number.NaN),
      { ok: true, state: fields({ issuedAt }) },
    );
  }
});

// ---- @unhappy 2: shape failures --------------------------------------------

// Extends "[unhappy-2] a value with no payload/signature split is malformed":
// other dotless and dot-first values, including a long one, under an empty
// secret too (the shape is checked before the signature).
test("[unhappy-2] other values with no payload/signature split are malformed", () => {
  const { signature } = split(signedN1());
  for (const value of [
    "   ",
    "\n",
    "x".repeat(10000),
    signature,
    "." + signature,
    ".abc",
  ]) {
    for (const secret of [SECRET, ""]) {
      assert.deepEqual(
        verifyState(secret, value, "user_1", T),
        MALFORMED,
        `value ${JSON.stringify(value.slice(0, 20))}`,
      );
    }
  }
});

// Extends "[unhappy-2] any other shape is judged by its signature": several
// dots where the last is not the first character, an empty signature after a
// real payload, and a doubled signature.
test("[unhappy-2] values whose last dot is not first are judged by the signature", () => {
  const value = signedN1();
  const { payload, signature } = split(value);
  for (const candidate of [
    "..",
    "...",
    "..abc",
    ".a.b",
    "a..",
    "\n.abc",
    payload + ".",
    `${value}.${signature}`,
    `${payload}..${signature}`,
    `.${value}`,
  ]) {
    assert.deepEqual(
      verifyState(SECRET, candidate, "user_1", T),
      BAD,
      `value ${JSON.stringify(candidate.slice(0, 30))}`,
    );
  }
});

// Extends "[unhappy-2] any other shape is judged by its signature": non-ASCII
// segments, including a 43-character signature whose UTF-8 bytes outnumber
// its characters, give bad-signature rather than an exception.
test("[unhappy-2] non-ASCII segments are a bad signature, without throwing", () => {
  const { payload } = split(signedN1());
  for (const candidate of [
    "ä.ä",
    `${payload}.${"A".repeat(42)}ä`,
    `${payload}.${"é".repeat(43)}`,
    `${payload}.${"🔑".repeat(22)}`,
    `ü${payload}.${hmac(SECRET, payload)}`,
  ]) {
    let result: ReturnType<typeof verifyState> | undefined;
    assert.doesNotThrow(() => {
      result = verifyState(SECRET, candidate, "user_1", T);
    });
    assert.deepEqual(result, BAD);
  }
});

// ---- @unhappy 3: a signed payload that is not a state is malformed --------

// Extends "[unhappy-3] a signed payload with a missing or mistyped field is
// malformed": every field missing in turn, and every field with each wrong type.
test("[unhappy-3] each field missing or of each wrong type is malformed", () => {
  const wrong: Record<string, string[]> = {
    organizationId: ["", "1", "null", "true", "{}", '["org_1"]'],
    userId: ["", "1", "null", "false", "{}", '["user_1"]'],
    returnTo: ["", "0", "null", "true", "{}", '["/"]'],
    issuedAt: ["", "null", "true", "{}", "[1700000000000]", '"1.7e12"'],
    nonce: ["", "1", "null", "true", "{}", '["n1"]'],
  };
  for (const [key, raws] of Object.entries(wrong)) {
    for (const raw of raws) {
      const json = stateJson({ [key]: raw });
      assert.deepEqual(
        verifyState(SECRET, signedRaw(json), "user_1", T),
        MALFORMED,
        `payload ${json}`,
      );
    }
  }
});

// Extends "[unhappy-3] a signed payload that is not a JSON object is
// malformed": other non-object JSON, a state nested inside something, trailing
// garbage, and a number literal too large to be finite.
test("[unhappy-3] other signed non-state payloads are malformed", () => {
  const inner = stateJson({});
  for (const json of [
    "{}",
    "true",
    "123",
    '""',
    `[${inner}]`,
    `{"state":${inner}}`,
    `${inner}x`,
    inner.slice(0, -1),
    stateJson({ issuedAt: "1e400" }),
    stateJson({ issuedAt: "-1e400" }),
  ]) {
    assert.deepEqual(
      verifyState(SECRET, signedRaw(json), "user_1", T),
      MALFORMED,
      `payload ${json.slice(0, 60)}`,
    );
  }
});

// Extends "[unhappy-2] any other shape is judged by its signature": a payload
// segment that is not base64url, or contains dots, but is correctly signed,
// passes the signature check and is then malformed. An implementation that
// splits at the first dot reports bad-signature here.
test("[unhappy-3] a correctly signed segment that is not base64url of a state is malformed", () => {
  for (const segment of ["a.b", "a.b.c.d", "%%%", "e30", "!!!!", " "]) {
    let result: ReturnType<typeof verifyState> | undefined;
    assert.doesNotThrow(() => {
      result = verifyState(SECRET, signedSegment(segment), "user_1", T);
    });
    assert.deepEqual(result, MALFORMED, `segment ${segment}`);
  }
});

// The payload check comes before expiry and the user check: a payload missing
// a field is malformed even when it is also expired or for another user.
test("[unhappy-3] a malformed payload is reported before expiry or user mismatch", () => {
  const missingNonce = signedRaw(stateJson({ nonce: "", issuedAt: "0" }));
  assert.deepEqual(verifyState(SECRET, missingNonce, "user_1", T), MALFORMED);
  const wrongTypedOrg = signedRaw(stateJson({ organizationId: "7" }));
  assert.deepEqual(verifyState(SECRET, wrongTypedOrg, "user_2", T + 86400000), MALFORMED);
});

// ---- @boundary 11: signed payloads are checked for types only -------------

// Extends "[boundary-11] empty strings and a fractional issuedAt in a signed
// payload verify": every string field empty in turn, exponent and negative-zero
// free number forms, and UTF-8 text decoded as UTF-8.
test("[boundary-11] other empty strings and number forms in a signed payload verify", () => {
  const cases: Array<[string, Fields, string]> = [
    [stateJson({ userId: '""' }), fields({ returnTo: "/", userId: "" }), ""],
    [stateJson({ returnTo: '""' }), fields({ returnTo: "" }), "user_1"],
    [
      stateJson({ organizationId: '""', returnTo: '""', nonce: '""' }),
      { organizationId: "", userId: "user_1", returnTo: "", issuedAt: T, nonce: "" },
      "user_1",
    ],
    [stateJson({ issuedAt: "1.7e12" }), fields({ returnTo: "/" }), "user_1"],
    [stateJson({ issuedAt: "1700000000000.0" }), fields({ returnTo: "/" }), "user_1"],
    [
      stateJson({ issuedAt: "1700000000123.875" }),
      fields({ returnTo: "/", issuedAt: 1700000000123.875 }),
      "user_1",
    ],
    [
      stateJson({ userId: '"üser_1"', returnTo: '"/€🔑"' }),
      fields({ userId: "üser_1", returnTo: "/€🔑" }),
      "üser_1",
    ],
  ];
  for (const [json, state, user] of cases) {
    assert.deepEqual(
      verifyState(SECRET, signedRaw(json), user, T),
      { ok: true, state },
      `payload ${json}`,
    );
  }
});

// Extends "[boundary-11] a signed fractional or negative issuedAt far from now
// is expired, not malformed": other finite extremes.
test("[boundary-11] other finite but distant issuedAt values in a signed payload are expired", () => {
  for (const raw of ["1e308", "-1e308", "-0.5", "5e-324", "0", "1700000600001"]) {
    assert.deepEqual(
      verifyState(SECRET, signedRaw(stateJson({ issuedAt: raw })), "user_1", T - 100000),
      EXPIRED,
      `issuedAt ${raw}`,
    );
  }
});

// ---- @boundary 12: extra keys in a signed payload are dropped -------------

// Extends both "[boundary-12] ..." tests: extras of every JSON type, including
// ones named like the fields in another case, still leave exactly the five.
test("[boundary-12] extras of every JSON type are dropped, leaving exactly the five fields", () => {
  const json =
    '{"organizationId":"org_1","Organizationid":"org_2","userId":"user_1","extraNull":null,"returnTo":"/","list":[1,{"userId":"user_2"}],"issuedAt":1700000000000,"nested":{"issuedAt":0},"nonce":"n1","n":1.5,"b":false,"s":""}';
  assert.deepEqual(verifyState(SECRET, signedRaw(json), "user_1", T), {
    ok: true,
    state: { organizationId: "org_1", userId: "user_1", returnTo: "/", issuedAt: T, nonce: "n1" },
  });
});

// ---- @unhappy 4: signed under another secret ------------------------------

// Extends "[unhappy-4] a value signed under another secret is a bad
// signature": near-miss secrets, including long secrets that differ only past
// their 64th character and secrets that differ only in Unicode form.
test("[unhappy-4] near-miss secrets are a bad signature", () => {
  const long = SECRET.repeat(3);
  const pairs: Array<[string, string]> = [
    [SECRET.slice(0, -1), SECRET],
    [SECRET.toUpperCase(), SECRET],
    [long + "A", long + "B"],
    [SECRET + "x".repeat(40) + "1", SECRET + "x".repeat(40) + "2"],
    ["café-secret", "café-secret"],
    ["é", "Ã©"],
  ];
  for (const [signer, verifier] of pairs) {
    const value = signedN1(signer);
    assert.deepEqual(verifyState(signer, value, "user_1", T), okN1);
    assert.deepEqual(verifyState(verifier, value, "user_1", T), BAD, `verify under ${verifier.slice(-8)}`);
  }
});

// ---- @unhappy 5: a rewritten payload keeps the old signature --------------

// Extends "[unhappy-5] a payload rewritten to another user is a bad
// signature": other fields rewritten, including a later issuedAt that would
// extend the lifetime.
test("[unhappy-5] rewriting any field under the old signature is a bad signature", () => {
  const { signature } = split(signedN1());
  for (const rewritten of [
    fields({ organizationId: "org_2" }),
    fields({ issuedAt: T + 86400000 }),
    fields({ nonce: "n2" }),
    fields({ returnTo: "//evil.example" }),
  ]) {
    const p2 = encode(JSON.stringify(rewritten));
    assert.deepEqual(
      verifyState(SECRET, `${p2}.${signature}`, "user_1", rewritten.issuedAt),
      BAD,
    );
  }
});

// Re-encodings of the same payload bytes keep the old signature: the HMAC is
// over the payload segment exactly as received.
test("[unhappy-5] the same payload bytes in another base64 spelling are a bad signature", () => {
  const state = fields({ returnTo: "/~~~" });
  const value = signState(SECRET, state);
  const { payload, signature } = split(value);
  assert.match(payload, /[-_]/);
  const standard = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = Buffer.from(payload, "base64url").toString("base64");
  for (const respelled of [standard, padded, payload + "=", payload + "=="]) {
    assert.notEqual(respelled, payload);
    assert.deepEqual(verifyState(SECRET, `${respelled}.${signature}`, "user_1", T), BAD);
  }
});

// Swapping signatures between two genuine values.
test("[unhappy-5] signatures swapped between two genuine values are bad", () => {
  const a = split(signedN1());
  const b = split(signState(SECRET, fields({ userId: "user_2" })));
  assert.deepEqual(verifyState(SECRET, `${a.payload}.${b.signature}`, "user_1", T), BAD);
  assert.deepEqual(verifyState(SECRET, `${b.payload}.${a.signature}`, "user_2", T), BAD);
});

// ---- @unhappy 6: a damaged signature ---------------------------------------

// Extends "[unhappy-6] a signature with its last character changed or dropped
// is bad": every other last character, including those that differ only in
// the two unused low bits and so decode to the same 32 bytes.
test("[unhappy-6] every other last character is a bad signature", () => {
  const { payload, signature } = split(KNOWN);
  const last = signature.slice(-1);
  let tried = 0;
  for (const c of BASE64URL) {
    if (c === last) continue;
    const damaged = signature.slice(0, -1) + c;
    assert.deepEqual(
      verifyState(SECRET, `${payload}.${damaged}`, "user_1", T),
      BAD,
      `last character ${c}`,
    );
    tried += 1;
  }
  assert.equal(tried, 63);
});

// Extends "[unhappy-6] ..." tests: a change at each position, other spellings
// of the same bytes, padding, case changes, and an empty signature.
test("[unhappy-6] a change at any position, a respelling or an empty signature is bad", () => {
  const { payload, signature } = split(KNOWN);
  assert.equal(verifyState(SECRET, KNOWN, "user_1", T).ok, true);
  const damaged: string[] = [];
  for (let i = 0; i < signature.length; i += 1) {
    const c = signature.charAt(i);
    const next = BASE64URL.charAt((BASE64URL.indexOf(c) + 1) % 64);
    damaged.push(signature.slice(0, i) + next + signature.slice(i + 1));
  }
  assert.match(signature, /-/);
  damaged.push(
    signature.replace(/-/g, "+").replace(/_/g, "/"),
    Buffer.from(signature, "base64url").toString("base64"),
    signature + "=",
    signature.toLowerCase(),
    signature.toUpperCase(),
    signature.split("").reverse().join(""),
    "",
    " " + signature.slice(1),
    hmac(SECRET, payload + "x"),
  );
  for (const candidate of damaged) {
    assert.notEqual(candidate, signature);
    assert.deepEqual(
      verifyState(SECRET, `${payload}.${candidate}`, "user_1", T),
      BAD,
      `signature ${candidate}`,
    );
  }
});

// ---- @unhappy 7: a bad signature is reported first -------------------------

// Extends both "[unhappy-7] ..." tests: a bad signature wins over every later
// failure and over a value that would otherwise verify.
test("[unhappy-7] a bad signature is reported over every later check", () => {
  const forged = signedN1(OTHER_SECRET);
  assert.deepEqual(verifyState(SECRET, forged, "user_1", T), BAD);
  assert.deepEqual(verifyState(SECRET, forged, "user_1", Number.NaN), BAD);
  assert.deepEqual(verifyState(SECRET, forged, "user_2", T), BAD);
  assert.deepEqual(verifyState(SECRET, forged, "", T - 60001), BAD);
  for (const json of [
    stateJson({ issuedAt: "null" }),
    stateJson({ userId: "" }),
    "[1,2]",
    "null",
  ]) {
    assert.deepEqual(
      verifyState(SECRET, signedRaw(json, OTHER_SECRET), "user_2", T + 86400000),
      BAD,
      `payload ${json}`,
    );
  }
  const nanState = signState(OTHER_SECRET, fields({ issuedAt: Number.NaN }));
  assert.deepEqual(verifyState(SECRET, nanState, "user_1", T), BAD);
});

// ---- @unhappy 8: an empty secret is an ordinary secret --------------------

// Extends "[unhappy-8] verifying under an empty secret does not throw and is a
// bad signature": other users, clocks and payloads under the empty secret.
test("[unhappy-8] the empty secret rejects values signed under any other secret, without throwing", () => {
  const candidates = [
    signedN1(),
    signedN1(OTHER_SECRET),
    signedN1(" "),
    signedRaw("not json"),
    signedRaw(stateJson({})),
  ];
  for (const value of candidates) {
    for (const [user, now] of [
      ["user_1", T],
      ["user_2", T + 86400000],
      ["", Number.NaN],
    ] as const) {
      let result: ReturnType<typeof verifyState> | undefined;
      assert.doesNotThrow(() => {
        result = verifyState("", value, user, now);
      });
      assert.deepEqual(result, BAD);
    }
  }
});

// ---- @unhappy 9: the expected user does not match exactly -----------------

// Extends "[unhappy-9] the user comparison is exact": prefixes, extensions,
// invisible characters, full-width and Unicode-normalization lookalikes.
test("[unhappy-9] near-miss expected users all get wrong-user", () => {
  const value = signedN1();
  for (const expected of [
    "user_10",
    "user_",
    "user",
    " user_1",
    "\tuser_1",
    "user_1\u0000",
    "user_1​",
    "User_1",
    "ｕｓｅｒ_１",
    "org_1",
  ]) {
    assert.deepEqual(
      verifyState(SECRET, value, expected, T),
      WRONG_USER,
      `expected ${JSON.stringify(expected)}`,
    );
  }
  const composed = signState(SECRET, fields({ userId: "josé" }));
  assert.deepEqual(verifyState(SECRET, composed, "josé", T), WRONG_USER);
  assert.deepEqual(verifyState(SECRET, composed, "JOSÉ", T), WRONG_USER);
});

// An empty signed userId does not match a non-empty expected one; extra keys
// in the payload do not change the user check; and the empty secret reaches the
// user check like any other secret.
test("[unhappy-9] wrong-user holds for empty signed users, payload extras and the empty secret", () => {
  const emptyUser = signState(SECRET, fields({ userId: "" }));
  assert.deepEqual(verifyState(SECRET, emptyUser, "user_1", T), WRONG_USER);

  const withExtras = signedRaw(
    '{"organizationId":"org_1","userId":"user_1","returnTo":"/","issuedAt":1700000000000,"nonce":"n1","expectedUserId":"user_2"}',
  );
  assert.deepEqual(verifyState(SECRET, withExtras, "user_2", T), WRONG_USER);

  assert.deepEqual(verifyState("", signedN1(""), "user_2", T), WRONG_USER);
});

// ---- @unhappy 10: expiry is reported before the user mismatch -------------

// Extends both "[unhappy-10] ..." tests: other mismatching users, far and
// infinite clocks, and payloads the module did not produce.
test("[unhappy-10] expiry is reported before the user mismatch in other combinations", () => {
  const value = signedN1();
  for (const [user, now] of [
    ["user_2", T + 86400000],
    ["", T + 600001],
    ["USER_1", T - 60001],
    ["user_2", Number.POSITIVE_INFINITY],
    ["user_2", Number.NEGATIVE_INFINITY],
  ] as const) {
    assert.deepEqual(verifyState(SECRET, value, user, now), EXPIRED, `${user} at ${now}`);
  }
  assert.deepEqual(
    verifyState(SECRET, signedRaw(stateJson({ issuedAt: "1.5" })), "user_2", T),
    EXPIRED,
  );
  assert.deepEqual(
    verifyState("", signState("", fields({ issuedAt: -1 })), "user_2", T),
    EXPIRED,
  );
});
