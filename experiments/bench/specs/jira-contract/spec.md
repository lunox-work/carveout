# Jira wire contract and linear-time trailing-slash trimming in `@sandbox-factory/shared`

The Jira integration package was lost, and only its compiled output survived.
This change brings back its wire contract in `packages/shared`. There are two
families of zod schema, and they are not interchangeable:

- `*ResponseSchema` (plus `tokenResponseSchema` and `accessibleResourceSchema`)
  describe what **Atlassian sends**. `packages/jira` parses with them. They are
  permissive on purpose. Almost every Jira issue field can be configured per
  screen, so a project administrator can remove it. These schemas therefore
  require only what Jira guarantees and keep unknown keys (`.loose()`).
- `*DtoSchema` describe what **we hand on** to the API, the web app and the
  extension. They are flat and strict, use `null` where Jira left a value out,
  and drop unknown keys.

The ticket also asks for one shared helper that removes trailing slashes from
a Jira site URL. The recovered code did this with
`siteUrl.replace(/\/+$/, "")` in `ApiTokenCredential` and in `toIssueDto`.
CodeQL flagged that regex as ReDoS (alerts 72 and 73): about 1300 ms for
60,000 slashes. The site URL is not ours. It comes from Atlassian's
accessible-resources response and from the stored `jira_connection` row, so it
is untrusted input. The helper scans backwards in linear time and does not use
a regex. `packages/client` already does the same thing privately
(`trimTrailingSlashes` in `packages/client/src/index.ts`).

Everything below is exported from `packages/shared/src/index.ts`, which
re-exports `./jira.js` the way it re-exports `./build-info.js`. The new module
depends on `zod` only.

**New exports**

```ts
/** Removes every trailing "/" (U+002F) in one backwards scan. Never throws. */
export function trimTrailingSlashes(value: string): string;

export const JIRA_STATUS_CATEGORIES = ["new", "indeterminate", "done", "unknown"] as const;
export const jiraStatusCategorySchema; // z.enum(JIRA_STATUS_CATEGORIES)

// What Atlassian sends (all objects .loose())
export const jiraIssueResponseSchema;
export const jiraIssuePageResponseSchema;
export const jiraBoardResponseSchema;
export const jiraBoardPageResponseSchema;
export const jiraSprintResponseSchema;
export const jiraSprintPageResponseSchema;
export const tokenResponseSchema;
export const accessibleResourceSchema;

// What we hand on (plain z.object, unknown keys stripped)
export const jiraIssueDtoSchema;
export const jiraIssuePageDtoSchema;
export const jiraBoardDtoSchema;
export const jiraSprintDtoSchema;
export const jiraSiteDtoSchema;

export type JiraStatusCategory     = z.infer<typeof jiraStatusCategorySchema>;
export type JiraIssueResponse      = z.infer<typeof jiraIssueResponseSchema>;
export type JiraIssuePageResponse  = z.infer<typeof jiraIssuePageResponseSchema>;
export type JiraBoardResponse      = z.infer<typeof jiraBoardResponseSchema>;
export type JiraBoardPageResponse  = z.infer<typeof jiraBoardPageResponseSchema>;
export type JiraSprintResponse     = z.infer<typeof jiraSprintResponseSchema>;
export type JiraSprintPageResponse = z.infer<typeof jiraSprintPageResponseSchema>;
export type TokenResponse          = z.infer<typeof tokenResponseSchema>;
export type AccessibleResource     = z.infer<typeof accessibleResourceSchema>;
export type JiraIssueDto           = z.infer<typeof jiraIssueDtoSchema>;
export type JiraIssuePageDto       = z.infer<typeof jiraIssuePageDtoSchema>;
export type JiraBoardDto           = z.infer<typeof jiraBoardDtoSchema>;
export type JiraSprintDto          = z.infer<typeof jiraSprintDtoSchema>;
export type JiraSiteDto            = z.infer<typeof jiraSiteDtoSchema>;
```

The object shapes. "opt" means the key may be absent; "nullish" means absent,
`undefined` or `null`; "nullable" means required but may be `null`.

