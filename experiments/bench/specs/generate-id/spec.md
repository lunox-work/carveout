# Generalise `generateId` and split the Drizzle schema into modules

`packages/db` creates every application id with `generateId()` in
`src/mapping.ts`. Right now the function can only make `todo_<uuid>` ids.
Upcoming tables need their own prefixes, so `generateId` will take a prefix
drawn from a closed list, `ID_PREFIXES`. Separately, `src/schema.ts` holds all
nine Drizzle tables in one file. This change moves them into three modules
under `src/schema/`: `auth.ts`, `organizations.ts` and `todos.ts`.
`src/schema.ts` stays in place as a barrel that re-exports them, so every
current importer keeps working unchanged. Those importers are `emails.ts`,
`organizations.ts`, `store.ts`, `auth-schema.ts`, `index.ts`, the tests, and
`drizzle.config.ts`, which reads `./src/schema.ts`. No table, column, index,
constraint or foreign key changes, and no migration is generated.

## Exports

### `packages/db/src/mapping.ts`

```ts
export const ID_PREFIXES = [
    "todo",
    "jrc",
    "jrb",
    "jri",
    "brn",
    "bpr",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

export function generateId(prefix: IdPrefix = "todo"): string;
```

- `ID_PREFIXES` is exported exactly as written above: the same six strings in
  the same order, and not wrapped in `Object.freeze`.
- `generateId(prefix)` returns `` `${prefix}_${crypto.randomUUID()}` ``. The
  result is the prefix, one `_`, then a lowercase RFC 4122 version-4 UUID
  (36 characters). The closed list is enforced by the `IdPrefix` type only;
  there is no runtime check. A value cast past the type is put into the id
  as the template literal stringifies it, and nothing is thrown: `"user"`
  gives `user_<uuid>`, `""` gives `_<uuid>`, `null` gives `null_<uuid>`.
  Passing `undefined`, or no argument, uses the default `"todo"`.
- These keep their current behaviour:
  - `rowToTodo(row: TodoRow): Todo`.
  - `newTodoRow(userId: string, title: string, id: string = generateId()): NewTodoRow`.
    Its default id still has the `todo_` prefix.
- `mapping.ts` keeps taking its `TodoRow` / `NewTodoRow` types from
  `./schema.js`.

### `packages/db/src/schema/auth.ts`

```ts
export const user = …;          // pgTable("user", …), moved verbatim
export const userEmail = …;     // pgTable("user_email", …), moved verbatim
export const session = …;       // pgTable("session", …), moved verbatim
export const account = …;       // pgTable("account", …), moved verbatim
export const verification = …;  // pgTable("verification", …), moved verbatim

export type UserRow = typeof user.$inferSelect;
export type UserEmailRow = typeof userEmail.$inferSelect;
export type NewUserEmailRow = typeof userEmail.$inferInsert;
export type SessionRow = typeof session.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type VerificationRow = typeof verification.$inferSelect;
```

`session.activeOrganizationId` still references `organization.id`, with
`onDelete: "set null"`. `organization` comes from `./organizations.js`, and
the lazy `() => organization.id` callback is kept. That import cycle is
allowed and safe, because neither module reads the other's bindings while it
is being evaluated. The Better Auth naming note, which requires singular
const names and camelCase property keys, moves with these tables.

### `packages/db/src/schema/organizations.ts`

```ts
export const organization = …;  // pgTable("organization", …), moved verbatim
export const member = …;        // pgTable("member", …), moved verbatim
export const invitation = …;    // pgTable("invitation", …), moved verbatim

export type OrganizationRow = typeof organization.$inferSelect;
export type NewOrganizationRow = typeof organization.$inferInsert;
export type MemberRow = typeof member.$inferSelect;
export type NewMemberRow = typeof member.$inferInsert;
export type InvitationRow = typeof invitation.$inferSelect;
```

`member.userId` and `invitation.inviterId` reference `user.id` from
`./auth.js`.

### `packages/db/src/schema/todos.ts`

```ts
export const todos = …;         // pgTable("todos", …), moved verbatim

export type TodoRow = typeof todos.$inferSelect;
export type NewTodoRow = typeof todos.$inferInsert;
```

`todos.userId` references `user.id` from `./auth.js`.

### `packages/db/src/schema.ts`

This file becomes a barrel and defines no tables of its own. It re-exports
every value and type listed above for the three modules, under the same
names. That is the same nine runtime values and thirteen types it exports
today, and no others. Each re-exported value is the same object (`===`) as
the one in its module.

### Package root and unchanged files

