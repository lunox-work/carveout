import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StoredVersionWithSource } from "@sandbox-factory/db";
import {
  canonicalJson,
  resolveScope,
  transformConfigOf,
} from "sandbox-factory";
import type {
  AliasRule,
  EvaluationCommand,
  EvaluationExecResult,
  EvaluationProvider,
  SandboxBuildManifest,
} from "sandbox-factory";
import type { ToolInputs, ToolRunInput } from "../../src/tools/adapter.js";
import {
  createSandboxBuildAdapter,
  descriptorTestSummary,
} from "../../src/tools/sandbox-build.js";
import { sha256 } from "../../src/tools/slice/hash.js";
import { fixture, slice, sliceRun, stamp } from "../fixture-slice.js";

const DESCRIPTOR = "project/sandbox-task.json";

/** A scratch directory for the files a test hands descriptorTestSummary. */
async function scratch<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hidden-touched-descriptor-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function written(dir: string, name: string, text: string) {
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return path;
}
const descriptorText = (testSummary: unknown) =>
  JSON.stringify({
    schemaVersion: 1,
    title: "Sum a cart",
    editablePaths: ["src/cart.ts"],
    publicTests: ["tests/public/cart.test.ts"],
    testSummary,
  });
/** descriptorTestSummary of one descriptor entry holding `text`. */
async function summaryOf(text: string) {
  return scratch(async (dir) =>
    descriptorTestSummary([
      { path: DESCRIPTOR, absolutePath: await written(dir, "d.json", text) },
    ]),
  );
}

// --- descriptorTestSummary ---

// Extends "[happy-4] a built descriptor's summary is returned as written":
// other labels, orders and counts, including negative and zero ones.
test("[happy-4] a summary in another order, with other labels and negative counts, is returned as written", async () => {
  const summary = [
    { label: "scenarios", count: 3 },
    { label: "public", count: 0 },
    { label: "", count: -4 },
    { label: "unité", count: 12 },
  ];
  assert.deepEqual(await summaryOf(descriptorText(summary)), summary);
});

test("[happy-4] a long summary keeps every entry, in order", async () => {
  const summary = Array.from({ length: 25 }, (_, index) => ({
    label: `l${25 - index}`,
    count: index * 7 - 50,
  }));
  assert.deepEqual(await summaryOf(descriptorText(summary)), summary);
});

test("[happy-4] only testSummary is checked: the rest of the descriptor may be anything", async () => {
  const summary = [{ label: "public", count: 2 }];
  for (const text of [
    JSON.stringify({ testSummary: summary }),
    JSON.stringify({ schemaVersion: "nope", title: 5, testSummary: summary }),
    JSON.stringify({ testSummary: summary, unexpected: { deep: [1, 2] } }),
    `${JSON.stringify({ testSummary: summary }, null, 2)}\n`,
  ])
    assert.deepEqual(await summaryOf(text), summary, text);
});

test("[happy-4] the descriptor entry is found among others, wherever it is in the list", async () => {
  await scratch(async (dir) => {
    const decoy = await written(
      dir,
      "decoy.json",
      descriptorText([{ label: "public", count: 99 }]),
    );
    const descriptor = await written(
      dir,
      "descriptor.json",
      descriptorText([{ label: "public", count: 3 }]),
    );
    assert.deepEqual(
      await descriptorTestSummary([
        { path: "sandbox-task.json", absolutePath: decoy },
        { path: "project/sandbox-task.json.bak", absolutePath: decoy },
        { path: "baseline.json", absolutePath: decoy },
        { path: DESCRIPTOR, absolutePath: descriptor },
        { path: "project/README.md", absolutePath: decoy },
      ]),
      [{ label: "public", count: 3 }],
    );
  });
});

// Extends "[boundary-9] what the descriptor's testSummary holds decides the result".
test("[boundary-9] keys besides label and count are dropped from every entry", async () => {
  const result = await summaryOf(
    JSON.stringify({
      testSummary: [
        { count: 1, label: "public", extra: true, nested: { a: 1 } },
        { label: "scenarios", count: 2, note: null },
      ],
    }),
  );
  assert.deepEqual(result, [
    { label: "public", count: 1 },
    { label: "scenarios", count: 2 },
  ]);
  for (const entry of result ?? [])
    assert.deepEqual(Object.keys(entry).sort(), ["count", "label"]);
});

