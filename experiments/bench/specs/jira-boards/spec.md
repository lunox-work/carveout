# Jira board store: register boards and the selection a run reads them by

Ticket #33 lets an organization register boards from its Jira connections, and
store for each board the *selection* a run uses to choose its oldest backlog
tickets. This spec covers the storage half in `packages/db`. That means a new
`jira_board` table, and a new `JiraBoardStore` in `packages/db/src/jira-boards.ts`
that follows `createJiraConnectionStore`. Every method takes the organization id
first and puts it in the `WHERE` clause. Another organization's board is a miss
(`null` / `false`), never an error that confirms the id exists. The store does
not query Jira. `forRun` gives the runner what it needs to do that: the board,
its selection, and the connection's `cloudId` and `siteUrl`.

## Exports

### `packages/db/src/jira-boards.ts` (new)

These come from the ticket's interface without change:

```ts
export interface StoredBoardSelection {
  readonly maxTickets?: number;
  readonly excludeAssigned?: boolean;
  readonly issueTypes?: readonly string[];
  readonly minAgeDays?: number;
  readonly maxAgeDays?: number | null;
  readonly minSpecChars?: number;
}

export interface JiraBoardSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly externalId: string;
  readonly name: string;
  readonly boardType: string;
  readonly projectKey: string | null;
  readonly selection: StoredBoardSelection;
  readonly writebackEnabled: boolean;
  readonly createdAt: string;
}

export interface RegisterBoardInput {
  readonly connectionId: string;
  readonly externalId: string;
  readonly name: string;
  readonly boardType: string;
  readonly projectKey?: string | null;
  readonly selection?: StoredBoardSelection;
}

export interface UpdateBoardInput {
  readonly selection?: StoredBoardSelection;
  readonly writebackEnabled?: boolean;
}

export interface JiraBoardStore {
  list(organizationId: string): Promise<JiraBoardSummary[]>;
  get(organizationId: string, boardId: string): Promise<JiraBoardSummary | null>;
  register(organizationId: string, input: RegisterBoardInput): Promise<JiraBoardSummary>;
  update(organizationId: string, boardId: string, input: UpdateBoardInput): Promise<JiraBoardSummary | null>;
  remove(organizationId: string, boardId: string): Promise<boolean>;
  forRun(organizationId: string, boardId: string): Promise<{
    board: JiraBoardSummary;
    connectionId: string;
    cloudId: string;
    siteUrl: string;
  } | null>;
}

export function createJiraBoardStore(db: Database): JiraBoardStore;
```

`Database` is the type from `./store.js`. The file adds no other exports: no
error classes, constants or validation function. The store does not validate a
selection; that is done at the HTTP edge.

### `packages/db/src/schema/jira.ts` and `packages/db/src/schema.ts`

The new table is declared in `schema/jira.ts`, beside `jiraConnection`.
`schema.ts` stays a barrel and re-exports it:

```ts
export { jiraBoard, jiraConnection } from "./schema/jira.js";
export type {
  JiraBoardRow,        // typeof jiraBoard.$inferSelect
  JiraConnectionRow,
  NewJiraBoardRow,     // typeof jiraBoard.$inferInsert
  NewJiraConnectionRow,
} from "./schema/jira.js";
```

`jiraBoard` is `pgTable("jira_board", …)` with these columns:

| property           | column              | type                                  | null     | default    | reference                                   |
| ------------------ | ------------------- | ------------------------------------- | -------- | ---------- | ------------------------------------------- |
| `id`               | `id`                | text, primary key                     | not null |            |                                             |
| `organizationId`   | `organization_id`   | text                                  | not null |            | `organization.id`, `onDelete: "cascade"`    |
| `connectionId`     | `connection_id`     | text                                  | not null |            | `jira_connection.id`, `onDelete: "cascade"` |
| `externalId`       | `external_id`       | text                                  | not null |            |                                             |
| `name`             | `name`              | text                                  | not null |            |                                             |
| `boardType`        | `board_type`        | text                                  | not null |            |                                             |
| `projectKey`       | `project_key`       | text                                  | nullable |            |                                             |
| `selection`        | `selection`         | jsonb                                 | not null | `{}`       |                                             |
| `writebackEnabled` | `writeback_enabled` | boolean                               | not null | `false`    |                                             |
| `createdAt`        | `created_at`        | timestamptz                           | not null | now        |                                             |
| `updatedAt`        | `updated_at`        | timestamptz                           | not null | now        |                                             |

