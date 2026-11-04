import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";

import type { Database } from "../../src/errors.js";
import { createJiraBoardStore } from "../../src/jira-boards.js";
import type { SyncBoardInput } from "../../src/jira-boards.js";
import { jiraBoard } from "../../src/schema.js";
import type { JiraBoardRow } from "../../src/schema.js";

/**
 * A test-local copy of `../fake-db.ts` that also records the argument passed
 * to `onConflictDoUpdate`. Every statement resolves to `rows`, unless a
 * per-statement outcome is queued in `outcomes` (by statement order), which
 * lets one test return a row to one call and nothing, or an error, to the next.
 */
interface RecordedCall {
  readonly kind: "select" | "insert" | "update" | "delete";
  readonly values?: Record<string, unknown>;
  readonly conflict?: Record<string, unknown>;
}

type Outcome =
  | { readonly rows: readonly unknown[] }
  | { readonly reject: unknown }
  | { readonly throwOnValues: unknown };

interface FakeOptions {
  readonly insertFailure?: unknown;
  readonly outcomes?: readonly Outcome[];
}

function chain(
  rows: readonly unknown[],
  failure: { readonly value: unknown } | undefined,
  onConflict?: (arg: Record<string, unknown>) => void,
): unknown {
  const result: Record<string, unknown> = {
    from: () => result,
    where: () => result,
    returning: () => result,
    set: () => result,
    values: () => result,
    onConflictDoUpdate: (arg: Record<string, unknown>) => {
      onConflict?.(arg);
      return result;
    },
    innerJoin: () => result,
    leftJoin: () => result,
    orderBy: () => result,
    then: (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) => (failure === undefined ? resolve([...rows]) : reject(failure.value)),
  };
  return result;
}

function createRecordingDb(rows: readonly unknown[], options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];
  let statement = 0;

  function next(kind: RecordedCall["kind"]): {
    rows: readonly unknown[];
    failure: { readonly value: unknown } | undefined;
    throwOnValues: { readonly value: unknown } | undefined;
  } {
    const outcome = options.outcomes?.[statement];
    statement += 1;
    if (outcome !== undefined) {
      if ("rows" in outcome) {
        return { rows: outcome.rows, failure: undefined, throwOnValues: undefined };
      }
      if ("reject" in outcome) {
        return { rows, failure: { value: outcome.reject }, throwOnValues: undefined };
      }
      return { rows, failure: undefined, throwOnValues: { value: outcome.throwOnValues } };
    }
    if (kind === "insert" && options.insertFailure !== undefined) {
      return { rows, failure: { value: options.insertFailure }, throwOnValues: undefined };
    }
    return { rows, failure: undefined, throwOnValues: undefined };
  }

  const db = {
    select: () => {
      calls.push({ kind: "select" });
      const o = next("select");
      return chain(o.rows, o.failure);
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const call: RecordedCall = { kind: "insert", values };
        calls.push(call);
        const o = next("insert");
        if (o.throwOnValues !== undefined) {
          throw o.throwOnValues.value;
        }
        return chain(o.rows, o.failure, (arg) => {
          Object.assign(call, { conflict: arg });
        });
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        calls.push({ kind: "update", values });
        const o = next("update");
        return chain(o.rows, o.failure);
      },
    }),
    delete: () => {
      calls.push({ kind: "delete" });
      const o = next("delete");
      return chain(o.rows, o.failure);
    },
  };

  return { db: db as unknown as Database, calls };
}

function store(rows: readonly unknown[], options: FakeOptions = {}) {
  const fake = createRecordingDb(rows, options);
  return { ...fake, store: createJiraBoardStore(fake.db) };
}

/** The spec's "stored row". */
function storedRow(overrides: Partial<JiraBoardRow> = {}): JiraBoardRow {
  return {
    id: "jrb_1",
    organizationId: "org_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Acme board",
    boardType: "scrum",
    projectKey: "ACME",
    selection: { maxTickets: 10, excludeAssigned: true },
    writebackEnabled: true,
    createdAt: new Date("2026-09-21T00:00:00.000Z"),
    updatedAt: new Date("2026-09-21T00:00:00.000Z"),
    ...overrides,
  };
}

const NOW = new Date("2026-10-01T12:00:00.000Z");

