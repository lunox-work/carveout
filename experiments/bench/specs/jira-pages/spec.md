# Jira board store: `sync` beside `register`

Sites are now pages, and boards are no longer chosen one at a time: every
board on a site is registered when the site is connected, and re-read every
time the site's page opens. The board store in
`packages/db/src/jira-boards.ts` gains `sync` for that re-read. It differs
from `register` in one thing: a sync refreshes only what is Jira's to state
(`name`, `boardType`, `projectKey`) and never touches `selection` or
`writebackEnabled`, because it runs on every visit against boards somebody
has already configured. `register` keeps overwriting `selection`, because a
caller passing one is asking for it.

## Exports

From `packages/db/src/jira-boards.ts`, added or changed:

```ts
/** What a sync records: Jira's facts about a board, and nothing of ours. */
export type SyncBoardInput = Omit<RegisterBoardInput, "selection">;

export interface JiraBoardStore {
    list(organizationId: string): Promise<JiraBoardSummary[]>;
    get(organizationId: string, boardId: string): Promise<JiraBoardSummary | null>;
    register(organizationId: string, input: RegisterBoardInput): Promise<JiraBoardSummary>;
    sync(organizationId: string, input: SyncBoardInput): Promise<JiraBoardSummary>;
    update(organizationId: string, boardId: string, input: UpdateBoardInput): Promise<JiraBoardSummary | null>;
    remove(organizationId: string, boardId: string): Promise<boolean>;
    forRun(organizationId: string, boardId: string): Promise<{
        board: JiraBoardSummary;
        connectionId: string;
        cloudId: string;
        siteUrl: string;
    } | null>;
}
```

`SyncBoardInput` is therefore `{ readonly connectionId: string; readonly
externalId: string; readonly name: string; readonly boardType: string;
readonly projectKey?: string | null }`. It is also re-exported as a type from
`packages/db/src/index.ts`, beside `RegisterBoardInput`.

Unchanged, with their current behaviour: `createJiraBoardStore(db: Database):
JiraBoardStore`, `StoredBoardSelection`, `JiraBoardSummary`,
`RegisterBoardInput`, `UpdateBoardInput`, and the methods `list`, `get`,
`register`, `update`, `remove` and `forRun`. Nothing else is exported.

## How `sync` behaves

`sync(organizationId, input)` issues exactly one statement: an upsert on
`jira_board`. It does not read first.

- Insert values, exactly these keys: `id` (`generateId("jrb")`, so it matches
  `/^jrb_/`), `organizationId`, `connectionId`, `externalId`, `name`,
  `boardType`, `projectKey` (`input.projectKey ?? null`), `selection` (`{}`),
  `updatedAt` (a `Date` taken during the call). `writebackEnabled` and
  `createdAt` are absent; the column defaults supply them.
- Conflict target: `[jiraBoard.connectionId, jiraBoard.externalId]`, the same
  unique pair `register` uses.
- Conflict update (`set`), exactly these keys: `name`, `boardType`,
  `projectKey`, `updatedAt`, with the same values as the insert.
- No conflict guard: no `setWhere` is passed, as with `register`, so the
  conflicting row is refreshed and returned whichever organization owns it.
- The statement ends in `.returning()`. The first returned row becomes the
  result through the same mapping `list` and `get` use. No row returned
  rejects with `Error("Failed to record the Jira board.")`.
- No input field is validated, trimmed or normalised; the edge validates.
  A database error rejects `sync` with that same error, unwrapped.

Tests use the fake in `packages/db/test/fake-db.ts`. It records the insert's
`values`; to observe `target`, `set` and the absence of `setWhere`, the fake (or a test-local
copy) records the argument passed to `onConflictDoUpdate`.

