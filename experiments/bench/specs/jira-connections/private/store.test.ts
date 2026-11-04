/**
 * Hidden suite for `JiraConnectionStore`, against an in-memory stand-in for
 * Drizzle in the style of `fake-organization-db.ts` that answers only the
 * query shapes the spec lists and records every call.
 *
 * Besides the real cipher (built from fixed keys), a deterministic
 * `TokenCipher` stand-in is used so that what the store writes can be
 * compared exactly: it "encrypts" `x` to `enc[x]`. The clock is fixed with
 * node:test's mock timers wherever `updatedAt` is asserted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { desc, getTableColumns } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createTokenCipher, TokenCipherError } from "../../src/cipher.js";
import type { TokenCipher } from "../../src/cipher.js";
import { createJiraConnectionStore } from "../../src/jira-connections.js";
import type {
  JiraConnectionInput,
  JiraConnectionStore,
} from "../../src/jira-connections.js";
import { jiraConnection } from "../../src/schema/jira.js";
import type { JiraConnectionRow } from "../../src/schema/jira.js";
import type { Database } from "../../src/store.js";

const K1 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const K2 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";
const K1_ID = "0ebcb5deb52c";

const ID_PATTERN =
  /^jrc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const INSERTED_AT = new Date("2026-11-04T10:00:00.000Z");
const STORE_BUILT_AT = Date.parse("2026-11-04T08:00:00.000Z");
const CALLED_AT = Date.parse("2026-11-04T09:30:15.250Z");

const SUMMARY_KEYS = [
  "cloudId",
  "createdAt",
  "email",
  "healthy",
  "id",
  "scopes",
  "siteName",
  "siteUrl",
];

const UPSERT_KEYS = [
  "accessTokenEnc",
  "cloudId",
  "email",
  "expiresAt",
  "healthy",
  "keyId",
  "organizationId",
  "refreshTokenEnc",
  "scopes",
  "siteName",
  "siteUrl",
  "updatedAt",
];

const SAVE_KEYS = [
  "accessTokenEnc",
  "expiresAt",
  "healthy",
  "keyId",
  "refreshTokenEnc",
  "scopes",
  "updatedAt",
];

const UNAUTHENTICATED =
  "Encrypted token could not be authenticated; the key may have changed.";

// ---- the fake ----------------------------------------------------------------

interface Condition {
  readonly column: string;
  readonly value: unknown;
}

const propertyOf = new Map(
  Object.entries(getTableColumns(jiraConnection)).map(
    ([property, col]) => [col.name, property] as const,
  ),
);

function conditions(where: unknown): Condition[] {
  const out: Condition[] = [];
  collect(where, out);
  return out;
}

function sortedConditions(where: unknown): Condition[] {
  return [...conditions(where)].sort((a, b) => a.column.localeCompare(b.column));
}

function collect(node: unknown, out: Condition[]): void {
  if (typeof node !== "object" || node === null) {
    return;
  }
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  if (!Array.isArray(chunks)) {
    return;
  }
  let column: string | undefined;
  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) {
      continue;
    }
    const record = chunk as Record<string, unknown>;
    if (Array.isArray(record["queryChunks"])) {
      collect(chunk, out);
      continue;
    }
    if (typeof record["name"] === "string" && "table" in record) {
      column = record["name"];
      continue;
    }
    if (Array.isArray(record["value"])) {
      continue;
    }
    if ("value" in record && column !== undefined) {
      out.push({ column, value: record["value"] });
      column = undefined;
    }
  }
}

function matches(row: JiraConnectionRow, where: unknown): boolean {
  return conditions(where).every((condition) => {
    const property = propertyOf.get(condition.column) ?? condition.column;
    return (row as Record<string, unknown>)[property] === condition.value;
  });
}

const dialect = new PgDialect();

function render(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]);
  return { sql: query.sql, params: query.params };
}

type Values = Record<string, unknown>;

interface InsertCall {
  readonly values: Values;
  readonly target: unknown;
  readonly set: Values;
}

interface UpdateCall {
  readonly set: Values;
  readonly where: unknown;
}

interface FakeJiraDb {
  readonly db: Database;
  readonly rows: JiraConnectionRow[];
  readonly selects: Array<{ where: unknown; orderBy: unknown[] | undefined }>;
  readonly inserts: InsertCall[];
  readonly appliedInserts: Values[];
  readonly updates: UpdateCall[];
  readonly deletes: Array<{ where: unknown }>;
}

interface FakeOptions {
  readonly orderBy?: "honour" | "ignore";
  readonly insertReturnsNothing?: boolean;
  /** Replaces what `insert … returning()` resolves to. */
  readonly returned?: (row: JiraConnectionRow) => JiraConnectionRow[];
}

function thenable<T>(run: () => T): PromiseLike<T> & Record<string, unknown> {
  return {
    then: <A, B>(
      onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
      onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ) => new Promise<T>((resolve) => resolve(run())).then(onFulfilled, onRejected),
  };
}

