/**
 * A recording fake for Drizzle's query builder, in the style of
 * `test/fake-db.ts` and the public suite's board fake. Each statement resolves,
 * in call order per kind, to the rows (or the rejection) given for it, and the
 * fake records the call's kind, table, values, conflict settings, and the
 * arguments given to `where`, `orderBy` and the joins, so a test can render
 * them with Drizzle's own Postgres dialect.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createJiraBoardStore } from "../../src/jira-boards.js";
import type {
  JiraBoardSummary,
  RegisterBoardInput,
  StoredBoardSelection,
  UpdateBoardInput,
} from "../../src/jira-boards.js";
import { jiraBoard } from "../../src/schema.js";
import * as jiraSchema from "../../src/schema/jira.js";
import type { JiraBoardRow } from "../../src/schema.js";
import type { Database } from "../../src/store.js";

type Kind = "select" | "insert" | "update" | "delete";
type Result = readonly unknown[] | Error;

interface BoardJoin {
  readonly kind: string;
  readonly table: unknown;
  readonly on: unknown;
}

interface BoardCall {
  readonly kind: Kind;
  readonly table: unknown;
  readonly values?: Record<string, unknown>;
  conflict?: { target?: unknown; set?: Record<string, unknown> };
  from?: unknown;
  readonly wheres: unknown[];
  readonly orderBys: unknown[];
  readonly joins: BoardJoin[];
}

function createBoardDb(results: Partial<Record<Kind, Result[]>> = {}) {
  const calls: BoardCall[] = [];
  const queues: Record<Kind, Result[]> = {
    select: [...(results.select ?? [])],
    insert: [...(results.insert ?? [])],
    update: [...(results.update ?? [])],
    delete: [...(results.delete ?? [])],
  };

  function start(
    kind: Kind,
    table: unknown,
    values?: Record<string, unknown>,
  ): unknown {
    const call: BoardCall = {
      kind,
      table,
      ...(values === undefined ? {} : { values }),
      wheres: [],
      orderBys: [],
      joins: [],
    };
    calls.push(call);
    const result = queues[kind].shift() ?? [];
    const settle = (): Promise<unknown> =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve([...result]);

    const join =
      (joinKind: string) =>
      (joined: unknown, on: unknown): unknown => {
        call.joins.push({ kind: joinKind, table: joined, on });
        return chain;
      };

    const chain: Record<string, unknown> = {
      from: (from: unknown) => {
        call.from = from;
        return chain;
      },
      innerJoin: join("inner"),
      leftJoin: join("left"),
      rightJoin: join("right"),
      fullJoin: join("full"),
      where: (condition: unknown) => {
        call.wheres.push(condition);
        return chain;
      },
      orderBy: (...columns: unknown[]) => {
        call.orderBys.push(...columns);
        return chain;
      },
      limit: () => chain,
      returning: () => chain,
      onConflictDoUpdate: (config: {
        target?: unknown;
        set?: Record<string, unknown>;
      }) => {
        call.conflict = config;
        return chain;
      },
      execute: () => settle(),
      then: (
        resolve?: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => settle().then(resolve, reject),
      catch: (reject?: (reason: unknown) => unknown) => settle().catch(reject),
      finally: (onFinally?: () => void) => settle().finally(onFinally),
    };
    return chain;
  }

  const db = {
    select: () => start("select", undefined),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) =>
        start("insert", table, values),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => start("update", table, values),
    }),
    delete: (table: unknown) => start("delete", table),
  };

  return {
    calls,
    store: createJiraBoardStore(db as unknown as Database),
  };
}

const dialect = new PgDialect();

/** Renders recorded SQL fragments the way Postgres would receive them. */
function render(parts: readonly unknown[]): {
  sql: string;
  params: unknown[];
} {
  const query = dialect.sqlToQuery(
    sql.join(
      parts.map((part) => sql`${part}`),
      sql` , `,
    ),
  );
  return { sql: query.sql, params: query.params };
}