| Schema                        | Field            | Rule                                                                 |
| ----------------------------- | ---------------- | -------------------------------------------------------------------- |
| `jiraIssueResponseSchema`     | `id`             | `z.string()`                                                         |
|                               | `key`            | `z.string()`                                                         |
|                               | `fields`         | opt, loose object; every member below is optional                    |
|                               | `fields.summary` | opt string                                                           |
|                               | `fields.status`  | opt `{ name?: string, statusCategory?: { key?: string, name?: string } }` |
|                               | `fields.assignee`| nullish `{ displayName?: string }`                                   |
|                               | `fields.priority`| nullish `{ name?: string, key?: string }`                            |
|                               | `fields.issuetype`, `fields.project` | opt `{ name?: string, key?: string }`            |
|                               | `fields.labels`  | opt `string[]`                                                       |
|                               | `fields.parent`  | nullish `{ key?: string }`                                           |
|                               | `fields.created`, `fields.updated`, `fields.duedate` | nullish string                   |
| `jiraIssuePageResponseSchema` | `issues`         | array of issue responses, defaults to `[]`                           |
|                               | `total`, `startAt`, `maxResults` | opt number                                           |
|                               | `nextPageToken`  | opt string                                                           |
| `jiraBoardResponseSchema`     | `id`             | `z.number()`                                                         |
|                               | `name`           | `z.string()`                                                         |
|                               | `type`           | opt string                                                           |
|                               | `location`       | opt `{ projectKey?, projectName?, displayName? }` (strings)          |
| `jiraBoardPageResponseSchema` | `values`         | array of board responses, defaults to `[]`                           |
|                               | `isLast`         | opt boolean                                                          |
|                               | `startAt`, `maxResults`, `total` | opt number                                           |
| `jiraSprintResponseSchema`    | `id`             | `z.number()`                                                         |
|                               | `name`           | `z.string()`                                                         |
|                               | `state`          | opt string                                                           |
|                               | `startDate`, `endDate`, `goal` | nullish string                                         |
| `jiraSprintPageResponseSchema`| `values`         | array of sprint responses, defaults to `[]`                          |
|                               | `isLast`         | opt boolean                                                          |
| `tokenResponseSchema`         | `access_token`   | `z.string()`                                                         |
|                               | `expires_in`     | `z.number()`                                                         |
|                               | `refresh_token`, `scope`, `token_type` | opt string                                     |
| `accessibleResourceSchema`    | `id`, `url`, `name` | `z.string()`                                                      |
|                               | `avatarUrl`      | opt string                                                           |
|                               | `scopes`         | `string[]`, defaults to `[]`                                         |
| `jiraIssueDtoSchema`          | `id`, `key`, `summary`, `status`, `issueType` | `z.string()`                            |
|                               | `statusCategory` | `jiraStatusCategorySchema`                                           |
|                               | `labels`         | `string[]`                                                           |
|                               | `assignee`, `priority`, `projectKey`, `parentKey`, `created`, `updated`, `dueDate`, `url` | nullable string |
| `jiraIssuePageDtoSchema`      | `issues`         | array of issue DTOs                                                  |
|                               | `total`, `nextStartAt` | opt number                                                     |
|                               | `nextPageToken`  | opt string                                                           |
| `jiraBoardDtoSchema`          | `id`             | `z.number()`                                                         |
|                               | `name`, `type`   | `z.string()`                                                         |
|                               | `projectKey`, `projectName` | nullable string                                           |
| `jiraSprintDtoSchema`         | `id`             | `z.number()`                                                         |
|                               | `name`, `state`  | `z.string()`                                                         |
|                               | `startDate`, `endDate`, `goal` | nullable string                                        |
| `jiraSiteDtoSchema`           | `cloudId`, `url`, `name` | `z.string()`                                                 |
|                               | `avatarUrl`      | opt string                                                           |

Every response object, including the nested ones, keeps unknown keys. Every
DTO object uses zod's default (strip) mode, so unknown keys are dropped from
the output.

**Existing exports keep their names, signatures and behaviour.** These are
`titleSchema`, `todoFilterSchema`, `handleSchema`, `todoSchema`,
`todoListSchema`, `createTodoSchema`, `updateTodoSchema`,
`ORGANIZATION_ROLES`, `organizationRoleSchema`, `organizationSummarySchema`,
`membershipSchema`, `membershipListSchema`, `organizationMemberSchema`,
`organizationMemberListSchema`, `pendingInvitationSchema`,
`pendingInvitationListSchema`, `inviteMemberSchema`, `errorSchema`, every
exported `*Dto` / `*Input` / `OrganizationRole` type, and everything
re-exported from `./build-info.js`. The tests in
`packages/shared/test/schemas.test.ts`, `build-info.test.ts`,
`build-info-resolver.test.ts` and `next-version.test.ts` pass unchanged.

