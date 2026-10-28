# Limit concurrent evaluation jobs on a worker

Every evaluation job a worker runs (a sandbox build's baseline, each
`run_starter` call) comes from an `EvaluationProvider`
(`sandbox-factory`, `packages/core/src/sandbox/build.ts`): `create({ label,
signal })` gives an `EvaluationJob` that lives until its `destroy()`
settles. Nothing today bounds how many of those jobs are alive at once, so
parallel runs on one worker can start any number of `npm ci`/`npm test`
process trees side by side. Ticket #104 caps it at two. The change adds a
new module, `apps/worker/src/evaluation/limit.ts`, with a wrapper that takes
any `EvaluationProvider` and returns one that admits at most `max` live jobs,
queueing further `create` calls until a slot frees. The wrapper only counts
and queues: it never looks at a job's files, commands or results, and it
uses no clock, file system or process. Tests drive it with a fake provider
whose `create` and `destroy` resolve or reject when the test says so.

## Exports of `apps/worker/src/evaluation/limit.ts`

```ts
import type { EvaluationProvider } from "sandbox-factory";

/** Evaluation jobs one worker runs at once. */
export const EVALUATION_JOBS_MAX = 2;

/**
 * At most `max` of a provider's jobs at once on this worker. Agent runs share
 * a worker three at a time, and a job is a whole install, build and test
 * run: past the cap, a job waits for one to be destroyed before it is
 * created, or for its run to stop.
 */
export function limitJobs(
  provider: EvaluationProvider,
  max: number,
): EvaluationProvider;
```

Nothing else is exported. The types `EvaluationProvider`, `EvaluationJob`,
`EvaluationEnvironment`, `EvaluationCommand`, `EvaluationExecResult` and
`StagedFile` are imported from `sandbox-factory` and are not changed.
`createLocalProcessProvider`, `runProcess` and `LocalProcessOptions` in
`apps/worker/src/evaluation/local-process.ts` keep their behaviour exactly,
and the tests in `apps/worker/test/local-process.test.ts` pass as they are.
(The worker's entry point, `apps/worker/src/main.ts`, is expected to wrap its
provider as `limitJobs(createLocalProcessProvider(), EVALUATION_JOBS_MAX)`;
that wiring is not unit-tested and nothing below depends on it.)

## Terms used below

- **inner provider**: the `provider` passed to `limitJobs`; **inner job**:
  a job its `create` resolved with.
- **limited provider** / **limited job**: what `limitJobs` returns, and the
  jobs its `create` resolves with.
- **admitted**: a `create` call holds a slot and the inner `create` has been
  called with its spec.
- **waiting**: a `create` call that has not been admitted and has not
  settled.
- **settled** (for observations): the test has let pending promises run,
  for example `await new Promise((done) => setImmediate(done))`. Every "then"
  in the scenarios is observed after settling.

