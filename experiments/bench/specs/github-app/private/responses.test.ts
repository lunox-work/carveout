import assert from "node:assert/strict";
import { test } from "node:test";

import {
  githubInstallationEventSchema,
  githubInstallationPageResponseSchema,
  githubInstallationRepositoriesEventSchema,
  githubInstallationResponseSchema,
  githubPushEventSchema,
  githubRepositoryEventSchema,
  githubRepositoryPageResponseSchema,
  githubRepositoryResponseSchema,
  githubTimestamp,
  githubWebhookEnvelopeSchema,
} from "../../src/index.js";

/*
 * Hidden checks on what GitHub sends: permissive, unknown fields kept, ids
 * any safe integer, arrays in GitHub's order, and the timestamp helper.
 */

const samePath = (path: readonly PropertyKey[], expected: readonly string[]) =>
  JSON.stringify(path) === JSON.stringify(expected);

// Extends "[happy-6] an installation parses with nothing but its id": other ids.
test("[happy-6] installations with other ids parse to exactly their id", () => {
  for (const id of [1, 7, 123456789, 2147483648]) {
    assert.deepEqual(githubInstallationResponseSchema.parse({ id }), { id });
  }
});

// Extends "[happy-6] an installation's account needs nothing but its login":
// every optional field given at once is kept as sent.
test("[happy-6] an installation with every optional field filled keeps them all", () => {
  const payload = {
    id: 42,
    account: { login: "octo-org", id: 9, type: "Organization" },
    repository_selection: "selected",
    permissions: { contents: "read", metadata: "read", pull_requests: "write" },
    suspended_at: "2026-11-01T00:00:00Z",
  };
  assert.deepEqual(githubInstallationResponseSchema.parse(payload), payload);
});

test("[happy-6] an installation page of bare installations keeps them in GitHub's order", () => {
  const parsed = githubInstallationPageResponseSchema.parse({
    installations: [{ id: 9 }, { id: 3 }, { id: 5 }],
  });
  assert.deepEqual(parsed, { installations: [{ id: 9 }, { id: 3 }, { id: 5 }] });
  assert.equal(parsed.total_count, undefined);
});

test("[happy-6] an installation event carries an installation that has nothing but its id", () => {
  const parsed = githubInstallationEventSchema.parse({
    action: "created",
    installation: { id: 42 },
  });
  assert.equal(parsed.action, "created");
  assert.deepEqual(parsed.installation, { id: 42 });

  const repos = githubInstallationRepositoriesEventSchema.parse({
    action: "added",
    installation: { id: 42 },
  });
  assert.deepEqual(repos.installation, { id: 42 });
  assert.equal(repos.repositories_added, undefined);
  assert.equal(repos.repositories_removed, undefined);
});

// Extends "[happy-7] an installation with a null account, an unfamiliar
// selection and an unknown field parses": several unknown fields of every
// JSON type, nested values kept whole.
test("[happy-7] unknown fields of every JSON type are kept whole on an installation", () => {
  const unknown = {
    app_slug: "sandbox-factory",
    target_id: 12,
    single_file_name: null,
    has_multiple_single_files: false,
    events: ["push", "repository"],
    nested: { deep: { deeper: [1, { two: 2 }] } },
  };
  const parsed = githubInstallationResponseSchema.parse({
    id: 42,
    account: null,
    repository_selection: "all",
    suspended_at: null,
    ...unknown,
  }) as Record<string, unknown>;
  for (const [key, value] of Object.entries(unknown)) {
    assert.deepEqual(parsed[key], value, key);
  }
  assert.equal(parsed.repository_selection, "all");
});

test("[happy-7] an installation page and the webhook envelope keep unknown fields", () => {
  const page = githubInstallationPageResponseSchema.parse({
    total_count: 1,
    installations: [{ id: 1, somethingNew: "kept" }],
    next: "cursor",
  }) as Record<string, unknown> & { installations: Array<Record<string, unknown>> };
  assert.equal(page.next, "cursor");
  assert.equal(page.installations[0]?.somethingNew, "kept");

  const envelope = githubWebhookEnvelopeSchema.parse({
    action: "created",
    installation: { id: 42, node_id: "x" },
    sender: { login: "octocat" },
  }) as Record<string, unknown> & { installation?: Record<string, unknown> };
  assert.deepEqual(envelope.sender, { login: "octocat" });
  assert.equal(envelope.installation?.node_id, "x");
});

