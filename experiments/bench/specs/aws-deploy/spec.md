# Origin verification in `createApp`

The API now sits directly behind CloudFront with no load balancer in between.
The ALB listener rule that used to reject requests missing the
`X-Origin-Verify` header went away with the load balancer, so the app does the
check itself. CloudFront adds the header to every request it forwards. A
request that reaches the Fargate task's public IP some other way does not have
it. `createApp` in `apps/api/src/routes.ts` gets a new option, `originVerify`.
When it is set, a middleware runs before every other handler (CORS included)
and answers any request whose `X-Origin-Verify` header does not match with a
404, as if the route did not exist.
`/health` is exempt so container health checks keep working. When the option is
unset (local dev, tests, or a deployment behind a load balancer), the
middleware is not installed and behaviour is the same as today.

This spec covers only the `routes.ts` seam. It does not cover reading
`ORIGIN_VERIFY` from the environment in `env.ts` or passing it through in
`server.ts`. The comparison is plain string equality, not constant-time; no
scenario below asserts anything about timing.

## Exports from `apps/api/src/routes.ts`

```ts
export interface AppOptions {
    store: TodoStore;
    corsOrigins: readonly string[];
    auth?: Auth | undefined;
    emails?: EmailStore | undefined;
    profiles?: UserProfileStore | undefined;
    originVerify?: string | undefined;
    buildInfo?: BuildInfoDto | undefined;
}

export function createApp({ store, corsOrigins, auth, emails, profiles, buildInfo = unknownBuildInfo, originVerify, }: AppOptions): Hono<AppEnv>;
```

- `originVerify` is new. It is the shared secret that CloudFront sends as the
  `X-Origin-Verify` request header. `undefined` (or leaving the key out) means
  "no check".
- `AuthVariables` and the `AppEnv` type are unchanged.
- With `originVerify` unset, every existing behaviour of `createApp` stays
  exactly as it is now: `/health`, `/version`, CORS, `/api/auth/*`, the session
  guard on `/api/v1/*`, the 503 when `auth` is absent, the JSON 404 and the
  error handler. The same holds with `originVerify` set, for any request that
  passes the check.
- No new constants or functions are exported. The header name
  (`X-Origin-Verify`), the rejection status (404) and the rejection body
  (`{ "error": "Not found" }`, with no trailing period, unlike the app's own
  `{ "error": "Not found." }` for unknown routes) are fixed by this spec, and
  tests assert the literal values.

