# Hold each bounty step until the steps before it are approved

A bounty is made in three steps, in the order of `BOUNTY_STEPS` in
`packages/core/src/stages.ts`: its scope, its price, and its sandbox. Up to
now the steps have not been locked to each other. With this change a step
can be changed only once every step before it is approved: the price waits
on the scope, and the sandbox waits on both the scope and the price. The
scope has no step before it, so nothing holds it, and going back (unapproving,
removing, unpublishing) is never held. Core decides whether a step is held,
by which step, and the words that explain it, so the API (409 `step_held`
with `heldBy`) and the web page refuse alike. This spec covers only the two
new exports of `packages/core/src/stages.ts`. They are pure functions: no
clock, no I/O, and they do not change their arguments.

## Exports

Two functions are added to `packages/core/src/stages.ts`. They are re-exported
unchanged from `packages/core/src/index.ts` by its existing
`export * from "./stages.js"`.

```ts
export function stepHeldBy(step: "price" | "sandbox", bounty: {
    readonly version: number;
    readonly approval: {
        readonly version: number;
    } | null;
}, proposal: {
    readonly status: string;
} | null): "scope" | "price" | null;

export function stepHeldReason(step: "price" | "sandbox", heldBy: "scope" | "price"): string;
```

- `stepHeldBy` returns the earliest step before `step` that is not approved,
  or `null` when every step before it is approved.
  - The scope is approved exactly when `scopeApproved(bounty)` is `true`:
    `bounty.approval !== null && bounty.approval.version === bounty.version`.
  - The price is approved exactly when `proposal !== null &&
    proposal.status === "approved"`. The comparison is exact and
    case-sensitive. Any other status (`"proposed"`, `"rejected"`,
    `"superseded"`, `""`, `"Approved"`, …) or a `null` proposal means not approved.
  - For `"price"` the result is `"scope"` or `null`, and `proposal` is not read.
  - For `"sandbox"` the scope is checked first. The result is `"scope"` when
    the scope is not approved, whatever the proposal says. It is `"price"`
    when the scope is approved and the price is not, and `null` when both
    are approved.
  - Only approval counts. Drift (`stageDrift`), the sandbox's own status and
    any extra properties on the arguments do not change the result.
  - A `step` that is neither `"price"` nor `"sandbox"` at runtime (for example
    `"scope"`, passed with a cast) is not refused: it is held as the price
    is, so the result is `"scope"` or `null` and `proposal` is not read.
- `stepHeldReason` returns the one-sentence reason shown for a held step. It
  has no leading or trailing whitespace and no newline:
  - `("price", "scope")`: `Approve the scope before changing the price.`
  - `("sandbox", "scope")`: `Approve the scope and the price before changing the sandbox.`
  - `("sandbox", "price")`: `Approve the price before changing the sandbox.`
  - It never throws. Any other pair gets one of these three sentences: a
    `step` of `"price"` always gets the price's sentence; any other `step`
    gets the scope-and-price sentence when `heldBy` is `"scope"`, and the
    price-before-sandbox sentence otherwise.

These existing exports keep their behaviour exactly: `BOUNTY_STEPS`,
`BountyStep`, `BountyStages`, `StageDrift`, `stageDrift`, `scopeVersionOf`,
`scopeApproved`, `BOUNTY_STATUSES`, `BountyStatus` and `bountyStatus`.

