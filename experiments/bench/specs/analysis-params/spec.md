# Analysis vocabulary, watchdog retry rule and canonical JSON

Repository snapshots (`docs/architecture.md`, "Every head is snapshotted")
are to be analyzed by a private Graphify worker. The jobs, their failures and
the artifacts they upload are recorded by other packages, but the words those
records use and the two pure rules they share belong in `packages/core`, which
stays dependency-free so the same code bundles for the browser and for Node.
This change adds a new module, `packages/core/src/analysis.ts`, holding:

- the closed lists of analysis statuses, error codes and artifact kinds, and
  the tool version an analysis records;
- `expiredAnalysis`, which decides what the watchdog does with an analysis
  whose worker lost its lease: put it back in the queue for another attempt,
  or fail it (the caller records `worker_lost`, as `failExpired` does for
  bounty runs);
- `canonicalJson`, one fixed JSON encoding of data used as cache-key input,
  so that the same parameters written with their keys in another order give
  the same bytes and do not create another job.

## Exports of `packages/core/src/analysis.ts`

These are used exactly as the ticket gives them:

```ts
export const ANALYSIS_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const ANALYSIS_ERROR_CODES = [
  "too_large", "too_many_files", "source_unavailable", "tool_failed",
  "tool_timeout", "upload_failed", "worker_lost", "cancelled",
] as const;
export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];

export const ARTIFACT_KINDS = [
  "graph_json", "graph_html", "report_md", "wiki_page", "manifest", "other",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const GRAPHIFY_TOOL_VERSION = "graphifyy@0.4.18+driver-1";

export interface AnalysisParams {
  readonly deadlineMinutes: number;
}

export function expiredAnalysis(attempt: number, maxAttempts: number): {
  status: "queued" | "failed";
  attempt: number;
};

export function canonicalJson(value: unknown): string;
```

- The three lists are plain `as const` arrays in the order shown, and are not
  frozen at runtime, like `WHOLE_BOUNTY_COMPLEXITIES` in `bounty.ts`.
- `AnalysisParams` is a type only. It has no runtime counterpart and this
  change adds no validator for it.
- The module imports nothing: no Node built-ins and no other package.
- `packages/core/src/index.ts` adds `export * from "./analysis.js";` after the
  existing lines. All existing exports (`handle`, `bounty`, `selection`,
  `pricing`, `repo`) keep their names and behaviour. None of the new names
  clash with an existing export.
- Both functions are pure and synchronous. They hold no state between calls
  and never modify their arguments.

