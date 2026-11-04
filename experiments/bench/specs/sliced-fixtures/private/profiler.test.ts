import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  EnqueueAnalysisResult,
  NewBountyProfile,
  ProfileTransition,
  StoredAnalysisRun,
  StoredBountyProfile,
} from "@sandbox-factory/db";
import { canonicalJson } from "sandbox-factory";
import type {
  AnalysisParams,
  AnalysisTool,
  ProfileStatus,
} from "sandbox-factory";

import {
  BountyProfiler,
  type BountyProfilerOptions,
} from "../../src/pricing/profiler.js";

const OWNER = "org_1";
const HASH = "h".repeat(64);
const stamp = "2026-10-03T00:00:00.000Z";

type Status = StoredAnalysisRun["status"];
type ErrorCode = StoredAnalysisRun["errorCode"];
type Reader = "abstractions" | "data_model";

interface Enqueued {
  owner: string;
  snapshotId: string;
  tool: AnalysisTool | undefined;
  params: AnalysisParams;
  requestedBy: string | null;
  maxActive: number | undefined;
}

interface EnqueueInput {
  tool?: AnalysisTool;
  params: AnalysisParams;
  requestedBy: string | null;
  maxActive?: number;
}

type Answer = (
  input: EnqueueInput,
  snapshotId: string,
) => EnqueueAnalysisResult | undefined;

const SHORT: Partial<Record<string, string>> = {
  graphify: "g",
  abstractions: "a",
  data_model: "d",
  scope: "s",
};

const graphParams = { deadlineMinutes: 30 };
const readerParams = (builder: Reader, graphRunId = "arn_g") =>
  ({ deadlineMinutes: 30, builder, graphRunId }) as unknown as AnalysisParams;

function storedRun(
  id: string,
  tool: AnalysisTool,
  snapshotId: string,
  params: AnalysisParams,
  status: Status,
  errorCode: ErrorCode = null,
): StoredAnalysisRun {
  return {
    id,
    snapshotId,
    repoId: "ghr_1",
    tool,
    toolVersion: `${tool}@1`,
    params,
    status,
    attempt: 0,
    maxAttempts: 2,
    errorCode,
    errorDetail: null,
    progress: null,
    startedAt: null,
    finishedAt: null,
    deadlineAt: null,
    createdAt: stamp,
  };
}

/**
 * An analysis queue that keeps one run per snapshot, tool and params, like
 * the store. A per-tool answer replaces the queue's own when it returns a
 * result; returning undefined falls through to the queue.
 */
class FakeRuns {
  readonly runs = new Map<string, StoredAnalysisRun>();
  readonly enqueued: Enqueued[] = [];
  readonly answers = new Map<AnalysisTool, Answer>();
  /** Per tool, an obsolete log key every answer for it carries. */
  readonly obsolete = new Map<AnalysisTool, string>();
  #counts = new Map<string, number>();

  enqueue = async (
    owner: string,
    snapshotId: string,
    input: EnqueueInput,
  ): Promise<EnqueueAnalysisResult> => {
    this.enqueued.push({
      owner,
      snapshotId,
      tool: input.tool,
      params: input.params,
      requestedBy: input.requestedBy,
      maxActive: input.maxActive,
    });
    const tool = input.tool ?? "graphify";
    const extra =
      this.obsolete.get(tool) === undefined
        ? {}
        : { obsoleteLogKey: this.obsolete.get(tool) as string };
    const answered = this.answers.get(tool)?.(input, snapshotId);
    if (answered !== undefined) {
      if (answered.ok) {
        this.runs.set(answered.run.id, answered.run);
        return { ...answered, ...extra };
      }
      return answered;
    }
    const existing = [...this.runs.values()].find(
      (run) =>
        run.snapshotId === snapshotId &&
        run.tool === tool &&
        canonicalJson(run.params) === canonicalJson(input.params),
    );
    if (existing !== undefined)
      return { ok: true, run: existing, created: false, ...extra };
    const run = storedRun(
      this.#nextId(tool),
      tool,
      snapshotId,
      input.params,
      "queued",
    );
    this.runs.set(run.id, run);
    return { ok: true, run, created: true, ...extra };
  };

  get = async (_owner: string, id: string) => this.runs.get(id) ?? null;

  #nextId(tool: string): string {
    const short = SHORT[tool] ?? tool;
    const count = (this.#counts.get(short) ?? 0) + 1;
    this.#counts.set(short, count);
    const id = count === 1 ? `arn_${short}` : `arn_${short}${count}`;
    return this.runs.has(id) ? this.#nextId(tool) : id;
  }

  seed(run: StoredAnalysisRun) {
    this.runs.set(run.id, run);
  }

  set(id: string, status: Status, errorCode: ErrorCode = null) {
    const run = this.runs.get(id);
    assert.ok(run, `no run ${id}`);
    this.runs.set(id, { ...run, status, errorCode });
  }

  tools(): (AnalysisTool | undefined)[] {
    return this.enqueued.map((each) => each.tool);
  }

  ofTool(tool: AnalysisTool): Enqueued[] {
    return this.enqueued.filter((each) => each.tool === tool);
  }
}

class FakeProfiles {
  readonly rows = new Map<string, StoredBountyProfile>();
  raced = false;
  pendingAsked = 0;

  request = async (_owner: string, _input: NewBountyProfile) => null;

  pending = async (owner: string) =>
    [...this.rows.values()].filter(
      (row) =>
        row.organizationId === owner &&
        ["queued", "scoping", "slicing"].includes(row.status),
    );

