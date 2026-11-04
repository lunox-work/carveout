# GitHub App installations and repository pointers: the wire contract

Issue #66 connects an organization to GitHub through a GitHub App
installation and tracks the repositories that the organization points at.
The ticket gives only its title, so this spec defines the contract that
`packages/shared` adds for that feature. It is a set of zod schemas,
constants, inferred types and two small pure helpers, in the same style as
the Jira contract in `src/jira.ts`. There are three families of schemas, and
they behave differently:

- **`*ResponseSchema` and `*EventSchema` (what GitHub sends: REST responses
  and webhook deliveries).** These are permissive. Only the fields GitHub
  always sends are required. They use `.loose()`, so an unknown field is kept
  instead of failing the parse. This follows the doctrine `jira.ts` states.
- **`*DtoSchema` (what we hand on to the web app).** These are strict
  (`z.strictObject`): every field is required, and an unknown key fails the
  parse. Their string fields are plain strings with no format or length
  check, because we produce them.
- **`*RequestSchema` (bodies our own clients send).** Plain `z.object`:
  unknown keys are stripped, and ids must be GitHub id text (see below).

The exports are defined in a new `src/github.ts`, and `index.ts` adds
`export * from "./github.js";`, which is how `jira.ts` is exposed. Every new
export can be imported from `packages/shared/src/index.ts`. All exports are
pure: they use no clock, network, storage or shared state, so no calls can
overlap.

## Exports added

```ts
// What GitHub sends (permissive, .loose()).
export const githubInstallationResponseSchema;          // one installation
export const githubInstallationPageResponseSchema;      // { total_count?, installations: [...] }
export const githubRepositoryResponseSchema;            // one repository
export const githubRepositoryPageResponseSchema;        // { total_count?, repository_selection?, repositories: [...] }
export const githubUserResponseSchema;                  // GET /user
export const githubRefResponseSchema;                   // GET /repos/{o}/{r}/git/ref/heads/{branch}
export const githubInstallationTokenResponseSchema;     // POST /app/installations/{id}/access_tokens
export const githubOAuthTokenResponseSchema;            // POST https://github.com/login/oauth/access_token
export const githubWebhookEnvelopeSchema;               // { action?, installation?: { id } }
export const githubInstallationEventSchema;
export const githubInstallationRepositoriesEventSchema;
export const githubPushEventSchema;
export const githubRepositoryEventSchema;

export const GITHUB_WEBHOOK_HEADERS = {
  event: "x-github-event",
  delivery: "x-github-delivery",
  signature: "x-hub-signature-256",
} as const;

// An ISO string from GitHub's ISO-string or Unix-seconds timestamps, or null.
export function githubTimestamp(value: string | number | null | undefined): string | null;

// Closed vocabularies, in this exact order.
export const GITHUB_REPO_ROLES = ["source"] as const;
export const githubRepoRoleSchema = z.enum(GITHUB_REPO_ROLES);

export const GITHUB_SYNC_STATUSES = ["pending", "ok", "error", "gone"] as const;
export const githubSyncStatusSchema = z.enum(GITHUB_SYNC_STATUSES);

export const GITHUB_INSTALLATION_STATUSES =
  ["linked", "claimed", "free", "not-authorized", "unavailable"] as const;

export const GITHUB_CONNECT_OUTCOMES = [
  "connected", "pick", "cancelled", "state", "forbidden", "not-visible",
  "claimed", "not-authorized", "unavailable", "denied", "error",
] as const;
export const githubConnectOutcomeSchema = z.enum(GITHUB_CONNECT_OUTCOMES);

// What we hand on (strict, z.strictObject).
export const githubConnectionDtoSchema;               // one installation linked to an organization
export const githubGrantDtoSchema;                    // the signed-in person's own GitHub grant
export const githubAvailableInstallationDtoSchema;    // an installation the person can see
export const githubInstallationRepositoryDtoSchema;   // a repository an installation can see
export const githubRepoDtoSchema;                     // a registered repository: the pointer

// Bodies our clients send (z.object, unknown keys stripped).
export const registerRepoRequestSchema;      // POST .../github/connections/:id/repositories
export const linkInstallationRequestSchema;  // POST .../github/connections

// The installation's settings page on GitHub.
export function githubInstallationSettingsUrl(
  accountType: string,
  accountLogin: string,
  installationId: string,
): string;

export type GithubInstallationResponse = z.infer<typeof githubInstallationResponseSchema>;
export type GithubRepositoryResponse = z.infer<typeof githubRepositoryResponseSchema>;
export type GithubUserResponse = z.infer<typeof githubUserResponseSchema>;
export type GithubInstallationEvent = z.infer<typeof githubInstallationEventSchema>;
export type GithubInstallationRepositoriesEvent = z.infer<typeof githubInstallationRepositoriesEventSchema>;
export type GithubPushEvent = z.infer<typeof githubPushEventSchema>;
export type GithubRepositoryEvent = z.infer<typeof githubRepositoryEventSchema>;
export type GithubRepoRole = z.infer<typeof githubRepoRoleSchema>;
export type GithubSyncStatus = z.infer<typeof githubSyncStatusSchema>;
export type GithubConnectionDto = z.infer<typeof githubConnectionDtoSchema>;
export type GithubGrantDto = z.infer<typeof githubGrantDtoSchema>;
export type GithubAvailableInstallationDto = z.infer<typeof githubAvailableInstallationDtoSchema>;
export type GithubInstallationRepositoryDto = z.infer<typeof githubInstallationRepositoryDtoSchema>;
export type GithubRepoDto = z.infer<typeof githubRepoDtoSchema>;
export type RegisterRepoRequest = z.infer<typeof registerRepoRequestSchema>;
export type LinkInstallationRequest = z.infer<typeof linkInstallationRequestSchema>;
export type GithubConnectOutcome = z.infer<typeof githubConnectOutcomeSchema>;
```

