import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";

import { authSchema } from "../../src/auth-schema.js";
import * as root from "../../src/index.js";
import * as barrel from "../../src/schema.js";
import * as auth from "../../src/schema/auth.js";
import * as organizations from "../../src/schema/organizations.js";
import * as todosModule from "../../src/schema/todos.js";

const dialect = new PgDialect();

const MODULES: Array<{
  label: string;
  module: Record<string, unknown>;
  tables: Record<string, string>;
}> = [
  {
    label: "auth",
    module: auth,
    tables: {
      user: "user",
      userEmail: "user_email",
      session: "session",
      account: "account",
      verification: "verification",
    },
  },
  {
    label: "organizations",
    module: organizations,
    tables: { organization: "organization", member: "member", invitation: "invitation" },
  },
  { label: "todos", module: todosModule, tables: { todos: "todos" } },
];

const ALL_NAMES = [
  "account",
  "invitation",
  "member",
  "organization",
  "session",
  "todos",
  "user",
  "userEmail",
  "verification",
];

function foreignKeyOn(table: PgTable, column: string) {
  const matches = getTableConfig(table).foreignKeys.filter((fk) => {
    const columns = fk.reference().columns;
    return columns.length === 1 && columns[0]?.name === column;
  });
  assert.equal(matches.length, 1, `exactly one foreign key on ${column}`);
  return matches[0]!;
}

function columnOf(table: PgTable, name: string) {
  const column = getTableConfig(table).columns.find(
    (candidate) => candidate.name === name,
  );
  assert.notEqual(column, undefined, `${name} should exist`);
  return column!;
}

function render(chunk: unknown): string {
  if (chunk instanceof SQL) {
    return dialect.sqlToQuery(chunk).sql;
  }
  return (chunk as { name: string }).name;
}

// ---- module exports ---------------------------------------------------------

// Extends "[happy-9] the cycling modules do not re-export each other's tables":
// no module carries any table that belongs to another module.
test("[happy-9] hidden: no module carries a table name that belongs to another module", () => {
  for (const { label, module, tables } of MODULES) {
    for (const name of ALL_NAMES) {
      assert.equal(name in module, name in tables, `${label}.${name}`);
    }
    assert.equal("default" in module, false, label);
  }
});

// Extends "[happy-9] each schema module's runtime exports are exactly its tables":
// each export is the table with the expected Postgres name.
test("[happy-9] hidden: each module's exports are tables with their expected Postgres names", () => {
  for (const { label, module, tables } of MODULES) {
    assert.deepEqual(Object.keys(module).sort(), Object.keys(tables).sort(), label);
    for (const [name, pgName] of Object.entries(tables)) {
      assert.equal(getTableConfig(module[name] as PgTable).name, pgName, `${label}.${name}`);
    }
  }
});

// Extends "[happy-10] each table keeps its Postgres table name": read through
// the barrel and the package root as well as the module.
test("[happy-10] hidden: the table names read the same through the barrel and the package root", () => {
  const fromBarrel = barrel as unknown as Record<string, PgTable>;
  const fromRoot = root as unknown as Record<string, PgTable>;
  for (const { tables } of MODULES) {
    for (const [name, pgName] of Object.entries(tables)) {
      assert.equal(getTableConfig(fromBarrel[name]!).name, pgName, name);
      assert.equal(getTableConfig(fromRoot[name]!).name, pgName, name);
    }
  }
});

// ---- the barrel -------------------------------------------------------------

// Extends "[happy-11] the barrel's runtime exports are the nine tables":
// nine distinct objects, none of them mapping helpers.
test("[happy-11] hidden: the barrel exports nine distinct table objects and nothing from mapping", () => {
  const keys = Object.keys(barrel);
  assert.equal(keys.length, 9);
  assert.deepEqual([...keys].sort(), ALL_NAMES);
  const values = new Set(Object.values(barrel));
  assert.equal(values.size, 9);
  for (const name of ["generateId", "ID_PREFIXES", "newTodoRow", "rowToTodo", "authSchema"]) {
    assert.equal(name in barrel, false, name);
  }
});

