# Build info: report and attest the commit each build came from

Each deployable (`api`, `web`, `extension`) needs to say which commit it was
built from, so a running build can be traced to the source and so a client
can confirm it is talking to an API built from the same commit. This change
adds a new module, `packages/shared/src/build-info.ts`, to
`@sandbox-factory/shared`. Like the rest of the package it is part of the wire
contract: it depends only on `zod`, has no I/O, and does not read the clock, the
environment or git. Callers collect the values (for example at build time) and
pass them in. `packages/shared/src/index.ts` re-exports everything from it
(`export * from "./build-info.js";`), so consumers import from
`@sandbox-factory/shared`. Tests may import from `../src/build-info.js` or
`../src/index.js`.

## Exports of `packages/shared/src/build-info.ts`

```ts
export const UNKNOWN_BUILD = "unknown";

/** z.object({ version, gitSha, gitShortSha, buildTime, gitRef, dirty }), see the rules below. */
export const buildInfoSchema: z.ZodObject<…>;

export type BuildInfoDto = z.infer<typeof buildInfoSchema>;
// = { version: string; gitSha: string; gitShortSha: string; buildTime: string; gitRef: string; dirty: boolean }

/** Body of the version endpoint: the same schema object as buildInfoSchema (the build info itself, not wrapped). */
export const versionResponseSchema: typeof buildInfoSchema;

/** version "0.0.0", dirty false, every other field UNKNOWN_BUILD. A plain, unfrozen object. */
export const unknownBuildInfo: BuildInfoDto;

export function formatVersion(info: BuildInfoDto): string;
export function isIdentified(info: BuildInfoDto): boolean;
export function commitUrl(info: BuildInfoDto): string | undefined;
export function sameBuild(a: BuildInfoDto, b: BuildInfoDto): boolean;
export function buildBanner(name: string, info: BuildInfoDto): string;
```

No other exports are added. The existing exports of `src/index.ts`
(`titleSchema`, `todoFilterSchema`, `todoSchema`, `todoListSchema`,
`createTodoSchema`, `updateTodoSchema`, `errorSchema` and their DTO types)
are unchanged and keep their current behaviour.

### Field rules of `buildInfoSchema`

Every field is required. The string fields accept any non-empty string,
including `UNKNOWN_BUILD` (`"unknown"`); no format is checked. Anything else
fails to parse.

| Field         | Accepted                                                        |
| ------------- | --------------------------------------------------------------- |
| `version`     | any non-empty string (for example `"0.3.0"`), kept as given     |
| `gitSha`      | any non-empty string (meant: full 40-character SHA, or `unknown`) |
| `gitShortSha` | any non-empty string (meant: first 7 of `gitSha`, or `unknown`) |
| `buildTime`   | any non-empty string (meant: ISO 8601 datetime, or `unknown`)   |
| `gitRef`      | any non-empty string (for example `"main"` or `"v1.4.2"`)       |
| `dirty`       | a boolean                                                       |

The object is a plain `z.object`, as the other schemas in this package are:
unknown keys are dropped from the parse result and do not cause an error.
Values are not trimmed, lowercased or otherwise normalised by the schema.

The five functions are pure. They do not validate their arguments: they are
specified only for values that `buildInfoSchema` accepts, and they do not
mutate them. None of them throws.

The commit link always points at the fixed repository
`https://github.com/lunox-work/sandbox-factory`.

