import assert from "node:assert/strict";
import { test } from "node:test";

import {
  githubAvailableInstallationDtoSchema,
  githubConnectionDtoSchema,
  githubGrantDtoSchema,
  githubInstallationRepositoryDtoSchema,
  githubRepoDtoSchema,
} from "../../src/index.js";

/*
 * Hidden checks on the DTOs we produce: strict, every field required, the
 * listed fields nullable, strings unchecked, unknown keys refused by name.
 */

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

const installationRepository = {
  externalId: "7",
  fullName: "octo/hello",
  defaultBranch: "main",
  isPrivate: true,
  registeredId: null,
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

const available = {
  installationId: "42",
  accountLogin: "o",
  accountType: "User",
  repositorySelection: "all",
  status: "free",
};

const without = (value: Record<string, unknown>, key: string) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

const unrecognized = (
  result: { success: boolean; error?: { issues: ReadonlyArray<{ message: string }> } },
  key: string,
) =>
  result.success === false &&
  (result.error?.issues.some(
    (issue) => issue.message === `Unrecognized key: "${key}"`,
  ) ??
    false);

// Extends "[happy-13] a complete connection DTO round-trips": a personal
// account, unhealthy, suspended but not uninstalled, with a nineteen-digit id.
test("[happy-13] a personal, suspended connection DTO round-trips", () => {
  const personal = {
    id: "ghc_99",
    installationId: "9999999999999999999",
    accountLogin: "octocat",
    accountType: "User",
    repositorySelection: "all",
    healthy: false,
    suspendedAt: "2026-11-02T00:00:00.000Z",
    uninstalledAt: null,
    settingsUrl: "https://github.com/settings/installations/9999999999999999999",
    createdAt: "2026-10-01T12:34:56.789Z",
  };
  const parsed = githubConnectionDtoSchema.parse(personal);
  assert.deepEqual(parsed, personal);
  assert.equal(Object.keys(parsed).length, 10);

  const uninstalled = { ...connection, uninstalledAt: "2026-11-03T00:00:00.000Z" };
  assert.deepEqual(githubConnectionDtoSchema.parse(uninstalled), uninstalled);
});

// Extends "[unhappy-9] a connection DTO missing or mistyping a field is
// refused": each field mistyped in a way the examples do not use.
test("[unhappy-9] every connection field mistyped is refused", () => {
  const changed: Array<Record<string, unknown>> = [
    { ...connection, id: 1 },
    { ...connection, id: null },
    { ...connection, installationId: null },
    { ...connection, accountLogin: null },
    { ...connection, accountLogin: 5 },
    { ...connection, accountType: 1 },
    { ...connection, accountType: null },
    { ...connection, repositorySelection: null },
    { ...connection, repositorySelection: ["all"] },
    { ...connection, healthy: "true" },
    { ...connection, healthy: 1 },
    { ...connection, healthy: undefined },
    { ...connection, suspendedAt: 0 },
    { ...connection, suspendedAt: false },
    { ...connection, uninstalledAt: 1700000000 },
    { ...connection, settingsUrl: null },
    { ...connection, createdAt: null },
    { ...connection, createdAt: 1700000000 },
    without(without(connection, "id"), "createdAt"),
    {},
  ];
  for (const dto of changed) {
    assert.equal(
      githubConnectionDtoSchema.safeParse(dto).success,
      false,
      JSON.stringify(dto),
    );
  }
  assert.equal(githubConnectionDtoSchema.safeParse(null).success, false);
});

// Extends "[boundary-4] DTO strings carry no format or length check": every
// string field empty or free-form, and very long strings, on every DTO.
test("[boundary-4] every connection string field may be empty or free-form", () => {
  const odd = {
    id: "",
    installationId: "",
    accountLogin: "",
    accountType: "",
    repositorySelection: "",
    healthy: false,
    suspendedAt: "",
    uninstalledAt: "never",
    settingsUrl: "",
    createdAt: "",
  };
  assert.deepEqual(githubConnectionDtoSchema.parse(odd), odd);

  const long = { ...connection, id: "x".repeat(10_000), createdAt: "y".repeat(10_000) };
  assert.deepEqual(githubConnectionDtoSchema.parse(long), long);
});

test("[boundary-4] repository DTO strings may be empty or free-form", () => {
  const installationOdd = {
    externalId: "0",
    fullName: "",
    defaultBranch: "",
    isPrivate: false,
    registeredId: "",
  };
  assert.deepEqual(
    githubInstallationRepositoryDtoSchema.parse(installationOdd),
    installationOdd,
  );

  const repoOdd = {
    ...repo,
    id: "",
    connectionId: "42",
    externalId: "-1",
    fullName: " no slash ",
    headSha: "not-a-sha",
    pushedAt: "yesterday",
    lastSyncedAt: "",
    syncStatus: "error",
    syncError: "",
    createdAt: "yesterday",
  };
  assert.deepEqual(githubRepoDtoSchema.parse(repoOdd), repoOdd);

  const availableOdd = { ...available, installationId: "007", accountLogin: "" };
  assert.deepEqual(githubAvailableInstallationDtoSchema.parse(availableOdd), availableOdd);
});

// Extends "[unhappy-10] an unknown key on a DTO is refused": other keys, on
// every DTO, each named in the message.
test("[unhappy-10] other unknown keys on the connection DTO are refused by name", () => {
  for (const key of ["installation_id", "accessToken", "permissions", "orgId"]) {
    const result = githubConnectionDtoSchema.safeParse({ ...connection, [key]: "x" });
    assert.ok(unrecognized(result, key), key);
  }
});

test("[unhappy-10] an unknown key is refused by name on each of the other DTOs", () => {
  assert.ok(
    unrecognized(
      githubGrantDtoSchema.safeParse({ githubLogin: "octocat", healthy: true, scope: "repo" }),
      "scope",
    ),
  );
  assert.ok(
    unrecognized(
      githubAvailableInstallationDtoSchema.safeParse({ ...available, id: "ghc_1" }),
      "id",
    ),
  );
  assert.ok(
    unrecognized(
      githubInstallationRepositoryDtoSchema.safeParse({
        ...installationRepository,
        archived: false,
      }),
      "archived",
    ),
  );
  assert.ok(
    unrecognized(githubRepoDtoSchema.safeParse({ ...repo, token: "secret" }), "token"),
  );
  assert.ok(
    unrecognized(githubRepoDtoSchema.safeParse({ ...repo, full_name: "o/a" }), "full_name"),
  );
});

// Extends "[happy-14] a complete installation repository DTO round-trips":
// public, registered, with other names and branches.
test("[happy-14] installation repository DTOs with other values round-trip", () => {
  for (const dto of [
    {
      externalId: "9999999999999999999",
      fullName: "Octo-Org/Hello.World",
      defaultBranch: "develop",
      isPrivate: false,
      registeredId: "ghr_2",
    },
    {
      externalId: "1296269",
      fullName: "octocat/Hello-World",
      defaultBranch: "release/2026",
      isPrivate: true,
      registeredId: null,
    },
  ]) {
    const parsed = githubInstallationRepositoryDtoSchema.parse(dto);
    assert.deepEqual(parsed, dto);
    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(dto).sort());
  }
});