// Extends "[happy-12] the package root's tables are the identical objects from their modules":
// barrel, root and module all agree, and authSchema's entries are those objects.
test("[happy-12] hidden: barrel, root and module values are the same object for every table", () => {
  const fromBarrel = barrel as unknown as Record<string, unknown>;
  const fromRoot = root as unknown as Record<string, unknown>;
  for (const { label, module, tables } of MODULES) {
    for (const name of Object.keys(tables)) {
      assert.equal(fromBarrel[name], module[name], `${label}.${name}`);
      assert.equal(fromRoot[name], fromBarrel[name], `${label}.${name}`);
    }
  }
});

// Extends "[happy-13] authSchema still holds the barrel's tables and not todos or userEmail".
test("[happy-13] hidden: authSchema's user and organization are the barrel's and the root's objects", () => {
  assert.equal(authSchema.user, barrel.user);
  assert.equal(authSchema.organization, barrel.organization);
  assert.equal(root.authSchema, authSchema);
  assert.equal(root.authSchema.user, auth.user);
  assert.equal(root.authSchema.organization, organizations.organization);
  assert.equal("todos" in root.authSchema, false);
  assert.equal("userEmail" in root.authSchema, false);
});

// ---- foreign keys -----------------------------------------------------------

const FOREIGN_KEYS: Array<[string, string, string, string]> = [
  ["todos", "user_id", "user", "cascade"],
  ["userEmail", "user_id", "user", "cascade"],
  ["session", "user_id", "user", "cascade"],
  ["session", "active_organization_id", "organization", "set null"],
  ["account", "user_id", "user", "cascade"],
  ["member", "organization_id", "organization", "cascade"],
  ["member", "user_id", "user", "cascade"],
  ["invitation", "organization_id", "organization", "cascade"],
  ["invitation", "inviter_id", "user", "cascade"],
];

// Extends "[happy-14] every foreign key points at the right table with the right action":
// tables read through the barrel, and the referenced column is the target's own id column.
test("[happy-14] hidden: foreign keys read through the barrel reference the target's own id column", () => {
  const fromBarrel = barrel as unknown as Record<string, PgTable>;
  const targets: Record<string, PgTable> = {
    user: auth.user,
    organization: organizations.organization,
  };
  for (const [from, column, target, onDelete] of FOREIGN_KEYS) {
    const fk = foreignKeyOn(fromBarrel[from]!, column);
    const reference = fk.reference();
    assert.equal(reference.foreignTable, targets[target], `${from}.${column}`);
    assert.equal(reference.foreignColumns.length, 1);
    assert.equal(reference.foreignColumns[0], columnOf(targets[target]!, "id"));
    assert.equal(fk.onDelete, onDelete, `${from}.${column}`);
  }
});

test("[happy-14] hidden: each referencing table has exactly the foreign keys listed for it", () => {
  const fromBarrel = barrel as unknown as Record<string, PgTable>;
  const expected: Record<string, string[]> = {};
  for (const [from, column] of FOREIGN_KEYS) {
    (expected[from] ??= []).push(column);
  }
  for (const [from, columns] of Object.entries(expected)) {
    const actual = getTableConfig(fromBarrel[from]!).foreignKeys.map(
      (fk) => fk.reference().columns.map((c) => c.name).join(","),
    );
    assert.deepEqual(actual.sort(), [...columns].sort(), from);
  }
});

/**
 * Loads the schema in a fresh module graph (a worker thread has its own module
 * cache), importing `first` before anything else, and reports every
 * cross-table foreign key there.
 */
