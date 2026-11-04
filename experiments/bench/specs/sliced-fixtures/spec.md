# The profiler's scope reads abstractions and the data model; the analysis routes drop deepwiki and dependency-cruiser

Two context builders, `deepwiki` and `dependency_cruiser`, are removed from
`sandbox-factory` and `@sandbox-factory/shared` in the same change. Once they are gone,
`CONTEXT_BUILDERS` is `["graphify", "abstractions", "data_model"]`, `ContextBuilder`
is that union, and `enqueueAnalysisSchema.tool` accepts only those three names.
This spec covers the two files in `apps/api` that change with that removal:

- `apps/api/src/analysis/routes.ts`. Its builder parameters stop treating
  `deepwiki` as a special case, and "Build all" queues the three remaining
  builders.
- `apps/api/src/pricing/profiler.ts`. When `BountyProfiler` takes a profile
  from `queued` to `scoping`, it first enqueues or finds the snapshot's
  `abstractions` and `data_model` runs on the graph run. It waits until both
  have finished, then names the ones that succeeded in the scope run's
  parameters.

Some parts of the ticket happen outside these files and are not covered here:
the worker, the migration, the fixtures agent that writes fixtures for a
sliced draft, and the sandbox build that reads the newest `data_model` run.

## Exports

The names and signatures do not change:

- `apps/api/src/analysis/routes.ts`
  - `interface AnalysisRouteOptions` keeps the same fields.
  - `const REPOSITORY_PROPOSALS_MAX = 100` keeps its behaviour.
  - `function mountAnalysisRoutes(app: Hono<{ Variables: AuthVariables }>, options: AnalysisRouteOptions): void`
    keeps its behaviour except for the two changes below:
    - `POST /api/v1/orgs/:orgId/github/repositories/:id/runs` gives every
      builder `GRAPH_DEADLINE_MINUTES` as its default deadline.
    - `POST .../repositories/:id/builds` queues
      `graphify, abstractions, data_model`.

    The routes below keep their current behaviour:
    - The `slices`, `scope` and `runs/:id/fixtures` routes. The `scope` and
      `fixtures` routes still name the snapshot's `latestSucceeded`
      `abstractions` / `data_model` runs, and enqueue neither.
    - `proposals`.
    - All the read routes.
- `apps/api/src/pricing/profiler.ts`
  - `const PROFILE_SWEEP_MS = 30_000` keeps its value.
  - `interface BountyProfilerOptions` does not change. In particular,
    `runs` stays `Pick<AnalysisRunStore, "enqueue" | "get">`.
  - `class BountyProfiler` keeps `constructor(options)`,
    `request(organizationId: string, input: NewBountyProfile): Promise<void>`,
    `start(): void`, `stop(): Promise<void>`, `kick(): void` and
    `sweep(): Promise<void>`.
    - The `scoping → slicing` and `slicing → ready` steps keep their
      behaviour.
    - The sweep coalescing, error reporting, `onSettled` hand-off, cap
      hold-back and obsolete-log removal also keep their behaviour.
    - Only the `queued → scoping` step changes.

No new export is added.