```gherkin
Feature: Build info for the commit a build came from

  Background:
    Given SHA is "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    And OTHER_SHA is "0123456789abcdef0123456789abcdef01234567"
    And REPO is "https://github.com/lunox-work/sandbox-factory"
    And a build info "known" with
      | version     | 0.3.0                    |
      | gitSha      | SHA                      |
      | gitShortSha | a1b2c3d                  |
      | buildTime   | 2026-11-04T12:00:00.000Z |
      | gitRef      | main                     |
      | dirty       | false                    |

  Rule: UNKNOWN_BUILD is the string "unknown" and unknownBuildInfo uses it for every field except version and dirty

    @happy
    Scenario: The unknown build info
      Then UNKNOWN_BUILD is "unknown"
      And unknownBuildInfo deep-equals
        | version | gitSha  | gitShortSha | buildTime | gitRef  | dirty |
        | 0.0.0   | unknown | unknown     | unknown   | unknown | false |
      And buildInfoSchema.parse(unknownBuildInfo) deep-equals unknownBuildInfo

  Rule: buildInfoSchema accepts any non-empty string in each string field and a boolean in dirty

    @happy
    Scenario: A fully known build info parses to itself
      When buildInfoSchema parses "known"
      Then the result deep-equals "known"

    @happy
    Scenario Outline: Any single string field may be "unknown"
      When buildInfoSchema parses "known" with <field> set to "unknown"
      Then parsing succeeds and <field> is "unknown"

      Examples:
        | field       |
        | version     |
        | gitSha      |
        | gitShortSha |
        | buildTime   |
        | gitRef      |

    @happy
    Scenario: A dirty build parses
      When buildInfoSchema parses "known" with dirty set to true
      Then parsing succeeds and dirty is true

    @boundary
    Scenario: Unknown keys are dropped
      When buildInfoSchema parses "known" plus the key "branch" with value "main"
      Then parsing succeeds
      And the result has no "branch" key and deep-equals "known"

    @boundary
    Scenario Outline: Accepted edge values
      When buildInfoSchema parses "known" with <field> set to <value>
      Then parsing succeeds and <field> is <value> unchanged

      Examples:
        | field       | value                                      |
        | version     | "v1"                                       |
        | version     | "0.3.0-rc.1+build.7"                       |
        | gitSha      | "a1b2c3d"                                  |
        | gitSha      | "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678" |
        | gitSha      | "Unknown"                                  |
        | gitShortSha | "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" |
        | buildTime   | "2026-11-04T12:00:00+01:00"                |
        | buildTime   | "yesterday"                                |
        | gitRef      | "v1.4.2"                                   |

  Rule: buildInfoSchema rejects a missing field, an empty string and a value of the wrong type

    @unhappy
    Scenario Outline: A missing required field is rejected
      When buildInfoSchema safe-parses "known" without <field>
      Then success is false

      Examples:
        | field       |
        | version     |
        | gitSha      |
        | gitShortSha |
        | buildTime   |
        | gitRef      |
        | dirty       |

    @unhappy
    Scenario Outline: Invalid field values are rejected
      When buildInfoSchema safe-parses "known" with <field> set to <value>
      Then success is false

      Examples:
        | field       | value   | why             |
        | version     | ""      | empty           |
        | version     | 3       | not a string    |
        | gitSha      | ""      | empty           |
        | gitShortSha | ""      | empty           |
        | buildTime   | ""      | empty           |
        | gitRef      | ""      | empty           |
        | dirty       | "false" | not a boolean   |
        | dirty       | null    | not a boolean   |

  Rule: versionResponseSchema is buildInfoSchema itself; the body is the build info, not wrapped

    @happy
    Scenario: It is the same schema
      Then versionResponseSchema is the same object as buildInfoSchema

    @happy
    Scenario: A version response parses
      When versionResponseSchema parses "known"
      Then the result deep-equals "known"

    @happy
    Scenario: A version response for an unknown build parses
      When versionResponseSchema parses unknownBuildInfo
      Then the result deep-equals unknownBuildInfo

    @unhappy
    Scenario Outline: Malformed version responses are rejected
      When versionResponseSchema safe-parses <body>
      Then success is false

      Examples:
        | body                                |
        | {}                                  |
        | { "build": "known" } (wrapped)      |
        | "known" with gitSha ""              |
        | null                                |

  Rule: formatVersion is "<version>+<gitShortSha>", or just "<version>" when gitShortSha is unknown, followed by "-dirty" when dirty

    @happy
    Scenario Outline: Formatting a version
      Given "known" with version <version>, gitShortSha <short> and dirty <dirty>
      When formatVersion is called with it
      Then it returns <text>

      Examples:
        | version | short   | dirty | text                  |
        | 0.3.0   | a1b2c3d | false | 0.3.0+a1b2c3d         |
        | 0.3.0   | a1b2c3d | true  | 0.3.0+a1b2c3d-dirty   |
        | 0.3.0   | unknown | false | 0.3.0                 |
        | 0.3.0   | unknown | true  | 0.3.0-dirty           |
        | unknown | a1b2c3d | false | unknown+a1b2c3d       |

    @boundary
    Scenario: gitSha, buildTime and gitRef do not affect the text
      When formatVersion is called with "known" with gitSha, buildTime and gitRef set to "unknown"
      Then it returns "0.3.0+a1b2c3d"

    @boundary
    Scenario: The unknown build info
      When formatVersion is called with unknownBuildInfo
      Then it returns "0.0.0"

  Rule: isIdentified is true exactly when gitSha is not "unknown"

    @happy
    Scenario Outline: Identifying a build
      Given "known" with <changes>
      When isIdentified is called with it
      Then it returns <result>

      Examples:
        | changes                                                  | result |
        | no changes                                               | true   |
        | version, gitShortSha, buildTime and gitRef all "unknown" | true   |
        | gitSha "Unknown"                                         | true   |
        | gitSha "unknown"                                         | false  |

    @boundary
    Scenario: The unknown build info is not identified
      When isIdentified is called with unknownBuildInfo
      Then it returns false

  Rule: commitUrl is "<REPO>/commit/<gitSha>", or undefined when gitSha is unknown

    @happy
    Scenario: URL for a known commit
      When commitUrl is called with "known"
      Then it returns "https://github.com/lunox-work/sandbox-factory/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

    @unhappy
    Scenario Outline: No URL without a commit
      When commitUrl is called with <info>
      Then it returns undefined

      Examples:
        | info                         |
        | "known" with gitSha unknown  |
        | unknownBuildInfo             |

    @boundary
    Scenario: Other fields do not matter
      Given "known" with version, gitShortSha, buildTime and gitRef all "unknown" and dirty true
      When commitUrl is called with it
      Then it returns "https://github.com/lunox-work/sandbox-factory/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

  Rule: sameBuild compares gitSha when both builds are identified; when either gitSha is unknown it is true

    @happy
    Scenario: Same commit, different build details
      Given "a" is "known"
      And "b" is "known" with version "0.4.0", buildTime "2026-11-05T08:30:00.000Z", gitRef "v0.4.0" and dirty true
      When sameBuild is called with "a" and "b"
      Then it returns true

    @happy
    Scenario: Different commits
      Given "a" is "known"
      And "b" is "known" with gitSha OTHER_SHA
      When sameBuild is called with "a" and "b"
      Then it returns false

    @boundary
    Scenario: Same short SHA but different full SHA
      Given "a" is "known"
      And "b" is "known" with gitSha "a1b2c3dffffffffffffffffffffffffffffffff0"
      When sameBuild is called with "a" and "b"
      Then it returns false

    @boundary
    Scenario Outline: An unknown commit is not reported as a mismatch
      When sameBuild is called with <a> and <b>
      Then it returns true

      Examples:
        | a                            | b                            |
        | "known"                      | unknownBuildInfo             |
        | unknownBuildInfo             | "known"                      |
        | unknownBuildInfo             | unknownBuildInfo             |
        | "known" with gitSha OTHER_SHA | "known" with gitSha unknown |

    @boundary
    Scenario: A build is the same as itself
      When sameBuild is called with "known" and "known"
      Then it returns true

    @boundary
    Scenario: The result does not depend on argument order
      Given "b" is "known" with gitSha OTHER_SHA
      Then sameBuild("known", "b") equals sameBuild("b", "known")
      And sameBuild("known", unknownBuildInfo) equals sameBuild(unknownBuildInfo, "known")

  Rule: buildBanner is "<name> <formatVersion(info)>", followed by " · commit <gitSha> · built <buildTime>" when the build is identified

    @happy
    Scenario Outline: Banners
      Given "known" with <changes>
      When buildBanner is called with name <name> and it
      Then it returns <banner>

      Examples:
        | name  | changes             | banner                                                                                                  |
        | "api" | no changes          | "api 0.3.0+a1b2c3d · commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 · built 2026-11-04T12:00:00.000Z"       |
        | "web" | dirty true          | "web 0.3.0+a1b2c3d-dirty · commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 · built 2026-11-04T12:00:00.000Z" |
        | "api" | buildTime "unknown" | "api 0.3.0+a1b2c3d · commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 · built unknown"                        |
        | "api" | gitSha "unknown"    | "api 0.3.0+a1b2c3d"                                                                                     |

    @boundary
    Scenario: Banner for the unknown build info
      When buildBanner is called with name "extension" and unknownBuildInfo
      Then it returns "extension 0.0.0"

    @boundary
    Scenario: gitRef is not part of the banner
      When buildBanner is called with name "api" and "known" with gitRef "unknown"
      Then it returns "api 0.3.0+a1b2c3d · commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 · built 2026-11-04T12:00:00.000Z"

    @boundary
    Scenario Outline: The name is used verbatim
      When buildBanner is called with name <name> and unknownBuildInfo
      Then it returns <banner>
      And nothing is thrown

      Examples:
        | name     | banner          |
        | ""       | " 0.0.0"        |
        | "  api " | "  api  0.0.0"  |

  Rule: The functions are pure and do not change their arguments

    @boundary
    Scenario: Arguments are left as they were
      Given a deep copy of "known"
      When formatVersion, isIdentified, commitUrl, buildBanner("api", ·) and sameBuild(·, ·) are each called with "known"
      Then "known" still deep-equals the copy
      And calling each function again with the same arguments returns the same result
```