/** Row "B1" from the spec's background. */
function boardRow(overrides: Partial<JiraBoardRow> = {}): JiraBoardRow {
  return {
    id: "jrb_1",
    organizationId: "org_1",
    connectionId: "jrc_1",
    externalId: "42",
    name: "Platform",
    boardType: "scrum",
    projectKey: "PLAT",
    selection: { maxTickets: 5, issueTypes: ["Bug"] },
    writebackEnabled: false,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

const SUMMARY_KEYS = [
  "boardType",
  "connectionId",
  "createdAt",
  "externalId",
  "id",
  "name",
  "projectKey",
  "selection",
  "writebackEnabled",
];

function sortedKeys(value: object | null | undefined): string[] {
  return Object.keys(value ?? {}).sort();
}

function targetColumns(target: unknown): unknown[] {
  return Array.isArray(target) ? target : [target];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONNECTION = {
  id: "jrc_1",
  cloudId: "cloud-1",
  siteUrl: "https://acme.atlassian.net",
};

const BASIC_INPUT: RegisterBoardInput = {
  connectionId: "jrc_1",
  externalId: "42",
  name: "Platform",
  boardType: "scrum",
};

/** The summary a row maps to, built field by field from the spec's rule. */
function summaryOf(row: JiraBoardRow): JiraBoardSummary {
  return {
    id: row.id,
    connectionId: row.connectionId,
    externalId: row.externalId,
    name: row.name,
    boardType: row.boardType,
    projectKey: row.projectKey,
    selection: (row.selection ?? {}) as StoredBoardSelection,
    writebackEnabled: row.writebackEnabled,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Asserts the call's where names the organization (and the board, when given)
 * against `jira_board`'s own columns, joined by `and`.
 */
function assertOwnerScoped(
  call: BoardCall | undefined,
  organizationId: string,
  boardId?: string,
): void {
  assert.ok(call, "no call was made");
  assert.ok(call.wheres.length > 0, `the ${call.kind} has no where`);
  const where = render(call.wheres);
  assert.ok(
    where.params.includes(organizationId),
    `the ${call.kind}'s where does not bind ${organizationId}: ${where.sql}`,
  );
  assert.match(where.sql, /"jira_board"\."organization_id"/);
  if (boardId !== undefined) {
    assert.ok(
      where.params.includes(boardId),
      `the ${call.kind}'s where does not bind ${boardId}: ${where.sql}`,
    );
    assert.match(where.sql, /"jira_board"\."id"/);
  }
  assert.doesNotMatch(where.sql, /\bor\b/i);
}

const OTHER_ROW = boardRow({
  id: "jrb_9",
  organizationId: "org_3",
  connectionId: "jrc_7",
  externalId: "1001",
  name: "Ünïcode — board",
  boardType: "kanban",
  projectKey: "X",
  selection: { excludeAssigned: true, minSpecChars: 0 },
  writebackEnabled: true,
  createdAt: new Date("2025-02-28T23:59:59.999Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const OTHER_SUMMARY: JiraBoardSummary = {
  id: "jrb_9",
  connectionId: "jrc_7",
  externalId: "1001",
  name: "Ünïcode — board",
  boardType: "kanban",
  projectKey: "X",
  selection: { excludeAssigned: true, minSpecChars: 0 },
  writebackEnabled: true,
  createdAt: "2025-02-28T23:59:59.999Z",
};

// ---------------------------------------------------------------------------
// Rule: a summary is the row mapped field by field
// ---------------------------------------------------------------------------

// Extends "[happy-1] get maps a stored row to a summary": every field differs.
test("[happy-1] get maps a row with other values in every field to its nine-key summary", async () => {
  const { store } = createBoardDb({ select: [[OTHER_ROW]] });

  const summary = await store.get("org_3", "jrb_9");

  assert.deepEqual(summary, OTHER_SUMMARY);
  assert.deepEqual(sortedKeys(summary), SUMMARY_KEYS);
});

// Extends "[happy-1] get maps a stored row to a summary": the same mapping
// holds for what list, register, update and forRun return.
test("[happy-1] list, register, update and forRun return the same nine-key summary as get", async () => {
  const { store } = createBoardDb({
    select: [
      [OTHER_ROW],
      [OTHER_ROW],
      [{ jira_board: OTHER_ROW, jira_connection: CONNECTION }],
    ],
    insert: [[OTHER_ROW]],
    update: [[OTHER_ROW]],
  });

  const listed = await store.list("org_3");
  const registered = await store.register("org_3", {
    connectionId: "jrc_7",
    externalId: "1001",
    name: "Ünïcode — board",
    boardType: "kanban",
  });
  const updated = await store.update("org_3", "jrb_9", {});
  const forRun = await store.forRun("org_3", "jrb_9");

  assert.deepEqual(listed, [OTHER_SUMMARY]);
  assert.deepEqual(registered, OTHER_SUMMARY);
  assert.deepEqual(updated, OTHER_SUMMARY);
  assert.deepEqual(forRun?.board, OTHER_SUMMARY);
  for (const summary of [listed[0], registered, updated, forRun?.board]) {
    assert.deepEqual(sortedKeys(summary), SUMMARY_KEYS);
  }
});

test("[boundary-1] a null project key stays null in what register, update and forRun return", async () => {
  const row = boardRow({ projectKey: null });
  const { store } = createBoardDb({
    select: [[row], [{ jira_board: row, jira_connection: CONNECTION }]],
    insert: [[row]],
    update: [[row]],
  });

  const registered = await store.register("org_1", BASIC_INPUT);
  const updated = await store.update("org_1", "jrb_1", {});
  const forRun = await store.forRun("org_1", "jrb_1");

  assert.equal(registered.projectKey, null);
  assert.equal(updated?.projectKey, null);
  assert.equal(forRun?.board.projectKey, null);
  assert.ok(updated !== null && "projectKey" in updated);
});

test("[boundary-1] a null project key stays null beside a set one in a list", async () => {
  const { store } = createBoardDb({
    select: [
      [
        boardRow({ id: "jrb_a", projectKey: null }),
        boardRow({ id: "jrb_b", projectKey: "B" }),
        boardRow({ id: "jrb_c", projectKey: "" }),
      ],
    ],
  });

  const listed = await store.list("org_1");

  assert.deepEqual(
    listed.map((board) => board.projectKey),
    [null, "B", ""],
  );
});

// ---------------------------------------------------------------------------
// Rule: a stored selection is read as stored; only null reads as {}
// ---------------------------------------------------------------------------

const MORE_SELECTION_READS: ReadonlyArray<readonly [string, unknown]> = [
  ["falsy values", { excludeAssigned: false, maxTickets: 0, minSpecChars: 0 }],
  ["negative and huge numbers", { maxTickets: -1, minSpecChars: 1e9 }],
  [
    "duplicate, padded and empty issue types",
    { issueTypes: [" Bug ", "Bug", "Bug", ""] },
  ],
  ["an empty issue type list", { issueTypes: [] }],
  [
    "every key with nested unknown keys",
    {
      maxTickets: 7,
      excludeAssigned: true,
      issueTypes: ["Story", "Task"],
      minAgeDays: 3,
      maxAgeDays: null,
      minSpecChars: 120,
      colour: "red",
      nested: { depth: [1, 2, { x: null }] },
    },
  ],
  ["only unknown keys", { colour: "red", size: 3 }],
  ["wrong value types", { maxTickets: "five", issueTypes: "Bug" }],
];

// Extends "[boundary-2] the selection column … is read as …": more stored shapes.
for (const [label, stored] of MORE_SELECTION_READS) {
  test(`[boundary-2] a stored selection with ${label} is read as stored`, async () => {
    const { store } = createBoardDb({
      select: [[boardRow({ selection: stored })]],
    });

    const summary = await store.get("org_1", "jrb_1");

    assert.deepEqual(summary?.selection, stored);
  });
}

// Extends "[boundary-2]": the null-reads-as-{} rule holds wherever a row is read.
test("[boundary-2] a null selection reads as {} from list, register and update, beside stored ones", async () => {
  const { store } = createBoardDb({
    select: [
      [
        boardRow({ id: "jrb_a", selection: null }),
        boardRow({ id: "jrb_b", selection: { colour: "red" } }),
        boardRow({ id: "jrb_c", selection: {} }),
      ],
      [boardRow()],
    ],
    insert: [[boardRow({ selection: null })]],
    update: [[boardRow({ selection: null })]],
  });

  const listed = await store.list("org_1");
  const registered = await store.register("org_1", BASIC_INPUT);
  const updated = await store.update("org_1", "jrb_1", {});

  assert.deepEqual(
    listed.map((board) => board.selection),
    [{}, { colour: "red" }, {}],
  );
  assert.deepEqual(registered.selection, {});
  assert.deepEqual(updated?.selection, {});
});

// ---------------------------------------------------------------------------
// Rule: list is one owner-scoped select ordered by createdAt descending
// ---------------------------------------------------------------------------

// Extends "[happy-2] list is owner-scoped and ordered by the query": checks
// what the where and orderBy hold, not only that they were applied.
test("[happy-2] list filters jira_board on the organization and orders by created_at descending", async () => {
  const { store, calls } = createBoardDb({ select: [[boardRow()]] });

  await store.list("org_42");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, "select");
  assert.equal(calls[0]?.from, jiraBoard);
  assertOwnerScoped(calls[0], "org_42");
  const order = render(calls[0]?.orderBys ?? []);
  assert.match(order.sql, /^"jira_board"\."created_at" desc\b/);
});

// Extends "[happy-2] list is owner-scoped and ordered by the query": more rows.
test("[happy-2] list maps twenty-five rows in the order the database returns them", async () => {
  const rows = Array.from({ length: 25 }, (_, index) =>
    boardRow({
      id: `jrb_${String(25 - index).padStart(2, "0")}`,
      externalId: String(1000 + index),
      name: `Board ${index}`,
      createdAt: new Date(Date.UTC(2026, 9, 25 - index, 12, 0, 0, index)),
      selection: index % 3 === 0 ? null : { maxTickets: index },
    }),
  );
  const { store, calls } = createBoardDb({ select: [rows] });

  const listed = await store.list("org_1");

  assert.deepEqual(listed, rows.map(summaryOf));
  assert.equal(calls.length, 1);
});

// Extends "[boundary-3] the store does not re-sort what the database returns".
test("[boundary-3] five boards in no date or id order are listed as the database returned them", async () => {
  const order: ReadonlyArray<readonly [string, string]> = [
    ["jrb_b", "2026-10-02T00:00:00.000Z"],
    ["jrb_e", "2026-09-01T00:00:00.000Z"],
    ["jrb_a", "2026-10-05T00:00:00.000Z"],
    ["jrb_d", "2026-10-05T00:00:00.000Z"],
    ["jrb_c", "2025-01-01T00:00:00.000Z"],
  ];
  const { store } = createBoardDb({
    select: [
      order.map(([id, createdAt]) =>
        boardRow({ id, createdAt: new Date(createdAt) }),
      ),
    ],
  });

  const listed = await store.list("org_1");

  assert.deepEqual(
    listed.map((board) => [board.id, board.createdAt]),
    order,
  );
});

// Extends "[boundary-4] an organization with no boards lists none".
test("[boundary-4] another organization with no boards lists none from a select scoped to it", async () => {
  const { store, calls } = createBoardDb({ select: [[]] });

  const listed = await store.list("org_empty");

  assert.deepEqual(listed, []);
  assert.equal(calls.length, 1);
  assertOwnerScoped(calls[0], "org_empty");
});

// ---------------------------------------------------------------------------
// Rule: get filters on owner and id; a miss is null
// ---------------------------------------------------------------------------

// Extends "[happy-3] get is owner-scoped": both predicates are in the where.
test("[happy-3] get's where binds both the organization and the board id", async () => {
  const { store, calls } = createBoardDb({ select: [[OTHER_ROW]] });

  await store.get("org_3", "jrb_9");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, "select");
  assert.equal(calls[0]?.from, jiraBoard);
  assertOwnerScoped(calls[0], "org_3", "jrb_9");
});

// Extends "[unhappy-1] another organization's board is null".
test("[unhappy-1] get for another organization's board is null, and its where names that organization and the board", async () => {
  const { store, calls } = createBoardDb({ select: [[]] });

  const result = await store.get("org_2", "jrb_1");

  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assertOwnerScoped(calls[0], "org_2", "jrb_1");
});

test("[unhappy-1] get for a board id that does not exist is null", async () => {
  const { store } = createBoardDb({ select: [[]] });

  assert.equal(await store.get("org_1", "jrb_missing"), null);
});

// ---------------------------------------------------------------------------
// Rule: register writes its input as given in one upsert
// ---------------------------------------------------------------------------

// Extends "[happy-4] register writes a prefixed, owner-scoped row": other values.
test("[happy-4] register writes other input values into one insert into jira_board", async () => {
  const returned = boardRow({
    organizationId: "org_9",
    connectionId: "jrc_5",
    externalId: "7",
    name: "Mobile",
    boardType: "kanban",
    projectKey: "MOB",
    selection: { excludeAssigned: true, issueTypes: ["Story", "Task"] },
  });
  const { store, calls } = createBoardDb({ insert: [[returned]] });

  const summary = await store.register("org_9", {
    connectionId: "jrc_5",
    externalId: "7",
    name: "Mobile",
    boardType: "kanban",
    projectKey: "MOB",
    selection: { excludeAssigned: true, issueTypes: ["Story", "Task"] },
  });

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["insert"],
  );
  assert.equal(calls[0]?.table, jiraBoard);
  const values = calls[0]?.values ?? {};
  assert.match(String(values["id"]), /^jrb_./);
  assert.equal(values["organizationId"], "org_9");
  assert.equal(values["connectionId"], "jrc_5");
  assert.equal(values["externalId"], "7");
  assert.equal(values["name"], "Mobile");
  assert.equal(values["boardType"], "kanban");
  assert.equal(values["projectKey"], "MOB");
  assert.deepEqual(values["selection"], {
    excludeAssigned: true,
    issueTypes: ["Story", "Task"],
  });
  assert.ok(values["updatedAt"] instanceof Date);
  assert.ok(!("writebackEnabled" in values));
  assert.deepEqual(summary, summaryOf(returned));
});

// Extends "[happy-4] register resolves to the summary of the returned row":
// the id and createdAt come from the row, not from what register generated.
test("[happy-4] register resolves to the returned row's id and createdAt, not the generated id", async () => {
  const returned = boardRow({
    id: "jrb_existing",
    createdAt: new Date("2024-03-04T05:06:07.890Z"),
  });
  const { store, calls } = createBoardDb({ insert: [[returned]] });

  const summary = await store.register("org_1", BASIC_INPUT);

  assert.notEqual(calls[0]?.values?.["id"], "jrb_existing");
  assert.equal(summary.id, "jrb_existing");
  assert.equal(summary.createdAt, "2024-03-04T05:06:07.890Z");
  assert.deepEqual(sortedKeys(summary), SUMMARY_KEYS);
});

interface RegisterValuesExample {
  readonly label: string;
  readonly input: RegisterBoardInput;
  readonly storedKey: string | null;
  readonly storedSelection: unknown;
}

const LONG_NAME = "N".repeat(1000);
const LONG_EXTERNAL = "9".repeat(300);
const LONG_TYPE = "t".repeat(256);

const MORE_REGISTER_EXAMPLES: readonly RegisterValuesExample[] = [
  {
    label: "an empty projectKey is kept as an empty string",
    input: { ...BASIC_INPUT, projectKey: "" },
    storedKey: "",
    storedSelection: {},
  },
  {
    label: "strings longer than 255 characters are not capped",
    input: {
      connectionId: "jrc_1",
      externalId: LONG_EXTERNAL,
      name: LONG_NAME,
      boardType: LONG_TYPE,
      projectKey: "P".repeat(500),
    },
    storedKey: "P".repeat(500),
    storedSelection: {},
  },
  {
    label: "tabs and newlines are not trimmed",
    input: {
      connectionId: "jrc_1",
      externalId: "\t42\n",
      name: "\nPlatform\t",
      boardType: "\tscrum",
      projectKey: "PLAT\n",
    },
    storedKey: "PLAT\n",
    storedSelection: {},
  },
  {
    label: "an empty boardType and a selection the HTTP edge would reject",
    input: {
      connectionId: "jrc_1",
      externalId: "42",
      name: "Platform",
      boardType: "",
      projectKey: null,
      selection: {
        maxTickets: 101,
        minAgeDays: 30,
        maxAgeDays: 7,
        minSpecChars: -1,
        issueTypes: [" Bug ", "Bug", "Bug", ""],
      },
    },
    storedKey: null,
    storedSelection: {
      maxTickets: 101,
      minAgeDays: 30,
      maxAgeDays: 7,
      minSpecChars: -1,
      issueTypes: [" Bug ", "Bug", "Bug", ""],
    },
  },
  {
    label: "a null maxAgeDays, a false excludeAssigned and unknown keys",
    input: {
      ...BASIC_INPUT,
      projectKey: "PLAT",
      selection: {
        maxAgeDays: null,
        excludeAssigned: false,
        colour: "red",
        nested: { a: [1] },
      } as StoredBoardSelection,
    },
    storedKey: "PLAT",
    storedSelection: {
      maxAgeDays: null,
      excludeAssigned: false,
      colour: "red",
      nested: { a: [1] },
    },
  },
];

// Extends "[boundary-5] register stores inputs as given": more inputs.
for (const example of MORE_REGISTER_EXAMPLES) {
  test(`[boundary-5] register stores inputs as given: ${example.label}`, async () => {
    const { store, calls } = createBoardDb({ insert: [[boardRow()]] });

    await store.register("org_1", example.input);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.kind, "insert");
    const values = calls[0]?.values ?? {};
    assert.equal(values["externalId"], example.input.externalId);
    assert.equal(values["name"], example.input.name);
    assert.equal(values["boardType"], example.input.boardType);
    assert.equal(values["projectKey"], example.storedKey);
    assert.deepEqual(values["selection"], example.storedSelection);
  });
}

// ---------------------------------------------------------------------------
// Rule: register does not check that the connection is the organization's
// ---------------------------------------------------------------------------

// Extends "[boundary-6] another organization's connection is not looked up".
test("[boundary-6] a connection owned by another organization is written for the caller without any read", async () => {
  const returned = boardRow({
    id: "jrb_x",
    organizationId: "org_3",
    connectionId: "jrc_of_org_4",
  });
  const { store, calls } = createBoardDb({ insert: [[returned]] });

  const summary = await store.register("org_3", {
    ...BASIC_INPUT,
    connectionId: "jrc_of_org_4",
    selection: { maxTickets: 2 },
  });

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["insert"],
  );
  assert.equal(calls[0]?.values?.["organizationId"], "org_3");
  assert.equal(calls[0]?.values?.["connectionId"], "jrc_of_org_4");
  assert.equal(calls[0]?.conflict?.set?.["organizationId"], "org_3");
  assert.equal(calls[0]?.conflict?.set?.["connectionId"], "jrc_of_org_4");
  assert.equal(summary.id, "jrb_x");
  assert.equal(summary.connectionId, "jrc_of_org_4");
});

// ---------------------------------------------------------------------------
// Rule: re-registering updates in place on (connection_id, external_id)
// ---------------------------------------------------------------------------

const CONFLICT_SET_KEYS = [
  "boardType",
  "connectionId",
  "externalId",
  "name",
  "organizationId",
  "projectKey",
  "selection",
  "updatedAt",
];

// Extends "[happy-5] re-registering refreshes Jira's details and keeps the
// board's id": a full input, and the set holds exactly the overwritten fields.
test("[happy-5] the conflict update sets exactly the eight overwritten fields to the given values", async () => {
  const { store, calls } = createBoardDb({
    insert: [[boardRow({ name: "Renamed", organizationId: "org_8" })]],
  });

  const summary = await store.register("org_8", {
    connectionId: "jrc_8",
    externalId: "808",
    name: "Renamed",
    boardType: "simple",
    projectKey: "REN",
    selection: { minSpecChars: 50, issueTypes: ["Epic"] },
  });

  const conflict = calls[0]?.conflict;
  assert.ok(conflict, "the insert has no onConflictDoUpdate");
  const target = targetColumns(conflict.target);
  assert.equal(target.length, 2);
  assert.ok(target.includes(jiraBoard.connectionId));
  assert.ok(target.includes(jiraBoard.externalId));

  const set = conflict.set ?? {};
  assert.deepEqual(sortedKeys(set), CONFLICT_SET_KEYS);
  assert.equal(set["organizationId"], "org_8");
  assert.equal(set["connectionId"], "jrc_8");
  assert.equal(set["externalId"], "808");
  assert.equal(set["name"], "Renamed");
  assert.equal(set["boardType"], "simple");
  assert.equal(set["projectKey"], "REN");
  assert.deepEqual(set["selection"], { minSpecChars: 50, issueTypes: ["Epic"] });
  assert.ok(set["updatedAt"] instanceof Date);
  assert.equal(summary.id, "jrb_1");
  assert.equal(summary.name, "Renamed");
});

test("[happy-5] the conflict update of a minimal registration holds no writebackEnabled, id or createdAt", async () => {
  const { store, calls } = createBoardDb({ insert: [[boardRow()]] });

  await store.register("org_1", { ...BASIC_INPUT, projectKey: null });

  const set = calls[0]?.conflict?.set ?? {};
  assert.deepEqual(sortedKeys(set), CONFLICT_SET_KEYS);
  assert.equal(set["projectKey"], null);
  assert.ok(!("writebackEnabled" in set));
  assert.ok(!("id" in set));
  assert.ok(!("createdAt" in set));
});

// Extends "[boundary-7] a re-registration that gives a selection replaces it".
test("[boundary-7] a re-registration's selection replaces the stored one whole, with nothing merged in", async () => {
  const given = { issueTypes: ["Story"], excludeAssigned: false };
  const { store, calls } = createBoardDb({ insert: [[boardRow()]] });

  await store.register("org_1", { ...BASIC_INPUT, selection: given });

  assert.deepEqual(calls[0]?.conflict?.set?.["selection"], given);
  assert.deepEqual(calls[0]?.values?.["selection"], given);
});

test("[boundary-7] a re-registration that gives an empty selection replaces it with {}", async () => {
  const { store, calls } = createBoardDb({ insert: [[boardRow()]] });

  await store.register("org_1", { ...BASIC_INPUT, selection: {} });

  assert.deepEqual(calls[0]?.conflict?.set?.["selection"], {});
});

// Extends "[boundary-8] a re-registration without a selection resets it to {}".
test("[boundary-8] a re-registration that gives a project key but no selection resets the selection to {}", async () => {
  const { store, calls } = createBoardDb({ insert: [[boardRow()]] });

  await store.register("org_1", {
    connectionId: "jrc_2",
    externalId: "77",
    name: "Data",
    boardType: "kanban",
    projectKey: "DATA",
  });

  assert.deepEqual(calls[0]?.conflict?.set?.["selection"], {});
  assert.deepEqual(calls[0]?.values?.["selection"], {});
  assert.equal(calls[0]?.conflict?.set?.["projectKey"], "DATA");
});

// ---------------------------------------------------------------------------
// Rule: register fails loudly on no row; database errors pass through
// ---------------------------------------------------------------------------

// Extends "[unhappy-2] an upsert that returns no row rejects".
test("[unhappy-2] an upsert for another organization that returns no row rejects after its single insert", async () => {
  const { store, calls } = createBoardDb({ insert: [[]] });

  await assert.rejects(
    () =>
      store.register("org_5", {
        connectionId: "jrc_9",
        externalId: "9",
        name: "Other",
        boardType: "kanban",
        selection: { maxTickets: 1 },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Failed to register the Jira board.");
      return true;
    },
  );
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["insert"],
  );
});

class DatabaseError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

// Extends "[unhappy-3] a database error is passed through": another error class.
test("[unhappy-3] a driver error of its own class is passed through as the same object", async () => {
  const failure = new DatabaseError(
    'duplicate key value violates unique constraint "jira_board_pkey"',
    "23505",
  );
  const { store, calls } = createBoardDb({ insert: [failure] });

  await assert.rejects(
    () =>
      store.register("org_2", {
        ...BASIC_INPUT,
        projectKey: "PLAT",
        selection: { maxTickets: 3 },
      }),
    (error: unknown) => {
      assert.equal(error, failure);
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, "23505");
      assert.equal(
        error.message,
        'duplicate key value violates unique constraint "jira_board_pkey"',
      );
      return true;
    },
  );
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["insert"],
  );
});