```gherkin
Feature: limitJobs caps how many evaluation jobs are alive at once

  Background:
    Given a fake inner provider named "fake"
    And each call to its create records the spec it was given and returns a promise the test resolves or rejects
    And each inner job it resolves with has an id, an environment, and stage, exec, read and destroy functions that record their calls
    And each inner job's destroy returns a promise the test resolves or rejects

  Rule: EVALUATION_JOBS_MAX is the worker's cap

    @happy
    Scenario: The constant is two
      Then EVALUATION_JOBS_MAX is 2

  Rule: max is not checked; limitJobs never throws for it

    @boundary
    Scenario Outline: Any max is accepted without throwing
      When limitJobs is called with the fake provider and max <max>
      Then it returns a provider without throwing
      And the inner provider's create has not been called

      Examples:
        | max              |
        | 0                |
        | -1               |
        | 1.5              |
        | NaN              |
        | Infinity         |
        | 1                |
        | 9007199254740991 |

    @boundary
    Scenario: With max 0 no create is ever admitted
      Given a limited provider made with max 0
      When create is called with label "j1"
      Then after settling "j1" is still waiting
      And the inner create has not been called

  Rule: The limited provider keeps the inner provider's name and is a new object

    @happy
    Scenario: The name passes through
      When limitJobs is called with the fake provider and max 2
      Then the result's name is "fake"
      And the result is not the same object as the fake provider
      And the inner provider's create has not been called

  Rule: While a slot is free, create is passed straight to the inner provider

    @happy
    Scenario: A create under the cap reaches the inner provider with the same label and signal
      Given a limited provider made with max 2
      And an AbortController "c"
      When create is called with label "sbv_1" and signal c.signal
      Then the inner create has been called once
      And it was given label "sbv_1" and the very same signal object c.signal

    @happy
    Scenario: The limited job forwards to the inner job and keeps its id and environment
      Given a limited provider made with max 2
      And the inner create resolves with a job whose id is "sandbox-eval-x-1" and whose environment is { provider: "fake", environmentId: null, templateDigest: null }
      When create is called with label "x" and resolves with a limited job
      Then the limited job's id is "sandbox-eval-x-1"
      And the limited job's environment is the same object as the inner job's environment
      And the limited job is not the same object as the inner job
      When the limited job's stage is called with [{ path: "a.txt", text: "a" }]
      Then the inner stage was called once with that same array and the call resolves with the inner stage's result
      When the limited job's exec is called with { argv: ["npm", "test"] }
      Then the inner exec was called once with that same command object
      And the call resolves with the very object the inner exec resolved with, here { exitCode: 0, timedOut: false, outputTruncated: false, stdout: "ok", stderr: "", durationMs: 5 }
      When the limited job's read is called with "package-lock.json" and the inner read resolves with null
      Then the call resolves with null

    @unhappy
    Scenario Outline: A failure of a forwarded job call passes through unchanged and does not touch the slot
      Given a limited provider made with max 1 holding one limited job "A"
      And another create "B" is waiting
      When A's <call> rejects with the error object E
      Then A's <call> rejects with E itself
      And B is still waiting
      And the inner create has been called once

      Examples:
        | call  |
        | stage |
        | exec  |
        | read  |

  Rule: At most max jobs are live; further creates wait and are admitted first in first out

    @concurrency
    Scenario Outline: Only max creates reach the inner provider at once
      Given a limited provider made with max <max>
      When create is called <calls> times without awaiting, with labels "j1", "j2", … in order
      Then the inner create has been called <admitted> times, with labels <labels>
      And <waiting> creates are waiting

      Examples:
        | max | calls | admitted | labels             | waiting |
        | 1   | 1     | 1        | "j1"               | 0       |
        | 1   | 3     | 1        | "j1"               | 2       |
        | 2   | 2     | 2        | "j1", "j2"         | 0       |
        | 2   | 3     | 2        | "j1", "j2"         | 1       |
        | 2   | 5     | 2        | "j1", "j2"         | 3       |
        | 3   | 5     | 3        | "j1", "j2", "j3"   | 2       |

    @concurrency
    Scenario: A slot is held from admission until destroy settles, not until create resolves
      Given a limited provider made with max 2
      And creates "j1" and "j2" have resolved with limited jobs J1 and J2
      When create "j3" is called
      Then the inner create has been called 2 times
      When J1's stage, exec and read are called and all resolve
      Then the inner create has still been called 2 times
      When J1's destroy is called and the inner destroy has not yet resolved
      Then the inner create has still been called 2 times
      When the inner destroy for J1 resolves
      Then the inner create has been called 3 times, the third with label "j3"

    @concurrency
    Scenario: Waiting creates are admitted in the order they were called
      Given a limited provider made with max 1
      And create "j1" has resolved with limited job J1
      And creates "j2", "j3" and "j4" are called in that order and are waiting
      When J1 is destroyed and its inner destroy resolves
      Then the inner create has been called with labels "j1", "j2" in that order
      When the job for "j2" resolves and is destroyed
      Then the inner create has been called with labels "j1", "j2", "j3"
      When the job for "j3" resolves and is destroyed
      Then the inner create has been called with labels "j1", "j2", "j3", "j4"

    @concurrency
    Scenario: A freed slot goes to the oldest waiter, not to a create called after it was freed
      Given a limited provider made with max 1
      And create "j1" has resolved with limited job J1
      And create "j2" is waiting
      When J1's destroy is called and its inner destroy resolves
      And create "j3" is called straight after `await J1.destroy()` returns, before any further settling
      Then after settling the inner create has been called with labels "j1", "j2"
      And "j3" is waiting

    @concurrency
    Scenario: Each destroy frees exactly one slot
      Given a limited provider made with max 2
      And creates "j1" and "j2" have resolved with limited jobs J1 and J2
      And creates "j3", "j4" and "j5" are waiting
      When J1 and J2 are destroyed together and both inner destroys resolve
      Then the inner create has been called with labels "j1", "j2", "j3", "j4"
      And "j5" is waiting

  Rule: A failed or aborted create gives its slot back at once and its error passes through unchanged

    @unhappy
    Scenario: An inner create that rejects frees its slot
      Given a limited provider made with max 1
      And create "j1" is admitted and create "j2" is waiting
      When the inner create for "j1" rejects with the error object E
      Then create "j1" rejects with E itself
      And the inner create has been called with labels "j1", "j2"

    @unhappy
    Scenario: An inner create that throws synchronously is treated as a rejection
      Given an inner provider whose create is a plain function that throws the error object E without returning a promise
      And a limited provider made over it with max 1
      When create "j1" is called
      Then the call returns a promise and does not throw
      And that promise rejects with E itself
      When the inner create is replaced to resolve normally and create "j2" is called
      Then the inner create is called for "j2" without waiting

    @unhappy
    Scenario: An abort the inner create reacts to is the inner create's rejection
      Given a limited provider made with max 1
      And an AbortController "c"
      And create "j1" with signal c.signal is admitted
      And create "j2" is waiting
      When c is aborted with reason R and the inner create for "j1" rejects with R
      Then create "j1" rejects with R itself
      And the inner create has been called with labels "j1", "j2"

  Rule: A create whose signal aborts before it is admitted rejects with the signal's reason and never reaches the inner provider

    @boundary
    Scenario: A signal already aborted at call time is admitted when a slot is free
      Given a limited provider made with max 2 and no live jobs
      And an AbortController "c" already aborted with the reason new Error("gone")
      When create is called with label "j1" and signal c.signal
      Then the inner create has been called once, with label "j1" and the very same signal object c.signal
      When the inner create for "j1" rejects with that same Error("gone") object
      Then create "j1" rejects with that same Error("gone") object
      And a following create "j2" with a fresh signal is admitted at once

    @unhappy
    Scenario: A signal already aborted at call time rejects at once when no slot is free
      Given a limited provider made with max 1
      And create "j1" has resolved with limited job J1
      And an AbortController "c" already aborted with the reason new Error("gone")
      When create is called with label "j2" and signal c.signal
      Then it rejects with that same Error("gone") object
      And the inner create has been called once, with label "j1"
      When create "j3" is called and J1 is destroyed and its inner destroy resolves
      Then the inner create has been called with labels "j1", "j3"
      And "j2" was never passed to the inner create

    @concurrency
    Scenario: A waiter whose signal aborts leaves the queue without taking a slot
      Given a limited provider made with max 1
      And create "j1" has resolved with limited job J1
      And an AbortController "c"
      And create "j2" with signal c.signal is waiting, then create "j3" is waiting
      When c is aborted with the reason new Error("stop")
      Then create "j2" rejects with that same Error("stop") object
      And the inner create has been called once, with label "j1"
      When J1 is destroyed and its inner destroy resolves
      Then the inner create has been called with labels "j1", "j3"
      And "j2" was never passed to the inner create

    @boundary
    Scenario: An abort after admission is left to the inner provider
      Given a limited provider made with max 1
      And an AbortController "c"
      And create "j1" with signal c.signal has resolved with limited job J1
      When c is aborted with reason R
      Then J1 still holds the slot
      And a create "j2" called now is waiting
      When J1 is destroyed and its inner destroy resolves
      Then the inner create is called for "j2"

  Rule: destroy always frees the slot once, whatever the inner destroy does

    @happy
    Scenario: destroy forwards to the inner job and resolves with its result
      Given a limited provider made with max 1 holding limited job J1
      When J1's destroy is called and the inner destroy resolves
      Then the inner destroy was called once
      And J1's destroy resolves with undefined

    @unhappy
    Scenario: An inner destroy that rejects still frees the slot
      Given a limited provider made with max 1 holding limited job J1
      And create "j2" is waiting
      When J1's destroy is called and the inner destroy rejects with the error object E
      Then J1's destroy rejects with E itself
      And the inner create is called for "j2"

    @boundary
    Scenario: Destroying the same job twice frees only one slot
      Given a limited provider made with max 1 holding limited job J1
      And creates "j2" and "j3" are waiting
      When J1's destroy is called twice and both inner destroys resolve
      Then the inner destroy was called twice
      And the inner create has been called with labels "j1", "j2"
      And "j3" is waiting

    @concurrency
    Scenario: Two overlapping destroys of the same job free only one slot
      Given a limited provider made with max 1 holding limited job J1
      And creates "j2" and "j3" are waiting
      When J1's destroy is called twice without awaiting, then both inner destroys resolve
      Then the inner create has been called with labels "j1", "j2"
      And "j3" is waiting

    @boundary
    Scenario: A job that is never destroyed keeps its slot
      Given a limited provider made with max 1
      And create "j1" has resolved with limited job J1 that is never destroyed
      When create "j2" is called
      Then after settling "j2" is still waiting
      And the inner create has been called once

    @boundary
    Scenario: The limited job's other calls still forward after destroy
      Given a limited provider made with max 1 holding limited job J1
      And J1 has been destroyed
      When J1's read is called with "a.txt"
      Then the inner read is called with "a.txt" and J1's read resolves with what it resolved with

  Rule: Each limitJobs call has its own count

    @concurrency
    Scenario: Two limited providers over the same inner provider do not share slots
      Given limited providers L1 and L2 made from the same fake provider, each with max 1
      When L1's create "a1" and L2's create "b1" are called
      Then the inner create has been called with labels "a1", "b1"
      When L1's create "a2" is called
      Then "a2" is waiting

    @concurrency
    Scenario: Wrapping a limited provider again applies the tighter cap
      Given L1 = limitJobs(fake, 2) and L2 = limitJobs(L1, 1)
      When L2's create is called twice with labels "j1" and "j2"
      Then the inner create has been called once, with label "j1"
      And "j2" is waiting
```