test("[boundary-9] an integer written with a fraction part, or an exponent, is an integer", async () => {
  assert.deepEqual(
    await summaryOf('{"testSummary":[{"label":"public","count":2.0},{"label":"x","count":1e3}]}'),
    [
      { label: "public", count: 2 },
      { label: "x", count: 1000 },
    ],
  );
});

test("[boundary-9] any malformed entry, or testSummary of the wrong type, gives undefined", async () => {
  for (const text of [
    '{"testSummary":null}',
    '{"testSummary":"public"}',
    '{"testSummary":3}',
    '{"testSummary":[null]}',
    '{"testSummary":[[]]}',
    '{"testSummary":[{"label":1,"count":1}]}',
    '{"testSummary":[{"label":null,"count":1}]}',
    '{"testSummary":[{"label":"public"}]}',
    '{"testSummary":[{"label":"public","count":null}]}',
    '{"testSummary":[{"label":"public","count":true}]}',
    '{"testSummary":[{"label":"public","count":-0.5}]}',
    '{"testSummary":[{"label":"a","count":1},{"label":"b","count":2},{"label":"c","count":0.1}]}',
    '{"testSummary":[{"label":"public","count":1}, "public"]}',
    '{"TestSummary":[{"label":"public","count":1}]}',
  ])
    assert.equal(await summaryOf(text), undefined, text);
});

test("[boundary-9] text that is JSON but no object, or no JSON at all, gives undefined", async () => {
  for (const text of [
    "",
    "   ",
    "[]",
    '[{"label":"public","count":1}]',
    '"testSummary"',
    "5",
    "true",
    '{"testSummary":[{"label":"public","count":1}]',
    "{testSummary:[]}",
  ])
    assert.equal(await summaryOf(text), undefined, JSON.stringify(text));
});

// Extends "[unhappy-7] without a readable descriptor entry at exactly
// project/sandbox-task.json there is no summary": other near-miss paths.
test("[unhappy-7] paths that only resemble project/sandbox-task.json are not read", async () => {
  await scratch(async (dir) => {
    const valid = await written(
      dir,
      "valid.json",
      descriptorText([{ label: "public", count: 1 }]),
    );
    for (const path of [
      "/project/sandbox-task.json",
      "./project/sandbox-task.json",
      "Project/sandbox-task.json",
      "project/Sandbox-task.json",
      "project\\sandbox-task.json",
      "project/sandbox-task.json ",
      " project/sandbox-task.json",
      "out/project/sandbox-task.json",
      "project//sandbox-task.json",
      "project/sandbox-task.JSON",
    ])
      assert.equal(
        await descriptorTestSummary([{ path, absolutePath: valid }]),
        undefined,
        path,
      );
  });
});

test("[unhappy-7] a descriptor entry whose absolutePath is a directory, or in a missing directory, gives undefined", async () => {
  await scratch(async (dir) => {
    const folder = join(dir, "folder");
    await mkdir(folder);
    assert.equal(
      await descriptorTestSummary([{ path: DESCRIPTOR, absolutePath: folder }]),
      undefined,
    );
    assert.equal(
      await descriptorTestSummary([
        { path: DESCRIPTOR, absolutePath: join(dir, "nowhere", "sandbox-task.json") },
      ]),
      undefined,
    );
  });
});

// Extends "[boundary-10] only the first entry at project/sandbox-task.json is read":
// the first does not give a summary, and the second, valid one is not read.
test("[boundary-10] when the first descriptor entry gives no summary, a later valid one is not used", async () => {
  await scratch(async (dir) => {
    const valid = await written(
      dir,
      "valid.json",
      descriptorText([{ label: "public", count: 5 }]),
    );
    const firsts = [
      await written(dir, "bad-json.json", "not json"),
      await written(dir, "bad-summary.json", descriptorText({ public: 1 })),
      await written(dir, "no-summary.json", '{"title":"x"}'),
      join(dir, "missing.json"),
    ];
    for (const first of firsts)
      assert.equal(
        await descriptorTestSummary([
          { path: DESCRIPTOR, absolutePath: first },
          { path: DESCRIPTOR, absolutePath: valid },
        ]),
        undefined,
        first,
      );
  });
});

