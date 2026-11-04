import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StoredVersionWithSource } from "@sandbox-factory/db";
import type {
  EvaluationCommand,
  EvaluationExecResult,
  EvaluationProvider,
  SandboxBuildManifest,
  StarterSubmission,
} from "sandbox-factory";
import type { AgentModel, AgentTurn } from "../../src/agent/loop.js";
import { AnalysisError } from "../../src/errors.js";
import type { ArtifactFile, ToolInputs } from "../../src/tools/adapter.js";
import {
  STARTER_CHECKS_MAX,
  STARTER_RUNS_MAX,
  createStarterAdapter,
} from "../../src/tools/starter.js";

const stamp = "2026-10-05T00:00:00.000Z";
const limits = { maxTurns: 60, maxTokens: 1_000_000 };

/** The cart starter, as in starter.test.ts. */
const starter: Omit<StarterSubmission, "summary"> = {
  files: [
    {
      path: "src/cart.ts",
      text: [
        "export interface AcmeLine { readonly price: number; readonly quantity: number }",
        "/** What the cart comes to. TODO: the bounty: sum each line's price times quantity. */",
        "export function acmeTotal(lines: readonly AcmeLine[]): number {",
        "  return lines.length === 0 ? 0 : Number.NaN;",
        "}",
        "",
      ].join("\n"),
    },
  ],
  publicTests: [
    {
      path: "tests/public/cart.test.ts",
      text: [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { acmeTotal } from "../../src/cart.js";',
        'test("an empty cart is free", () => assert.equal(acmeTotal([]), 0));',
        "",
      ].join("\n"),
    },
  ],
  hiddenTests: [
    {
      path: "tests/private/total.test.ts",
      text: [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { acmeTotal } from "../../src/cart.js";',
        'test("lines add up", () => assert.equal(acmeTotal([{ price: 2, quantity: 3 }]), 6));',
        "",
      ].join("\n"),
      expectedBaseline: "fail",
    },
  ],
  packages: [],
  scenario:
    'import { acmeTotal } from "../src/cart.js";\nconsole.log(acmeTotal([]));\n',
  aliases: [
    { before: "AcmeLine", after: "Line", kind: "identifier", paths: [] },
    { before: "acmeTotal", after: "total", kind: "identifier", paths: [] },
  ],
};
const submission: StarterSubmission = {
  ...starter,
  summary: "A cart whose total is left to write.",
};
const { aliases: pseudonyms, ...candidate } = starter;
const { aliases: _pseudonyms, ...submitted } = submission;
const [, totalAlias] = submission.aliases as [
  StarterSubmission["aliases"][number],
  StarterSubmission["aliases"][number],
];
const hiddenTest = starter
  .hiddenTests[0] as StarterSubmission["hiddenTests"][number];
const cartFile = starter.files[0] as StarterSubmission["files"][number];

const missingImport = 'import "../src/missing.js";\n';
const MISSING =
  "sandbox/run.ts: ../src/missing.js does not resolve to a file in the project.";
const NAME_TABLE =
  "A starter needs a name table: at least one name from the bounty's own vocabulary, and the neutral name contributors read instead.";
const ACME_IN_CART =
  'src/cart.ts: "acme" names the workspace and appears 2 times in 1 public file: src/cart.ts. Give it a pseudonym.';
const MUST_FAIL =
  "At least one hidden test must fail on the starter: it is how a finished bounty is told apart from an unfinished one.";
const A_TS = "src/a.ts:1 TS2322 Type 'string' is not assignable to type 'number'.";
const SUM_TS =
  "tests/private/total.test.ts:3 TS2305 Module '\"../../src/cart.js\"' has no exported member 'sum'.";
const GLOBEX =
  "Name 1: Globex does not occur in the starter, so it renames nothing.";

/** Changes to the cart candidate, one per stage, all past the tools' schema. */
const atRulesTwice = {
  ...candidate,
  files: [cartFile, cartFile],
};
const atRulesHiddenPasses = {
  ...candidate,
  hiddenTests: [{ ...hiddenTest, expectedBaseline: "pass" as const }],
};
const atRulesHiddenPath = {
  ...candidate,
  hiddenTests: [{ ...hiddenTest, path: "tests/private/total.ts" }],
};
const atProject = { ...candidate, scenario: missingImport };
const atTypes = {
  ...candidate,
  files: [cartFile, { path: "src/a.ts", text: "export const a: number = 'x';" }],
};
const hiddenSum = {
  ...hiddenTest,
  text: [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { sum } from "../../src/cart.js";',
    'test("lines add up", () => assert.equal(sum([{ price: 2, quantity: 3 }]), 6));',
    "",
  ].join("\n"),
};
const atTypesHidden = { ...candidate, hiddenTests: [hiddenSum] };
const submittedAs = (changed: Omit<StarterSubmission, "aliases" | "summary">) => ({
  ...changed,
  summary: submission.summary,
});

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
let calls = 0;
const call = (name: string, input: unknown) => ({
  type: "tool_use",
  id: `${name}-${(calls += 1)}`,
  name,
  input,
});
const turn = (content: unknown[], stopReason = "tool_use"): AgentTurn => ({
  content: content as AgentTurn["content"],
  stopReason,
  usage,
});
const setPseudonyms = (aliases: unknown = pseudonyms) =>
  turn([call("set_pseudonyms", { aliases })]);
