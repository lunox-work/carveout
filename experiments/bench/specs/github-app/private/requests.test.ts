import assert from "node:assert/strict";
import { test } from "node:test";

import {
  linkInstallationRequestSchema,
  registerRepoRequestSchema,
} from "../../src/index.js";

/*
 * Hidden checks on the bodies our clients send: GitHub id text is exactly
 * ^[1-9][0-9]{0,18}$, it stays a string, and unknown keys are stripped.
 */

const MESSAGE = "Expected a GitHub id.";

const samePath = (path: readonly PropertyKey[], expected: readonly string[]) =>
  JSON.stringify(path) === JSON.stringify(expected);

type Issues = { issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }> };

const hasIssue = (
  error: Issues | undefined,
  path: readonly string[],
  message?: string,
) =>
  error?.issues.some(
    (issue) =>
      samePath(issue.path, path) &&
      (message === undefined || issue.message === message),
  ) ?? false;

// Extends "[happy-4] a canonical id is accepted and kept as a string": every
// leading digit, every length from 1 to 19, and ids a Number() round trip
// would corrupt.
test("[happy-4] ids of every length from one to nineteen digits are accepted verbatim", () => {
  const ids: string[] = [];
  for (let length = 1; length <= 19; length += 1) {
    ids.push("9".repeat(length));
    ids.push("1" + "0".repeat(length - 1));
  }
  for (const first of "123456789") ids.push(first + "05");
  ids.push(
    "9223372036854775807",
    "9223372036854775808",
    "1234567890123456789",
    "9007199254740995",
    "18014398509481985",
  );
  for (const id of ids) {
    const result = registerRepoRequestSchema.safeParse({
      externalId: id,
      role: "source",
    });
    assert.equal(result.success, true, id);
    assert.equal(result.data?.externalId, id);
    assert.equal(typeof result.data?.externalId, "string");
  }
});

// Extends "[boundary-1] a twenty-digit id is refused": other twenty-digit ids
// and longer ones, on both bodies, always with the GitHub id message.
test("[boundary-1] every id of twenty digits or more is refused with the GitHub id message", () => {
  for (const id of [
    "12345678901234567890",
    "10000000000000000001",
    "18446744073709551615",
    "18446744073709551616",
    "1" + "0".repeat(20),
    "9".repeat(40),
  ]) {
    const result = registerRepoRequestSchema.safeParse({
      externalId: id,
      role: "source",
    });
    assert.equal(result.success, false, id);
    assert.ok(hasIssue(result.error, ["externalId"], MESSAGE), id);
  }
});

// Extends "[unhappy-5] the link body refuses a twenty-digit id with the GitHub
// id message": other twenty-digit and longer ids.
test("[unhappy-5] the link body refuses other ids of twenty digits or more", () => {
  for (const installationId of ["12345678901234567890", "99999999999999999999", "1" + "0".repeat(25)]) {
    const result = linkInstallationRequestSchema.safeParse({ installationId });
    assert.equal(result.success, false, installationId);
    assert.ok(hasIssue(result.error, ["installationId"], MESSAGE), installationId);
  }
});

// Extends "[unhappy-3] a non-canonical id is refused rather than normalised":
// other leading-zero, sign, separator, base, whitespace and non-ASCII digit
// spellings.
test("[unhappy-3] other non-canonical spellings are refused with the GitHub id message", () => {
  for (const id of [
    "00",
    "0000",
    "01",
    "0000000000000000001",
    "-0",
    "-42",
    "+42",
    "1_000",
    "1,000",
    "1 000",
    "0x1A",
    "0b1",
    "1e19",
    "12a",
    "a12",
    "\t12",
    "12\t",
    "\n12",
    "１２",
    "١٢",
    "Infinity",
    "NaN",
    "42.0",
    ".5",
  ]) {
    const result = registerRepoRequestSchema.safeParse({
      externalId: id,
      role: "source",
    });
    assert.equal(result.success, false, JSON.stringify(id));
    assert.ok(hasIssue(result.error, ["externalId"], MESSAGE), JSON.stringify(id));
  }
});

