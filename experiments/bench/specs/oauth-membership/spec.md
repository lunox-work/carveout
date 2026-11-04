# Re-check membership when the Jira OAuth callback lands

The Jira connection flow checks membership and role once, when
`GET /api/v1/orgs/:orgId/jira/connect` starts it, then trusts the signed
`state` at `GET /api/v1/jira/callback` for up to ten minutes. A user removed
from the organization, or demoted to a plain member, inside that window can
still finish the flow and attach a Jira site to an organization they no longer
administer. This change makes the callback ask the organization store again,
for the organization named in the verified state, before it spends the
authorization code. `createApp` in `apps/api/src/routes.ts` supplies that
lookup from `organizations.roleOf`, so `AppOptions.jira` no longer carries it.

## Interface

`apps/api/src/routes.ts`. The `jira` field is the only change; it is the
ticket's interface as given:

```ts
export interface AppOptions {
    store: TodoStore;
    corsOrigins: readonly string[];
    auth?: Auth | undefined;
    emails?: EmailStore | undefined;
    profiles?: UserProfileStore | undefined;
    organizations?: OrganizationStore | undefined;
    jira?: Omit<JiraRouteOptions, "roleOf"> | undefined;
    originVerify?: string | undefined;
    buildInfo?: BuildInfoDto | undefined;
}

export function createApp(options: AppOptions): Hono<AppEnv>; // signature unchanged
```

`apps/api/src/jira/routes.ts`. `JiraRouteOptions` gets one new **required**
member. Its type is the same as `OrganizationStore["roleOf"]` from
`@sandbox-factory/db`:

```ts
export interface JiraRouteOptions {
  // …every existing member unchanged…
  /**
   * The caller's role in an organization, or undefined when they are not a
   * member. Called by the callback to re-check the decision made at connect.
   */
  roleOf: (userId: string, organizationId: string) => Promise<string | undefined>;
}

export function mountJiraRoutes<Env extends JiraAppEnv>(
  app: Hono<Env>,
  options: JiraRouteOptions,
): void; // signature unchanged
```

Wiring: when both `organizations` and `jira` are given, `createApp` mounts the
Jira routes with `{ ...jira, roleOf: (userId, organizationId) =>
organizations.roleOf(userId, organizationId) }`. The call goes through
`organizations` as a method call, so a store whose `roleOf` uses `this` still
works. A `roleOf` found on `jira` at runtime (passed with a cast) is
overwritten and never called.

Exports whose behaviour does not change: `rankAtLeast`, `AuthVariables`,
`JiraAppEnv`, `signState`, `verifyState`, `JiraOAuthState`, `StateFailure`,
`StateResult`. Apart from the callback, every route `createApp` mounts behaves
as it does today. That includes connect, list connections, disconnect, the
membership guard on `/api/v1/orgs/:orgId/*`, and leaving the Jira routes
unmounted when `jira` or `organizations` is absent. Nothing new is exported.

## Callback order after the change

1. An `error` query parameter → redirect as today (`cancelled` / `error`). Membership is not checked.
2. `verifyState` fails → redirect to `/settings/jira?jira=state`. Membership is not checked.
3. **New:** `roleOf(sessionUserId, state.organizationId)` is called once. If the result is `undefined`, or is not owner or admin by the rule `connect` uses, the callback redirects to `returnTo?jira=forbidden`.
4. `code` is missing or empty → `returnTo?jira=error`, as today.
5. Exchange, list the sites, upsert, then redirect: `connected`, `partial-scopes`, `no-sites` or `denied`, all as today.

"Owner or admin" means the role string is split on `,`, each entry is trimmed,
and at least one entry is exactly `owner` or `admin`. The match is
case-sensitive.