function scripted(turns: AgentTurn[]): AgentModel & {
  results: { content: string; is_error?: boolean }[][];
} {
  const results: { content: string; is_error?: boolean }[][] = [];
  return {
    model: "test-model",
    results,
    async turn(request) {
      const last = request.messages.at(-1);
      if (request.messages.length > 1 && Array.isArray(last?.content))
        results.push(
          last.content as unknown as { content: string; is_error?: boolean }[],
        );
      return turns.shift() ?? turn([], "refusal");
    },
  };
}

const TAP_FAILED = {
  exitCode: 1,
  stdout:
    "TAP version 13\nnot ok 1 - fails\n  failureType: 'testCodeFailure'\n1..1\n# tests 1\n# pass 0\n# fail 1\n",
};
function fakeProvider(
  script: (argv: readonly string[]) => Partial<EvaluationExecResult> = (
    argv,
  ) => (argv.some((arg) => arg.startsWith("tests/private/")) ? TAP_FAILED : {}),
) {
  let jobs = 0;
  const provider: EvaluationProvider = {
    name: "fake",
    async create() {
      jobs += 1;
      return {
        id: `job_${jobs}`,
        environment: {
          provider: "fake",
          environmentId: null,
          templateDigest: null,
        },
        async stage() {},
        async exec(command: EvaluationCommand) {
          return {
            exitCode: 0,
            timedOut: false,
            outputTruncated: false,
            stdout: "",
            stderr: "",
            durationMs: 1,
            ...script(command.argv),
          };
        },
        async read(path) {
          return path === "package-lock.json" ? '{"lockfileVersion":3}' : null;
        },
        async destroy() {},
      };
    },
  };
  return { provider, jobs: () => jobs };
}

const stored: StoredVersionWithSource = {
  version: {
    id: "sbv_1",
    sandboxId: "sbx_1",
    version: 1,
    title: "Sum a cart",
    specSummary: "The cart adds up its lines.",
    complexity: "S",
    tags: [],
    testSummary: [],
    publicBaseCommitSha: null,
    readme: null,
    languages: null,
    frozenAt: null,
    createdAt: stamp,
  },
  source: {
    sandboxVersionId: "sbv_1",
    origin: "starter",
    sourceSnapshotId: null,
    sourceCommitSha: null,
    sliceRunId: null,
    manifestSha256: null,
    contractSha256: null,
    starterRunId: "arn_starter",
    starterSha256: null,
    transformConfigSha256: "t".repeat(64),
    approvedTaskSha256: "a".repeat(64),
    proposalVersion: 1,
    contextVersions: { jira: null, github: null },
    approvedTask: {
      schemaVersion: 3,
      title: "Sum a cart",
      summary: "The cart adds up its lines: price times quantity.",
      spec: null,
      pricing: null,
      selectedBy: "user_1",
      selectedAt: stamp,
      bountyId: "bty_1",
    },
    aliasRules: [],
    dependencyChoices: {},
    acceptanceTests: [],
    fixtures: null,
    scope: {
      editablePaths: [],
      generatedPaths: [],
      permittedOperations: ["edit", "add"],
      dependencies: [],
      blockers: [],
    },
    harnessSha256: null,
    toolchainDigest: null,
    buildRunId: "arn_starter",
    roundTripRunId: null,
    disclosureRunId: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  },
};
const params = {
  deadlineMinutes: 60,
  agent: "starter" as const,
  sandboxVersionId: "sbv_1",
  approvedTaskSha256: "a".repeat(64),
  stack: ["TypeScript"],
  vocabulary: ["acme"],
};
interface Recorded {
  readonly versionId: string;
  readonly runId: string;
  readonly output: Record<string, unknown>;
}
function inputs(recorded: Recorded[] = []): ToolInputs {
  return {
    getRun: async () => null,
    listArtifacts: async () => [],
    readArtifact: async () => undefined,
    getVersion: async (id) => (id === "sbv_1" ? stored : null),
    getTask: async () => null,
    recordBuildOutput: async () => false,
    recordStarterOutput: async (versionId, runId, output) => {
      recorded.push({
        versionId,
        runId,
        output: output as unknown as Record<string, unknown>,
      });
      return true;
    },
  };
}
const isCode = (code: string) => (error: unknown) =>
  error instanceof AnalysisError && error.code === code;