// ---------------------------------------------------------------------------
// Rule: update reads, then writes once; selection merged key by key
// ---------------------------------------------------------------------------

// Extends "[happy-6] update merges the selection and toggles write-back":
// other values, and the result is the row the UPDATE returned.
test("[happy-6] update merges several keys, turns write-back off and resolves to the row the update returned", async () => {
  const stored = boardRow({
    id: "jrb_7",
    organizationId: "org_7",
    writebackEnabled: true,
    selection: { maxTickets: 5, issueTypes: ["Bug"], minAgeDays: 2 },
  });
  const merged = {
    maxTickets: 5,
    issueTypes: ["Story", "Task"],
    minAgeDays: 2,
    excludeAssigned: true,
    maxAgeDays: null,
  };
  const returned = boardRow({
    id: "jrb_7",
    organizationId: "org_7",
    name: "Renamed in the meantime",
    writebackEnabled: false,
    selection: merged,
  });
  const { store, calls } = createBoardDb({
    select: [[stored]],
    update: [[returned]],
  });

  const summary = await store.update("org_7", "jrb_7", {
    selection: {
      issueTypes: ["Story", "Task"],
      excludeAssigned: true,
      maxAgeDays: null,
    },
    writebackEnabled: false,
  });

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["select", "update"],
  );
  const values = calls[1]?.values ?? {};
  assert.deepEqual(values["selection"], merged);
  assert.equal(values["writebackEnabled"], false);
  assert.ok(values["updatedAt"] instanceof Date);
  assert.deepEqual(summary, summaryOf(returned));
});