// Extends "[happy-15] a complete registered repository DTO round-trips": each
// sync status, with an error, a large size and a partial set of nulls.
test("[happy-15] repo DTOs in each sync status round-trip", () => {
  const variants = [
    { ...repo, syncStatus: "ok", sizeKb: 123456, headSha: "a".repeat(40), lastSyncedAt: "2026-11-02T00:00:00.000Z" },
    { ...repo, syncStatus: "error", syncError: "rate limited", isPrivate: false },
    { ...repo, syncStatus: "gone", pushedAt: "2026-11-01T00:00:00.000Z", sizeKb: 0 },
    { ...repo, syncStatus: "pending", externalId: "9999999999999999999", connectionId: "ghc_2", fullName: "octo/renamed" },
  ];
  for (const dto of variants) {
    assert.deepEqual(githubRepoDtoSchema.parse(dto), dto);
  }
});

// Extends "[happy-16] the grant DTO carries the login and health, never
// tokens": other logins, and every token-like key refused by name.
test("[happy-16] the grant DTO keeps other logins and refuses every token-like key", () => {
  for (const [githubLogin, healthy] of [
    ["monalisa", false],
    ["Octo-Cat", true],
    ["", true],
  ] as const) {
    assert.deepEqual(githubGrantDtoSchema.parse({ githubLogin, healthy }), {
      githubLogin,
      healthy,
    });
  }
  for (const key of ["token", "access_token", "refresh_token", "refreshToken", "expiresAt"]) {
    const result = githubGrantDtoSchema.safeParse({
      githubLogin: "octocat",
      healthy: true,
      [key]: "t",
    });
    assert.ok(unrecognized(result, key), key);
  }
});

test("[happy-16] the grant DTO refuses a missing or mistyped login or health", () => {
  for (const dto of [
    { githubLogin: "octocat" },
    { healthy: true },
    { githubLogin: null, healthy: true },
    { githubLogin: "octocat", healthy: "yes" },
  ]) {
    assert.equal(githubGrantDtoSchema.safeParse(dto).success, false, JSON.stringify(dto));
  }
});

// Extends "[unhappy-11] a repository DTO with a bad field is refused": every
// other field removed, and other mistypings.
test("[unhappy-11] an installation repository DTO missing or mistyping any other field is refused", () => {
  const cases: Array<Record<string, unknown>> = [
    without(installationRepository, "externalId"),
    without(installationRepository, "fullName"),
    without(installationRepository, "defaultBranch"),
    { ...installationRepository, isPrivate: "true" },
    { ...installationRepository, isPrivate: null },
    { ...installationRepository, registeredId: 1 },
    { ...installationRepository, registeredId: undefined },
    { ...installationRepository, fullName: null },
    { ...installationRepository, defaultBranch: null },
  ];
  for (const dto of cases) {
    assert.equal(
      githubInstallationRepositoryDtoSchema.safeParse(dto).success,
      false,
      JSON.stringify(dto),
    );
  }
});

test("[unhappy-11] a repo DTO missing any field, or mistyping one, is refused", () => {
  const cases: Array<Record<string, unknown>> = [
    ...Object.keys(repo).map((key) => without(repo, key)),
    { ...repo, id: 1 },
    { ...repo, role: "sandbox" },
    { ...repo, role: null },
    { ...repo, fullName: null },
    { ...repo, isPrivate: null },
    { ...repo, sizeKb: undefined },
    { ...repo, headSha: 0 },
    { ...repo, pushedAt: 1700000000 },
    { ...repo, lastSyncedAt: false },
    { ...repo, syncStatus: "Pending" },
    { ...repo, syncStatus: null },
    { ...repo, syncError: 500 },
    { ...repo, createdAt: null },
  ];
  for (const dto of cases) {
    assert.equal(githubRepoDtoSchema.safeParse(dto).success, false, JSON.stringify(dto));
  }
});