interface Tagged {
  readonly turn: number;
  readonly text: string;
}

/**
 * A starter run whose agent makes the given turns and never has a
 * submission accepted; its step and log lines, each tagged with the index
 * of the agent turn it came in.
 */
async function refusedRun(turns: AgentTurn[], fake = fakeProvider()) {
  const model = scripted(turns);
  const steps: Tagged[] = [];
  const lines: Tagged[] = [];
  const adapter = createStarterAdapter({
    agent: { model, limits },
    provider: fake.provider,
    now: () => new Date(stamp),
  });
  const out = await mkdtemp(join(tmpdir(), "hidden-touched-starter-"));
  try {
    await assert.rejects(
      adapter.run({
        sourceDir: out,
        outDir: join(out, "out"),
        params: params as never,
        run: null,
        inputs: inputs(),
        signal: new AbortController().signal,
        log: (text) => lines.push({ turn: model.results.length, text }),
        step: (text) => steps.push({ turn: model.results.length, text }),
      }),
      isCode("agent_incomplete"),
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  const at = (list: Tagged[], index: number) =>
    list.filter((item) => item.turn === index).map((item) => item.text);
  return {
    model,
    jobs: fake.jobs,
    stepsAt: (index: number) => at(steps, index),
    linesAt: (index: number) => at(lines, index),
    lines: lines.map((item) => item.text),
    /** The result of the first call in the turn at `index`. */
    resultAt: (index: number) => model.results[index]?.[0],
  };
}
const refusals = (lines: readonly string[]) =>
  lines.filter((line) => line.includes(" refused ("));

// --- Step lines and the run log ---

// Extends "[happy-1] a starter that passes every stage ...": in the adapter,
// a passing check after a refused one has the compile step line and no refusal entry.
test("[happy-1] a check that passes after a refused one gets the compile line and writes no refusal", async () => {
  const run = await refusedRun([
    turn([call("check_starter", candidate)]),
    setPseudonyms(),
    turn([call("check_starter", candidate)]),
  ]);
  assert.deepEqual(run.stepsAt(0), [
    "Checked the starter: its files break the starter's rules",
  ]);
  assert.deepEqual(refusals(run.linesAt(0)), [
    `check_starter refused (rules): 1 problem.\n  ${NAME_TABLE}`,
  ]);
  assert.equal(run.resultAt(2)?.is_error, undefined);
  assert.deepEqual(run.stepsAt(2), ["Checked the starter: 3 files compile"]);
  assert.deepEqual(refusals(run.linesAt(2)), []);
});

// Extends "[unhappy-3] check_starter before any pseudonyms are set stops at rules":
// the exact log entry, and what the agent is sent.
test("[unhappy-3] check_starter before any pseudonyms logs exactly the name-table problem and sends it to the agent", async () => {
  const run = await refusedRun([turn([call("check_starter", candidate)])]);
  assert.equal(run.resultAt(0)?.is_error, true);
  assert.equal(run.resultAt(0)?.content, NAME_TABLE);
  assert.deepEqual(refusals(run.lines), [
    `check_starter refused (rules): 1 problem.\n  ${NAME_TABLE}`,
  ]);
});

test("[unhappy-3] run_starter before any pseudonyms stops at rules under its own name and starts no job", async () => {
  const run = await refusedRun([turn([call("run_starter", candidate)])]);
  assert.equal(run.resultAt(0)?.is_error, true);
  assert.equal(run.resultAt(0)?.content, NAME_TABLE);
  assert.deepEqual(run.stepsAt(0), [
    "Ran the starter: its files break the starter's rules",
  ]);
  assert.deepEqual(refusals(run.lines), [
    `run_starter refused (rules): 1 problem.\n  ${NAME_TABLE}`,
  ]);
  assert.equal(run.jobs(), 0);
});

test("[unhappy-3] submit_starter before any pseudonyms stops at rules under its own name and starts no job", async () => {
  const run = await refusedRun([turn([call("submit_starter", submitted)])]);
  assert.deepEqual(run.stepsAt(0), [
    "Submitted the starter: its files break the starter's rules",
  ]);
  assert.deepEqual(refusals(run.lines), [
    `submit_starter refused (rules): 1 problem.\n  ${NAME_TABLE}`,
  ]);
  assert.equal(run.jobs(), 0);
});

test("[unhappy-3] check_starter with no pseudonyms and a repeated file logs both rules problems in order", async () => {
  const run = await refusedRun([turn([call("check_starter", atRulesTwice)])]);
  assert.equal(
    run.resultAt(0)?.content,
    `src/cart.ts is given twice.\n${NAME_TABLE}`,
  );
  assert.deepEqual(refusals(run.lines), [
    `check_starter refused (rules): 2 problems.\n  src/cart.ts is given twice.\n  ${NAME_TABLE}`,
  ]);
});

// Extends "[unhappy-4] ... refused at rules/project/types ...": every stage under
// every tool, with the exact log entry the check's problems give.
const stageCases: {
  readonly tool: "check_starter" | "run_starter" | "submit_starter";
  readonly input: unknown;
  readonly line: string;
  readonly log: string;
  readonly aliases?: unknown;
}[] = [
  {
    tool: "check_starter",
    input: atProject,
    line: "Checked the starter: its project does not generate yet",
    log: `check_starter refused (project): 1 problem.\n  ${MISSING}`,
  },
  {
    tool: "check_starter",
    input: atTypes,
    line: "Checked the starter: it does not compile yet",
    log: `check_starter refused (types): 1 problem.\n  ${A_TS}`,
  },
  {
    tool: "check_starter",
    input: atRulesHiddenPasses,
    line: "Checked the starter: its files break the starter's rules",
    log: `check_starter refused (rules): 1 problem.\n  ${MUST_FAIL}`,
  },
  {
    tool: "check_starter",
    input: candidate,
    aliases: [totalAlias],
    line: "Checked the starter: its names need fixing",
    log: `check_starter refused (names): 1 problem.\n  ${ACME_IN_CART}`,
  },
  {
    tool: "run_starter",
    input: atRulesTwice,
    line: "Ran the starter: its files break the starter's rules",
    log: "run_starter refused (rules): 1 problem.\n  src/cart.ts is given twice.",
  },
  {
    tool: "run_starter",
    input: atTypes,
    line: "Ran the starter: it does not compile yet",
    log: `run_starter refused (types): 1 problem.\n  ${A_TS}`,
  },
  {
    tool: "run_starter",
    input: candidate,
    aliases: [totalAlias],
    line: "Ran the starter: its names need fixing",
    log: `run_starter refused (names): 1 problem.\n  ${ACME_IN_CART}`,
  },
  {
    tool: "submit_starter",
    input: submittedAs(atProject),
    line: "Submitted the starter: its project does not generate yet",
    log: `submit_starter refused (project): 1 problem.\n  ${MISSING}`,
  },
  {
    tool: "submit_starter",
    input: submittedAs(atRulesHiddenPasses),
    line: "Submitted the starter: its files break the starter's rules",
    log: `submit_starter refused (rules): 1 problem.\n  ${MUST_FAIL}`,
  },
  {
    tool: "submit_starter",
    input: submitted,
    aliases: [totalAlias],
    line: "Submitted the starter: its names need fixing",
    log: `submit_starter refused (names): 1 problem.\n  ${ACME_IN_CART}`,
  },
];
for (const item of stageCases)
  test(`[unhappy-4] ${item.tool} refused with "${item.line}" logs exactly its refusal once and starts no job`, async () => {
    const run = await refusedRun([
      setPseudonyms(item.aliases ?? pseudonyms),
      turn([call(item.tool, item.input)]),
    ]);
    assert.equal(run.resultAt(1)?.is_error, true);
    assert.deepEqual(run.stepsAt(1), [item.line]);
    assert.deepEqual(refusals(run.linesAt(1)), [item.log]);
    assert.deepEqual(refusals(run.lines), [item.log]);
    assert.equal(run.jobs(), 0);
  });

// Extends "[unhappy-4] a run_starter refused at project ... starts no job":
// refused runs use up no run, however many there are.
test("[unhappy-4] STARTER_RUNS_MAX refused run_starter calls each log and use up no run", async () => {
  const run = await refusedRun([
    setPseudonyms(),
    ...Array.from({ length: STARTER_RUNS_MAX }, () =>
      turn([call("run_starter", atProject)]),
    ),
    turn([call("run_starter", candidate)]),
  ]);
  for (let index = 1; index <= STARTER_RUNS_MAX; index += 1) {
    assert.deepEqual(run.stepsAt(index), [
      "Ran the starter: its project does not generate yet",
    ]);
    assert.deepEqual(refusals(run.linesAt(index)), [
      `run_starter refused (project): 1 problem.\n  ${MISSING}`,
    ]);
  }
  const last = STARTER_RUNS_MAX + 1;
  assert.doesNotMatch(run.resultAt(last)?.content ?? "", /No runs are left/);
  assert.equal(run.jobs(), 1);
  assert.deepEqual(refusals(run.linesAt(last)), []);
});

// Extends "[unhappy-5] pseudonyms that rename nothing stop check_starter at names":
// run_starter and submit_starter, and two unused names.
test("[unhappy-5] pseudonyms that rename nothing stop run_starter and submit_starter at names", async () => {
  const run = await refusedRun([
    setPseudonyms([
      { before: "Globex", after: "Vendor", kind: "identifier", paths: [] },
    ]),
    turn([call("run_starter", candidate)]),
    turn([call("submit_starter", submitted)]),
  ]);
  assert.deepEqual(run.stepsAt(1), ["Ran the starter: its names need fixing"]);
  assert.deepEqual(run.stepsAt(2), [
    "Submitted the starter: its names need fixing",
  ]);
  assert.deepEqual(refusals(run.lines), [
    `run_starter refused (names): 1 problem.\n  ${GLOBEX}`,
    `submit_starter refused (names): 1 problem.\n  ${GLOBEX}`,
  ]);
  assert.equal(run.resultAt(1)?.content, GLOBEX);
  assert.equal(run.jobs(), 0);
});

test("[unhappy-5] two names that rename nothing are both logged under names", async () => {
  const run = await refusedRun([
    setPseudonyms([
      { before: "Globex", after: "Vendor", kind: "identifier", paths: [] },
      { before: "Initech", after: "Firm", kind: "identifier", paths: [] },
    ]),
    turn([call("check_starter", candidate)]),
  ]);
  assert.deepEqual(run.stepsAt(1), [
    "Checked the starter: its names need fixing",
  ]);
  assert.deepEqual(refusals(run.lines), [
    [
      "check_starter refused (names): 2 problems.",
      `  ${GLOBEX}`,
      "  Name 2: Initech does not occur in the starter, so it renames nothing.",
    ].join("\n"),
  ]);
});

// Extends "[unhappy-6] a hidden test that does not compile is shown to the agent
// but only counted in the log": the exact entry, and run_starter and submit_starter.
test("[unhappy-6] a hidden test's diagnostic alone is logged as a header and a count, and sent whole to the agent", async () => {
  const run = await refusedRun([
    setPseudonyms(),
    turn([call("check_starter", atTypesHidden)]),
    turn([call("run_starter", atTypesHidden)]),
    turn([call("submit_starter", submittedAs(atTypesHidden))]),
  ]);
  for (const index of [1, 2, 3]) {
    assert.equal(run.resultAt(index)?.is_error, true);
    assert.equal(run.resultAt(index)?.content, SUM_TS);
  }
  assert.deepEqual(refusals(run.lines), [
    "check_starter refused (types): 1 problem.\n  and 1 in hidden tests, not shown",
    "run_starter refused (types): 1 problem.\n  and 1 in hidden tests, not shown",
    "submit_starter refused (types): 1 problem.\n  and 1 in hidden tests, not shown",
  ]);
  assert.deepEqual(run.stepsAt(2), ["Ran the starter: it does not compile yet"]);
  assert.equal(run.jobs(), 0);
});

test("[unhappy-6] a hidden test's diagnostic beside a source one: the log shows the source one and counts the other", async () => {
  const run = await refusedRun([
    setPseudonyms(),
    turn([
      call("check_starter", { ...atTypes, hiddenTests: [hiddenSum] }),
    ]),
  ]);
  const content = (run.resultAt(1)?.content ?? "").split("\n");
  assert.ok(content.includes(A_TS), content.join("\n"));
  assert.ok(content.includes(SUM_TS), content.join("\n"));
  const logged = refusals(run.linesAt(1));
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0]?.split("\n"), [
    "check_starter refused (types): 2 problems.",
    `  ${A_TS}`,
    "  and 1 in hidden tests, not shown",
  ]);
  assert.ok(run.lines.every((line) => !line.includes("tests/private/total.test.ts:")));
});