  organizationsWithPending = async () => {
    this.pendingAsked += 1;
    return [
      ...new Set(
        [...this.rows.values()]
          .filter((row) =>
            ["queued", "scoping", "slicing"].includes(row.status),
          )
          .map((row) => row.organizationId),
      ),
    ];
  };

  advance = async (
    _owner: string,
    id: string,
    from: ProfileStatus,
    to: ProfileTransition,
  ) => {
    const row = this.rows.get(id);
    if (this.raced || row === undefined || row.status !== from) return false;
    this.rows.set(id, {
      ...row,
      status: to.status,
      ...(to.status === "scoping" ? { scopeRunId: to.scopeRunId } : {}),
      ...(to.status === "slicing" ? { sliceRunId: to.sliceRunId } : {}),
      ...(to.status === "ready" ? { profile: to.profile } : {}),
      ...(to.status === "failed"
        ? { errorCode: to.errorCode, runErrorCode: to.runErrorCode ?? null }
        : {}),
    });
    return true;
  };

  add(
    id: string,
    proposalId: string,
    snapshotId: string | null,
    extra: Partial<
      Pick<StoredBountyProfile, "organizationId" | "specRevision" | "specHash">
    > = {},
  ): StoredBountyProfile {
    const row: StoredBountyProfile = {
      id,
      organizationId: OWNER,
      proposalId,
      specRevision: 2,
      specHash: HASH,
      snapshotId,
      repository: "acme/app",
      status: "queued",
      errorCode: null,
      runErrorCode: null,
      scopeRunId: null,
      sliceRunId: null,
      profile: null,
      createdAt: stamp,
      updatedAt: stamp,
      ...extra,
    };
    this.rows.set(id, row);
    return row;
  }

  row(id: string): StoredBountyProfile {
    const row = this.rows.get(id);
    assert.ok(row, `no profile ${id}`);
    return row;
  }
}

function harness(maxActive: number | "unset" = 4) {
  const runs = new FakeRuns();
  const profiles = new FakeProfiles();
  const errors: string[] = [];
  const removed: string[] = [];
  const settled: StoredBountyProfile[] = [];
  let launches = 0;
  const base: BountyProfilerOptions = {
    profiles,
    runs,
    artifacts: { list: async () => [] },
    snapshots: { get: async () => null },
    specs: { get: async () => null },
    ensureWorker: async () => {
      launches += 1;
    },
    removeObject: async (key) => {
      removed.push(key);
    },
    intervalMs: 60_000,
    onSettled: async (_owner, profile) => {
      settled.push(profile);
    },
    onError: (code) => errors.push(code),
  };
  const profiler = new BountyProfiler(
    maxActive === "unset" ? base : { ...base, maxActive },
  );
  return {
    profiler,
    runs,
    profiles,
    errors,
    removed,
    settled,
    launches: () => launches,
  };
}

type Harness = ReturnType<typeof harness>;

/** The snapshot's graph and map readers, as earlier runs left them, under the given ids. */
function seedMap(
  h: Harness,
  statuses: { g?: Status; a?: Status; d?: Status },
  {
    snapshotId = "rsn_1",
    g = "arn_g",
    a = "arn_a",
    d = "arn_d",
    codes = {},
  }: {
    snapshotId?: string;
    g?: string;
    a?: string;
    d?: string;
    codes?: { a?: ErrorCode; d?: ErrorCode };
  } = {},
) {
  h.runs.seed(
    storedRun(g, "graphify", snapshotId, graphParams, statuses.g ?? "succeeded"),
  );
  if (statuses.a !== undefined)
    h.runs.seed(
      storedRun(
        a,
        "abstractions",
        snapshotId,
        readerParams("abstractions", g),
        statuses.a,
        codes.a ?? (statuses.a === "failed" ? "tool_failed" : null),
      ),
    );
  if (statuses.d !== undefined)
    h.runs.seed(
      storedRun(
        d,
        "data_model",
        snapshotId,
        readerParams("data_model", g),
        statuses.d,
        codes.d ?? (statuses.d === "failed" ? "tool_failed" : null),
      ),
    );
}

const scopeBase = {
  deadlineMinutes: 60,
  agent: "scope",
  graphRunId: "arn_g",
  proposalId: "bpr_1",
  specRevision: 2,
  specHash: HASH,
};

function scopeEnqueue(h: Harness): Enqueued {
  const scopes = h.runs.ofTool("scope");
  assert.equal(scopes.length, 1);
  const [scope] = scopes;
  assert.ok(scope);
  return scope;
}

function paramsOf(each: Enqueued | undefined): Record<string, unknown> {
  assert.ok(each);
  return each.params as unknown as Record<string, unknown>;
}

const refuse =
  (reason: "not-found" | "graph_mismatch" | "run_limit"): Answer =>
  () => ({ ok: false, reason });

function answerWith(
  id: string,
  tool: AnalysisTool,
  status: Status,
  errorCode: ErrorCode = null,
  created = true,
): Answer {
  return (input, snapshotId) => ({
    ok: true,
    created,
    run: storedRun(id, tool, snapshotId, input.params, status, errorCode),
  });
}

/** An answer for one snapshot only; others fall through to the queue. */
function onSnapshot(snapshotId: string, answer: Answer): Answer {
  return (input, asked) =>
    asked === snapshotId ? answer(input, asked) : undefined;
}

// --- happy-1 ---