```gherkin
Feature: Analysis vocabulary, watchdog retry rule and canonical JSON

  Background:
    Given the exports of "packages/core/src/analysis.ts"

  Rule: The vocabulary lists hold exactly the ticket's values, in the ticket's order

    @happy
    Scenario: Each list holds its values in order
      Then each constant deep-equals its list:
        | constant             | values                                                                                                  |
        | ANALYSIS_STATUSES    | queued, running, succeeded, failed                                                                      |
        | ANALYSIS_ERROR_CODES | too_large, too_many_files, source_unavailable, tool_failed, tool_timeout, upload_failed, worker_lost, cancelled |
        | ARTIFACT_KINDS       | graph_json, graph_html, report_md, wiki_page, manifest, other                                           |

    @happy
    Scenario: The tool version is pinned
      Then GRAPHIFY_TOOL_VERSION equals "graphifyy@0.4.18+driver-1"

    @happy
    Scenario: The package entry point re-exports the module
      When the names are imported from "packages/core/src/index.ts"
      Then ANALYSIS_STATUSES, ANALYSIS_ERROR_CODES, ARTIFACT_KINDS, GRAPHIFY_TOOL_VERSION, expiredAnalysis and canonicalJson are the same values that "analysis.ts" exports

    @happy
    Scenario: AnalysisParams takes a deadline in minutes
      Given a value typed AnalysisParams equal to { deadlineMinutes: 30 }
      Then it type-checks and its deadlineMinutes is 30

  Rule: An expired attempt is requeued as the next attempt while attempts remain, and is otherwise failed as the attempt it was

    # `attempt` is the analysis's attempt number, raised by one each time the
    # watchdog requeues it (a retry count, not a count of lease claims).
    # `maxAttempts` is how many attempts the analysis may have in all.
    # When attempt < maxAttempts the result is { status: "queued", attempt: attempt + 1 },
    # where the returned attempt is the number the next run will have.
    # Otherwise the result is { status: "failed", attempt }, with attempt unchanged.

    @happy
    Scenario Outline: The watchdog's decision for an expired attempt
      When expiredAnalysis(<attempt>, <maxAttempts>) is called
      Then the result deep-equals { status: "<status>", attempt: <result> }

      Examples:
        | attempt | maxAttempts | status | result |
        | 1       | 3           | queued | 2      |
        | 2       | 3           | queued | 3      |
        | 3       | 3           | failed | 3      |

    @boundary
    Scenario Outline: Attempts at the edges of the limit
      When expiredAnalysis(<attempt>, <maxAttempts>) is called
      Then the result deep-equals { status: "<status>", attempt: <result> }

      Examples:
        | attempt                     | maxAttempts             | status | result                  |
        | 1                           | 1                       | failed | 1                       |
        | 1                           | 2                       | queued | 2                       |
        | 5                           | 3                       | failed | 5                       |
        | Number.MAX_SAFE_INTEGER - 1 | Number.MAX_SAFE_INTEGER | queued | Number.MAX_SAFE_INTEGER |
        | Number.MAX_SAFE_INTEGER     | Number.MAX_SAFE_INTEGER | failed | Number.MAX_SAFE_INTEGER |

    # The 5-of-3 row is an analysis that ran past a limit that was later lowered.
    # It fails and is not rejected.

    @boundary
    Scenario: Each call returns a new object
      When expiredAnalysis(1, 3) is called twice
      Then the two results deep-equal each other and are not the same object

  Rule: expiredAnalysis does not check its arguments and never throws

    # Any numbers go through the same comparison: attempt < maxAttempts requeues
    # as attempt + 1, anything else fails with attempt unchanged.

    @boundary
    Scenario Outline: Arguments that are not positive integers are compared as given
      When expiredAnalysis(<attempt>, <maxAttempts>) is called
      Then it does not throw
      And the result deep-equals { status: "<status>", attempt: <result> }

      Examples:
        | attempt | maxAttempts | status | result |
        | 0       | 3           | queued | 1      |
        | 1.5     | 3           | queued | 2.5    |
        | 1       | 0           | failed | 1      |
        | 0       | 0           | failed | 0      |
        | NaN     | 3           | failed | NaN    |

  Rule: canonicalJson writes data as compact JSON with object keys sorted by UTF-16 code units

    # No whitespace anywhere. Arrays keep their order. Each object's own
    # enumerable string keys are sorted by UTF-16 code unit, the order the
    # default Array.prototype.sort gives, at every depth. Strings and numbers
    # are written exactly as JSON.stringify writes them: non-ASCII is not
    # escaped, lone surrogates become lowercase \uXXXX escapes, -0 becomes 0,
    # 1e21 becomes 1e+21, and NaN, Infinity and -Infinity become null.
    # Symbol keys are ignored. Non-index properties of an array are ignored.

    @happy
    Scenario Outline: Values are written compactly
      When canonicalJson(<value>) is called
      Then it returns '<json>'

      Examples:
        | value                                   | json                          |
        | null                                    | null                          |
        | true                                    | true                          |
        | 42                                      | 42                            |
        | "héllo"                                 | "héllo"                       |
        | [3, 1, 2]                               | [3,1,2]                       |
        | { b: 1, a: [true, null], c: "x" }       | {"a":[true,null],"b":1,"c":"x"} |
        | { z: { y: 1, x: 2 }, a: [] }            | {"a":[],"z":{"x":2,"y":1}}    |
        | {}                                      | {}                            |

    @happy
    Scenario: Key order in the input does not change the output
      Given a = { b: 1, a: [true, null], c: "x" }
      And b = { c: "x", a: [true, null], b: 1 }
      Then canonicalJson(a) and canonicalJson(b) both return '{"a":[true,null],"b":1,"c":"x"}'

    @boundary
    Scenario: Keys sort by code unit, not numerically or by code point
      When canonicalJson is called with an object whose keys and values are:
        | key  | value |
        | b    | 1     |
        | a    | 2     |
        | B    | 3     |
        | 10   | 4     |
        | 9    | 5     |
        | ｚ   | 6     |
        | 😀   | 7     |
        | é    | 8     |
      Then it returns '{"10":4,"9":5,"B":3,"a":2,"b":1,"é":8,"😀":7,"ｚ":6}'

    # "10" comes before "9", which is not the integer-key order JavaScript
    # enumerates in. "😀" (U+D83D U+DE00) comes before "ｚ" (U+FF5A), which is
    # not code-point order.

    @boundary
    Scenario Outline: Numbers and strings follow JSON.stringify
      When canonicalJson(<value>) is called
      Then it returns '<json>'

      Examples:
        | value            | json                  |
        | -0               | 0                     |
        | 1e21             | 1e+21                 |
        | 0.1 + 0.2        | 0.30000000000000004   |
        | "\u0001"         | "\u0001"              |
        | "a\"b\\c\n"      | "a\"b\\c\n"           |
        | "\ud800"         | "\ud800"              |
        | NaN              | null                  |
        | [Infinity]       | [null]                |
        | { n: -Infinity } | {"n":null}            |

    @boundary
    Scenario: An object with no prototype is accepted
      Given o = Object.create(null) with o.b = 2 and o.a = 1
      Then canonicalJson(o) returns '{"a":1,"b":2}'

    @boundary
    Scenario Outline: Any other object is written as its own enumerable string keys
      When canonicalJson(<value>) is called
      Then it returns '<json>'

      Examples:
        | value                               | json          |
        | new Date(0)                         | {}            |
        | new Map([[1, 2]])                   | {}            |
        | new String("x")                     | {"0":"x"}     |
        | { d: new Date(0) }                  | {"d":{}}      |
        | an instance of a class setting b = 1 then a = 2 | {"a":2,"b":1} |

    # toJSON is never called: a Date is written as {} and not as its ISO string.

    @boundary
    Scenario: An array hole is written as nothing between the commas
      When canonicalJson([1, , 3]) is called
      Then it returns '[1,,3]'

    @boundary
    Scenario: Symbol keys and extra array properties are ignored
      Given o = { a: 1, [Symbol("s")]: 2 }
      And arr = [1, 2] with arr.extra = 3
      Then canonicalJson(o) returns '{"a":1}'
      And canonicalJson(arr) returns '[1,2]'

    @boundary
    Scenario: A value shared by two branches but not cyclic is written at both places
      Given shared = { k: 1 }
      Then canonicalJson({ x: shared, y: [shared] }) returns '{"x":{"k":1},"y":[{"k":1}]}'

    @happy
    Scenario: The input is not modified
      Given input = { b: [2, 1], a: { d: 1, c: 2 } }
      When canonicalJson(input) is called
      Then Object.keys(input) is still ["b", "a"]
      And input.b is still [2, 1]
      And Object.keys(input.a) is still ["d", "c"]

  Rule: canonicalJson throws for undefined, functions, symbols, bigints and cycles

    # undefined, functions and symbols throw an Error (not a TypeError) with
    # message exactly "Cache parameters must be JSON values.", wherever they
    # appear: at the top level, as an array element, or as an object property
    # value. A property whose value is undefined is not left out; it throws.
    # A bigint anywhere throws a TypeError. A cyclic structure throws a RangeError.

    @unhappy
    Scenario Outline: undefined, functions and symbols are refused
      When canonicalJson(<value>) is called
      Then it throws an Error with message "Cache parameters must be JSON values."

      Examples:
        | value                    |
        | undefined                |
        | [1, undefined]           |
        | { b: undefined, a: 1 }   |
        | () => 1                  |
        | { f: () => 1 }           |
        | Symbol("s")              |
        | { toJSON: () => 1 }      |

    # The last row shows that toJSON is not special: it is a function-valued
    # property like any other.

    @unhappy
    Scenario Outline: A bigint is refused
      When canonicalJson(<value>) is called
      Then it throws a TypeError

      Examples:
        | value      |
        | 10n        |
        | { n: 10n } |

    @unhappy
    Scenario: A cyclic structure is refused
      Given o = { a: 1 } with o.self = o
      When canonicalJson(o) is called
      Then it throws a RangeError

    @unhappy
    Scenario: A cycle through an array is refused
      Given arr = [] with arr.push(arr)
      When canonicalJson(arr) is called
      Then it throws a RangeError
```