```gherkin
Feature: Hold each bounty step until the steps before it are approved
  stepHeldBy(step, bounty, proposal) names the earliest step before `step`
  that is not approved, or null; stepHeldReason(step, heldBy) gives the
  words every surface refuses with.

  Background:
    Given the functions stepHeldBy and stepHeldReason imported from "packages/core/src/stages.ts"

  Rule: The price waits on the scope, approved at the version the scope is at

    @happy
    Scenario: A price over an approved scope is not held
      When stepHeldBy("price", { version: 2, approval: { version: 2 } }, null) is called
      Then it returns null

    @unhappy
    Scenario Outline: A price over a scope not approved at its version is held by the scope
      When stepHeldBy("price", { version: <version>, approval: <approval> }, null) is called
      Then it returns "scope"

      Examples:
        | version | approval         | why                                  |
        | 2       | null             | never approved                       |
        | 3       | { version: 2 }   | a version made since the approval    |
        | 1       | { version: 2 }   | approval names a version not current |

    @boundary
    Scenario: The price's hold does not read the proposal
      When stepHeldBy("price", { version: 2, approval: null }, { status: "approved" }) is called
      Then it returns "scope"
      When stepHeldBy("price", { version: 2, approval: { version: 2 } }, { status: "rejected" }) is called
      Then it returns null

    @boundary
    Scenario: Version 0 approved at version 0 is approved
      When stepHeldBy("price", { version: 0, approval: { version: 0 } }, null) is called
      Then it returns null

  Rule: The sandbox waits on the scope first, then on the price

    @happy
    Scenario: A sandbox over an approved scope and an approved price is not held
      When stepHeldBy("sandbox", { version: 4, approval: { version: 4 } }, { status: "approved" }) is called
      Then it returns null

    @unhappy
    Scenario Outline: The earliest step not approved holds the sandbox
      When stepHeldBy("sandbox", { version: 4, approval: <approval> }, <proposal>) is called
      Then it returns <heldBy>

      Examples:
        | approval       | proposal                   | heldBy  |
        | null           | null                       | "scope" |
        | null           | { status: "approved" }     | "scope" |
        | { version: 3 } | { status: "approved" }     | "scope" |
        | { version: 3 } | null                       | "scope" |
        | { version: 4 } | null                       | "price" |
        | { version: 4 } | { status: "proposed" }     | "price" |
        | { version: 4 } | { status: "rejected" }     | "price" |
        | { version: 4 } | { status: "superseded" }   | "price" |

    @boundary
    Scenario Outline: Only the exact status "approved" approves the price
      When stepHeldBy("sandbox", { version: 1, approval: { version: 1 } }, { status: <status> }) is called
      Then it returns <heldBy>

      Examples:
        | status        | heldBy  |
        | "approved"    | null    |
        | "Approved"    | "price" |
        | " approved"   | "price" |
        | "approved "   | "price" |
        | ""            | "price" |

  Rule: Only approval holds a step; drift and other fields do not

    @boundary
    Scenario: A price behind the scope does not hold the sandbox once both are approved
      # stageDrift would report this price as behind (sized from scope version 2 of 3);
      # the hold reads approvals only.
      Given the scope is at version 3 and approved at version 3
      And the live proposal has status "approved"
      When stepHeldBy("sandbox", { version: 3, approval: { version: 3 } }, { status: "approved" }) is called
      Then it returns null

    @boundary
    Scenario: A whole bounty with extra fields is read for its version and approval only
      When stepHeldBy("sandbox", { version: 2, approval: { version: 2, by: "usr_1" }, title: "Fix login", proposal: null, sandbox: { status: "published", expiresAt: null } }, { status: "approved", revision: 5 }) is called
      Then it returns null

    @happy
    Scenario: The functions do not change their arguments
      Given bounty = { version: 2, approval: { version: 1 } } and proposal = { status: "proposed" }, both frozen deeply
      When stepHeldBy("sandbox", bounty, proposal) is called
      Then it returns "scope"
      And no error is thrown and bounty and proposal are as they were

  Rule: A step outside "price" and "sandbox" is held as the price is

    @unhappy
    Scenario Outline: A step outside "price" and "sandbox" waits on the scope only
      When stepHeldBy(<step> as never, { version: 1, approval: <approval> }, null) is called
      Then it returns <heldBy>
      And no error is thrown

      Examples:
        | step      | approval       | heldBy  |
        | "scope"   | { version: 1 } | null    |
        | "Price"   | { version: 1 } | null    |
        | ""        | { version: 1 } | null    |
        | "scope"   | null           | "scope" |
        | "Price"   | { version: 0 } | "scope" |

  Rule: The reason names the held step and the step holding it, in one sentence

    @happy
    Scenario Outline: Each hold has its own words
      When stepHeldReason(<step>, <heldBy>) is called
      Then it returns <reason>

      Examples:
        | step      | heldBy  | reason                                                           |
        | "price"   | "scope" | "Approve the scope before changing the price."                   |
        | "sandbox" | "scope" | "Approve the scope and the price before changing the sandbox."   |
        | "sandbox" | "price" | "Approve the price before changing the sandbox."                 |

    @happy
    Scenario: Every hold stepHeldBy returns has a reason
      When stepHeldBy("sandbox", { version: 4, approval: { version: 4 } }, { status: "proposed" }) is called
      Then it returns "price"
      And stepHeldReason("sandbox", "price") returns "Approve the price before changing the sandbox."

    @unhappy
    Scenario Outline: A hold that cannot happen is not refused
      When stepHeldReason(<step> as never, <heldBy> as never) is called
      Then no error is thrown
      And it returns <reason>

      Examples:
        | step      | heldBy    | reason                                                           |
        | "price"   | "price"   | "Approve the scope before changing the price."                   |
        | "price"   | "sandbox" | "Approve the scope before changing the price."                   |
        | "scope"   | "scope"   | "Approve the scope and the price before changing the sandbox."   |
        | "sandbox" | "sandbox" | "Approve the price before changing the sandbox."                 |

  Rule: Existing stage exports keep their behaviour

    @happy
    Scenario: scopeApproved and bountyStatus are unchanged
      When scopeApproved({ version: 3, approval: { version: 2 } }) is called
      Then it returns false
      When bountyStatus({ version: 2, approval: null, proposal: { status: "approved" }, sandbox: null }, new Date("2026-10-10T00:00:00Z")) is called
      Then it returns "priced"
```

Decided:

- Scope approval: same test as `scopeApproved`. The approval's version must equal the bounty's version exactly, and that includes version 0.
- Price approval: only the exact, case-sensitive status `"approved"` counts. A `null` proposal and any other status hold.
- Order: the sandbox reports `"scope"` before `"price"` when both are unapproved, so the earliest step wins.
- `stepHeldBy("price", …)` never reads `proposal` and never returns `"price"`.
- Drift (`stageDrift`), sandbox status, publication lapse and extra properties on the arguments never affect the hold.
- A runtime `step` outside `"price" | "sandbox"`: `stepHeldBy` does not throw. It is held as the price is: `"scope"` when the scope is not approved, else `null`, without reading `proposal`.
- Reason wording: `("price", "scope")` → `Approve the scope before changing the price.`; `("sandbox", "scope")` → `Approve the scope and the price before changing the sandbox.`; `("sandbox", "price")` → `Approve the price before changing the sandbox.` Each is one sentence with no surrounding whitespace.
- A pair that `stepHeldBy` cannot return, such as `("price", "price")`: `stepHeldReason` does not throw. A `step` of `"price"` gets the price's sentence whatever `heldBy` is; any other `step` gets the scope-and-price sentence when `heldBy` is `"scope"`, else the price-before-sandbox sentence.
- Purity: both functions are synchronous and do not change their arguments. Calls cannot overlap in any way that matters, so there are no `@concurrency` scenarios.
- Going back (unapproving, removing, unpublishing) goes through no core function. The scope is never held, because nothing comes before it.
- Re-export: both functions reach `packages/core/src/index.ts` through the existing `export *`. No new types or constants are exported.