// Extends "[happy-1] the first sweep queues the graph and both map readers, in order, and leaves the row queued":
// another snapshot, proposal and an unset cap.
test("[happy-1] on another snapshot with the cap unset, the first sweep asks for exactly graphify, abstractions and data_model there", async () => {
  const h = harness("unset");
  h.profiles.add("bpf_9", "bpr_9", "rsn_7", {
    specRevision: 4,
    specHash: "f".repeat(64),
  });
  await h.profiler.sweep();
  assert.deepEqual(h.runs.enqueued, [
    {
      owner: OWNER,
      snapshotId: "rsn_7",
      tool: "graphify",
      params: { deadlineMinutes: 30 },
      requestedBy: null,
      maxActive: 2,
    },
    {
      owner: OWNER,
      snapshotId: "rsn_7",
      tool: "abstractions",
      params: readerParams("abstractions", "arn_g"),
      requestedBy: null,
      maxActive: 2,
    },
    {
      owner: OWNER,
      snapshotId: "rsn_7",
      tool: "data_model",
      params: readerParams("data_model", "arn_g"),
      requestedBy: null,
      maxActive: 2,
    },
  ]);
  const row = h.profiles.row("bpf_9");
  assert.equal(row.status, "queued");
  assert.equal(row.scopeRunId, null);
  assert.equal(h.launches(), 1);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.settled, []);
});

// Extends "[happy-1] a graph run found rather than created is the one the map readers name":
// a created graph run whose id is not the default one.
test("[happy-1] the map readers name the graph run's own id and take the graph's deadline, not the scope's", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.runs.answers.set(
    "graphify",
    answerWith("arn_graph_42", "graphify", "queued"),
  );
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), ["graphify", "abstractions", "data_model"]);
  assert.deepEqual(
    h.runs.ofTool("abstractions")[0]?.params,
    readerParams("abstractions", "arn_graph_42"),
  );
  assert.deepEqual(
    h.runs.ofTool("data_model")[0]?.params,
    readerParams("data_model", "arn_graph_42"),
  );
  assert.equal(h.runs.ofTool("scope").length, 0);
  assert.equal(h.profiles.row("bpf_1").status, "queued");
  assert.equal(h.launches(), 1);
});

// --- happy-2 ---

// Extends "[happy-2] once both map readers have succeeded, the scope names both and the row moves to scoping":
// runs found under ids that are not the default ones, and another proposal, revision and hash.
test("[happy-2] the scope names the very map-reader runs found, under their own ids, for the row's own proposal and revision", async () => {
  const h = harness();
  const hash = "a".repeat(64);
  h.profiles.add("bpf_7", "bpr_7", "rsn_3", { specRevision: 5, specHash: hash });
  seedMap(
    h,
    { g: "succeeded", a: "succeeded", d: "succeeded" },
    { snapshotId: "rsn_3", g: "arn_graph_x", a: "arn_abs_old", d: "arn_dm_old" },
  );
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), [
    "graphify",
    "abstractions",
    "data_model",
    "scope",
  ]);
  assert.deepEqual(
    h.runs.enqueued[1]?.params,
    readerParams("abstractions", "arn_graph_x"),
  );
  assert.deepEqual(
    h.runs.enqueued[2]?.params,
    readerParams("data_model", "arn_graph_x"),
  );
  const scope = scopeEnqueue(h);
  assert.equal(scope.snapshotId, "rsn_3");
  assert.equal(scope.requestedBy, null);
  assert.equal(scope.maxActive, 3);
  assert.deepEqual(scope.params, {
    deadlineMinutes: 60,
    agent: "scope",
    graphRunId: "arn_graph_x",
    proposalId: "bpr_7",
    specRevision: 5,
    specHash: hash,
    abstractionsRunId: "arn_abs_old",
    dataModelRunId: "arn_dm_old",
  });
  const row = h.profiles.row("bpf_7");
  assert.equal(row.status, "scoping");
  assert.ok(row.scopeRunId !== null);
  assert.equal(h.runs.runs.get(row.scopeRunId)?.tool, "scope");
  assert.deepEqual(h.errors, []);
});

// Extends "[happy-2] once both map readers have succeeded, ...": more sweeps, the readers finishing one at a time.
test("[happy-2] over three sweeps the row waits while data_model still runs, and moves to scoping only once it has succeeded", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  await h.profiler.sweep();
  h.runs.set("arn_g", "succeeded");
  h.runs.set("arn_a", "succeeded");
  h.runs.set("arn_d", "running");
  h.runs.enqueued.length = 0;
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), ["graphify", "abstractions", "data_model"]);
  assert.equal(h.profiles.row("bpf_1").status, "queued");
  assert.equal(h.profiles.row("bpf_1").scopeRunId, null);
  h.runs.set("arn_d", "succeeded");
  h.runs.enqueued.length = 0;
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), [
    "graphify",
    "abstractions",
    "data_model",
    "scope",
  ]);
  assert.deepEqual(scopeEnqueue(h).params, {
    ...scopeBase,
    abstractionsRunId: "arn_a",
    dataModelRunId: "arn_d",
  });
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "scoping");
  assert.equal(h.runs.runs.get(row.scopeRunId ?? "")?.tool, "scope");
});

// --- boundary-1 ---

// Extends the "[boundary-1] abstractions X and data_model Y" table with the combinations it leaves out.
const moreWaitCases: { a: Status; d: Status }[] = [
  { a: "running", d: "running" },
  { a: "queued", d: "failed" },
  { a: "failed", d: "queued" },
  { a: "running", d: "failed" },
  { a: "succeeded", d: "running" },
  { a: "queued", d: "succeeded" },
];