```gherkin
Feature: JiraBoardStore.sync refreshes Jira's facts about a board and leaves its settings alone

  Background:
    Given a store made by createJiraBoardStore over a fake database
    And every query on the fake database resolves to the rows the scenario gives
    And the fake database records each statement's kind, its values and its onConflictDoUpdate argument
    And "stored row" means this JiraBoardRow:
      | field            | value                                       |
      | id               | jrb_1                                       |
      | organizationId   | org_1                                       |
      | connectionId     | jrc_1                                       |
      | externalId       | 42                                          |
      | name             | Acme board                                  |
      | boardType        | scrum                                       |
      | projectKey       | ACME                                        |
      | selection        | { maxTickets: 10, excludeAssigned: true }   |
      | writebackEnabled | true                                        |
      | createdAt        | 2026-09-21T00:00:00.000Z                    |
      | updatedAt        | 2026-09-21T00:00:00.000Z                    |

  Rule: A sync inserts a board that is not yet registered, with empty settings and write-back left to the column default

    @happy
    Scenario: A board seen for the first time is inserted with empty settings
      Given the database returns the stored row
      When sync is called with "org_1" and:
        | field        | value       |
        | connectionId | jrc_1       |
        | externalId   | 42          |
        | name         | Acme board  |
        | boardType    | scrum       |
        | projectKey   | ACME        |
      Then exactly one statement is issued, of kind "insert"
      And its values have exactly the keys id, organizationId, connectionId, externalId, name, boardType, projectKey, selection, updatedAt
      And values.id matches /^jrb_/
      And values.organizationId is "org_1"
      And values.connectionId is "jrc_1"
      And values.externalId is "42"
      And values.name is "Acme board"
      And values.boardType is "scrum"
      And values.projectKey is "ACME"
      And values.selection deep-equals {}
      And values.updatedAt is a Date no earlier than the moment sync was called
      And values has no key "writebackEnabled"

  Rule: On an already-registered board, a sync updates only name, boardType, projectKey and updatedAt

    @happy
    Scenario: The conflict clause targets the board's Jira identity and sets only Jira's facts
      Given the database returns the stored row
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board (renamed)", boardType: "kanban", projectKey: "ACME2" }
      Then the onConflictDoUpdate target is [jiraBoard.connectionId, jiraBoard.externalId]
      And the onConflictDoUpdate set has exactly the keys name, boardType, projectKey, updatedAt
      And set.name is "Acme board (renamed)"
      And set.boardType is "kanban"
      And set.projectKey is "ACME2"
      And set.updatedAt is a Date
      And set has no key "selection"
      And set has no key "writebackEnabled"
      And set has no key "organizationId"

    @happy
    Scenario: The summary carries the stored settings, not defaults
      Given the database returns the stored row with name "Acme board (renamed)"
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board (renamed)", boardType: "scrum" }
      Then it resolves to the JiraBoardSummary:
        | field            | value                                     |
        | id               | jrb_1                                     |
        | connectionId     | jrc_1                                     |
        | externalId       | 42                                        |
        | name             | Acme board (renamed)                      |
        | boardType        | scrum                                     |
        | projectKey       | ACME                                      |
        | selection        | { maxTickets: 10, excludeAssigned: true } |
        | writebackEnabled | true                                      |
        | createdAt        | "2026-09-21T00:00:00.000Z"                |

    @boundary
    Scenario: A stored null selection reads back as empty settings
      Given the database returns the stored row with selection null
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum" }
      Then the resolved summary's selection deep-equals {}

  Rule: An omitted or null projectKey is written as null on insert and on update

    @boundary
    Scenario Outline: The project key Jira states is what is stored
      Given the database returns the stored row
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum" } plus projectKey <given>
      Then values.projectKey is <written>
      And set.projectKey is <written>

      Examples:
        | given        | written |
        | "ACME"       | "ACME"  |
        | null         | null    |
        | not supplied | null    |

  Rule: Inputs are stored as given; sync validates and normalises nothing

    @boundary
    Scenario Outline: Unusual values pass through unchanged
      Given the database returns the stored row
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: <name>, boardType: <boardType> }
      Then values.name is <name> and set.name is <name>
      And values.boardType is <boardType> and set.boardType is <boardType>
      And the call resolves

      Examples:
        | name           | boardType |
        | ""             | "scrum"   |
        | "  Acme  "     | "kanban"  |
        | "Acme board"   | "simple"  |
        | "Acme board"   | ""        |

    @unhappy
    Scenario: A selection smuggled past the type is ignored
      Given the database returns the stored row
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum", selection: { maxTickets: 1 } } cast to SyncBoardInput
      Then values.selection deep-equals {}
      And set has no key "selection"

    @unhappy
    Scenario: A writebackEnabled smuggled past the type is ignored
      Given the database returns the stored row
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum", writebackEnabled: false } cast to SyncBoardInput
      Then values has no key "writebackEnabled"
      And set has no key "writebackEnabled"

  Rule: A sync's conflict update is not guarded by organization, and a sync that yields no row rejects

    @unhappy
    Scenario: The conflict update carries no organization guard
      Given the database returns the stored row with organizationId "org_2"
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum" }
      Then the onConflictDoUpdate argument has no setWhere
      And it resolves to a summary with id "jrb_1"

    @unhappy
    Scenario: No returned row rejects with a named error
      Given the database returns no rows
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum" }
      Then it rejects with an Error whose message is "Failed to record the Jira board."

    @unhappy
    Scenario: A database error surfaces unchanged
      Given a database whose insert statement rejects with Error("connection reset")
      When sync is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum" }
      Then it rejects with that same Error instance

  Rule: A sync is one statement with no prior read, so overlapping calls cannot duplicate a board or clobber settings

    @concurrency
    Scenario: Two syncs of the same board started together each issue one insert
      Given the database returns the stored row
      When two sync calls for "org_1" with { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum" } are started before either is awaited
      Then both resolve to a summary with id "jrb_1"
      And exactly two statements are recorded, both of kind "insert"
      And no statement of kind "select" is recorded
      And the two insert values carry different ids, each matching /^jrb_/

    @concurrency
    Scenario: A sync overlapping an update does not write the settings the update writes
      Given the database returns the stored row
      When update("org_1", "jrb_1", { selection: { maxTickets: 5 }, writebackEnabled: false }) and sync("org_1", { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum" }) are started before either is awaited
      Then both resolve
      And the recorded insert's onConflictDoUpdate set has neither "selection" nor "writebackEnabled"
      And the recorded update's values include selection { maxTickets: 5, excludeAssigned: true } and writebackEnabled false

  Rule: register keeps its behaviour, which is to overwrite the selection

    @happy
    Scenario: register still sets the selection it is given, and still leaves write-back alone
      Given the database returns the stored row
      When register is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum", selection: { maxTickets: 3 } }
      Then values.selection deep-equals { maxTickets: 3 }
      And the onConflictDoUpdate set includes selection { maxTickets: 3 }
      And values has no key "writebackEnabled"

    @boundary
    Scenario: register without a selection still resets it to empty, unlike sync
      Given the database returns the stored row
      When register is called with "org_1" and { connectionId: "jrc_1", externalId: "42", name: "Acme board", boardType: "scrum" }
      Then the onConflictDoUpdate set includes selection {}
      And no setWhere is passed to onConflictDoUpdate
```