```gherkin
Feature: The scope reads the snapshot's abstractions and data model, and only three context builders remain

  Background:
    Given CONTEXT_BUILDERS is ["graphify", "abstractions", "data_model"]
    And GRAPH_DEADLINE_MINUTES is 30 and AGENT_DEADLINE_MINUTES is 60

  Rule: The profiler's queued step enqueues or finds graphify, then abstractions, then data_model, before anything else

    Background:
      Given a BountyProfiler with maxActive 4
      And organization "org_1" has one profile "bpf_1" in status "queued" with proposalId "bpr_1", specRevision 2, specHash "h" repeated 64 times and snapshotId "rsn_1"

    @happy
    Scenario: The first sweep queues the graph and both map readers and leaves the row queued
      Given the runs store creates every run it is asked for with status "queued", with ids "arn_g", "arn_a" and "arn_d" in order
      When sweep() is called once
      Then runs.enqueue was called exactly 3 times on snapshot "rsn_1", in this order:
        | # | tool         | params                                                               | requestedBy | maxActive |
        | 1 | graphify     | { deadlineMinutes: 30 }                                              | null        | 3         |
        | 2 | abstractions | { deadlineMinutes: 30, builder: "abstractions", graphRunId: "arn_g" } | null        | 3         |
        | 3 | data_model   | { deadlineMinutes: 30, builder: "data_model", graphRunId: "arn_g" }   | null        | 3         |
      And no "scope" run was enqueued
      And profile "bpf_1" is still "queued" with scopeRunId null
      And ensureWorker was called once
      And onError was not called

    @happy
    Scenario: Once both map readers have succeeded, the scope names both and the row moves to scoping
      Given the first sweep has queued "arn_g", "arn_a" and "arn_d"
      And "arn_g", "arn_a" and "arn_d" have status "succeeded"
      When sweep() is called
      Then runs.enqueue was called 4 times in that sweep, for graphify, abstractions, data_model and scope in that order, with the first three params as in the first sweep
      And the scope enqueue has tool "scope", requestedBy null, maxActive 3, and params:
        """
        { deadlineMinutes: 60, agent: "scope", graphRunId: "arn_g",
          proposalId: "bpr_1", specRevision: 2, specHash: "hhhh…h" (64 h),
          abstractionsRunId: "arn_a", dataModelRunId: "arn_d" }
        """
      And profile "bpf_1" is "scoping" with scopeRunId equal to the scope run's id

    @boundary
    Scenario Outline: Only the map readers that succeeded are named, and the scope waits while either has not finished
      Given the graph run "arn_g" has status "succeeded"
      And the abstractions run "arn_a" has status "<abstractions>" and the data_model run "arn_d" has status "<data_model>"
      When sweep() is called
      Then a scope run is enqueued: <scope enqueued>
      And the scope params contain exactly these context keys: <named>
      And profile "bpf_1" ends the sweep in status "<status>"

      Examples:
        | abstractions | data_model | scope enqueued | named                                                | status   |
        | queued       | queued     | no             | (no scope)                                           | queued   |
        | running      | succeeded  | no             | (no scope)                                           | queued   |
        | succeeded    | queued     | no             | (no scope)                                           | queued   |
        | failed       | running    | no             | (no scope)                                           | queued   |
        | succeeded    | succeeded  | yes            | abstractionsRunId: "arn_a", dataModelRunId: "arn_d"  | scoping  |
        | succeeded    | failed     | yes            | abstractionsRunId: "arn_a"                           | scoping  |
        | failed       | succeeded  | yes            | dataModelRunId: "arn_d"                              | scoping  |
        | failed       | failed     | yes            | (none)                                               | scoping  |

    @boundary
    Scenario: A context key the profiler does not name is absent, not undefined or null
      Given "arn_g" has status "succeeded", and "arn_a" and "arn_d" have status "failed" with errorCode "tool_failed"
      When sweep() is called
      Then the scope params deep-equal { deadlineMinutes: 60, agent: "scope", graphRunId: "arn_g", proposalId: "bpr_1", specRevision: 2, specHash: "hhhh…h" (64 h) }
      And "abstractionsRunId" in params is false
      And "dataModelRunId" in params is false
      And profile "bpf_1" is "scoping" with errorCode null and runErrorCode null
      And onError was not called

    @happy
    Scenario: The map readers are queued while the graph itself is still queued
      Given the runs store answers the graphify enqueue with run "arn_g" in status "queued"
      When sweep() is called
      Then abstractions and data_model are both enqueued in that sweep with graphRunId "arn_g"
      And profile "bpf_1" is still "queued"

  Rule: A failed graph fails the profile before the map readers are asked for; a missing snapshot fails it as unavailable; a map reader that cannot be enqueued is left out

    Background:
      Given a BountyProfiler with maxActive 4
      And organization "org_1" has one profile "bpf_1" in status "queued" on snapshot "rsn_1"

    @unhappy
    Scenario: A graph out of retries fails the profile and queues nothing behind it
      Given the runs store answers the graphify enqueue with a run in status "failed" with errorCode "tool_failed"
      When sweep() is called
      Then runs.enqueue was called once, for graphify only
      And profile "bpf_1" is "failed" with errorCode "scope_failed" and runErrorCode "tool_failed"
      And ensureWorker was not called
      And onSettled was called once with that failed profile

    @boundary
    Scenario Outline: A map reader the store will not enqueue is left out, and the scope runs without it
      Given the runs store answers the graphify enqueue with run "arn_g" in status "succeeded"
      And it answers the <tool> enqueue with { ok: false, reason: "<reason>" }
      And it answers the other map reader's enqueue with run "<other id>" in status "succeeded"
      When sweep() is called
      Then a "scope" run is enqueued whose params contain exactly these context keys: <named>
      And profile "bpf_1" is "scoping" with errorCode null and runErrorCode null
      And onError was not called

      Examples:
        | tool         | reason         | other id | named                      |
        | abstractions | not-found      | arn_d    | dataModelRunId: "arn_d"    |
        | abstractions | graph_mismatch | arn_d    | dataModelRunId: "arn_d"    |
        | data_model   | not-found      | arn_a    | abstractionsRunId: "arn_a" |
        | data_model   | graph_mismatch | arn_a    | abstractionsRunId: "arn_a" |

    @boundary
    Scenario: A map reader the store will not enqueue does not end the wait for the other
      Given the runs store answers the graphify enqueue with run "arn_g" in status "succeeded"
      And it answers the abstractions enqueue with { ok: false, reason: "not-found" }
      And it answers the data_model enqueue with run "arn_d" in status "running"
      When sweep() is called
      Then no "scope" run was enqueued
      And profile "bpf_1" is still "queued"

    @unhappy
    Scenario: A profile with no snapshot fails before anything is enqueued
      Given profile "bpf_1" has snapshotId null
      When sweep() is called
      Then runs.enqueue was not called
      And profile "bpf_1" is "failed" with errorCode "source_unavailable"

    @unhappy
    Scenario: A scope that fails after the map readers finished fails the profile as before
      Given "arn_g", "arn_a" and "arn_d" have status "succeeded"
      And the runs store answers the scope enqueue with a run in status "failed" with errorCode "agent_unavailable"
      When sweep() is called
      Then profile "bpf_1" is "failed" with errorCode "scope_failed" and runErrorCode "agent_unavailable"

  Rule: Every enqueue in the queued step is held one slot under the cap, and meeting the cap leaves the row queued and stops the sweep's other queued rows

    @boundary
    Scenario Outline: The map readers' enqueues use the same held-back cap as the graph and the scope
      Given a BountyProfiler with maxActive <cap>
      And one profile in status "queued"
      When sweep() is called
      Then the graphify, abstractions and data_model enqueues each pass maxActive <held>

      Examples:
        | cap       | held |
        | undefined | 2    |
        | 1         | 1    |
        | 2         | 1    |
        | 4         | 3    |

    @boundary
    Scenario Outline: A map reader refused at the cap leaves the row queued, and the next queued row is not tried
      Given a BountyProfiler with maxActive 4
      And organization "org_1" has profiles "bpf_1" and "bpf_2", both "queued", for proposals "bpr_1" and "bpr_2" on snapshot "rsn_1"
      And the runs store creates the graphify run "arn_g" with status "queued"
      And it answers the <tool> enqueue with { ok: false, reason: "run_limit" }
      When sweep() is called
      Then runs.enqueue was called exactly <calls> times, all for "bpf_1"
      And both profiles are still "queued"
      And ensureWorker was called once
      And onError was not called

      Examples:
        | tool         | calls |
        | abstractions | 2     |
        | data_model   | 3     |

    @boundary
    Scenario: A row waiting on its map readers does not stop the next queued row
      Given a BountyProfiler with maxActive 4
      And organization "org_1" has profiles "bpf_1" on snapshot "rsn_1" and "bpf_2" on snapshot "rsn_2", both "queued"
      And every run the store creates has status "queued"
      When sweep() is called
      Then runs.enqueue was called 6 times: graphify, abstractions and data_model on "rsn_1", then on "rsn_2"
      And both profiles are still "queued"

  Rule: A map reader's re-queue removes its previous log, as the graph's and the scope's do

    @happy
    Scenario: Each re-queued run's obsolete log is removed in the queued step
      Given a BountyProfiler with maxActive 4 and one profile in status "queued"
      And every enqueue the runs store answers carries obsoleteLogKey "logs/old.txt" and creates a run in status "queued"
      When sweep() is called
      Then removeObject was called with "logs/old.txt" exactly 3 times, once each for graphify, abstractions and data_model

  Rule: Profiles on one snapshot share its graph and map readers, and overlapping sweeps still coalesce

    @concurrency
    Scenario: Two profiles on one snapshot ask for identical map-reader runs and name the same ones
      Given a BountyProfiler with maxActive 4
      And organization "org_1" has profiles "bpf_1" for "bpr_1" and "bpf_2" for "bpr_2", both "queued" on snapshot "rsn_1"
      And the runs store returns the existing run when tool and canonical params match
      And "arn_g", "arn_a" and "arn_d" already exist with status "succeeded"
      When sweep() is called
      Then the abstractions params enqueued for "bpf_1" and "bpf_2" are equal, and so are the data_model params
      And both scope runs name abstractionsRunId "arn_a" and dataModelRunId "arn_d"
      And both profiles are "scoping", each with its own scopeRunId

    @concurrency
    Scenario: A sweep asked for during a sweep returns that sweep and runs one more after it
      Given a BountyProfiler with one profile in status "queued"
      When sweep() is called twice without awaiting the first
      Then profiles.organizationsWithPending was called exactly 2 times once both have resolved

    @concurrency
    Scenario: A row another sweep moved to scoping first is left alone
      Given "arn_g", "arn_a" and "arn_d" have status "succeeded"
      And profiles.advance answers false because the row was moved by another sweep
      When sweep() is called
      Then the scope run is enqueued
      And onError and onSettled were not called

  Rule: Each context builder's default deadline on POST .../repositories/:id/runs is GRAPH_DEADLINE_MINUTES; a map reader names the graph run

    Background:
      Given mountAnalysisRoutes with a member of role "owner" in organization "org_1", repository "ghr_1" and current snapshot "rsn_1"
      And the runs store answers every enqueue with { ok: true, created: false, run } where run.id is "arn_1" with status "succeeded"

    @happy
    Scenario Outline: The builder's parameters, from the request body
      When POST /api/v1/orgs/org_1/github/repositories/ghr_1/runs is called with body <body>
      Then the response status is 202
      And runs.enqueue was called with, in order: <enqueued>

      Examples:
        | body                                                  | enqueued                                                                                                                         |
        | { tool: "graphify" }                                  | graphify { deadlineMinutes: 30 }                                                                                                 |
        | { tool: "graphify", params: { deadlineMinutes: 45 } } | graphify { deadlineMinutes: 45 }                                                                                                 |
        | { tool: "abstractions" }                              | graphify { deadlineMinutes: 30 }; abstractions { deadlineMinutes: 30, builder: "abstractions", graphRunId: "arn_1" }             |
        | { tool: "data_model", params: { deadlineMinutes: 120 } } | graphify { deadlineMinutes: 30 }; data_model { deadlineMinutes: 120, builder: "data_model", graphRunId: "arn_1" }             |

    @unhappy
    Scenario Outline: A removed builder's name is an invalid request
      When POST /api/v1/orgs/org_1/github/repositories/ghr_1/runs is called with body { tool: "<tool>" }
      Then the response status is 400 with body { error: "Invalid analysis request." }
      And runs.enqueue was not called
      And ensureWorker was not called

      Examples:
        | tool               |
        | deepwiki           |
        | dependency_cruiser |

  Rule: Build all queues graphify, abstractions and data_model, in that order, under the set's one admission

    Background:
      Given mountAnalysisRoutes with a member of role "owner" in organization "org_1", repository "ghr_1" and current snapshot "rsn_1"
      And maxActive is not set, so the cap is 3

    @happy
    Scenario: A fresh set is queued whole, and the snapshot becomes the repository's context
      Given the runs store creates each run in status "queued" with id "arn_<tool>" while fewer than its maxActive are active, starting with 2 active
      When POST /api/v1/orgs/org_1/github/repositories/ghr_1/builds is called with body { snapshotId: "rsn_1" }
      Then the response status is 202
      And the response's runs have tools ["graphify", "abstractions", "data_model"] in that order
      And the enqueued params are, in order:
        | tool         | params                                                                      |
        | graphify     | { deadlineMinutes: 30 }                                                     |
        | abstractions | { deadlineMinutes: 30, builder: "abstractions", graphRunId: "arn_graphify" } |
        | data_model   | { deadlineMinutes: 30, builder: "data_model", graphRunId: "arn_graphify" }   |
      And the maxActive passed to the three enqueues is [3, 6, 6]
      And repos.setContextSnapshot was called once with ("org_1", "ghr_1", "rsn_1")
      And ensureWorker was called once

    @boundary
    Scenario: A set already built is answered as is, held to the cap throughout, and wakes no worker
      Given the runs store answers every enqueue with { ok: true, created: false, run } where run.id is "arn_1" with status "succeeded"
      When POST /api/v1/orgs/org_1/github/repositories/ghr_1/builds is called with body {}
      Then the response status is 202 with 3 runs
      And the maxActive passed to the three enqueues is [3, 3, 3]
      And ensureWorker was not called
      And repos.setContextSnapshot was called once with ("org_1", "ghr_1", "rsn_1")

    @boundary
    Scenario: With the graph out of retries, only the graph is enqueued
      Given the runs store answers the graphify enqueue with a run in status "failed" with attempt 2
      When POST /api/v1/orgs/org_1/github/repositories/ghr_1/builds is called with body {}
      Then the response status is 202
      And runs.enqueue was called once, for "graphify"
      And the response has 1 run

    @unhappy
    Scenario: No slot left refuses the set at its first run
      Given 3 runs are already active
      When POST /api/v1/orgs/org_1/github/repositories/ghr_1/builds is called with body {}
      Then the response status is 409 with code "run_limit"
      And the maxActive passed to the enqueues is [3]
      And repos.setContextSnapshot was not called

  Rule: The scope route still names the snapshot's latest succeeded map readers and does not enqueue them

    @happy
    Scenario: A scope request with only a succeeded data_model run names just that run
      Given mountAnalysisRoutes with a member of role "owner" in organization "org_1", repository "ghr_1" and current snapshot "rsn_1"
      And proposal "bpr_1" has spec revision 2
      And runs.latestSucceeded answers "arn_model" for "data_model" and null for "abstractions"
      When POST /api/v1/orgs/org_1/github/repositories/ghr_1/scope is called with body { proposalId: "bpr_1" }
      Then the response status is 202
      And runs.enqueue was called for "graphify" and then "scope" only
      And the scope params have dataModelRunId "arn_model" and no abstractionsRunId key
```