for (const { a, d } of moreWaitCases)
  test(`[boundary-1] abstractions ${a} and data_model ${d}: the readers are asked for, no scope, the row stays queued`, async () => {
    const h = harness();
    h.profiles.add("bpf_1", "bpr_1", "rsn_1");
    seedMap(h, { g: "succeeded", a, d });
    await h.profiler.sweep();
    assert.deepEqual(h.runs.tools(), [
      "graphify",
      "abstractions",
      "data_model",
    ]);
    assert.equal(h.runs.ofTool("scope").length, 0);
    const row = h.profiles.row("bpf_1");
    assert.equal(row.status, "queued");
    assert.equal(row.scopeRunId, null);
    assert.equal(row.errorCode, null);
    assert.deepEqual(h.errors, []);
  });

// Extends the "[boundary-1]" table: statuses answered by the enqueue itself, under other run ids.
const answeredCases: {
  a: Status;
  d: Status;
  named: { abstractionsRunId?: string; dataModelRunId?: string };
}[] = [
  {
    a: "succeeded",
    d: "succeeded",
    named: { abstractionsRunId: "arn_abs_9", dataModelRunId: "arn_dm_9" },
  },
  { a: "succeeded", d: "failed", named: { abstractionsRunId: "arn_abs_9" } },
  { a: "failed", d: "succeeded", named: { dataModelRunId: "arn_dm_9" } },
];

for (const { a, d, named } of answeredCases)
  test(`[boundary-1] readers answered by the store as abstractions ${a} and data_model ${d} are named by the ids the store gave`, async () => {
    const h = harness();
    h.profiles.add("bpf_1", "bpr_1", "rsn_1");
    h.runs.answers.set(
      "graphify",
      answerWith("arn_g", "graphify", "succeeded", null, false),
    );
    h.runs.answers.set(
      "abstractions",
      answerWith(
        "arn_abs_9",
        "abstractions",
        a,
        a === "failed" ? "tool_timeout" : null,
        false,
      ),
    );
    h.runs.answers.set(
      "data_model",
      answerWith(
        "arn_dm_9",
        "data_model",
        d,
        d === "failed" ? "worker_lost" : null,
        false,
      ),
    );
    await h.profiler.sweep();
    assert.deepEqual(scopeEnqueue(h).params, { ...scopeBase, ...named });
    const row = h.profiles.row("bpf_1");
    assert.equal(row.status, "scoping");
    assert.equal(row.errorCode, null);
    assert.deepEqual(h.errors, []);
  });

// --- boundary-2 ---

// Extends "[boundary-2] a context key the profiler does not name is absent, not undefined or null":
// both readers found failed through the enqueue, with codes other than tool_failed.
test("[boundary-2] both readers found failed with other codes: the scope params are exactly the base, after both were asked for", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.runs.answers.set(
    "graphify",
    answerWith("arn_g", "graphify", "succeeded", null, false),
  );
  h.runs.answers.set(
    "abstractions",
    answerWith("arn_a", "abstractions", "failed", "tool_timeout", false),
  );
  h.runs.answers.set(
    "data_model",
    answerWith("arn_d", "data_model", "failed", "worker_lost", false),
  );
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), [
    "graphify",
    "abstractions",
    "data_model",
    "scope",
  ]);
  const params = paramsOf(scopeEnqueue(h));
  assert.deepEqual(params, scopeBase);
  assert.deepEqual(Object.keys(params).sort(), Object.keys(scopeBase).sort());
  assert.equal("abstractionsRunId" in params, false);
  assert.equal("dataModelRunId" in params, false);
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "scoping");
  assert.equal(row.errorCode, null);
  assert.equal(row.runErrorCode, null);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.settled, []);
});

// Extends "[boundary-2] one map reader that failed is absent while the other is named": the other reader failed.
test("[boundary-2] a failed data_model is absent while abstractions is named, with no other key added", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  seedMap(
    h,
    { g: "succeeded", a: "succeeded", d: "failed" },
    { codes: { d: "tool_timeout" } },
  );
  await h.profiler.sweep();
  const params = paramsOf(scopeEnqueue(h));
  assert.deepEqual(
    Object.keys(params).sort(),
    [...Object.keys(scopeBase), "abstractionsRunId"].sort(),
  );
  assert.equal(params["abstractionsRunId"], "arn_a");
  assert.equal("dataModelRunId" in params, false);
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "scoping");
  assert.equal(row.runErrorCode, null);
  assert.deepEqual(h.errors, []);
});

// --- happy-3 ---

// Extends "[happy-3] the map readers are queued while the graph itself is still queued":
// the full params, the order, and the worker woken.
test("[happy-3] with a found graph still queued, both readers' full params name it, in order, and the worker is woken once", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.runs.answers.set(
    "graphify",
    answerWith("arn_gq", "graphify", "queued", null, false),
  );
  await h.profiler.sweep();
  assert.deepEqual(
    h.runs.enqueued.map(({ tool, params, snapshotId }) => ({
      tool,
      params,
      snapshotId,
    })),
    [
      { tool: "graphify", params: graphParams, snapshotId: "rsn_1" },
      {
        tool: "abstractions",
        params: readerParams("abstractions", "arn_gq"),
        snapshotId: "rsn_1",
      },
      {
        tool: "data_model",
        params: readerParams("data_model", "arn_gq"),
        snapshotId: "rsn_1",
      },
    ],
  );
  assert.equal(h.profiles.row("bpf_1").status, "queued");
  assert.equal(h.launches(), 1);
  assert.deepEqual(h.errors, []);
});

// --- unhappy-1 ---