/** A fixed clock and deterministic ids; both are restored after the test. */
function fixture(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  let counter = 0;
  t.mock.method(globalThis.crypto, "randomUUID", () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  });
}

const baseInput: SyncBoardInput = {
  connectionId: "jrc_1",
  externalId: "42",
  name: "Acme board",
  boardType: "scrum",
};

function inserts(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.kind === "insert");
}

function valuesOf(call: RecordedCall | undefined): Record<string, unknown> {
  return call?.values ?? {};
}

function conflictOf(call: RecordedCall | undefined): Record<string, unknown> {
  return call?.conflict ?? {};
}

function setOf(call: RecordedCall | undefined): Record<string, unknown> {
  return (conflictOf(call)["set"] ?? {}) as Record<string, unknown>;
}

const SYNC_INSERT_KEYS = [
  "boardType",
  "connectionId",
  "externalId",
  "id",
  "name",
  "organizationId",
  "projectKey",
  "selection",
  "updatedAt",
];

const SYNC_SET_KEYS = ["boardType", "name", "projectKey", "updatedAt"];

function timeOf(value: unknown): number {
  assert.ok(value instanceof Date, "expected a Date");
  return value.getTime();
}

// ---------------------------------------------------------------- @happy 1

// Extends public "[happy-1] a board seen for the first time is inserted with
// empty settings": other organization, connection, board and Jira facts, so
// values hard-wired to the public case are caught.
test("[happy-1] the insert records the caller's organization and Jira's facts for any board", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);
  const calledAt = Date.now();

  await boards.sync("org_7", {
    connectionId: "jrc_9",
    externalId: "1001",
    name: "Payments",
    boardType: "kanban",
    projectKey: "PAY",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, "insert");
  const values = valuesOf(calls[0]);
  assert.deepEqual(Object.keys(values).sort(), SYNC_INSERT_KEYS);
  assert.match(String(values["id"]), /^jrb_/);
  assert.equal(values["organizationId"], "org_7");
  assert.equal(values["connectionId"], "jrc_9");
  assert.equal(values["externalId"], "1001");
  assert.equal(values["name"], "Payments");
  assert.equal(values["boardType"], "kanban");
  assert.equal(values["projectKey"], "PAY");
  assert.deepEqual(values["selection"], {});
  assert.ok(timeOf(values["updatedAt"]) >= calledAt);
  assert.equal("writebackEnabled" in values, false);
  assert.equal("createdAt" in values, false);
});

// Extends public "[happy-1] a board seen for the first time ...": fields
// smuggled past the type must not change the insert's keys, its generated id
// or the organization taken from the first argument.
test("[happy-1] smuggled id, organizationId and timestamps do not reach the insert", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  await boards.sync("org_1", {
    ...baseInput,
    projectKey: "ACME",
    id: "jrb_smuggled",
    organizationId: "org_2",
    createdAt: new Date("2000-01-01T00:00:00.000Z"),
    updatedAt: new Date("2000-01-01T00:00:00.000Z"),
  } as SyncBoardInput);

  const values = valuesOf(calls[0]);
  assert.deepEqual(Object.keys(values).sort(), SYNC_INSERT_KEYS);
  assert.match(String(values["id"]), /^jrb_/);
  assert.notEqual(values["id"], "jrb_smuggled");
  assert.equal(values["organizationId"], "org_1");
  assert.equal(timeOf(values["updatedAt"]), NOW.getTime());
  assert.equal("createdAt" in values, false);
});

// Extends public "[happy-1] updatedAt is taken during the call ...": two
// calls at different moments each take their own Date, so a Date captured
// once and reused is caught.
test("[happy-1] each sync takes its own updatedAt at the moment it is called", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  await boards.sync("org_1", baseInput);
  t.mock.timers.tick(5_000);
  const secondAt = Date.now();
  await boards.sync("org_1", baseInput);

  assert.equal(calls.length, 2);
  assert.equal(timeOf(valuesOf(calls[0])["updatedAt"]), NOW.getTime());
  assert.equal(timeOf(valuesOf(calls[1])["updatedAt"]), secondAt);
  assert.equal(timeOf(setOf(calls[1])["updatedAt"]), secondAt);
  assert.notEqual(valuesOf(calls[0])["id"], valuesOf(calls[1])["id"]);
});

