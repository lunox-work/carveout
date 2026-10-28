# Native tickets: one definition of ticket content, limits, keys and the spec hash

Tickets can now be written in the platform ("manual") as well as read from
Jira ("jira"), and both kinds are priced. Today the rules for a ticket's text
live in `packages/jira/src/spec.ts`, so a native ticket has nowhere to take
them from. This change adds a new dependency-free module,
`packages/core/src/ticket.ts`, that owns them once: the ticket origins, the
ticket limits, the default issue type, title clamping, the shape of a
ticket's content, the spec-text normalization, the pricing fingerprint
(`ticketSpecHash`, which **is** the existing Jira `pricingSpecHash`: same
inputs, same 64-character hex, so every stored hash stays valid) and the
display key of a ticket. The module is imported from
`packages/core/src/ticket.ts`; `packages/core/src/index.ts` is not changed by
this change, and nothing else changes in `packages/core`.

## Exports of `packages/core/src/ticket.ts`

```ts
/** Where a ticket came from: written here, or read from Jira. */
export const TICKET_ORIGINS = ["manual", "jira"] as const;
export type TicketOrigin = (typeof TICKET_ORIGINS)[number];

/** Caps on a ticket's fields, in UTF-16 code units (`String.length`) or entries. */
export const TICKET_LIMITS = {
  title: 255,
  description: 20_000,
  issueType: 64,
  priority: 64,
  labels: 20,
  label: 64,
} as const;

/** The issue type a ticket has when it names none (Jira's own fallback). */
export const DEFAULT_ISSUE_TYPE = "Task";

export function clampTicketTitle(title: string): string;

export interface TicketContent {
  readonly title: string;
  readonly description: string;
  readonly issueType: string;
  readonly priority: string | null;
  readonly labels: readonly string[];
  readonly components: readonly string[];
  readonly inputTruncated: boolean;
}

/** The version of the fingerprint `ticketSpecHash` produces (stored as `specHashVersion`). */
export const TICKET_SPEC_HASH_VERSION = 1;

export async function ticketSpecHash(
  title: string,
  description: string,
  issueType: string,
): Promise<string>;

export function normalizeSpecText(value: string): string;

export function ticketKey(ticket: {
  readonly number: number;
  readonly jiraKey?: string | null | undefined;
}): string;
```

- `TicketContent` is a type only; it has no runtime behaviour. `labels` and
  `components` are not part of any hash.
- `ticketSpecHash` uses `crypto.subtle.digest("SHA-256", …)` over
  `new TextEncoder().encode(JSON.stringify([normalizeSpecText(title),
  normalizeSpecText(description), normalizeSpecText(issueType)]))` and returns
  the digest as lowercase hex. It must not import `node:crypto`.
- Every existing export of `packages/core` (`handle`, `bounty`, `selection`,
  `pricing`, `repo`, `analysis`, `slice`, `sandbox`) keeps its name, signature
  and behaviour; none of them is renamed or moved by this change.