Decided:
- Meaning of `attempt`: the analysis's attempt number, raised by one only when the watchdog requeues it (a retry count, not a count of lease claims). A requeue returns `attempt + 1`, the next attempt's number. A failure returns `attempt` unchanged.
- Requeue boundary: requeue when `attempt < maxAttempts`, otherwise fail. So `maxAttempts` is the total number of attempts allowed.
- `attempt > maxAttempts` (the limit was lowered): fail with `attempt` unchanged. It is not rejected.
- `expiredAnalysis` does not validate its arguments and never throws: `expiredAnalysis(0, 3)` is `{ status: "queued", attempt: 1 }`, `expiredAnalysis(1, 0)` is `{ status: "failed", attempt: 1 }`, `expiredAnalysis(NaN, 3)` is `{ status: "failed", attempt: NaN }`.
- `canonicalJson` key order: own enumerable string keys sorted by UTF-16 code unit at every depth, the JCS (RFC 8785) convention.
- `canonicalJson` layout: no whitespace, arrays in order, strings and numbers exactly as `JSON.stringify` writes them (`-0` → `0`, non-ASCII unescaped, lone surrogates escaped, `NaN` and `±Infinity` → `null`).
- Any non-array object, whatever its prototype, is written as its own enumerable string keys: `new Date(0)` → `{}`, `new Map()` → `{}`, `new String("x")` → `{"0":"x"}`. `toJSON` is never called.
- An array hole is written as nothing: `[1, , 3]` → `[1,,3]`.
- Values `canonicalJson` refuses: `undefined` (at the top level, as an array element and as an object property value), functions and symbols throw an `Error` with message `"Cache parameters must be JSON values."`; bigints throw a `TypeError`; cycles throw a `RangeError`. The last two have no fixed message.
- Symbol keys and non-index array properties are ignored. A non-cyclic shared reference is written each place it appears.
- `AnalysisParams` stays a type only, with no validator, because the ticket gives none.
- The vocabulary arrays are not frozen at runtime, matching `bounty.ts`.
- `index.ts` re-exports the new module, as it does every other core module.
- No `@concurrency` scenarios: both functions are synchronous and stateless, so calls cannot overlap.