// ---------------------------------------------------------------- @happy 2

// Extends public "[happy-2] the conflict clause targets the Jira identity ...":
// other values, including a null project key, and the exact set contents.
test("[happy-2] the conflict set is exactly Jira's facts for another board and organization", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  await boards.sync("org_3", {
    connectionId: "jrc_5",
    externalId: "7",
    name: "Ops",
    boardType: "simple",
    projectKey: null,
  });

  const conflict = conflictOf(calls[0]);
  const target = conflict["target"] as unknown[];
  assert.ok(Array.isArray(target));
  assert.equal(target.length, 2);
  assert.equal(target[0], jiraBoard.connectionId);
  assert.equal(target[1], jiraBoard.externalId);

  const set = setOf(calls[0]);
  assert.deepEqual(Object.keys(set).sort(), SYNC_SET_KEYS);
  const { updatedAt, ...facts } = set;
  assert.deepEqual(facts, { name: "Ops", boardType: "simple", projectKey: null });
  assert.equal(timeOf(updatedAt), timeOf(valuesOf(calls[0])["updatedAt"]));
});

// Extends public "[happy-2] the conflict set carries the same values as the
// insert": smuggled identity and settings fields cannot widen the set.
test("[happy-2] smuggled fields do not widen the conflict set", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  await boards.sync("org_1", {
    ...baseInput,
    name: "Renamed",
    boardType: "kanban",
    projectKey: "NEW",
    organizationId: "org_2",
    id: "jrb_other",
    createdAt: new Date("2000-01-01T00:00:00.000Z"),
    selection: { maxTickets: 2 },
    writebackEnabled: true,
  } as SyncBoardInput);

  const set = setOf(calls[0]);
  assert.deepEqual(Object.keys(set).sort(), SYNC_SET_KEYS);
  assert.equal(set["name"], "Renamed");
  assert.equal(set["boardType"], "kanban");
  assert.equal(set["projectKey"], "NEW");
  assert.equal(timeOf(set["updatedAt"]), NOW.getTime());
});

// ---------------------------------------------------------------- @happy 3

// Extends public "[happy-3] the summary carries the stored settings, not
// defaults": the returned row differs from the input in every Jira fact, so a
// summary assembled from the input is caught.
test("[happy-3] the summary is built from the returned row, not from the input", async (t) => {
  fixture(t);
  const { store: boards } = store([
    storedRow({
      id: "jrb_77",
      connectionId: "jrc_8",
      externalId: "900",
      name: "Stored name",
      boardType: "kanban",
      projectKey: "STORED",
      selection: { maxTickets: 4, issueTypes: ["Bug"] },
      writebackEnabled: false,
      createdAt: new Date("2025-01-02T03:04:05.678Z"),
    }),
  ]);

  const summary = await boards.sync("org_1", {
    connectionId: "jrc_1",
    externalId: "42",
    name: "Input name",
    boardType: "scrum",
    projectKey: "INPUT",
  });

  assert.deepEqual(summary, {
    id: "jrb_77",
    connectionId: "jrc_8",
    externalId: "900",
    name: "Stored name",
    boardType: "kanban",
    projectKey: "STORED",
    selection: { maxTickets: 4, issueTypes: ["Bug"] },
    writebackEnabled: false,
    createdAt: "2025-01-02T03:04:05.678Z",
  });
});

// Extends public "[happy-3] the summary is the returned row through the same
// mapping get uses": more than one returned row; the first one is the result.
test("[happy-3] when several rows come back, the first becomes the summary", async (t) => {
  fixture(t);
  const { store: boards } = store([
    storedRow({ id: "jrb_first", name: "First" }),
    storedRow({ id: "jrb_second", name: "Second", writebackEnabled: false }),
  ]);

  const summary = await boards.sync("org_1", baseInput);

  assert.equal(summary.id, "jrb_first");
  assert.equal(summary.name, "First");
  assert.equal(summary.writebackEnabled, true);
  assert.deepEqual(summary.selection, { maxTickets: 10, excludeAssigned: true });
});

// ---------------------------------------------------------------- @boundary 1