function createFakeJiraDb(
  seed: JiraConnectionRow[] = [],
  options: FakeOptions = {},
): FakeJiraDb {
  const rows = seed.map((candidate) => ({ ...candidate }));
  const selects: FakeJiraDb["selects"] = [];
  const inserts: InsertCall[] = [];
  const appliedInserts: Values[] = [];
  const updates: UpdateCall[] = [];
  const deletes: FakeJiraDb["deletes"] = [];

  function ordered(found: JiraConnectionRow[], orderBy: unknown[] | undefined) {
    if (orderBy === undefined || options.orderBy === "ignore") {
      return found;
    }
    for (const term of [...orderBy].reverse()) {
      const { sql } = render(term);
      const name = /"([a-z_]+)"\s*(asc|desc)?\s*$/i.exec(sql);
      const property = propertyOf.get(name?.[1] ?? "");
      if (property === undefined) {
        continue;
      }
      const direction = /desc\s*$/i.test(sql) ? -1 : 1;
      found = [...found].sort((a, b) => {
        const left = (a as Record<string, unknown>)[property] as Date;
        const right = (b as Record<string, unknown>)[property] as Date;
        return (left.getTime() - right.getTime()) * direction;
      });
    }
    return found;
  }

  function select() {
    const call: { where: unknown; orderBy: unknown[] | undefined } = {
      where: undefined,
      orderBy: undefined,
    };
    selects.push(call);
    let limit: number | undefined;
    const chain = thenable(() => {
      const found = ordered(
        rows.filter((candidate) => matches(candidate, call.where)),
        call.orderBy,
      ).map((candidate) => ({ ...candidate }));
      return limit === undefined ? found : found.slice(0, limit);
    });
    chain["from"] = () => chain;
    chain["where"] = (where: unknown) => {
      call.where = where;
      return chain;
    };
    chain["orderBy"] = (...terms: unknown[]) => {
      call.orderBy = terms;
      return chain;
    };
    chain["limit"] = (value: number) => {
      limit = value;
      return chain;
    };
    return chain;
  }

  function insert() {
    let values: Values = {};
    const chain: Record<string, unknown> = {
      values: (value: Values) => {
        values = value;
        return chain;
      },
      onConflictDoUpdate: (config: { target: unknown; set: Values }) => {
        const call: InsertCall = { values, target: config.target, set: config.set };
        inserts.push(call);
        return {
          returning: () =>
            thenable(() => {
              appliedInserts.push(call.values);
              const existing = rows.find(
                (candidate) =>
                  candidate.organizationId === call.values["organizationId"] &&
                  candidate.cloudId === call.values["cloudId"],
              );
              let result: JiraConnectionRow;
              if (existing !== undefined) {
                Object.assign(existing, call.set);
                result = { ...existing };
              } else {
                const created = {
                  kind: "oauth",
                  email: null,
                  accessTokenEnc: null,
                  refreshTokenEnc: null,
                  keyId: null,
                  expiresAt: null,
                  scopes: "",
                  healthy: true,
                  createdAt: INSERTED_AT,
                  updatedAt: INSERTED_AT,
                  ...call.values,
                } as JiraConnectionRow;
                rows.push(created);
                result = { ...created };
              }
              if (options.insertReturnsNothing === true) {
                return [];
              }
              return options.returned === undefined ? [result] : options.returned(result);
            }),
        };
      },
    };
    return chain;
  }

  function update() {
    let set: Values = {};
    const chain: Record<string, unknown> = {
      set: (value: Values) => {
        set = value;
        return chain;
      },
      where: (where: unknown) => {
        updates.push({ set, where });
        for (const candidate of rows) {
          if (matches(candidate, where)) {
            Object.assign(candidate, set);
          }
        }
        const done = thenable(() => [] as unknown[]);
        done["returning"] = () => thenable(() => [] as unknown[]);
        return done;
      },
    };
    return chain;
  }

  function remove() {
    return {
      where: (where: unknown) => {
        deletes.push({ where });
        let removed: JiraConnectionRow[] | undefined;
        const run = () => {
          if (removed === undefined) {
            removed = rows.filter((candidate) => matches(candidate, where));
            for (const candidate of removed) {
              rows.splice(rows.indexOf(candidate), 1);
            }
          }
          return removed.map((candidate) => ({ ...candidate }));
        };
        const done = thenable(run);
        done["returning"] = () => thenable(run);
        return done;
      },
    };
  }

  const db = { select, insert, update, delete: remove };
  return {
    db: db as unknown as Database,
    rows,
    selects,
    inserts,
    appliedInserts,
    updates,
    deletes,
  };
}

// ---- fixtures ----------------------------------------------------------------

function row(overrides: Partial<JiraConnectionRow> = {}): JiraConnectionRow {
  return {
    id: "jrc_a",
    organizationId: "org_1",
    cloudId: "c-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    kind: "oauth",
    accessTokenEnc: null,
    refreshTokenEnc: null,
    keyId: null,
    expiresAt: null,
    scopes: "",
    email: null,
    healthy: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function input(overrides: Partial<JiraConnectionInput> = {}): JiraConnectionInput {
  return {
    cloudId: "c-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    email: "ada@acme.test",
    accessToken: "AT-1",
    refreshToken: "RT-1",
    expiresAt: "2026-11-04T12:00:00.000Z",
    scopes: ["read:jira-work", "offline_access"],
    ...overrides,
  };
}

/** A deterministic cipher: `x` encrypts to `enc[x]`. */
function labelCipher(keyId = "label-kid"): TokenCipher {
  return {
    keyId,
    encrypt: (plaintext: string | null) => (plaintext === null ? null : `enc[${plaintext}]`),
    decrypt: (ciphertext: string | null) => {
      if (ciphertext === null) {
        return null;
      }
      assert.ok(ciphertext.startsWith("enc[") && ciphertext.endsWith("]"), ciphertext);
      return ciphertext.slice(4, -1);
    },
  };
}

/** A cipher whose every call fails the test. */
function refusingCipher(): TokenCipher & { calls: number } {
  const cipher = {
    keyId: "refusing",
    calls: 0,
    encrypt: (_plaintext: string | null): string | null => {
      cipher.calls += 1;
      throw new Error("encrypt must not be called");
    },
    decrypt: (_ciphertext: string | null): string | null => {
      cipher.calls += 1;
      throw new Error("decrypt must not be called");
    },
  };
  return cipher;
}

function setup(
  seed: JiraConnectionRow[] = [],
  options: FakeOptions = {},
  cipher: TokenCipher = createTokenCipher(K1),
): { fake: FakeJiraDb; cipher: TokenCipher; store: JiraConnectionStore } {
  const fake = createFakeJiraDb(seed, options);
  return { fake, cipher, store: createJiraConnectionStore(fake.db, cipher) };
}

function onlyInsert(fake: FakeJiraDb): InsertCall {
  assert.equal(fake.inserts.length, 1);
  const call = fake.inserts[0];
  assert.ok(call);
  return call;
}

function onlyUpdate(fake: FakeJiraDb): UpdateCall {
  assert.equal(fake.updates.length, 1);
  const call = fake.updates[0];
  assert.ok(call);
  return call;
}

function withoutId(values: Values): Values {
  const { id: _id, ...rest } = values;
  return rest;
}

// ---- upsert --------------------------------------------------------------------

// Extends "[happy-14] a new connection is inserted with encrypted tokens": the
// tokens go through the store's own cipher, and only its output is written.
test("[happy-14] a new connection writes exactly what the store's cipher returns, with its key id", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STORE_BUILT_AT });
  const { fake, store } = setup([], {}, labelCipher("kid-7"));
  t.mock.timers.setTime(CALLED_AT);
  await store.upsert("org_9", input({ cloudId: "c-9", siteName: "Ünïcode Site", scopes: ["x", "y", "z"] }));

  const { values, set } = onlyInsert(fake);
  assert.match(String(values["id"]), /^jrc_/);
  assert.deepEqual(withoutId(values), {
    organizationId: "org_9",
    cloudId: "c-9",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Ünïcode Site",
    email: "ada@acme.test",
    accessTokenEnc: "enc[AT-1]",
    refreshTokenEnc: "enc[RT-1]",
    keyId: "kid-7",
    expiresAt: new Date("2026-11-04T12:00:00.000Z"),
    scopes: "x y z",
    healthy: true,
    updatedAt: new Date(CALLED_AT),
  });
  assert.deepEqual(set, withoutId(values));
});

// "updatedAt is written as new Date() taken when the method is called": a
// Date taken when the store was built is wrong.
test("[happy-14] upsert's updatedAt is the time of the call, not of the store's creation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STORE_BUILT_AT });
  const { fake, store } = setup();
  t.mock.timers.setTime(CALLED_AT);
  await store.upsert("org_1", input());
  t.mock.timers.setTime(CALLED_AT + 60_000);
  await store.upsert("org_1", input({ cloudId: "c-2" }));

  const [first, second] = fake.inserts;
  assert.ok(first && second);
  assert.ok(first.values["updatedAt"] instanceof Date);
  assert.equal((first.values["updatedAt"] as Date).getTime(), CALLED_AT);
  assert.equal((second.values["updatedAt"] as Date).getTime(), CALLED_AT + 60_000);
  assert.equal((second.set["updatedAt"] as Date).getTime(), CALLED_AT + 60_000);
});