The separator in banners is a space, U+00B7 MIDDLE DOT, and a space (`" · "`).

There are no `@concurrency` scenarios: every export is a pure function or a
constant value, so overlapping calls cannot interact.

## Decided:

- Fields of `BuildInfoDto` are `version`, `gitSha`, `gitShortSha`, `buildTime`, `gitRef` (required strings) and `dirty` (required boolean); there is no `repository` field.
  - Ticket: silent.
  - Instead: `version`, `commit`, `builtAt`, `repository`, all strings.
- An unknown field holds the string `UNKNOWN_BUILD` rather than being omitted or `null`; `dirty` is never unknown.
  - Ticket: `export const UNKNOWN_BUILD = "unknown";`
  - Instead: optional or nullable fields.
- The string fields accept any non-empty string; `gitSha` and `gitShortSha` are not checked as hex or for length, `buildTime` is not checked as a datetime, and values are not normalised.
  - Ticket: silent.
  - Instead: require a 40-character lowercase hex SHA and a `z.iso.datetime()` UTC timestamp.
- `version` is any non-empty string, not checked against semver.
  - Ticket: silent.
  - Instead: require a semver string.
- The repository in commit links is the fixed `https://github.com/lunox-work/sandbox-factory`, not a field of the build info.
  - Ticket: silent.
  - Instead: a `repository` field validated as an `https:` URL.