```gherkin
Feature: Jira wire contract and linear-time trailing-slash trimming

  Background:
    Given a valid issue DTO is
      | field          | value                                       |
      | id             | 10001                                       |
      | key            | PROJ-123                                    |
      | summary        | Fix the login redirect                      |
      | status         | In Review                                   |
      | statusCategory | indeterminate                               |
      | assignee       | Dana                                        |
      | priority       | High                                        |
      | issueType      | Bug                                         |
      | labels         | ["auth"]                                    |
      | projectKey     | PROJ                                        |
      | parentKey      | null                                        |
      | created        | 2026-09-16T00:00:00.000+0000                |
      | updated        | 2026-09-17T09:14:00.000+0000                |
      | dueDate        | null                                        |
      | url            | https://acme.atlassian.net/browse/PROJ-123  |
    And a valid board DTO is { id: 7, name: "Platform", type: "scrum", projectKey: "PROJ", projectName: "Project" }

  Rule: trimTrailingSlashes removes only the run of "/" at the very end, and nothing else

    @happy
    Scenario: Trailing slashes are removed and everything before them is kept
      When trimTrailingSlashes is called with each input
      Then it returns the matching output
        | input                            | output                       |
        | https://acme.atlassian.net/      | https://acme.atlassian.net   |
        | https://acme.atlassian.net///    | https://acme.atlassian.net   |
        | https://jira.example.com/jira/   | https://jira.example.com/jira |
        | a/b/c//                          | a/b/c                        |

    @boundary
    Scenario: Strings with no trailing slash come back unchanged
      When trimTrailingSlashes is called with each input
      Then it returns the input unchanged
        | input                         |
        | https://acme.atlassian.net    |
        | a//b                          |
        | /leading                      |
        | x                             |

    @boundary
    Scenario: Empty and all-slash strings trim to the empty string
      When trimTrailingSlashes is called with each input
      Then it returns the matching output
        | input | output |
        |       |        |
        | /     |        |
        | ///// |        |

    @boundary
    Scenario: Only U+002F counts as a slash; backslashes and whitespace are kept
      When trimTrailingSlashes is called with each input
      Then it returns the matching output
        | input                               | output                              |
        | https://acme.atlassian.net\\        | https://acme.atlassian.net\\        |
        | https://acme.atlassian.net/ (space) | https://acme.atlassian.net/ (space) |
        | https://acme.atlassian.net/\t       | https://acme.atlassian.net/\t       |
      # "(space)" stands for one trailing U+0020; "\t" for one trailing U+0009.
      # A slash followed by whitespace is not a trailing slash.

    @boundary
    Scenario: A long run of slashes is handled in linear time
      When trimTrailingSlashes is called with each input
      Then it returns the matching output within 250 ms of wall time per call
        | input                                                     | output                                                    |
        | "https://acme.atlassian.net" + 60,000 × "/"               | https://acme.atlassian.net                                |
        | 60,000 × "/"                                              | (empty string)                                            |
        | "https://acme.atlassian.net" + 60,000 × "/" + "x"         | the input unchanged                                       |
        | 1,000,000 × "/"                                           | (empty string)                                            |
      # The old `replace(/\/+$/, "")` took about 1300 ms on the 60,000 case.

  Rule: jiraStatusCategorySchema is Jira's three categories plus our own "unknown"

    @happy
    Scenario: Each category is accepted
      When jiraStatusCategorySchema parses each value
      Then the parse succeeds with that value
        | value         |
        | new           |
        | indeterminate |
        | done          |
        | unknown       |
      And JIRA_STATUS_CATEGORIES deep-equals ["new", "indeterminate", "done", "unknown"]

    @unhappy
    Scenario: Anything else is refused, not mapped
      When jiraStatusCategorySchema safe-parses each value
      Then success is false
        | value          |
        | To Do          |
        | Done           |
        | undefined      |
        | (empty string) |

  Rule: The issue response schemas require only id and key, and keep whatever else Jira sends

    @happy
    Scenario: An issue with no fields block parses
      When jiraIssueResponseSchema parses { id: "10001", key: "PROJ-123" }
      Then the result deep-equals the input

    @happy
    Scenario: A full Jira issue parses with nulls where Jira sent null
      When jiraIssueResponseSchema parses
        """
        { "id": "10001", "key": "PROJ-123",
          "fields": { "summary": "Fix the login redirect",
                      "status": { "name": "In Review", "statusCategory": { "key": "indeterminate", "name": "In Progress" } },
                      "assignee": null, "priority": null, "parent": null,
                      "issuetype": { "name": "Bug" }, "labels": ["auth"],
                      "project": { "key": "PROJ", "name": "Project" },
                      "created": "2026-09-16T00:00:00.000+0000", "updated": null, "duedate": null } }
        """
      Then the result deep-equals the input

    @boundary
    Scenario: An empty fields block and an unrecognised status category key both parse
      When jiraIssueResponseSchema parses { id: "1", key: "A-1", fields: {} }
      Then the parse succeeds
      And parsing { id: "1", key: "A-1", fields: { status: { statusCategory: { key: "To Do" } } } } succeeds unchanged

    @boundary
    Scenario: Unknown keys are kept at every level
      When jiraIssueResponseSchema parses { id: "1", key: "A-1", expand: "names", fields: { customfield_10010: 5, assignee: { displayName: "Dana", accountId: "abc" } } }
      Then the result deep-equals the input

    @unhappy
    Scenario: An issue without an id or key, or with the wrong types, is refused
      When jiraIssueResponseSchema safe-parses each input
      Then success is false
        | input                                         |
        | { key: "A-1" }                                |
        | { id: "1" }                                   |
        | { id: 1, key: "A-1" }                         |
        | { id: "1", key: "A-1", fields: { summary: 5 } } |
        | { id: "1", key: "A-1", fields: { labels: "auth" } } |

    @boundary
    Scenario: An issue page with no issues key parses to an empty list
      When jiraIssuePageResponseSchema parses {}
      Then the result deep-equals { issues: [] }
      And parsing { issues: [{ id: "1", key: "A-1" }], nextPageToken: "tok" } returns the input unchanged
      And parsing { issues: [], total: 0, startAt: 0, maxResults: 50 } returns the input unchanged

    @unhappy
    Scenario: An issue page with one bad issue is refused
      When jiraIssuePageResponseSchema safe-parses { issues: [{ id: "1", key: "A-1" }, { id: "2" }] }
      Then success is false

  Rule: The board and sprint response schemas require a numeric id and a name

    @happy
    Scenario: A board with only id and name parses, and so does one with a location
      When jiraBoardResponseSchema parses { id: 7, name: "Platform" }
      Then the result deep-equals the input
      And parsing { id: 7, name: "Platform", type: "scrum", location: { projectKey: "PROJ", projectName: "Project", displayName: "Project (PROJ)" } } returns the input unchanged

    @unhappy
    Scenario: Malformed boards are refused
      When jiraBoardResponseSchema safe-parses each input
      Then success is false
        | input                         |
        | { id: "7", name: "Platform" } |
        | { id: 7 }                     |
        | { name: "Platform" }          |

    @boundary
    Scenario: Board and sprint pages default their values to an empty list
      When jiraBoardPageResponseSchema parses {}
      Then the result deep-equals { values: [] }
      And jiraSprintPageResponseSchema parses {} to { values: [] }
      And jiraBoardPageResponseSchema parses { values: [{ id: 7, name: "Platform" }], isLast: true } unchanged

    @happy
    Scenario: A sprint with null dates and goal parses
      When jiraSprintResponseSchema parses { id: 3, name: "Sprint 3", state: "active", startDate: null, endDate: null, goal: null }
      Then the result deep-equals the input
      And parsing { id: 3, name: "Sprint 3" } returns the input unchanged

    @unhappy
    Scenario: A sprint with a string id is refused
      When jiraSprintResponseSchema safe-parses { id: "3", name: "Sprint 3" }
      Then success is false

  Rule: tokenResponseSchema and accessibleResourceSchema require only what Atlassian always sends

    @happy
    Scenario: A token response without a refresh token or scope parses
      When tokenResponseSchema parses { access_token: "at", expires_in: 3600 }
      Then the result deep-equals the input
      And parsing { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "read:jira-work offline_access", token_type: "Bearer" } returns the input unchanged

    @unhappy
    Scenario: A token response missing the access token or expiry is refused
      When tokenResponseSchema safe-parses each input
      Then success is false
        | input                                     |
        | { expires_in: 3600 }                      |
        | { access_token: "at" }                    |
        | { access_token: "at", expires_in: "3600" } |

    @boundary
    Scenario: An accessible resource without scopes gets an empty scope list
      When accessibleResourceSchema parses { id: "cloud-1", url: "https://acme.atlassian.net", name: "Acme" }
      Then the result deep-equals { id: "cloud-1", url: "https://acme.atlassian.net", name: "Acme", scopes: [] }

    @unhappy
    Scenario: An accessible resource missing id, url or name is refused
      When accessibleResourceSchema safe-parses each input
      Then success is false
        | input                                             |
        | { url: "https://acme.atlassian.net", name: "Acme" } |
        | { id: "cloud-1", name: "Acme" }                   |
        | { id: "cloud-1", url: "https://acme.atlassian.net" } |

  Rule: jiraIssueDtoSchema is a flat issue with every field present, null where Jira had nothing

    @happy
    Scenario: A well-formed issue DTO parses to itself
      When jiraIssueDtoSchema parses the valid issue DTO
      Then the result deep-equals the valid issue DTO

    @happy
    Scenario: Every nullable field accepts null
      When jiraIssueDtoSchema parses the valid issue DTO with assignee, priority, projectKey, parentKey, created, updated, dueDate and url all null
      Then the parse succeeds with those fields null

    @boundary
    Scenario: A description, or any other unknown key, is dropped
      When jiraIssueDtoSchema parses the valid issue DTO plus { description: "secret client text", fields: {} }
      Then the result deep-equals the valid issue DTO

    @boundary
    Scenario: Strings are not otherwise constrained
      When jiraIssueDtoSchema parses the valid issue DTO with summary "" and key "not a key" and created "yesterday"
      Then the parse succeeds with those values unchanged

    @unhappy
    Scenario: Malformed issue DTOs are refused
      When jiraIssueDtoSchema safe-parses the valid issue DTO with one field changed
      Then success is false
        | field          | value     |
        | statusCategory | To Do     |
        | assignee       | (missing) |
        | url            | (missing) |
        | labels         | null      |
        | issueType      | null      |
        | id             | 10001 (a number) |

    @happy
    Scenario: jiraIssuePageDtoSchema wraps issues with optional cursors
      When jiraIssuePageDtoSchema parses { issues: [the valid issue DTO] }
      Then the result deep-equals the input
      And parsing { issues: [], total: 0, nextStartAt: 50 } returns the input unchanged
      And parsing { issues: [], nextPageToken: "tok" } returns the input unchanged

    @unhappy
    Scenario: An issue page DTO without issues is refused
      When jiraIssuePageDtoSchema safe-parses {}
      Then success is false

  Rule: The board, sprint and site DTOs are flat and strip unknown keys

    @happy
    Scenario: A well-formed board DTO parses to itself, and nulls are accepted for the project
      When jiraBoardDtoSchema parses the valid board DTO
      Then the result deep-equals the valid board DTO
      And parsing it with projectKey null and projectName null succeeds

    @unhappy
    Scenario: Malformed board DTOs are refused
      When jiraBoardDtoSchema safe-parses the valid board DTO with one field changed
      Then success is false
        | field      | value       |
        | id         | "7"         |
        | type       | (missing)   |
        | projectKey | (missing)   |

    @happy
    Scenario: A sprint DTO with null dates and goal parses to itself
      When jiraSprintDtoSchema parses { id: 3, name: "Sprint 3", state: "active", startDate: null, endDate: null, goal: null }
      Then the result deep-equals the input

    @unhappy
    Scenario: A sprint DTO missing its state is refused
      When jiraSprintDtoSchema safe-parses { id: 3, name: "Sprint 3", startDate: null, endDate: null, goal: null }
      Then success is false

    @happy
    Scenario: A site DTO parses with or without an avatar, and drops scopes
      When jiraSiteDtoSchema parses { cloudId: "cloud-1", url: "https://acme.atlassian.net", name: "Acme" }
      Then the result deep-equals the input
      And parsing it plus { avatarUrl: "https://x.test/a.png" } returns that input unchanged
      And parsing it plus { scopes: ["read:jira-work"] } returns it without scopes

    @unhappy
    Scenario: A site DTO missing its cloudId is refused
      When jiraSiteDtoSchema safe-parses { url: "https://acme.atlassian.net", name: "Acme" }
      Then success is false

  Rule: The existing contract is unchanged

    @happy
    Scenario: Existing schemas behave as before
      When todoSchema parses { id: "todo_1", title: "write tests", done: false, createdAt: "2026-09-16T00:00:00.000Z" }
      Then the result deep-equals the input
      And handleSchema parses "  FeverSoul  " to "feversoul"
      And buildInfoSchema and UNKNOWN_BUILD are still exported from the package index
```