// Extends "[unhappy-1] a graph out of retries fails the profile and queues nothing behind it":
// a second row, on a snapshot whose graph is fine, shows the readers are only held back for the failed graph.
test("[unhappy-1] a failed graph queues no reader on its snapshot, while the next row's snapshot still gets both", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.profiles.add("bpf_2", "bpr_2", "rsn_2");
  h.runs.answers.set(
    "graphify",
    onSnapshot(
      "rsn_1",
      answerWith("arn_gf", "graphify", "failed", "tool_failed", false),
    ),
  );
  await h.profiler.sweep();
  assert.deepEqual(
    h.runs.enqueued.map((each) => [each.tool, each.snapshotId]),
    [
      ["graphify", "rsn_1"],
      ["graphify", "rsn_2"],
      ["abstractions", "rsn_2"],
      ["data_model", "rsn_2"],
    ],
  );
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "scope_failed");
  assert.equal(row.runErrorCode, "tool_failed");
  assert.deepEqual(
    h.settled.map(({ id, status, errorCode, runErrorCode }) => ({
      id,
      status,
      errorCode,
      runErrorCode,
    })),
    [
      {
        id: "bpf_1",
        status: "failed",
        errorCode: "scope_failed",
        runErrorCode: "tool_failed",
      },
    ],
  );
  assert.equal(h.profiles.row("bpf_2").status, "queued");
});

// Extends "[unhappy-1] a failed graph that was found, not created, ...": the snapshot's readers already
// succeeded, and the code is tool_timeout; the row behind it on a ready snapshot still scopes.
test("[unhappy-1] a failed graph fails its row even when its readers already succeeded, and asks for neither of them", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.profiles.add("bpf_2", "bpr_2", "rsn_2");
  seedMap(h, { g: "failed", a: "succeeded", d: "succeeded" });
  h.runs.set("arn_g", "failed", "tool_timeout");
  seedMap(
    h,
    { g: "succeeded", a: "succeeded", d: "succeeded" },
    { snapshotId: "rsn_2", g: "arn_g2", a: "arn_a2", d: "arn_d2" },
  );
  await h.profiler.sweep();
  assert.deepEqual(
    h.runs.enqueued
      .filter((each) => each.snapshotId === "rsn_1")
      .map((each) => each.tool),
    ["graphify"],
  );
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "scope_failed");
  assert.equal(row.runErrorCode, "tool_timeout");
  assert.equal(h.settled.length, 1);
  assert.equal(h.settled[0]?.id, "bpf_1");
  assert.equal(h.profiles.row("bpf_2").status, "scoping");
  assert.deepEqual(scopeEnqueue(h).params, {
    ...scopeBase,
    graphRunId: "arn_g2",
    proposalId: "bpr_2",
    abstractionsRunId: "arn_a2",
    dataModelRunId: "arn_d2",
  });
});

// --- boundary-3 ---

// Extends the "[boundary-3] <tool> answered <reason> is left out" table: the other reader failed, so nothing is named.
test("[boundary-3] abstractions answered not-found and data_model failed: the scope runs naming neither", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.runs.answers.set(
    "graphify",
    answerWith("arn_g", "graphify", "succeeded", null, false),
  );
  h.runs.answers.set("abstractions", refuse("not-found"));
  h.runs.answers.set(
    "data_model",
    answerWith("arn_d", "data_model", "failed", "tool_failed", false),
  );
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), [
    "graphify",
    "abstractions",
    "data_model",
    "scope",
  ]);
  const params = paramsOf(scopeEnqueue(h));
  assert.deepEqual(params, scopeBase);
  assert.equal("abstractionsRunId" in params, false);
  assert.equal("dataModelRunId" in params, false);
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "scoping");
  assert.equal(row.errorCode, null);
  assert.equal(row.runErrorCode, null);
  assert.deepEqual(h.errors, []);
});

// Extends the "[boundary-3]" table: both readers refused.
for (const reason of ["not-found", "graph_mismatch"] as const)
  test(`[boundary-3] both readers answered ${reason}: the scope still runs on the graph, naming neither`, async () => {
    const h = harness();
    h.profiles.add("bpf_1", "bpr_1", "rsn_1");
    h.runs.answers.set(
      "graphify",
      answerWith("arn_gx", "graphify", "succeeded", null, false),
    );
    h.runs.answers.set("abstractions", refuse(reason));
    h.runs.answers.set("data_model", refuse(reason));
    await h.profiler.sweep();
    assert.deepEqual(h.runs.tools(), [
      "graphify",
      "abstractions",
      "data_model",
      "scope",
    ]);
    assert.deepEqual(scopeEnqueue(h).params, {
      ...scopeBase,
      graphRunId: "arn_gx",
    });
    const row = h.profiles.row("bpf_1");
    assert.equal(row.status, "scoping");
    assert.equal(row.errorCode, null);
    assert.equal(row.runErrorCode, null);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.settled, []);
  });

// Extends "[boundary-3] data_model answered not-found ...": data_model is still asked for after abstractions,
// and the abstractions run is named by its own id.
test("[boundary-3] data_model answered not-found after abstractions was found: abstractions is named by its own id", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.runs.answers.set(
    "graphify",
    answerWith("arn_g", "graphify", "succeeded", null, false),
  );
  h.runs.answers.set(
    "abstractions",
    answerWith("arn_abs_3", "abstractions", "succeeded", null, false),
  );
  h.runs.answers.set("data_model", refuse("not-found"));
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), [
    "graphify",
    "abstractions",
    "data_model",
    "scope",
  ]);
  assert.deepEqual(scopeEnqueue(h).params, {
    ...scopeBase,
    abstractionsRunId: "arn_abs_3",
  });
  assert.equal(h.profiles.row("bpf_1").status, "scoping");
  assert.deepEqual(h.errors, []);
});