// Extends "[unhappy-4] a numeric externalId is refused, not coerced": other
// numbers and other non-string types.
test("[unhappy-4] other numbers and non-string externalIds are refused at their path", () => {
  for (const externalId of [7, 1, 0, 9007199254740991, 1.5, true, ["7"], { id: "7" }]) {
    const result = registerRepoRequestSchema.safeParse({
      externalId,
      role: "source",
    });
    assert.equal(result.success, false, JSON.stringify(externalId));
    assert.ok(hasIssue(result.error, ["externalId"]), JSON.stringify(externalId));
  }
});

// Extends "[happy-5] the link body takes GitHub's installation id as text":
// other ids, and the setup callback's own fields are stripped.
test("[happy-5] the link body keeps other installation ids as text and strips callback fields", () => {
  for (const installationId of ["1", "7", "9007199254740993", "1000000000000000000", "1234567890123456789"]) {
    const parsed = linkInstallationRequestSchema.parse({
      installationId,
      installation_id: Number(installationId.slice(0, 5)),
      setup_action: "install",
      state: "s",
    });
    assert.deepEqual(parsed, { installationId });
    assert.deepEqual(Object.keys(parsed), ["installationId"]);
  }
});

// Extends "[unhappy-5] the link body refuses an id that is not GitHub id text":
// the GitHub id message on the spec's string examples, and other spellings.
test("[unhappy-5] the link body refuses non-canonical text with the GitHub id message", () => {
  for (const installationId of ["0", "042", "", "-42", " 42", "42 ", "4 2", "1e3", "abc", "+7"]) {
    const result = linkInstallationRequestSchema.safeParse({ installationId });
    assert.equal(result.success, false, JSON.stringify(installationId));
    assert.ok(
      hasIssue(result.error, ["installationId"], MESSAGE),
      JSON.stringify(installationId),
    );
  }
});

test("[unhappy-5] the link body refuses a missing, null or non-string id at its path", () => {
  for (const body of [
    {},
    { installationId: null },
    { installationId: 7 },
    { installationId: 9007199254740991 },
    { installationId: ["42"] },
    { installation_id: "42" },
  ]) {
    const result = linkInstallationRequestSchema.safeParse(body);
    assert.equal(result.success, false, JSON.stringify(body));
    assert.ok(hasIssue(result.error, ["installationId"]), JSON.stringify(body));
  }
});

// Extends "[happy-17] a register body parses unchanged": other ids.
test("[happy-17] register bodies with other ids parse unchanged", () => {
  for (const externalId of ["1", "123456789", "1000000000000000000", "9007199254740992"]) {
    assert.deepEqual(
      registerRepoRequestSchema.parse({ externalId, role: "source" }),
      { externalId, role: "source" },
    );
  }
});

// Extends "[happy-18] unknown keys in a register body are stripped": more
// keys, including snake_case spellings and ones that look like our fields.
test("[happy-18] many unknown keys are stripped, leaving exactly the id and role", () => {
  const parsed = registerRepoRequestSchema.parse({
    full_name: "octo/hello",
    externalId: "9999999999999999999",
    connection_id: "ghc_1",
    installationId: "42",
    role: "source",
    defaultBranch: "main",
    headSha: "abc",
    syncStatus: "ok",
    extra: { nested: [1, 2, 3] },
  });
  assert.deepEqual(parsed, { externalId: "9999999999999999999", role: "source" });
  assert.deepEqual(Object.keys(parsed).sort(), ["externalId", "role"]);
});

// Extends "[unhappy-12] a register body without a valid role is refused":
// other spellings and non-strings, always reported at ["role"].
test("[unhappy-12] other invalid roles are refused at the role path", () => {
  for (const role of ["SOURCE", "source ", " source", "sources", "src", "ok", 1, true, ["source"], {}]) {
    const result = registerRepoRequestSchema.safeParse({
      externalId: "123456789",
      role,
    });
    assert.equal(result.success, false, JSON.stringify(role));
    assert.ok(hasIssue(result.error, ["role"]), JSON.stringify(role));
  }
});