test("[unhappy-6] a rules problem naming a hidden test first is counted, not shown, in the log", async () => {
  const run = await refusedRun([
    setPseudonyms(),
    turn([call("check_starter", atRulesHiddenPath)]),
  ]);
  const problem =
    "tests/private/total.ts: hidden tests live under tests/private/ and end in .test.ts.";
  assert.equal(run.resultAt(1)?.content, problem);
  assert.deepEqual(run.stepsAt(1), [
    "Checked the starter: its files break the starter's rules",
  ]);
  assert.deepEqual(refusals(run.lines), [
    "check_starter refused (rules): 1 problem.\n  and 1 in hidden tests, not shown",
  ]);
  assert.ok(run.lines.every((line) => !line.includes("tests/private/total.ts:")));
});

// Extends "[boundary-7] a schema-invalid check and a check after the limit ...":
// refused checks count toward the limit, each logging, and other schema faults.
test("[boundary-7] STARTER_CHECKS_MAX refused checks each log their stage, and the next gets no step line and no log", async () => {
  const run = await refusedRun([
    setPseudonyms(),
    ...Array.from({ length: STARTER_CHECKS_MAX }, () =>
      turn([call("check_starter", atProject)]),
    ),
    turn([call("check_starter", atProject)]),
  ]);
  for (let index = 1; index <= STARTER_CHECKS_MAX; index += 1) {
    assert.deepEqual(run.stepsAt(index), [
      "Checked the starter: its project does not generate yet",
    ]);
    assert.deepEqual(refusals(run.linesAt(index)), [
      `check_starter refused (project): 1 problem.\n  ${MISSING}`,
    ]);
  }
  const over = STARTER_CHECKS_MAX + 1;
  assert.match(run.resultAt(over)?.content ?? "", /No checks are left/);
  assert.deepEqual(run.stepsAt(over), []);
  assert.deepEqual(refusals(run.linesAt(over)), []);
  assert.equal(refusals(run.lines).length, STARTER_CHECKS_MAX);
});