## Decided:

- When the profiler waits on the map readers, the row stays in `queued` (WAIT). It moves to `scoping` only after the scope is enqueued.
  - Ticket: "The bounty profiler enqueues or finds the abstractions and data_model runs on the graph, waits for them, and names the ones that succeeded in the scope run."
  - Instead: add a new profile status, or enqueue the scope at once and name nothing.
- `abstractions` and `data_model` are enqueued in the same sweep as the graph, even while the graph is still queued. The queue holds them behind it.
  - Ticket: "The bounty profiler enqueues or finds the abstractions and data_model runs on the graph"
  - Instead: wait for the graph to succeed before asking for the map readers.
- Enqueue order is graphify, abstractions, data_model, then scope. Each one is sequential.
  - Ticket: silent.
  - Instead: enqueue the two map readers in parallel (`Promise.all`), or data_model first.
- Each map reader's params are `{ deadlineMinutes: GRAPH_DEADLINE_MINUTES, builder, graphRunId }`, so they share a cache key with the repository page's builds.
  - Ticket: silent.
  - Instead: `AGENT_DEADLINE_MINUTES`, the scope's own deadline.
- A map reader that ended `failed` does not fail the profile. It is left out of the scope params, and nothing is reported to `onError`.
  - Ticket: "names the ones that succeeded in the scope run."
  - Instead: fail the profile with `scope_failed` and the reader's run code.