### Shapes

"Integer" means `z.number().int()`: a whole number within ±`Number.MAX_SAFE_INTEGER`.
Zero and negatives are not refused.

| Schema                                           | Field                    | Type (parsed output)                                                     |
| ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------ |
| `githubInstallationResponseSchema` (loose)       | `id`                     | required integer                                                         |
|                                                  | `account`                | optional, nullable; loose `{ login: string; id?: number; type?: string }` |
|                                                  | `repository_selection`   | optional `string` (any value)                                            |
|                                                  | `permissions`            | optional `Record<string, string>`                                        |
|                                                  | `suspended_at`           | optional, nullable `string`                                              |
| `githubInstallationPageResponseSchema` (loose)   | `total_count`            | optional `number`                                                        |
|                                                  | `installations`          | required `GithubInstallationResponse[]`                                  |
| `githubRepositoryResponseSchema` (loose)         | `id`                     | required integer                                                         |
|                                                  | `full_name`              | required `string` (any value, even `""`)                                 |
|                                                  | `private`                | optional `boolean`                                                       |
|                                                  | `default_branch`         | optional `string`                                                        |
|                                                  | `size`                   | optional `number` (kilobytes)                                            |
|                                                  | `pushed_at`              | optional `string \| number \| null` (ISO string or Unix seconds)         |
| `githubRepositoryPageResponseSchema` (loose)     | `total_count`            | optional `number`                                                        |
|                                                  | `repository_selection`   | optional `string`                                                        |
|                                                  | `repositories`           | required `GithubRepositoryResponse[]` (no default)                       |
| `githubUserResponseSchema` (loose)               | `login`, `id`            | required `string`, required integer                                      |
| `githubRefResponseSchema` (loose)                | `ref`, `object`          | optional `string`; required loose `{ sha: string }`                      |
| `githubInstallationTokenResponseSchema` (loose)  | `token`, `expires_at`    | required `string` length ≥ 1; required `string`                          |
| `githubOAuthTokenResponseSchema` (loose)         | all fields optional      | `access_token`, `refresh_token` (length ≥ 1), `expires_in`, `refresh_token_expires_in` (number), `error`, `error_description` (string) |
| `githubWebhookEnvelopeSchema` (loose)            | `action`, `installation` | optional `string`; optional loose `{ id: integer }`                      |
| `githubInstallationEventSchema` (loose)          | `action`, `installation` | required `string`; required `GithubInstallationResponse`                 |
| `githubInstallationRepositoriesEventSchema` (loose) | `action`, `installation` | required `string`; required `GithubInstallationResponse`             |
|                                                  | `repository_selection`   | optional `string`                                                        |
|                                                  | `repositories_added`, `repositories_removed` | optional arrays of loose `{ id: integer; full_name?: string }` |
| `githubPushEventSchema` (loose)                  | `ref`, `after`           | required `string`                                                        |
|                                                  | `deleted`                | optional `boolean`                                                       |
|                                                  | `repository`             | required `GithubRepositoryResponse`                                      |
|                                                  | `installation`           | optional loose `{ id: integer }`                                         |
| `githubRepositoryEventSchema` (loose)            | `action`, `repository`   | required `string`; required `GithubRepositoryResponse`                   |
|                                                  | `changes`                | optional loose `{ default_branch?: loose { from: string } }`             |
|                                                  | `installation`           | optional loose `{ id: integer }`                                         |
| `githubConnectionDtoSchema` (strict)             | `id`                     | `string` (our row id)                                                    |
|                                                  | `installationId`         | `string` (GitHub's installation id as text)                              |
|                                                  | `accountLogin`           | `string`                                                                 |
|                                                  | `accountType`            | `string` (GitHub's casing, e.g. `Organization`, `User`)                  |
|                                                  | `repositorySelection`    | `string`                                                                 |
|                                                  | `healthy`                | `boolean`                                                                |
|                                                  | `suspendedAt`            | `string \| null`                                                         |
|                                                  | `uninstalledAt`          | `string \| null`                                                         |
|                                                  | `settingsUrl`            | `string`                                                                 |
|                                                  | `createdAt`              | `string`                                                                 |
| `githubGrantDtoSchema` (strict)                  | `githubLogin`, `healthy` | `string`; `boolean`                                                      |
| `githubAvailableInstallationDtoSchema` (strict)  | `installationId`         | `string`                                                                 |
|                                                  | `accountLogin`, `accountType`, `repositorySelection` | `string`                                     |
|                                                  | `status`                 | one of `GITHUB_INSTALLATION_STATUSES`                                    |
| `githubInstallationRepositoryDtoSchema` (strict) | `externalId`             | `string` (GitHub's repository id as text)                                |
|                                                  | `fullName`               | `string`                                                                 |
|                                                  | `defaultBranch`          | `string`                                                                 |
|                                                  | `isPrivate`              | `boolean`                                                                |
|                                                  | `registeredId`           | `string \| null` (the registered row's id, if registered)                |
| `githubRepoDtoSchema` (strict)                   | `id`                     | `string` (our row id)                                                    |
|                                                  | `connectionId`           | `string` (our connection row id, not GitHub's number)                    |
|                                                  | `role`                   | `GithubRepoRole`                                                         |
|                                                  | `externalId`             | `string` (GitHub's repository id as text)                                |
|                                                  | `fullName`               | `string`                                                                 |
|                                                  | `defaultBranch`          | `string`                                                                 |
|                                                  | `isPrivate`              | `boolean`                                                                |
|                                                  | `sizeKb`                 | `number \| null`                                                         |
|                                                  | `headSha`                | `string \| null`                                                         |
|                                                  | `pushedAt`               | `string \| null`                                                         |
|                                                  | `lastSyncedAt`           | `string \| null`                                                         |
|                                                  | `syncStatus`             | `GithubSyncStatus`                                                       |
|                                                  | `syncError`              | `string \| null`                                                         |
|                                                  | `createdAt`              | `string`                                                                 |
| `registerRepoRequestSchema`                      | `externalId`             | GitHub id text (string)                                                  |
|                                                  | `role`                   | `GithubRepoRole`                                                         |
| `linkInstallationRequestSchema`                  | `installationId`         | GitHub id text (string)                                                  |

A repository pointer refers to a repository by its permanent GitHub id
(`externalId`). `fullName` is only the name last seen. Repositories can be
renamed and transferred, just as the `slug` of `organizationSummarySchema` is
renameable and never a foreign key.

**GitHub id text** is a string matching `^[1-9][0-9]{0,18}$`: 1 to 19 decimal
digits with no leading zero. There is no safe-integer cap. When it fails, the
issue message is `Expected a GitHub id.` It is checked only in
`registerRepoRequestSchema` and `linkInstallationRequestSchema`, and it stays a
string there. The DTOs' id fields are plain strings.

### Existing exports keep their behaviour

Every export already in `index.ts` keeps its name, signature and behaviour:
`handleSchema`, the organization, membership, invitation and error schemas,
their constants and types, and everything re-exported from `build-info.js`,
`bounty.js`, `spec.js`, `jira.js` and `identicon.js`. No existing export is
renamed, widened or narrowed.

```gherkin
Feature: GitHub App installation and repository pointer wire contract
  The shared package exports the schemas that the API, the web app and the
  extension use to connect GitHub App installations and to track repositories
  by GitHub's permanent id.

  Background:
    Given every export below is imported from "packages/shared/src/index.ts"

  Rule: The vocabularies are closed and listed in a fixed order

    @happy
    Scenario: The constants list their values in order
      Then GITHUB_REPO_ROLES equals ["source"]
      And GITHUB_SYNC_STATUSES equals ["pending", "ok", "error", "gone"]
      And GITHUB_INSTALLATION_STATUSES equals ["linked", "claimed", "free", "not-authorized", "unavailable"]
      And GITHUB_CONNECT_OUTCOMES equals ["connected", "pick", "cancelled", "state", "forbidden", "not-visible", "claimed", "not-authorized", "unavailable", "denied", "error"]
      And GITHUB_WEBHOOK_HEADERS equals { event: "x-github-event", delivery: "x-github-delivery", signature: "x-hub-signature-256" }

    @happy
    Scenario Outline: Each enum schema accepts its own values
      When <schema> parses "<value>"
      Then the parse succeeds with "<value>"

      Examples:
        | schema                     | value          |
        | githubRepoRoleSchema       | source         |
        | githubSyncStatusSchema     | pending        |
        | githubSyncStatusSchema     | ok             |
        | githubSyncStatusSchema     | error          |
        | githubSyncStatusSchema     | gone           |
        | githubConnectOutcomeSchema | connected      |
        | githubConnectOutcomeSchema | not-authorized |
        | githubConnectOutcomeSchema | error          |

    @unhappy
    Scenario Outline: An enum schema refuses other casing and unknown values
      When <schema> safe-parses "<value>"
      Then the parse fails

      Examples:
        | schema                     | value     |
        | githubRepoRoleSchema       | sandbox   |
        | githubRepoRoleSchema       | Source    |
        | githubSyncStatusSchema     | OK        |
        | githubSyncStatusSchema     | stale     |
        | githubConnectOutcomeSchema | success   |

    @unhappy
    Scenario: An available installation's status is closed
      When githubAvailableInstallationDtoSchema safe-parses { installationId: "42", accountLogin: "o", accountType: "User", repositorySelection: "all", status: "owned" }
      Then the parse fails at path ["status"]

    @happy
    Scenario Outline: Account type and repository selection are free strings in GitHub's casing
      When githubConnectionDtoSchema parses the complete connection DTO with accountType "<accountType>" and repositorySelection "<selection>"
      Then the parse succeeds with accountType "<accountType>" and repositorySelection "<selection>"

      Examples:
        | accountType  | selection |
        | Organization | selected  |
        | User         | all       |
        | Enterprise   | some      |

  Rule: A GitHub id in a request body is 1 to 19 digits with no leading zero

    @happy
    Scenario Outline: A canonical id is accepted and kept as a string
      When registerRepoRequestSchema parses { externalId: "<id>", role: "source" }
      Then the parse succeeds
      And externalId is the string "<id>"

      Examples:
        | id                  |
        | 1                   |
        | 123456789           |
        | 9007199254740991    |
        | 9007199254740992    |
        | 9999999999999999999 |

    @boundary
    Scenario: A twenty-digit id is refused
      When registerRepoRequestSchema safe-parses { externalId: "10000000000000000000", role: "source" }
      Then the parse fails with the message "Expected a GitHub id." at path ["externalId"]

    @unhappy
    Scenario Outline: A non-canonical id is refused rather than normalised
      When registerRepoRequestSchema safe-parses { externalId: "<id>", role: "source" }
      Then the parse fails with the message "Expected a GitHub id." at path ["externalId"]

      Examples:
        | id    |
        |       |
        | 0     |
        | 0123  |
        | -1    |
        | +1    |
        | 1.5   |
        | 1e3   |
        | " 12" |
        | abc   |

    @unhappy
    Scenario: A numeric externalId is refused, not coerced
      When registerRepoRequestSchema safe-parses { externalId: 123, role: "source" }
      Then the parse fails at path ["externalId"]

    @happy
    Scenario: The link body takes GitHub's installation id as text
      When linkInstallationRequestSchema parses { installationId: "42" }
      Then the result is { installationId: "42" }

    @unhappy
    Scenario Outline: The link body refuses an id that is not GitHub id text
      When linkInstallationRequestSchema safe-parses { installationId: <id> }
      Then the parse fails at path ["installationId"]

      Examples:
        | id    |
        | 42    |
        | "0"   |
        | "042" |
        | ""    |

  Rule: GitHub's payloads are parsed permissively and keep unknown fields

    @happy
    Scenario: An installation parses with nothing but its id
      When githubInstallationResponseSchema parses { id: 42 }
      Then the result is { id: 42 }
      And account, repository_selection, permissions and suspended_at are undefined

    @happy
    Scenario: An installation with a null account, an unfamiliar selection and an unknown field parses
      When githubInstallationResponseSchema parses { id: 42, account: null, repository_selection: "some", suspended_at: null, somethingNew: true }
      Then account is null
      And repository_selection is "some"
      And suspended_at is null
      And somethingNew is true

    @happy
    Scenario: An installation's account type is any string
      When githubInstallationResponseSchema parses { id: 42, account: { login: "o", type: "Enterprise" } }
      Then account is { login: "o", type: "Enterprise" }

    @boundary
    Scenario Outline: An installation id is any safe integer, including zero and negatives
      When githubInstallationResponseSchema parses { id: <id> }
      Then the result's id is <id>

      Examples:
        | id               |
        | 0                |
        | -1               |
        | 9007199254740991 |

    @unhappy
    Scenario Outline: An installation without a usable id or with an account lacking its login is refused
      When githubInstallationResponseSchema safe-parses <payload>
      Then the parse fails

      Examples:
        | payload                      |
        | {}                           |
        | { id: "42" }                 |
        | { id: 1.5 }                  |
        | { id: 9007199254740992 }     |
        | { id: 42, account: {} }      |

    @happy
    Scenario: A repository parses with only its id and full name, keeping unknown fields
      When githubRepositoryResponseSchema parses { id: 7, full_name: "octo/hello", topics: ["x"] }
      Then id is 7 and full_name is "octo/hello"
      And private, default_branch, size and pushed_at are undefined
      And topics is ["x"]

    @happy
    Scenario Outline: A repository's pushed_at may be an ISO string, Unix seconds or null
      When githubRepositoryResponseSchema parses { id: 7, full_name: "octo/hello", pushed_at: <pushedAt> }
      Then pushed_at is <pushedAt>

      Examples:
        | pushedAt               |
        | "2026-11-01T00:00:00Z" |
        | 1700000000             |
        | null                   |

    @unhappy
    Scenario Outline: A repository without its id or full name is refused
      When githubRepositoryResponseSchema safe-parses <payload>
      Then the parse fails

      Examples:
        | payload                   |
        | { full_name: "octo/a" }   |
        | { id: 7 }                 |

    @unhappy
    Scenario: A repository page without its repositories array is refused
      When githubRepositoryPageResponseSchema safe-parses {}
      Then the parse fails at path ["repositories"]

    @boundary
    Scenario: A repository page with an empty array parses as empty
      When githubRepositoryPageResponseSchema parses { repositories: [] }
      Then repositories is []
      And total_count is undefined

    @happy
    Scenario: A repository page keeps its repositories in the order GitHub sent
      When githubRepositoryPageResponseSchema parses { total_count: 2, repositories: [{ id: 2, full_name: "o/b" }, { id: 1, full_name: "o/a" }] }
      Then the repository ids are [2, 1]

    @happy
    Scenario Outline: githubTimestamp reads either spelling as ISO, and anything else as null
      When githubTimestamp is called with <value>
      Then it returns <result>

      Examples:
        | value                  | result                     |
        | 1700000000             | "2023-11-14T22:13:20.000Z" |
        | "2026-11-01T00:00:00Z" | "2026-11-01T00:00:00.000Z" |
        | null                   | null                       |
        | undefined              | null                       |
        | "nope"                 | null                       |

  Rule: The DTOs we produce are strict: every field required, unknown keys refused

    @happy
    Scenario: A complete connection DTO round-trips
      Given the connection DTO
        """
        { "id": "ghc_1", "installationId": "42", "accountLogin": "octo-org",
          "accountType": "Organization", "repositorySelection": "selected",
          "healthy": true, "suspendedAt": null, "uninstalledAt": null,
          "settingsUrl": "https://github.com/organizations/octo-org/settings/installations/42",
          "createdAt": "2026-11-01T00:00:00.000Z" }
        """
      When githubConnectionDtoSchema parses it
      Then the result deep-equals the input

    @unhappy
    Scenario Outline: A connection DTO missing or mistyping a field is refused
      When githubConnectionDtoSchema safe-parses the complete connection DTO with <change>
      Then the parse fails

      Examples:
        | change                       |
        | id removed                   |
        | installationId removed       |
        | accountLogin removed         |
        | accountType removed          |
        | repositorySelection removed  |
        | healthy removed              |
        | suspendedAt removed          |
        | uninstalledAt removed        |
        | settingsUrl removed          |
        | createdAt removed            |
        | installationId set to 42     |
        | healthy set to null          |

    @boundary
    Scenario: DTO strings carry no format or length check
      When githubConnectionDtoSchema parses the complete connection DTO with id "" and createdAt "yesterday"
      Then the parse succeeds with id "" and createdAt "yesterday"

    @unhappy
    Scenario: An unknown key on a DTO is refused
      When githubConnectionDtoSchema safe-parses the complete connection DTO plus { token: "secret" }
      Then the parse fails with the message 'Unrecognized key: "token"'

    @happy
    Scenario: A complete installation repository DTO round-trips
      Given the installation repository DTO { externalId: "7", fullName: "octo/hello", defaultBranch: "main", isPrivate: true, registeredId: null }
      When githubInstallationRepositoryDtoSchema parses it
      Then the result deep-equals the input

    @happy
    Scenario: A complete registered repository DTO round-trips
      Given the repo DTO
        """
        { "id": "ghr_1", "connectionId": "ghc_1", "role": "source",
          "externalId": "7", "fullName": "Octo/Hello", "defaultBranch": "main",
          "isPrivate": true, "sizeKb": null, "headSha": null, "pushedAt": null,
          "lastSyncedAt": null, "syncStatus": "pending", "syncError": null,
          "createdAt": "2026-11-01T00:00:00.000Z" }
        """
      When githubRepoDtoSchema parses it
      Then the result deep-equals the input

    @happy
    Scenario: The grant DTO carries the login and health, never tokens
      When githubGrantDtoSchema parses { githubLogin: "octocat", healthy: true }
      Then the result is { githubLogin: "octocat", healthy: true }
      And githubGrantDtoSchema safe-parsing { githubLogin: "octocat", healthy: true, accessToken: "t" } fails

    @unhappy
    Scenario Outline: A repository DTO with a bad field is refused
      When <schema> safe-parses its complete DTO with <change>
      Then the parse fails

      Examples:
        | schema                                | change                       |
        | githubInstallationRepositoryDtoSchema | externalId set to 7          |
        | githubInstallationRepositoryDtoSchema | isPrivate removed            |
        | githubInstallationRepositoryDtoSchema | registeredId removed         |
        | githubInstallationRepositoryDtoSchema | archived set to false        |
        | githubRepoDtoSchema                   | externalId set to 7          |
        | githubRepoDtoSchema                   | connectionId set to 42       |
        | githubRepoDtoSchema                   | role set to "sandbox"        |
        | githubRepoDtoSchema                   | syncStatus set to "stale"    |
        | githubRepoDtoSchema                   | headSha removed              |
        | githubRepoDtoSchema                   | defaultBranch removed        |

  Rule: Registering a repository names GitHub's repository id and its role

    @happy
    Scenario: A register body parses unchanged
      When registerRepoRequestSchema parses { externalId: "7", role: "source" }
      Then the result is { externalId: "7", role: "source" }

    @happy
    Scenario: Unknown keys in a register body are stripped
      # The full name is read from GitHub, never taken from the client; the connection is in the path.
      When registerRepoRequestSchema parses { externalId: "7", role: "source", fullName: "octo/hello", connectionId: "ghc_1" }
      Then the result is exactly { externalId: "7", role: "source" }

    @unhappy
    Scenario Outline: A register body without a valid role is refused
      When registerRepoRequestSchema safe-parses <body>
      Then the parse fails at path ["role"]

      Examples:
        | body                                    |
        | { externalId: "7" }                     |
        | { externalId: "7", role: "sandbox" }    |

  Rule: The settings URL points at the account's installation settings on GitHub

    @happy
    Scenario Outline: githubInstallationSettingsUrl builds the page for the account type
      When githubInstallationSettingsUrl is called with ("<accountType>", "<login>", "<id>")
      Then it returns "<url>"

      Examples:
        | accountType  | login    | id | url                                                                 |
        | Organization | octo-org | 42 | https://github.com/organizations/octo-org/settings/installations/42 |
        | User         | octocat  | 7  | https://github.com/settings/installations/7                         |
        | organization | octo-org | 42 | https://github.com/settings/installations/42                        |

  Rule: Existing exports are unchanged

    @happy
    Scenario: The organization and Jira contracts still parse as before
      When organizationSummarySchema parses { id: "org_1", name: "Acme", slug: "acme" }
      Then kind is "team"
      And registerBoardSchema still parses { connectionId: "c1", externalId: "10" } unchanged
      And handleSchema still parses "  FeverSoul  " to "feversoul"
```

Decided:

- What "repository pointer" means: a registered repository row (`githubRepoDtoSchema`) keyed by GitHub's permanent numeric id, with the full name, default branch and head commit SHA last read, and a sync status. It never holds contents.
  Ticket: "feat(github): connect GitHub App installations and track repository pointers (#66)"
  Instead: only a git ref pointer (a branch name mapped to a commit SHA), or only the id and full name with no head or sync state.
- Which exports the change adds: schemas, constants and types, plus two pure helpers. `githubTimestamp(1700000000)` returns `"2023-11-14T22:13:20.000Z"`, `githubTimestamp("nope")` returns `null`, and `githubInstallationSettingsUrl("Organization", "octo-org", "42")` returns `"https://github.com/organizations/octo-org/settings/installations/42"`. Any other account type gives `https://github.com/settings/installations/<id>`. GitHub-to-DTO mapping belongs to the integration package, as Jira's does.
  Ticket: silent.
  Instead: no functions at all, or also export mapping helpers such as `toGithubConnectionDto`.
- Where the exports live: in a new `src/github.ts` that `index.ts` re-exports with `export * from "./github.js";`.
  Ticket: "The change keeps the exports' names and signatures."
  Instead: define everything inline in `index.ts`.
- Existing exports: unchanged in name, signature and behaviour.
  Ticket: "The change keeps the exports' names and signatures."
  Instead: rename or extend existing schemas (such as `registerBoardSchema`) to cover GitHub.
- How strict the GitHub response and event schemas are: `.loose()`. Only `id` is required on an installation, `id` and `full_name` on a repository, and `login` on an account when one is given. `repository_selection` and `account.type` are free strings.
  Ticket: silent.
  Instead: strict schemas with closed enums for GitHub's fields.
- The id type for GitHub ids sent by GitHub: `z.number().int()`, which takes any safe integer, including `0` and `-1`. `1.5`, `9007199254740992` and the string `"42"` are refused.
  Ticket: silent.
  Instead: `z.coerce.number()` accepting numeric strings, or a minimum of 1.
- How a repository page without `repositories` is treated: it is refused. There is no default to `[]`.
  Ticket: silent.
  Instead: default `repositories` to `[]`.
- The type of ids in our DTOs and bodies: strings, never numbers, matching Jira's `externalId`. This covers GitHub's installation id (`installationId: "42"`) as well as repository ids.
  Ticket: silent.
  Instead: JSON numbers.
- Which id strings a request body accepts: `^[1-9][0-9]{0,18}$`, so 1 to 19 digits with no safe-integer cap. `"9007199254740992"` and `"9999999999999999999"` are accepted, and `"10000000000000000000"` is refused. Leading zeros, signs, whitespace, decimals and exponents are refused with the message `Expected a GitHub id.` DTO id fields are not checked.
  Ticket: silent.
  Instead: cap at `Number.MAX_SAFE_INTEGER`, trim and normalise (`"0123"` becomes `"123"`), or allow any non-empty string as `registerBoardSchema` does.
- The full-name format: not checked. `fullName` and `full_name` are any string, case kept, nothing trimmed.
  Ticket: silent.
  Instead: enforce GitHub's owner/name character rules with a message such as `Must be owner/name.`
- Account type and repository selection values: free strings in GitHub's casing (`Organization`, `User`, `Enterprise`, `all`, `selected`) in both responses and DTOs, with no closed vocabulary exported.
  Ticket: silent.
  Instead: closed lowercase enums `["user", "organization"]` and `["all", "selected"]`.
- The setup callback: not part of the shared contract, and no setup-action vocabulary or callback schema is exported. How the connect callback ends is the closed vocabulary `GITHUB_CONNECT_OUTCOMES`.
  Ticket: silent.
  Instead: export a `githubSetupCallbackSchema` that maps `installation_id`, `setup_action` and `state` to camelCase.
- Unknown keys: refused in DTOs (`z.strictObject`, with message `Unrecognized key: "<key>"`), stripped in request bodies, and kept in GitHub responses and events.
  Ticket: silent.
  Instead: strip them in DTOs as well.
- What the register body names: GitHub's repository id and a `role`, which must be `"source"`. The connection is our row id in the path (`POST .../github/connections/:id/repositories`), not a body field. The link body names GitHub's installation id as text.
  Ticket: silent.
  Instead: put our installation row id in the body, or take GitHub's `installation_id` as a number.
- Repository roles: only `source`, so `sandbox` is refused until the sandbox phase widens `GITHUB_REPO_ROLES`.
  Ticket: silent.
  Instead: admit `sandbox` now.
- Defaults and nullability in DTOs: no defaults, and every field is required. These fields are nullable: `suspendedAt`, `uninstalledAt`, `registeredId`, `sizeKb`, `headSha`, `pushedAt`, `lastSyncedAt` and `syncError`. Strings carry no length or format check, so `defaultBranch: ""` and `createdAt: "yesterday"` are accepted.
  Ticket: silent.
  Instead: require non-empty strings and `z.iso.datetime()` timestamps.
- List wrappers: none exported. The shared package has no `{ installations }`, `{ repositories }` or `{ pointers }` DTO list schemas.
  Ticket: silent.
  Instead: export `githubInstallationListSchema`, `githubRepositoryListSchema` and `githubRepositoryPointerListSchema`.
- List ordering: arrays keep their input order, and the schemas neither sort nor deduplicate.
  Ticket: silent.
  Instead: sort by full name or deduplicate by `externalId` during parsing.
- Concurrency: none applies. All exports are stateless schemas and pure functions, so the spec has no `@concurrency` scenarios.
  Ticket: silent.
  Instead: specify idempotent tracking of the same repository twice, which belongs to the store, not this seam.