test("[boundary-7] check_starter calls missing a field or with no source file are refused by the schema and write no log", async () => {
  const { hiddenTests: _hidden, ...noHidden } = candidate;
  const run = await refusedRun([
    setPseudonyms(),
    turn([call("check_starter", noHidden)]),
    turn([call("check_starter", { ...candidate, files: [] })]),
    turn([call("check_starter", { ...candidate, extra: true })]),
    turn([call("check_starter", atProject)]),
  ]);
  for (const index of [1, 2, 3]) {
    assert.equal(run.resultAt(index)?.is_error, true);
    assert.deepEqual(run.stepsAt(index), ["Checked the starter: it was refused"]);
    assert.deepEqual(refusals(run.linesAt(index)), []);
  }
  assert.deepEqual(refusals(run.lines), [
    `check_starter refused (project): 1 problem.\n  ${MISSING}`,
  ]);
});

test("[boundary-7] a run_starter with no runs left never reaches the check: no step line and no log", async () => {
  const run = await refusedRun([
    setPseudonyms(),
    turn([call("check_starter", atTypes)]),
    ...Array.from({ length: STARTER_RUNS_MAX - 1 }, () =>
      turn([call("run_starter", candidate)]),
    ),
    turn([call("run_starter", atProject)]),
  ]);
  assert.deepEqual(refusals(run.linesAt(1)), [
    `check_starter refused (types): 1 problem.\n  ${A_TS}`,
  ]);
  const over = STARTER_RUNS_MAX + 1;
  assert.match(run.resultAt(over)?.content ?? "", /^No runs are left/);
  assert.deepEqual(run.stepsAt(over), []);
  assert.deepEqual(refusals(run.linesAt(over)), []);
  assert.equal(refusals(run.lines).length, 1);
});

