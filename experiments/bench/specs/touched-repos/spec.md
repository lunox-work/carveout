# Refused starter checks say where they stopped; builds record their test counts

Ticket #132 has three parts. This spec covers the two that live in
`apps/worker/src/tools/{starter-check,starter,sandbox-build}.ts`:

- a refused starter check names the stage it stopped at (`rules`, `names`,
  `project`, `types`), in its step line and in the run log; the log keeps
  the problems but only counts those in hidden tests;
- a build run and a starter run record the counts in the built descriptor's
  `testSummary` on the version when they commit.

The first part, about repository labels in a draft (`draft-v9`), lives in
`apps/api` and is not part of this change.

## Exports

`apps/worker/src/tools/starter-check.ts`

```ts
export type StarterCheckStage = "rules" | "names" | "project" | "types";

export type StarterCheck =
  | {
      readonly ok: false;
      readonly stage: StarterCheckStage;
      readonly problems: readonly string[];
    }
  | {
      readonly ok: true;
      readonly problems: readonly [];
      readonly project: GeneratedProject;
      readonly starter: StarterSubmission;
    };

// The signature does not change. The result now carries `stage` when ok is false.
export function checkStarter(input: {
  readonly root: string;
  readonly version: ProjectVersion;
  readonly starter: StarterSubmission;
  readonly spec: SpecDraft | null;
  readonly vocabulary: readonly string[];
}): StarterCheck;
```

`apps/worker/src/tools/starter.ts`

```ts
export function refusedCheckLog(
  tool: string,
  stage: StarterCheckStage,
  problems: readonly string[],
): string;
```

`apps/worker/src/tools/sandbox-build.ts`

```ts
export async function descriptorTestSummary(
  files: readonly Pick<ArtifactFile, "path" | "absolutePath">[],
): Promise<TaskDescriptorDto["testSummary"] | undefined>;
```

`TaskDescriptorDto` comes from `@sandbox-factory/shared`. To carry the
summary, `BuildOutput` and `StarterOutput` in `@sandbox-factory/db` each gain
one optional field: `readonly testSummary?: readonly { label: string; count: number }[]`.
How the database layer stores it on the version is outside this spec.

These keep their current behaviour unless a rule below changes it:
`checkStarter`'s problems (their text, their order, the 40-problem cap and
which stage runs first), `STARTER_CHECKS_MAX`, `STARTER_RUNS_MAX`,
`STEP_OUTPUT_CHARS`, `STARTER_SET_PATH`, `createStarterAdapter` (except for
step lines, log lines and `committed`), `createSandboxBuildAdapter` (except
for `committed`), `writeBuildOutputs`, `previewProject`, `baselineOf`,
`reportedBaselineOf`, `privateTestOutcome`, `tapPoints` and
`buildArtifactKind`. Tool result `content` sent to the agent does not
change: a refused check is still its problems joined by `"\n"`, and it
still has `isError: true`.

The constant `HIDDEN_TEST_MARK` used below means `"tests/private/"`
(`PRIVATE_TESTS_DIR` followed by `/`).