// Extends "[happy-8] an installation's account type is any string": types no
// closed list would carry, with the account's own id.
test("[happy-8] an installation's account keeps any type with its id", () => {
  for (const type of ["User", "Organization", "Bot", "Mannequin", "ENTERPRISE"]) {
    const account = { login: "someone", id: 77, type };
    assert.deepEqual(
      githubInstallationResponseSchema.parse({ id: 42, account }).account,
      account,
    );
  }
});

// Extends "[boundary-2] an installation id is any safe integer": values past
// 32 bits in both directions, and one inside the safe range near its edge.
test("[boundary-2] installation ids beyond 32 bits and next to the safe limits are accepted", () => {
  for (const id of [
    2147483647,
    2147483648,
    4294967296,
    -2147483649,
    9007199254740990,
    -9007199254740990,
    1,
  ]) {
    assert.equal(githubInstallationResponseSchema.parse({ id }).id, id);
  }
});

test("[boundary-2] zero, negative and largest safe installation ids are accepted inside events", () => {
  for (const id of [0, -1, 9007199254740991]) {
    assert.equal(
      githubInstallationEventSchema.parse({ action: "deleted", installation: { id } })
        .installation.id,
      id,
    );
    assert.equal(githubWebhookEnvelopeSchema.parse({ installation: { id } }).installation?.id, id);
  }
});

// Extends "[unhappy-6] an installation without a usable id ... is refused":
// non-finite and fractional numbers, other non-numbers, unsafe values, and
// an account whose login is missing or mistyped.
test("[unhappy-6] installations with non-integer, unsafe or non-numeric ids are refused", () => {
  for (const id of [
    42.5,
    0.1,
    -1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    9007199254740994,
    -9007199254740994,
    1e21,
    true,
    "0",
    [42],
    { id: 42 },
  ]) {
    assert.equal(
      githubInstallationResponseSchema.safeParse({ id }).success,
      false,
      String(id),
    );
  }
});

test("[unhappy-6] an installation whose account has no string login is refused", () => {
  for (const account of [
    { id: 5, type: "User" },
    { login: null },
    { login: 1 },
    { name: "o" },
    "o",
    [],
  ]) {
    assert.equal(
      githubInstallationResponseSchema.safeParse({ id: 42, account }).success,
      false,
      JSON.stringify(account),
    );
  }
});

test("[unhappy-6] an installation event whose installation lacks a usable id is refused", () => {
  for (const installation of [{}, { id: "42" }, { id: 1.5 }, { id: 42, account: {} }]) {
    assert.equal(
      githubInstallationEventSchema.safeParse({ action: "created", installation }).success,
      false,
      JSON.stringify(installation),
    );
  }
});

// Extends "[happy-9] a repository parses with only its id and full name,
// keeping unknown fields": many unknown fields, and every optional field set.
test("[happy-9] a full repository payload, with GitHub's other fields, round-trips", () => {
  const payload = {
    id: 1296269,
    node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
    name: "Hello-World",
    full_name: "octocat/Hello-World",
    owner: { login: "octocat", id: 1 },
    private: false,
    default_branch: "trunk",
    size: 0,
    pushed_at: "2011-01-26T19:06:43Z",
    archived: false,
    topics: ["octocat", "atom"],
    license: null,
  };
  assert.deepEqual(githubRepositoryResponseSchema.parse(payload), payload);
});