// Extends "[boundary-8] a schema-invalid run_starter keeps its old step line":
// submit_starter too, and other schema faults, beside a refusal that does log.
test("[boundary-8] schema-invalid run_starter and submit_starter keep 'it does not build yet' and log nothing, unlike a refusal", async () => {
  const { summary: _summary, ...noSummary } = submitted;
  const run = await refusedRun([
    setPseudonyms(),
    turn([call("submit_starter", { ...submitted, packages: "none" })]),
    turn([call("submit_starter", noSummary)]),
    turn([call("run_starter", { ...candidate, scenario: "" })]),
    turn([call("run_starter", atProject)]),
  ]);
  assert.deepEqual(run.stepsAt(1), [
    "Submitted the starter: it does not build yet",
  ]);
  assert.deepEqual(run.stepsAt(2), [
    "Submitted the starter: it does not build yet",
  ]);
  assert.deepEqual(run.stepsAt(3), ["Ran the starter: it does not build yet"]);
  for (const index of [1, 2, 3]) {
    assert.equal(run.resultAt(index)?.is_error, true);
    assert.deepEqual(refusals(run.linesAt(index)), []);
  }
  assert.deepEqual(run.stepsAt(4), [
    "Ran the starter: its project does not generate yet",
  ]);
  assert.deepEqual(refusals(run.lines), [
    `run_starter refused (project): 1 problem.\n  ${MISSING}`,
  ]);
  assert.equal(run.jobs(), 0);
});

