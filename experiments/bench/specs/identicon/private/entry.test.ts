/**
 * Hidden tests for the package surface: the entry point re-exports identicon
 * and keeps every existing export.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as buildInfoModule from "../../src/build-info.js";
import { type BuildInfoDto } from "../../src/build-info.js";
import { identicon } from "../../src/identicon.js";
import * as entry from "../../src/index.js";
import * as jiraModule from "../../src/jira.js";

/**
 * Read through the namespace rather than a named import, so this file still
 * compiles before the entry point gains the re-export.
 */
const fromEntry = (entry as Record<string, unknown>).identicon as
  | typeof identicon
  | undefined;

/** The entry point's own exports before identicon was added. */
const INDEX_OWN = [
  "handleSchema",
  "ORGANIZATION_ROLES",
  "organizationRoleSchema",
  "ORGANIZATION_KINDS",
  "organizationKindSchema",
  "organizationSummarySchema",
  "membershipSchema",
  "membershipListSchema",
  "organizationMemberSchema",
  "organizationMemberListSchema",
  "pendingInvitationSchema",
  "pendingInvitationListSchema",
  "inviteMemberSchema",
  "errorSchema",
];

const identified: BuildInfoDto = {
  version: "1.4.2",
  gitSha: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
  gitShortSha: "7f3a9c1",
  buildTime: "2026-09-17T09:14:00.000Z",
  gitRef: "main",
  dirty: false,
};

// Extends "the entry point re-exports the same identicon function": called
// through the entry point, it gives the pinned faces.
test("[happy-5] identicon through the entry point gives the pinned faces", () => {
  assert.equal(typeof fromEntry, "function");
  const face = fromEntry!("user-2");
  assert.deepEqual(face.cells, identicon("user-2").cells);
  assert.equal(face.hue, 62);
  assert.deepEqual(fromEntry!("user-46623"), identicon("user-46623"));
});

// Extends "the existing exports of the entry point behave as before": every
// build-info and jira export is still there under its name, the same value,
// alongside identicon.
test("[happy-5] every build-info and jira export is still on the entry point with identicon", () => {
  assert.equal(fromEntry, identicon);
  const record = entry as Record<string, unknown>;
  for (const [name, value] of [
    ...Object.entries(buildInfoModule),
    ...Object.entries(jiraModule),
  ]) {
    assert.ok(name in entry, `missing ${name}`);
    assert.equal(record[name], value, `changed ${name}`);
  }
  for (const name of INDEX_OWN) assert.ok(name in entry, `missing ${name}`);
});

// Extends "the existing exports of the entry point behave as before": more of
// build-info's functions, read from the entry point next to identicon.
test("[happy-5] build-info functions on the entry point behave as before next to identicon", () => {
  assert.equal(fromEntry, identicon);
  assert.equal(
    entry.formatVersion({ ...identified, dirty: true }),
    "1.4.2+7f3a9c1-dirty",
  );
  assert.equal(entry.formatVersion(entry.unknownBuildInfo), "0.0.0");
  assert.equal(entry.isIdentified(identified), true);
  assert.equal(entry.isIdentified(entry.unknownBuildInfo), false);
  assert.equal(entry.releaseTag("1.0.0"), "sandbox-factory-v1.0.0");
  assert.equal(entry.unknownBuildInfo.gitSha, entry.UNKNOWN_BUILD);
  assert.equal(entry.buildBanner("api", entry.unknownBuildInfo), "api 0.0.0");
  assert.equal(entry.sameBuild(identified, entry.unknownBuildInfo), true);
});

// Extends "the existing exports of the entry point behave as before": the
// entry point's own schemas, next to identicon.
test("[happy-5] the entry point's own schemas behave as before next to identicon", () => {
  assert.equal(fromEntry, identicon);
  assert.deepEqual([...entry.ORGANIZATION_ROLES], ["owner", "admin", "member"]);
  assert.deepEqual([...entry.ORGANIZATION_KINDS], ["personal", "team"]);
  for (const candidate of ["has space", "has/slash", "has@at"]) {
    assert.equal(entry.handleSchema.safeParse(candidate).success, false);
  }
  assert.equal(
    entry.organizationSummarySchema.parse({ id: "o1", name: "Acme", slug: "acme" })
      .kind,
    "team",
  );
  assert.ok(entry.inviteMemberSchema.safeParse({ handle: "dana" }).success);
  assert.equal(
    entry.inviteMemberSchema.safeParse({
      handle: "dana",
      email: "dana@example.test",
    }).success,
    false,
  );
});

// Extends "the identicon module exports identicon and nothing else": the hash
// and bit layout stay private, so the entry point gains identicon alone and
// nothing named after them.
test("[happy-5] the entry point gains identicon but none of its private helpers", () => {
  assert.equal(fromEntry, identicon);
  const before = new Set([
    ...Object.keys(buildInfoModule),
    ...Object.keys(jiraModule),
    ...INDEX_OWN,
  ]);
  const added = Object.keys(entry).filter((name) => !before.has(name));
  assert.ok(added.includes("identicon"));
  for (const name of added) {
    assert.doesNotMatch(name, /fnv|hash|bit|layout|mirror/i, `leaked ${name}`);
  }
});