```gherkin
Feature: Refused starter checks name their stage, and builds record their test counts

  Background:
    Given "the cart starter" is the starter fixture from apps/worker/test/starter.test.ts:
      | part        | value                                                                        |
      | files       | src/cart.ts exporting interface AcmeLine and function acmeTotal              |
      | publicTests | tests/public/cart.test.ts importing acmeTotal                                |
      | hiddenTests | tests/private/total.test.ts importing acmeTotal, expectedBaseline "fail"     |
      | packages    | none                                                                         |
      | scenario    | imports acmeTotal from "../src/cart.js" and logs acmeTotal([])               |
      | aliases     | AcmeLine -> Line (identifier), acmeTotal -> total (identifier)               |
      | summary     | "A cart whose total is left to write."                                       |
    And checkStarter is called with any absolute root, version "Sum a cart" (sbv_1), spec null and vocabulary ["acme"]

  Rule: A refused check names the first stage that refused it, in the order rules, names, project, types

    Workspace-name leaks in public files are found with the project's
    blockers. When there are leaks but no project blockers, the stage is
    "names". When there is at least one project blocker, the stage is
    "project", and its problems hold the blockers followed by the leaks.

    @happy
    Scenario: A starter that passes every stage has no stage
      When checkStarter checks the cart starter
      Then the result has ok true and problems []
      And the result has no "stage" key

    @unhappy
    Scenario Outline: Each stage refuses with its own problems
      When checkStarter checks the cart starter changed by <change>
      Then the result has ok false and stage "<stage>"
      And its problems are <problems>

      Examples:
        | change                                                                                                    | stage   | problems                                                                                     |
        | aliases []                                                                                                | rules   | a list whose first entry matches /needs a name table/                                         |
        | files [{ path "lib/cart.ts", text "" }] and scenario 'import "../src/missing.js";\n'                       | rules   | ["lib/cart.ts: source files live under src/."]                                               |
        | aliases [Globex -> Vendor, identifier]                                                                     | names   | ["Name 1: Globex does not occur in the starter, so it renames nothing."]                     |
        | aliases [AcmeLine -> Line] only and scenario 'import "../src/missing.js";\n'                              | project | ["sandbox/run.ts: ../src/missing.js does not resolve to a file in the project.", "src/cart.ts: \"acme\" names the workspace and appears 3 times in 2 public files: src/cart.ts, tests/public/cart.test.ts. Give it a pseudonym."] |
        | files [src/cart.ts "export const acmeTotal: number = 'no';\n"] and aliases [acmeTotal -> total] only     | types   | a list with an entry starting "src/cart.ts:1 TS2322"                                         |

    @unhappy
    Scenario: A workspace name left in a public file, with no other project problem, stops at the names stage
      When checkStarter checks the cart starter with vocabulary ["acme"] and aliases [AcmeLine -> Line] only
      Then the result has ok false and stage "names"
      And every problem matches /"acme" names the workspace/
      And no problem is a compiler diagnostic (none matches /^\S+:\d+ TS\d+ /)

    @boundary
    Scenario: A stage's problems are still capped at 40
      Given the cart starter with 45 source files at lib/a1.ts through lib/a45.ts
      When checkStarter checks it
      Then the result has ok false and stage "rules"
      And it has exactly 40 problems, the first 40 the rules give in their order

  Rule: refusedCheckLog writes a header line, then the problems that are not a hidden test's, then a count of those that are

    The header is "<tool> refused (<stage>): <n> problem." when <n> is 1,
    and "<tool> refused (<stage>): <n> problems." otherwise (0 included),
    where <n> is the number of problems given, hidden ones included. A
    problem is a hidden test's when it starts with HIDDEN_TEST_MARK. Then
    come the first 10 problems that are not a hidden test's, in the order
    given, each on its own line prefixed by two spaces; a problem longer
    than 300 characters is cut to its first 300 characters followed by "…".
    When more than 10 such problems are given, a line "  and <m> more"
    follows, where <m> is how many were left out. Last, only when at least
    one problem is a hidden test's, comes "  and <h> in hidden tests, not shown".
    Lines are joined with "\n" and there is no trailing newline. Problems
    are not deduplicated. The tool name is written as given and is not checked.

    @happy
    Scenario: A rules refusal with one problem
      When refusedCheckLog("check_starter", "rules", ["lib/cart.ts: source files live under src/."]) is called
      Then it returns:
        """
        check_starter refused (rules): 1 problem.
          lib/cart.ts: source files live under src/.
        """

    @happy
    Scenario: A hidden test's problem is counted but not shown
      When refusedCheckLog is called with tool "submit_starter", stage "types" and problems:
        | problem                                                                              |
        | src/cart.ts:1 TS2322 Type 'string' is not assignable to type 'number'.               |
        | tests/private/total.test.ts:3 TS2305 Module '"../../src/cart.js"' has no exported member 'sum'. |
        | (project) TS5023 Unknown compiler option 'x'.                                        |
      Then it returns:
        """
        submit_starter refused (types): 3 problems.
          src/cart.ts:1 TS2322 Type 'string' is not assignable to type 'number'.
          (project) TS5023 Unknown compiler option 'x'.
          and 1 in hidden tests, not shown
        """

    @boundary
    Scenario Outline: A problem is a hidden test's only when it starts with "tests/private/"
      When refusedCheckLog("run_starter", "rules", ["<problem>"]) is called
      Then the problem is <shown>

      Examples:
        | problem                                                                     | shown     |
        | tests/private/total.test.ts is longer than 20000 characters.                | not shown |
        | lib/x.test.ts: hidden tests live under tests/private/ and end in .test.ts. | shown     |
        | src/a.ts and tests/private/A.ts differ only in case.                        | shown     |
        | At least one hidden test must fail on the starter: it is how a finished bounty is told apart from an unfinished one. | shown |
        | tests/public/cart.test.ts is given twice.                                   | shown     |

    @boundary
    Scenario: Every problem is a hidden test's
      When refusedCheckLog("check_starter", "types", ["tests/private/a.test.ts:1 TS2304 Cannot find name 'x'.", "tests/private/b.test.ts:2 TS2304 Cannot find name 'y'."]) is called
      Then it returns:
        """
        check_starter refused (types): 2 problems.
          and 2 in hidden tests, not shown
        """

    @boundary
    Scenario: No problems gives the header alone
      When refusedCheckLog("check_starter", "names", []) is called
      Then it returns "check_starter refused (names): 0 problems."

    @boundary
    Scenario Outline: A long problem is cut after 300 characters
      When refusedCheckLog("check_starter", "rules", [<problem>]) is called
      Then its second line is <line>

      Examples:
        | problem              | line                                      |
        | "a" repeated 300 times | "  " followed by "a" repeated 300 times |
        | "a" repeated 301 times | "  " followed by "a" repeated 300 times and "…" |

    @boundary
    Scenario: At most 10 shown problems, then how many more
      When refusedCheckLog("check_starter", "rules", ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11", "p12", "tests/private/a.test.ts: x"]) is called
      Then it returns:
        """
        check_starter refused (rules): 13 problems.
          p1
          p2
          p3
          p4
          p5
          p6
          p7
          p8
          p9
          p10
          and 2 more
          and 1 in hidden tests, not shown
        """

  Rule: Each starter tool a check refuses writes refusedCheckLog to the run log, and its step line names the stage

    check_starter, run_starter and submit_starter each call input.log once
    with refusedCheckLog(<their own tool name>, stage, problems), using the
    stage and problems from checkStarter. They do this when the check
    refuses, and only then. A run_starter or submit_starter that a check
    refuses starts no evaluation job and uses up no run, as now.
    The step line (`describe`) is "<verb> the starter: <phrase>", where
    <verb> is "Checked", "Ran" or "Submitted" and <phrase> depends on the stage:
      | stage   | phrase                              |
      | rules   | its files break the starter's rules |
      | names   | its names need fixing               |
      | project | its project does not generate yet   |
      | types   | it does not compile yet             |
    A check_starter call that fails schema validation gets the step line
    "Checked the starter: it was refused", and a check_starter call after
    STARTER_CHECKS_MAX gets no step line (describe returns null); neither
    writes a log line. A run_starter or submit_starter call that fails
    schema validation still gets "<verb> the starter: it does not build yet"
    and writes no log line. A check_starter call that passes still gets
    "Checked the starter: <n> files compile". run_starter and submit_starter
    step lines for a baseline, and for "No runs are left", do not change.

    @unhappy
    Scenario: check_starter before any pseudonyms are set stops at rules
      Given a starter run whose agent's first call is check_starter with the cart starter's candidate and no set_pseudonyms call before it
      When the run proceeds
      Then the agent gets is_error true with content matching /needs a name table/
      And the step line for the call is "Checked the starter: its files break the starter's rules"
      And the run log contains an entry starting "check_starter refused (rules): 1 problem.\n  A starter needs a name table"

    @unhappy
    Scenario Outline: The step line for a refused check names its stage, whichever tool ran it
      Given pseudonyms were set to the cart starter's aliases
      When the agent calls <tool> with the cart starter changed by <change>
      Then the step line for the call is "<line>"
      And the run log has one entry starting "<tool> refused (<stage>):"
      And the evaluation provider created no job for the call

      Examples:
        | tool           | change                                                         | stage   | line                                                       |
        | check_starter  | files [{ path "lib/cart.ts", text "" }]                        | rules   | Checked the starter: its files break the starter's rules   |
        | run_starter    | scenario 'import "../src/missing.js";\n'                       | project | Ran the starter: its project does not generate yet         |
        | submit_starter | files add src/a.ts "export const a: number = 'x';"             | types   | Submitted the starter: it does not compile yet             |

    @unhappy
    Scenario: Pseudonyms that rename nothing stop at names
      Given pseudonyms were set to [Globex -> Vendor, identifier]
      When the agent calls check_starter with the cart starter's candidate
      Then the step line is "Checked the starter: its names need fixing"
      And the run log has an entry equal to "check_starter refused (names): 1 problem.\n  Name 1: Globex does not occur in the starter, so it renames nothing."

    @unhappy
    Scenario: A hidden test that does not compile is counted in the log but shown to the agent
      Given pseudonyms were set to the cart starter's aliases
      When the agent calls check_starter with the cart starter whose hidden test imports "sum" from "../../src/cart.js"
      Then the agent's content contains a problem starting "tests/private/total.test.ts:"
      And the run log entry for the call ends with "in hidden tests, not shown"
      And no run log entry contains "tests/private/total.test.ts:"

    @boundary
    Scenario: Calls that never reach the check write no log
      Given pseudonyms were set to the cart starter's aliases
      When the agent calls check_starter with packages "none"
      And the agent calls check_starter STARTER_CHECKS_MAX + 1 more times with the cart starter's candidate
      Then the schema-invalid call gets the step line "Checked the starter: it was refused"
      And the call after the limit gets a null step line
      And no run log entry contains "refused (" for either of them

    @boundary
    Scenario: A schema-invalid run_starter keeps its old step line
      Given pseudonyms were set to the cart starter's aliases
      When the agent calls run_starter with packages "none"
      Then the step line for the call is "Ran the starter: it does not build yet"
      And no run log entry contains "refused (" for it

    @concurrency
    Scenario: Two checks in one turn each name their own stage, in call order
      Given pseudonyms were set to the cart starter's aliases
      When one agent turn holds two check_starter calls: first with files [{ path "lib/cart.ts", text "" }], then with files [src/cart.ts "export const acmeTotal: number = 'no';\n"]
      Then the calls run one after the other, in the order given
      And the step lines are, in order:
        | Checked the starter: its files break the starter's rules |
        | Checked the starter: it does not compile yet             |
      And the two refusal log entries appear in the same order, starting "check_starter refused (rules):" and then "check_starter refused (types):"

  Rule: descriptorTestSummary reads testSummary from the build's descriptor, and returns undefined if it cannot

    It looks only at the first entry whose path is exactly
    "project/sandbox-task.json" (`project/` followed by TASK_DESCRIPTOR_PATH).
    It reads that entry's absolutePath as UTF-8 and parses it as JSON. It
    checks only the `testSummary` property, against the taskDescriptorSchema's
    testSummary schema (an array of { label: string, count: integer }), not
    the rest of the descriptor. It returns the parsed array, keeping the
    descriptor's entry order and dropping any keys other than label and count.
    It returns undefined, and does not throw, when no entry has that path,
    when the file cannot be read, when it is not JSON, or when testSummary is
    missing or does not match the schema.

    @happy
    Scenario: A built descriptor's summary is returned as written
      Given a file at <tmp>/project/sandbox-task.json holding a descriptor with testSummary [{ "label": "public", "count": 2 }, { "label": "scenarios", "count": 1 }]
      When descriptorTestSummary([{ path: "build-manifest.json", absolutePath: <manifest> }, { path: "project/sandbox-task.json", absolutePath: <tmp>/project/sandbox-task.json }]) is called
      Then it resolves to [{ label: "public", count: 2 }, { label: "scenarios", count: 1 }]

    @boundary
    Scenario Outline: What the descriptor holds decides the result
      Given the entry "project/sandbox-task.json" points at a file holding <text>
      When descriptorTestSummary is called with that entry
      Then it resolves to <result>

      Examples:
        | text                                                                   | result                           |
        | {"testSummary":[]}                                                     | []                               |
        | {"testSummary":[{"label":"public","count":1,"extra":true}]}            | [{ label: "public", count: 1 }]  |
        | {"title":"x"}                                                          | undefined                        |
        | {"testSummary":{"public":1}}                                           | undefined                        |
        | {"testSummary":[{"label":"public","count":1.5}]}                       | undefined                        |
        | {"testSummary":[{"label":"public","count":"2"}]}                       | undefined                        |
        | {"testSummary":[{"label":"public","count":1},{"count":2}]}             | undefined                        |
        | not json                                                               | undefined                        |
        | null                                                                   | undefined                        |

    @unhappy
    Scenario Outline: Without a readable descriptor entry there is no summary
      When descriptorTestSummary is called with <files>
      Then it resolves to undefined

      Examples:
        | files                                                                                 |
        | []                                                                                    |
        | [{ path: "sandbox-task.json", absolutePath: <a valid descriptor> }]                   |
        | [{ path: "project/sub/sandbox-task.json", absolutePath: <a valid descriptor> }]       |
        | [{ path: "project/sandbox-task.json", absolutePath: <tmp>/missing.json }]             |

    @boundary
    Scenario: Only the first matching entry is read
      Given two entries with path "project/sandbox-task.json", the first holding testSummary [{ "label": "public", "count": 1 }] and the second [{ "label": "public", "count": 9 }]
      When descriptorTestSummary is called with both
      Then it resolves to [{ label: "public", count: 1 }]

    @concurrency
    Scenario: Overlapping calls on the same files agree
      Given the entry "project/sandbox-task.json" holds testSummary [{ "label": "public", "count": 2 }]
      When descriptorTestSummary is called twice with it, without waiting for the first call to resolve
      Then both calls resolve to [{ label: "public", count: 2 }]

  Rule: committed passes the descriptor's summary on with what it already records, when there is one

    A build's committed adds `testSummary: <descriptorTestSummary(files)>`
    to the output it gives recordBuildOutput, which still happens only for a
    ready manifest. A starter's committed adds the same key to the output it
    gives recordStarterOutput, as a top-level key outside `build`, whether or
    not the build is ready. When descriptorTestSummary returns undefined, the
    key is left out, not set to undefined. Nothing else in either output changes.

    @happy
    Scenario: A starter run records its descriptor's counts on commit
      Given the starter agent sets the cart starter's pseudonyms, checks, runs and submits it, and the baseline passes
      When committed is called with runId "arn_starter" and the run's files
      Then recordStarterOutput is called once with versionId "sbv_1", runId "arn_starter" and an output that adds, to the keys it holds today,
        | key         | value                                                               |
        | testSummary | [{ label: "public", count: 1 }, { label: "scenarios", count: 0 }]   |

    @happy
    Scenario: A starter kept as not ready still records its counts
      Given a starter run whose submissions fail the baseline until the runs are spent
      When committed is called with the run's files
      Then the recorded output has build null
      And it has testSummary [{ label: "public", count: 1 }, { label: "scenarios", count: 0 }]

    @happy
    Scenario: A ready build records its descriptor's counts with its harness
      Given a sandbox build run that ends ready
      When committed is called with runId "arn_build" and the run's files
      Then recordBuildOutput is called once with an output holding harnessSha256, toolchainDigest, any transform as today
      And testSummary equal to the testSummary parsed from the run's "project/sandbox-task.json"

    @unhappy
    Scenario: A build that is not ready records nothing, counts included
      Given a sandbox build run that ends with a blocker
      When committed is called with the run's files
      Then recordBuildOutput is not called

    @boundary
    Scenario Outline: Without the descriptor among the files, the key is left out
      Given a <run> run that ends ready
      When committed is called with the run's files except "project/sandbox-task.json"
      Then <record> is called with an output that has no "testSummary" key
      And the rest of the output is what it would have been with the descriptor

      Examples:
        | run           | record              |
        | sandbox build | recordBuildOutput   |
        | starter       | recordStarterOutput |
```