// Extends "[happy-6] update merges the selection and toggles write-back": both
// statements are scoped to the owner and the board.
test("[happy-6] update's select and UPDATE both bind the organization and the board id on jira_board", async () => {
  const { store, calls } = createBoardDb({
    select: [[boardRow({ id: "jrb_5", organizationId: "org_5" })]],
    update: [[boardRow({ id: "jrb_5", organizationId: "org_5" })]],
  });

  await store.update("org_5", "jrb_5", { writebackEnabled: true });

  assert.equal(calls[0]?.kind, "select");
  assert.equal(calls[0]?.from, jiraBoard);
  assertOwnerScoped(calls[0], "org_5", "jrb_5");
  assert.equal(calls[1]?.kind, "update");
  assert.equal(calls[1]?.table, jiraBoard);
  assertOwnerScoped(calls[1], "org_5", "jrb_5");
});

// Extends "[happy-6] update replaces a stored key it is given and keeps the
// others": the base is whatever the select returned, unknown keys included.
test("[happy-6] update merges over the selection the select returned, keeping its unknown keys", async () => {
  const { store, calls } = createBoardDb({
    select: [[boardRow({ selection: { colour: "red", minSpecChars: 50, maxTickets: 1 } })]],
    update: [[boardRow()]],
  });

  await store.update("org_1", "jrb_1", { selection: { maxTickets: 7 } });

  assert.deepEqual(calls[1]?.values?.["selection"], {
    colour: "red",
    minSpecChars: 50,
    maxTickets: 7,
  });
});

