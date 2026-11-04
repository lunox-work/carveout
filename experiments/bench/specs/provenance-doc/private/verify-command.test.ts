/**
 * Hidden tests for #45: `verifyCommand` returns exactly
 * `gh api /repos/lunox-work/sandbox-factory/attestations/<digest>`, with the
 * digest verbatim, and `undefined` only when `imageDigest` is absent or
 * undefined. No other field decides the result.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  unknownBuildInfo,
  verifyCommand,
  type BuildInfoDto,
} from "../../src/build-info.js";

const identified: BuildInfoDto = {
  version: "1.4.2",
  gitSha: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
  gitShortSha: "7f3a9c1",
  buildTime: "2026-09-17T09:14:00.000Z",
  gitRef: "main",
  dirty: false,
};

const PREFIX = "gh api /repos/lunox-work/sandbox-factory/attestations/";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_HEX =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DIGEST_REAL =
  "sha256:9b2c4e1f7a3d5b8c0e6f2a4d1b7c9e3f5a8d0b2c4e6f1a3d5b7c9e0f2a4d6b8c";

const withDigest = (digest: string): BuildInfoDto => ({
  ...identified,
  imageDigest: digest,
});

const OLD_FRAGMENTS = ["gh attestation verify", "--digest", "--repo", "oci://"];

// --- @happy 1 ---

// Extends "[happy-1] a sha256 digest becomes the gh api attestations lookup":
// mixed hex digests, not a repeated character, so a hard-coded answer fails.
for (const digest of [DIGEST_REAL, DIGEST_HEX, `sha256:${"0".repeat(64)}`]) {
  test(`[happy-1] the sha256 digest ${digest.slice(0, 15)}… becomes exactly the lookup for it`, () => {
    assert.equal(verifyCommand(withDigest(digest)), `${PREFIX}${digest}`);
  });
}

test("[happy-1] the full literal command for a mixed-hex digest", () => {
  assert.equal(
    verifyCommand(withDigest(DIGEST_REAL)),
    "gh api /repos/lunox-work/sandbox-factory/attestations/sha256:9b2c4e1f7a3d5b8c0e6f2a4d1b7c9e3f5a8d0b2c4e6f1a3d5b7c9e0f2a4d6b8c",
  );
});

// Extends "[happy-1] a different sha256 digest...": the result tracks the
// digest call by call, with no caching of an earlier answer.
test("[happy-1] consecutive calls with different digests each give their own lookup", () => {
  const digests = [DIGEST_A, DIGEST_REAL, DIGEST_HEX, DIGEST_A, `sha256:${"f".repeat(64)}`];
  const results = digests.map((digest) => verifyCommand(withDigest(digest)));
  assert.deepEqual(
    results,
    digests.map((digest) => `${PREFIX}${digest}`),
  );
});

test("[happy-1] the command is the gh api path, with a leading slash and no flags", () => {
  const command = verifyCommand(withDigest(DIGEST_REAL));
  assert.equal(command, `gh api /repos/lunox-work/sandbox-factory/attestations/${DIGEST_REAL}`);
  assert.ok(command !== undefined && !command.includes("--jq"));
  assert.ok(command !== undefined && !command.includes("https://"));
});

// --- @happy 2 ---

// Extends "[happy-2] the digest is inserted verbatim with the colon unencoded":
// characters encodeURIComponent would rewrite must survive as they are.
for (const digest of [
  "sha256:a/b",
  "sha256:a+b=c",
  "sha256:a@b",
  "sha256:a?b#c",
  "sha256:a&b",
  "sha256:a b",
  "sha256:é",
]) {
  test(`[happy-2] the digest ${JSON.stringify(digest)} is inserted without any encoding`, () => {
    const command = verifyCommand(withDigest(digest));
    assert.equal(command, `${PREFIX}${digest}`);
    assert.ok(command !== undefined && !command.includes("%"));
  });
}

test("[happy-2] a mixed-hex sha256 digest keeps its colon unencoded", () => {
  const command = verifyCommand(withDigest(DIGEST_REAL));
  assert.equal(command, `${PREFIX}${DIGEST_REAL}`);
  assert.ok(command !== undefined && !command.includes("%3A"));
  assert.ok(command !== undefined && !command.includes("%3a"));
});

// --- @happy 3 ---

// Extends "[happy-3] the command is a single line with no surrounding whitespace":
// more digests and bases, and no carriage return either.
for (const [label, record] of [
  ["identified, mixed hex", withDigest(DIGEST_REAL)],
  ["dirty identified", { ...identified, dirty: true, imageDigest: DIGEST_A }],
  [
    "released",
    { ...identified, version: "1.0.0", gitRef: "sandbox-factory-v1.0.0", imageDigest: DIGEST_A },
  ],
] as const satisfies ReadonlyArray<readonly [string, BuildInfoDto]>) {
  test(`[happy-3] the command is one trimmed line for a ${label} record`, () => {
    const command = verifyCommand(record);
    assert.equal(typeof command, "string");
    assert.ok(command !== undefined && !command.includes("\n"));
    assert.ok(command !== undefined && !command.includes("\r"));
    assert.equal(command, command?.trim());
    assert.equal(command, `${PREFIX}${record.imageDigest}`);
  });
}

// --- @unhappy 1 ---

// Extends the "[unhappy-1] the command does not contain ..." tests: every old
// fragment is absent across several digests and bases, and the result is still
// the lookup (not undefined or an empty string).
for (const [label, record] of [
  ["mixed-hex digest", withDigest(DIGEST_REAL)],
  ["unknown fallback with a digest", { ...unknownBuildInfo, imageDigest: DIGEST_A }],
  ["empty digest", withDigest("")],
  [
    "released build",
    { ...identified, version: "1.0.0", gitRef: "sandbox-factory-v1.0.0", imageDigest: DIGEST_HEX },
  ],
] as const satisfies ReadonlyArray<readonly [string, BuildInfoDto]>) {
  test(`[unhappy-1] no old fragment appears for a ${label}`, () => {
    const command = verifyCommand(record);
    assert.equal(command, `${PREFIX}${record.imageDigest}`);
    for (const fragment of OLD_FRAGMENTS) {
      assert.ok(!command?.includes(fragment), fragment);
    }
    assert.ok(!command?.includes("attestation verify"));
  });
}

// --- @unhappy 2 ---

// Extends "[unhappy-2] a record with no imageDigest property gives undefined":
// other records without the property, including an unidentified one.
for (const [label, record] of [
  ["unidentified copy of identified", { ...identified, gitSha: "unknown", gitShortSha: "unknown" }],
  ["released clean", { ...identified, version: "1.0.0", gitRef: "sandbox-factory-v1.0.0" }],
  ["different sha", { ...identified, gitSha: "0".repeat(40), gitShortSha: "0000000" }],
] as const satisfies ReadonlyArray<readonly [string, BuildInfoDto]>) {
  test(`[unhappy-2] a ${label} record with no imageDigest property gives undefined`, () => {
    assert.equal("imageDigest" in record, false);
    assert.equal(verifyCommand(record), undefined);
    // "only when absent": the same record with a digest gives the lookup.
    assert.equal(verifyCommand({ ...record, imageDigest: DIGEST_REAL }), `${PREFIX}${DIGEST_REAL}`);
  });
}

test("[unhappy-2] a record without a digest gives undefined after a call that had one", () => {
  assert.equal(verifyCommand(withDigest(DIGEST_REAL)), `${PREFIX}${DIGEST_REAL}`);
  assert.equal(verifyCommand(identified), undefined);
});

// --- @unhappy 3 ---

// Extends "[unhappy-3] imageDigest explicitly set to undefined gives undefined".
for (const [label, record] of [
  ["dirty", { ...identified, dirty: true, imageDigest: undefined }],
  [
    "released",
    { ...identified, version: "1.0.0", gitRef: "sandbox-factory-v1.0.0", imageDigest: undefined },
  ],
] as const satisfies ReadonlyArray<readonly [string, BuildInfoDto]>) {
  test(`[unhappy-3] a ${label} record with imageDigest explicitly undefined gives undefined`, () => {
    assert.equal("imageDigest" in record, true);
    assert.equal(verifyCommand(record), undefined);
    // "only when undefined": the same record with a digest gives the lookup.
    assert.equal(verifyCommand({ ...record, imageDigest: DIGEST_REAL }), `${PREFIX}${DIGEST_REAL}`);
  });
}

test("[unhappy-3] explicit undefined gives undefined right after a call with a digest", () => {
  assert.equal(verifyCommand(withDigest(DIGEST_A)), `${PREFIX}${DIGEST_A}`);
  assert.equal(verifyCommand({ ...identified, imageDigest: undefined }), undefined);
});

// --- @boundary 1 ---

// Extends "[boundary-1] the unknown fallback record gives undefined": no state
// carried over from an earlier call on a copy of it that had a digest.
test("[boundary-1] the unknown fallback still gives undefined after a call on a copy with a digest", () => {
  assert.equal(
    verifyCommand({ ...unknownBuildInfo, imageDigest: DIGEST_REAL }),
    `${PREFIX}${DIGEST_REAL}`,
  );
  assert.equal(verifyCommand(unknownBuildInfo), undefined);
  assert.equal("imageDigest" in unknownBuildInfo, false);
});

test("[boundary-1] a plain copy of the unknown fallback gives undefined", () => {
  assert.equal(verifyCommand({ ...unknownBuildInfo }), undefined);
  assert.equal(verifyCommand({ ...unknownBuildInfo, imageDigest: "" }), PREFIX);
});

// --- @boundary 2 ---

// Extends the "[boundary-2] the digest ... passes through unchanged" tests:
// other algorithms, upper case, odd whitespace, very long values.
for (const imageDigest of [
  "sha384:0f0f",
  "SHA256:ABCDEF",
  `sha256:${"a".repeat(63)}`,
  `sha256:${"a".repeat(65)}`,
  "sha256:",
  ":",
  "   ",
  "\t",
  "a",
  "sha256:%3A",
  "sha256:aaaa sha256:bbbb",
  "x".repeat(10_000),
]) {
  test(`[boundary-2] the digest ${JSON.stringify(imageDigest.slice(0, 30))} (length ${imageDigest.length}) passes through unchanged`, () => {
    assert.equal(verifyCommand(withDigest(imageDigest)), `${PREFIX}${imageDigest}`);
  });
}

test("[boundary-2] a single-space digest gives a command ending in attestations/ and one space", () => {
  const command = verifyCommand(withDigest(" "));
  assert.equal(command, "gh api /repos/lunox-work/sandbox-factory/attestations/ ");
  assert.equal(command?.length, PREFIX.length + 1);
});

test("[boundary-2] a malformed digest on the unknown fallback passes through unchanged", () => {
  assert.equal(
    verifyCommand({ ...unknownBuildInfo, imageDigest: "not-a-digest" }),
    "gh api /repos/lunox-work/sandbox-factory/attestations/not-a-digest",
  );
});

// --- @boundary 3 ---

// Extends "[boundary-3] an empty imageDigest gives the command ending in attestations/".
for (const [label, record] of [
  ["dirty", { ...identified, dirty: true, imageDigest: "" }],
  [
    "released",
    { ...identified, version: "1.0.0", gitRef: "sandbox-factory-v1.0.0", imageDigest: "" },
  ],
  ["dirty unknown fallback", { ...unknownBuildInfo, dirty: true, imageDigest: "" }],
] as const satisfies ReadonlyArray<readonly [string, BuildInfoDto]>) {
  test(`[boundary-3] an empty imageDigest on a ${label} record gives the bare attestations/ command`, () => {
    const command = verifyCommand(record);
    assert.equal(command, "gh api /repos/lunox-work/sandbox-factory/attestations/");
    assert.equal(typeof command, "string");
  });
}

// --- @boundary 4 ---

// Extends the "[boundary-4] the same digest gives the same command for ..."
// tests: a digest other than DIGEST_A across every base, so an answer keyed to
// the visible digest fails.
const BASES: ReadonlyArray<readonly [string, BuildInfoDto]> = [
  ["identified", identified],
  ["unknownBuildInfo", unknownBuildInfo],
  ["dirty identified", { ...identified, dirty: true }],
  ["released", { ...identified, version: "1.0.0", gitRef: "sandbox-factory-v1.0.0" }],
  ["dirty released", { ...identified, dirty: true, version: "1.0.0", gitRef: "sandbox-factory-v1.0.0" }],
  ["unidentified with a short sha", { ...unknownBuildInfo, gitShortSha: "7f3a9c1" }],
  ["sha unknown, rest identified", { ...identified, gitSha: "unknown" }],
  ["different commit", { ...identified, gitSha: "1".repeat(40), gitShortSha: "1111111" }],
];

for (const [label, base] of BASES) {
  test(`[boundary-4] a mixed-hex digest gives the same command on a ${label} record`, () => {
    assert.equal(verifyCommand({ ...base, imageDigest: DIGEST_REAL }), `${PREFIX}${DIGEST_REAL}`);
  });
}

test("[boundary-4] every base gives one identical command for the same digest", () => {
  const commands = new Set(
    BASES.map(([, base]) => verifyCommand({ ...base, imageDigest: DIGEST_HEX })),
  );
  assert.deepEqual([...commands], [`${PREFIX}${DIGEST_HEX}`]);
});

test("[boundary-4] field order of the record does not matter", () => {
  const reordered: BuildInfoDto = {
    imageDigest: DIGEST_REAL,
    dirty: true,
    gitRef: "feature/x",
    buildTime: "unknown",
    gitShortSha: "unknown",
    gitSha: "unknown",
    version: "9.9.9",
  };
  assert.equal(verifyCommand(reordered), `${PREFIX}${DIGEST_REAL}`);
});

// --- @boundary 5 ---

// Extends "[boundary-5] verifyCommand leaves a record with a digest unchanged":
// a frozen record is accepted, and records of other shapes are left as they were.
test("[boundary-5] verifyCommand accepts a frozen record and returns the lookup", () => {
  const record = Object.freeze(withDigest(DIGEST_REAL));
  const copy = structuredClone(record);
  assert.equal(verifyCommand(record), `${PREFIX}${DIGEST_REAL}`);
  assert.deepEqual(record, copy);
});

for (const [label, record] of [
  ["empty digest", withDigest("")],
  ["unknown fallback with a digest", { ...unknownBuildInfo, imageDigest: DIGEST_A }],
  ["dirty released with a digest", { ...identified, dirty: true, version: "1.0.0", gitRef: "sandbox-factory-v1.0.0", imageDigest: DIGEST_HEX }],
] as const satisfies ReadonlyArray<readonly [string, BuildInfoDto]>) {
  test(`[boundary-5] verifyCommand leaves a ${label} record deep-equal to its copy`, () => {
    const target: BuildInfoDto = { ...record };
    const copy = structuredClone(target);
    const keys = Object.keys(target);
    const result = verifyCommand(target);
    assert.equal(result, target.imageDigest === undefined ? undefined : `${PREFIX}${target.imageDigest}`);
    assert.deepEqual(target, copy);
    assert.deepEqual(Object.keys(target), keys);
  });
}

test("[boundary-5] the shared unknown fallback is unchanged by verifyCommand", () => {
  const before = structuredClone(unknownBuildInfo);
  assert.equal(verifyCommand(unknownBuildInfo), undefined);
  assert.equal(verifyCommand({ ...unknownBuildInfo, imageDigest: DIGEST_A }), `${PREFIX}${DIGEST_A}`);
  assert.deepEqual(unknownBuildInfo, before);
  assert.deepEqual(unknownBuildInfo, {
    version: "0.0.0",
    gitSha: "unknown",
    gitShortSha: "unknown",
    buildTime: "unknown",
    gitRef: "unknown",
    dirty: false,
  });
});
