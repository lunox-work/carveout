/**
 * Hidden tests for #45: every export other than `verifyCommand` keeps its
 * current behaviour when the record carries an `imageDigest`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBanner,
  buildInfoSchema,
  commitUrl,
  formatVersion,
  isIdentified,
  releaseUrl,
  sameBuild,
  unknownBuildInfo,
  versionResponseSchema,
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

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_REAL =
  "sha256:9b2c4e1f7a3d5b8c0e6f2a4d1b7c9e3f5a8d0b2c4e6f1a3d5b7c9e0f2a4d6b8c";

const withDigest = (digest: string): BuildInfoDto => ({
  ...identified,
  imageDigest: digest,
});

// --- @happy 4 ---

// Extends "[happy-4] buildInfoSchema accepts a record with a digest and rejects an empty one".
for (const digest of [DIGEST_REAL, "sha512:abc", "not-a-digest"]) {
  test(`[happy-4] buildInfoSchema accepts the digest ${JSON.stringify(digest)} and returns the record`, () => {
    const record = withDigest(digest);
    assert.deepEqual(buildInfoSchema.parse(record), record);
  });
}

test("[happy-4] buildInfoSchema rejects an empty digest on the unknown fallback and on a dirty record", () => {
  assert.equal(
    buildInfoSchema.safeParse({ ...unknownBuildInfo, imageDigest: "" }).success,
    false,
  );
  assert.equal(
    buildInfoSchema.safeParse({ ...identified, dirty: true, imageDigest: "" }).success,
    false,
  );
});

test("[happy-4] buildInfoSchema still accepts the record with no digest, and versionResponseSchema is the same schema", () => {
  assert.deepEqual(buildInfoSchema.parse(identified), identified);
  assert.equal(versionResponseSchema, buildInfoSchema);
  assert.deepEqual(versionResponseSchema.parse(withDigest(DIGEST_A)), withDigest(DIGEST_A));
});

// --- @happy 5 ---

// Extends the "[happy-5] ... is unchanged by a digest" tests: other digests,
// dirty and unidentified records.
test("[happy-5] formatVersion is unchanged by a digest on a dirty record", () => {
  assert.equal(
    formatVersion({ ...identified, dirty: true, imageDigest: DIGEST_REAL }),
    "1.4.2+7f3a9c1-dirty",
  );
});

test("[happy-5] formatVersion is unchanged by a digest on the unknown fallback", () => {
  assert.equal(formatVersion({ ...unknownBuildInfo, imageDigest: DIGEST_A }), "0.0.0");
});

test("[happy-5] isIdentified stays false for the unknown fallback with a digest", () => {
  assert.equal(isIdentified({ ...unknownBuildInfo, imageDigest: DIGEST_A }), false);
  assert.equal(isIdentified(withDigest("")), true);
});

test("[happy-5] commitUrl stays undefined for the unknown fallback with a digest", () => {
  assert.equal(commitUrl({ ...unknownBuildInfo, imageDigest: DIGEST_A }), undefined);
  assert.equal(
    commitUrl(withDigest(DIGEST_REAL)),
    "https://github.com/lunox-work/sandbox-factory/commit/7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
  );
});

test("[happy-5] releaseUrl stays undefined for an unidentified release-shaped record with a digest", () => {
  assert.equal(
    releaseUrl({
      ...unknownBuildInfo,
      version: "1.0.0",
      gitRef: "sandbox-factory-v1.0.0",
      imageDigest: DIGEST_A,
    }),
    undefined,
  );
});

test("[happy-5] sameBuild still compares only the sha when both sides have digests", () => {
  const other: BuildInfoDto = {
    ...identified,
    gitSha: "1".repeat(40),
    gitShortSha: "1111111",
  };
  assert.equal(sameBuild({ ...other, imageDigest: DIGEST_A }, withDigest(DIGEST_A)), false);
  assert.equal(sameBuild(withDigest(DIGEST_A), withDigest(DIGEST_REAL)), true);
  assert.equal(sameBuild(identified, withDigest(DIGEST_REAL)), true);
  assert.equal(sameBuild({ ...unknownBuildInfo, imageDigest: DIGEST_A }, other), true);
});

test("[happy-5] buildBanner is unchanged by a digest on the unknown fallback and a dirty record", () => {
  assert.equal(buildBanner("web", { ...unknownBuildInfo, imageDigest: DIGEST_A }), "web 0.0.0");
  assert.equal(
    buildBanner("api", { ...identified, dirty: true, imageDigest: DIGEST_REAL }),
    "api 1.4.2+7f3a9c1-dirty · commit 7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09 · built 2026-09-17T09:14:00.000Z",
  );
});

test("[happy-5] buildBanner never prints the digest", () => {
  const banner = buildBanner("api", withDigest(DIGEST_REAL));
  assert.equal(
    banner,
    "api 1.4.2+7f3a9c1 · commit 7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09 · built 2026-09-17T09:14:00.000Z",
  );
  assert.ok(!banner.includes(DIGEST_REAL));
});