The table also has:

- the unique constraint `jira_board_connection_external_unique` on
  `(connection_id, external_id)`
- the index `jira_board_organization_id_idx` on `(organization_id)`

`schema/jira.ts` does not import from `../jira-boards.js`; the store casts the
`selection` column to `StoredBoardSelection` when it reads it. The SQL
migration comes from `npm run db:generate`, and this spec does not test it.

`packages/db/src/index.ts` re-exports `createJiraBoardStore` and the types
`JiraBoardStore`, `JiraBoardSummary`, `RegisterBoardInput`,
`StoredBoardSelection` and `UpdateBoardInput`. That file is outside the coverage
gate and is not tested here.

### Unchanged

These keep their current behaviour:

- every export of `jira-connections.ts`
- `jiraConnection`, `JiraConnectionRow` and `NewJiraConnectionRow`
- every other table and row type in `schema.ts`
- `generateId` and `ID_PREFIXES`, which already contain `"jrb"`

### Rows the store reads (for the database fake)

- `list`, `get` and `remove` make one call that resolves to `JiraBoardRow[]`.
- `register` makes one call: an `insert … values … onConflictDoUpdate … returning()`
  that resolves to `JiraBoardRow[]`. It does not read `jira_connection`.
- `update` makes up to two calls: an owner-scoped `select` on `jira_board`, then,
  if a row came back, an `update … set … where … returning()`. Both resolve to
  `JiraBoardRow[]`.
- `forRun` issues one `select()` `.from(jiraBoard).innerJoin(jiraConnection, eq(jiraBoard.connectionId, jiraConnection.id))`
  with a `where`. It resolves to `{ jira_board: JiraBoardRow; jira_connection: { id: string; cloudId: string; siteUrl: string } }[]`.

