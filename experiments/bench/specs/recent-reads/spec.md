# Recent Jira reads: a bounded, time-limited memo for `apps/api`

Ticket #104 ("faster flows") stops the API from re-reading Jira on every request.
A Jira site's field list will be kept for an hour. A proposal's page and the
context's status will read an issue at most once a minute. Approvals will still
read it live. This change adds the building block those callers share: the new
module `apps/api/src/jira/recent.ts`. It holds a small in-memory store of recent
reads keyed by string, where each entry expires a fixed time after it was
written. It also exports a key builder for issue reads. Connecting the store to
the field-list, proposal-page and context-status routes is outside this seam.
Approvals must not use it, and nothing in this module performs a Jira read.

The module has no I/O. Time comes only from the `now` option, so every
behaviour below can be tested by calling the exports with a fake clock.

## Exports

From `apps/api/src/jira/recent.ts` (new file):

```ts
/** How long a recent issue read is reused: one minute. */
export const RECENT_JIRA_READ_MS = 60000;

export interface RecentReads<T> {
    get(key: string): T | undefined;
    set(key: string, value: T): void;
}

export function recentReads<T>(options: {
    ttlMs?: number;
    now?: () => number;
    max?: number;
} = {}): RecentReads<T>;

export function issueKey(organizationId: string, connectionId: string, issueId: string): string;
```

- `RECENT_JIRA_READ_MS` is exactly `60000`.
- `recentReads` options:
  - `ttlMs` defaults to `RECENT_JIRA_READ_MS`.
  - `now` defaults to `Date.now` and returns epoch milliseconds.
  - `max` defaults to `1000`. No constant is exported for it.
  - Passing `undefined` for an option has the same effect as leaving it out.
- `recentReads` does not validate its options and never throws. Values such
  as `ttlMs: 0` or `max: 0` are used as given (see the scenarios below).
- Each call to `recentReads` returns an independent store. Stores share no
  state.
- `issueKey` returns `[organizationId, connectionId, issueId].join("\n")`. This
  follows the newline-separated key that `sharedCredential` in
  `src/jira/credential.ts` already uses. It does no validation.
- No other module's exports change. `src/jira/credential.ts` and
  `src/jira/routes.ts` keep their current behaviour.

## Behaviour

