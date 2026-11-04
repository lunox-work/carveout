import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GITHUB_CONNECT_OUTCOMES,
  GITHUB_INSTALLATION_STATUSES,
  GITHUB_REPO_ROLES,
  GITHUB_SYNC_STATUSES,
  GITHUB_WEBHOOK_HEADERS,
  githubAvailableInstallationDtoSchema,
  githubConnectionDtoSchema,
  githubConnectOutcomeSchema,
  githubRepoDtoSchema,
  githubRepoRoleSchema,
  githubSyncStatusSchema,
  registerRepoRequestSchema,
} from "../../src/index.js";

/*
 * Hidden checks on the closed vocabularies: exact contents, exact casing, and
 * the schemas that are built from them.
 */

const samePath = (path: readonly PropertyKey[], expected: readonly string[]) =>
  JSON.stringify(path) === JSON.stringify(expected);

const connection = {
  id: "ghc_1",
  installationId: "42",
  accountLogin: "octo-org",
  accountType: "Organization",
  repositorySelection: "selected",
  healthy: true,
  suspendedAt: null,
  uninstalledAt: null,
  settingsUrl:
    "https://github.com/organizations/octo-org/settings/installations/42",
  createdAt: "2026-11-01T00:00:00.000Z",
};

const available = {
  installationId: "42",
  accountLogin: "o",
  accountType: "User",
  repositorySelection: "all",
};

const repo = {
  id: "ghr_1",
  connectionId: "ghc_1",
  role: "source",
  externalId: "7",
  fullName: "Octo/Hello",
  defaultBranch: "main",
  isPrivate: true,
  sizeKb: null,
  headSha: null,
  pushedAt: null,
  lastSyncedAt: null,
  syncStatus: "pending",
  syncError: null,
  createdAt: "2026-11-01T00:00:00.000Z",
};

// Extends "[happy-1] the constants list their values in order": exact lengths,
// exact header keys, and no vocabulary leaking into another.
test("[happy-1] the constants hold exactly their listed values and no more", () => {
  assert.equal(GITHUB_REPO_ROLES.length, 1);
  assert.equal(GITHUB_SYNC_STATUSES.length, 4);
  assert.equal(GITHUB_INSTALLATION_STATUSES.length, 5);
  assert.equal(GITHUB_CONNECT_OUTCOMES.length, 11);
  assert.deepEqual(Object.keys(GITHUB_WEBHOOK_HEADERS).sort(), [
    "delivery",
    "event",
    "signature",
  ]);
  assert.equal(GITHUB_WEBHOOK_HEADERS.event, "x-github-event");
  assert.equal(GITHUB_WEBHOOK_HEADERS.delivery, "x-github-delivery");
  assert.equal(GITHUB_WEBHOOK_HEADERS.signature, "x-hub-signature-256");
  assert.equal(GITHUB_CONNECT_OUTCOMES[0], "connected");
  assert.equal(GITHUB_CONNECT_OUTCOMES[10], "error");
  assert.equal(GITHUB_INSTALLATION_STATUSES[3], "not-authorized");
  assert.equal(GITHUB_SYNC_STATUSES[3], "gone");
});

// Extends "[happy-1] each enum schema's options are its constant": the
// available installation's status takes exactly GITHUB_INSTALLATION_STATUSES.
test("[happy-1] the available installation's status options are exactly the installation statuses", () => {
  assert.deepEqual(
    [...githubAvailableInstallationDtoSchema.shape.status.options].sort(),
    [...GITHUB_INSTALLATION_STATUSES].sort(),
  );
});

// Extends "[happy-2] every listed value ... is accepted by its schema": the
// values are accepted where the DTOs and the register body use them too.
test("[happy-2] every sync status and role is accepted inside the repo DTO and the register body", () => {
  for (const syncStatus of ["pending", "ok", "error", "gone"]) {
    assert.equal(
      githubRepoDtoSchema.parse({ ...repo, syncStatus }).syncStatus,
      syncStatus,
    );
  }
  assert.equal(githubRepoDtoSchema.parse({ ...repo, role: "source" }).role, "source");
  assert.equal(
    registerRepoRequestSchema.parse({ externalId: "1", role: "source" }).role,
    "source",
  );
});