- `src/index.ts` still re-exports `generateId`, `newTodoRow` and
  `rowToTodo`, plus the tables and row types from `./schema.js`. It now also
  re-exports `ID_PREFIXES` (value) and `IdPrefix` (type) from `./mapping.js`.
- `src/auth-schema.ts` and `authSchema` are unchanged.
- `emails.ts` still uses its own `email_${uuid}` ids. Moving it onto
  `generateId` is out of scope.

```gherkin
Feature: Prefixed id generation and a modular Drizzle schema

  Background:
    Given UUID_V4 is the pattern "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"

  Rule: ID_PREFIXES is the closed, ordered list of six prefixes

    @happy
    Scenario: The list holds exactly the six prefixes in declaration order
      When ID_PREFIXES is read from "src/mapping.ts"
      Then it deep-equals ["todo", "jrc", "jrb", "jri", "brn", "bpr"]
      And its length is 6

    @boundary
    Scenario: Every prefix is lowercase letters only, so an id splits unambiguously at its first "_"
      When each entry of ID_PREFIXES is checked
      Then every entry matches /^[a-z]+$/
      And no two entries are equal

    @boundary
    Scenario: The list is exported as declared, not frozen
      When Object.isFrozen(ID_PREFIXES) is evaluated
      Then the result is false

    @happy
    Scenario: The package root re-exports the same list
      When ID_PREFIXES is imported from "src/index.js" and from "src/mapping.js"
      Then the two values are strictly equal

  Rule: generateId(prefix) returns "<prefix>_<lowercase uuid v4>"

    @happy
    Scenario Outline: Each listed prefix produces an id carrying that prefix
      When generateId("<prefix>") is called
      Then the result matches /^<prefix>_UUID_V4$/
      And the result has length <length>

      Examples:
        | prefix | length |
        | todo   | 41     |
        | jrc    | 40     |
        | jrb    | 40     |
        | jri    | 40     |
        | brn    | 40     |
        | bpr    | 40     |

    @happy
    Scenario: With no argument the prefix is "todo", as before
      When generateId() is called
      Then the result matches /^todo_UUID_V4$/

    @boundary
    Scenario: An explicit undefined falls back to the default prefix
      When generateId(undefined) is called
      Then the result matches /^todo_UUID_V4$/

    @happy
    Scenario: Repeated calls return distinct ids
      When generateId("jri") is called 1000 times
      Then the 1000 results are pairwise distinct
      And every result starts with "jri_"

    @boundary
    Scenario: Ids with different prefixes never collide, even across prefixes
      When generateId(p) is called 100 times for each p in ID_PREFIXES
      Then the 600 results are pairwise distinct
      And the part after the first "_" is pairwise distinct across all 600

  Rule: A prefix outside ID_PREFIXES is not checked at runtime and is used as given

    @unhappy
    Scenario Outline: A value cast past the IdPrefix type is stringified into the id without an error
      When generateId is called with <input> (cast past the IdPrefix type)
      Then it does not throw
      And the result is <start> followed by a string matching /^UUID_V4$/

      Examples:
        | input    | start      |
        | "user"   | "user_"    |
        | ""       | "_"        |
        | "TODO"   | "TODO_"    |
        | "Jrc"    | "Jrc_"     |
        | " todo"  | " todo_"   |
        | "todo_"  | "todo__"   |
        | "email"  | "email_"   |
        | null     | "null_"    |
        | 42       | "42_"      |

  Rule: Overlapping callers each receive their own id

    @concurrency
    Scenario: Ids requested from interleaved async tasks are all distinct
      Given 50 async tasks that each await a resolved promise and then call generateId("brn") 20 times
      When the tasks run together under Promise.all
      Then the 1000 collected ids are pairwise distinct
      And every id matches /^brn_UUID_V4$/

  Rule: newTodoRow and rowToTodo keep their behaviour

    @happy
    Scenario: newTodoRow still defaults to a todo-prefixed id
      When newTodoRow("user_1", "buy milk") is called
      Then its id matches /^todo_UUID_V4$/
      And its userId is "user_1", its title is "buy milk" and done is false

    @happy
    Scenario: newTodoRow still uses an id it is given verbatim
      When newTodoRow("user_1", "buy milk", "jri_custom") is called
      Then its id is "jri_custom"

    @happy
    Scenario: rowToTodo is unchanged
      When rowToTodo is called with { id: "todo_1", userId: "user_1", title: "write tests", done: false, createdAt: new Date("2026-09-16T00:00:00.000Z") }
      Then it returns { id: "todo_1", title: "write tests", done: false, createdAt: "2026-09-16T00:00:00.000Z" }

  Rule: Each schema module exports exactly its own tables

    @happy
    Scenario Outline: A module's runtime exports are exactly its tables
      When the module "<module>" is imported as a namespace
      Then Object.keys of the namespace, sorted, deep-equal <keys>

      Examples:
        | module                       | keys                                                           |
        | src/schema/auth.js           | ["account", "session", "user", "userEmail", "verification"]    |
        | src/schema/organizations.js  | ["invitation", "member", "organization"]                       |
        | src/schema/todos.js          | ["todos"]                                                      |

    @happy
    Scenario Outline: Each table keeps its Postgres table name
      When getTableConfig(<export>) is read from "<module>"
      Then its name is "<table>"

      Examples:
        | module                       | export       | table        |
        | src/schema/auth.js           | user         | user         |
        | src/schema/auth.js           | userEmail    | user_email   |
        | src/schema/auth.js           | session      | session      |
        | src/schema/auth.js           | account      | account      |
        | src/schema/auth.js           | verification | verification |
        | src/schema/organizations.js  | organization | organization |
        | src/schema/organizations.js  | member       | member       |
        | src/schema/organizations.js  | invitation   | invitation   |
        | src/schema/todos.js          | todos        | todos        |

  Rule: schema.ts is a barrel that re-exports the same objects, and nothing else

    @happy
    Scenario: The barrel's runtime exports are the nine tables
      When "src/schema.js" is imported as a namespace
      Then Object.keys of the namespace, sorted, deep-equal ["account", "invitation", "member", "organization", "session", "todos", "user", "userEmail", "verification"]

    @happy
    Scenario Outline: A barrel export is the identical object from its module
      When <export> is imported from "src/schema.js" and from "<module>"
      Then the two values are strictly equal

      Examples:
        | export       | module                       |
        | user         | src/schema/auth.js           |
        | userEmail    | src/schema/auth.js           |
        | session      | src/schema/auth.js           |
        | account      | src/schema/auth.js           |
        | verification | src/schema/auth.js           |
        | organization | src/schema/organizations.js  |
        | member       | src/schema/organizations.js  |
        | invitation   | src/schema/organizations.js  |
        | todos        | src/schema/todos.js          |

    @happy
    Scenario: authSchema still holds the barrel's tables
      When authSchema is imported from "src/auth-schema.js"
      Then authSchema.user is strictly equal to user from "src/schema/auth.js"
      And authSchema.organization is strictly equal to organization from "src/schema/organizations.js"
      And "todos" in authSchema is false
      And "userEmail" in authSchema is false

  Rule: Foreign keys across modules resolve to the same table objects and keep their delete actions

    @happy
    Scenario Outline: Every foreign key points at the right table with the right action
      When the foreign keys of getTableConfig(<from>) are read
      Then exactly one foreign key has local column "<column>"
      And its reference().foreignTable is strictly equal to <target> from "<target module>"
      And its reference().foreignColumns[0].name is "id"
      And its onDelete is "<onDelete>"

      Examples:
        | from       | column                 | target       | target module                | onDelete |
        | todos      | user_id                | user         | src/schema/auth.js           | cascade  |
        | userEmail  | user_id                | user         | src/schema/auth.js           | cascade  |
        | session    | user_id                | user         | src/schema/auth.js           | cascade  |
        | session    | active_organization_id | organization | src/schema/organizations.js  | set null |
        | account    | user_id                | user         | src/schema/auth.js           | cascade  |
        | member     | organization_id        | organization | src/schema/organizations.js  | cascade  |
        | member     | user_id                | user         | src/schema/auth.js           | cascade  |
        | invitation | organization_id        | organization | src/schema/organizations.js  | cascade  |
        | invitation | inviter_id             | user         | src/schema/auth.js           | cascade  |

    @boundary
    Scenario Outline: The auth/organizations import cycle does not depend on which module loads first
      Given a fresh process that imports "<first>" before anything else
      When the foreign key on session.active_organization_id is resolved
      Then its foreignTable is the organization table named "organization"
      And member.user_id's foreignTable is the user table named "user"

      Examples:
        | first                        |
        | src/schema/auth.js           |
        | src/schema/organizations.js  |

    @happy
    Scenario Outline: Tables that reference nothing have no foreign keys
      When getTableConfig(<table>).foreignKeys is read
      Then its length is 0

      Examples:
        | table        |
        | user         |
        | verification |
        | organization |

  Rule: Indexes, constraints and defaults move unchanged

    @happy
    Scenario Outline: Each named index or unique constraint is still on its table
      When getTableConfig(<table>) is read
      Then it has an index or unique constraint named "<name>" over <columns> with unique = <unique>

      Examples:
        | table      | name                              | columns                         | unique |
        | todos      | todos_user_id_created_at_idx      | user_id, desc(created_at)       | false  |
        | user       | user_email_lower_unique           | lower(email)                    | true   |
        | userEmail  | user_email_one_primary            | user_id where is_primary        | true   |
        | userEmail  | user_email_email_lower_unique     | lower(email)                    | true   |
        | account    | account_provider_identity_unique  | provider_id, account_id         | true   |
        | member     | member_organization_user_unique   | organization_id, user_id        | true   |
        | member     | member_user_id_idx                | user_id                         | false  |
        | invitation | invitation_email_status_idx       | email, status                   | false  |
        | invitation | invitation_organization_id_idx    | organization_id                 | false  |

    @boundary
    Scenario Outline: Column-level defaults survive the move
      When the column "<column>" of getTableConfig(<table>) is read
      Then its default is <default>

      Examples:
        | table      | column         | default   |
        | todos      | done           | false     |
        | userEmail  | is_primary     | false     |
        | user       | email_verified | false     |
        | member     | role           | "member"  |
        | invitation | role           | "member"  |
        | invitation | status         | "pending" |
```