```gherkin
Feature: Recent Jira reads
  A store of recent reads hands back a value written less than ttlMs ago and
  forgets values once they are older, so callers re-read Jira at most once
  per ttlMs per key.

  Background:
    Given a clock "now" that returns the number held in a variable "t"
    And "t" is 1000000

  Rule: A value written less than ttlMs ago is returned as written

    @happy
    Scenario: A value just written is returned
      Given store = recentReads<{ summary: string }>({ now, ttlMs: 60000 })
      And issue = { summary: "Fix login" }
      When store.set("org_1\njcn_1\n10001", issue)
      Then store.get("org_1\njcn_1\n10001") returns the same object as issue (identity, not a copy)

    @happy
    Scenario: A key never written is a miss
      Given store = recentReads<string>({ now })
      Then store.get("never-set") returns undefined

    @boundary
    Scenario Outline: Freshness is measured from the write, exclusive of ttlMs
      Given store = recentReads<string>({ now, ttlMs: 60000 })
      And store.set("k", "v") at t = 1000000
      When t is set to <t>
      Then store.get("k") returns <result>

      Examples:
        | t       | result    |
        | 1000000 | "v"       |
        | 1059999 | "v"       |
        | 1060000 | undefined |
        | 1060001 | undefined |
        | 1120000 | undefined |

    @boundary
    Scenario: A clock that moves backwards keeps the entry fresh
      Given store = recentReads<string>({ now, ttlMs: 60000 })
      And store.set("k", "v") at t = 1000000
      When t is set to 999000
      Then store.get("k") returns "v"

    @boundary
    Scenario Outline: Falsy values are stored and returned, not treated as misses
      Given store = recentReads<unknown>({ now })
      When store.set("k", <value>)
      Then store.get("k") returns <value>

      Examples:
        | value |
        | null  |
        | 0     |
        | ""    |
        | false |
        | []    |

    @boundary
    Scenario: Keys match exactly, are case-sensitive, and the empty string is a key
      Given store = recentReads<string>({ now })
      When store.set("", "empty") and store.set("ABC-1", "upper")
      Then store.get("") returns "empty"
      And store.get("ABC-1") returns "upper"
      And store.get("abc-1") returns undefined
      And store.get("ABC-1 ") returns undefined

  Rule: get never extends an entry's life

    @boundary
    Scenario: Reading an entry does not refresh its expiry
      Given store = recentReads<string>({ now, ttlMs: 60000 })
      And store.set("k", "v") at t = 1000000
      When t is set to 1059000 and store.get("k") returns "v"
      And t is set to 1060000
      Then store.get("k") returns undefined

  Rule: set replaces the value and restarts the entry's ttl from the current time

    @happy
    Scenario: Writing a key again replaces its value and restarts its ttl
      Given store = recentReads<string>({ now, ttlMs: 60000 })
      And store.set("k", "old") at t = 1000000
      When t is set to 1050000 and store.set("k", "new")
      Then store.get("k") returns "new"
      When t is set to 1109999
      Then store.get("k") returns "new"
      When t is set to 1110000
      Then store.get("k") returns undefined

    @happy
    Scenario: An expired key can be written again and is fresh
      Given store = recentReads<string>({ now, ttlMs: 60000 })
      And store.set("k", "v1") at t = 1000000
      When t is set to 1060000
      Then store.get("k") returns undefined
      When store.set("k", "v2")
      Then store.get("k") returns "v2"

  Rule: Defaults are one minute, Date.now and 1000 entries

    @happy
    Scenario: The exported constant
      Then RECENT_JIRA_READ_MS equals 60000

    @boundary
    Scenario: ttlMs defaults to RECENT_JIRA_READ_MS
      Given store = recentReads<string>({ now })
      And store.set("k", "v") at t = 1000000
      When t is set to 1059999
      Then store.get("k") returns "v"
      When t is set to 1060000
      Then store.get("k") returns undefined

    @boundary
    Scenario: Options given as undefined take their defaults
      Given store = recentReads<string>({ now, ttlMs: undefined, max: undefined })
      And store.set("k", "v") at t = 1000000
      When t is set to 1059999
      Then store.get("k") returns "v"
      When t is set to 1060000
      Then store.get("k") returns undefined

    @happy
    Scenario: Called with no options, the store works on the real clock
      Given store = recentReads<string>()
      When store.set("k", "v")
      Then store.get("k") returns "v" when read immediately

    @boundary
    Scenario: max defaults to 1000
      Given store = recentReads<number>({ now })
      When store.set("k0", 0), store.set("k1", 1), ... store.set("k999", 999) in that order
      Then store.get("k0") returns 0
      When store.set("k1000", 1000)
      Then store.get("k0") returns undefined
      And store.get("k1") returns 1
      And store.get("k1000") returns 1000

    @happy
    Scenario: A field list kept for an hour
      Given fields = recentReads<string[]>({ now, ttlMs: 3600000 })
      And fields.set("org_1\njcn_1", ["summary", "priority"]) at t = 1000000
      When t is set to 4599999
      Then fields.get("org_1\njcn_1") returns ["summary", "priority"]
      When t is set to 4600000
      Then fields.get("org_1\njcn_1") returns undefined

  Rule: A store holds at most max entries; writing a new key into a full store drops the oldest-written entry

    @boundary
    Scenario: The oldest write is dropped when a new key exceeds max
      Given store = recentReads<string>({ now, max: 2 })
      And store.set("a", "A"), then store.set("b", "B")
      When store.set("c", "C")
      Then store.get("a") returns undefined
      And store.get("b") returns "B"
      And store.get("c") returns "C"

    @boundary
    Scenario: Rewriting an existing key in a full store drops nothing and makes it the newest
      Given store = recentReads<string>({ now, max: 2 })
      And store.set("a", "A1"), then store.set("b", "B")
      When store.set("a", "A2")
      Then store.get("a") returns "A2"
      And store.get("b") returns "B"
      When store.set("c", "C")
      Then store.get("b") returns undefined
      And store.get("a") returns "A2"
      And store.get("c") returns "C"

    @boundary
    Scenario: Reading an entry does not protect it from eviction
      Given store = recentReads<string>({ now, max: 2 })
      And store.set("a", "A"), then store.set("b", "B")
      And store.get("a") returns "A"
      When store.set("c", "C")
      Then store.get("a") returns undefined
      And store.get("b") returns "B"

    @boundary
    Scenario: max of 1 keeps only the latest key
      Given store = recentReads<string>({ now, max: 1 })
      When store.set("a", "A"), then store.set("b", "B")
      Then store.get("a") returns undefined
      And store.get("b") returns "B"

  Rule: Options are used as given, without validation

    @unhappy
    Scenario Outline: Unusual options do not throw
      When recentReads({ ttlMs: <ttlMs>, max: <max> }) is called
      Then it returns a store without throwing

      Examples:
        | ttlMs     | max      |
        | 1         | 1        |
        | 0.5       | 1        |
        | 0         | 0        |
        | -1        | -1       |
        | NaN       | 1.5      |
        | Infinity  | NaN      |
        | -Infinity | Infinity |

    @unhappy
    Scenario: A ttlMs of 0 makes every read a miss
      Given store = recentReads<string>({ now, ttlMs: 0 })
      When store.set("k", "v") at t = 1000000
      Then store.get("k") returns undefined

    @boundary
    Scenario: A ttlMs of Infinity never expires
      Given store = recentReads<string>({ now, ttlMs: Infinity })
      And store.set("k", "v") at t = 1000000
      When t is set to 1000000000000
      Then store.get("k") returns "v"

    @unhappy
    Scenario: A max of 0 still keeps the latest key
      Given store = recentReads<string>({ now, max: 0 })
      When store.set("a", "A"), then store.set("b", "B")
      Then store.get("a") returns undefined
      And store.get("b") returns "B"

    @boundary
    Scenario: A fractional ttlMs keeps the exclusive boundary
      Given store = recentReads<string>({ now, ttlMs: 0.5 })
      And store.set("k", "v") at t = 1000000
      Then store.get("k") returns "v"
      When t is set to 1000000.5
      Then store.get("k") returns undefined

  Rule: Stores are independent of each other

    @happy
    Scenario: Two stores with the same key do not see each other's writes
      Given first = recentReads<string>({ now })
      And second = recentReads<string>({ now })
      When first.set("k", "one")
      Then second.get("k") returns undefined
      When second.set("k", "two")
      Then first.get("k") returns "one"
      And second.get("k") returns "two"

  Rule: Overlapping reads are not merged; the last write wins

    @concurrency
    Scenario: Two callers that both miss both write, and the later write is kept
      Given store = recentReads<string>({ now, ttlMs: 60000 })
      And caller A calls store.get("k") and gets undefined at t = 1000000
      And caller B calls store.get("k") and gets undefined at t = 1000000
      When caller B calls store.set("k", "from B") at t = 1000100
      And caller A calls store.set("k", "from A") at t = 1000200
      Then store.get("k") returns "from A"
      And at t = 1060199 store.get("k") returns "from A"
      And at t = 1060200 store.get("k") returns undefined

  Rule: issueKey joins its three parts with newlines, without validation

    @happy
    Scenario Outline: issueKey builds the key from organization, connection and issue
      When issueKey(<organizationId>, <connectionId>, <issueId>) is called
      Then it returns <key>

      Examples:
        | organizationId | connectionId | issueId  | key                     |
        | "org_1"        | "jcn_1"      | "10001"  | "org_1\njcn_1\n10001"   |
        | "org_1"        | "jcn_2"      | "10001"  | "org_1\njcn_2\n10001"   |
        | "org_2"        | "jcn_1"      | "PROJ-7" | "org_2\njcn_1\nPROJ-7"  |
        | ""             | ""           | ""       | "\n\n"                  |

    @boundary
    Scenario: The same issue under different organizations or connections is a different key
      Given store = recentReads<string>({ now })
      When store.set(issueKey("org_1", "jcn_1", "10001"), "seen by org_1")
      Then store.get(issueKey("org_2", "jcn_1", "10001")) returns undefined
      And store.get(issueKey("org_1", "jcn_2", "10001")) returns undefined
      And store.get(issueKey("org_1", "jcn_1", "10001")) returns "seen by org_1"

    @unhappy
    Scenario: Parts containing a newline are not rejected and can collide
      When issueKey("a\nb", "c", "d") is called
      Then it returns "a\nb\nc\nd" without throwing
      And it equals issueKey("a", "b\nc", "d")
```

