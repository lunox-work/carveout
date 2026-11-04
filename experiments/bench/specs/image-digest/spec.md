# Resolve the deployed image digest from the container runtime

Ticket #43 wants the API to report the digest of the container image it is
running, so that `GET /version` can be checked against the image's provenance
attestation (`gh attestation verify --digest sha256:…`). The change adds a
new module, `apps/api/src/image-digest.ts`, that asks the container runtime
for the digest instead of trusting a build argument. ECS injects
`ECS_CONTAINER_METADATA_URI_V4` into every task. The agent on the host serves
the container's metadata at that URI, and its `ImageID` field names the image
the runtime pulled. At boot the server resolves the digest once and adds it to
the build record that `GET /version` returns, as `imageDigest`. As with the
`BUILD_*` provenance values in `apps/api/src/env.ts`, a missing or unusable
digest leaves a gap in what the API reports. It is never a reason to fail at
boot. So the resolver returns `undefined` in those cases and never throws or
rejects.

## Exports

From `apps/api/src/image-digest.ts` (new file):

```ts
export async function resolveImageDigest(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined>;
```

- Reads `env.ECS_CONTAINER_METADATA_URI_V4` once, synchronously, when it is
  called. If that value is missing or the empty string, it resolves to
  `undefined` and makes no request.
- Otherwise it makes one `GET` request with the global `fetch` to exactly that
  URI, with a 1000 ms timeout. If the response is 2xx and its JSON body has a
  string `ImageID`, it takes the part of `ImageID` after the last `@` (the
  whole string if there is no `@`). If that part is a valid digest, the
  promise resolves to it. In every other case it resolves to `undefined`.
- A valid digest is exactly `sha256:` followed by 64 lowercase hex characters
  (`/^sha256:[0-9a-f]{64}$/`). The value is not trimmed or lowercased first.
- It never throws synchronously and the promise never rejects. A refused
  connection, an invalid URI, a non-2xx status, a timeout, a body that is not
  JSON, and a missing or non-string `ImageID` all resolve to `undefined`.
- It reads no other key of `env` (in particular not `IMAGE_DIGEST`), never
  changes `env`, reads no file and writes nothing to the console.
- It keeps no cache. Each call reads `env` again at the moment it is called
  and makes its own request.

The module exports nothing else.

These existing exports keep their current behaviour, and this change does not
modify them:

- `apps/api/src/env.ts`: `parseEnv`, `buildInfo`, `appUrl`, `objectStoreConfig`
  and `Env`. `ECS_CONTAINER_METADATA_URI_V4` is not added to the env schema,
  so `parseEnv` still drops it and never fails because of it.
- `apps/api/src/routes.ts`: `createApp` and `AppOptions`. `GET /version` still
  returns the build record it was given, unchanged. The server entry point now
  gives it `buildInfo(env)` plus `imageDigest: await resolveImageDigest()`,
  resolved before the server starts listening.
- `@sandbox-factory/shared`: `BuildInfoDto`, `unknownBuildInfo` and
  `buildInfoSchema` stay as they are.

The constants below are used in the scenarios:

- `DIGEST_A` = `"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"`
- `DIGEST_B` = `"sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"`
- `URI_A` and `URI_B` are two metadata endpoint URLs served by the test. Unless
  a scenario says otherwise, `URI_A` responds `200` with the JSON body
  `{ "ImageID": DIGEST_A }` and `URI_B` responds `200` with
  `{ "ImageID": DIGEST_B }`.

In tables, every value in a `value` column is a JSON string literal. `\n`,
`\t` and the spaces inside the quotes are part of the value.