// --- boundary-4 ---

// Extends "[boundary-4] a map reader the store will not enqueue does not end the wait for the other":
// the refusal is graph_mismatch on abstractions and the other is queued.
test("[boundary-4] abstractions answered graph_mismatch does not end the wait for a queued data_model", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.runs.answers.set(
    "graphify",
    answerWith("arn_g", "graphify", "succeeded", null, false),
  );
  h.runs.answers.set("abstractions", refuse("graph_mismatch"));
  h.runs.answers.set(
    "data_model",
    answerWith("arn_d", "data_model", "queued", null, false),
  );
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), ["graphify", "abstractions", "data_model"]);
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "queued");
  assert.equal(row.errorCode, null);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.settled, []);
});

// Extends "[boundary-4] ...": a later sweep, once the other reader has succeeded, scopes naming it alone.
test("[boundary-4] once the other reader has succeeded on a later sweep, the scope names it alone", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.runs.answers.set(
    "graphify",
    answerWith("arn_g", "graphify", "succeeded", null, false),
  );
  h.runs.answers.set("abstractions", refuse("not-found"));
  await h.profiler.sweep();
  assert.equal(h.runs.ofTool("scope").length, 0);
  assert.equal(h.profiles.row("bpf_1").status, "queued");
  h.runs.set("arn_d", "running");
  await h.profiler.sweep();
  assert.equal(h.runs.ofTool("scope").length, 0);
  assert.equal(h.profiles.row("bpf_1").status, "queued");
  h.runs.set("arn_d", "succeeded");
  await h.profiler.sweep();
  assert.deepEqual(scopeEnqueue(h).params, {
    ...scopeBase,
    dataModelRunId: "arn_d",
  });
  assert.equal(h.profiles.row("bpf_1").status, "scoping");
  assert.deepEqual(h.errors, []);
});

// --- unhappy-2 ---

// Extends "[unhappy-2] a profile with no snapshot fails alone; ...": the row without a snapshot comes second.
test("[unhappy-2] a row with no snapshot behind a waiting row fails as unavailable, and nothing is enqueued for it", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.profiles.add("bpf_2", "bpr_2", null);
  await h.profiler.sweep();
  assert.deepEqual(
    h.runs.enqueued.map((each) => [each.tool, each.snapshotId]),
    [
      ["graphify", "rsn_1"],
      ["abstractions", "rsn_1"],
      ["data_model", "rsn_1"],
    ],
  );
  assert.equal(h.profiles.row("bpf_1").status, "queued");
  const row = h.profiles.row("bpf_2");
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "source_unavailable");
  assert.equal(row.runErrorCode, null);
  assert.deepEqual(
    h.settled.map(({ id, errorCode }) => ({ id, errorCode })),
    [{ id: "bpf_2", errorCode: "source_unavailable" }],
  );
});

// --- unhappy-3 ---

// Extends "[unhappy-3] a scope that fails after the map readers finished fails the profile as before":
// the failing scope enqueue had named both readers, under their own ids.
test("[unhappy-3] the failed scope was asked for naming both readers, and the profile fails with its code", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  seedMap(
    h,
    { g: "succeeded", a: "succeeded", d: "succeeded" },
    { a: "arn_a7", d: "arn_d7" },
  );
  h.runs.answers.set(
    "scope",
    answerWith("arn_s", "scope", "failed", "agent_unavailable"),
  );
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), [
    "graphify",
    "abstractions",
    "data_model",
    "scope",
  ]);
  assert.deepEqual(scopeEnqueue(h).params, {
    ...scopeBase,
    abstractionsRunId: "arn_a7",
    dataModelRunId: "arn_d7",
  });
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "scope_failed");
  assert.equal(row.runErrorCode, "agent_unavailable");
  assert.equal(h.settled.length, 1);
  assert.equal(h.settled[0]?.runErrorCode, "agent_unavailable");
});

// Extends "[unhappy-3] a failed scope's code is the profile's even when a map reader also failed": both failed.
test("[unhappy-3] with both readers failed, the scope still is asked for after them and its own failure code is the profile's", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  seedMap(h, { g: "succeeded", a: "failed", d: "failed" });
  h.runs.answers.set(
    "scope",
    answerWith("arn_s", "scope", "failed", "tool_timeout"),
  );
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), [
    "graphify",
    "abstractions",
    "data_model",
    "scope",
  ]);
  assert.deepEqual(scopeEnqueue(h).params, scopeBase);
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "scope_failed");
  assert.equal(row.runErrorCode, "tool_timeout");
});

// --- boundary-5 ---

// Extends the "[boundary-5] with maxActive <cap>" table: other caps, and the scope's enqueue in the same step.
const moreCapCases: { cap: number | "unset"; held: number }[] = [
  { cap: "unset", held: 2 },
  { cap: 1, held: 1 },
  { cap: 3, held: 2 },
  { cap: 10, held: 9 },
];

for (const { cap, held } of moreCapCases)
  test(`[boundary-5] with maxActive ${cap === "unset" ? "undefined" : cap}, the graph, both readers and the scope each pass maxActive ${held}`, async () => {
    const h = harness(cap);
    h.profiles.add("bpf_1", "bpr_1", "rsn_1");
    seedMap(h, { g: "succeeded", a: "succeeded", d: "succeeded" });
    await h.profiler.sweep();
    assert.deepEqual(h.runs.tools(), [
      "graphify",
      "abstractions",
      "data_model",
      "scope",
    ]);
    assert.deepEqual(
      h.runs.enqueued.map((each) => each.maxActive),
      [held, held, held, held],
    );
  });