test("[happy-9] a repository page and a push event keep unknown fields on the repository", () => {
  const page = githubRepositoryPageResponseSchema.parse({
    repository_selection: "selected",
    repositories: [{ id: 7, full_name: "octo/hello", visibility: "internal" }],
    somethingNew: 1,
  }) as Record<string, unknown> & { repositories: Array<Record<string, unknown>> };
  assert.equal(page.somethingNew, 1);
  assert.equal(page.repository_selection, "selected");
  assert.equal(page.repositories[0]?.visibility, "internal");

  const push = githubPushEventSchema.parse({
    ref: "refs/heads/main",
    after: "0123456789abcdef0123456789abcdef01234567",
    repository: { id: 7, full_name: "octo/hello", stargazers_count: 3 },
    pusher: { name: "octocat" },
  }) as Record<string, unknown> & { repository: Record<string, unknown> };
  assert.equal(push.repository.stargazers_count, 3);
  assert.deepEqual(push.pusher, { name: "octocat" });
  assert.equal(push.deleted, undefined);
  assert.equal(push.installation, undefined);

  const renamed = githubRepositoryEventSchema.parse({
    action: "edited",
    repository: { id: 7, full_name: "octo/renamed", private: true },
    changes: { default_branch: { from: "master" }, repository: { name: { from: "hello" } } },
  }) as Record<string, unknown> & { changes?: Record<string, unknown> };
  assert.deepEqual(renamed.changes?.default_branch, { from: "master" });
  assert.deepEqual(renamed.changes?.repository, { name: { from: "hello" } });
});

// Extends "[happy-10] a repository's pushed_at may be an ISO string, Unix
// seconds or null": other values are kept as sent, not converted.
test("[happy-10] other ISO strings and Unix seconds are kept as sent, never converted", () => {
  for (const pushedAt of [
    "2011-01-26T19:06:43Z",
    "2026-11-01T02:00:00+02:00",
    "2026-11-01T00:00:00.123Z",
    1296068472,
    4102444800,
  ]) {
    const parsed = githubRepositoryResponseSchema.parse({
      id: 7,
      full_name: "octo/hello",
      pushed_at: pushedAt,
    });
    assert.equal(parsed.pushed_at, pushedAt);
    assert.equal(typeof parsed.pushed_at, typeof pushedAt);
  }
});

// Extends "[unhappy-7] a repository without its id or full name is refused":
// both missing, mistyped values, unsafe ids, and a bad repository inside a page.
test("[unhappy-7] repositories with a missing or mistyped id or full name are refused", () => {
  for (const payload of [
    {},
    { id: 7, full_name: 7 },
    { id: 7, full_name: ["octo", "a"] },
    { id: 7.5, full_name: "octo/a" },
    { id: 9007199254740992, full_name: "octo/a" },
    { id: null, full_name: "octo/a" },
    { name: "a", owner: { login: "octo" } },
  ]) {
    assert.equal(
      githubRepositoryResponseSchema.safeParse(payload).success,
      false,
      JSON.stringify(payload),
    );
  }
});

test("[unhappy-7] a page or a push event carrying a repository without its full name is refused", () => {
  assert.equal(
    githubRepositoryPageResponseSchema.safeParse({
      repositories: [{ id: 1, full_name: "o/a" }, { id: 2 }],
    }).success,
    false,
  );
  assert.equal(
    githubPushEventSchema.safeParse({
      ref: "refs/heads/main",
      after: "abc",
      repository: { id: 7 },
    }).success,
    false,
  );
  assert.equal(
    githubRepositoryEventSchema.safeParse({
      action: "renamed",
      repository: { full_name: "octo/a" },
    }).success,
    false,
  );
});

// Extends "[unhappy-8] a repository page without its repositories array is
// refused": other pages that lack it or send something other than an array.
test("[unhappy-8] a page with only its count or selection, or a non-array, is refused at repositories", () => {
  for (const payload of [
    { total_count: 0 },
    { total_count: 3, repository_selection: "all" },
    { items: [] },
    { repositories: {} },
    { repositories: "[]" },
    { repositories: { id: 7, full_name: "o/a" } },
  ]) {
    const result = githubRepositoryPageResponseSchema.safeParse(payload);
    assert.equal(result.success, false, JSON.stringify(payload));
    assert.ok(
      result.error?.issues.some((issue) => samePath(issue.path, ["repositories"])),
      JSON.stringify(payload),
    );
  }
});