```gherkin
Feature: Origin verification on createApp
  An app built with originVerify answers only requests that carry the matching
  X-Origin-Verify header, except on /health. An app built without it does no
  check at all.

  Background:
    Given a store created with createInMemoryStore holding todo "todo_1" owned by "user_1"
    And corsOrigins is ["http://localhost:5173"]
    And a fake Auth whose getSession returns user "user_1" when a "cookie" header is present
    And buildInfo is the record with version "1.4.2" and gitSha "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09"

  Rule: When originVerify is undefined the check is not installed, and the X-Origin-Verify header is ignored

    @happy
    Scenario Outline: An app without originVerify serves requests whatever their X-Origin-Verify header holds
      Given createApp is called without originVerify
      When "GET /version" is requested with X-Origin-Verify <header>
      Then the status is 200
      And the body is the buildInfo record

      Examples:
        | header      |
        | absent      |
        | "anything"  |
        | ""          |

    @happy
    Scenario: originVerify passed explicitly as undefined behaves like leaving it out
      Given createApp is called with originVerify undefined
      When "GET /api/v1/todos" is requested with the session cookie and no X-Origin-Verify header
      Then the status is 200
      And the body is {"todos":[{"id":"todo_1","userId":"user_1","title":"write tests","done":false,"createdAt":"2026-09-16T00:00:00.000Z"}]}

  Rule: When originVerify is set, a request without the exact header value gets 404 with body {"error":"Not found"}

    @happy
    Scenario Outline: A request with the matching header is served as it would be without the check
      Given createApp is called with originVerify "s3cret-Value"
      When "<method> <path>" is requested with X-Origin-Verify "s3cret-Value" and the session cookie
      Then the status is <status>
      And the body is <body>

      Examples:
        | method | path              | status | body                                   |
        | GET    | /version          | 200    | the buildInfo record                   |
        | GET    | /api/v1/todos      | 200    | {"todos":[<todo_1 as in the Background>]} |
        | GET    | /api/v1/todos/nope | 404    | {"error":"No todo with id \"nope\"."}    |
        | GET    | /api/v1/nope       | 404    | {"error":"Not found."}                 |
        | GET    | /nowhere           | 404    | {"error":"Not found."}                 |

    @unhappy
    Scenario Outline: A missing or non-matching header is rejected on every non-exempt path and method
      Given createApp is called with originVerify "s3cret-Value"
      When "<method> <path>" is requested with the session cookie and X-Origin-Verify <header>
      Then the status is 404
      And the content type is "application/json"
      And the body is {"error":"Not found"}

      Examples:
        | method | path                 | header            |
        | GET    | /version             | absent            |
        | GET    | /api/v1/todos        | absent            |
        | POST   | /api/v1/todos        | "wrong"           |
        | PATCH  | /api/v1/todos/todo_1 | ""                |
        | DELETE | /api/v1/todos/todo_1 | "s3cret-value"    |
        | GET    | /api/v1/me           | "s3cret-Value2"   |
        | GET    | /api/auth/session    | "s3cret-Valu"     |
        | GET    | /api/v1/nope         | absent            |
        | GET    | /nowhere             | absent            |

    @boundary
    Scenario: The comparison is case-sensitive on the value
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /version" is requested with X-Origin-Verify "S3CRET-VALUE"
      Then the status is 404

    @boundary
    Scenario Outline: The header name is matched case-insensitively
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /version" is requested with header <name> set to "s3cret-Value"
      Then the status is 200

      Examples:
        | name              |
        | X-Origin-Verify   |
        | x-origin-verify   |
        | X-ORIGIN-VERIFY   |

    @boundary
    Scenario: Leading and trailing whitespace stripped by the Headers API does not cause a rejection
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /version" is requested with X-Origin-Verify "  s3cret-Value  "
      Then the status is 200

    @boundary
    Scenario: A header sent twice is compared as the combined value and rejected
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /version" is requested with X-Origin-Verify appended twice as "s3cret-Value"
      Then the header value the app sees is "s3cret-Value, s3cret-Value"
      And the status is 404

    @unhappy
    Scenario: An unknown route without the header gets the check's 404, not the app's own
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /api/v1/does-not-exist" is requested with no X-Origin-Verify header
      Then the status is 404
      And the body is {"error":"Not found"}

  Rule: The check runs before CORS, authentication and every route handler

    @unhappy
    Scenario: A rejected request never reaches the session guard
      Given createApp is called with originVerify "s3cret-Value" and an Auth whose getSession counts its calls
      When "GET /api/v1/todos" is requested with the session cookie and no X-Origin-Verify header
      Then the status is 404
      And getSession was called 0 times

    @unhappy
    Scenario: A rejected unauthenticated request is 404, not 401
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /api/v1/todos" is requested with no cookie and no X-Origin-Verify header
      Then the status is 404

    @happy
    Scenario: An accepted unauthenticated request still gets the session guard's 401
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /api/v1/todos" is requested with X-Origin-Verify "s3cret-Value" and no cookie
      Then the status is 401
      And the body is {"error":"Authentication required."}

    @unhappy
    Scenario: A rejected request never reaches the Better Auth handler
      Given createApp is called with originVerify "s3cret-Value" and an Auth whose handler counts its calls
      When "GET /api/auth/session" is requested with no X-Origin-Verify header
      Then the status is 404
      And the handler was called 0 times

    @unhappy
    Scenario: A rejected write does not change the store
      Given createApp is called with originVerify "s3cret-Value"
      When "DELETE /api/v1/todos/todo_1" is requested with the session cookie and no X-Origin-Verify header
      Then the status is 404
      And "GET /api/v1/todos" with the session cookie and X-Origin-Verify "s3cret-Value" still returns todo "todo_1"

    @unhappy
    Scenario: A rejected request carries no CORS headers
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /api/v1/todos" is requested with Origin "http://localhost:5173", the session cookie and no X-Origin-Verify header
      Then the status is 404
      And the response has no "Access-Control-Allow-Origin" header

    @unhappy
    Scenario: A CORS preflight without the header is rejected
      Given createApp is called with originVerify "s3cret-Value"
      When "OPTIONS /api/v1/todos" is requested with Origin "http://localhost:5173", Access-Control-Request-Method "POST" and no X-Origin-Verify header
      Then the status is 404
      And the response has no "Access-Control-Allow-Origin" header

    @happy
    Scenario: An accepted request gets the usual CORS headers
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /api/v1/todos" is requested with Origin "http://localhost:5173", the session cookie and X-Origin-Verify "s3cret-Value"
      Then the status is 200
      And the "Access-Control-Allow-Origin" header is "http://localhost:5173"

  Rule: The check is installed whether or not auth is configured

    @unhappy
    Scenario: With no auth, a request without the header is 404 rather than 503
      Given createApp is called with originVerify "s3cret-Value" and no auth
      When "GET /api/v1/todos" is requested with no X-Origin-Verify header
      Then the status is 404
      And the body is {"error":"Not found"}

    @happy
    Scenario: With no auth, an accepted request still gets the 503
      Given createApp is called with originVerify "s3cret-Value" and no auth
      When "GET /api/v1/todos" is requested with X-Origin-Verify "s3cret-Value"
      Then the status is 503
      And the body is {"error":"Authentication is not configured."}

    @unhappy
    Scenario: With no auth, /version without the header is 404
      Given createApp is called with originVerify "s3cret-Value" and no auth
      When "GET /version" is requested with no X-Origin-Verify header
      Then the status is 404

  Rule: Only the exact path /health is exempt, for any method and whatever the header holds

    @happy
    Scenario Outline: /health answers without a valid header
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /health" is requested with X-Origin-Verify <header>
      Then the status is 200
      And the body is {"status":"ok","version":"1.4.2","sha":"7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09"}

      Examples:
        | header          |
        | absent          |
        | "wrong"         |
        | "s3cret-Value"  |

    @boundary
    Scenario: A query string does not remove the exemption
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /health?probe=1" is requested with no X-Origin-Verify header
      Then the status is 200

    @boundary
    Scenario: The exemption is by path, not by method
      Given createApp is called with originVerify "s3cret-Value"
      When "POST /health" is requested with no X-Origin-Verify header
      Then the status is 404
      And the body is {"error":"Not found."}

    @boundary
    Scenario Outline: Paths that only look like /health are not exempt
      Given createApp is called with originVerify "s3cret-Value"
      When "GET <path>" is requested with no X-Origin-Verify header
      Then the status is 404

      Examples:
        | path            |
        | /health/        |
        | /healthz        |
        | /HEALTH         |
        | /api/health     |
        | /health/extra   |

  Rule: Any string originVerify, empty or whitespace-padded included, installs the check and is compared as given

    @boundary
    Scenario: An empty secret installs the check and matches only a present, empty header
      Given createApp is called with originVerify ""
      When "GET /version" is requested with no X-Origin-Verify header
      Then createApp did not throw
      And the status is 404
      And the body is {"error":"Not found"}
      And "GET /version" with X-Origin-Verify "" returns status 200

    @boundary
    Scenario: A whitespace-padded secret is not trimmed, so no request can match it
      Given createApp is called with originVerify " s3cret-Value"
      When "GET /version" is requested with X-Origin-Verify " s3cret-Value"
      Then createApp did not throw
      And the status is 404
      And "GET /health" with no X-Origin-Verify header returns status 200

    @boundary
    Scenario: A secret containing interior spaces and punctuation is accepted verbatim
      Given createApp is called with originVerify "a b:c/d=e"
      When "GET /version" is requested with X-Origin-Verify "a b:c/d=e"
      Then the status is 200

  Rule: The check keeps no state between requests

    @concurrency
    Scenario: Overlapping requests with and without the header are each decided on their own header
      Given one app created with originVerify "s3cret-Value"
      When these requests are started together and awaited with Promise.all
        | request              | X-Origin-Verify |
        | GET /version         | "s3cret-Value"  |
        | GET /version         | absent          |
        | GET /version         | "wrong"         |
        | GET /health          | absent          |
        | GET /version         | "s3cret-Value"  |
      Then the statuses are, in the same order, 200, 404, 404, 200, 200

    @concurrency
    Scenario: Two apps with different secrets do not share them
      Given app A created with originVerify "alpha" and app B created with originVerify "beta"
      When "GET /version" is requested from both at once, each with X-Origin-Verify "alpha"
      Then app A answers 200
      And app B answers 404

    @boundary
    Scenario: A rejected request does not affect the next one
      Given createApp is called with originVerify "s3cret-Value"
      When "GET /version" is requested with no X-Origin-Verify header
      And then "GET /version" is requested with X-Origin-Verify "s3cret-Value"
      Then the first status is 404
      And the second status is 200
```