Decided:

- What `generateId` produces: the prefix, one `_`, then a lowercase UUID v4 from `crypto.randomUUID()`. The separator is unchanged from today's ids.
  Ticket: silent.
  Instead: a shorter random suffix (nanoid or base32) or a ULID that sorts by time.
- What happens with a prefix outside `ID_PREFIXES` at runtime: nothing checks it. The `IdPrefix` type is the only guard; a value cast past it is stringified into the id as-is (`"user"` → `user_<uuid>`, `""` → `_<uuid>`, `42` → `42_<uuid>`) and no error is thrown.
  Ticket: "export function generateId(prefix: IdPrefix = "todo"): string;"
  Instead: check membership at runtime and throw a `RangeError` for an unknown prefix.
- How prefixes are normalised: they are not. No lower-casing or trimming, so `"TODO"` gives `TODO_<uuid>` and `" todo"` gives ` todo_<uuid>`.
  Ticket: silent.
  Instead: lower-case and trim the input first.
- What `generateId(undefined)` and `generateId(null)` do: `undefined` uses `"todo"`, the normal default-parameter behaviour. `null` does not trigger the default and gives `null_<uuid>`.
  Ticket: "export function generateId(prefix: IdPrefix = "todo"): string;"
  Instead: treat `null` like `undefined` as well.