## Decided:

- The `stage` of an `ok: false` check is the first stage that refused it. A check never reports more than one stage.
  Ticket: "A refused starter check says where it stopped (rules, names, project, types)"
  Instead: list every stage that would fail, which would mean running later stages on input an earlier stage refused.
- Workspace-name leaks alone stop at the `names` stage; when the project also has a generation blocker, the stage is `project` and its problems hold the blockers, then the leaks.
  Ticket: silent.
  Instead: count leaks as `project` always, or add a separate `vocabulary` stage, which the ticket's stage list does not have.
- The log text is a header "`<tool>` refused (`<stage>`): `<n>` problem." ("problems." when `<n>` is not 1), then the shown problems one per line, each prefixed by two spaces, then "  and `<m>` more" when shown problems were left out, then "  and `<h>` in hidden tests, not shown", joined with "\n".
  Ticket: "the run log keeps its problems, counting a hidden test's without showing them"
  Instead: one log line per problem, or a single line that joins the problems with "; ".
- A problem is a hidden test's only when it starts with "tests/private/"; one that names that path elsewhere is shown.
  Ticket: "counting a hidden test's without showing them"
  Instead: count any problem that contains "tests/private/" anywhere.
- `<n>` counts every problem passed in, hidden ones included, and the hidden line appears only when `<h>` > 0.
  Ticket: "counting a hidden test's without showing them"
  Instead: count only the shown problems, and always print the hidden count, even when it is 0.