```gherkin
Feature: resolveImageDigest reports the deployed image digest from the container metadata endpoint

  Background:
    Given DIGEST_A is "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    And DIGEST_B is "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
    And URI_A is a metadata endpoint that responds 200 with { "ImageID": DIGEST_A }
    And URI_B is a metadata endpoint that responds 200 with { "ImageID": DIGEST_B }

  Rule: A well-formed ImageID from the metadata endpoint resolves to that digest

    @happy
    Scenario: The digest reported by the runtime is returned verbatim
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A }
      When resolveImageDigest(env) is awaited
      Then exactly one GET request was made to URI_A
      And the result is DIGEST_A

    @happy
    Scenario: Other keys in the environment do not affect the result
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": URI_B, "IMAGE_DIGEST": DIGEST_A, "BUILD_SHA": "7f3a9c1e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a", "PORT": "4000" }
      When resolveImageDigest(env) is awaited
      Then the result is DIGEST_B

    @happy
    Scenario: Other fields in the metadata body do not affect the result
      Given URI_A responds 200 with { "DockerId": "abc", "Name": "api", "Image": "sandbox-factory-api:latest", "ImageID": DIGEST_A, "Labels": {} }
      And env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A }
      When resolveImageDigest(env) is awaited
      Then the result is DIGEST_A

    @happy
    Scenario Outline: An image reference with the digest appended is reduced to the digest
      Given URI_A responds 200 with { "ImageID": <value> }
      And env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A }
      When resolveImageDigest(env) is awaited
      Then the result is DIGEST_A

      Examples:
        | value                                                                                                                                      |
        | "123456789012.dkr.ecr.eu-west-1.amazonaws.com/sandbox-factory-api@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" |
        | "sandbox-factory-api:1.4.2@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"                                       |

    @happy
    Scenario: The result is a Promise
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A }
      When resolveImageDigest(env) is called without awaiting
      Then the return value is an instance of Promise
      And it resolves to DIGEST_A

    @happy
    Scenario: With no argument the resolver reads process.env
      Given process.env.ECS_CONTAINER_METADATA_URI_V4 is set to URI_A
      When resolveImageDigest() is awaited with no argument
      Then the result is DIGEST_A
      And after process.env.ECS_CONTAINER_METADATA_URI_V4 is deleted, resolveImageDigest() resolves to undefined

  Rule: A missing or empty ECS_CONTAINER_METADATA_URI_V4 resolves to undefined without a request

    @unhappy
    Scenario: The metadata URI is not set
      Given env is {}
      When resolveImageDigest(env) is awaited
      Then no request is made
      And the result is undefined

    @unhappy
    Scenario: The metadata URI is the empty string
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": "" }
      When resolveImageDigest(env) is awaited
      Then no request is made
      And the result is undefined

    @unhappy
    Scenario: The metadata URI is explicitly undefined
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": undefined }
      When resolveImageDigest(env) is awaited
      Then no request is made
      And the result is undefined

    @unhappy
    Scenario: IMAGE_DIGEST alone is ignored
      Given env is { "IMAGE_DIGEST": DIGEST_A }
      When resolveImageDigest(env) is awaited
      Then no request is made
      And the result is undefined

  Rule: Any failure to reach or read the metadata endpoint resolves to undefined and does not throw

    @unhappy
    Scenario Outline: The endpoint cannot be used
      Given <setup>
      When resolveImageDigest(env) is awaited
      Then the promise resolves rather than rejects
      And the result is undefined

      Examples:
        | case                    | setup                                                                                          |
        | connection refused      | env.ECS_CONTAINER_METADATA_URI_V4 is a URL on a port nothing listens on                        |
        | not a URL               | env is { "ECS_CONTAINER_METADATA_URI_V4": "not a url" }                                        |
        | non-2xx status          | URI_A responds 500 with { "ImageID": DIGEST_A } and env points at URI_A                         |
        | not found               | URI_A responds 404 with { "ImageID": DIGEST_A } and env points at URI_A                         |
        | body is not JSON        | URI_A responds 200 with the text body "ok" and env points at URI_A                              |
        | body is JSON null       | URI_A responds 200 with the body null and env points at URI_A                                   |
        | no ImageID field        | URI_A responds 200 with { "Image": "sandbox-factory-api:latest" } and env points at URI_A       |
        | ImageID is not a string | URI_A responds 200 with { "ImageID": 42 } and env points at URI_A                               |

    @unhappy
    Scenario: An endpoint that never answers times out after 1000 ms
      Given URI_A accepts the connection but never responds
      And env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A }
      When resolveImageDigest(env) is awaited
      Then the result is undefined
      And the promise settles about 1000 ms after the call, and within 2000 ms

  Rule: Only "sha256:" followed by exactly 64 lowercase hex characters is accepted; anything else resolves to undefined

    @boundary
    Scenario Outline: ImageID values that are not exactly one digest
      Given URI_A responds 200 with { "ImageID": <value> }
      And env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A }
      When resolveImageDigest(env) is awaited
      Then the promise resolves rather than rejects
      And the result is undefined

      Examples:
        | case                         | value                                                                                                     |
        | 63 hex characters            | "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde"                                  |
        | 65 hex characters            | "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0"                                |
        | non-hex character            | "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg"                                 |
        | uppercase hex                | "sha256:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"                                 |
        | uppercase algorithm          | "SHA256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"                                 |
        | no algorithm prefix          | "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"                                        |
        | prefix without hex           | "sha256:"                                                                                                 |
        | other algorithm              | "sha512:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"                                 |
        | tag instead of digest        | "sandbox-factory-api:7f3a9c1e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a"                                            |
        | reference ending in @        | "sandbox-factory-api@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef@"            |
        | placeholder                  | "unknown"                                                                                                 |
        | empty string                 | ""                                                                                                        |
        | trailing newline             | "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n"                               |
        | surrounding spaces           | "  sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  "                             |
        | whitespace inside            | "sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"                                |

  Rule: The environment is read once, when the call is made, and never cached or modified

    @concurrency
    Scenario: Changing env after the call does not change the pending result
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A }
      When resolveImageDigest(env) is called and its promise is held without awaiting
      And env.ECS_CONTAINER_METADATA_URI_V4 is then set to URI_B
      And the held promise is awaited
      Then the result is DIGEST_A

    @concurrency
    Scenario: Overlapping calls each see the environment as it was when they were made
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A }
      When p1 = resolveImageDigest(env) is called
      And env.ECS_CONTAINER_METADATA_URI_V4 is set to URI_B
      And p2 = resolveImageDigest(env) is called
      And env.ECS_CONTAINER_METADATA_URI_V4 is deleted
      And p3 = resolveImageDigest(env) is called
      And Promise.all([p1, p2, p3]) is awaited
      Then the results are [DIGEST_A, DIGEST_B, undefined]

    @concurrency
    Scenario: Concurrent calls on the same environment agree and each make their own request
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": URI_B }
      When resolveImageDigest(env) is called 10 times without awaiting and all are awaited together
      Then all 10 results are DIGEST_B
      And 10 requests were made to URI_B

    @concurrency
    Scenario: A later call sees a changed endpoint response
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A }
      And resolveImageDigest(env) has been awaited and resolved to DIGEST_A
      When URI_A is changed to respond 200 with { "ImageID": DIGEST_B }
      And resolveImageDigest(env) is awaited again
      Then the result is DIGEST_B

    @happy
    Scenario: The input environment is left unchanged
      Given env is { "ECS_CONTAINER_METADATA_URI_V4": URI_A, "BUILD_SHA": "abc" }
      When resolveImageDigest(env) is awaited
      Then the result is DIGEST_A
      And env deep-equals { "ECS_CONTAINER_METADATA_URI_V4": URI_A, "BUILD_SHA": "abc" }

  Rule: Existing env parsing is unchanged, and /version returns whatever build record it is given

    @happy
    Scenario: parseEnv neither validates nor keeps the metadata URI
      Given env is the required variables from apps/api/test/env.test.ts plus { "ECS_CONTAINER_METADATA_URI_V4": "not a url", "IMAGE_DIGEST": "not-a-digest" }
      When parseEnv(env) is called
      Then it does not throw
      And the returned Env has no ECS_CONTAINER_METADATA_URI_V4 property
      And the returned Env has no IMAGE_DIGEST property

    @happy
    Scenario: GET /version returns exactly the BuildInfoDto it was given
      Given createApp is given buildInfo { "version": "1.4.2", "gitSha": "7f3a9c1e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a", "gitShortSha": "7f3a9c1", "buildTime": "2026-11-01T12:00:00Z", "gitRef": "v1.4.2", "dirty": false }
      When GET /version is requested
      Then the status is 200
      And the JSON body deep-equals that buildInfo, with no imageDigest key

    @happy
    Scenario: GET /version passes an imageDigest in the build record through unchanged
      Given createApp is given buildInfo { "version": "1.4.2", "gitSha": "7f3a9c1e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a", "gitShortSha": "7f3a9c1", "buildTime": "2026-11-01T12:00:00Z", "gitRef": "v1.4.2", "dirty": false, "imageDigest": DIGEST_A }
      When GET /version is requested
      Then the status is 200
      And the JSON body deep-equals that buildInfo, including "imageDigest": DIGEST_A
```