interface MoreUpdateExample {
  readonly label: string;
  readonly stored: unknown;
  readonly storedWriteback: boolean;
  readonly input: UpdateBoardInput;
  readonly keys: readonly string[];
  readonly selection: unknown;
  readonly writebackEnabled?: boolean;
}

const MORE_UPDATE_EXAMPLES: readonly MoreUpdateExample[] = [
  {
    label: "write-back off on a board that has it on",
    stored: { maxTickets: 5, issueTypes: ["Bug"] },
    storedWriteback: true,
    input: { writebackEnabled: false },
    keys: ["selection", "writebackEnabled", "updatedAt"],
    selection: { maxTickets: 5, issueTypes: ["Bug"] },
    writebackEnabled: false,
  },
  {
    label: "a selection and write-back together, with an empty issue type list",
    stored: { maxTickets: 5, issueTypes: ["Bug"] },
    storedWriteback: false,
    input: { selection: { maxTickets: 9, issueTypes: [] }, writebackEnabled: true },
    keys: ["selection", "writebackEnabled", "updatedAt"],
    selection: { maxTickets: 9, issueTypes: [] },
    writebackEnabled: true,
  },
  {
    label: "a null maxAgeDays over a stored number",
    stored: { maxAgeDays: 14, minAgeDays: 2 },
    storedWriteback: false,
    input: { selection: { maxAgeDays: null } },
    keys: ["selection", "updatedAt"],
    selection: { maxAgeDays: null, minAgeDays: 2 },
  },
  {
    label: "a number over a stored null maxAgeDays",
    stored: { maxAgeDays: null },
    storedWriteback: false,
    input: { selection: { maxAgeDays: 14 } },
    keys: ["selection", "updatedAt"],
    selection: { maxAgeDays: 14 },
  },
  {
    label: "a selection over a stored null selection",
    stored: null,
    storedWriteback: false,
    input: { selection: { maxTickets: 3 } },
    keys: ["selection", "updatedAt"],
    selection: { maxTickets: 3 },
  },
  {
    label: "an empty update of a selection with every key",
    stored: {
      maxTickets: 7,
      excludeAssigned: false,
      issueTypes: ["Story"],
      minAgeDays: 0,
      maxAgeDays: null,
      minSpecChars: 10,
    },
    storedWriteback: true,
    input: {},
    keys: ["selection", "updatedAt"],
    selection: {
      maxTickets: 7,
      excludeAssigned: false,
      issueTypes: ["Story"],
      minAgeDays: 0,
      maxAgeDays: null,
      minSpecChars: 10,
    },
  },
];

