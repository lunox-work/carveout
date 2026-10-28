# Handle rules in `packages/core`

Organizations (#24) need public handles just as users already have. Today the
rules for a user handle live privately in `packages/db/src/emails.ts`: the
`USERNAME_*` constants, the `[a-z0-9_-]` pattern inside `setUsername`, and the
`toHandleBase`/`trimHyphens` helpers behind `suggest`. This change adds a new,
dependency-free module, `packages/core/src/handle.ts`, that owns those rules so
users and organizations share them. It covers casing, validation, normalization
of typed input, and deriving a candidate handle ("stem") from free text or an
email address. Uniqueness (`dana`, `dana2`, …) still needs a store, so it is not
part of this module.

## Exports

`packages/core/src/handle.ts` exports exactly the following, with these
signatures:

```ts
export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;

export type HandleProblem = "length" | "charset";

export interface HandleRejected {
  readonly status: "invalid";
  readonly problem: HandleProblem;
  readonly reason: string;
}

export type HandleCheck = { readonly status: "ok" } | HandleRejected;

export function toHandleCase(raw: string): string;
export function checkHandle(handle: string): HandleCheck;

export type NormalizedHandle =
  | {
      readonly status: "ok";
      readonly handle: string;
      readonly display: string;
    }
  | HandleRejected;

export function normalizeHandle(raw: string): NormalizedHandle;
export function isValidHandle(raw: string): boolean;
export function toHandleStem(text: string): string;
export function handleStemFromEmail(email: string): string;
```

- The allowed character set is `a`–`z`, `0`–`9`, `-` and `_`. The module keeps
  it in a private pattern, `/^[a-z0-9_-]+$/`, and does not export it.
- `packages/core/src/index.ts` adds one line, `export * from "./handle.js";`, so
  these exports are also available from the package root (`sandbox-factory`).
  Every existing export of `index.ts` (`Todo`, `TITLE_MAX_LENGTH`,
  `TODO_FILTERS`, `TodoFilter`, `isTodoFilter`, `InvalidTitleError`,
  `normalizeTitle`, `isValidTitle`, `toggle`, `rename`, `matchesFilter`,
  `filterTodos`, `TodoCounts`, `countTodos`) keeps its current behaviour.
- Nothing outside `packages/core` changes. `packages/db` keeps its own
  `USERNAME_*` constants and helpers for now.
- Every function is pure and synchronous. None of them throws for any string
  input, mutates anything, or keeps state between calls. Each call returns a
  new plain object (not frozen) with exactly the keys shown in this spec.
  Calling with a non-string is outside the contract. There is no runtime type
  guard, and tests must not call with a non-string.
- All lengths are `String.prototype.length`, which counts UTF-16 code units.
- The two rejection reasons are fixed strings, built from the constants:
  - `length`: `Must be between 3 and 30 characters.`
  - `charset`: `Can use letters, numbers, hyphens and underscores only.`

```gherkin
Feature: Handle rules shared by users and organizations
  A handle is the lowercase identifier used in URLs and mentions. It is
  3 to 30 characters, each from a-z, 0-9, "-" or "_". People may type it
  in any casing with surrounding whitespace. Candidate handles can be
  derived from free text or an email address.

  Background:
    Given the exports of "packages/core/src/handle.ts"
    And HANDLE_MIN_LENGTH is 3 and HANDLE_MAX_LENGTH is 30

  Rule: The length limits are the exported constants

    @happy
    Scenario: The constants have the documented values
      Then HANDLE_MIN_LENGTH equals 3
      And HANDLE_MAX_LENGTH equals 30

    @happy
    Scenario: The handle exports are also reachable from the package root
      When the test imports checkHandle, normalizeHandle, isValidHandle, toHandleCase, toHandleStem, handleStemFromEmail, HANDLE_MIN_LENGTH and HANDLE_MAX_LENGTH from "packages/core/src/index.ts"
      Then each one is the same value as the export of "packages/core/src/handle.ts"

  Rule: toHandleCase trims surrounding whitespace and lowercases, and does nothing else

    @happy
    Scenario Outline: Casing raw input
      When toHandleCase is called with <raw>
      Then it returns <cased>

      Examples:
        | raw                 | cased            |
        | "FeverSoul"         | "feversoul"      |
        | "  FeverSoul  "     | "feversoul"      |
        | "\tRivers-Dana\n"   | "rivers-dana"    |
        | "a-b_c9"            | "a-b_c9"         |
        | "Has Space"         | "has space"      |
        | "has.dot"           | "has.dot"        |
        | "ÉCOLE"             | "école"          |
        | ""                  | ""               |
        | "   "               | ""               |

    @boundary
    Scenario: toHandleCase is idempotent
      Given the raw input "  Mixed_Case-9  "
      When toHandleCase is applied to its own output
      Then the result is still "mixed_case-9"

  Rule: checkHandle checks an already-cased handle as given, with no trimming or lowercasing

    @happy
    Scenario Outline: Valid handles
      When checkHandle is called with <handle>
      Then it returns exactly { status: "ok" }

      Examples:
        | handle           |
        | "abc"            |
        | "feversoul"      |
        | "a-b_c9"         |
        | "-ab"            |
        | "___"            |
        | "123"            |
        | "dana--rivers"   |

    @boundary
    Scenario Outline: Length is inclusive at both limits
      When checkHandle is called with a handle of <length> "x" characters
      Then it returns <result>

      Examples:
        | length | result                                                                                          |
        | 0      | { status: "invalid", problem: "length", reason: "Must be between 3 and 30 characters." } |
        | 2      | { status: "invalid", problem: "length", reason: "Must be between 3 and 30 characters." } |
        | 3      | { status: "ok" }                                                                                |
        | 30     | { status: "ok" }                                                                                |
        | 31     | { status: "invalid", problem: "length", reason: "Must be between 3 and 30 characters." } |

    @unhappy
    Scenario Outline: Characters outside a-z, 0-9, "-" and "_" are rejected
      When checkHandle is called with <handle>
      Then it returns exactly { status: "invalid", problem: "charset", reason: "Can use letters, numbers, hyphens and underscores only." }

      Examples:
        | handle       | why                                  |
        | "has space"  | space                                |
        | "has/slash"  | slash                                |
        | "has@at"     | at sign                              |
        | "has.dot"    | dot                                  |
        | "FeverSoul"  | uppercase is not lowercased here     |
        | " abc"       | whitespace is not trimmed here       |
        | "abc\n"      | trailing newline is not trimmed here |
        | "école"      | non-ASCII letter                     |
        | "😀😀"       | 4 UTF-16 code units, so length is ok |

    @boundary
    Scenario Outline: Length is checked before the character set, and only one problem is reported
      When checkHandle is called with <handle>
      Then the result has status "invalid" and problem <problem>

      Examples:
        | handle                   | problem   | why                                       |
        | "a."                     | "length"  | too short and a bad character             |
        | "éé"                     | "length"  | 2 code units, too short                   |
        | "x x x x x x x x x x x x x x x x" | "length" | 31 characters including spaces   |
        | "a.b"                    | "charset" | right length, bad character               |

  Rule: normalizeHandle trims and lowercases raw input, then applies checkHandle to the lowercased form

    @happy
    Scenario Outline: Accepted input keeps the typed casing for display
      When normalizeHandle is called with <raw>
      Then it returns exactly { status: "ok", handle: <handle>, display: <display> }

      Examples:
        | raw                | handle         | display        |
        | "  FeverSoul  "    | "feversoul"    | "FeverSoul"    |
        | "dana"             | "dana"         | "dana"         |
        | "\tRivers-Dana\n"  | "rivers-dana"  | "Rivers-Dana"  |
        | "A-B_C9"           | "a-b_c9"       | "A-B_C9"       |

    @boundary
    Scenario Outline: Length is measured after trimming
      When normalizeHandle is called with <raw>
      Then the result status is <status>

      Examples:
        | raw                                   | status    |
        | "  abc  "                             | "ok"      |
        | " ab "                                | "invalid" |
        | 30 "X" characters with 2 spaces each side | "ok"  |
        | 31 "x" characters                     | "invalid" |
        | ""                                    | "invalid" |
        | "    "                                | "invalid" |

    @unhappy
    Scenario Outline: Rejected input returns the checkHandle rejection unchanged and no display
      When normalizeHandle is called with <raw>
      Then it returns exactly { status: "invalid", problem: <problem>, reason: <reason> }
      And the result has no "handle" or "display" key

      Examples:
        | raw            | problem   | reason                                                            |
        | "ab"           | "length"  | "Must be between 3 and 30 characters."                     |
        | "   "          | "length"  | "Must be between 3 and 30 characters."                     |
        | "Has Space"    | "charset" | "Can use letters, numbers, hyphens and underscores only."  |
        | "rivers.dana"  | "charset" | "Can use letters, numbers, hyphens and underscores only."  |
        | "École"        | "charset" | "Can use letters, numbers, hyphens and underscores only."  |

    @boundary
    Scenario: The normalized handle passes checkHandle and equals toHandleCase of the input
      Given the raw input "  Rivers_Dana-9 "
      When normalizeHandle is called with it
      Then the returned handle is "rivers_dana-9"
      And it equals toHandleCase("  Rivers_Dana-9 ")
      And checkHandle("rivers_dana-9") returns { status: "ok" }

  Rule: isValidHandle is true exactly when normalizeHandle would return status "ok"

    @happy
    Scenario Outline: isValidHandle agrees with normalizeHandle
      When isValidHandle is called with <raw>
      Then it returns <valid>

      Examples:
        | raw                 | valid |
        | "feversoul"         | true  |
        | "  FeverSoul  "     | true  |
        | "a-b_c9"            | true  |
        | 30 "x" characters   | true  |
        | "ab"                | false |
        | 31 "x" characters   | false |
        | ""                  | false |
        | "has space"         | false |
        | "has.dot"           | false |

  Rule: toHandleStem derives a handle that always passes checkHandle

    The steps, in order:
    1. Lowercase the whole text with toLowerCase.
    2. Replace each maximal run of characters outside a-z, 0-9, "-" and "_"
       with a single "-". Hyphens already in the text are kept as they are.
    3. Strip all leading and trailing "-" ("_" is not stripped).
    4. Keep the first HANDLE_MAX_LENGTH (30) characters. Hyphens are not
       stripped again, so a cut can leave the stem ending in "-".
    5. If fewer than HANDLE_MIN_LENGTH (3) characters remain, append "-user".
    The function runs in linear time in the length of the text.

    @happy
    Scenario Outline: Deriving a stem from free text
      When toHandleStem is called with <text>
      Then it returns <stem>

      Examples:
        | text                  | stem                  |
        | "Acme Corp"           | "acme-corp"           |
        | "  Acme, Inc.  "      | "acme-inc"            |
        | "rivers.dana+work"    | "rivers-dana-work"    |
        | "--dana--rivers--"    | "dana--rivers"        |
        | "a -b"                | "a--b"                |
        | "_dana_"              | "_dana_"              |
        | "Zoë Café"            | "zo-caf"              |
        | "dana@example.test"   | "dana-example-test"   |

    @boundary
    Scenario Outline: Short stems are padded with "-user"
      When toHandleStem is called with <text>
      Then it returns <stem>

      Examples:
        | text       | stem       |
        | "jo"       | "jo-user"  |
        | "QA"       | "qa-user"  |
        | "x"        | "x-user"   |
        | "abc"      | "abc"      |
        | ""         | "-user"    |
        | "日本"      | "-user"    |
        | "!!!"      | "-user"    |
        | "-a-"      | "a-user"   |

    @boundary
    Scenario Outline: Long stems are cut to 30 characters, even when the cut ends in a hyphen
      When toHandleStem is called with <text>
      Then it returns <stem>

      Examples:
        | text                                  | stem                                    |
        | 60 "x" characters                     | 30 "x" characters                       |
        | 30 "x" characters                     | 30 "x" characters                       |
        | 29 "x" characters followed by ".y"    | 29 "x" characters followed by "-"       |
        | 29 "-" characters followed by "abcdef" | "abcdef"                               |
        | "ab" followed by 40 "-" characters and "cd" | "ab" followed by 28 "-" characters |

    @boundary
    Scenario: A very long run of hyphens is handled
      When toHandleStem is called with 100000 "-" characters
      Then it returns "-user"

    @boundary
    Scenario Outline: Every derived stem passes checkHandle and is unchanged by toHandleCase
      When toHandleStem is called with <text>
      Then checkHandle of the result returns { status: "ok" }
      And toHandleCase of the result equals the result

      Examples:
        | text                                  |
        | "Acme Corp"                           |
        | ""                                    |
        | "jo"                                  |
        | 29 "x" characters followed by ".y"    |
        | 200 "-" characters                    |
        | "日本"                                 |

  Rule: handleStemFromEmail applies toHandleStem to the local part of the address

    The local part is everything before the first "@". With no "@", the
    whole string is used. The domain is ignored and the address is not
    otherwise validated.

    @happy
    Scenario Outline: Deriving a stem from an email address
      When handleStemFromEmail is called with <email>
      Then it returns <stem>

      Examples:
        | email                            | stem                |
        | "dana@example.test"              | "dana"              |
        | "rivers.dana+work@example.test"  | "rivers-dana-work"  |
        | "Rivers.Dana@example.test"       | "rivers-dana"       |
        | "--dana--rivers--@example.test"  | "dana--rivers"      |
        | "jo@example.test"                | "jo-user"           |

    @boundary
    Scenario Outline: Edge-case addresses
      When handleStemFromEmail is called with <email>
      Then it returns <stem>

      Examples:
        | email                                   | stem                |
        | "@example.test"                         | "-user"             |
        | ""                                      | "-user"             |
        | "no-at-sign"                            | "no-at-sign"        |
        | "a@b@example.test"                      | "a-user"            |
        | 60 "x" characters followed by "@example.test" | 30 "x" characters |
        | 200 "-" characters followed by "@example.test" | "-user"      |

    @boundary
    Scenario: The result equals toHandleStem of the local part
      Given the email "Rivers.Dana+Work@Example.Test"
      Then handleStemFromEmail of it equals toHandleStem("Rivers.Dana+Work")
      And that value is "rivers-dana-work"
```

Decided:
- Module surface: the private pattern is not exported; `index.ts` re-exports all of `handle.ts`, and existing core exports are unchanged; `packages/db` is untouched.
- Allowed characters: `a-z`, `0-9`, `-`, `_`, with no rule about leading or trailing `-`/`_` (same as `setUsername`).
- `toHandleCase` uses `String.prototype.trim` then `toLowerCase`, and inner whitespace is kept.
- `checkHandle` does no trimming or lowercasing, so uppercase or surrounding whitespace is a `charset` problem.
- Length is counted in UTF-16 code units, and both limits are inclusive.
- Length is checked before the character set, and only the first problem is reported.
- Reason strings are fixed: `Must be between 3 and 30 characters.` and `Can use letters, numbers, hyphens and underscores only.`
- `normalizeHandle`: `display` is the trimmed input with its typed casing; a rejection returns exactly the `checkHandle` result, with no `display`.
- `isValidHandle` takes raw input and agrees with `normalizeHandle`, like `isValidTitle` does with `normalizeTitle`.
- Stem derivation order: trim hyphens before truncating (keeps `toHandleBase` results), and do not trim again after truncating, so the cut can leave a trailing `-` (29 `x` then `.y` gives 29 `x` then `-`).
- Short stems are padded with `-user` for both free text and email, and an empty stem becomes `-user` (keeps `toHandleBase` results).
- `toHandleStem` treats `@` like any other disallowed character; only `handleStemFromEmail` splits on the first `@`, and with no `@` it uses the whole string.
- Errors: no function throws for any string; invalid input is reported through `status: "invalid"`, never an exception.
- Overlapping calls: all functions are pure and synchronous with no shared state, so there are no `@concurrency` scenarios.
- Uniqueness suffixes (`dana2`, random fallback) stay out of scope because they need a store.
