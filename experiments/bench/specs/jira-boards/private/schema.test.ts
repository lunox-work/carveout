/**
 * The `jira_board` table, read from `schema/jira.ts` where the spec declares
 * it, and through the `schema.ts` barrel that re-exports it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import * as schema from "../../src/schema.js";
import * as jiraSchema from "../../src/schema/jira.js";
import * as organizationSchema from "../../src/schema/organizations.js";

/** `jiraBoard` as `schema/jira.ts` exports it; fails when it does not. */
function moduleBoardTable(): PgTable {
  const table = (jiraSchema as Record<string, unknown>)["jiraBoard"];
  assert.notEqual(table, undefined, "schema/jira.ts does not export jiraBoard");
  return table as PgTable;
}

function column(table: PgTable, name: string): PgColumn | undefined {
  return getTableConfig(table).columns.find((candidate) => candidate.name === name);
}

// Extends "[happy-9] the barrel exports the table": the name is read from the
// module's table, and every export of the module reaches the barrel.
test("[happy-9] schema/jira.ts declares jira_board and the barrel re-exports both of its tables unchanged", () => {
  const table = moduleBoardTable();

  assert.equal(getTableConfig(table).name, "jira_board");
  assert.equal(schema.jiraBoard, table);
  for (const [name, value] of Object.entries(jiraSchema)) {
    assert.equal(
      (schema as Record<string, unknown>)[name],
      value,
      `schema.ts does not re-export ${name}`,
    );
  }
  assert.ok("jiraConnection" in jiraSchema);
});

const PROPERTIES: ReadonlyArray<readonly [string, string, string]> = [
  ["id", "id", "text"],
  ["organizationId", "organization_id", "text"],
  ["connectionId", "connection_id", "text"],
  ["externalId", "external_id", "text"],
  ["name", "name", "text"],
  ["boardType", "board_type", "text"],
  ["projectKey", "project_key", "text"],
  ["selection", "selection", "jsonb"],
  ["writebackEnabled", "writeback_enabled", "boolean"],
  ["createdAt", "created_at", "timestamp with time zone"],
  ["updatedAt", "updated_at", "timestamp with time zone"],
];

// Extends "[happy-10] columns, nullability and defaults": the property each
// column is reached by, and its SQL type.
test("[happy-10] each jira_board property maps to its column with the spec's SQL type", () => {
  const table = moduleBoardTable() as unknown as Record<string, PgColumn>;

  for (const [property, name, type] of PROPERTIES) {
    const col = table[property];
    assert.ok(col, `jiraBoard has no ${property} property`);
    assert.equal(col.name, name, `${property} column name`);
    assert.equal(col.getSQLType(), type, `${name} type`);
  }
});

// Extends "[happy-10] columns, nullability and defaults": read from the module.
test("[happy-10] the module's jira_board has the spec's keys, nullability and defaults", () => {
  const table = moduleBoardTable();
  const { columns } = getTableConfig(table);

  assert.deepEqual(
    columns.map((col) => col.name).sort(),
    PROPERTIES.map(([, name]) => name).sort(),
  );
  assert.equal(column(table, "id")?.primary, true);
  for (const [, name] of PROPERTIES) {
    assert.equal(column(table, name)?.notNull, name !== "project_key", `${name} notNull`);
  }
  for (const name of [
    "id",
    "organization_id",
    "connection_id",
    "external_id",
    "name",
    "board_type",
    "project_key",
  ]) {
    assert.equal(column(table, name)?.hasDefault, false, `${name} has a default`);
  }
  assert.equal(column(table, "selection")?.hasDefault, true);
  assert.deepEqual(column(table, "selection")?.default, {});
  assert.equal(column(table, "writeback_enabled")?.hasDefault, true);
  assert.equal(column(table, "writeback_enabled")?.default, false);
  assert.equal(column(table, "created_at")?.hasDefault, true);
  assert.equal(column(table, "updated_at")?.hasDefault, true);
});

// Extends "[happy-11] both owners cascade": the referenced columns too.
test("[happy-11] the module's jira_board cascades from organization.id and jira_connection.id", () => {
  const keys = getTableConfig(moduleBoardTable()).foreignKeys.map((key) => ({
    onDelete: key.onDelete,
    reference: key.reference(),
  }));

  const toOrganization = keys.find(
    ({ reference }) => reference.foreignTable === organizationSchema.organization,
  );
  assert.ok(toOrganization, "jira_board does not reference organization");
  assert.equal(toOrganization.onDelete, "cascade");
  assert.deepEqual(
    toOrganization.reference.columns.map((col) => col.name),
    ["organization_id"],
  );
  assert.deepEqual(
    toOrganization.reference.foreignColumns.map((col) => col.name),
    ["id"],
  );

  const toConnection = keys.find(
    ({ reference }) => reference.foreignTable === jiraSchema.jiraConnection,
  );
  assert.ok(toConnection, "jira_board does not reference jira_connection");
  assert.equal(toConnection.onDelete, "cascade");
  assert.deepEqual(
    toConnection.reference.columns.map((col) => col.name),
    ["connection_id"],
  );
  assert.deepEqual(
    toConnection.reference.foreignColumns.map((col) => col.name),
    ["id"],
  );
});

// Extends "[happy-12] one row per Jira board per connection, indexed for its
// owner": read from the module, and no uniqueness per organization.
test("[happy-12] the module's jira_board is unique on exactly (connection_id, external_id) and indexed on organization_id", () => {
  const config = getTableConfig(moduleBoardTable());

  const constraint = config.uniqueConstraints.find(
    (candidate) => candidate.name === "jira_board_connection_external_unique",
  );
  assert.ok(constraint, "missing jira_board_connection_external_unique");
  assert.deepEqual(
    constraint.columns.map((col) => col.name),
    ["connection_id", "external_id"],
  );
  for (const unique of config.uniqueConstraints) {
    assert.ok(
      !unique.columns.some((col) => col.name === "organization_id"),
      `${unique.name ?? "a unique constraint"} includes organization_id`,
    );
  }

  const index = config.indexes.find(
    (candidate) => candidate.config.name === "jira_board_organization_id_idx",
  );
  assert.ok(index, "missing jira_board_organization_id_idx");
  assert.deepEqual(
    index.config.columns.map((col) => ("name" in col ? col.name : undefined)),
    ["organization_id"],
  );
});
