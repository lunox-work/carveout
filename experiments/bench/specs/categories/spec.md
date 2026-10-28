# Selection categories: facts, rules, signals and the category registry

Backlog runs used to take the ten oldest tickets. Under ticket #64 they size
every open ticket that fits at least one outsourcing category, and they record
why each one was picked. This spec covers the pure, dependency-free part of
that change in `packages/core/src/selection/`. `facts.ts` turns one issue
read from Jira into `IssueFacts`. `rules.ts` composes named signals into rules
and evaluates them. `signals.ts` holds the named signals. `categories.ts` holds
the registry of six categories and resolves a board's overrides and classifies
facts. `index.ts` re-exports all four. Nothing here reads a clock, the network
or storage: `now` is a parameter. Every export is synchronous and keeps no
state between calls.

Outside this spec (other packages): the Jira read, the settings schema, the
`ticketCap`/`unassignedOnly` rename, run deadlines, settings merge/persistence,
proposal paging and title batching. `packages/core/src/bounty.ts`,
`packages/core/src/handle.ts` and `packages/core/src/index.ts` are unchanged,
and so is every existing export (`BountySelection` still has `maxTickets` and
`excludeAssigned` in this package). Tests import from
`packages/core/src/selection/index.ts` (compiled: `../src/selection/index.js`).

## Exports

`packages/core/src/selection/index.ts` re-exports everything below:
`export * from "./facts.js"`, `"./rules.js"`, `"./signals.js"` and
`"./categories.js"`.

### `facts.ts`

```ts
export interface SelectionLink {
    readonly type: string;
    readonly direction: "inward" | "outward";
    readonly statusCategory: string;
}
export interface SelectionClosedSprint {
    readonly startDate: string | null;
    readonly endDate: string | null;
}
export interface SelectionRelease {
    readonly name: string;
    readonly releaseDate: string | null;
    readonly released: boolean;
}
export interface SelectionIssue {
    readonly assignee: string | null;
    readonly priority: string | null;
    readonly issueType: string;
    readonly created: string | null;
    readonly updated: string | null;
    readonly dueDate: string | null;
    readonly sprint: { readonly state: string } | null;
    readonly closedSprints: readonly SelectionClosedSprint[];
    readonly votes: number | null;
    readonly watchers: number | null;
    readonly commentCount?: number | null;
    readonly links: readonly SelectionLink[];
    readonly releases: readonly SelectionRelease[];
}
export type PriorityRank = "low" | "medium" | "high" | "none";
export interface IssueFacts {
    readonly ageDays: number;
    readonly daysSinceUpdate: number;
    readonly assigned: boolean;
    readonly inSprint: boolean;
    readonly closedSprintCount: number;
    readonly carriedSince: string | null;
    readonly votes: number;
    readonly watchers: number;
    readonly duplicateLinks: number;
    readonly blocksOpenCount: number;
    readonly commentCount: number | null;
    readonly priorityName: string | null;
    readonly priorityRank: PriorityRank;
    readonly isBug: boolean;
    readonly dueInDays: number | null;
    readonly release: { readonly name: string; readonly inDays: number } | null;
}
export const PRIORITY_RANKS: Readonly<Record<string, PriorityRank>>;
export const BUG_ISSUE_TYPES: readonly string[] = ["bug", "defect"];
export function factsFor(issue: SelectionIssue, now: Date): IssueFacts;
```

`PRIORITY_RANKS` is an object with exactly these lowercase keys: `lowest`,
`trivial`, `low`, `minor` → `"low"`; `medium`, `normal` → `"medium"`. A
non-blank priority name that is not a key ranks `"high"`. `BUG_ISSUE_TYPES`
is `["bug", "defect"]`.

### `rules.ts`

```ts
export interface Signal {
    readonly id: string;
    readonly test: (facts: IssueFacts) => boolean;
    readonly describe: (facts: IssueFacts) => string | null;
}
export type Rule = Signal | { readonly all: readonly Rule[] } | { readonly any: readonly Rule[] };
export function all(...rules: Rule[]): Rule;            // returns { all: rules }
export function any(...rules: Rule[]): Rule;            // returns { any: rules }
export function silent(signal: Signal): Signal;
export function signal(id: string, test: Signal["test"], describe: Signal["describe"]): Signal;
export interface Evaluation {
    readonly matched: boolean;
    readonly clauses: readonly string[];
}
export function evaluate(rule: Rule, facts: IssueFacts): Evaluation;
```

### `signals.ts`

```ts
export const unassigned: Signal;
export const neverInSprint: Signal;
export const notInSprint: Signal;
export const bug: Signal;
export function openAtLeast(days: number): Signal;
export function quietAtLeast(days: number): Signal;
export function carriedAtLeast(sprints: number): Signal;
export function votesAtLeast(votes: number): Signal;
export function watchersAtLeast(watchers: number): Signal;
export function duplicatesAtLeast(links: number): Signal;
export function commentsAtLeast(comments: number): Signal;
export function blocksAtLeast(tickets: number): Signal;
export function priorityAtMost(rank: "low" | "medium"): Signal;
export function deadlineWithin(days: number): Signal;
```

### `categories.ts`