function resolveInFreshGraph(first: string): Promise<{
  fks: Array<[string, string, string, string, boolean]>;
}> {
  const url = (path: string) => new URL(path, import.meta.url).href;
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      await import(workerData.first);
      const auth = await import(workerData.auth);
      const organizations = await import(workerData.organizations);
      const todos = await import(workerData.todos);
      const { getTableConfig } = await import(workerData.pgCore);
      const tables = { ...auth, ...organizations, ...todos };
      const targets = { user: auth.user, organization: organizations.organization };
      const fks = [];
      for (const [name, table] of Object.entries(tables)) {
        for (const fk of getTableConfig(table).foreignKeys) {
          const ref = fk.reference();
          const targetName = getTableConfig(ref.foreignTable).name;
          fks.push([
            name,
            ref.columns[0].name,
            targetName,
            fk.onDelete,
            ref.foreignTable === targets[targetName],
          ]);
        }
      }
      parentPort.postMessage({ fks });
    })().catch((error) => {
      parentPort.postMessage({ error: String((error && error.stack) || error) });
    });
  `;
  const paths: Record<string, string> = {
    auth: url("../../src/schema/auth.js"),
    organizations: url("../../src/schema/organizations.js"),
    todos: url("../../src/schema/todos.js"),
    barrel: url("../../src/schema.js"),
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: {
        first: paths[first],
        auth: paths.auth,
        organizations: paths.organizations,
        todos: paths.todos,
        pgCore: import.meta.resolve("drizzle-orm/pg-core"),
      },
    });
    worker.once("message", (message: { error?: string }) => {
      void worker.terminate();
      if (message.error !== undefined) {
        reject(new Error(message.error));
      } else {
        resolve(message as never);
      }
    });
    worker.once("error", reject);
  });
}

const EXPECTED_FRESH = FOREIGN_KEYS.map(([from, column, target, onDelete]) =>
  [from, column, target, onDelete, true].join("|"),
).sort();

// Extends "[boundary-5] with organizations.js loaded first, the cross-module foreign keys resolve":
// all nine foreign keys, not only the two that cross the cycle.
test("[boundary-5] hidden: with organizations.js loaded first, all nine foreign keys resolve to the live tables", async () => {
  const { fks } = await resolveInFreshGraph("organizations");
  assert.deepEqual(fks.map((fk) => fk.join("|")).sort(), EXPECTED_FRESH);
});

// Extends "[boundary-5] with auth.js loaded first, the cross-module foreign keys resolve".
test("[boundary-5] hidden: with auth.js loaded first, all nine foreign keys resolve to the live tables", async () => {
  const { fks } = await resolveInFreshGraph("auth");
  assert.deepEqual(fks.map((fk) => fk.join("|")).sort(), EXPECTED_FRESH);
});

// Other load orders: the spec says the cycle works whichever module loads first.
test("[boundary-5] hidden: with todos.js loaded first, the cross-module foreign keys resolve", async () => {
  const { fks } = await resolveInFreshGraph("todos");
  assert.deepEqual(fks.map((fk) => fk.join("|")).sort(), EXPECTED_FRESH);
});

test("[boundary-5] hidden: with the schema.js barrel loaded first, the cross-module foreign keys resolve", async () => {
  const { fks } = await resolveInFreshGraph("barrel");
  assert.deepEqual(fks.map((fk) => fk.join("|")).sort(), EXPECTED_FRESH);
});

// Extends "[happy-15] user, verification and organization have no foreign keys":
// read through the barrel and the root.
test("[happy-15] hidden: user, verification and organization have no foreign keys through barrel and root", () => {
  for (const table of [
    barrel.user,
    barrel.verification,
    barrel.organization,
    root.user,
    root.verification,
    root.organization,
  ]) {
    assert.equal(getTableConfig(table).foreignKeys.length, 0);
  }
});

// ---- indexes, constraints and defaults --------------------------------------

// Extends "[happy-16] each named index or unique constraint is still on its table":
// the expression columns are checked for their function and direction.
test("[happy-16] hidden: todos' index is user_id then created_at descending", () => {
  const index = getTableConfig(barrel.todos).indexes.find(
    (candidate) => candidate.config.name === "todos_user_id_created_at_idx",
  );
  assert.notEqual(index, undefined);
  const columns = index!.config.columns.map(render);
  assert.equal(columns.length, 2);
  assert.equal(columns[0], "user_id");
  assert.match(columns[1]!, /"created_at" desc$/);
  assert.equal(index!.config.unique, false);
});

test("[happy-16] hidden: the lower(email) unique indexes are on lower of the email column", () => {
  for (const [table, name] of [
    [barrel.user, "user_email_lower_unique"],
    [barrel.userEmail, "user_email_email_lower_unique"],
  ] as const) {
    const index = getTableConfig(table).indexes.find(
      (candidate) => candidate.config.name === name,
    );
    assert.notEqual(index, undefined, name);
    assert.equal(index!.config.unique, true, name);
    const columns = index!.config.columns.map(render);
    assert.equal(columns.length, 1, name);
    assert.match(columns[0]!, /^lower\(.*"email"\)$/, name);
  }
});

test("[happy-16] hidden: user_email_one_primary is unique on user_id where is_primary", () => {
  const index = getTableConfig(barrel.userEmail).indexes.find(
    (candidate) => candidate.config.name === "user_email_one_primary",
  );
  assert.notEqual(index, undefined);
  assert.equal(index!.config.unique, true);
  assert.deepEqual(index!.config.columns.map(render), ["user_id"]);
  assert.match(render(index!.config.where), /"is_primary"$/);
});

test("[happy-16] hidden: the named unique constraints and plain indexes read through the barrel", () => {
  const uniques: Array<[PgTable, string, string[]]> = [
    [barrel.account, "account_provider_identity_unique", ["provider_id", "account_id"]],
    [barrel.member, "member_organization_user_unique", ["organization_id", "user_id"]],
  ];
  for (const [table, name, columns] of uniques) {
    const config = getTableConfig(table);
    const found =
      config.uniqueConstraints.find((c) => c.name === name)?.columns.map((c) => c.name) ??
      config.indexes
        .find((i) => i.config.name === name && i.config.unique)
        ?.config.columns.map(render);
    assert.deepEqual(found, columns, name);
  }
  const plain: Array<[PgTable, string, string[]]> = [
    [barrel.member, "member_user_id_idx", ["user_id"]],
    [barrel.invitation, "invitation_email_status_idx", ["email", "status"]],
    [barrel.invitation, "invitation_organization_id_idx", ["organization_id"]],
  ];
  for (const [table, name, columns] of plain) {
    const index = getTableConfig(table).indexes.find((i) => i.config.name === name);
    assert.notEqual(index, undefined, name);
    assert.equal(index!.config.unique, false, name);
    assert.deepEqual(index!.config.columns.map(render), columns, name);
  }
});

// Extends "[boundary-6] column-level defaults survive the move": read through
// the barrel, and the defaultNow timestamps on every table too.
test("[boundary-6] hidden: the literal defaults read the same through the barrel", () => {
  const expected: Array<[PgTable, string, unknown]> = [
    [barrel.todos, "done", false],
    [barrel.userEmail, "is_primary", false],
    [barrel.user, "email_verified", false],
    [barrel.member, "role", "member"],
    [barrel.invitation, "role", "member"],
    [barrel.invitation, "status", "pending"],
  ];
  for (const [table, name, value] of expected) {
    const column = columnOf(table, name);
    assert.equal(column.hasDefault, true, name);
    assert.equal(column.default, value, name);
  }
});

test("[boundary-6] hidden: every table's created_at keeps its now() default", () => {
  const fromBarrel = barrel as unknown as Record<string, PgTable>;
  for (const name of ALL_NAMES) {
    const column = columnOf(fromBarrel[name]!, "created_at");
    assert.equal(column.hasDefault, true, name);
    assert.equal(column.default instanceof SQL, true, name);
    assert.match(render(column.default), /^now\(\)$/, name);
  }
});