Decided:

- The helper is named `trimTrailingSlashes(value: string): string` and is exported from the shared package.
  Ticket: "Replaced with a backwards scan in one shared helper"
  Instead: the name `stripTrailingSlashes` (the commit title's verb), or keeping the helper internal to the Jira package.
- Only U+002F counts as a slash. Backslashes and trailing whitespace are kept, and `""` and all-slash strings return `""`.
  Ticket: "strip trailing slashes without a backtracking regex"
  Instead: also stripping backslashes or trailing whitespace.
- The linear-time requirement is pinned at under 250 ms for 60,000 slashes (also tested at 1,000,000), including the case where non-slash text follows the slashes.
  Ticket: "pinned by a test that fails on the old implementation (1300ms against a 250ms threshold)"
  Instead: an operation-count bound, or a timing test only on the trailing-slash case.
- The contract has two families: permissive `*Response` schemas for what Atlassian sends, and strict `*Dto` schemas for what we hand on. There is no connection, connect-body or site-URL schema in shared.
  Ticket: "recover the Jira integration package and its wire contract"
  Instead: a connection DTO, a `POST /api/v1/jira/connections` body schema and a validating `jiraSiteUrlSchema`.
- Response schemas require only what Jira guarantees: `id` and `key` on an issue, numeric `id` and `name` on a board or sprint, `access_token` and `expires_in` on a token, `id`, `url` and `name` on an accessible resource. Everything else is optional or nullish.
  Ticket: silent.
  Instead: requiring `summary`, `status` and the like, which fails a whole page when one project hides a field.
- Response objects keep unknown keys (`.loose()`) at every level. DTO objects strip them, so an issue `description` never reaches the wire.
  Ticket: silent.
  Instead: stripping in both families, or `z.strictObject`, which refuses unknown keys.
- Missing lists default to `[]`: `issues` on an issue page, `values` on board and sprint pages, `scopes` on an accessible resource.
  Ticket: silent.
  Instead: refusing a page without its list.
- `JIRA_STATUS_CATEGORIES` is `new`, `indeterminate`, `done` plus our own `unknown`. The schema refuses anything else (`To Do`, `Done`, Jira's `undefined`) and does not map it. The response schema keeps the category `key` as a free string.
  Ticket: silent.
  Instead: Jira's three categories only, or coercing unrecognised values into `new`.
- Board and sprint ids are numbers and issue ids are strings, as Jira sends them, in both the response and DTO schemas.
  Ticket: silent.
  Instead: our own prefixed string ids (`jrb_…`, `jri_…`).
- The issue DTO has `id`, `key`, `summary`, `status`, `statusCategory`, `assignee`, `priority`, `issueType`, `labels`, `projectKey`, `parentKey`, `created`, `updated`, `dueDate` and `url`. Every key is required, and the optional-in-Jira ones are nullable rather than optional.
  Ticket: silent.
  Instead: optional keys, or a smaller shape with a `boardId`.
- DTO strings are plain `z.string()`: no non-empty check, no issue-key pattern, no datetime or URL check. `assignee` is a display name and `url` may be `null`.
  Ticket: silent.
  Instead: `min(1)`, an issue-key regex such as `/^[A-Z][A-Z0-9_]*-[0-9]+$/`, `z.iso.datetime()` and `z.url()`.
- The issue page DTO carries `issues` plus optional `total`, `nextStartAt` and `nextPageToken`. The board, sprint and site DTOs are not wrapped in list schemas.
  Ticket: silent.
  Instead: `{ boards: [...] }` / `{ issues: [...] }` list wrappers.
- There are no `@concurrency` scenarios. Every export is a pure function or a stateless schema, so overlapping calls cannot interact.
  Ticket: silent.
  Instead: a scenario that runs parallel parses and checks they are independent.
- Every existing export keeps its name, signature and behaviour. The change only adds exports.
  Ticket: "The change keeps the exports' names and signatures."
  Instead: renaming or folding existing exports into a Jira namespace.