// Extends "[concurrency-1] two checks in one turn each name their own stage":
// three checks, in an order unlike the stages'.
test("[concurrency-1] three checks in one turn at project, types and rules keep call order in steps and log", async () => {
  const run = await refusedRun([
    setPseudonyms(),
    turn([
      call("check_starter", atProject),
      call("check_starter", atTypes),
      call("check_starter", atRulesTwice),
    ]),
  ]);
  assert.deepEqual(run.stepsAt(1), [
    "Checked the starter: its project does not generate yet",
    "Checked the starter: it does not compile yet",
    "Checked the starter: its files break the starter's rules",
  ]);
  assert.deepEqual(refusals(run.linesAt(1)), [
    `check_starter refused (project): 1 problem.\n  ${MISSING}`,
    `check_starter refused (types): 1 problem.\n  ${A_TS}`,
    "check_starter refused (rules): 1 problem.\n  src/cart.ts is given twice.",
  ]);
  assert.deepEqual(
    run.model.results[1]?.map((result) => result.content),
    [MISSING, A_TS, "src/cart.ts is given twice."],
  );
});

test("[concurrency-1] one turn holding a refused check, run and submit logs each under its own tool, in order", async () => {
  const run = await refusedRun([
    setPseudonyms(),
    turn([
      call("check_starter", atTypes),
      call("run_starter", atRulesTwice),
      call("submit_starter", submittedAs(atProject)),
    ]),
  ]);
  assert.deepEqual(run.stepsAt(1), [
    "Checked the starter: it does not compile yet",
    "Ran the starter: its files break the starter's rules",
    "Submitted the starter: its project does not generate yet",
  ]);
  assert.deepEqual(refusals(run.linesAt(1)), [
    `check_starter refused (types): 1 problem.\n  ${A_TS}`,
    "run_starter refused (rules): 1 problem.\n  src/cart.ts is given twice.",
    `submit_starter refused (project): 1 problem.\n  ${MISSING}`,
  ]);
  assert.equal(run.jobs(), 0);
});

// --- A starter's committed records the descriptor's counts ---

const DESCRIPTOR = "project/sandbox-task.json";
const cartSummary = [
  { label: "public", count: 1 },
  { label: "scenarios", count: 0 },
];

/** A starter run that ends with a submission, and the files it returned. */
async function submittedRun(turns: AgentTurn[], fake = fakeProvider()) {
  const model = scripted(turns);
  const adapter = createStarterAdapter({
    agent: { model, limits },
    provider: fake.provider,
    now: () => new Date(stamp),
  });
  const out = await mkdtemp(join(tmpdir(), "hidden-touched-starter-"));
  const files = await adapter.run({
    sourceDir: out,
    outDir: join(out, "out"),
    params: params as never,
    run: null,
    inputs: inputs(),
    signal: new AbortController().signal,
    log: () => {},
  });
  const fileAt = (path: string) => {
    const file = files.find((item) => item.path === path);
    assert.ok(file !== undefined, `${path} is among the run's files`);
    return file;
  };
  const read = async (path: string) =>
    readFile(fileAt(path).absolutePath, "utf8");
  /** Rewrites the descriptor's testSummary in place, keeping the rest. */
  const rewriteSummary = async (testSummary: unknown) => {
    const file = fileAt(DESCRIPTOR);
    const descriptor = JSON.parse(await read(DESCRIPTOR)) as Record<string, unknown>;
    await writeFile(
      file.absolutePath,
      JSON.stringify({ ...descriptor, testSummary }),
      "utf8",
    );
  };
  const commit = async (list: readonly ArtifactFile[] = files) => {
    const recorded: Recorded[] = [];
    await adapter.committed?.({
      runId: "arn_starter",
      files: [...list],
      inputs: inputs(recorded),
    });
    return recorded;
  };
  return { adapter, files, out, read, fileAt, rewriteSummary, commit };
}
const acceptedTurns = () => [
  setPseudonyms(),
  turn([call("submit_starter", submitted)]),
];

// Extends "[happy-5] a starter run records its descriptor's counts on commit":
// the counts come from the descriptor file, whatever it holds.
test("[happy-5] a starter's committed records the testSummary its descriptor file holds, in its order", async () => {
  const run = await submittedRun(acceptedTurns());
  try {
    const before = await run.commit();
    const custom = [
      { label: "scenarios", count: 7 },
      { label: "public", count: -2 },
      { label: "extra", count: 0 },
    ];
    await run.rewriteSummary(custom.map((item) => ({ ...item, note: "dropped" })));
    const recorded = await run.commit();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.versionId, "sbv_1");
    assert.equal(recorded[0]?.runId, "arn_starter");
    assert.deepEqual(recorded[0]?.output.testSummary, custom);
    const { testSummary: _a, ...rest } = recorded[0]?.output ?? {};
    const { testSummary: _b, ...restBefore } = before[0]?.output ?? {};
    assert.deepEqual(rest, restBefore);
    assert.deepEqual(before[0]?.output.testSummary, cartSummary);
  } finally {
    await rm(run.out, { recursive: true, force: true });
  }
});