test("[boundary-10] of three descriptor entries, after other files, the first is read", async () => {
  await scratch(async (dir) => {
    const [one, two, three] = await Promise.all(
      [1, 2, 3].map((count) =>
        written(dir, `d${count}.json`, descriptorText([{ label: "public", count }])),
      ),
    );
    assert.deepEqual(
      await descriptorTestSummary([
        { path: "build-manifest.json", absolutePath: three as string },
        { path: DESCRIPTOR, absolutePath: two as string },
        { path: DESCRIPTOR, absolutePath: one as string },
        { path: DESCRIPTOR, absolutePath: three as string },
      ]),
      [{ label: "public", count: 2 }],
    );
  });
});

// Extends "[concurrency-2] overlapping calls on the same files agree": more calls,
// and overlapping calls on different files.
test("[concurrency-2] twenty overlapping calls on the same files all agree", async () => {
  await scratch(async (dir) => {
    const path = await written(
      dir,
      "descriptor.json",
      descriptorText([
        { label: "public", count: 2 },
        { label: "scenarios", count: 1 },
      ]),
    );
    const files = [{ path: DESCRIPTOR, absolutePath: path }];
    const results = await Promise.all(
      Array.from({ length: 20 }, () => descriptorTestSummary(files)),
    );
    for (const result of results)
      assert.deepEqual(result, [
        { label: "public", count: 2 },
        { label: "scenarios", count: 1 },
      ]);
  });
});

test("[concurrency-2] overlapping calls on different files each resolve to their own", async () => {
  await scratch(async (dir) => {
    const lists = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => [
        {
          path: DESCRIPTOR,
          absolutePath: await written(
            dir,
            `d${index}.json`,
            index % 4 === 3
              ? "not json"
              : descriptorText([{ label: `l${index}`, count: index }]),
          ),
        },
      ]),
    );
    const results = await Promise.all(lists.map((files) => descriptorTestSummary(files)));
    results.forEach((result, index) =>
      assert.deepEqual(
        result,
        index % 4 === 3 ? undefined : [{ label: `l${index}`, count: index }],
        String(index),
      ),
    );
  });
});

// --- A build's committed records the descriptor's counts ---

const TAP_FAILED = {
  exitCode: 1,
  stdout:
    "TAP version 13\nnot ok 1 - fails\n  failureType: 'testCodeFailure'\n1..1\n# tests 1\n# pass 0\n# fail 1\n",
};
const runsHiddenTest = (argv: readonly string[]) =>
  argv.includes("--test-reporter=tap");