// Extends public "[boundary-1] a stored null selection reads back as empty
// settings": the rest of the summary is still the row's, write-back off and
// no project key included.
test("[boundary-1] a null selection reads as empty while the rest of the row is kept", async (t) => {
  fixture(t);
  const { store: boards } = store([
    storedRow({
      selection: null as unknown as Record<string, never>,
      writebackEnabled: false,
      projectKey: null,
    }),
  ]);

  const summary = await boards.sync("org_2", { ...baseInput, projectKey: "X" });

  assert.deepEqual(summary, {
    id: "jrb_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Acme board",
    boardType: "scrum",
    projectKey: null,
    selection: {},
    writebackEnabled: false,
    createdAt: "2026-09-21T00:00:00.000Z",
  });
});

// ---------------------------------------------------------------- @boundary 2

// Extends the public "[boundary-2]" examples: other organizations and other
// project keys, including one passed explicitly as undefined.
for (const [label, given, written] of [
  ['"ZZ-9"', "ZZ-9", "ZZ-9"],
  ['"acme" (lower case)', "acme", "acme"],
  ["null", null, null],
  ["explicit undefined", undefined, null],
] as const) {
  test(`[boundary-2] projectKey ${label} is written as ${JSON.stringify(written)} on insert and update for another board`, async (t) => {
    fixture(t);
    const { store: boards, calls } = store([storedRow()]);

    await boards.sync("org_4", {
      connectionId: "jrc_2",
      externalId: "8",
      name: "Board eight",
      boardType: "kanban",
      projectKey: given,
    });

    const values = valuesOf(calls[0]);
    const set = setOf(calls[0]);
    assert.equal("projectKey" in values, true);
    assert.equal(values["projectKey"], written);
    assert.equal("projectKey" in set, true);
    assert.equal(set["projectKey"], written);
  });
}

// ---------------------------------------------------------------- @boundary 3

// Extends the public "[boundary-3]" examples: longer and stranger values.
for (const [label, name, boardType] of [
  ["a 10,000-character name", "x".repeat(10_000), "scrum"],
  ["a non-ASCII name", "Équipe — 看板 🚀", "kanban"],
  ["a name of only spaces", "   ", "unknown"],
  ["a padded, upper-case board type", "Acme board", " Kanban "],
  ["a board type outside Jira's", "Acme board", "team-managed/next-gen"],
] as const) {
  test(`[boundary-3] ${label} passes through unchanged`, async (t) => {
    fixture(t);
    const { store: boards, calls } = store([storedRow()]);

    await assert.doesNotReject(() =>
      boards.sync("org_1", { ...baseInput, name, boardType }),
    );

    const values = valuesOf(calls[0]);
    const set = setOf(calls[0]);
    assert.equal(values["name"], name);
    assert.equal(set["name"], name);
    assert.equal(values["boardType"], boardType);
    assert.equal(set["boardType"], boardType);
  });
}

// Extends public "[boundary-3] connectionId and externalId are not trimmed or
// normalised either": empty identity fields are not rejected either.
test("[boundary-3] empty connection and board ids are stored as given", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  await assert.doesNotReject(() =>
    boards.sync("org_1", {
      connectionId: "",
      externalId: "",
      name: "",
      boardType: "",
      projectKey: "",
    }),
  );

  const values = valuesOf(calls[0]);
  assert.equal(values["connectionId"], "");
  assert.equal(values["externalId"], "");
  assert.equal(values["name"], "");
  assert.equal(values["boardType"], "");
  assert.equal(values["projectKey"], "");
});

// ---------------------------------------------------------------- @unhappy 1

// Extends public "[unhappy-1] a selection smuggled past the type is ignored":
// a smuggled null, and a smuggled selection from another organization's call.
for (const [label, selection] of [
  ["null", null],
  ["an empty object", {}],
  ["a full selection", { maxTickets: 50, excludeAssigned: false, issueTypes: ["Task"] }],
] as const) {
  test(`[unhappy-1] a smuggled selection of ${label} still inserts {} and is absent from the set`, async (t) => {
    fixture(t);
    const { store: boards, calls } = store([storedRow()]);

    const summary = await boards.sync("org_2", {
      ...baseInput,
      selection,
    } as unknown as SyncBoardInput);

    const values = valuesOf(calls[0]);
    assert.deepEqual(values["selection"], {});
    assert.notEqual(values["selection"], selection);
    assert.equal("selection" in setOf(calls[0]), false);
    assert.deepEqual(summary.selection, { maxTickets: 10, excludeAssigned: true });
  });
}