```gherkin
Feature: Ticket content rules shared by native and Jira tickets
  Every surface takes a ticket's origins, limits, default issue type,
  title clamp, spec normalization, pricing fingerprint and display key
  from packages/core/src/ticket.ts.

  Rule: The constants have one fixed definition

    @happy
    Scenario: The origins are manual then jira
      When TICKET_ORIGINS is read
      Then it equals ["manual", "jira"] in that order

    @happy
    Scenario: The default issue type and the hash version
      Then DEFAULT_ISSUE_TYPE equals "Task"
      And TICKET_SPEC_HASH_VERSION equals 1

    @happy
    Scenario: The ticket limits
      When TICKET_LIMITS is read
      Then it deep-equals exactly these keys and values
        | key         | value |
        | title       | 255   |
        | description | 20000 |
        | issueType   | 64    |
        | priority    | 64    |
        | labels      | 20    |
        | label       | 64    |

  Rule: normalizeSpecText removes line-ending and edge whitespace noise and keeps the words
    Lines are split on "\r\n", "\r" or "\n"; each line loses its trailing
    whitespace (String.prototype.trimEnd); the lines are joined with "\n";
    the result is trimmed at both ends (String.prototype.trim). Leading
    indentation of any line but the first, inner spaces and blank lines
    between text are kept. It never throws.

    @happy
    Scenario Outline: Normalizing spec text
      When normalizeSpecText is called with <input>
      Then it returns <output>

      Examples:
        | input                            | output             |
        | "One\nTwo"                       | "One\nTwo"         |
        | "One  \r\nTwo\t"                 | "One\nTwo"         |
        | "One\rTwo"                       | "One\nTwo"         |
        | "  a  \r\n\r\n b\t\r c  "        | "a\n\n b\n c"      |
        | "Add  export"                    | "Add  export"      |
        | "\n\nTitle\n\n"                  | "Title"            |

    @boundary
    Scenario Outline: Empty and whitespace-only text normalizes to the empty string
      When normalizeSpecText is called with <input>
      Then it returns ""

      Examples:
        | input        |
        | ""           |
        | "   "        |
        | "\r\n\t\n "  |

    @boundary
    Scenario: Normalizing is idempotent
      Given the text "  a  \r\n\r\n b\t\r c  "
      When normalizeSpecText is applied to it twice
      Then the result equals applying it once: "a\n\n b\n c"

  Rule: ticketSpecHash fingerprints title, description and issue type, version 1
    The hash is SHA-256 of the JSON array of the three normalized strings, as
    64 lowercase hex characters. It is byte-for-byte the value the Jira
    package's pricingSpecHash returns for the same three arguments. It does
    not clamp the title, does not default an empty issue type, and is
    case-sensitive in every field.

    @happy
    Scenario Outline: Known fingerprints
      When ticketSpecHash(<title>, <description>, <issueType>) is awaited
      Then it resolves to <hash>

      Examples:
        | title        | description | issueType | hash                                                             |
        | "Add export" | "Adds CSV." | "Story"   | 3b83fc961d8b052c4ebb2269255f29a3e901b27eb21f7452ea5f9ac5c5d77444 |
        | "Add export" | "Adds CSV." | "Bug"     | 7e3c32427cf03005b0304866833c254926f931bbe4beedea60c2e6297afbacc2 |
        | "Fix it"     | ""          | "Task"    | cddb635f134a4d5762ecb6231a36db6d93e45e613c8fc8c2d19837e5aaf6c16c |

    @boundary
    Scenario: An entirely empty ticket still hashes
      When ticketSpecHash("", "", "") is awaited
      Then it resolves to "799c55d702efedb7750db18b36386fc3a3f4be7dddcfb649adeb41a3ed0da228"
      And the result matches /^[0-9a-f]{64}$/

    @boundary
    Scenario: An empty issue type is not replaced by the default
      When ticketSpecHash("Fix it", "", "") and ticketSpecHash("Fix it", "", "Task") are awaited
      Then the two results differ

    @happy
    Scenario: Line-ending and trailing whitespace noise does not change the hash
      When ticketSpecHash("Title  ", "One  \r\nTwo\t", " Story ") is awaited
      Then it equals ticketSpecHash("Title", "One\nTwo", "Story")

    @happy
    Scenario Outline: A change of meaning changes the hash
      When ticketSpecHash("Add export", "Adds CSV.", "Story") is compared with ticketSpecHash(<title>, <description>, <issueType>)
      Then the two results differ

      Examples:
        | title        | description  | issueType |
        | "Add import" | "Adds CSV."  | "Story"   |
        | "Add export" | "Adds JSON." | "Story"   |
        | "Add export" | "Adds CSV."  | "Bug"     |
        | "add export" | "Adds CSV."  | "Story"   |
        | "Add  export" | "Adds CSV."  | "Story"   |

    @unhappy
    Scenario Outline: Text cannot be shifted between fields to forge a hash
      When ticketSpecHash(<a1>, <a2>, <a3>) is compared with ticketSpecHash(<b1>, <b2>, <b3>)
      Then the two results differ

      Examples:
        | a1    | a2    | a3     | b1   | b2     | b3     |
        | "AB"  | ""    | "Task" | "A"  | "B"    | "Task" |
        | "a\"b" | "c"   | "Task" | "a"  | "\"b"  | "Task" |
        | "A"   | "B"   | ""     | "A"  | ""     | "B"    |

    @happy
    Scenario: The same ticket hashes the same every time
      When ticketSpecHash("Add export", "Adds CSV.", "Story") is awaited twice
      Then both results are equal

    @concurrency
    Scenario: Overlapping hash calls do not interfere
      When these three calls are started together and awaited with Promise.all
        | title        | description | issueType |
        | "Add export" | "Adds CSV." | "Story"   |
        | "Add export" | "Adds CSV." | "Bug"     |
        | "Fix it"     | ""          | "Task"    |
      Then the results, in call order, are
        | hash                                                             |
        | 3b83fc961d8b052c4ebb2269255f29a3e901b27eb21f7452ea5f9ac5c5d77444 |
        | 7e3c32427cf03005b0304866833c254926f931bbe4beedea60c2e6297afbacc2 |
        | cddb635f134a4d5762ecb6231a36db6d93e45e613c8fc8c2d19837e5aaf6c16c |

  Rule: clampTicketTitle cuts a title to TICKET_LIMITS.title code units, without splitting a surrogate pair
    The title is not trimmed and no ellipsis is added. It is cut to its first
    255 UTF-16 code units (a title of at most 255 is returned unchanged,
    whitespace included); if the cut ends on a high surrogate (U+D800 to
    U+DBFF) that code unit is dropped too. The result is never longer than
    255 code units, never rejected and never throws; "" returns "".

    @happy
    Scenario Outline: Titles within the limit are returned unchanged
      When clampTicketTitle is called with <title>
      Then it returns <result>

      Examples:
        | title                  | result               |
        | "Add export"           | "Add export"         |
        | "  Add export \n"      | "  Add export \n"    |
        | "Add   CSV  export"    | "Add   CSV  export"  |

    @boundary
    Scenario Outline: The length boundary
      When clampTicketTitle is called with <title>
      Then it returns <result>
      And the result has length <length>

      Examples:
        | title                                | result                        | length |
        | "x" repeated 255 times               | "x" repeated 255 times        | 255    |
        | "x" repeated 256 times               | "x" repeated 255 times        | 255    |
        | "  " + "x" repeated 255 times + "  " | "  " + "x" repeated 253 times | 255    |
        | "x" repeated 1000 times              | "x" repeated 255 times        | 255    |

    @boundary
    Scenario Outline: Empty and blank titles are not changed
      When clampTicketTitle is called with <title>
      Then it returns <title>

      Examples:
        | title    |
        | ""       |
        | "   "    |
        | "\n\t "  |

    @boundary
    Scenario: Whitespace before the cut is kept
      Given a title of "x" repeated 250 times, then 5 spaces, then "y" repeated 10 times (length 265)
      When clampTicketTitle is called with it
      Then it returns "x" repeated 250 times + 5 spaces
      And the result has length 255

    @boundary
    Scenario: A surrogate pair that fits whole is kept
      Given a title of "a" repeated 253 times, then "😀", then "b" (length 256)
      When clampTicketTitle is called with it
      Then it returns "a" repeated 253 times + "😀"
      And the result has length 255

    @boundary
    Scenario: A cut never splits a surrogate pair
      Given a title of "a" repeated 254 times, then "😀" (length 256)
      When clampTicketTitle is called with it
      Then it returns "a" repeated 254 times
      And the result has length 254

    @boundary
    Scenario: Clamping is idempotent
      Given the title "x" repeated 300 times
      When clampTicketTitle is applied to it twice
      Then the result equals applying it once: "x" repeated 255 times

  Rule: ticketKey shows a ticket by its Jira key when it has one, and by "T-" and its number otherwise
    A jiraKey that is a string (including "" or whitespace only) is returned
    exactly as given, not trimmed. When jiraKey is null, undefined or absent
    the key is "T-" followed by the number as JavaScript formats it. The
    number is never checked and ticketKey never throws.

    @happy
    Scenario Outline: Choosing the key
      When ticketKey is called with <ticket>
      Then it returns <key>

      Examples:
        | ticket                               | key           |
        | { number: 7, jiraKey: "ACME-12" }    | "ACME-12"     |
        | { number: 7, jiraKey: " ACME-12 " }  | " ACME-12 "   |
        | { number: 7 }                        | "T-7"         |
        | { number: 7, jiraKey: null }         | "T-7"         |
        | { number: 7, jiraKey: undefined }    | "T-7"         |
        | { number: 1042 }                     | "T-1042"      |

    @boundary
    Scenario Outline: Blank Jira keys are returned as they are
      When ticketKey is called with { number: 3, jiraKey: <jiraKey> }
      Then it returns <jiraKey>

      Examples:
        | jiraKey |
        | ""      |
        | "   "   |

    @boundary
    Scenario Outline: The number is used as given
      When ticketKey is called with { number: <number> }
      Then it returns <key> without throwing

      Examples:
        | number                  | key                  |
        | 1                       | "T-1"                |
        | 9007199254740991        | "T-9007199254740991" |
        | 0                       | "T-0"                |
        | -1                      | "T--1"               |
        | 1.5                     | "T-1.5"              |

    @boundary
    Scenario: A Jira key makes the number irrelevant
      When ticketKey is called with { number: 0, jiraKey: "ACME-1" }
      Then it returns "ACME-1" without throwing
```