## Implementation notes the scenarios rely on

- A slot is taken by the `create` call it is granted to, either at call time
  (when fewer than `max` are live and nobody waits) or by being handed over
  directly from the job or failed create that frees it. A freed slot goes to
  the oldest waiter before any later `create` call can see it as free.
- An aborted waiter is removed from the queue; its abort listener is removed
  when it is admitted or leaves, so admitted calls hold no listener on the
  caller's signal.
- The limited job is a new object: `id` and `environment` are the inner
  job's own values; `stage`, `exec` and `read` call the inner job's functions
  with the same arguments and return their promises' outcome unchanged;
  `destroy` calls the inner `destroy` every time it is called, and the first
  time any call to it settles, the slot is freed.

Decided:
- `max` validation: none; `limitJobs` returns a provider for any `max` (0, -1, 1.5, `NaN`, `Infinity`, …) without throwing; with `max` 0 no `create` is ever admitted.
- Name: the limited provider keeps the inner provider's `name`; it is a new object.
- What counts as a live job: from admission of `create` until the job's `destroy()` settles, not until `create` resolves.
- Queue order: waiting creates are admitted first in first out; a freed slot is handed to the oldest waiter, so later calls cannot jump the queue.
- Inner `create` rejecting or throwing synchronously: slot freed at once, the same error passes through, the call always returns a promise.
- Signal already aborted at call time: with a slot free the call is admitted and the inner `create` is called with that signal (the abort is left to the inner provider); with no slot free it rejects with `signal.reason` at once, without queueing or calling the inner `create`.
- Signal aborting while waiting: rejects with `signal.reason`, leaves the queue, takes no slot; aborting after admission is left to the inner provider.
- Inner `destroy` rejecting: the slot is still freed and the same error passes through.
- Repeated or overlapping `destroy` calls: each is forwarded to the inner job, but only one slot is freed.
- A job never destroyed keeps its slot indefinitely; no timeout, since the wrapper has no clock.
- Forwarded `stage`/`exec`/`read`: same arguments, same results and errors, still forwarded after `destroy`.
- `id` and `environment` of the limited job are the inner job's own values (same `environment` object).
- Scope of the count: each `limitJobs` call has its own; wrapping twice composes to the tighter cap.
- `EVALUATION_JOBS_MAX` is `2`; wiring it into `main.ts` is expected but outside the unit-tested surface.