// ---------------------------------------------------------------- @unhappy 2

// Extends public "[unhappy-2] a writebackEnabled smuggled past the type is
// ignored": other smuggled values, including undefined and a non-boolean.
for (const [label, writebackEnabled] of [
  ["undefined", undefined],
  ["the string \"true\"", "true"],
  ["null", null],
] as const) {
  test(`[unhappy-2] a smuggled writebackEnabled of ${label} is absent from the insert and the set`, async (t) => {
    fixture(t);
    const { store: boards, calls } = store([storedRow()]);

    await boards.sync("org_1", {
      ...baseInput,
      writebackEnabled,
    } as unknown as SyncBoardInput);

    assert.equal("writebackEnabled" in valuesOf(calls[0]), false);
    assert.equal("writebackEnabled" in setOf(calls[0]), false);
  });
}

// Extends public "[unhappy-2] a smuggled writebackEnabled of true ...":
// smuggled together with a selection, both are dropped.
test("[unhappy-2] writebackEnabled smuggled together with a selection is still ignored", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  await boards.sync("org_1", {
    ...baseInput,
    selection: { maxTickets: 1 },
    writebackEnabled: false,
  } as SyncBoardInput);

  const values = valuesOf(calls[0]);
  assert.deepEqual(Object.keys(values).sort(), SYNC_INSERT_KEYS);
  assert.equal("writebackEnabled" in values, false);
  assert.deepEqual(Object.keys(setOf(calls[0])).sort(), SYNC_SET_KEYS);
});

// ---------------------------------------------------------------- @unhappy 3

// Extends public "[unhappy-3] the conflict update carries no organization
// guard": other organizations on both sides, and no guard by any name.
test("[unhappy-3] no guard of either form when the caller and the owner differ", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([
    storedRow({
      id: "jrb_9",
      organizationId: "org_9",
      name: "Owner's board",
      projectKey: null,
      selection: { minAgeDays: 3 },
      writebackEnabled: false,
    }),
  ]);

  const summary = await boards.sync("org_3", {
    ...baseInput,
    name: "Caller's name",
  });

  const conflict = conflictOf(calls[0]);
  assert.equal("setWhere" in conflict, false);
  assert.equal("where" in conflict, false);
  assert.equal("organizationId" in setOf(calls[0]), false);
  assert.equal(valuesOf(calls[0])["organizationId"], "org_3");
  assert.equal(calls.length, 1);
  assert.deepEqual(summary, {
    id: "jrb_9",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Owner's board",
    boardType: "scrum",
    projectKey: null,
    selection: { minAgeDays: 3 },
    writebackEnabled: false,
    createdAt: "2026-09-21T00:00:00.000Z",
  });
});

// ---------------------------------------------------------------- @unhappy 4

// Extends public "[unhappy-4] no returned row rejects with a named error":
// a sync that returns nothing after one that returned a row still rejects, so
// a store that falls back to a previous result is caught.
test("[unhappy-4] an empty result after a successful sync still rejects with the named error", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()], {
    outcomes: [{ rows: [storedRow()] }, { rows: [] }],
  });

  const firstSummary = await boards.sync("org_1", baseInput);
  assert.equal(firstSummary.id, "jrb_1");

  await assert.rejects(
    () => boards.sync("org_5", { ...baseInput, externalId: "43", projectKey: "X" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Failed to record the Jira board.");
      return true;
    },
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.kind === "insert"));
});

// Extends public "[unhappy-4] the rejection follows the one insert ...": two
// overlapping syncs that both get nothing back both reject with the message.
test("[unhappy-4] overlapping syncs that get no row both reject with the named error", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([]);

  const results = await Promise.allSettled([
    boards.sync("org_1", baseInput),
    boards.sync("org_2", { ...baseInput, name: "Other" }),
  ]);

  for (const result of results) {
    assert.equal(result.status, "rejected");
    const reason = (result as PromiseRejectedResult).reason as unknown;
    assert.ok(reason instanceof Error);
    assert.equal(reason.message, "Failed to record the Jira board.");
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.kind === "insert"));
});