// Extends "[boundary-9] update … writes exactly …": other stored rows and inputs.
for (const example of MORE_UPDATE_EXAMPLES) {
  test(`[boundary-9] update writes exactly ${example.keys.join(", ")} for ${example.label}`, async () => {
    const { store, calls } = createBoardDb({
      select: [
        [
          boardRow({
            selection: example.stored,
            writebackEnabled: example.storedWriteback,
          }),
        ],
      ],
      update: [[boardRow()]],
    });

    await store.update("org_1", "jrb_1", example.input);

    const writes = calls.filter((call) => call.kind === "update");
    assert.equal(writes.length, 1);
    const values = writes[0]?.values ?? {};
    assert.deepEqual(sortedKeys(values), [...example.keys].sort());
    assert.deepEqual(values["selection"], example.selection);
    assert.ok(values["updatedAt"] instanceof Date);
    if (example.writebackEnabled !== undefined) {
      assert.equal(values["writebackEnabled"], example.writebackEnabled);
    }
  });
}

// Extends "[boundary-10] the selection is not validated": more invalid values.
test("[boundary-10] negative, zero, huge, fractional and unknown selection values are merged and written as given", async () => {
  const { store, calls } = createBoardDb({
    select: [[boardRow()]],
    update: [[boardRow()]],
  });

  await store.update("org_1", "jrb_1", {
    selection: {
      maxTickets: -5,
      minSpecChars: 1e9,
      minAgeDays: 0.25,
      maxAgeDays: 0,
      issueTypes: [" Bug ", "bug", ""],
      colour: "red",
    } as StoredBoardSelection,
  });

  assert.deepEqual(calls[1]?.values?.["selection"], {
    maxTickets: -5,
    issueTypes: [" Bug ", "bug", ""],
    minSpecChars: 1e9,
    minAgeDays: 0.25,
    maxAgeDays: 0,
    colour: "red",
  });
});