test("[happy-5] a starter with two public tests records a public count of 2 from its descriptor", async () => {
  const second = {
    path: "tests/public/more.test.ts",
    text: [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { acmeTotal } from "../../src/cart.js";',
      'test("an empty cart is still free", () => assert.equal(acmeTotal([]), 0));',
      "",
    ].join("\n"),
  };
  const run = await submittedRun([
    setPseudonyms(),
    turn([
      call("submit_starter", {
        ...submitted,
        publicTests: [...submitted.publicTests, second],
      }),
    ]),
  ]);
  try {
    const manifest = JSON.parse(
      await run.read("build-manifest.json"),
    ) as SandboxBuildManifest;
    assert.equal(manifest.ready, true);
    const descriptor = JSON.parse(await run.read(DESCRIPTOR)) as {
      testSummary: unknown;
    };
    assert.deepEqual(descriptor.testSummary, [
      { label: "public", count: 2 },
      { label: "scenarios", count: 0 },
    ]);
    const recorded = await run.commit();
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]?.output.testSummary, descriptor.testSummary);
    assert.deepEqual(recorded[0]?.output.build, {
      harnessSha256: manifest.harnessSha256,
      toolchainDigest: manifest.toolchainDigest,
    });
  } finally {
    await rm(run.out, { recursive: true, force: true });
  }
});

// Extends "[happy-6] a starter kept as not ready still records its counts, outside build":
// the counts a not-ready descriptor holds, whatever they are.
test("[happy-6] a not-ready starter records its descriptor file's counts at the top level, not inside build", async () => {
  const run = await submittedRun(
    [
      setPseudonyms(),
      ...Array.from({ length: STARTER_RUNS_MAX }, () =>
        turn([call("submit_starter", submitted)]),
      ),
    ],
    fakeProvider(() => ({})),
  );
  try {
    const manifest = JSON.parse(
      await run.read("build-manifest.json"),
    ) as SandboxBuildManifest;
    assert.equal(manifest.ready, false);
    const custom = [{ label: "public", count: 4 }];
    await run.rewriteSummary(custom);
    const recorded = await run.commit();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.output.build, null);
    assert.deepEqual(recorded[0]?.output.testSummary, custom);
  } finally {
    await rm(run.out, { recursive: true, force: true });
  }
});

// Extends "[boundary-11] a starter committed without its descriptor leaves the
// testSummary key out": a descriptor that is there but gives no summary.
test("[boundary-11] a starter whose descriptor is not JSON, or has a bad testSummary, or is gone, commits without the key", async () => {
  const run = await submittedRun(acceptedTurns());
  try {
    const withDescriptor = await run.commit();
    assert.deepEqual(withDescriptor[0]?.output.testSummary, cartSummary);
    const { testSummary: _summary, ...rest } = withDescriptor[0]?.output ?? {};
    const descriptor = run.fileAt(DESCRIPTOR);
    const variants: [string, () => Promise<void>][] = [
      ["a bad testSummary", () => run.rewriteSummary([{ label: "public", count: 1.5 }])],
      ["no testSummary", () => run.rewriteSummary(undefined)],
      ["not JSON", () => writeFile(descriptor.absolutePath, "not json", "utf8")],
      ["a missing file", () => rm(descriptor.absolutePath, { force: true })],
    ];
    for (const [name, change] of variants) {
      await change();
      const recorded = await run.commit();
      assert.equal(recorded.length, 1, name);
      const output = recorded[0]?.output ?? {};
      assert.equal("testSummary" in output, false, name);
      assert.deepEqual(output, rest, name);
    }
  } finally {
    await rm(run.out, { recursive: true, force: true });
  }
});

test("[boundary-11] a not-ready starter committed without its descriptor records build null and no testSummary key", async () => {
  const run = await submittedRun(
    [
      setPseudonyms(),
      ...Array.from({ length: STARTER_RUNS_MAX }, () =>
        turn([call("submit_starter", submitted)]),
      ),
    ],
    fakeProvider(() => ({})),
  );
  try {
    const withDescriptor = await run.commit();
    assert.deepEqual(withDescriptor[0]?.output.testSummary, cartSummary);
    const recorded = await run.commit(
      run.files.filter((file) => file.path !== DESCRIPTOR),
    );
    assert.equal(recorded.length, 1);
    const output = recorded[0]?.output ?? {};
    assert.equal(output.build, null);
    assert.equal("testSummary" in output, false);
    const { testSummary: _summary, ...rest } = withDescriptor[0]?.output ?? {};
    assert.deepEqual(output, rest);
  } finally {
    await rm(run.out, { recursive: true, force: true });
  }
});