```gherkin
Feature: Jira board store

  Background:
    Given a board row "B1":
      | field            | value                                           |
      | id               | jrb_1                                           |
      | organizationId   | org_1                                           |
      | connectionId     | jrc_1                                           |
      | externalId       | 42                                              |
      | name             | Platform                                        |
      | boardType        | scrum                                           |
      | projectKey       | PLAT                                            |
      | selection        | {"maxTickets":5,"issueTypes":["Bug"]}           |
      | writebackEnabled | false                                           |
      | createdAt        | 2026-10-01T00:00:00.000Z                        |
      | updatedAt        | 2026-10-01T00:00:00.000Z                        |
    And a store made by createJiraBoardStore over a database fake that resolves each query, in call order, to the rows given in each scenario and records each call's kind, values, conflict settings and whether a where was applied

  Rule: A summary is the row mapped field by field, with createdAt as an ISO string and no organizationId or updatedAt

    @happy
    Scenario: get maps a stored row to a summary
      Given the database holds row "B1"
      When get("org_1", "jrb_1") is called
      Then it resolves to:
        | field            | value                                 |
        | id               | jrb_1                                 |
        | connectionId     | jrc_1                                 |
        | externalId       | 42                                    |
        | name             | Platform                              |
        | boardType        | scrum                                 |
        | projectKey       | PLAT                                  |
        | selection        | {"maxTickets":5,"issueTypes":["Bug"]} |
        | writebackEnabled | false                                 |
        | createdAt        | 2026-10-01T00:00:00.000Z              |
      And the summary has exactly these nine keys

    @boundary
    Scenario: a null project key stays null
      Given the database holds row "B1" with projectKey null
      When get("org_1", "jrb_1") is called
      Then the summary's projectKey is null

  Rule: A stored selection is read as stored, without checking or dropping keys; only a null selection reads as {}

    @boundary
    Scenario Outline: the selection column is returned as stored
      Given the database holds row "B1" with selection <stored>
      When get("org_1", "jrb_1") is called
      Then the summary's selection deep-equals <read>

      Examples:
        | stored                                                   | read                                                     |
        | {}                                                       | {}                                                       |
        | null                                                     | {}                                                       |
        | {"maxTickets":5,"colour":"red"}                          | {"maxTickets":5,"colour":"red"}                          |
        | {"maxTickets":101}                                       | {"maxTickets":101}                                       |
        | {"minAgeDays":1.5,"minSpecChars":200}                    | {"minAgeDays":1.5,"minSpecChars":200}                    |
        | {"maxAgeDays":null}                                      | {"maxAgeDays":null}                                      |
        | {"issueTypes":["Bug",""]}                                | {"issueTypes":["Bug",""]}                                |
        | {"minAgeDays":30,"maxAgeDays":7}                         | {"minAgeDays":30,"maxAgeDays":7}                         |

  Rule: list returns the organization's boards in the order the database returns them, from one owner-scoped select ordered by createdAt descending

    @happy
    Scenario: list is owner-scoped and ordered by the query
      Given the database returns, in this order:
        | id    | createdAt                |
        | jrb_c | 2026-10-03T00:00:00.000Z |
        | jrb_b | 2026-10-02T00:00:00.000Z |
        | jrb_a | 2026-10-01T00:00:00.000Z |
      When list("org_1") is called
      Then the summary ids are, in order: jrb_c, jrb_b, jrb_a
      And exactly one call was made, a select with a where and an orderBy applied

    @boundary
    Scenario: the store does not re-sort what the database returns
      Given the database returns, in this order:
        | id    | createdAt                |
        | jrb_a | 2026-10-01T00:00:00.000Z |
        | jrb_c | 2026-10-03T00:00:00.000Z |
      When list("org_1") is called
      Then the summary ids are, in order: jrb_a, jrb_c

    @boundary
    Scenario: an organization with no boards lists none
      Given the database returns no rows
      When list("org_1") is called
      Then it resolves to []

  Rule: get filters on both the organization and the board id; a miss, including another organization's board, is null

    @happy
    Scenario: get is owner-scoped
      Given the database holds row "B1"
      When get("org_1", "jrb_1") is called
      Then the first call is a select with a where applied

    @unhappy
    Scenario: another organization's board is null
      Given the database returns no rows
      When get("org_2", "jrb_1") is called
      Then it resolves to null

  Rule: register writes its input as given in one upsert; strings are not trimmed or checked, an absent or null projectKey is stored as null, an absent selection as {}, and write-back is left to the column default (off)

    @happy
    Scenario: register writes a prefixed, owner-scoped row
      Given the upsert returns row "B1"
      When register("org_1", {connectionId: "jrc_1", externalId: "42", name: "Platform", boardType: "scrum", projectKey: "PLAT", selection: {maxTickets: 5}}) is called
      Then exactly one call was made, an insert
      And its values have:
        | field            | value             |
        | id               | matches ^jrb_     |
        | organizationId   | org_1             |
        | connectionId     | jrc_1             |
        | externalId       | 42                |
        | name             | Platform          |
        | boardType        | scrum             |
        | projectKey       | PLAT              |
        | selection        | {"maxTickets":5}  |
        | updatedAt        | a Date            |
      And its values have no writebackEnabled key
      And it resolves to the summary of row "B1"

    @boundary
    Scenario Outline: inputs are stored as given, with defaults only for absent fields
      Given the upsert returns row "B1"
      When register is called for "org_1" with connectionId "jrc_1", externalId <externalId>, name <name>, boardType <boardType>, projectKey <projectKey> and selection <selection>
      Then the insert values have externalId <externalId>, name <name>, boardType <boardType>, projectKey <storedKey> and selection <storedSelection>

      Examples:
        | externalId | name         | boardType | projectKey | selection           | storedKey | storedSelection     |
        | "42"       | "Platform"   | "kanban"  | (absent)   | (absent)            | null      | {}                  |
        | "42"       | "Platform"   | "  "      | null       | {}                  | null      | {}                  |
        | " 42 "     | " Platform " | "scrum"   | "  "       | (absent)            | "  "      | {}                  |
        | "42"       | "Platform"   | "scrum"   | " PLAT "   | {"issueTypes":[]}   | " PLAT "  | {"issueTypes":[]}   |
        | ""         | ""           | "scrum"   | "PLAT"     | {"maxTickets":0,"colour":"red"} | "PLAT" | {"maxTickets":0,"colour":"red"} |

  Rule: register does not check that the connection belongs to the organization; it makes no read of jira_connection and writes the row

    @boundary
    Scenario: another organization's connection is not looked up
      Given the upsert returns row "B1" with organizationId "org_2"
      When register("org_2", {connectionId: "jrc_1", externalId: "42", name: "Platform", boardType: "scrum"}) is called
      Then exactly one call was made, an insert whose values have organizationId "org_2" and connectionId "jrc_1"
      And it resolves to a summary with id "jrb_1"

  Rule: registering the same Jira board on the same connection again updates the existing row in place (conflict on connection_id, external_id); organizationId, connectionId, externalId, name, boardType, projectKey, selection and updatedAt are overwritten, writebackEnabled, id and createdAt never

    @happy
    Scenario: re-registering refreshes Jira's details and keeps the board's id
      Given the upsert returns row "B1" with name "Platform v2"
      When register("org_1", {connectionId: "jrc_1", externalId: "42", name: "Platform v2", boardType: "scrum"}) is called
      Then the insert targets a conflict on (connectionId, externalId)
      And the conflict update sets organizationId "org_1", connectionId "jrc_1", externalId "42", name "Platform v2", boardType "scrum", projectKey null, selection {} and updatedAt to a Date
      And the conflict update sets neither writebackEnabled, id nor createdAt
      And it resolves to a summary with id "jrb_1" and name "Platform v2"

    @boundary
    Scenario: a re-registration that gives a selection replaces it
      When register("org_1", {connectionId: "jrc_1", externalId: "42", name: "Platform", boardType: "scrum", selection: {minAgeDays: 30}}) is called against an existing board
      Then the conflict update sets selection {"minAgeDays":30}

    @boundary
    Scenario: a re-registration without a selection resets it to {}
      When register("org_1", {connectionId: "jrc_1", externalId: "42", name: "Platform", boardType: "scrum"}) is called against an existing board
      Then the conflict update sets selection {}

  Rule: register fails loudly when the upsert returns no row, and passes database errors through unchanged

    @unhappy
    Scenario: an upsert that returns no row rejects
      Given the upsert returns no rows
      When register("org_1", {connectionId: "jrc_1", externalId: "42", name: "Platform", boardType: "scrum"}) is called
      Then it rejects with an Error whose message is "Failed to register the Jira board."

    @unhappy
    Scenario: a database error is passed through
      Given the insert rejects with an Error "insert or update on table violates foreign key constraint"
      When register("org_1", {connectionId: "jrc_missing", externalId: "42", name: "Platform", boardType: "scrum"}) is called
      Then it rejects with that same Error

  Rule: update reads the board with an owner-scoped select, then issues one owner-scoped UPDATE returning the row; a given selection is merged key by key over the stored one; a miss is null

    @happy
    Scenario: update merges the selection and toggles write-back
      Given the select returns row "B1" and the update returns row "B1" with writebackEnabled true and selection {"maxTickets":5,"issueTypes":["Bug"],"minAgeDays":30}
      When update("org_1", "jrb_1", {selection: {minAgeDays: 30}, writebackEnabled: true}) is called
      Then exactly two calls were made, a select with a where applied and then an update with a where applied
      And the update values have selection {"maxTickets":5,"issueTypes":["Bug"],"minAgeDays":30}, writebackEnabled true and updatedAt a Date
      And it resolves to a summary with writebackEnabled true and selection {"maxTickets":5,"issueTypes":["Bug"],"minAgeDays":30}

    @boundary
    Scenario Outline: selection and updatedAt are always written, writebackEnabled only when given
      Given the select returns row "B1" and the update returns row "B1"
      When update("org_1", "jrb_1", <input>) is called
      Then the update values hold exactly the keys <keys> and selection <selection>

      Examples:
        | input                                          | keys                                   | selection                                         |
        | {writebackEnabled: false}                      | selection, writebackEnabled, updatedAt | {"maxTickets":5,"issueTypes":["Bug"]}             |
        | {selection: {maxTickets: 3}}                   | selection, updatedAt                   | {"maxTickets":3,"issueTypes":["Bug"]}             |
        | {selection: {}}                                | selection, updatedAt                   | {"maxTickets":5,"issueTypes":["Bug"]}             |
        | {selection: {maxAgeDays: null}}                | selection, updatedAt                   | {"maxTickets":5,"issueTypes":["Bug"],"maxAgeDays":null} |
        | {selection: undefined, writebackEnabled: true} | selection, writebackEnabled, updatedAt | {"maxTickets":5,"issueTypes":["Bug"]}             |
        | {}                                             | selection, updatedAt                   | {"maxTickets":5,"issueTypes":["Bug"]}             |

    @boundary
    Scenario: the selection is not validated
      Given the select returns row "B1" and the update returns row "B1"
      When update("org_1", "jrb_1", {selection: {minAgeDays: 30, maxAgeDays: 7}}) is called
      Then the update values have selection {"maxTickets":5,"issueTypes":["Bug"],"minAgeDays":30,"maxAgeDays":7}

    @unhappy
    Scenario Outline: a miss is null and writes nothing
      Given the select returns no rows
      When update("org_2", "jrb_1", <input>) is called
      Then it resolves to null
      And exactly one call was made, a select with a where applied

      Examples:
        | input                     |
        | {writebackEnabled: true}  |
        | {}                        |

  Rule: when the board is removed between update's read and its write, the UPDATE matches no row and update returns null instead of bringing the board back

    @concurrency
    Scenario: update overlapping a remove
      Given the select returns row "B1" and the update returns no rows because a remove of "jrb_1" committed in between
      When update("org_1", "jrb_1", {writebackEnabled: true}) and remove("org_1", "jrb_1") are started together
      Then update resolves to null
      And update made a select and then an update, and no insert

  Rule: overlapping registrations of one Jira board rely on the conflict target, not on a read, so both resolve to the one row the database returns

    @concurrency
    Scenario: two registrations of board 42 at once
      Given the database's upsert returns row "B1" to each statement
      When register("org_1", {connectionId: "jrc_1", externalId: "42", name: "Platform", boardType: "scrum"}) is started twice without awaiting the first
      Then each call made exactly one insert with a conflict target, and no select
      And both resolve to a summary with id "jrb_1"

  Rule: remove deletes with both predicates and reports whether a row went

    @happy
    Scenario: removing an owned board
      Given the database holds row "B1"
      When remove("org_1", "jrb_1") is called
      Then it resolves to true
      And the first call is a delete with a where applied

    @unhappy
    Scenario: removing another organization's board
      Given the database returns no rows
      When remove("org_2", "jrb_1") is called
      Then it resolves to false

  Rule: forRun reads the board and its connection in one owner-scoped query and returns the board summary with the connection's id, cloudId and siteUrl; a miss is null; connection health is not checked here

    @happy
    Scenario: forRun returns what a run needs
      Given the joined query returns [{jira_board: row "B1", jira_connection: {id: "jrc_1", cloudId: "cloud-1", siteUrl: "https://acme.atlassian.net"}}]
      When forRun("org_1", "jrb_1") is called
      Then exactly one call was made, a select with a where applied
      And it resolves to:
        | field        | value                         |
        | board        | the summary of row "B1"       |
        | connectionId | jrc_1                         |
        | cloudId      | cloud-1                       |
        | siteUrl      | https://acme.atlassian.net    |
      And the result carries no token material and no keys other than these four

    @boundary
    Scenario: forRun returns the stored selection as get does
      Given the joined query returns row "B1" with selection {"maxTickets":500,"minAgeDays":14}
      When forRun("org_1", "jrb_1") is called
      Then the board's selection is {"maxTickets":500,"minAgeDays":14}

    @unhappy
    Scenario: forRun for a board the caller does not own is null
      Given the joined query returns no rows
      When forRun("org_2", "jrb_1") is called
      Then it resolves to null

  Rule: the jira_board table is owned by an organization, hangs off a connection, and is unique per Jira board per connection

    @happy
    Scenario: the barrel exports the table
      Then schema.ts exports jiraBoard, and it is the same object schema/jira.ts exports
      And getTableConfig(jiraBoard).name is "jira_board"

    @happy
    Scenario: columns, nullability and defaults
      Then getTableConfig(jiraBoard) has these columns:
        | column            | notNull | default |
        | id                | true    |         |
        | organization_id   | true    |         |
        | connection_id     | true    |         |
        | external_id       | true    |         |
        | name              | true    |         |
        | board_type        | true    |         |
        | project_key       | false   |         |
        | selection         | true    | {}      |
        | writeback_enabled | true    | false   |
        | created_at        | true    | defaultNow() (hasDefault true) |
        | updated_at        | true    | defaultNow() (hasDefault true) |

    @happy
    Scenario: both owners cascade
      Then jiraBoard has a foreign key to organization with onDelete "cascade"
      And jiraBoard has a foreign key to jiraConnection with onDelete "cascade"

    @happy
    Scenario: one row per Jira board per connection, indexed for its owner
      Then jiraBoard has a unique constraint "jira_board_connection_external_unique" on columns connection_id, external_id
      And jiraBoard has an index "jira_board_organization_id_idx" whose first column is organization_id
```