- A map reader is "finished" when its status is `succeeded` or `failed`. While it is `queued` or `running`, the row waits.
  - Ticket: "waits for them"
  - Instead: wait only for the readers to leave `queued`.
- A context key that is not named is left out of the scope params. It is not set to `undefined` or `null`.
  - Ticket: silent.
  - Instead: always write both keys, with `null` for one that did not succeed.
- The profiler names the very runs it enqueued or found. It does not look up `latestSucceeded`, and `BountyProfilerOptions.runs` stays `Pick<AnalysisRunStore, "enqueue" | "get">`.
  - Ticket: "names the ones that succeeded in the scope run."
  - Instead: read `runs.latestSucceeded`, as the scope route does.
- A graph that comes back `failed` fails the profile before any map reader is enqueued.
  - Ticket: silent.
  - Instead: enqueue the map readers first, then fail.
- A map-reader enqueue answered `not-found` or `graph_mismatch` does not fail the profile. That reader is left out of the scope params, as a failed one is, and nothing is reported to `onError`. The scope is enqueued once the other reader has finished.
  - Ticket: "names the ones that succeeded in the scope run."
  - Instead: fail the profile with `source_unavailable` and `runErrorCode` null.
- A map-reader enqueue refused with `run_limit` leaves the row queued, and the sweep tries no other queued row in that organization (FULL).
  - Ticket: silent.
  - Instead: enqueue the scope without the refused reader.