```ts
export type Thresholds = Readonly<Record<string, number>>;
export interface Category {
    readonly id: string;
    readonly label: string;
    readonly why: string;
    readonly defaults: Thresholds;
    readonly rule: (thresholds: Thresholds) => Rule;
}
export const CATEGORIES: readonly Category[];
export const UNCATEGORIZED = "uncategorized";
export interface CategorySettings {
    readonly enabled?: boolean | undefined;
    readonly thresholds?: Readonly<Record<string, number | null | undefined>> | undefined;
}
export type CategoryConfig = Readonly<Record<string, CategorySettings | undefined>>;
export interface ResolvedCategory {
    readonly id: string;
    readonly label: string;
    readonly why: string;
    readonly enabled: boolean;
    readonly thresholds: Thresholds;
}
export interface CategoryMatch {
    readonly id: string;
    readonly label: string;
    readonly reason: string;
}
export function resolveCategories(config: CategoryConfig = {}, categories: readonly Category[] = CATEGORIES): ResolvedCategory[];
export function createClassifier(config: CategoryConfig = {}, categories: readonly Category[] = CATEGORIES): (facts: IssueFacts) => CategoryMatch[];
export function classify(facts: IssueFacts, config: CategoryConfig = {}, categories: readonly Category[] = CATEGORIES): CategoryMatch[];
```

### The registry

`CATEGORIES` is an array, in this order:

| id                   | label              | defaults                                                                | rule (thresholds `t`)                                                                                                                                         |
| -------------------- | ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `left-behind`        | Left behind        | `{ minAgeDays: 180, minQuietDays: 90 }`                                 | `all(openAtLeast(t.minAgeDays), neverInSprint, unassigned, silent(quietAtLeast(t.minQuietDays)))`                                                             |
| `always-next-sprint` | Always next sprint | `{ minSprints: 2 }`                                                     | `carriedAtLeast(t.minSprints)`                                                                                                                                |
| `quietly-wanted`     | Quietly wanted     | `{ minVotes: 3, minWatchers: 5, minDuplicates: 1, minComments: 5 }`     | `all(any(votesAtLeast(t.minVotes), watchersAtLeast(t.minWatchers), commentsAtLeast(t.minComments), duplicatesAtLeast(t.minDuplicates)), priorityAtMost("low"))` |
| `holding-others-up`  | Holding others up  | `{ minBlocked: 1 }`                                                     | `all(blocksAtLeast(t.minBlocked), unassigned)`                                                                                                                |
| `paper-cuts`         | Paper cuts         | `{ minAgeDays: 90 }`                                                    | `all(bug, silent(priorityAtMost("medium")), openAtLeast(t.minAgeDays))`                                                                                       |
| `deadline-exposed`   | Deadline exposed   | `{ withinDays: 30 }`                                                    | `all(deadlineWithin(t.withinDays), silent(unassigned), notInSprint)`                                                                                          |

The `why` strings, verbatim:

| id                   | why                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `left-behind`        | The team has shown it won't reach this, so outsourcing takes nothing off the roadmap.                 |
| `always-next-sprint` | Already planned and wanted; the only blocker is capacity.                                              |
| `quietly-wanted`     | Shows demand that the priority field hides, which justifies a higher bounty.                          |
| `holding-others-up`  | One bounty unblocks several tickets the team will do in-house.                                         |
| `paper-cuts`         | Small, self-contained bugs are what agents fix most reliably, and users notice when they're gone.     |
| `deadline-exposed`   | The deadline justifies paying now rather than waiting for capacity.                                    |

### Signals

| export                   | `id`                     | `test(facts)` is true when                                                    | `describe(facts)`                                                                    |
| ------------------------ | ------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `unassigned`             | `unassigned`             | `!assigned`                                                                   | `"unassigned"`                                                                       |
| `neverInSprint`          | `never-in-sprint`        | `!inSprint && closedSprintCount === 0`                                        | `"never in a sprint"`                                                                |
| `notInSprint`            | `not-in-sprint`          | `!inSprint`                                                                   | `"not in any sprint"`                                                                |
| `bug`                    | `bug`                    | `isBug`                                                                       | `"<priorityName>-priority bug"`, or `"bug"` when `priorityName` is null              |
| `openAtLeast(n)`         | `open-at-least`          | `ageDays >= n`                                                                | `"open <ageDays> day(s)"`                                                            |
| `quietAtLeast(n)`        | `quiet-at-least`         | `daysSinceUpdate >= n`                                                        | `"no update in <daysSinceUpdate> day(s)"`                                            |
| `carriedAtLeast(n)`      | `carried-at-least`       | `closedSprintCount >= n`                                                      | `"carried over <closedSprintCount> sprint(s)"`, plus `" since <carriedSince>"` when `carriedSince` is not null |
| `votesAtLeast(n)`        | `votes-at-least`         | `votes >= n`                                                                  | `"<votes> vote(s)"`                                                                  |
| `watchersAtLeast(n)`     | `watchers-at-least`      | `watchers >= n`                                                               | `"<watchers> watcher(s)"`                                                            |
| `duplicatesAtLeast(n)`   | `duplicates-at-least`    | `duplicateLinks >= n`                                                         | `"<duplicateLinks> duplicate(s) linked"`                                             |
| `commentsAtLeast(n)`     | `comments-at-least`      | `commentCount !== null && commentCount >= n`                                  | `"<commentCount> comment(s)"`, counting a null `commentCount` as 0                   |
| `blocksAtLeast(n)`       | `blocks-at-least`        | `blocksOpenCount >= n`                                                        | `"blocks <blocksOpenCount> open ticket(s)"`                                          |
| `priorityAtMost(r)`      | `priority-at-most-<r>`   | `"low"`: `priorityRank === "low"`; `"medium"`: rank is `"low"` or `"medium"`; never for `"none"` | `"priority <priorityName>"`, or `"priority unset"` when `priorityName` is null |
| `deadlineWithin(n)`      | `deadline-within`        | `(dueInDays !== null && 0 <= dueInDays <= n) \|\| (release !== null && 0 <= release.inDays <= n)` | see the deadline rule below                                   |