- Unknown keys are dropped, not rejected (plain `z.object`, as elsewhere in the package).
  - Ticket: silent.
  - Instead: `z.strictObject` rejecting extra keys.
- `versionResponseSchema` is the same schema object as `buildInfoSchema`; the response body is the build info itself.
  - Ticket: `export const versionResponseSchema = …;`
  - Instead: wrap it as `{ build: BuildInfoDto }`.
- `unknownBuildInfo` has `version` `"0.0.0"`, `dirty` `false` and `"unknown"` in the other fields; it is a plain object and is not frozen.
  - Ticket: `export const unknownBuildInfo: BuildInfoDto = …;`
  - Instead: `"unknown"` in every field, frozen.
- `formatVersion` is `"<version>+<gitShortSha>"` (semver build-metadata style), drops `+<gitShortSha>` when `gitShortSha` is unknown, and appends `"-dirty"` when `dirty`; it reads `gitShortSha`, not `gitSha`.
  - Ticket: `export function formatVersion(info: BuildInfoDto): string;`
  - Instead: `"<version> (<7-char commit>)"`, collapsing to `"unknown"`.
- `isIdentified` depends on `gitSha` alone, compared case-sensitively with `"unknown"`.
  - Ticket: `export function isIdentified(info: BuildInfoDto): boolean;`
  - Instead: require every field to be known.
- `commitUrl` returns `undefined` (not a throw or `""`) when `gitSha` is unknown, otherwise `"https://github.com/lunox-work/sandbox-factory/commit/<gitSha>"` with `gitSha` verbatim.
  - Ticket: `export function commitUrl(info: BuildInfoDto): string | undefined;`
  - Instead: build the URL from a per-build repository field.
- `sameBuild` compares only the full `gitSha`, and returns `true` when either side is unidentified (an unknown build is not reported as a mismatch).
  - Ticket: `export function sameBuild(a: BuildInfoDto, b: BuildInfoDto): boolean;`
  - Instead: an unknown commit never matches, even another unknown one; or deep equality of all fields.
- `buildBanner` is one line: `"<name> <formatVersion>"`, plus `" · commit <gitSha> · built <buildTime>"` when identified (even if `buildTime` is unknown); no `gitRef` or URL.
  - Ticket: `export function buildBanner(name: string, info: BuildInfoDto): string;`
  - Instead: `" built <builtAt>"` only when the time is known, or a multi-line banner with the commit URL.
- `buildBanner` uses `name` verbatim, empty or padded included, and never throws.
  - Ticket: silent.
  - Instead: trim the name and throw `TypeError("A build banner needs a name.")` when empty.
- The functions do not validate their arguments; behaviour is specified only for schema-valid input.
  - Ticket: silent.
  - Instead: parse the argument inside each function and throw on invalid input.
- The module is re-exported from `src/index.ts`.
  - Ticket: "In `packages/shared/src/build-info.ts`:"
  - Instead: expose it only through a separate subpath export.