- refusedCheckLog shows at most 10 problems, then "  and `<m>` more", and cuts a problem longer than 300 characters to its first 300 followed by "…". It does not deduplicate.
  Ticket: silent.
  Instead: show every problem uncut, leaving checkStarter's cap of 40 as the only limit.
- run_starter and submit_starter write the refusal log and the stage step line too, under their own tool names.
  Ticket: "A refused starter check says where it stopped … instead of always \"does not compile\""
  Instead: change only check_starter and keep "it does not build yet" for run and submit refusals.
- The step phrases are: rules "its files break the starter's rules", names "its names need fixing", project "its project does not generate yet", types "it does not compile yet".
  Ticket: silent.
  Instead: put the bare stage name in the line, e.g. "Checked the starter: refused at names".
- A schema-invalid check_starter call gets "Checked the starter: it was refused", a check_starter call after the limit gets a null step line, and a schema-invalid run_starter or submit_starter keeps "<verb> the starter: it does not build yet"; none of them writes a log line.
  Ticket: silent.
  Instead: give them all a null step line, or keep the old "does not compile yet" line for check_starter.
- Tool content sent to the agent does not change: hidden-test problems are still shown to the agent, which wrote them.
  Ticket: silent.
  Instead: start the content with the stage as well.
- descriptorTestSummary returns the whole testSummary (the "public" and "scenarios" entries) in the descriptor's order, not only the "public" entry.
  Ticket: "A build or starter run records the descriptor's public test counts on the version."
  Instead: return only the entry labelled "public".
- descriptorTestSummary reads only the first entry at exactly "project/sandbox-task.json", and checks only testSummary, not the rest of the descriptor.
  Ticket: silent.
  Instead: parse the whole descriptor with taskDescriptorSchema and reject it if any field is wrong.
- descriptorTestSummary never throws. A missing, unreadable, non-JSON or malformed descriptor gives undefined.
  Ticket: silent.
  Instead: throw (for example AnalysisError "tool_failed") the way committed does for a missing or unreadable manifest.
- Entries keep only label and count. Counts must be integers, and negative integers are allowed, as the shared schema allows them.
  Ticket: silent.
  Instead: reject an entry that has extra keys, or a count below zero.
- A build records the summary only when it is ready, because committed records nothing for a build that is not ready. A starter records it whether or not it is ready, as a top-level key outside `build`.
  Ticket: "A build or starter run records the descriptor's public test counts on the version."
  Instead: record the counts for every committed build, or put the starter's counts inside `build`.
- When there is no summary, the `testSummary` key is left out of the recorded output, not set to undefined or [].
  Ticket: silent.
  Instead: record testSummary as [] when the descriptor is missing.