Decided:

- The digest comes from the `ImageID` field of the ECS container metadata endpoint at `ECS_CONTAINER_METADATA_URI_V4`. `IMAGE_DIGEST` is ignored.
  - Ticket: silent.
  - Instead: read an `IMAGE_DIGEST` environment variable written into the task definition by CD.
- The resolver makes one `GET` request with global `fetch` to exactly the URI in `ECS_CONTAINER_METADATA_URI_V4`. It reads no file and writes nothing to the console.
  - Ticket: "export async function resolveImageDigest(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined>;"
  - Instead: make no network or file system access, even though it is async.
- A missing or empty `ECS_CONTAINER_METADATA_URI_V4` resolves to `undefined` and makes no request.
  - Ticket: silent.
  - Instead: fall back to a default metadata address.
- The request has a 1000 ms timeout. An endpoint that does not answer in time resolves to `undefined`.
  - Ticket: silent.
  - Instead: wait for the endpoint with no timeout.
- The only accepted format is `sha256:` plus 64 lowercase hex characters.
  - Ticket: silent.
  - Instead: accept any OCI digest (`<algorithm>:<encoded>`), including `sha512:`.
- Uppercase hex or an uppercase `SHA256:` prefix is rejected, not lowercased.
  - Ticket: silent.
  - Instead: lowercase the value before checking it.