- The map-reader enqueues use the same held-back cap as the profiler's other enqueues, `max(1, (maxActive ?? 3) - 1)`.
  - Ticket: silent.
  - Instead: the organization's full cap.
- A row waiting on its map readers does not stop the sweep's other queued rows.
  - Ticket: silent.
  - Instead: treat waiting like meeting the cap.
- The profiler sets no time limit of its own on the wait. The readers' own deadlines and retries end it.
  - Ticket: "waits for them"
  - Instead: fail the profile after some number of sweeps.
- The scope and fixtures routes keep naming `latestSucceeded` runs, and they do not enqueue or wait for the map readers.
  - Ticket: "The bounty profiler enqueues or finds the abstractions and data_model runs on the graph"
  - Instead: make the scope route enqueue and wait for them too.
- Every context builder's default deadline on `.../runs` is `GRAPH_DEADLINE_MINUTES`, and an asked deadline still wins.
  - Ticket: "Drop both tools, their parameters, summary schemas, artifact kinds and the now unused builder_unavailable error code."
  - Instead: keep a per-tool deadline switch for future agent-backed builders.
- Build all's cap after its first created run is `maxActive + CONTEXT_BUILDERS.length`, which is 6 with the default cap of 3.
  - Ticket: silent.
  - Instead: keep the old headroom of 8.
- A request naming `deepwiki` or `dependency_cruiser` gets 400 `{ error: "Invalid analysis request." }` and enqueues nothing.
  - Ticket: "Drop both tools, their parameters, summary schemas, artifact kinds and the now unused builder_unavailable error code."
  - Instead: answer 404 or 410 for a removed tool.
