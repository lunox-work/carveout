# Home's setup stage and getting-started checklist

Home becomes one page that changes with what a workspace has connected
(ticket #84). The decision of *which* home to show, and what the
getting-started checklist above it says, is made in a new, pure module,
`apps/web/src/features/onboarding/setup.ts`. `useWorkspaceSetup` (outside
this seam) gathers the facts from the cache keys the summarised pages already
use and passes them in as a `SetupFacts`; this module only reads that value.
It imports no React, no query client, no `fetch`, no storage and no clock,
so every behaviour below is checked by calling its exports with a plain
object, the way `test/analysis-labels.test.ts` calls `runDuration`.

The file is new, so no existing export of it changes. Everything outside it
(`useJira`, `withoutJira`, `useJiraBoards`, `useGithub`, `HomeBoard`'s
`readHomeBoard`/`writeHomeBoard`, the removal of `useConnections`) is out of
this spec's scope and keeps the behaviour it has at the starting commit
unless another spec says otherwise.

## Exports

Exactly these, with these signatures (as the ticket gives them):

```ts
export type SetupStage = "barebone" | "jira" | "github" | "both";

export interface SetupFacts {
    readonly jira: {
        readonly available: boolean;   // the server offers Jira at all
        readonly connected: number;    // healthy Jira connections
        readonly broken: number;       // unhealthy ones (need reconnecting)
        readonly boards: number;       // registered boards
    };
    readonly github: {
        readonly available: boolean;   // the server has a GitHub App configured
        readonly connected: number;    // GitHub connections (installations)
        readonly repositories: number; // registered repositories
    };
    readonly proposals: number;        // proposals in the workspace
    readonly bounties: number;         // bounties in the workspace
    readonly canManage: boolean;       // the person is an owner or admin
}

export function setupStage(facts: SetupFacts): SetupStage;

export type SetupStepId = "jira" | "github" | "size";

export interface SetupStep {
    readonly id: SetupStepId;
    readonly done: boolean;
    readonly current: boolean;
}

export function setupSteps(facts: SetupFacts): SetupStep[];

export function setupComplete(facts: SetupFacts): boolean;
```

No other export is added. All three functions are synchronous, total (they
never throw for any value of the declared type) and pure: they do not mutate
`facts`, and equal inputs give equal outputs. `setupSteps` returns a new
array on every call.

## Definitions used by every rule

- A count is **positive** when `count > 0`. Zero, negative numbers and `NaN`
  are not positive; a fractional count above zero (e.g. `0.5`) is positive.
  No input is rejected.
- **Jira counts for the stage** when `jira.connected` is positive.
  `jira.available`, `jira.broken` and `jira.boards` never change this.
- **GitHub counts for the stage** when `github.connected` is positive **or**
  `github.repositories` is positive. `github.available` never changes this.
- The **jira step is done** when `jira.connected` is positive.
- The **github step is done** when `github.repositories` is positive. A
  GitHub connection with no repository does not complete it.
- The **size step is done** when `proposals` is positive. `bounties` never
  completes it.
- `jira.available` and `github.available` only decide whether that tool's
  step is listed. `canManage` is read by none of the three functions.

```gherkin
Feature: Home's setup stage and getting-started checklist
  setupStage, setupSteps and setupComplete in
  apps/web/src/features/onboarding/setup.ts decide which home a workspace
  sees and what its checklist says, from a SetupFacts value alone.

  Background:
    Given the base facts are:
      | field              | value |
      | jira.available     | true  |
      | jira.connected     | 0     |
      | jira.broken        | 0     |
      | jira.boards        | 0     |
      | github.available   | true  |
      | github.connected   | 0     |
      | github.repositories| 0     |
      | proposals          | 0     |
      | bounties           | 0     |
      | canManage          | true  |
    And each scenario changes only the fields it names

  Rule: setupStage names the tools that count: neither is "barebone", Jira alone is "jira", GitHub alone is "github", both is "both"

    @happy
    Scenario Outline: The stage follows the healthy connections
      Given jira.connected is <jira> and github.connected is <github>
      When setupStage is called
      Then it returns "<stage>"

      Examples:
        | jira | github | stage    |
        | 0    | 0      | barebone |
        | 1    | 0      | jira     |
        | 0    | 1      | github   |
        | 1    | 1      | both     |
        | 3    | 2      | both     |

    @boundary
    Scenario Outline: Boards, proposals and bounties do not change the stage; repositories add GitHub
      Given jira.connected is 1 and jira.boards is <boards>
      And github.repositories is <repositories>
      And proposals is <proposals> and bounties is <bounties>
      When setupStage is called
      Then it returns "<stage>"

      Examples:
        | boards | repositories | proposals | bounties | stage |
        | 0      | 0            | 0         | 0        | jira  |
        | 4      | 0            | 0         | 0        | jira  |
        | 0      | 0            | 12        | 3        | jira  |
        | 0      | 7            | 12        | 3        | both  |

    @boundary
    Scenario: GitHub repositories without a GitHub connection are the GitHub stage
      Given github.connected is 0 and github.repositories is 5
      When setupStage is called
      Then it returns "github"

    @boundary
    Scenario: canManage does not change the stage
      Given canManage is false and jira.connected is 1 and github.connected is 1
      When setupStage is called
      Then it returns "both"

  Rule: Only healthy connections count; a workspace whose Jira sites all need reconnecting is not at the Jira stage

    @unhappy
    Scenario Outline: Broken Jira connections do not make Jira count
      Given jira.connected is <connected> and jira.broken is <broken>
      And github.connected is <github>
      When setupStage is called
      Then it returns "<stage>"

      Examples:
        | connected | broken | github | stage    |
        | 0         | 2      | 0      | barebone |
        | 0         | 1      | 1      | github   |
        | 1         | 3      | 0      | jira     |

  Rule: setupStage does not read available; a positive count gives a tool its place in the stage even when the server does not offer it

    @unhappy
    Scenario Outline: available false does not override the counts
      Given jira.available is <jiraAvailable> and jira.connected is <jira>
      And github.available is <githubAvailable> and github.connected is <github>
      When setupStage is called
      Then it returns "<stage>"

      Examples:
        | jiraAvailable | jira | githubAvailable | github | stage    |
        | false         | 2    | true            | 0      | jira     |
        | false         | 2    | true            | 1      | both     |
        | true          | 1    | false           | 4      | both     |
        | false         | 1    | false           | 1      | both     |
        | false         | 0    | false           | 0      | barebone |

  Rule: A count is positive only when it is greater than zero; no input is rejected and no call throws

    @boundary
    Scenario Outline: Odd counts are read, not rejected
      Given jira.connected is <jira> and github.connected is <github>
      When setupStage is called
      Then it returns "<stage>" without throwing

      Examples:
        | jira | github | stage    |
        | -1   | 0      | barebone |
        | NaN  | 0      | barebone |
        | 0    | -3     | barebone |
        | 0.5  | 0      | jira     |
        | NaN  | 1      | github   |

    @boundary
    Scenario: Negative and NaN proposal and bounty counts are not sized
      Given proposals is -1 and bounties is NaN
      When setupSteps is called
      Then the "size" step has done false

  Rule: setupSteps lists the offered steps in the order jira, github, size, except at the GitHub stage, where it is github, size, jira

    The "jira" step is listed when jira.available is true, and the "github"
    step when github.available is true; canManage and the connection counts
    do not matter. The "size" step is always listed, so the list is never
    empty. When setupStage returns "github" the listed steps are in the order
    github, size, jira; at every other stage they are jira, github, size.

    @happy
    Scenario: A fresh workspace lists all three steps
      When setupSteps is called
      Then it returns:
        | id     | done  | current |
        | jira   | false | true    |
        | github | false | false   |
        | size   | false | false   |

    @boundary
    Scenario Outline: A tool the server does not offer has no step
      Given jira.available is <jiraAvailable> and github.available is <githubAvailable>
      When setupSteps is called
      Then the step ids are, in order, <ids>

      Examples:
        | jiraAvailable | githubAvailable | ids                |
        | true          | true            | jira, github, size |
        | false         | true            | github, size       |
        | true          | false           | jira, size         |
        | false         | false           | size               |

    @happy
    Scenario Outline: At the GitHub stage sizing comes before Jira
      Given github.connected is <github> and github.repositories is <repositories>
      And jira.available is <jiraAvailable>
      When setupSteps is called
      Then the step ids are, in order, <ids>

      Examples:
        | github | repositories | jiraAvailable | ids                |
        | 1      | 0            | true          | github, size, jira |
        | 0      | 2            | true          | github, size, jira |
        | 1      | 2            | false         | github, size       |

    @boundary
    Scenario Outline: canManage does not change which steps are listed
      Given canManage is false
      And jira.connected is <jira> and github.connected is <github>
      When setupSteps is called
      Then the step ids are, in order, <ids>

      Examples:
        | jira | github | ids                |
        | 0    | 0      | jira, github, size |
        | 1    | 0      | jira, github, size |
        | 0    | 1      | github, size, jira |
        | 1    | 1      | jira, github, size |

    @unhappy
    Scenario: A member whose workspace has only broken Jira sites still sees the Jira step, undone
      Given canManage is false and jira.connected is 0 and jira.broken is 2
      When setupSteps is called
      Then it returns:
        | id     | done  | current |
        | jira   | false | true    |
        | github | false | false   |
        | size   | false | false   |

  Rule: A step is done when its outcome holds: jira when jira.connected is positive, github when github.repositories is positive, size when proposals is positive

    @happy
    Scenario Outline: Each step is done on its own fact
      Given jira.connected is <jira> and github.connected is <github> and github.repositories is <repositories>
      And proposals is <proposals> and bounties is <bounties>
      When setupSteps is called
      Then the steps' done values are jira <jiraDone>, github <githubDone>, size <sizeDone>

      Examples:
        | jira | github | repositories | proposals | bounties | jiraDone | githubDone | sizeDone |
        | 0    | 0      | 0            | 0         | 0        | false    | false      | false    |
        | 1    | 0      | 0            | 0         | 0        | true     | false      | false    |
        | 0    | 1      | 0            | 0         | 0        | false    | false      | false    |
        | 0    | 0      | 1            | 0         | 0        | false    | true       | false    |
        | 0    | 0      | 0            | 1         | 0        | false    | false      | true     |
        | 0    | 0      | 0            | 0         | 1        | false    | false      | false    |
        | 2    | 1      | 4            | 5         | 3        | true     | true       | true     |

    @boundary
    Scenario: Boards complete no step; repositories complete the GitHub step
      Given jira.boards is 3 and github.repositories is 2
      When setupSteps is called
      Then it returns:
        | id     | done  | current |
        | github | true  | false   |
        | size   | false | true    |
        | jira   | false | false   |

    @unhappy
    Scenario: Broken Jira sites leave the Jira step undone for a manager
      Given jira.connected is 0 and jira.broken is 1
      When setupSteps is called
      Then it returns:
        | id     | done  | current |
        | jira   | false | true    |
        | github | false | false   |
        | size   | false | false   |

  Rule: Exactly one step is current, the first listed step that is not done; when every step is done none is current

    @happy
    Scenario Outline: current moves to the first undone step in list order
      Given jira.connected is <jira> and github.connected is <github> and github.repositories is <repositories>
      And proposals is <proposals>
      When setupSteps is called
      Then the current step is <current>

      Examples:
        | jira | github | repositories | proposals | current |
        | 0    | 0      | 0            | 0         | jira    |
        | 1    | 0      | 0            | 0         | github  |
        | 1    | 1      | 0            | 0         | github  |
        | 1    | 0      | 1            | 0         | size    |
        | 0    | 0      | 1            | 0         | size    |
        | 0    | 1      | 1            | 1         | jira    |
        | 0    | 0      | 0            | 1         | jira    |
        | 1    | 0      | 0            | 1         | github  |

    @boundary
    Scenario: Sizing before connecting does not move current past an undone step
      Given proposals is 4
      When setupSteps is called
      Then it returns:
        | id     | done  | current |
        | jira   | false | true    |
        | github | false | false   |
        | size   | true  | false   |

    @boundary
    Scenario: A member with nothing connected has the jira step current
      Given canManage is false
      When setupSteps is called
      Then it returns:
        | id     | done  | current |
        | jira   | false | true    |
        | github | false | false   |
        | size   | false | false   |

    @boundary
    Scenario: Every step done leaves none current
      Given jira.connected is 1 and github.repositories is 1 and proposals is 1
      When setupSteps is called
      Then it returns:
        | id     | done | current |
        | jira   | true | false   |
        | github | true | false   |
        | size   | true | false   |

  Rule: setupComplete is true exactly when every step setupSteps lists for the same facts is done

    @happy
    Scenario Outline: Completion follows the listed steps
      Given jira.available is <jiraAvailable> and jira.connected is <jira>
      And github.available is <githubAvailable> and github.repositories is <repositories>
      And canManage is <canManage> and proposals is <proposals>
      When setupComplete is called
      Then it returns <complete>

      Examples:
        | jiraAvailable | jira | githubAvailable | repositories | canManage | proposals | complete |
        | true          | 0    | true            | 0            | true      | 0         | false    |
        | true          | 1    | true            | 1            | true      | 0         | false    |
        | true          | 1    | true            | 0            | true      | 1         | false    |
        | true          | 1    | true            | 1            | true      | 1         | true     |
        | false         | 0    | false           | 0            | true      | 1         | true     |
        | true          | 1    | false           | 0            | true      | 1         | true     |
        | false         | 0    | true            | 1            | true      | 1         | true     |
        | true          | 0    | true            | 0            | false     | 1         | false    |
        | true          | 0    | true            | 0            | false     | 0         | false    |

    @boundary
    Scenario: A GitHub connection without a repository leaves the checklist incomplete
      Given jira.connected is 1 and github.connected is 1 and github.repositories is 0 and proposals is 1
      When setupComplete is called
      Then it returns false

    @boundary
    Scenario: A hand-written bounty does not complete the size step
      Given jira.connected is 1 and github.repositories is 1 and proposals is 0 and bounties is 1
      When setupComplete is called
      Then it returns false

    @boundary
    Scenario: setupComplete agrees with setupSteps for any facts
      Given any SetupFacts value
      When setupSteps and setupComplete are called with it
      Then setupComplete returns true exactly when every returned step has done true
      And when setupComplete returns true no returned step has current true

  Rule: The functions are pure: they do not mutate their input and return a fresh list each call

    @boundary
    Scenario: The facts are left as they were
      Given a frozen copy (Object.freeze, deeply) of facts with jira.connected 1 and proposals 2
      When setupStage, setupSteps and setupComplete are each called with it
      Then none of them throws
      And the facts still deep-equal their value before the calls

    @boundary
    Scenario: Each setupSteps call returns a new array
      When setupSteps is called twice with the same facts object
      Then the two results deep-equal each other
      And they are not the same array instance
```

These are synchronous functions of one value; calls cannot overlap, so there
is no `@concurrency` scenario. Whatever `useWorkspaceSetup` does while its
reads are still loading is outside this seam.

Decided:
- Which connections count: only `connected` (healthy) ones; `broken` never makes a tool count for the stage or a step done.
- Whether `available: false` with a positive count counts: `setupStage` ignores `available`, so the count still decides the stage (e.g. `jira.available: false, jira.connected: 2` is `"jira"`); `available: false` only removes that tool's step from `setupSteps`.
- Whether boards affect the stage or steps: they do not.
- Whether repositories affect the stage or steps: `github.repositories > 0` makes GitHub count for the stage, as `github.connected > 0` does, and is the only thing that makes the `github` step done; a GitHub connection with no repository gives the `"github"` stage but leaves the `github` step undone.
- Odd counts (negative, `NaN`, fractional): read as positive only when `> 0`; nothing is rejected and nothing throws.
- What "size" being done means: `proposals > 0` only; `bounties` (including a hand-written bounty) never completes it.
- Which steps are listed: a tool's step is listed exactly when that tool is available; `canManage` and the counts don't matter; `size` is always listed.
- Step order: `jira`, `github`, `size`, except when `setupStage` returns `"github"`, where it is `github`, `size`, `jira`; done steps keep their place.
- Which step is current: the first listed undone one; none when all are done; done-out-of-order steps don't move it.
- What `setupComplete` means: every step `setupSteps` lists is done (so it can't be true with an empty list, since `size` is always listed).
- Whether `canManage` affects anything: it does not; none of the three functions reads it.
- Purity: the input isn't mutated, and each `setupSteps` call returns a new array; no concurrency rules, because the functions are synchronous.