```gherkin
Feature: The Jira OAuth callback re-checks membership before connecting a site

  Background:
    Given an app built by createApp with:
      | option        | value                                                        |
      | auth          | a fake whose session, for any request with a cookie, is user "user_1" (dana@example.test) |
      | organizations | a fake whose roleOf answers from a role table and records every call as [userId, organizationId] |
      | jira.secret   | "0123456789abcdef0123456789abcdef"                           |
      | jira.apiUrl   | "https://api.test"                                           |
      | jira.appUrl   | "https://app.test"                                           |
      | jira.fetch    | a fake Atlassian that records each request, answers the token exchange with refresh token "refresh-1" and scope "read:jira-work read:jira-user read:board-scope:jira-software read:sprint:jira-software offline_access", and lists one site "cloud-1" |
      | jira.connections | a fake that records each upsert as [organizationId, input] |
    And "a state for org_1" means signState(secret, { organizationId: "org_1", userId: "user_1", returnTo: "/settings/jira" })
    And every request carries the header "cookie: session=1"

  Rule: createApp supplies roleOf from the organization store, and the callback calls it once with the session user and the state's organization

    @happy
    Scenario: The callback asks the organization store about the state's organization
      Given the role table holds "user_1" in "org_1" as "owner"
      When GET /api/v1/jira/callback?code=code-1&state=<a state for org_1>
      Then the recorded roleOf calls are exactly [["user_1", "org_1"]]
      And the response is 302 to "https://app.test/settings/jira?jira=connected"

    @happy
    Scenario: The organization id comes from the state even when the query names another
      Given the role table holds "user_1" in "org_1" as "owner"
      When GET /api/v1/jira/callback?code=c&orgId=org_evil&organizationId=org_evil&state=<a state for org_1>
      Then the recorded roleOf calls are exactly [["user_1", "org_1"]]
      And exactly one upsert is recorded, for "org_1"

    @boundary
    Scenario: A store whose roleOf relies on `this` is called as a method
      Given the organizations store is a class instance whose roleOf reads the role table from `this`
      And the role table holds "user_1" in "org_1" as "admin"
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the response is 302 with jira "connected"
      And the response is not 500

    @boundary
    Scenario: A roleOf on the jira options is ignored in favour of the store's
      Given the role table holds no entry for "user_1" in "org_1"
      And the jira options passed to createApp carry, via a cast, roleOf returning "owner" for every call
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the jira options' roleOf is never called
      And the response is 302 with jira "forbidden"
      And no upsert is recorded

  Rule: An owner or admin at callback time connects exactly as before

    @happy
    Scenario Outline: A role that still allows connecting finishes the flow
      Given the role table holds "user_1" in "org_1" as "<role>"
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the response is 302 to "https://app.test/settings/jira?jira=connected"
      And exactly one upsert is recorded, for "org_1" with cloudId "cloud-1" and refreshToken "refresh-1"

      Examples:
        | role         |
        | owner        |
        | admin        |
        | member,admin |
        | admin,member |
        | member, owner |

  Rule: A caller who is no longer a member is sent back with jira=forbidden, and nothing is exchanged or stored

    @unhappy
    Scenario: Removed from the organization after starting the flow
      Given the role table holds no entry for "user_1" in "org_1"
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the response status is 302
      And the location is "https://app.test/settings/jira?jira=forbidden"
      And the fake Atlassian recorded no request
      And no upsert is recorded

    @unhappy
    Scenario: The forbidden redirect honours the signed returnTo
      Given the role table holds no entry for "user_1" in "org_1"
      And the state is signState(secret, { organizationId: "org_1", userId: "user_1", returnTo: "/orgs/acme/jira" })
      When GET /api/v1/jira/callback?code=c&state=<that state>
      Then the location's origin is "https://app.test"
      And the location's pathname is "/orgs/acme/jira"
      And the location's query is exactly jira=forbidden, with no "missing" parameter

    @unhappy
    Scenario: A member of another organization only cannot complete a flow for this one
      Given the role table holds "user_1" in "org_2" as "owner" and nothing in "org_1"
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the location's jira parameter is "forbidden"
      And no upsert is recorded

  Rule: A caller who is still a member but neither owner nor admin is refused the same way

    @unhappy
    Scenario Outline: A role that does not allow connecting is forbidden
      Given the role table holds "user_1" in "org_1" as "<role>"
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the response is 302 to "https://app.test/settings/jira?jira=forbidden"
      And the fake Atlassian recorded no request
      And no upsert is recorded

      Examples:
        | role          | why                                  |
        | member        | demoted after starting the flow      |
        | billing       | a role this code does not know       |
        | Owner         | the match is case-sensitive          |
        | ADMIN         | the match is case-sensitive          |
        | member,member | no entry is owner or admin           |
        | administrator | a whole entry must match, not a prefix |

    @boundary
    Scenario: An empty role string is not a role
      Given the role table holds "user_1" in "org_1" as ""
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the location's jira parameter is "forbidden"
      And no upsert is recorded

  Rule: The re-check comes after the Atlassian error and state checks, and before the code check

    @boundary
    Scenario Outline: Atlassian's own refusal is reported without asking the store
      Given the role table holds no entry for "user_1" in "org_1"
      When GET /api/v1/jira/callback?<query>
      Then the location is "https://app.test/settings/jira?jira=<outcome>"
      And no roleOf call is recorded

      Examples:
        | query                                                | outcome   |
        | error=access_denied&error_description=User+denied    | cancelled |
        | error=invalid_scope                                  | error     |
        | error=access_denied&code=c&state=<a state for org_1> | cancelled |

    @boundary
    Scenario Outline: A refused state is reported without asking the store
      Given the role table holds "user_1" in "org_1" as "owner"
      When GET /api/v1/jira/callback?code=c<state part>
      Then the location is "https://app.test/settings/jira?jira=state"
      And no roleOf call is recorded
      And no upsert is recorded

      Examples:
        | state part                                                                                       |
        |                                                                                                  |
        | &state=                                                                                          |
        | &state=<signState("a-different-secret-that-is-long-enough", { organizationId: "org_1", userId: "user_1", returnTo: "/settings/jira" })> |
        | &state=<signState(secret, { organizationId: "org_1", userId: "user_2", returnTo: "/settings/jira" })> |

    @boundary
    Scenario Outline: With a valid state and no code, membership decides the outcome first
      Given the role table holds "user_1" in "org_1" as <role>
      When GET /api/v1/jira/callback?state=<a state for org_1><code part>
      Then the location's jira parameter is "<outcome>"
      And the recorded roleOf calls are exactly [["user_1", "org_1"]]
      And the fake Atlassian recorded no request

      Examples:
        | role       | code part | outcome   |
        | no entry   |           | forbidden |
        | no entry   | &code=    | forbidden |
        | "member"   |           | forbidden |
        | "owner"    |           | error     |
        | "owner"    | &code=    | error     |

  Rule: A failing membership lookup is a 500, not a redirect

    @unhappy
    Scenario: roleOf rejects
      Given the organizations store's roleOf rejects with Error("database is on fire")
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the response status is 500
      And the body is {"error":"Internal server error."}
      And the fake Atlassian recorded no request
      And no upsert is recorded

  Rule: Membership is checked once per callback, before the exchange, and is not re-checked during it

    @boundary
    Scenario: A grant covering two sites checks membership once and stores both
      Given the role table holds "user_1" in "org_1" as "admin"
      And the fake Atlassian lists two sites, "cloud-1" and "cloud-2"
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the recorded roleOf calls are exactly [["user_1", "org_1"]]
      And two upserts are recorded, for "org_1" with cloudIds "cloud-1" then "cloud-2"
      And the location's jira parameter is "connected"

    @concurrency
    Scenario: Membership revoked while the token exchange is in flight does not stop the flow
      Given the role table holds "user_1" in "org_1" as "owner"
      And the fake Atlassian deletes "user_1" in "org_1" from the role table when it receives the token request
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the recorded roleOf calls are exactly [["user_1", "org_1"]]
      And exactly one upsert is recorded, for "org_1"
      And the location's jira parameter is "connected"

    @concurrency
    Scenario: Overlapping callbacks for two organizations are each decided by their own organization
      Given the role table holds "user_1" in "org_1" as "owner" and nothing in "org_2"
      And "a state for org_2" is signState(secret, { organizationId: "org_2", userId: "user_1", returnTo: "/settings/jira" })
      When GET /api/v1/jira/callback?code=c1&state=<a state for org_1> and GET /api/v1/jira/callback?code=c2&state=<a state for org_2> are issued together and both awaited
      Then the first location's jira parameter is "connected"
      And the second location's jira parameter is "forbidden"
      And exactly one upsert is recorded, for "org_1"
      And the recorded roleOf calls contain ["user_1", "org_1"] and ["user_1", "org_2"], once each, in either order

    @concurrency
    Scenario: The same state redeemed twice in parallel is checked on each request
      Given the role table holds "user_1" in "org_1" as "owner"
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1> is issued twice together and both are awaited
      Then both locations' jira parameter is "connected"
      And the recorded roleOf calls are exactly [["user_1", "org_1"], ["user_1", "org_1"]]
      And two upserts are recorded, both for "org_1"

  Rule: Every other route keeps its behaviour

    @happy
    Scenario: Connect still consults the store once, through the membership guard
      Given the role table holds "user_1" in "org_1" as "owner"
      When GET /api/v1/orgs/org_1/jira/connect
      Then the response is 302 to origin "https://auth.atlassian.com"
      And the recorded roleOf calls are exactly [["user_1", "org_1"]]

    @unhappy
    Scenario Outline: Connect and disconnect refusals are unchanged
      Given the role table holds "user_1" in "org_1" as "member"
      When <method> <path>
      Then the response status is <status>

      Examples:
        | method | path                                      | status |
        | GET    | /api/v1/orgs/org_1/jira/connect           | 403    |
        | DELETE | /api/v1/orgs/org_1/jira/connections/jrc_1 | 403    |
        | GET    | /api/v1/orgs/org_2/jira/connect           | 404    |
        | GET    | /api/v1/orgs/org_1/jira/connections       | 200    |

    @unhappy
    Scenario: A callback without a session is still a 401 and asks nothing
      Given the role table holds "user_1" in "org_1" as "owner"
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1> without a cookie
      Then the response status is 401
      And the body is {"error":"Authentication required."}
      And no roleOf call is recorded

    @boundary
    Scenario Outline: Without both stores the callback is not mounted
      Given createApp is called with auth, <given> and not <absent>
      When GET /api/v1/jira/callback?code=c&state=<a state for org_1>
      Then the response status is 404
      And the body is {"error":"Not found."}

      Examples:
        | given         | absent        |
        | organizations | jira          |
        | jira          | organizations |
```