Decided:
- Registering a board against a connection the organization does not own is not checked: the store makes no read of `jira_connection` and inserts the row; only the foreign key on `connection_id` applies.
    Ticket: silent.
    Instead: reject with a not-found error, or return null.
- Registering the same Jira board twice updates it in place on (connection_id, external_id).
    Ticket: silent.
    Instead: reject the second registration as a conflict.
- On re-registration, organizationId, connectionId, externalId, name, boardType, projectKey, selection and updatedAt are overwritten, and an absent selection resets it to `{}`; writeback, id and createdAt are kept.
    Ticket: silent.
    Instead: keep the stored selection when none is given.
- New boards start with write-back off, from the column default; register never writes `writebackEnabled`.
    Ticket: silent.
    Instead: default write-back on when the connection has `write:jira-work`.
- Enabling write-back does not check the connection's scopes in the store.
    Ticket: silent.
    Instead: reject `writebackEnabled: true` when the scopes lack `write:jira-work`.
- `update`'s selection is merged key by key over the stored selection; `{}` or an absent selection leaves it as it was.
    Ticket: silent.
    Instead: replace the stored selection whole.
- An empty update still writes: it reads the board, then sets the unchanged selection and a new updatedAt.
    Ticket: silent.
    Instead: read the board without writing, or reject an empty update as invalid input.