// --- boundary-6 ---

// Extends "[boundary-6] data_model refused at the cap ...": the graph and abstractions are already done,
// so a refusal must not be read as "left out".
test("[boundary-6] data_model refused at the cap after abstractions succeeded: no scope, and the next queued row is not tried", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.profiles.add("bpf_2", "bpr_2", "rsn_1");
  seedMap(h, { g: "succeeded", a: "succeeded" });
  h.runs.answers.set("data_model", refuse("run_limit"));
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), ["graphify", "abstractions", "data_model"]);
  assert.equal(h.runs.ofTool("scope").length, 0);
  assert.equal(h.profiles.row("bpf_1").status, "queued");
  assert.equal(h.profiles.row("bpf_1").errorCode, null);
  assert.equal(h.profiles.row("bpf_2").status, "queued");
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.settled, []);
});

// Extends "[boundary-6] abstractions refused at the cap ...": the next row is on another snapshot,
// and another organization's rows still move.
test("[boundary-6] abstractions refused at the cap stops the organization's other rows, not another organization's", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.profiles.add("bpf_2", "bpr_2", "rsn_2");
  h.profiles.add("bpf_3", "bpr_3", "rsn_5", { organizationId: "org_2" });
  h.runs.answers.set("abstractions", onSnapshot("rsn_1", refuse("run_limit")));
  await h.profiler.sweep();
  assert.deepEqual(
    h.runs.enqueued.map((each) => [each.owner, each.tool, each.snapshotId]),
    [
      ["org_1", "graphify", "rsn_1"],
      ["org_1", "abstractions", "rsn_1"],
      ["org_2", "graphify", "rsn_5"],
      ["org_2", "abstractions", "rsn_5"],
      ["org_2", "data_model", "rsn_5"],
    ],
  );
  for (const id of ["bpf_1", "bpf_2", "bpf_3"])
    assert.equal(h.profiles.row(id).status, "queued");
  assert.equal(h.launches(), 1);
  assert.deepEqual(h.errors, []);
});

// --- boundary-7 ---

// Extends "[boundary-7] a row waiting on its map readers does not stop the next queued row": three rows.
test("[boundary-7] three rows waiting on three snapshots each ask for graphify, abstractions and data_model, in row order", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.profiles.add("bpf_2", "bpr_2", "rsn_2");
  h.profiles.add("bpf_3", "bpr_3", "rsn_3");
  await h.profiler.sweep();
  assert.deepEqual(
    h.runs.enqueued.map((each) => [each.tool, each.snapshotId]),
    ["rsn_1", "rsn_2", "rsn_3"].flatMap((snapshot) => [
      ["graphify", snapshot],
      ["abstractions", snapshot],
      ["data_model", snapshot],
    ]),
  );
  for (const id of ["bpf_1", "bpf_2", "bpf_3"])
    assert.equal(h.profiles.row(id).status, "queued");
  assert.equal(h.runs.ofTool("scope").length, 0);
  assert.equal(h.launches(), 1);
  assert.deepEqual(h.errors, []);
});

// --- happy-4 ---

// Extends "[happy-4] each re-queued run's obsolete log is removed in the queued step": a different key per run.
test("[happy-4] each of the graph's and readers' own obsolete logs is removed once", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.runs.obsolete.set("graphify", "logs/graphify-old.txt");
  h.runs.obsolete.set("abstractions", "logs/abstractions-old.txt");
  h.runs.obsolete.set("data_model", "logs/data-model-old.txt");
  await h.profiler.sweep();
  assert.deepEqual(h.runs.tools(), ["graphify", "abstractions", "data_model"]);
  assert.deepEqual([...h.removed].sort(), [
    "logs/abstractions-old.txt",
    "logs/data-model-old.txt",
    "logs/graphify-old.txt",
  ]);
});

// Extends "[happy-4] only the map reader whose re-queue carries an obsolete log has it removed": data_model only,
// on a sweep that also enqueues the scope.
test("[happy-4] only data_model's obsolete log is removed when it alone carries one, on the sweep that queues the scope", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  seedMap(h, { g: "succeeded", a: "succeeded", d: "succeeded" });
  h.runs.obsolete.set("data_model", "logs/dm-old.txt");
  await h.profiler.sweep();
  assert.equal(h.runs.ofTool("scope").length, 1);
  assert.deepEqual(h.removed, ["logs/dm-old.txt"]);
});

// --- concurrency-1 ---