## Decided:

- Header name is `X-Origin-Verify`, looked up case-insensitively.
  - Ticket: "Dropping the load balancer removed the listener rule that enforced the X-Origin-Verify header, so that check moves into the app"
  - Instead: make the header name configurable through another option.
- A rejected request gets status 404 with JSON body `{"error":"Not found"}` (no trailing period), so it reads as a missing route rather than a refusal.
  - Ticket: silent.
  - Instead: 403 `{"error":"Forbidden."}`, 401, or reuse the app's own `{"error":"Not found."}` body exactly.
- The value must match exactly, case-sensitively. The only normalisation is the Headers API's own whitespace stripping, and a repeated header (combined to `"a, a"`) is rejected.
  - Ticket: silent.
  - Instead: trim and/or case-fold the value, or accept when any one of several comma-separated values matches.
- The exemption covers the exact path `/health` only, for any method and any query string. `/health/`, `/healthz`, `/HEALTH` and `/api/health` are checked.
  - Ticket: "/health is exempt so container probes keep working."
  - Instead: exempt by prefix (`/health*`), or exempt `GET /health` only.
- `/version` is not exempt.
  - Ticket: "then asks /version whether the site is serving the commit it just built"
  - Instead: exempt `/version` with `/health` because it is also unauthenticated.