- The store does not validate selection values: no range for `maxTickets`, no integer checks, no `maxAgeDays ≥ minAgeDays` check, no `issueTypes` checks. Validation is left to the HTTP edge.
    Ticket: silent.
    Instead: reject invalid values in the store with a typed error.
- `maxAgeDays: null` is kept as null, distinct from an absent key.
    Ticket: "readonly maxAgeDays?: number | null;"
    Instead: collapse null to absent.
- `issueTypes` is stored as given: an empty list stays `[]`, and entries are not trimmed or de-duplicated.
    Ticket: silent.
    Instead: trim, de-duplicate, and store an empty list as absent.
- Unknown selection keys are kept on write and on read.
    Ticket: silent.
    Instead: drop or reject unknown keys.
- A stored selection is read back as stored, with no checks; only a null selection reads as `{}`.
    Ticket: silent.
    Instead: sanitize it on read, or throw so the bad row is noticed.
- A summary's selection holds only the stored keys and does not fill in defaults.
    Ticket: "readonly selection: StoredBoardSelection;"
    Instead: fill in default values for every key.
- Input strings are stored exactly as given, with no trimming and no rejection of empty values; an absent or null projectKey is stored as null.
    Ticket: silent.
    Instead: trim them, reject an empty externalId or name, and store a blank boardType as "unknown".