Signal ids do not include the threshold. "(s)" means the plural form unless
the count is exactly 1: `"open 1 day"`, `"open 0 days"`, `"1 vote"`,
`"blocks 1 open ticket"`. A signal's `describe` does not check its own `test`,
except that `deadlineWithin` only describes a due date or release inside its
window and otherwise says `"due today"`. `evaluate` calls `describe` only
after `test` has returned true.

```gherkin
Feature: Selection categories classify an issue's facts and say why

  Background:
    Given NOW is new Date("2026-10-25T12:00:00.000Z")
    And BASE_ISSUE is the SelectionIssue
      | field         | value                      |
      | assignee      | null                       |
      | priority      | "Medium"                   |
      | issueType     | "Story"                    |
      | created       | "2026-01-01T00:00:00.000Z" |
      | updated       | "2026-10-01T00:00:00.000Z" |
      | dueDate       | null                       |
      | sprint        | null                       |
      | closedSprints | []                         |
      | votes         | 0                          |
      | watchers      | 0                          |
      | commentCount  | (property absent)          |
      | links         | []                         |
      | releases      | []                         |
    And BASE_FACTS is the IssueFacts
      | field             | value  |
      | ageDays           | 0      |
      | daysSinceUpdate   | 0      |
      | assigned          | false  |
      | inSprint          | false  |
      | closedSprintCount | 0      |
      | carriedSince      | null   |
      | votes             | 0      |
      | watchers          | 0      |
      | duplicateLinks    | 0      |
      | blocksOpenCount   | 0      |
      | commentCount      | null   |
      | priorityName      | null   |
      | priorityRank      | "none" |
      | isBug             | false  |
      | dueInDays         | null   |
      | release           | null   |
    And "BASE_FACTS with x: y" means a copy of BASE_FACTS with only those fields changed

  Rule: factsFor reduces an issue to facts, measuring whole elapsed days from now

    @happy
    Scenario: The base issue becomes facts
      When factsFor(BASE_ISSUE, NOW) is called
      Then the result deep-equals
        | field             | value    |
        | ageDays           | 297      |
        | daysSinceUpdate   | 24       |
        | assigned          | false    |
        | inSprint          | false    |
        | closedSprintCount | 0        |
        | carriedSince      | null     |
        | votes             | 0        |
        | watchers          | 0        |
        | duplicateLinks    | 0        |
        | blocksOpenCount   | 0        |
        | commentCount      | null     |
        | priorityName      | "Medium" |
        | priorityRank      | "medium" |
        | isBug             | false    |
        | dueInDays         | null     |
        | release           | null     |
      And BASE_ISSUE is not modified

    @boundary
    Scenario Outline: ageDays is floor((now - created) / 86_400_000), and 0 when created is missing, unparseable or in the future
      When factsFor(BASE_ISSUE with created: <created>, NOW) is called
      Then ageDays is <ageDays>

      Examples:
        | created                    | ageDays |
        | "2025-09-20T00:00:00.000Z" | 400     |
        | "2026-10-24T12:00:00.000Z" | 1       |
        | "2026-10-24T12:00:00.001Z" | 0       |
        | "2026-10-26T00:00:00.000Z" | 0       |
        | null                       | 0       |
        | "not a date"               | 0       |

    @boundary
    Scenario Outline: daysSinceUpdate measures from updated like ageDays, and is 0 when updated is missing, unparseable or in the future
      When factsFor(BASE_ISSUE with updated: <updated>, NOW) is called
      Then daysSinceUpdate is <days>

      Examples:
        | updated                    | days |
        | "2026-04-01T00:00:00.000Z" | 207  |
        | "2026-10-25T12:00:00.000Z" | 0    |
        | "2026-11-01T00:00:00.000Z" | 0    |
        | null                       | 0    |
        | "yesterday"                | 0    |

    @boundary
    Scenario Outline: assigned is true for any assignee that is not null
      When factsFor(BASE_ISSUE with assignee: <assignee>, NOW) is called
      Then assigned is <assigned>

      Examples:
        | assignee | assigned |
        | null     | false    |
        | ""       | true     |
        | "   "    | true     |
        | "Dana"   | true     |

    @boundary
    Scenario Outline: inSprint is true for any current sprint whose state is not exactly "closed"
      When factsFor(BASE_ISSUE with sprint: <sprint>, NOW) is called
      Then inSprint is <inSprint>

      Examples:
        | sprint                 | inSprint |
        | null                   | false    |
        | { state: "active" }    | true     |
        | { state: "future" }    | true     |
        | { state: "unknown" }   | true     |
        | { state: "closed" }    | false    |
        | { state: "CLOSED" }    | true     |

    @happy
    Scenario Outline: Closed sprints are counted, and carriedSince names the UTC month of the earliest closed sprint's startDate (or endDate when startDate does not parse), with the year when it is not now's year
      When factsFor(BASE_ISSUE with closedSprints: <closedSprints>, NOW) is called
      Then closedSprintCount is <count> and carriedSince is <carriedSince>

      Examples:
        | closedSprints                                                                                                                         | count | carriedSince               |
        | []                                                                                                                                    | 0     | null                       |
        | [{ startDate: "2026-03-02T09:00:00.000Z", endDate: "2026-03-16T09:00:00.000Z" }, { startDate: "2026-02-16T09:00:00.000Z", endDate: null }] | 2     | "February"                 |
        | [{ startDate: null, endDate: "2026-04-01T00:00:00.000Z" }]                                                                            | 1     | "April"                    |
        | [{ startDate: "garbage", endDate: "2026-05-01T00:00:00.000Z" }]                                                                       | 1     | "May"                      |
        | [{ startDate: "2025-11-10T09:00:00.000Z", endDate: null }, { startDate: "2026-01-05T09:00:00.000Z", endDate: null }]                  | 2     | "November 2025"            |
        | [{ startDate: null, endDate: null }, { startDate: "garbage", endDate: null }]                                                         | 2     | null                       |

    @boundary
    Scenario: Missing votes, watchers and comment count
      When factsFor is called with BASE_ISSUE with votes: null, watchers: null and commentCount: null
      Then votes is 0, watchers is 0 and commentCount is null
      And with commentCount absent, commentCount is null
      And with votes: 4, watchers: 7, commentCount: 12, the facts carry 4, 7 and 12

    @happy
    Scenario: Duplicate links count only inward, and blocking counts only outward Blocks links to tickets whose status category is not exactly "done"
      Given links
        | type        | direction | statusCategory |
        | "Duplicate" | inward    | "done"         |
        | "duplicate" | outward   | "new"          |
        | "Blocks"    | outward   | "new"          |
        | "blocks"    | outward   | "indeterminate"|
        | "Blocks"    | outward   | "unknown"      |
        | "Blocks"    | outward   | "Done"         |
        | "Blocks"    | outward   | "done"         |
        | "Blocks"    | inward    | "new"          |
        | "Relates"   | outward   | "new"          |
      When factsFor(BASE_ISSUE with those links, NOW) is called
      Then duplicateLinks is 1
      And blocksOpenCount is 4

    @boundary
    Scenario Outline: Priority is ranked through PRIORITY_RANKS by its trimmed lowercase name; any other non-blank name is "high", and a blank or missing one is "none"
      When factsFor(BASE_ISSUE with priority: <priority>, NOW) is called
      Then priorityName is <name> and priorityRank is <rank>

      Examples:
        | priority      | name          | rank     |
        | "Highest"     | "Highest"     | "high"   |
        | "High"        | "High"        | "high"   |
        | "Blocker"     | "Blocker"     | "high"   |
        | "Critical"    | "Critical"    | "high"   |
        | "Major"       | "Major"       | "high"   |
        | "Medium"      | "Medium"      | "medium" |
        | "Normal"      | "Normal"      | "medium" |
        | "Low"         | "Low"         | "low"    |
        | "Lowest"      | "Lowest"      | "low"    |
        | "Minor"       | "Minor"       | "low"    |
        | "Trivial"     | "Trivial"     | "low"    |
        | "  low  "     | "low"         | "low"    |
        | "P2"          | "P2"          | "high"   |
        | "   "         | null          | "none"   |
        | null          | null          | "none"   |

    @boundary
    Scenario Outline: isBug matches BUG_ISSUE_TYPES against the trimmed lowercase issue type
      When factsFor(BASE_ISSUE with issueType: <issueType>, NOW) is called
      Then isBug is <isBug>

      Examples:
        | issueType | isBug |
        | "Bug"     | true  |
        | " bug "   | true  |
        | "Defect"  | true  |
        | "Bugfix"  | false |
        | "Story"   | false |

    @boundary
    Scenario Outline: dueInDays counts UTC calendar days from now's UTC date to the UTC date of the parsed due date, negative when overdue
      When factsFor(BASE_ISSUE with dueDate: <dueDate>, NOW) is called
      Then dueInDays is <dueInDays>

      Examples:
        | dueDate                         | dueInDays |
        | "2026-10-25"                    | 0         |
        | "2026-10-26"                    | 1         |
        | "2026-11-08"                    | 14        |
        | "2026-11-08T23:30:00.000-05:00" | 15        |
        | "2026-10-20"                    | -5        |
        | "soon"                          | null      |
        | null                            | null      |

    @happy
    Scenario Outline: release is the unreleased version with the earliest parseable releaseDate that is today or later, counted like dueInDays
      When factsFor(BASE_ISSUE with releases: <releases>, NOW) is called
      Then release is <release>

      Examples:
        | releases                                                                                                                                                                      | release                       |
        | [{ name: "2.4", releaseDate: "2026-11-01", released: false }, { name: "2.3", releaseDate: "2026-10-30", released: true }, { name: "3.0", releaseDate: null, released: false }] | { name: "2.4", inDays: 7 }    |
        | [{ name: "A", releaseDate: "2026-11-01", released: false }, { name: "B", releaseDate: "2026-11-01", released: false }]                                                       | { name: "A", inDays: 7 }      |
        | [{ name: "Late", releaseDate: "2026-10-20", released: false }, { name: "2.4", releaseDate: "2026-11-01", released: false }]                                                  | { name: "2.4", inDays: 7 }    |
        | [{ name: "Now", releaseDate: "2026-10-25", released: false }]                                                                                                                | { name: "Now", inDays: 0 }    |
        | [{ name: "1.0", releaseDate: "2026-10-01", released: true }, { name: "X", releaseDate: "tbd", released: false }]                                                             | null                          |
        | []                                                                                                                                                                            | null                          |

    @boundary
    Scenario: The lookup tables
      Then PRIORITY_RANKS deep-equals { lowest: "low", trivial: "low", low: "low", minor: "low", medium: "medium", normal: "medium" }
      And BUG_ISSUE_TYPES deep-equals ["bug", "defect"]

  Rule: evaluate matches a rule and collects the clauses of the signals that made it match

    Background:
      Given A is signal("a", () => true, () => "alpha")
      And B is signal("b", () => true, () => "beta")
      And N is signal("n", () => false, () => "never")
      And Q is signal("q", () => true, () => null)

    @happy
    Scenario: signal, all and any build plain values
      Then signal("a", t, d) has id "a" and test and describe that are the same function references t and d
      And all(A, B) deep-equals { all: [A, B] }
      And any(A, N) deep-equals { any: [A, N] }

    @happy
    Scenario Outline: Matching and clauses
      When evaluate(<rule>, BASE_FACTS) is called
      Then the result deep-equals { matched: <matched>, clauses: <clauses> }

      Examples:
        | rule                 | matched | clauses           |
        | A                    | true    | ["alpha"]         |
        | N                    | false   | []                |
        | Q                    | true    | []                |
        | silent(A)            | true    | []                |
        | all(A, B)            | true    | ["alpha", "beta"] |
        | all(A, N)            | false   | []                |
        | any(N, A, B)         | true    | ["alpha", "beta"] |
        | any(N)               | false   | []                |
        | all(A, any(N, B))    | true    | ["alpha", "beta"] |
        | all(A, A)            | true    | ["alpha", "alpha"] |
        | any(A, all(B, A))    | true    | ["alpha", "beta", "alpha"] |

    @boundary
    Scenario: Empty combinators follow every/some
      Then evaluate(all(), BASE_FACTS) deep-equals { matched: true, clauses: [] }
      And evaluate(any(), BASE_FACTS) deep-equals { matched: false, clauses: [] }

    @boundary
    Scenario: all and any evaluate every child
      Given T is a signal whose test counts its calls and returns false
      Then evaluate(all(N, T), BASE_FACTS) returns { matched: false, clauses: [] } and T's test was called once
      And evaluate(any(A, B), BASE_FACTS) calls the test of both A and B

    @boundary
    Scenario: describe runs only for a signal whose test matched
      Given S is signal("s", () => false, describeSpy)
      When evaluate(S, BASE_FACTS) is called
      Then describeSpy was not called

    @happy
    Scenario: silent keeps the id and test but never describes, and leaves the original alone
      When S2 is silent(A)
      Then S2.id is "a" and S2.test is A.test
      And S2.describe(BASE_FACTS) is null
      And A.describe(BASE_FACTS) is still "alpha"

  Rule: Each named signal has a fixed id, a test and a description

    @happy
    Scenario Outline: Signal ids
      Then <signal>.id is <id>

      Examples:
        | signal                   | id                       |
        | unassigned               | "unassigned"             |
        | neverInSprint            | "never-in-sprint"        |
        | notInSprint              | "not-in-sprint"          |
        | bug                      | "bug"                    |
        | openAtLeast(90)          | "open-at-least"          |
        | quietAtLeast(30)         | "quiet-at-least"         |
        | carriedAtLeast(3)        | "carried-at-least"       |
        | votesAtLeast(3)          | "votes-at-least"         |
        | watchersAtLeast(5)       | "watchers-at-least"      |
        | duplicatesAtLeast(2)     | "duplicates-at-least"    |
        | commentsAtLeast(10)      | "comments-at-least"      |
        | blocksAtLeast(1)         | "blocks-at-least"        |
        | priorityAtMost("low")    | "priority-at-most-low"   |
        | priorityAtMost("medium") | "priority-at-most-medium"|
        | deadlineWithin(14)       | "deadline-within"        |

    @boundary
    Scenario Outline: Tests and descriptions, with thresholds inclusive
      Given facts F = BASE_FACTS with <changes>
      Then <signal>.test(F) is <test>
      And <signal>.describe(F) is <describe>

      Examples:
        | signal                   | changes                                                     | test  | describe                              |
        | unassigned               | assigned: false                                             | true  | "unassigned"                          |
        | unassigned               | assigned: true                                              | false | "unassigned"                          |
        | neverInSprint            | inSprint: false, closedSprintCount: 0                       | true  | "never in a sprint"                   |
        | neverInSprint            | closedSprintCount: 1                                        | false | "never in a sprint"                   |
        | neverInSprint            | inSprint: true                                              | false | "never in a sprint"                   |
        | notInSprint              | closedSprintCount: 4                                        | true  | "not in any sprint"                   |
        | notInSprint              | inSprint: true                                              | false | "not in any sprint"                   |
        | bug                      | isBug: true                                                 | true  | "bug"                                 |
        | bug                      | isBug: true, priorityName: "Low"                            | true  | "Low-priority bug"                    |
        | bug                      | isBug: false                                                | false | "bug"                                 |
        | openAtLeast(90)          | ageDays: 90                                                 | true  | "open 90 days"                        |
        | openAtLeast(90)          | ageDays: 89                                                 | false | "open 89 days"                        |
        | openAtLeast(1)           | ageDays: 1                                                  | true  | "open 1 day"                          |
        | openAtLeast(0)           | ageDays: 0                                                  | true  | "open 0 days"                         |
        | quietAtLeast(30)         | daysSinceUpdate: 45                                         | true  | "no update in 45 days"                |
        | quietAtLeast(30)         | daysSinceUpdate: 29                                         | false | "no update in 29 days"                |
        | quietAtLeast(1)          | daysSinceUpdate: 1                                          | true  | "no update in 1 day"                  |
        | carriedAtLeast(3)        | closedSprintCount: 3, carriedSince: "February"              | true  | "carried over 3 sprints since February" |
        | carriedAtLeast(3)        | closedSprintCount: 2                                        | false | "carried over 2 sprints"              |
        | carriedAtLeast(1)        | closedSprintCount: 1                                        | true  | "carried over 1 sprint"               |
        | votesAtLeast(3)          | votes: 3                                                    | true  | "3 votes"                             |
        | votesAtLeast(1)          | votes: 1                                                    | true  | "1 vote"                              |
        | votesAtLeast(3)          | votes: 2                                                    | false | "2 votes"                             |
        | watchersAtLeast(5)       | watchers: 5                                                 | true  | "5 watchers"                          |
        | watchersAtLeast(1)       | watchers: 1                                                 | true  | "1 watcher"                           |
        | duplicatesAtLeast(2)     | duplicateLinks: 2                                           | true  | "2 duplicates linked"                 |
        | duplicatesAtLeast(1)     | duplicateLinks: 1                                           | true  | "1 duplicate linked"                  |
        | commentsAtLeast(10)      | commentCount: 10                                            | true  | "10 comments"                         |
        | commentsAtLeast(1)       | commentCount: 1                                             | true  | "1 comment"                           |
        | commentsAtLeast(0)       | commentCount: null                                          | false | "0 comments"                          |
        | blocksAtLeast(1)         | blocksOpenCount: 1                                          | true  | "blocks 1 open ticket"                |
        | blocksAtLeast(1)         | blocksOpenCount: 3                                          | true  | "blocks 3 open tickets"               |
        | blocksAtLeast(1)         | blocksOpenCount: 0                                          | false | "blocks 0 open tickets"               |
        | priorityAtMost("low")    | priorityName: "Lowest", priorityRank: "low"                 | true  | "priority Lowest"                     |
        | priorityAtMost("low")    | priorityName: "Medium", priorityRank: "medium"              | false | "priority Medium"                     |
        | priorityAtMost("medium") | priorityName: "Normal", priorityRank: "medium"              | true  | "priority Normal"                     |
        | priorityAtMost("medium") | priorityName: "Low", priorityRank: "low"                    | true  | "priority Low"                        |
        | priorityAtMost("medium") | priorityName: "High", priorityRank: "high"                  | false | "priority High"                       |
        | priorityAtMost("medium") | priorityName: "P2", priorityRank: "high"                    | false | "priority P2"                         |
        | priorityAtMost("low")    | priorityName: null, priorityRank: "none"                    | false | "priority unset"                      |

    @boundary
    Scenario Outline: deadlineWithin matches a due date or a release from 0 to n days ahead, not overdue ones, and describes the nearer one inside the window
      Given facts F = BASE_FACTS with <changes>
      Then deadlineWithin(14).test(F) is <test>
      And deadlineWithin(14).describe(F) is <describe>

      Examples:
        | changes                                                  | test  | describe                         |
        | dueInDays: 14                                            | true  | "due in 14 days"                 |
        | dueInDays: 15                                            | false | "due today"                      |
        | dueInDays: 1                                             | true  | "due in 1 day"                   |
        | dueInDays: 0                                             | true  | "due today"                      |
        | dueInDays: -1                                            | false | "due today"                      |
        | dueInDays: -5                                            | false | "due today"                      |
        | release: { name: "2.4", inDays: 7 }                      | true  | "release 2.4 in 7 days"          |
        | release: { name: "2.4", inDays: 0 }                      | true  | "release 2.4 today"              |
        | release: { name: "2.4", inDays: -2 }                     | false | "due today"                      |
        | release: { name: "3.0", inDays: 30 }                     | false | "due today"                      |
        | dueInDays: 20, release: { name: "2.4", inDays: 5 }       | true  | "release 2.4 in 5 days"          |
        | dueInDays: 3, release: { name: "2.4", inDays: 20 }       | true  | "due in 3 days"                  |
        | dueInDays: 6, release: { name: "2.4", inDays: 5 }        | true  | "release 2.4 in 5 days"          |
        | dueInDays: 5, release: { name: "2.4", inDays: 5 }        | true  | "due in 5 days"                  |
        | dueInDays: null, release: null                           | false | "due today"                      |

    @boundary
    Scenario: Signal factories take any number as a threshold without refusing it
      Then openAtLeast(0).test(BASE_FACTS) is true
      And openAtLeast(-1).test(BASE_FACTS) is true
      And quietAtLeast(NaN).test(BASE_FACTS) is false
      And votesAtLeast(2.5).test(BASE_FACTS with votes: 3) is true and its id is "votes-at-least"
      And deadlineWithin(0).test(BASE_FACTS with dueInDays: 0) is true

  Rule: The registry lists six categories in a fixed order, and resolveCategories applies a board's overrides

    @happy
    Scenario: The registry as shipped
      Then CATEGORIES.map(c => c.id) deep-equals ["left-behind", "always-next-sprint", "quietly-wanted", "holding-others-up", "paper-cuts", "deadline-exposed"]
      And each category's label, why and defaults are as in the registry tables of this spec
      And no category id equals UNCATEGORIZED, which is "uncategorized"

    @happy
    Scenario: With no config every category is enabled at its defaults
      When resolveCategories() is called
      Then it returns six ResolvedCategory values in registry order
      And the first deep-equals { id: "left-behind", label: "Left behind", why: "The team has shown it won't reach this, so outsourcing takes nothing off the roadmap.", enabled: true, thresholds: { minAgeDays: 180, minQuietDays: 90 } }
      And resolveCategories({}) deep-equals resolveCategories()

    @happy
    Scenario: A threshold override replaces only that threshold
      When resolveCategories({ "left-behind": { thresholds: { minAgeDays: 365 } } }) is called
      Then "left-behind" has thresholds { minAgeDays: 365, minQuietDays: 90 }
      And every other category keeps its defaults

    @boundary
    Scenario Outline: An override that is null, undefined or not finite keeps the default; any finite number replaces it
      When resolveCategories({ "always-next-sprint": { thresholds: { minSprints: <value> } } }) is called
      Then "always-next-sprint" has thresholds { minSprints: <resolved> }

      Examples:
        | value     | resolved |
        | 5         | 5        |
        | 0         | 0        |
        | 2.5       | 2.5      |
        | null      | 2        |
        | undefined | 2        |
        | -1        | -1       |
        | NaN       | 2        |
        | Infinity  | 2        |

    @boundary
    Scenario: Unknown thresholds and unknown categories are ignored
      When resolveCategories({ "paper-cuts": { thresholds: { minAgeDays: 60, minVotes: 9 } }, "no-such-category": { enabled: false } }) is called
      Then "paper-cuts" has thresholds deep-equal to { minAgeDays: 60 }
      And the result still has exactly the six registry categories

    @happy
    Scenario Outline: enabled defaults to true and only false switches a category off
      When resolveCategories({ "quietly-wanted": <settings> }) is called
      Then "quietly-wanted" has enabled <enabled> and thresholds { minVotes: 3, minWatchers: 5, minDuplicates: 1, minComments: <comments> }

      Examples:
        | settings                                              | enabled | comments |
        | undefined                                             | true    | 5        |
        | {}                                                    | true    | 5        |
        | { enabled: true }                                     | true    | 5        |
        | { enabled: false }                                    | false   | 5        |
        | { enabled: false, thresholds: { minComments: 4 } }    | false   | 4        |

    @boundary
    Scenario: Resolving returns fresh objects and never changes the registry
      Given R1 = resolveCategories({ "left-behind": { thresholds: { minAgeDays: 1 } } })
      When R1[0].thresholds is compared with CATEGORIES[0].defaults
      Then CATEGORIES[0].defaults is still { minAgeDays: 180, minQuietDays: 90 }
      And resolveCategories()[0] is not the same object as R1[0]

  Rule: A classifier returns every enabled category whose rule matches, in registry order, with a reason

    The reason is the clauses of the evaluation joined with ", ", with its
    first character upper-cased. When a matching rule yields no clauses, the
    reason is the category's label.

    @happy
    Scenario Outline: Each shipped category at its defaults
      Given facts F = BASE_FACTS with <changes>
      When classify(F) is called
      Then the result deep-equals [{ id: <id>, label: <label>, reason: <reason> }]

      Examples:
        | changes                                                                                              | id                   | label                | reason                                           |
        | ageDays: 400, daysSinceUpdate: 200                                                                   | "left-behind"        | "Left behind"        | "Open 400 days, never in a sprint, unassigned"   |
        | closedSprintCount: 3, carriedSince: "February", inSprint: true, assigned: true                       | "always-next-sprint" | "Always next sprint" | "Carried over 3 sprints since February"          |
        | votes: 4, watchers: 7, priorityName: "Low", priorityRank: "low", closedSprintCount: 1                | "quietly-wanted"     | "Quietly wanted"     | "4 votes, 7 watchers, priority Low"              |
        | blocksOpenCount: 2, inSprint: true                                                                   | "holding-others-up"  | "Holding others up"  | "Blocks 2 open tickets, unassigned"              |
        | isBug: true, priorityName: "Low", priorityRank: "low", ageDays: 120, daysSinceUpdate: 1, inSprint: true | "paper-cuts"      | "Paper cuts"         | "Low-priority bug, open 120 days"                |
        | dueInDays: 10, closedSprintCount: 1                                                                  | "deadline-exposed"   | "Deadline exposed"   | "Due in 10 days, not in any sprint"              |

    @happy
    Scenario: An issue can fit several categories; matches come in registry order
      Given facts F = BASE_FACTS with ageDays: 400, daysSinceUpdate: 200, isBug: true, priorityName: "Trivial", priorityRank: "low", dueInDays: 3
      When classify(F) is called
      Then the result deep-equals
        | id                 | label            | reason                                                     |
        | "left-behind"      | "Left behind"      | "Open 400 days, never in a sprint, unassigned" |
        | "paper-cuts"       | "Paper cuts"       | "Trivial-priority bug, open 400 days"          |
        | "deadline-exposed" | "Deadline exposed" | "Due in 3 days, not in any sprint"             |

    @boundary
    Scenario: An issue that fits nothing gets an empty list, never UNCATEGORIZED
      When classify(BASE_FACTS with assigned: true) is called
      Then the result deep-equals []

    @boundary
    Scenario: A silent clause can make or break a match without appearing in the reason
      Given facts F = BASE_FACTS with ageDays: 400, daysSinceUpdate: 200
      Then classify(F) deep-equals [{ id: "left-behind", label: "Left behind", reason: "Open 400 days, never in a sprint, unassigned" }]
      And classify(F with daysSinceUpdate: 10) deep-equals []
      And classify(BASE_FACTS with dueInDays: 5) deep-equals [{ id: "deadline-exposed", label: "Deadline exposed", reason: "Due in 5 days, not in any sprint" }]
      And classify(BASE_FACTS with dueInDays: 5, assigned: true) deep-equals []

    @happy
    Scenario: Overrides change what matches
      Given facts F = BASE_FACTS with closedSprintCount: 1, assigned: true
      Then classify(F) deep-equals []
      And classify(F, { "always-next-sprint": { thresholds: { minSprints: 1 } } }) deep-equals [{ id: "always-next-sprint", label: "Always next sprint", reason: "Carried over 1 sprint" }]
      And classify(F, { "always-next-sprint": { enabled: false, thresholds: { minSprints: 1 } } }) deep-equals []

    @boundary
    Scenario: A rule that matches with no clauses gives the category's label as the reason
      Given a custom category { id: "all-of-it", label: "All of it", why: "Everything qualifies.", defaults: {}, rule: () => all() }
      When classify(BASE_FACTS, {}, [that category]) is called
      Then the result deep-equals [{ id: "all-of-it", label: "All of it", reason: "All of it" }]

    @happy
    Scenario: createClassifier builds each enabled rule once and is reusable
      Given two custom categories { id: "one", label: "One", why: "First.", defaults: { votes: 1 } } and { id: "two", label: "Two", why: "Second.", defaults: {} }
      And each one's rule function counts its calls and returns signal("s", f => f.votes >= 1, f => `${f.votes} votes`)
      And config { two: { enabled: false } }
      When C = createClassifier(config, [one, two]) is created
      Then the rule of "one" was called once, with thresholds deep-equal to { votes: 1 }, and the rule of "two" was never called
      When C is called with BASE_FACTS with votes: 1, then BASE_FACTS, then BASE_FACTS with votes: 2
      Then the results are [{ id: "one", label: "One", reason: "1 votes" }], [] and [{ id: "one", label: "One", reason: "2 votes" }]
      And the rule of "one" was still called only once

    @boundary
    Scenario: classify is createClassifier applied once
      Given F = BASE_FACTS with ageDays: 400, daysSinceUpdate: 200, isBug: true, priorityName: "Trivial", priorityRank: "low", dueInDays: 3
      And K = { "paper-cuts": { enabled: false } }
      Then classify(F, K) deep-equals createClassifier(K)(F)
      And two classifiers made from different configs, called alternately on the same facts, each return the same results as when called alone
```