// Extends "[unhappy-4] an update … that misses is null and writes nothing".
test("[unhappy-4] an update with a selection and write-back off that misses is null and writes nothing", async () => {
  const { store, calls } = createBoardDb({ select: [[]], update: [[boardRow()]] });

  const result = await store.update("org_2", "jrb_1", {
    selection: { maxTickets: 3 },
    writebackEnabled: false,
  });

  assert.equal(result, null);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["select"],
  );
  assertOwnerScoped(calls[0], "org_2", "jrb_1");
});

test("[unhappy-4] an update of a board id that does not exist is null and writes nothing", async () => {
  const { store, calls } = createBoardDb({ select: [[]], update: [[boardRow()]] });

  const result = await store.update("org_1", "jrb_missing", {
    writebackEnabled: true,
  });

  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, "select");
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

// Extends "[concurrency-1] update overlapping a remove resolves to null": the
// remove starts first, and the update carries a selection.
test("[concurrency-1] an update started after an overlapping remove resolves to null and writes only an owner-scoped update", async () => {
  const { store, calls } = createBoardDb({
    select: [[boardRow()]],
    delete: [[boardRow()]],
    update: [[]],
  });

  const [removed, updated] = await Promise.all([
    store.remove("org_1", "jrb_1"),
    store.update("org_1", "jrb_1", {
      selection: { maxTickets: 9 },
      writebackEnabled: true,
    }),
  ]);

  assert.equal(removed, true);
  assert.equal(updated, null);
  const writes = calls.filter((call) => call.kind === "update");
  assert.equal(writes.length, 1);
  assertOwnerScoped(writes[0], "org_1", "jrb_1");
  assert.ok(!calls.some((call) => call.kind === "insert"));
  assert.deepEqual(
    calls
      .filter((call) => call.kind === "select" || call.kind === "update")
      .map((call) => call.kind),
    ["select", "update"],
  );
});

// Extends "[concurrency-2] two registrations of board 42 at once": three
// registrations with different selections.
test("[concurrency-2] three overlapping registrations each upsert on the conflict target and resolve to the one row", async () => {
  const { store, calls } = createBoardDb({
    insert: [[boardRow()], [boardRow()], [boardRow()]],
  });
  const selections: StoredBoardSelection[] = [
    { maxTickets: 1 },
    { maxTickets: 2 },
    { minAgeDays: 3 },
  ];

  const results = await Promise.all(
    selections.map((selection) =>
      store.register("org_1", { ...BASIC_INPUT, selection }),
    ),
  );

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["insert", "insert", "insert"],
  );
  calls.forEach((call, index) => {
    assert.ok(call.conflict, "an insert has no conflict target");
    const target = targetColumns(call.conflict.target);
    assert.equal(target.length, 2);
    assert.ok(target.includes(jiraBoard.connectionId));
    assert.ok(target.includes(jiraBoard.externalId));
    assert.deepEqual(call.values?.["selection"], selections[index]);
    assert.deepEqual(call.conflict.set?.["selection"], selections[index]);
  });
  for (const result of results) {
    assert.equal(result.id, "jrb_1");
  }
});

// ---------------------------------------------------------------------------
// Rule: remove deletes with both predicates and reports whether a row went
// ---------------------------------------------------------------------------

// Extends "[happy-7] removing an owned board": other ids, and both predicates.
test("[happy-7] removing another owned board deletes from jira_board by organization and board id", async () => {
  const { store, calls } = createBoardDb({
    delete: [[boardRow({ id: "jrb_77", organizationId: "org_5" })]],
  });

  const removed = await store.remove("org_5", "jrb_77");

  assert.equal(removed, true);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["delete"],
  );
  assert.equal(calls[0]?.table, jiraBoard);
  assertOwnerScoped(calls[0], "org_5", "jrb_77");
});