Decided:

- What `sync` writes as the settings of a board it inserts for the first time.
  - Ticket: "Every board on a site is registered when the site is connected"
  - Instead: leave `selection` out of the insert and rely on the column default `{}`.
- Which columns the conflict update of `sync` sets, exactly.
  - Ticket: "a sync refreshes only what is Jira's to state — the name, the type, the project — and leaves `selection` and `writebackEnabled` alone"
  - Instead: also re-set `organizationId`, `connectionId` and `externalId`, as `register`'s `set` does.
- What an omitted or null `projectKey` does to a stored project key.
  - Ticket: silent.
  - Instead: an omitted `projectKey` leaves the stored key as it was.
- Whether `sync` validates or normalises its input (empty name, unknown board type, whitespace).
  - Ticket: silent.
  - Instead: reject an empty name or a board type outside `scrum`/`kanban`/`unknown` with an error.
- What happens to `selection` or `writebackEnabled` passed to `sync` despite the type.
  - Ticket: silent.
  - Instead: spread the input into the statement, so any extra field is written.
- Whether `sync` may refresh a board row owned by another organization that shares the connection and board id.
  - Ticket: silent.
  - Instead: guard the conflict update with `setWhere` on the caller's organization, so another organization's row is never refreshed and the call rejects.
- What `sync` does when the upsert returns no row.
  - Ticket: silent.
  - Instead: resolve to `null` (which would change the interface's return type).
- The error message for that case.
  - Ticket: silent.
  - Instead: reuse "Failed to register the Jira board.", or say "Failed to sync the Jira board."
- Whether database errors are wrapped.
  - Ticket: silent.
  - Instead: wrap them in a store-specific error.
- How overlapping syncs, and a sync overlapping an update, are kept from duplicating rows or losing settings.
  - Ticket: "re-read whenever the site's page opens"
  - Instead: read the existing row first and insert or update, which would need a transaction or lock to be safe.
- Whether `sync` takes one board or a site's whole board list.
  - Ticket: "The store grows `sync` beside `register` for this."
  - Instead: `sync(organizationId, connectionId, boards[])` that also removes boards Jira no longer lists.
- Whether `register` changes.
  - Ticket: "`register` overwrites the selection because a caller passing one is asking for it."
  - Instead: make `register` keep the stored selection when none is passed.