// The result maps the row `returning()` gives back, not the input.
test("[happy-14] the result is the summary of the first returned row, not of the input", async () => {
  const { store } = setup([], {
    returned: (inserted) => [
      {
        ...inserted,
        siteName: "Name From The Database",
        siteUrl: "https://db.atlassian.net",
        email: "db@acme.test",
        healthy: false,
        scopes: "a b",
        createdAt: new Date("2025-05-05T05:05:05.555Z"),
      },
      row({ id: "jrc_second", siteName: "Second" }),
    ],
  });
  const result = await store.upsert("org_1", input());
  assert.match(result.id, ID_PATTERN);
  assert.deepEqual(result, {
    id: result.id,
    cloudId: "c-1",
    siteUrl: "https://db.atlassian.net",
    siteName: "Name From The Database",
    email: "db@acme.test",
    healthy: false,
    scopes: ["a", "b"],
    createdAt: "2025-05-05T05:05:05.555Z",
  });
});

test("[happy-14] each new connection gets its own fresh jrc id", async () => {
  const { fake, store } = setup();
  const results = [];
  for (const cloudId of ["c-1", "c-2", "c-3", "c-4", "c-5"]) {
    results.push(await store.upsert("org_1", input({ cloudId })));
  }
  const ids = fake.inserts.map((call) => String(call.values["id"]));
  for (const id of ids) {
    assert.match(id, ID_PATTERN);
  }
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(results.map((summary) => summary.id), ids);
  for (const summary of results) {
    assert.deepEqual(Object.keys(summary).sort(), SUMMARY_KEYS);
  }
});

test("[happy-14] tokens are encrypted with the store's real cipher and its explicit key id", async () => {
  const cipher = createTokenCipher(K2, { keyId: "2026-11_a" });
  const { fake, store } = setup([], {}, cipher);
  await store.upsert("org_1", input({ accessToken: "tökén 🔑", refreshToken: "r".repeat(4000) }));
  const { values } = onlyInsert(fake);
  assert.equal(values["keyId"], "2026-11_a");
  assert.equal(createTokenCipher(K2).decrypt(values["accessTokenEnc"] as string), "tökén 🔑");
  assert.equal(createTokenCipher(K2).decrypt(values["refreshTokenEnc"] as string), "r".repeat(4000));
  assert.throws(
    () => createTokenCipher(K1).decrypt(values["accessTokenEnc"] as string),
    (error: unknown) => error instanceof TokenCipherError && error.message === UNAUTHENTICATED,
  );
});

// Extends "[happy-15] reconnecting the same site updates the existing row":
// every input field replaces the stored one; id and createdAt are kept.
test("[happy-15] reconnecting replaces every input field of the stored row and keeps id and createdAt", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CALLED_AT });
  const { fake, store } = setup(
    [
      row({
        id: "jrc_keep",
        organizationId: "org_1",
        cloudId: "c-1",
        siteUrl: "https://old.atlassian.net",
        siteName: "Old",
        email: "old@acme.test",
        accessTokenEnc: "enc[old-AT]",
        refreshTokenEnc: "enc[old-RT]",
        keyId: "old-kid",
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        scopes: "old:scope",
        healthy: false,
        createdAt: new Date("2025-03-03T03:03:03.333Z"),
      }),
      row({ id: "jrc_other_org", organizationId: "org_2", cloudId: "c-1", siteName: "Other org" }),
    ],
    {},
    labelCipher("new-kid"),
  );
  const result = await store.upsert("org_1", {
    cloudId: "c-1",
    siteUrl: "https://new.atlassian.net",
    siteName: "New",
    email: "new@acme.test",
    accessToken: "new-AT",
    refreshToken: null,
    expiresAt: "2026-12-01T00:00:00.000Z",
    scopes: ["read:jira-work", "write:jira-work"],
  });

  assert.deepEqual(result, {
    id: "jrc_keep",
    cloudId: "c-1",
    siteUrl: "https://new.atlassian.net",
    siteName: "New",
    email: "new@acme.test",
    healthy: true,
    scopes: ["read:jira-work", "write:jira-work"],
    createdAt: "2025-03-03T03:03:03.333Z",
  });
  const { set } = onlyInsert(fake);
  assert.deepEqual(set, {
    organizationId: "org_1",
    cloudId: "c-1",
    siteUrl: "https://new.atlassian.net",
    siteName: "New",
    email: "new@acme.test",
    accessTokenEnc: "enc[new-AT]",
    refreshTokenEnc: null,
    keyId: "new-kid",
    expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    scopes: "read:jira-work write:jira-work",
    healthy: true,
    updatedAt: new Date(CALLED_AT),
  });
  const kept = fake.rows.find((candidate) => candidate.id === "jrc_keep");
  assert.equal(kept?.accessTokenEnc, "enc[new-AT]");
  assert.equal(kept?.refreshTokenEnc, null);
  assert.equal(kept?.keyId, "new-kid");
  const other = fake.rows.find((candidate) => candidate.id === "jrc_other_org");
  assert.equal(other?.siteName, "Other org");
  assert.equal(fake.rows.length, 2);
});

// Spec: "an omitted email becomes null" on reconnect, also when the stored row
// had one; the conflict set must carry email: null, not leave it out.
test("[happy-15] reconnecting without an email clears the stored one through the conflict set", async () => {
  const { fake, store } = setup([row({ id: "jrc_a", email: "keep-me@acme.test" })]);
  const given: Record<string, unknown> = { ...input() };
  delete given["email"];
  const result = await store.upsert("org_1", given as unknown as JiraConnectionInput);
  const { set } = onlyInsert(fake);
  assert.deepEqual(Object.keys(set).sort(), UPSERT_KEYS);
  assert.equal(set["email"], null);
  assert.equal(result.email, null);
  assert.equal(fake.rows[0]?.email, null);
});