// Extends "[unhappy-5] removing another organization's board".
test("[unhappy-5] removing another organization's board is false from one delete naming that organization and board", async () => {
  const { store, calls } = createBoardDb({ delete: [[]] });

  const removed = await store.remove("org_2", "jrb_1");

  assert.equal(removed, false);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["delete"],
  );
  assertOwnerScoped(calls[0], "org_2", "jrb_1");
});

test("[unhappy-5] removing a board id that does not exist is false", async () => {
  const { store } = createBoardDb({ delete: [[]] });

  assert.equal(await store.remove("org_1", "jrb_missing"), false);
});

// ---------------------------------------------------------------------------
// Rule: forRun is one owner-scoped joined query
// ---------------------------------------------------------------------------

// Extends "[happy-8] forRun returns what a run needs": the join and the where.
test("[happy-8] forRun inner-joins jira_connection on connection_id and binds the organization and board id", async () => {
  const { store, calls } = createBoardDb({
    select: [[{ jira_board: OTHER_ROW, jira_connection: { ...CONNECTION, id: "jrc_7" } }]],
  });

  await store.forRun("org_3", "jrb_9");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, "select");
  assert.equal(calls[0]?.from, jiraBoard);
  const joins = calls[0]?.joins ?? [];
  assert.equal(joins.length, 1);
  assert.equal(joins[0]?.kind, "inner");
  assert.equal(joins[0]?.table, jiraSchema.jiraConnection);
  assert.equal(
    render([joins[0]?.on]).sql,
    '"jira_board"."connection_id" = "jira_connection"."id"',
  );
  const where = render(calls[0]?.wheres ?? []);
  assert.ok(where.params.includes("org_3"), where.sql);
  assert.ok(where.params.includes("jrb_9"), where.sql);
  assert.match(where.sql, /"jira_(board|connection)"\."organization_id"/);
  assert.match(where.sql, /"jira_board"\."id"/);
  assert.doesNotMatch(where.sql, /\bor\b/i);
});

// Extends "[happy-8] forRun returns what a run needs": a full connection row,
// tokens included, still yields only the four keys.
test("[happy-8] forRun picks only id, cloudId and siteUrl from a joined connection row that carries tokens", async () => {
  const connection = {
    id: "jrc_7",
    organizationId: "org_3",
    cloudId: "cloud-77",
    siteUrl: "https://beta.atlassian.net",
    siteName: "Beta",
    kind: "oauth",
    accessTokenEnc: "v1:access-secret",
    refreshTokenEnc: "v1:refresh-secret",
    keyId: "key-1",
    expiresAt: new Date("2026-11-01T00:00:00.000Z"),
    scopes: "read:jira-work write:jira-work offline_access",
    email: "owner@beta.test",
    healthy: true,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
  const { store } = createBoardDb({
    select: [[{ jira_board: OTHER_ROW, jira_connection: connection }]],
  });

  const result = await store.forRun("org_3", "jrb_9");

  assert.deepEqual(result, {
    board: OTHER_SUMMARY,
    connectionId: "jrc_7",
    cloudId: "cloud-77",
    siteUrl: "https://beta.atlassian.net",
  });
  assert.deepEqual(sortedKeys(result), [
    "board",
    "cloudId",
    "connectionId",
    "siteUrl",
  ]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("secret"));
  assert.ok(!serialized.includes("key-1"));
  assert.ok(!serialized.includes("owner@beta.test"));
});

test("[happy-8] forRun's connectionId comes from the joined connection row", async () => {
  const { store } = createBoardDb({
    select: [
      [
        {
          jira_board: boardRow({ connectionId: "jrc_board_side" }),
          jira_connection: { ...CONNECTION, id: "jrc_join_side" },
        },
      ],
    ],
  });

  const result = await store.forRun("org_1", "jrb_1");

  assert.equal(result?.connectionId, "jrc_join_side");
});

test("[happy-8] forRun returns the board when its connection is unhealthy", async () => {
  const { store } = createBoardDb({
    select: [
      [
        {
          jira_board: boardRow(),
          jira_connection: { ...CONNECTION, healthy: false },
        },
      ],
    ],
  });

  const result = await store.forRun("org_1", "jrb_1");

  assert.deepEqual(result?.board, summaryOf(boardRow()));
  assert.equal(result?.cloudId, "cloud-1");
  assert.equal(result?.siteUrl, "https://acme.atlassian.net");
});

// Extends "[boundary-11] forRun returns the stored selection as get does".
test("[boundary-11] forRun returns a selection with unknown keys, nulls and invalid values as stored", async () => {
  const stored = {
    maxTickets: 0,
    excludeAssigned: false,
    maxAgeDays: null,
    minAgeDays: 30,
    issueTypes: ["Bug", "Bug", ""],
    colour: "red",
  };
  const { store } = createBoardDb({
    select: [
      [
        {
          jira_board: boardRow({ selection: stored, projectKey: null }),
          jira_connection: CONNECTION,
        },
      ],
    ],
  });

  const result = await store.forRun("org_1", "jrb_1");

  assert.deepEqual(result?.board.selection, stored);
  assert.equal(result?.board.projectKey, null);
});

// Extends "[unhappy-6] forRun for a board the caller does not own is null".
test("[unhappy-6] forRun for another organization's board is null from one select naming that organization and board", async () => {
  const { store, calls } = createBoardDb({ select: [[]] });

  const result = await store.forRun("org_2", "jrb_1");

  assert.equal(result, null);
  assert.equal(calls.length, 1);
  const where = render(calls[0]?.wheres ?? []);
  assert.ok(where.params.includes("org_2"), where.sql);
  assert.ok(where.params.includes("jrb_1"), where.sql);
});

test("[unhappy-6] forRun for a board id that does not exist is null", async () => {
  const { store } = createBoardDb({ select: [[]] });

  assert.equal(await store.forRun("org_1", "jrb_missing"), null);
});