// Extends "[boundary-3] a repository page with an empty array parses as
// empty": with a selection and unknown fields alongside.
test("[boundary-3] an empty page keeps its selection and extra fields and stays empty", () => {
  const parsed = githubRepositoryPageResponseSchema.parse({
    repository_selection: "selected",
    repositories: [],
    somethingNew: true,
  }) as Record<string, unknown> & { repositories: unknown[] };
  assert.deepEqual(parsed.repositories, []);
  assert.equal(parsed.repository_selection, "selected");
  assert.equal(parsed.total_count, undefined);
  assert.equal(parsed.somethingNew, true);
  assert.deepEqual(githubRepositoryPageResponseSchema.parse({ repositories: [] }), {
    repositories: [],
  });
});

// Extends "[happy-11] a repository page keeps its repositories in the order
// GitHub sent": more items, in an order neither sorted by id nor by name.
test("[happy-11] a longer page keeps GitHub's order, unsorted by id or name", () => {
  const repositories = [
    { id: 5, full_name: "o/m" },
    { id: 3, full_name: "o/z" },
    { id: 9, full_name: "o/a" },
    { id: 1, full_name: "o/q" },
    { id: 7, full_name: "o/b" },
    { id: 2, full_name: "O/A" },
    { id: 8, full_name: "o/a" },
  ];
  const parsed = githubRepositoryPageResponseSchema.parse({
    total_count: 7,
    repositories,
  });
  assert.deepEqual(
    parsed.repositories.map((repository) => repository.id),
    [5, 3, 9, 1, 7, 2, 8],
  );
  assert.deepEqual(
    parsed.repositories.map((repository) => repository.full_name),
    ["o/m", "o/z", "o/a", "o/q", "o/b", "O/A", "o/a"],
  );
});

test("[happy-11] a hundred repositories in descending order are kept in that order", () => {
  const repositories = Array.from({ length: 100 }, (_, index) => ({
    id: 100 - index,
    full_name: `o/r${100 - index}`,
  }));
  const parsed = githubRepositoryPageResponseSchema.parse({ repositories });
  assert.deepEqual(
    parsed.repositories.map((repository) => repository.id),
    repositories.map((repository) => repository.id),
  );
});

// Extends "[happy-12] githubTimestamp reads either spelling as ISO": other
// Unix seconds (not milliseconds), and ISO strings with an offset or
// milliseconds, normalised to UTC.
test("[happy-12] githubTimestamp reads other Unix seconds as seconds", () => {
  assert.equal(githubTimestamp(1296068472), "2011-01-26T19:01:12.000Z");
  assert.equal(githubTimestamp(1730419200), "2024-11-01T00:00:00.000Z");
  assert.equal(githubTimestamp(1000000000), "2001-09-09T01:46:40.000Z");
  assert.equal(githubTimestamp(4102444800), "2100-01-01T00:00:00.000Z");
  assert.equal(githubTimestamp(1), "1970-01-01T00:00:01.000Z");
});

test("[happy-12] githubTimestamp normalises other ISO strings to UTC with milliseconds", () => {
  assert.equal(githubTimestamp("2011-01-26T19:06:43Z"), "2011-01-26T19:06:43.000Z");
  assert.equal(
    githubTimestamp("2026-11-01T02:00:00+02:00"),
    "2026-11-01T00:00:00.000Z",
  );
  assert.equal(
    githubTimestamp("2026-10-31T19:00:00-05:00"),
    "2026-11-01T00:00:00.000Z",
  );
  assert.equal(
    githubTimestamp("2026-11-01T00:00:00.123Z"),
    "2026-11-01T00:00:00.123Z",
  );
  assert.equal(
    githubTimestamp("2026-11-01T00:00:00.000Z"),
    "2026-11-01T00:00:00.000Z",
  );
});

test("[happy-12] githubTimestamp reads impossible dates and other words as null", () => {
  for (const value of ["2026-13-45T00:00:00Z", "2026-11-01T25:00:00Z", "not a date", "null"]) {
    assert.equal(githubTimestamp(value), null, value);
  }
});