// Extends "[boundary-6] optional, nullable and unchecked fields" with the
// values a truthiness shortcut (`x || null`, `x ? … : null`) gets wrong.
const moreStoredFields: Array<[string, Partial<JiraConnectionInput>, (values: Values) => void]> = [
  ["empty email is kept", { email: "" }, (v) => assert.equal(v["email"], "")],
  ["empty siteUrl is kept", { siteUrl: "" }, (v) => assert.equal(v["siteUrl"], "")],
  ["cloudId with spaces is kept", { cloudId: " C-1 " }, (v) => assert.equal(v["cloudId"], " C-1 ")],
  ["empty refresh token is encrypted", { refreshToken: "" }, (v) => assert.equal(v["refreshTokenEnc"], "enc[]")],
  ["empty access token is encrypted", { accessToken: "" }, (v) => assert.equal(v["accessTokenEnc"], "enc[]")],
  [
    "only the access token is null",
    { accessToken: null, refreshToken: "RT-9" },
    (v) => {
      assert.equal(v["accessTokenEnc"], null);
      assert.equal(v["refreshTokenEnc"], "enc[RT-9]");
    },
  ],
  [
    "empty expiresAt is an invalid Date, not null",
    { expiresAt: "" },
    (v) => {
      assert.ok(v["expiresAt"] instanceof Date);
      assert.ok(Number.isNaN(v["expiresAt"].getTime()));
    },
  ],
  [
    "date-only expiresAt",
    { expiresAt: "2026-11-04" },
    (v) => assert.deepEqual(v["expiresAt"], new Date("2026-11-04")),
  ],
  [
    "RFC 1123 expiresAt",
    { expiresAt: "Wed, 04 Nov 2026 13:00:00 GMT" },
    (v) => assert.deepEqual(v["expiresAt"], new Date("2026-11-04T13:00:00.000Z")),
  ],
  ["one empty scope", { scopes: [""] }, (v) => assert.equal(v["scopes"], "")],
  ["a trailing empty scope", { scopes: ["a", ""] }, (v) => assert.equal(v["scopes"], "a ")],
  ["a scope with a space", { scopes: ["a b", "c"] }, (v) => assert.equal(v["scopes"], "a b c")],
  ["reverse-sorted scopes", { scopes: ["z", "m", "a"] }, (v) => assert.equal(v["scopes"], "z m a")],
  [
    "forty scopes with repeats",
    { scopes: Array.from({ length: 40 }, (_, i) => `s${i % 7}`) },
    (v) => assert.equal(v["scopes"], Array.from({ length: 40 }, (_, i) => `s${i % 7}`).join(" ")),
  ],
  ["case kept in siteName", { siteName: "ACME corp" }, (v) => assert.equal(v["siteName"], "ACME corp")],
];

for (const [why, overrides, check] of moreStoredFields) {
  test(`[boundary-6] optional, nullable and unchecked fields: ${why}`, async () => {
    const { fake, store } = setup([], {}, labelCipher());
    await store.upsert("org_1", input(overrides));
    const { values, set } = onlyInsert(fake);
    check(values);
    check(set);
  });
}

test("[boundary-6] an empty email on reconnect replaces the stored one with an empty string", async () => {
  const { fake, store } = setup([row({ id: "jrc_a", email: "old@acme.test" })]);
  const result = await store.upsert("org_1", input({ email: "" }));
  assert.equal(result.email, "");
  assert.equal(fake.rows[0]?.email, "");
});

// Extends "[unhappy-9] the insert returns no row".
test("[unhappy-9] no row back on reconnect rejects with the plain Error", async () => {
  const { fake, store } = setup([row({ id: "jrc_a" })], { insertReturnsNothing: true });
  await assert.rejects(
    store.upsert("org_1", input({ cloudId: "c-1", accessToken: null, refreshToken: null })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TokenCipherError, false);
      assert.equal(error.message, "Failed to record the Jira connection.");
      return true;
    },
  );
  assert.equal(fake.inserts.length, 1);
  assert.equal(fake.selects.length, 0);
  assert.equal(fake.updates.length, 0);
});

test("[unhappy-9] no row back rejects for another organization and site too", async () => {
  const { store } = setup([], { insertReturnsNothing: true });
  await assert.rejects(store.upsert("org_77", input({ cloudId: "c-77", email: null })), {
    message: "Failed to record the Jira connection.",
  });
});

// Extends "[concurrency-1] two overlapping upserts of the same site leave one
// connection": three overlapping calls, one of them against an existing row.
test("[concurrency-1] three overlapping upserts of one site converge on one row", async () => {
  const { fake, store } = setup();
  const results = await Promise.all(
    ["A", "B", "C"].map((siteName) => store.upsert("org_1", input({ cloudId: "c-1", siteName }))),
  );
  assert.equal(new Set(results.map((summary) => summary.id)).size, 1);
  const held = fake.rows.filter(
    (candidate) => candidate.organizationId === "org_1" && candidate.cloudId === "c-1",
  );
  assert.equal(held.length, 1);
  assert.equal(held[0]?.siteName, fake.appliedInserts.at(-1)?.["siteName"]);
  assert.equal(fake.inserts.length, 3);
  assert.equal(fake.selects.length, 0);
  assert.equal(fake.updates.length, 0);
});

test("[concurrency-1] overlapping upserts of an existing site all return its id", async () => {
  const { fake, store } = setup([row({ id: "jrc_existing", cloudId: "c-1" })]);
  const results = await Promise.all([
    store.upsert("org_1", input({ siteName: "X" })),
    store.upsert("org_1", input({ siteName: "Y" })),
  ]);
  assert.deepEqual(results.map((summary) => summary.id), ["jrc_existing", "jrc_existing"]);
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0]?.siteName, fake.appliedInserts.at(-1)?.["siteName"]);
  assert.equal(fake.selects.length, 0);
});

// Extends "[happy-16] the same site in two organizations is two connections".
test("[happy-16] one site in three organizations is three connections, and an existing one is untouched", async () => {
  const { fake, store } = setup([
    row({ id: "jrc_org2", organizationId: "org_2", cloudId: "c-1", siteName: "Org 2 site" }),
  ]);
  const first = await store.upsert("org_1", input({ cloudId: "c-1", siteName: "Org 1 site" }));
  const third = await store.upsert("org_3", input({ cloudId: "c-1", siteName: "Org 3 site" }));
  assert.notEqual(first.id, "jrc_org2");
  assert.notEqual(third.id, "jrc_org2");
  assert.notEqual(first.id, third.id);
  assert.equal(fake.rows.length, 3);
  assert.equal(
    fake.rows.find((candidate) => candidate.id === "jrc_org2")?.siteName,
    "Org 2 site",
  );
  for (const call of fake.inserts) {
    assert.deepEqual(call.target, [jiraConnection.organizationId, jiraConnection.cloudId]);
  }
});

// ---- list and get ------------------------------------------------------------

function fiveRows(): JiraConnectionRow[] {
  return [
    row({ id: "jrc_1", cloudId: "c-1", createdAt: new Date("2026-05-01T00:00:00.000Z") }),
    row({ id: "jrc_2", cloudId: "c-2", createdAt: new Date("2026-01-15T08:30:00.123Z") }),
    row({ id: "jrc_3", cloudId: "c-3", createdAt: new Date("2026-09-09T09:09:09.999Z") }),
    row({ id: "jrc_4", cloudId: "c-4", createdAt: new Date("2025-12-31T23:59:59.999Z") }),
    row({ id: "jrc_5", cloudId: "c-5", createdAt: new Date("2026-03-03T00:00:00.000Z") }),
    row({ id: "jrc_x", organizationId: "org_2", createdAt: new Date("2027-01-01T00:00:00.000Z") }),
    row({ id: "jrc_y", organizationId: "org_3", createdAt: new Date("2024-01-01T00:00:00.000Z") }),
  ];
}