test("[happy-2] each connect outcome parses to itself through safeParse", () => {
  for (const value of [
    "connected",
    "pick",
    "cancelled",
    "state",
    "forbidden",
    "not-visible",
    "claimed",
    "not-authorized",
    "unavailable",
    "denied",
    "error",
  ]) {
    const result = githubConnectOutcomeSchema.safeParse(value);
    assert.equal(result.success, true, value);
    assert.equal(result.data, value);
  }
});

// Extends "[unhappy-1] an enum schema refuses other casing and unknown
// values": all-caps, values from a neighbouring vocabulary, and non-strings.
test("[unhappy-1] an enum schema refuses upper case, a neighbour's values and non-strings", () => {
  const cases: Array<[{ safeParse(value: unknown): { success: boolean } }, unknown]> = [
    [githubRepoRoleSchema, "SOURCE"],
    [githubRepoRoleSchema, "sources"],
    [githubRepoRoleSchema, "pending"],
    [githubRepoRoleSchema, null],
    [githubRepoRoleSchema, undefined],
    [githubRepoRoleSchema, ["source"]],
    [githubSyncStatusSchema, "PENDING"],
    [githubSyncStatusSchema, "Gone"],
    [githubSyncStatusSchema, "connected"],
    [githubSyncStatusSchema, "ok\n"],
    [githubSyncStatusSchema, 1],
    [githubSyncStatusSchema, null],
    [githubConnectOutcomeSchema, "CONNECTED"],
    [githubConnectOutcomeSchema, "linked"],
    [githubConnectOutcomeSchema, "free"],
    [githubConnectOutcomeSchema, "not visible"],
    [githubConnectOutcomeSchema, "Error"],
    [githubConnectOutcomeSchema, 0],
  ];
  for (const [schema, value] of cases) {
    assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));
  }
});

// Extends "[unhappy-2] an available installation's status is closed": a
// neighbour vocabulary's value, null, a number and a missing status.
test("[unhappy-2] an available installation's status refuses a connect outcome, null, a number or absence", () => {
  const bodies: Array<Record<string, unknown>> = [
    { ...available, status: "connected" },
    { ...available, status: "pending" },
    { ...available, status: "LINKED" },
    { ...available, status: "free " },
    { ...available, status: null },
    { ...available, status: 0 },
    { ...available },
  ];
  for (const body of bodies) {
    const result = githubAvailableInstallationDtoSchema.safeParse(body);
    assert.equal(result.success, false, JSON.stringify(body));
    assert.ok(
      result.error?.issues.some((issue) => samePath(issue.path, ["status"])),
      JSON.stringify(body),
    );
  }
});

// Extends "[happy-3] account type and repository selection are free strings":
// types GitHub has but no shortcut enum would list, and long values.
test("[happy-3] account type and repository selection keep values beyond the examples", () => {
  for (const [accountType, repositorySelection] of [
    ["Bot", "selected"],
    ["Mannequin", "none"],
    ["ORGANIZATION", "All"],
    ["User ", " all"],
    ["x".repeat(500), "y".repeat(500)],
  ] as const) {
    const parsed = githubConnectionDtoSchema.parse({
      ...connection,
      accountType,
      repositorySelection,
    });
    assert.equal(parsed.accountType, accountType);
    assert.equal(parsed.repositorySelection, repositorySelection);
  }
});

test("[happy-3] the available installation DTO keeps account type and selection in GitHub's casing", () => {
  for (const [accountType, repositorySelection] of [
    ["Organization", "selected"],
    ["User", "all"],
    ["Enterprise", "some"],
  ] as const) {
    const dto = { ...available, accountType, repositorySelection, status: "free" };
    assert.deepEqual(githubAvailableInstallationDtoSchema.parse(dto), dto);
  }
});