Decided:
- `TICKET_LIMITS` keys and values: `title` 255, `description` 20 000 (the ADF cap), `issueType` 64, `priority` 64, `labels` 20 (entries), `label` 64. There is no component limit. It is a plain `as const` object and is not frozen at run time.
- Lengths are counted in UTF-16 code units (`String.length`), the same way zod `.max` counts them.
- `clampTicketTitle` only cuts to the first 255 code units: no trim, no ellipsis, inner and edge whitespace and line breaks left alone, so titles already hashed keep their hashes. It never rejects or throws.
- `clampTicketTitle` drops a high surrogate left at the cut, so an emoji is never split.
- An empty or blank title is returned unchanged and is not rejected.
- `normalizeSpecText` behaves exactly like the Jira package's private `normalize`, including a final trim at both ends.
- `ticketSpecHash` matches `pricingSpecHash` byte for byte: SHA-256 of the JSON array of three normalized strings, as lowercase hex.
- `ticketSpecHash` does not clamp the title, does not swap an empty issue type for `DEFAULT_ISSUE_TYPE`, and is case-sensitive.
- `ticketSpecHash` calls are independent: overlapping calls resolve in call order to their own hashes.
- `ticketKey`: any string `jiraKey`, blank included, is returned as given, untrimmed. Only a null or missing `jiraKey` falls back to `T-<number>`.
- `ticketKey` never checks the number and never throws; `0`, negatives and fractions are formatted as given (`T-0`, `T--1`, `T-1.5`).
- `packages/core/src/index.ts` does not re-export `./ticket.js`; the exports are taken from `packages/core/src/ticket.ts`. No other core export changes.