// Extends "[happy-17] list asks for newest first and keeps the order it gets".
test("[happy-17] list returns five of the organization's rows newest first, from one query", async () => {
  const { fake, store } = setup(fiveRows(), { orderBy: "honour" });
  const result = await store.list("org_1");

  assert.equal(fake.selects.length, 1);
  const { orderBy, where } = fake.selects[0] ?? {};
  assert.equal(orderBy?.length, 1);
  assert.deepEqual(render(orderBy?.[0]), render(desc(jiraConnection.createdAt)));
  assert.deepEqual(conditions(where), [{ column: "organization_id", value: "org_1" }]);
  assert.deepEqual(
    result.map((summary) => [summary.id, summary.createdAt]),
    [
      ["jrc_3", "2026-09-09T09:09:09.999Z"],
      ["jrc_1", "2026-05-01T00:00:00.000Z"],
      ["jrc_5", "2026-03-03T00:00:00.000Z"],
      ["jrc_2", "2026-01-15T08:30:00.123Z"],
      ["jrc_4", "2025-12-31T23:59:59.999Z"],
    ],
  );
});

test("[happy-17] list maps every field of each row and nothing more", async () => {
  const { store } = setup(
    [
      row({
        id: "jrc_p",
        cloudId: "c-p",
        siteUrl: "https://p.atlassian.net",
        siteName: "P",
        email: "p@p.test",
        healthy: true,
        scopes: "one",
        keyId: "kid",
        accessTokenEnc: "enc[x]",
        expiresAt: new Date("2026-11-04T00:00:00.000Z"),
        createdAt: new Date("2026-02-02T00:00:00.000Z"),
      }),
      row({
        id: "jrc_q",
        cloudId: "c-q",
        siteUrl: "https://q.atlassian.net",
        siteName: "Q",
        email: null,
        healthy: false,
        scopes: "",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ],
    { orderBy: "honour" },
  );
  assert.deepEqual(await store.list("org_1"), [
    {
      id: "jrc_p",
      cloudId: "c-p",
      siteUrl: "https://p.atlassian.net",
      siteName: "P",
      email: "p@p.test",
      healthy: true,
      scopes: ["one"],
      createdAt: "2026-02-02T00:00:00.000Z",
    },
    {
      id: "jrc_q",
      cloudId: "c-q",
      siteUrl: "https://q.atlassian.net",
      siteName: "Q",
      email: null,
      healthy: false,
      scopes: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
});

// Extends "[boundary-7] list does not re-sort" with five rows, ties included.
test("[boundary-7] list keeps a shuffled five-row order exactly as the query returns it", async () => {
  const rows = fiveRows();
  const order = ["jrc_4", "jrc_3", "jrc_5", "jrc_1", "jrc_2"];
  const seeded = order.map((id) => rows.find((candidate) => candidate.id === id) as JiraConnectionRow);
  const { store } = setup([...seeded, ...rows.slice(5)], { orderBy: "ignore" });
  assert.deepEqual((await store.list("org_1")).map((summary) => summary.id), order);
});

test("[boundary-7] list keeps rows with the same createdAt in the order returned", async () => {
  const same = new Date("2026-06-06T06:06:06.006Z");
  const ids = ["jrc_m", "jrc_b", "jrc_z", "jrc_a"];
  const { store } = setup(
    ids.map((id, i) => row({ id, cloudId: `c-${i}`, createdAt: same })),
    { orderBy: "ignore" },
  );
  assert.deepEqual((await store.list("org_1")).map((summary) => summary.id), ids);
});

// Extends "[boundary-8] an organization with no connections".
test("[boundary-8] an organization with no connections among many gets [] from one filtered select", async () => {
  const { fake, store } = setup(fiveRows(), { orderBy: "honour" });
  assert.deepEqual(await store.list("org_empty"), []);
  assert.equal(fake.selects.length, 1);
  assert.deepEqual(conditions(fake.selects[0]?.where), [
    { column: "organization_id", value: "org_empty" },
  ]);
  assert.deepEqual(await store.list(""), []);
});

// Extends "[happy-18] summaries do not need the key": a cipher that refuses
// every call, many rows, and no token material in what comes back.
test("[happy-18] list and get never touch the cipher and expose no token material", async () => {
  const cipher = refusingCipher();
  const fake = createFakeJiraDb(
    Array.from({ length: 4 }, (_, i) =>
      row({
        id: `jrc_${i}`,
        cloudId: `c-${i}`,
        accessTokenEnc: `garbage-access-${i}`,
        refreshTokenEnc: `garbage-refresh-${i}`,
        keyId: `kid-${i}`,
        expiresAt: new Date("2026-11-04T12:00:00.000Z"),
      }),
    ),
  );
  const store = createJiraConnectionStore(fake.db, cipher);
  const listed = await store.list("org_1");
  const got = await store.get("org_1", "jrc_2");
  assert.equal(cipher.calls, 0);
  assert.equal(listed.length, 4);
  for (const summary of [...listed, got]) {
    assert.ok(summary);
    assert.deepEqual(Object.keys(summary).sort(), SUMMARY_KEYS);
    const text = JSON.stringify(summary);
    assert.equal(text.includes("garbage"), false);
    assert.equal(text.includes("kid-"), false);
  }
});

// Extends "[happy-19] get returns one summary".
test("[happy-19] get maps a healthy row with an email and no scopes", async () => {
  const { store } = setup([
    row({ id: "jrc_a" }),
    row({
      id: "jrc_b",
      cloudId: "c-b",
      siteUrl: "https://b.atlassian.net",
      siteName: "B",
      email: "b@b.test",
      healthy: true,
      scopes: "",
      createdAt: new Date("2026-07-07T07:07:07.707Z"),
    }),
  ]);
  assert.deepEqual(await store.get("org_1", "jrc_b"), {
    id: "jrc_b",
    cloudId: "c-b",
    siteUrl: "https://b.atlassian.net",
    siteName: "B",
    email: "b@b.test",
    healthy: true,
    scopes: [],
    createdAt: "2026-07-07T07:07:07.707Z",
  });
});

// "scopes is the row's scopes split on a single space": other whitespace is
// part of a scope, and two spaces leave an empty one between.
test("[happy-19] get splits scopes on a single space only", async () => {
  const { store } = setup([
    row({ id: "jrc_tab", scopes: "a\tb" }),
    row({ id: "jrc_double", cloudId: "c-2", scopes: "a  b" }),
    row({ id: "jrc_dupes", cloudId: "c-3", scopes: "b a b" }),
  ]);
  assert.deepEqual((await store.get("org_1", "jrc_tab"))?.scopes, ["a\tb"]);
  assert.deepEqual((await store.get("org_1", "jrc_double"))?.scopes, ["a", "", "b"]);
  assert.deepEqual((await store.get("org_1", "jrc_dupes"))?.scopes, ["b", "a", "b"]);
});

test("[happy-19] get uses the first row the query returns", async () => {
  const { store } = setup([
    row({ id: "jrc_a", siteName: "First" }),
    row({ id: "jrc_a", siteName: "Second" }),
  ]);
  assert.equal((await store.get("org_1", "jrc_a"))?.siteName, "First");
});

// Extends "[unhappy-10] get misses return null" with other misses.
const moreGetMisses: Array<[string, string]> = [
  ["", "jrc_a"],
  ["ORG_1", "jrc_a"],
  ["org_1 ", "jrc_a"],
  ["org_1", "JRC_A"],
  ["org_1", " jrc_a"],
  ["org_3", "jrc_a"],
];

for (const [organizationId, connectionId] of moreGetMisses) {
  test(`[unhappy-10] get misses return null: (${JSON.stringify(organizationId)}, ${JSON.stringify(connectionId)})`, async () => {
    const { fake, store } = setup([
      row({ id: "jrc_a", organizationId: "org_1" }),
      row({ id: "jrc_b", organizationId: "org_3", cloudId: "c-3" }),
    ]);
    assert.equal(await store.get(organizationId, connectionId), null);
    assert.equal(fake.selects.length, 1);
    assert.deepEqual(sortedConditions(fake.selects[0]?.where), [
      { column: "id", value: connectionId },
      { column: "organization_id", value: organizationId },
    ]);
  });
}

// ---- tokens --------------------------------------------------------------------

// Extends "[happy-20] tokens returns the decrypted pair": the store decrypts
// with its own cipher, from one scoped select, and writes nothing.
test("[happy-20] tokens decrypts each column with the store's cipher from one scoped select", async () => {
  const { fake, store } = setup(
    [
      row({ id: "jrc_a", accessTokenEnc: "enc[wrong row]" }),
      row({
        id: "jrc_b",
        cloudId: "c-2",
        accessTokenEnc: "enc[AT-b]",
        refreshTokenEnc: "enc[RT-b]",
        expiresAt: new Date("2026-11-04T12:34:56.789Z"),
        scopes: "read:jira-work write:jira-work offline_access",
      }),
    ],
    {},
    labelCipher(),
  );
  const result = await store.tokens("org_1", "jrc_b");
  assert.deepEqual(result, {
    accessToken: "AT-b",
    refreshToken: "RT-b",
    expiresAt: "2026-11-04T12:34:56.789Z",
    scopes: ["read:jira-work", "write:jira-work", "offline_access"],
  });
  assert.equal(fake.selects.length, 1);
  assert.deepEqual(sortedConditions(fake.selects[0]?.where), [
    { column: "id", value: "jrc_b" },
    { column: "organization_id", value: "org_1" },
  ]);
  assert.equal(fake.updates.length + fake.inserts.length + fake.deletes.length, 0);
});

test("[happy-20] tokens returns long non-ASCII tokens under K2 with exactly four keys", async () => {
  const cipher = createTokenCipher(K2);
  const access = "tökén 🔑 ".repeat(500);
  const fake = createFakeJiraDb([
    row({
      id: "jrc_a",
      accessTokenEnc: cipher.encrypt(access),
      refreshTokenEnc: cipher.encrypt(""),
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      scopes: "a",
    }),
  ]);
  const store = createJiraConnectionStore(fake.db, createTokenCipher(K2.replace(/=$/, "")));
  const result = await store.tokens("org_1", "jrc_a");
  assert.ok(result);
  assert.deepEqual(Object.keys(result).sort(), ["accessToken", "expiresAt", "refreshToken", "scopes"]);
  assert.equal(result.accessToken, access);
  assert.equal(result.refreshToken, "");
  assert.equal(result.expiresAt, "2030-01-01T00:00:00.000Z");
});

// Extends "[boundary-9] absent tokens and expiry stay null".
test("[boundary-9] a null access token beside a present refresh token stays null", async () => {
  const { store } = setup(
    [row({ id: "jrc_a", accessTokenEnc: null, refreshTokenEnc: "enc[RT]", expiresAt: null, scopes: "" })],
    {},
    labelCipher(),
  );
  assert.deepEqual(await store.tokens("org_1", "jrc_a"), {
    accessToken: null,
    refreshToken: "RT",
    expiresAt: null,
    scopes: [],
  });
});

test("[boundary-9] a null expiry beside present tokens stays null", async () => {
  const { store } = setup(
    [row({ id: "jrc_a", accessTokenEnc: "enc[AT]", refreshTokenEnc: "enc[RT]", expiresAt: null, scopes: "x" })],
    {},
    labelCipher(),
  );
  assert.deepEqual(await store.tokens("org_1", "jrc_a"), {
    accessToken: "AT",
    refreshToken: "RT",
    expiresAt: null,
    scopes: ["x"],
  });
});

// Extends "[unhappy-11] tokens for another organization's connection is null":
// a miss never reaches the cipher, even when the stored tokens are unreadable.
test("[unhappy-11] another organization's unreadable tokens are a null miss, not a cipher error", async () => {
  const foreign = createTokenCipher(K2);
  const cipher = refusingCipher();
  const fake = createFakeJiraDb([
    row({
      id: "jrc_a",
      organizationId: "org_1",
      accessTokenEnc: foreign.encrypt("AT"),
      refreshTokenEnc: foreign.encrypt("RT"),
    }),
  ]);
  const store = createJiraConnectionStore(fake.db, cipher);
  assert.equal(await store.tokens("org_2", "jrc_a"), null);
  assert.equal(await store.tokens("", "jrc_a"), null);
  assert.equal(await store.tokens("org_1", ""), null);
  assert.equal(await store.tokens("ORG_1", "jrc_a"), null);
  assert.equal(cipher.calls, 0);
});

// Extends "[unhappy-12] tokens written under another key propagate the cipher
// error and write nothing".
test("[unhappy-12] a refresh token under another key propagates the authentication error", async () => {
  const cipher = createTokenCipher(K1);
  const { fake, store } = setup(
    [
      row({
        id: "jrc_a",
        healthy: false,
        accessTokenEnc: cipher.encrypt("AT-1"),
        refreshTokenEnc: createTokenCipher(K2, { keyId: K1_ID }).encrypt("RT-1"),
        keyId: K1_ID,
      }),
    ],
    {},
    cipher,
  );
  await assert.rejects(store.tokens("org_1", "jrc_a"), (error: unknown) => {
    assert.ok(error instanceof TokenCipherError);
    assert.equal(error.name, "TokenCipherError");
    assert.equal(error.message, UNAUTHENTICATED);
    return true;
  });
  assert.equal(fake.updates.length + fake.inserts.length + fake.deletes.length, 0);
  assert.equal(fake.rows[0]?.healthy, false);
});

test("[unhappy-12] a truncated stored token propagates the truncation error", async () => {
  const { fake, store } = setup([row({ id: "jrc_a", accessTokenEnc: "v1:" })]);
  await assert.rejects(store.tokens("org_1", "jrc_a"), (error: unknown) => {
    assert.ok(error instanceof TokenCipherError);
    assert.equal(error.message, "Encrypted token is truncated.");
    return true;
  });
  assert.equal(fake.updates.length, 0);
  assert.equal(fake.rows[0]?.healthy, true);
});

// ---- saveTokens ----------------------------------------------------------------

// Extends "[happy-21] a refreshed pair is stored encrypted": the exact set,
// written by the store's cipher at the time of the call.
test("[happy-21] saveTokens writes exactly the cipher's output, its key id and the call time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STORE_BUILT_AT });
  const { fake, store } = setup(
    [
      row({ id: "jrc_a", healthy: false, keyId: "old", accessTokenEnc: "enc[old]" }),
      row({ id: "jrc_b", cloudId: "c-2", healthy: false, accessTokenEnc: "enc[b]" }),
    ],
    {},
    labelCipher("kid-save"),
  );
  t.mock.timers.setTime(CALLED_AT);
  const result = await store.saveTokens("jrc_a", {
    accessToken: "AT-3",
    refreshToken: "RT-3",
    expiresAt: "2026-11-04T14:00:00+02:00",
    scopes: ["write:jira-work", "read:jira-work", "write:jira-work"],
  });
  assert.equal(result, undefined);

  const { set, where } = onlyUpdate(fake);
  assert.deepEqual(set, {
    accessTokenEnc: "enc[AT-3]",
    refreshTokenEnc: "enc[RT-3]",
    keyId: "kid-save",
    expiresAt: new Date("2026-11-04T12:00:00.000Z"),
    scopes: "write:jira-work read:jira-work write:jira-work",
    healthy: true,
    updatedAt: new Date(CALLED_AT),
  });
  assert.deepEqual(conditions(where), [{ column: "id", value: "jrc_a" }]);
  assert.equal(fake.selects.length + fake.inserts.length + fake.deletes.length, 0);
  const other = fake.rows.find((candidate) => candidate.id === "jrc_b");
  assert.equal(other?.healthy, false);
  assert.equal(other?.accessTokenEnc, "enc[b]");
});

test("[happy-21] tokens read back what saveTokens wrote, for a row of any organization", async () => {
  const { fake, store } = setup([row({ id: "jrc_a", organizationId: "org_5", healthy: false })]);
  await store.saveTokens("jrc_a", {
    accessToken: "AT-new",
    refreshToken: "RT-new",
    expiresAt: "2026-11-04T13:00:00.000Z",
    scopes: ["a", "b"],
  });
  assert.equal(fake.rows[0]?.healthy, true);
  assert.equal(fake.rows[0]?.keyId, K1_ID);
  assert.deepEqual(await store.tokens("org_5", "jrc_a"), {
    accessToken: "AT-new",
    refreshToken: "RT-new",
    expiresAt: "2026-11-04T13:00:00.000Z",
    scopes: ["a", "b"],
  });
  assert.equal((await store.get("org_5", "jrc_a"))?.healthy, true);
});

// Extends "[boundary-10] a grant without offline_access saves a null refresh token".
test("[boundary-10] null tokens and an expiry are saved as given", async () => {
  const { fake, store } = setup([row({ id: "jrc_a", refreshTokenEnc: "enc[old]" })], {}, labelCipher());
  await store.saveTokens("jrc_a", {
    accessToken: null,
    refreshToken: null,
    expiresAt: "2026-11-04T13:00:00.000Z",
    scopes: ["read:jira-work"],
  });
  const { set } = onlyUpdate(fake);
  assert.deepEqual(Object.keys(set).sort(), SAVE_KEYS);
  assert.equal(set["accessTokenEnc"], null);
  assert.equal(set["refreshTokenEnc"], null);
  assert.deepEqual(set["expiresAt"], new Date("2026-11-04T13:00:00.000Z"));
  assert.equal(fake.rows[0]?.refreshTokenEnc, null);
});

test("[boundary-10] an empty refresh token is encrypted, not saved as null", async () => {
  const { fake, store } = setup([row({ id: "jrc_a" })], {}, labelCipher());
  await store.saveTokens("jrc_a", { accessToken: "", refreshToken: "", expiresAt: null, scopes: [""] });
  const { set } = onlyUpdate(fake);
  assert.equal(set["accessTokenEnc"], "enc[]");
  assert.equal(set["refreshTokenEnc"], "enc[]");
  assert.equal(set["scopes"], "");
});

// Extends "[boundary-11] an unknown connection id is a no-op".
test("[boundary-11] an unknown id among several rows changes none of them", async () => {
  const seed = [
    row({ id: "jrc_a", healthy: false, keyId: "k-a" }),
    row({ id: "jrc_b", cloudId: "c-2", healthy: false, keyId: "k-b" }),
    row({ id: "jrc_c", organizationId: "org_2", healthy: false, keyId: "k-c" }),
  ];
  const { fake, store } = setup(seed);
  const result = await store.saveTokens("jrc_gone", {
    accessToken: "AT",
    refreshToken: "RT",
    expiresAt: null,
    scopes: [],
  });
  assert.equal(result, undefined);
  assert.deepEqual(conditions(onlyUpdate(fake).where), [{ column: "id", value: "jrc_gone" }]);
  assert.deepEqual(fake.rows, seed);
  assert.equal(fake.selects.length + fake.inserts.length, 0);
});

// Extends "[boundary-12] the expiry is not checked".
test("[boundary-12] an empty expiry string is saved as an invalid Date, not null", async () => {
  const { fake, store } = setup([row({ id: "jrc_a" })]);
  assert.equal(
    await store.saveTokens("jrc_a", { accessToken: "AT", refreshToken: "RT", expiresAt: "", scopes: [] }),
    undefined,
  );
  const expiresAt = onlyUpdate(fake).set["expiresAt"];
  assert.ok(expiresAt instanceof Date);
  assert.ok(Number.isNaN(expiresAt.getTime()));
});

const otherExpiries: Array<[string, Date]> = [
  ["2026-11-04", new Date("2026-11-04T00:00:00.000Z")],
  ["1970-01-01T00:00:00.000Z", new Date(0)],
  ["2026-11-04T12:00:00.999999Z", new Date("2026-11-04T12:00:00.999Z")],
  ["9999-12-31T23:59:59.999Z", new Date("9999-12-31T23:59:59.999Z")],
];

for (const [expiresAt, expected] of otherExpiries) {
  test(`[boundary-12] the expiry is not checked: ${JSON.stringify(expiresAt)}`, async () => {
    const { fake, store } = setup([row({ id: "jrc_a" })]);
    await store.saveTokens("jrc_a", { accessToken: "AT", refreshToken: "RT", expiresAt, scopes: [] });
    assert.deepEqual(onlyUpdate(fake).set["expiresAt"], expected);
  });
}

// ---- markUnhealthy -------------------------------------------------------------

// Extends "[happy-22] flagging a connection".
test("[happy-22] markUnhealthy sets only healthy false and the call time, by id", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STORE_BUILT_AT });
  const seeded = row({
    id: "jrc_q",
    organizationId: "org_7",
    healthy: true,
    accessTokenEnc: "enc[x]",
    keyId: "k",
    scopes: "a b",
  });
  const { fake, store } = setup([seeded, row({ id: "jrc_r", cloudId: "c-2" })], {}, refusingCipher());
  t.mock.timers.setTime(CALLED_AT);
  assert.equal(await store.markUnhealthy("jrc_q"), undefined);

  const { set, where } = onlyUpdate(fake);
  assert.deepEqual(set, { healthy: false, updatedAt: new Date(CALLED_AT) });
  assert.deepEqual(conditions(where), [{ column: "id", value: "jrc_q" }]);
  assert.deepEqual(fake.rows[0], { ...seeded, healthy: false, updatedAt: new Date(CALLED_AT) });
  assert.equal(fake.rows[1]?.healthy, true);
  assert.equal((await store.get("org_7", "jrc_q"))?.healthy, false);
  assert.deepEqual((await store.list("org_7")).map((summary) => summary.healthy), [false]);
});

// Extends "[boundary-13] flagging twice, or flagging an unknown id".
test("[boundary-13] flagging an already unhealthy row, then an unknown id, issues one update each", async () => {
  const { fake, store } = setup([
    row({ id: "jrc_a", healthy: false }),
    row({ id: "jrc_b", cloudId: "c-2", healthy: true }),
  ]);
  const results = [
    await store.markUnhealthy("jrc_a"),
    await store.markUnhealthy("jrc_a"),
    await store.markUnhealthy("jrc_gone"),
    await store.markUnhealthy(""),
  ];
  assert.deepEqual(results, [undefined, undefined, undefined, undefined]);
  assert.deepEqual(
    fake.updates.map((call) => conditions(call.where)),
    [
      [{ column: "id", value: "jrc_a" }],
      [{ column: "id", value: "jrc_a" }],
      [{ column: "id", value: "jrc_gone" }],
      [{ column: "id", value: "" }],
    ],
  );
  assert.equal(fake.rows[0]?.healthy, false);
  assert.equal(fake.rows[1]?.healthy, true);
});

// Extends "[concurrency-2] a refresh and a failure flag overlap".
test("[concurrency-2] refresh, flag, refresh overlapping: the last applied update wins", async () => {
  const { fake, store } = setup([row({ id: "jrc_a", healthy: true })], {}, labelCipher());
  const results = await Promise.all([
    store.saveTokens("jrc_a", { accessToken: "AT-1", refreshToken: "RT-1", expiresAt: null, scopes: [] }),
    store.markUnhealthy("jrc_a"),
    store.saveTokens("jrc_a", { accessToken: "AT-2", refreshToken: "RT-2", expiresAt: null, scopes: ["s"] }),
  ]);
  assert.deepEqual(results, [undefined, undefined, undefined]);
  assert.equal(fake.updates.length, 3);
  const last = fake.updates.at(-1)?.set;
  assert.equal(fake.rows[0]?.healthy, last?.["healthy"]);
  const lastSave = [...fake.updates].reverse().find((call) => "accessTokenEnc" in call.set);
  assert.equal(fake.rows[0]?.accessTokenEnc, lastSave?.set["accessTokenEnc"]);
  assert.equal(fake.selects.length, 0);
});

test("[concurrency-2] two flags and a refresh overlapping: the last applied update wins", async () => {
  const { fake, store } = setup([row({ id: "jrc_a", healthy: false })], {}, labelCipher());
  await Promise.all([
    store.markUnhealthy("jrc_a"),
    store.saveTokens("jrc_a", { accessToken: "AT", refreshToken: null, expiresAt: null, scopes: [] }),
    store.markUnhealthy("jrc_a"),
  ]);
  assert.equal(fake.updates.length, 3);
  assert.equal(fake.rows[0]?.healthy, fake.updates.at(-1)?.set["healthy"]);
  assert.equal(fake.rows[0]?.accessTokenEnc, "enc[AT]");
});

// ---- remove ------------------------------------------------------------------

// Extends "[happy-23] removing an existing connection".
test("[happy-23] removing one of several connections returns exactly true and leaves the rest", async () => {
  const { fake, store } = setup(fiveRows());
  const removed = await store.remove("org_1", "jrc_3");
  assert.equal(removed, true);
  assert.equal(fake.deletes.length, 1);
  assert.deepEqual(sortedConditions(fake.deletes[0]?.where), [
    { column: "id", value: "jrc_3" },
    { column: "organization_id", value: "org_1" },
  ]);
  assert.deepEqual(
    fake.rows.map((candidate) => candidate.id),
    ["jrc_1", "jrc_2", "jrc_4", "jrc_5", "jrc_x", "jrc_y"],
  );
  assert.equal(await store.get("org_1", "jrc_3"), null);
  assert.equal((await store.get("org_1", "jrc_4"))?.id, "jrc_4");
});

test("[happy-23] removing another organization's connection in its own organization works", async () => {
  const { fake, store } = setup(fiveRows());
  assert.equal(await store.remove("org_2", "jrc_x"), true);
  assert.equal(fake.rows.some((candidate) => candidate.id === "jrc_x"), false);
  assert.equal(fake.rows.length, 6);
});

// Extends "[unhappy-13] removing nothing" with other misses.
const moreRemoveMisses: Array<[string, string]> = [
  ["", "jrc_a"],
  ["org_1", ""],
  ["ORG_1", "jrc_a"],
  ["org_1", "JRC_A"],
  ["org_2", "jrc_b"],
];

for (const [organizationId, connectionId] of moreRemoveMisses) {
  test(`[unhappy-13] removing nothing: (${JSON.stringify(organizationId)}, ${JSON.stringify(connectionId)})`, async () => {
    const { fake, store } = setup([
      row({ id: "jrc_a", organizationId: "org_1" }),
      row({ id: "jrc_b", organizationId: "org_3", cloudId: "c-3" }),
    ]);
    const removed = await store.remove(organizationId, connectionId);
    assert.equal(removed, false);
    assert.deepEqual(
      fake.rows.map((candidate) => candidate.id),
      ["jrc_a", "jrc_b"],
    );
    assert.equal(fake.deletes.length, 1);
  });
}

// Extends "[boundary-14] removing twice".
test("[boundary-14] removing three times returns true, then false, then false", async () => {
  const { fake, store } = setup([
    row({ id: "jrc_a", organizationId: "org_1" }),
    row({ id: "jrc_b", organizationId: "org_1", cloudId: "c-2" }),
  ]);
  const results = [
    await store.remove("org_1", "jrc_a"),
    await store.remove("org_1", "jrc_a"),
    await store.remove("org_1", "jrc_a"),
  ];
  assert.deepEqual(results, [true, false, false]);
  assert.equal(fake.deletes.length, 3);
  assert.deepEqual(fake.rows.map((candidate) => candidate.id), ["jrc_b"]);
  assert.equal(await store.remove("org_1", "jrc_b"), true);
  assert.deepEqual(await store.list("org_1"), []);
});