- Whether `ID_PREFIXES` is frozen: no. It is exported exactly as declared (`as const`, not frozen), and mutating it is outside the contract.
  Ticket: "export const ID_PREFIXES = [ … ] as const;"
  Instead: wrap it in `Object.freeze` so mutation is impossible at runtime as well.
- What happens to `src/schema.ts`: it stays as a barrel that re-exports exactly the same nine values and thirteen types, with identical object identity, so importers and `drizzle.config.ts` are untouched.
  Ticket: "split the schema into modules"
  Instead: delete `schema.ts` and point every importer and `drizzle.config.ts` at `src/schema/*` (or at a new `src/schema/index.ts`).
- What each module exports: only its own tables and row types. Modules do not re-export each other's tables.
  Ticket: silent.
  Instead: have `auth.ts` re-export `organization` (or the reverse) for convenience.
- How the `session` → `organization` reference crosses modules: a direct import cycle between `auth.ts` and `organizations.ts`, kept safe by Drizzle's lazy reference callbacks. It works whichever module loads first.
  Ticket: silent.
  Instead: put `session` in `organizations.ts`, or move the foreign key into a separate relations module so there is no cycle.
- Whether `src/index.ts` exports `ID_PREFIXES` and `IdPrefix`: yes. Both are re-exported from the package root next to `generateId`, and the root's `ID_PREFIXES` is the same object as `mapping.ts`'s.
  Ticket: silent.
  Instead: leave `index.ts` untouched and keep the list internal to the package.
- Whether `newTodoRow` or `emails.ts` id generation changes: neither does. `newTodoRow`'s default id stays `todo_…`, and `emails.ts` keeps its own `email_…` generator.
  Ticket: silent.
  Instead: add `"email"` to `ID_PREFIXES` and route `emails.ts` through `generateId`.
- How overlapping calls behave: `generateId` is synchronous and keeps no state, so calls from interleaved async tasks each get a distinct id.
  Ticket: silent.
  Instead: no alternative is conventional for a pure function; a per-process counter would be the only stateful option.
- Whether the database changes: no. Table names, columns, defaults, indexes, constraints and delete actions are moved verbatim, and no migration is generated.
  Ticket: silent.
  Instead: use the split to tidy names or indexes and ship a migration with it.