// ---------------------------------------------------------------- @unhappy 5

// Extends public "[unhappy-5] a database error surfaces unchanged": a
// rejection that is not an Error instance is passed on as the same value.
test("[unhappy-5] a non-Error rejection from the database is passed on as the same value", async (t) => {
  fixture(t);
  const failure = { code: "57P01", detail: "terminating connection" };
  const { store: boards } = store([storedRow()], { insertFailure: failure });

  await assert.rejects(
    () => boards.sync("org_1", baseInput),
    (error: unknown) => {
      assert.equal(error, failure);
      return true;
    },
  );
});

// Extends public "[unhappy-5] a driver error with its own fields ...": an
// error whose message looks like the store's own is still the same instance.
test("[unhappy-5] a database error is never replaced by the store's own error", async (t) => {
  fixture(t);
  const failure = new TypeError("Failed to record the Jira board.", {
    cause: new Error("socket hang up"),
  });
  const { store: boards } = store([storedRow()], { insertFailure: failure });

  await assert.rejects(
    () => boards.sync("org_1", baseInput),
    (error: unknown) => {
      assert.equal(error, failure);
      assert.ok(error instanceof TypeError);
      return true;
    },
  );
});

// Extends public "[unhappy-5] a database error surfaces unchanged": an error
// raised while the statement is being built is a rejection of the same error.
test("[unhappy-5] an error thrown while building the statement rejects with that same error", async (t) => {
  fixture(t);
  const failure = new Error("pool exhausted");
  const { store: boards } = store([storedRow()], {
    outcomes: [{ throwOnValues: failure }],
  });

  await assert.rejects(
    () => boards.sync("org_1", baseInput),
    (error: unknown) => {
      assert.equal(error, failure);
      return true;
    },
  );
});

// Extends public "[unhappy-5] a database error surfaces unchanged": after a
// successful sync, the next one's database error is still the same instance.
test("[unhappy-5] a database error after a successful sync surfaces unchanged", async (t) => {
  fixture(t);
  const failure = new Error("connection reset");
  const { store: boards } = store([storedRow()], {
    outcomes: [{ rows: [storedRow()] }, { reject: failure }],
  });

  assert.equal((await boards.sync("org_1", baseInput)).id, "jrb_1");
  await assert.rejects(
    () => boards.sync("org_1", baseInput),
    (error: unknown) => {
      assert.equal(error, failure);
      return true;
    },
  );
});

// ---------------------------------------------------------------- @concurrency 1

// Extends public "[concurrency-1] two syncs of the same board started together
// each issue one insert": five at once, so a store that de-duplicates
// in-flight syncs, or reads first, is caught.
test("[concurrency-1] five syncs of the same board started together issue five inserts and no read", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  const pending = Array.from({ length: 5 }, () => boards.sync("org_1", baseInput));
  const summaries = await Promise.all(pending);

  for (const summary of summaries) {
    assert.equal(summary.id, "jrb_1");
  }
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.kind === "insert"));
  const ids = calls.map((call) => String(valuesOf(call)["id"]));
  for (const id of ids) {
    assert.match(id, /^jrb_/);
  }
  assert.equal(new Set(ids).size, 5);
  for (const call of calls) {
    assert.deepEqual(Object.keys(setOf(call)).sort(), SYNC_SET_KEYS);
  }
});

// Extends public "[concurrency-1] two overlapping syncs of different boards
// ...": the same board from two organizations at once.
test("[concurrency-1] overlapping syncs of one board from two organizations each issue their own insert", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  const [a, b] = await Promise.all([
    boards.sync("org_1", baseInput),
    boards.sync("org_2", baseInput),
  ]);

  assert.equal(a.id, "jrb_1");
  assert.equal(b.id, "jrb_1");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.kind === "insert"));
  const orgs = calls.map((call) => valuesOf(call)["organizationId"]).sort();
  assert.deepEqual(orgs, ["org_1", "org_2"]);
  assert.notEqual(valuesOf(calls[0])["id"], valuesOf(calls[1])["id"]);
});

// ---------------------------------------------------------------- @concurrency 2