// Extends "[concurrency-1] two profiles on one snapshot ask for identical map-reader runs and name the same ones":
// the readers are created by the first sweep, and named once they succeed.
test("[concurrency-1] two profiles on one snapshot share the readers the first sweep created, and both name them once they succeed", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.profiles.add("bpf_2", "bpr_2", "rsn_1");
  await h.profiler.sweep();
  const firstAbstractions = h.runs.ofTool("abstractions");
  const firstDataModel = h.runs.ofTool("data_model");
  assert.equal(firstAbstractions.length, 2);
  assert.equal(firstDataModel.length, 2);
  assert.deepEqual(firstAbstractions[0]?.params, firstAbstractions[1]?.params);
  assert.deepEqual(firstDataModel[0]?.params, firstDataModel[1]?.params);
  assert.equal(
    [...h.runs.runs.values()].filter((run) => run.tool === "abstractions")
      .length,
    1,
  );
  assert.equal(h.profiles.row("bpf_1").status, "queued");
  assert.equal(h.profiles.row("bpf_2").status, "queued");
  for (const id of ["arn_g", "arn_a", "arn_d"]) h.runs.set(id, "succeeded");
  h.runs.enqueued.length = 0;
  await h.profiler.sweep();
  const scopes = h.runs.ofTool("scope");
  assert.equal(scopes.length, 2);
  assert.deepEqual(
    scopes.map((scope) => paramsOf(scope)["proposalId"]).sort(),
    ["bpr_1", "bpr_2"],
  );
  for (const scope of scopes) {
    const params = paramsOf(scope);
    assert.equal(params["abstractionsRunId"], "arn_a");
    assert.equal(params["dataModelRunId"], "arn_d");
  }
  const one = h.profiles.row("bpf_1");
  const two = h.profiles.row("bpf_2");
  assert.equal(one.status, "scoping");
  assert.equal(two.status, "scoping");
  assert.ok(one.scopeRunId !== null && two.scopeRunId !== null);
  assert.notEqual(one.scopeRunId, two.scopeRunId);
});

// Extends "[concurrency-1] ...": three profiles on one snapshot.
test("[concurrency-1] three profiles on one snapshot all name the same readers, each with its own scope run", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  h.profiles.add("bpf_2", "bpr_2", "rsn_1");
  h.profiles.add("bpf_3", "bpr_3", "rsn_1");
  seedMap(
    h,
    { g: "succeeded", a: "succeeded", d: "succeeded" },
    { a: "arn_a5", d: "arn_d5" },
  );
  await h.profiler.sweep();
  const abstractions = h.runs.ofTool("abstractions");
  assert.equal(abstractions.length, 3);
  assert.equal(new Set(abstractions.map((each) => canonicalJson(each.params))).size, 1);
  const dataModel = h.runs.ofTool("data_model");
  assert.equal(dataModel.length, 3);
  assert.equal(new Set(dataModel.map((each) => canonicalJson(each.params))).size, 1);
  const scopes = h.runs.ofTool("scope");
  assert.equal(scopes.length, 3);
  for (const scope of scopes) {
    const params = paramsOf(scope);
    assert.equal(params["abstractionsRunId"], "arn_a5");
    assert.equal(params["dataModelRunId"], "arn_d5");
  }
  const ids = ["bpf_1", "bpf_2", "bpf_3"].map((id) => {
    const row = h.profiles.row(id);
    assert.equal(row.status, "scoping");
    return row.scopeRunId;
  });
  assert.equal(new Set(ids).size, 3);
});

// --- concurrency-2 ---

// Extends "[concurrency-2] a sweep asked for during a sweep returns that sweep and runs one more after it":
// both passes take the waiting row through the queued step.
test("[concurrency-2] both passes of a coalesced sweep ask for the graph and both readers for a waiting row", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  const first = h.profiler.sweep();
  const second = h.profiler.sweep();
  await Promise.all([first, second]);
  assert.equal(h.profiles.pendingAsked, 2);
  assert.deepEqual(h.runs.tools(), [
    "graphify",
    "abstractions",
    "data_model",
    "graphify",
    "abstractions",
    "data_model",
  ]);
  assert.equal(h.profiles.row("bpf_1").status, "queued");
});

// Extends "[concurrency-2] ...": with the readers done, the first pass scopes and the second asks for nothing more.
test("[concurrency-2] a coalesced sweep over a row whose readers are done enqueues one scope naming them", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  seedMap(h, { g: "succeeded", a: "succeeded", d: "succeeded" });
  await Promise.all([
    h.profiler.sweep(),
    h.profiler.sweep(),
    h.profiler.sweep(),
  ]);
  assert.equal(h.profiles.pendingAsked, 2);
  assert.deepEqual(h.runs.tools(), [
    "graphify",
    "abstractions",
    "data_model",
    "scope",
  ]);
  assert.deepEqual(scopeEnqueue(h).params, {
    ...scopeBase,
    abstractionsRunId: "arn_a",
    dataModelRunId: "arn_d",
  });
  assert.equal(h.profiles.row("bpf_1").status, "scoping");
});

// --- concurrency-3 ---

// Extends "[concurrency-3] a row another sweep moved to scoping first is left alone": one reader failed.
test("[concurrency-3] a raced row's scope names the succeeded reader only, and nothing is reported or settled", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  seedMap(h, { g: "succeeded", a: "succeeded", d: "failed" });
  h.profiles.raced = true;
  await h.profiler.sweep();
  assert.deepEqual(scopeEnqueue(h).params, {
    ...scopeBase,
    abstractionsRunId: "arn_a",
  });
  assert.equal(h.profiles.row("bpf_1").status, "queued");
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.settled, []);
});

// Extends "[concurrency-3] ...": a reader refused not-found on a raced row.
test("[concurrency-3] a raced row with abstractions answered not-found still enqueues the scope naming data_model, and is left alone", async () => {
  const h = harness();
  h.profiles.add("bpf_1", "bpr_1", "rsn_1");
  seedMap(h, { g: "succeeded", d: "succeeded" });
  h.runs.answers.set("abstractions", refuse("not-found"));
  h.profiles.raced = true;
  await h.profiler.sweep();
  assert.deepEqual(scopeEnqueue(h).params, {
    ...scopeBase,
    dataModelRunId: "arn_d",
  });
  const row = h.profiles.row("bpf_1");
  assert.equal(row.status, "queued");
  assert.equal(row.scopeRunId, null);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.settled, []);
});