- `ImageID` is not trimmed. Any whitespace in it, leading, trailing or inside, makes it invalid.
  - Ticket: silent.
  - Instead: trim surrounding whitespace before checking.
- A bare 64-hex value without the `sha256:` prefix is rejected, not given the prefix.
  - Ticket: silent.
  - Instead: add `sha256:` to a bare 64-hex value.
- A full image reference (`repo@sha256:…`) is reduced to the part after the last `@`, which must then be a valid digest.
  - Ticket: silent.
  - Instead: reject any value that is not a bare digest.
- A missing URI, a refused connection, an invalid URI, a non-2xx status, a timeout, a non-JSON body, a missing or non-string `ImageID` and an invalid digest all resolve to `undefined`. The resolver never throws or rejects.
  - Ticket: silent.
  - Instead: throw (reject) on a malformed value, as `parseEnv` does for invalid config.
- `env` is read once, synchronously, at call time. Changes made after the call do not affect that call's result.
  - Ticket: silent.
  - Instead: read `env` after an `await`, so the value is whatever `env` holds when the promise settles.
- No cache: every call reads `env` again and makes its own request.
  - Ticket: silent.
  - Instead: cache the first resolved digest for the life of the process.
- Neither `ECS_CONTAINER_METADATA_URI_V4` nor `IMAGE_DIGEST` is added to the `parseEnv` schema, so `parseEnv` neither validates nor keeps them.
  - Ticket: silent.
  - Instead: add the variable to `envSchema` as an optional string.
- The server resolves the digest once at boot, awaited before it starts listening, and adds it to the build record as `imageDigest`. `GET /version` returns that record, so `imageDigest` appears there when it resolved and is absent from the JSON when it is `undefined`. `createApp`, `BuildInfoDto` and `buildInfoSchema` are not changed.
  - Ticket: "feat: attest the deployed image and report its digest at /version (#43)"
  - Instead: leave `/version` unchanged and add the digest in a separate change, or add `imageDigest` to `BuildInfoDto` and its schema.
- `resolveImageDigest` is the only export. The timeout and the digest pattern are not exported.
  - Ticket: silent.
  - Instead: also export `IMAGE_DIGEST_PATTERN` and the timeout as constants.