function fakeProvider(
  script: (
    argv: readonly string[],
  ) => Partial<EvaluationExecResult> = () => ({}),
): EvaluationProvider {
  return {
    name: "fake",
    async create() {
      return {
        id: "job_1",
        environment: {
          provider: "fake",
          environmentId: "env_1",
          templateDigest: "sha256:template",
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
}

/** The sliced draft sandbox-build.test.ts builds, with the alias rules given. */
async function versionFor(
  aliasRules: AliasRule[] = [],
): Promise<StoredVersionWithSource> {
  const { artifacts, manifest, contract } = await slice();
  const manifestSha =
    artifacts.find((a) => a.kind === "slice_manifest")?.sha256 ?? "";
  const contractSha =
    artifacts.find((a) => a.kind === "boundary_contract")?.sha256 ?? "";
  const source: StoredVersionWithSource["source"] = {
    sandboxVersionId: "sbv_1",
    origin: "slice",
    sourceSnapshotId: "rsn_1",
    sourceCommitSha: "a".repeat(40),
    sliceRunId: sliceRun.id,
    starterRunId: null,
    starterSha256: null,
    manifestSha256: manifestSha,
    contractSha256: contractSha,
    transformConfigSha256: "",
    approvedTaskSha256: "",
    proposalVersion: 1,
    contextVersions: { jira: null, github: null },
    approvedTask: {
      schemaVersion: 1,
      title: "Fix the widget",
      summary: "Make it work.",
      spec: {
        proposalId: "bpr_1",
        specRevision: 1,
        specHash: "s".repeat(64),
        draft: {
          feature: "Widget",
          background: [],
          scenarios: [
            {
              id: "s1",
              kind: "happy",
              title: "createService describes a thing",
              steps: [{ keyword: "When", text: "createService runs" }],
              origin: "draft",
            },
          ],
          openQuestions: [],
          assumptions: [],
        },
      },
      pricing: null,
      selectedBy: "user_1",
      selectedAt: stamp,
      jiraIssueIds: [],
    },
    aliasRules,
    dependencyChoices: {},
    acceptanceTests: [
      {
        path: "tests/private/fix.test.ts",
        text: 'import { test } from "node:test";\ntest("fixed", () => { throw new Error("not yet"); });\n',
        expectedBaseline: "fail",
      },
    ],
    fixtures: null,
    scope: resolveScope({ manifest, contract }),
    harnessSha256: null,
    toolchainDigest: null,
    buildRunId: null,
    roundTripRunId: null,
    disclosureRunId: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return {
    version: {
      id: "sbv_1",
      sandboxId: "sbx_1",
      version: 1,
      title: "Fix the widget",
      specSummary: "Make it work.",
      complexity: "M",
      tags: ["typescript"],
      testSummary: [],
      publicBaseCommitSha: null,
      readme: null,
      languages: null,
      frozenAt: null,
      createdAt: stamp,
    },
    source: {
      ...source,
      transformConfigSha256: sha256(
        canonicalJson(
          transformConfigOf({
            aliasRules: source.aliasRules,
            dependencyChoices: source.dependencyChoices,
            acceptanceTests: source.acceptanceTests,
            fixtures: source.fixtures,
            starterSha256: source.starterSha256,
          }),
        ),
      ),
      approvedTaskSha256: sha256(canonicalJson(source.approvedTask)),
    },
  };
}

/** A sandbox build of the draft, run to its end; its files and manifest. */
async function runBuild(
  provider: EvaluationProvider,
  version: StoredVersionWithSource,
) {
  const { artifacts, objects } = await slice();
  const outDir = await mkdtemp(join(tmpdir(), "hidden-touched-build-"));
  const inputs: ToolInputs = {
    getRun: async (id) =>
      id === sliceRun.id ? { ...sliceRun, status: "succeeded" } : null,
    listArtifacts: async (id) => (id === sliceRun.id ? artifacts : []),
    readArtifact: async (key) => objects.get(key),
    getVersion: async (id) => (id === "sbv_1" ? version : null),
    getTask: async () => null,
    recordBuildOutput: async () => false,
    recordStarterOutput: async () => false,
  };
  const input: ToolRunInput = {
    runId: "arn_build",
    sourceDir: fixture,
    outDir,
    params: {
      deadlineMinutes: 30,
      sliceRunId: sliceRun.id,
      sandboxVersionId: "sbv_1",
      manifestSha256: version.source.manifestSha256 ?? "",
      contractSha256: version.source.contractSha256 ?? "",
      transformConfigSha256: version.source.transformConfigSha256,
      approvedTaskSha256: version.source.approvedTaskSha256,
    } as never,
    run: { snapshotId: "rsn_1", commitSha: "a".repeat(40) },
    inputs,
    signal: new AbortController().signal,
    log: () => {},
  };
  const adapter = createSandboxBuildAdapter({
    provider,
    now: () => new Date(stamp),
  });
  const files = await adapter.run(input);
  const read = async (path: string) => readFile(join(outDir, path), "utf8");
  const manifest = JSON.parse(
    await read("build-manifest.json"),
  ) as SandboxBuildManifest;
  const found = files.find((file) => file.path === DESCRIPTOR);
  const descriptorFile = {
    path: DESCRIPTOR,
    absolutePath: found?.absolutePath ?? "",
  };
  /** Rewrites the descriptor's testSummary in place, keeping the rest. */
  const rewriteSummary = async (testSummary: unknown) => {
    assert.ok(found !== undefined, "the build returns its descriptor");
    const descriptor = JSON.parse(
      await readFile(descriptorFile.absolutePath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      descriptorFile.absolutePath,
      JSON.stringify({ ...descriptor, testSummary }),
      "utf8",
    );
  };
  const commit = async (list = files) => {
    const recorded: {
      versionId: string;
      runId: string;
      output: Record<string, unknown>;
    }[] = [];
    await adapter.committed?.({
      runId: "arn_build",
      files: list,
      inputs: recording(recorded),
    });
    return recorded;
  };
  return { files, manifest, outDir, descriptorFile, rewriteSummary, commit };
}
function recording(
  recorded: {
    versionId: string;
    runId: string;
    output: Record<string, unknown>;
  }[],
): ToolInputs {
  return {
    getRun: async () => null,
    listArtifacts: async () => [],
    readArtifact: async () => undefined,
    getVersion: async () => null,
    getTask: async () => null,
    recordBuildOutput: async (versionId, runId, output) => {
      recorded.push({
        versionId,
        runId,
        output: output as unknown as Record<string, unknown>,
      });
      return true;
    },
    recordStarterOutput: async () => false,
  };
}
const readyProvider = () =>
  fakeProvider((argv) => (runsHiddenTest(argv) ? TAP_FAILED : {}));

// Extends "[happy-7] a ready build records its descriptor's counts with its harness":
// the counts are the descriptor file's, whatever it holds.
test("[happy-7] a ready build records the testSummary its descriptor file holds, extra keys dropped", async () => {
  const build = await runBuild(readyProvider(), await versionFor());
  try {
    assert.equal(build.manifest.ready, true);
    const generated = JSON.parse(
      await readFile(build.descriptorFile.absolutePath, "utf8"),
    ) as { testSummary: unknown };
    const first = await build.commit();
    assert.deepEqual(first[0]?.output.testSummary, generated.testSummary);
    await build.rewriteSummary([
      { label: "scenarios", count: 11, extra: "x" },
      { label: "public", count: -1 },
    ]);
    const recorded = await build.commit();
    assert.deepEqual(recorded, [
      {
        versionId: "sbv_1",
        runId: "arn_build",
        output: {
          harnessSha256: build.manifest.harnessSha256,
          toolchainDigest: build.manifest.toolchainDigest,
          testSummary: [
            { label: "scenarios", count: 11 },
            { label: "public", count: -1 },
          ],
        },
      },
    ]);
  } finally {
    await rm(build.outDir, { recursive: true, force: true });
  }
});

test("[happy-7] an empty testSummary in a ready build's descriptor is recorded as []", async () => {
  const build = await runBuild(readyProvider(), await versionFor());
  try {
    assert.equal(build.manifest.ready, true);
    await build.rewriteSummary([]);
    const recorded = await build.commit();
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]?.output.testSummary, []);
  } finally {
    await rm(build.outDir, { recursive: true, force: true });
  }
});

// Extends "[unhappy-8] a build that is not ready records nothing, counts included":
// its descriptor has counts to give, and they are still not recorded.
test("[unhappy-8] a not-ready build whose descriptor holds counts still records nothing", async () => {
  const build = await runBuild(
    fakeProvider(),
    await versionFor([
      { before: "run", after: "client", kind: "identifier", paths: [] },
    ]),
  );
  try {
    assert.equal(build.manifest.ready, false);
    // A build stopped by a blocker writes no project; give it a descriptor.
    const absolutePath = join(build.outDir, "given-descriptor.json");
    await writeFile(
      absolutePath,
      descriptorText([{ label: "public", count: 3 }]),
      "utf8",
    );
    const files = [
      ...build.files,
      {
        path: DESCRIPTOR,
        absolutePath,
        kind: "project_file" as const,
        contentType: "application/json",
        meta: null,
      },
    ];
    assert.deepEqual(await descriptorTestSummary(files), [
      { label: "public", count: 3 },
    ]);
    assert.deepEqual(await build.commit(files), []);
  } finally {
    await rm(build.outDir, { recursive: true, force: true });
  }
});

// Extends "[boundary-11] a build committed without its descriptor leaves the
// testSummary key out": a descriptor that is there but gives no summary.
test("[boundary-11] a ready build whose descriptor is not JSON, has a bad testSummary, or is gone, records without the key", async () => {
  const build = await runBuild(readyProvider(), await versionFor());
  try {
    assert.equal(build.manifest.ready, true);
    const rest = {
      harnessSha256: build.manifest.harnessSha256,
      toolchainDigest: build.manifest.toolchainDigest,
    };
    const variants: [string, () => Promise<void>][] = [
      ["a testSummary of strings", () => build.rewriteSummary([{ label: "public", count: "2" }])],
      ["an object testSummary", () => build.rewriteSummary({ public: 1 })],
      ["not JSON", () => writeFile(build.descriptorFile.absolutePath, "{", "utf8")],
      ["a missing file", () => rm(build.descriptorFile.absolutePath, { force: true })],
    ];
    for (const [name, change] of variants) {
      await change();
      assert.equal(await descriptorTestSummary(build.files), undefined, name);
      const recorded = await build.commit();
      assert.equal(recorded.length, 1, name);
      const output = recorded[0]?.output ?? {};
      assert.equal("testSummary" in output, false, name);
      assert.deepEqual(output, rest, name);
    }
  } finally {
    await rm(build.outDir, { recursive: true, force: true });
  }
});