Decided:
- Default `ttlMs` is `RECENT_JIRA_READ_MS` (60000). Callers such as the hour-long field list pass their own value.
- Default `max` is 1000. No constant is exported for it.
- Expiry is exclusive: an entry is fresh while `now() - writtenAt < ttlMs`, and is gone at exactly `ttlMs`.
- A clock that moves backwards leaves the entry fresh, because the elapsed time is negative and so below `ttlMs`.
- `get` never refreshes an entry's expiry or its eviction order.
- `set` on an existing key replaces the value, restarts its ttl from `now()` and makes it the newest entry.
- Eviction drops the oldest-written entry, and only when a new key is written into a full store.
- Falsy values (`null`, `0`, `""`, `false`) are returned as stored. Only `undefined` means a miss.
- Values are returned by reference, not copied.
- Keys are compared exactly and case-sensitively, and `""` is a valid key.
- Options are not validated and `recentReads` never throws. `ttlMs: 0` makes every read a miss, `ttlMs: Infinity` never expires, and `max: 0` behaves like `max: 1`.
- Options passed as `undefined` take their defaults.
- Each `recentReads()` call returns an independent store.
- Overlapping misses are not merged into one read: both callers read and write, the last `set` wins, and its ttl starts from its own write.
- `issueKey` joins its parts with `"\n"`, as `sharedCredential` does. Empty parts and parts containing a newline are accepted without validation.