// Extends public "[concurrency-2] a sync overlapping an update does not write
// the settings the update writes": a write-back-only update, with the sync's
// insert checked as well as its set.
test("[concurrency-2] a sync overlapping a write-back-only update writes neither setting", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow({ writebackEnabled: false })]);

  const syncing = boards.sync("org_1", { ...baseInput, name: "Renamed" });
  const updating = boards.update("org_1", "jrb_1", { writebackEnabled: true });
  await assert.doesNotReject(() => Promise.all([syncing, updating]));

  const syncInserts = inserts(calls);
  assert.equal(syncInserts.length, 1);
  const values = valuesOf(syncInserts[0]);
  assert.equal("writebackEnabled" in values, false);
  assert.deepEqual(values["selection"], {});
  assert.deepEqual(Object.keys(setOf(syncInserts[0])).sort(), SYNC_SET_KEYS);

  const updates = calls.filter((call) => call.kind === "update");
  assert.equal(updates.length, 1);
  const updated = valuesOf(updates[0]);
  assert.equal(updated["writebackEnabled"], true);
  assert.deepEqual(updated["selection"], { maxTickets: 10, excludeAssigned: true });
  // Only the update reads.
  assert.equal(calls.filter((call) => call.kind === "select").length, 1);
});

// Extends public "[concurrency-2] a sync started before a selection-only
// update ...": two syncs around one update.
test("[concurrency-2] two syncs around one update leave the update's settings as the only settings written", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  const results = await Promise.all([
    boards.sync("org_1", baseInput),
    boards.update("org_1", "jrb_1", {
      selection: { maxTickets: 5, issueTypes: ["Bug"] },
      writebackEnabled: false,
    }),
    boards.sync("org_1", { ...baseInput, boardType: "kanban" }),
  ]);
  assert.equal(results.length, 3);

  const syncInserts = inserts(calls);
  assert.equal(syncInserts.length, 2);
  for (const call of syncInserts) {
    const set = setOf(call);
    assert.equal("selection" in set, false);
    assert.equal("writebackEnabled" in set, false);
    assert.equal("writebackEnabled" in valuesOf(call), false);
  }
  const updates = calls.filter((call) => call.kind === "update");
  assert.equal(updates.length, 1);
  assert.deepEqual(valuesOf(updates[0])["selection"], {
    maxTickets: 5,
    excludeAssigned: true,
    issueTypes: ["Bug"],
  });
  assert.equal(valuesOf(updates[0])["writebackEnabled"], false);
});

// ---------------------------------------------------------------- @happy 4

// Extends public "[happy-4] register still sets the selection it is given
// ...": register after a sync of the same board, with a fuller selection,
// still overwrites the selection and leaves write-back alone.
test("[happy-4] register after a sync still sets the selection it is given and leaves write-back alone", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  await boards.sync("org_1", baseInput);
  const selection = { maxTickets: 3, issueTypes: ["Bug", "Task"], minSpecChars: 40 };
  await boards.register("org_1", { ...baseInput, selection });

  assert.equal(calls.length, 2);
  assert.equal("selection" in setOf(calls[0]), false);
  const values = valuesOf(calls[1]);
  assert.deepEqual(values["selection"], selection);
  assert.deepEqual(setOf(calls[1])["selection"], selection);
  assert.equal("writebackEnabled" in values, false);
  assert.equal("writebackEnabled" in setOf(calls[1]), false);
});

// ---------------------------------------------------------------- @boundary 4

// Extends public "[boundary-4] register and sync share the conflict target
// ...": the other order, sync first, then register without a selection.
test("[boundary-4] register after a sync, without a selection, still resets it to empty with no guard", async (t) => {
  fixture(t);
  const { store: boards, calls } = store([storedRow()]);

  await boards.sync("org_1", baseInput);
  await boards.register("org_1", { ...baseInput, selection: undefined });

  assert.equal(calls.length, 2);
  assert.equal("selection" in setOf(calls[0]), false);
  assert.deepEqual(valuesOf(calls[1])["selection"], {});
  assert.deepEqual(setOf(calls[1])["selection"], {});
  assert.equal("setWhere" in conflictOf(calls[1]), false);
  assert.deepEqual(conflictOf(calls[1])["target"], conflictOf(calls[0])["target"]);
});