- The check runs first, ahead of CORS, so rejected responses (preflights included) carry no CORS headers.
  - Ticket: silent.
  - Instead: install it after CORS so browsers can read the 404.
- The check runs ahead of auth, so a request with no header and no session gets 404, not 401, and neither `getSession` nor `auth.handler` is called.
  - Ticket: silent.
  - Instead: run auth first and check the origin only on authenticated requests.
- Unknown routes are checked too: without the header they get the check's `{"error":"Not found"}` 404, not the app's `{"error":"Not found."}` 404.
  - Ticket: silent.
  - Instead: let unknown routes through to the app's own 404 unchecked.
- The check is installed whether or not `auth` is configured, so with no auth a request without the header gets 404 and not 503.
  - Ticket: "Unset — locally, or behind a load balancer — the check is not installed at all."
  - Instead: install it only on the fully configured app.
- `originVerify: undefined` means no check, and then any `X-Origin-Verify` header is ignored.
  - Ticket: "gated on an optional ORIGIN_VERIFY. Unset — locally, or behind a load balancer — the check is not installed at all."
  - Instead: strip or reject the header when no secret is configured.
- `createApp` never throws over `originVerify`. Any string, `""` included, installs the check and is compared untrimmed: `""` admits only requests carrying an empty `X-Origin-Verify` header, and a whitespace-padded secret admits nothing but `/health`.
  - Ticket: silent.
  - Instead: throw for an empty or whitespace-padded secret, or treat `""` as unset and install no check.
- The middleware keeps no state: each request, overlapping or not, is decided only on its own header, and each app only on its own secret.
  - Ticket: silent.
  - Instead: none conventional. Rate-limiting or remembering rejected callers was not considered.
- The value comparison is plain string equality, not constant-time.
  - Ticket: silent.
  - Instead: compare with a constant-time function such as Hono's `timingSafeEqual`.
- Reading `ORIGIN_VERIFY` from the environment (`env.ts`, `server.ts`) is outside this spec.
  - Ticket: "routes.ts gains middleware, gated on an optional ORIGIN_VERIFY."
  - Instead: specify the `parseEnv` field and the `server.ts` wiring here too.