- No length cap on name, externalId or boardType.
    Ticket: silent.
    Instead: cap at 255 characters to match Jira's limit.
- The only error the store raises itself is a plain `Error("Failed to register the Jira board.")` when the upsert returns no row; database errors pass through unchanged.
    Ticket: silent.
    Instead: typed errors such as `InvalidJiraBoardError`, or a result union.
- `list` order comes from the query (`createdAt` descending) with no tie-breaker; the store returns rows in the order the database gives them.
    Ticket: silent.
    Instead: sort in the store, newest first with ties broken by id.
- `forRun` returns the board even when its connection is unhealthy.
    Ticket: silent.
    Instead: return null for an unhealthy connection.
- `forRun` is one joined query with the row shape `{ jira_board, jira_connection }`, and its connectionId comes from the joined connection row.
    Ticket: silent.
    Instead: two queries, first the board and then `jira_connection`.
- Deleting a connection or an organization cascades to its boards.
    Ticket: silent.
    Instead: `onDelete: "restrict"`, so a connection with boards cannot be removed.
- A board is unique per connection, not per organization.
    Ticket: silent.
    Instead: unique on (organization_id, external_id).
- The table lives in `schema/jira.ts` and is re-exported by the `schema.ts` barrel; `index.ts` re-exports the new store and its five types.
    Ticket: silent.
    Instead: declare the table directly in `schema.ts`.
- What happens when overlapping calls race: update reads then writes, and returns null when the board is gone by the write; register relies on the conflict target.
    Ticket: silent.
    Instead: read-then-write inside a transaction, or write without reading first.