Decided:
- The callback refuses the same roles that `connect` refuses: only owner or admin passes, not any member.
  - Ticket: "fix(jira): re-check membership when the OAuth callback lands (#34)"
  - Instead: accept any member (`roleOf` returns anything other than undefined), checking presence only.
- A refused re-check ends in a 302 to the web app with `jira=forbidden`, not a 404 or 403 response.
  - Ticket: silent.
  - Instead: answer 404 JSON, as the membership guard does for a non-member.
- A removed member and a demoted member get the same `jira=forbidden` value.
  - Ticket: silent.
  - Instead: separate values, e.g. `jira=not-member` and `jira=forbidden`.
- The forbidden redirect uses the signed `returnTo` path, like every other outcome after verification.
  - Ticket: silent.
  - Instead: always use `/settings/jira`, as the state-failure redirect does.
- The re-check runs after the `error` parameter and state checks, and before the code check. A non-member with no code gets `forbidden`, not `error`.
  - Ticket: silent.
  - Instead: check the code first, then membership just before the exchange.
- `roleOf` is called with the session's user id and the verified state's organization id.
  - Ticket: silent.
  - Instead: use `state.userId` (equal after verification, but taken from the payload).
- `createApp` always supplies `roleOf` from `organizations`, overriding any `roleOf` smuggled onto `jira`.
  - Ticket: "jira?: Omit<JiraRouteOptions, \"roleOf\"> | undefined;"
  - Instead: spread `jira` last, so a caller-supplied `roleOf` wins.
- `JiraRouteOptions.roleOf` is required, not optional.
  - Ticket: silent.
  - Instead: make it optional and skip the re-check when it is absent.
- When `roleOf` rejects, the callback answers 500 through `errorHandler`, and no request reaches Atlassian.
  - Ticket: silent.
  - Instead: treat a failed lookup as a refusal and redirect with `jira=forbidden` or `jira=error`.
- Membership is checked once per callback before the exchange. It is not checked again per site or before each upsert, so a revocation during the exchange does not stop the flow.
  - Ticket: silent.
  - Instead: re-check before every `connections.upsert`.
- Overlapping callbacks, including two that redeem the same state, each make their own check. No lock is taken and the state is not made single-use.
  - Ticket: silent.
  - Instead: record the state's nonce and refuse a second redemption.
- The role match is case-sensitive and works per trimmed comma-separated entry. An empty or unknown role is refused.
  - Ticket: silent.
  - Instead: match case-insensitively, or use `rankAtLeast(role, "admin")`.