Decided:
- Entry point: tests import from `packages/core/src/selection/index.ts`, which re-exports all four modules. The root `src/index.ts`, `bounty.ts` and `handle.ts` are unchanged.
- Day counting: `ageDays` and `daysSinceUpdate` are `floor(elapsed ms / 86_400_000)`, clamped at 0. A missing, unparseable or future date gives 0. `daysSinceUpdate` does not fall back to `ageDays`.
- `dueInDays` and `release.inDays` are differences in UTC calendar days between now and the parsed date (full timestamp, offset applied). They are negative when overdue and null when the date is missing or unparseable.
- `assigned` is true for any non-null assignee, blank or not.
- `inSprint` is true for any sprint whose state is not exactly "closed" (case-sensitive).
- `carriedSince` is the UTC month name of the earliest closed sprint's `startDate`, or its `endDate` when `startDate` does not parse ("February"). The year is appended when it differs from now's UTC year ("November 2025"). It is null when no date parses.
- Links: the type name is matched as a case-insensitive substring ("duplicate", "block"). Only inward "Duplicate" links count. "Blocks" counts only outward links whose status category is not exactly "done" (case-sensitive).
- Null `votes`/`watchers` become 0. A null or absent `commentCount` stays null, and `commentsAtLeast` never matches it.
- `PRIORITY_RANKS` contents: lowest/trivial/low/minor are low, medium/normal are medium. Names are trimmed and lowercased before lookup. Any other non-blank name ranks "high", and a blank or null priority ranks "none". `priorityName` is trimmed, and blank becomes null.
- `PRIORITY_RANKS`, `BUG_ISSUE_TYPES` and `CATEGORIES` are not frozen.
- `release` is the earliest-dated unreleased version that is today or later. Overdue, undated and unparseable versions are ignored. Ties go to array order.
- `evaluate`: `all()` matches and `any()` does not. Both `all` and `any` evaluate every child. Clauses keep rule order, drop nulls, keep duplicates, and are empty when the rule does not match.
- `describe` is called only after `test` matched. Called directly, it describes whatever facts it is given, except `deadlineWithin`, which describes only a date inside its window and otherwise returns "due today".
- Signal ids are the kebab name without the threshold (`open-at-least`), and `priority-at-most-low`/`priority-at-most-medium`. Description wording and singular/plural (singular only for exactly 1) are as in the signal table.
- `deadlineWithin` matches 0 to n days ahead, not overdue. It accepts a due date or a release and describes the nearer one inside the window, with a tie going to the due date.
- Signal factories do not validate their threshold: negative, fractional and non-finite numbers are used as given.
- The registry's ids, threshold names, defaults, rule compositions and `why` texts are as tabled here.
- Overrides: null, undefined and non-finite values keep the default. Any finite number is accepted, including 0, fractions and negatives. Unknown threshold keys and unknown category ids are ignored.
- `enabled` is true unless it is false. Disabled categories still appear in `resolveCategories`, with their thresholds resolved.
- Category lists are not checked for duplicate or reserved ids.
- Reason format: clauses joined with ", " and the first character upper-cased. It falls back to the category's `label` when there are no clauses.
- Matches come in registry order. An issue with no match gets `[]`, and `UNCATEGORIZED` is never returned.
- `createClassifier` resolves and builds rules once, at creation, and only for enabled categories.
- Everything is synchronous and stateless, so overlapping calls cannot interfere. No `@concurrency` scenario applies.
