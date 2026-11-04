import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { StoredAnalysisRun } from "@sandbox-factory/db";
import { CONTEXT_BUILDERS } from "sandbox-factory";
import {
  mountAnalysisRoutes,
  type AnalysisRouteOptions,
} from "../../src/analysis/routes.js";
import type { AuthVariables } from "../../src/routes.js";

const stamp = "2026-10-01T00:00:00.000Z";
const run: StoredAnalysisRun = {
  id: "arn_1",
  snapshotId: "rsn_1",
  repoId: "ghr_1",
  tool: "graphify",
  toolVersion: "test",
  params: { deadlineMinutes: 30 },
  status: "succeeded",
  attempt: 0,
  maxAttempts: 2,
  errorCode: null,
  errorDetail: null,
  progress: null,
  startedAt: stamp,
  finishedAt: stamp,
  deadlineAt: stamp,
  createdAt: stamp,
};
const scopeRun: StoredAnalysisRun = {
  ...run,
  id: "arn_scope",
  tool: "scope",
  status: "queued",
  params: {
    deadlineMinutes: 60,
    agent: "scope",
    graphRunId: run.id,
    proposalId: "bpr_1",
    specRevision: 2,
    specHash: "h2",
  },
};

interface EnqueueInput {
  tool?: string;
  params: unknown;
  maxActive?: number;
}
type Enqueue = (
  owner: string,
  snapshot: string,
  input: EnqueueInput,
) => Promise<unknown>;

/** The three context builders the spec's background names. */
const BUILDERS = ["graphify", "abstractions", "data_model"] as const;

/** CONTEXT_BUILDERS, once it is the three builders the background names. */
function builders(): readonly string[] {
  assert.deepEqual([...CONTEXT_BUILDERS], [...BUILDERS]);
  return CONTEXT_BUILDERS;
}

/**
 * An owner of "org_1" with repository "ghr_1", whose current snapshot is
 * "rsn_1". Every enqueue is answered `{ ok: true, created: false, run }`
 * with run "arn_1" succeeded, unless a test answers otherwise.
 */
function fixture(maxActive?: number) {
  const enqueued: {
    tool: string;
    snapshot: string;
    params: unknown;
    maxActive: number | undefined;
  }[] = [];
  const contexts: [string, string, string][] = [];
  const asked: string[] = [];
  const latest = new Map<string, string>();
  let launches = 0;
  let answer: Enqueue = async (_owner, _snapshot, input) => ({
    ok: true,
    created: false,
    run: input.tool === "scope" ? scopeRun : run,
  });
  const options = {
    runs: {
      enqueue: async (owner: string, snapshot: string, input: EnqueueInput) => {
        enqueued.push({
          tool: input.tool ?? "graphify",
          snapshot,
          params: input.params,
          maxActive: input.maxActive,
        });
        return answer(owner, snapshot, input);
      },
      latestSucceeded: async (owner: string, snapshot: string, tool: string) => {
        asked.push(tool);
        const id = owner === "org_1" ? latest.get(tool) : undefined;
        return id === undefined
          ? null
          : { ...run, id, tool, snapshotId: snapshot };
      },
      get: async () => null,
      list: async () => [],
      logKey: async () => null,
    },
    repos: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "ghr_1" ? { id } : null,
      setContextSnapshot: async (
        owner: string,
        id: string,
        snapshotId: string,
      ) => {
        contexts.push([owner, id, snapshotId]);
        return true;
      },
    },
    snapshots: {
      current: async () => ({ id: "rsn_1", repoId: "ghr_1", treeKey: "t" }),
      get: async (_owner: string, id: string) =>
        id === "rsn_1" ? { id, repoId: "ghr_1", treeKey: "t" } : null,
    },
    tree: async () => null,
    artifacts: { list: async () => [], get: async () => null },
    objects: {
      remove: async () => {},
      get: async () => undefined,
      signedUrl: async () => "https://objects.test/signed",
    },
    ensureWorker: async () => {
      launches += 1;
    },
    proposals: {
      get: async (owner: string, id: string) =>
        owner === "org_1" && id === "bpr_1" ? { id, specRevision: 2 } : null,
      list: async () => [],
    },
    specs: {
      get: async (_owner: string, proposalId: string, revision: number) =>
        proposalId === "bpr_1" && revision === 2
          ? { revision, specHash: "h2" }
          : null,
    },
    boards: { list: async () => [] },
    ...(maxActive === undefined ? {} : { maxActive }),
  } as unknown as AnalysisRouteOptions;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/api/v1/orgs/:orgId/*", async (c, next) => {
    c.set("user", {
      id: "user_1",
      email: "test@example.test",
      name: "User",
    } as never);
    c.set("member", {
      role: "owner",
      organizationId: c.req.param("orgId"),
    } as never);
    await next();
  });
  mountAnalysisRoutes(app, options);
  const request = (path: string, body: unknown) =>
    app.request(`/api/v1/orgs/org_1/github/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    request,
    enqueued,
    contexts,
    asked,
    launches: () => launches,
    answer: (next: Enqueue) => {
      answer = next;
    },
    withLatest: (tool: string, id: string) => {
      latest.set(tool, id);
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

/** A queue that creates each run queued, `arn_<tool>`, while fewer than its maxActive are active. */
function creating(f: Fixture, active: number) {
  f.answer(async (_owner, _snapshot, input) => {
    const cap = input.maxActive ?? 3;
    if (active >= cap) return { ok: false, reason: "run_limit" };
    active += 1;
    const tool = input.tool ?? "graphify";
    return {
      ok: true,
      created: true,
      run: {
        ...run,
        id: `arn_${tool}`,
        tool,
        params: input.params,
        status: "queued",
      },
    };
  });
}

/** A run of the asked tool, found as is, with the given status. */
const found = (input: EnqueueInput, status: StoredAnalysisRun["status"]) => ({
  ok: true,
  created: false,
  run: {
    ...run,
    id: `arn_found_${input.tool ?? "graphify"}`,
    tool: input.tool ?? "graphify",
    params: input.params,
    status,
  },
});

/** What `.../runs` enqueues for one builder: its graph run first when it reads the map. */
function expectedRuns(
  tool: string,
  deadline: number,
  graphRunId: string,
): { tool: string; params: unknown }[] {
  switch (tool) {
    case "graphify":
      return [{ tool, params: { deadlineMinutes: deadline } }];
    case "abstractions":
    case "data_model":
      return [
        { tool: "graphify", params: { deadlineMinutes: 30 } },
        {
          tool,
          params: { deadlineMinutes: deadline, builder: tool, graphRunId },
        },
      ];
    default:
      assert.fail(`${tool} is not a context builder`);
  }
}

// --- happy-5 ---

// Extends "[happy-5] the builder's parameters, from the request body": every builder, with no deadline.
test("[happy-5] every context builder's default deadline is GRAPH_DEADLINE_MINUTES, and a map reader names the graph run", async () => {
  for (const tool of builders()) {
    const f = fixture();
    const response = await f.request("repositories/ghr_1/runs", { tool });
    assert.equal(response.status, 202, tool);
    assert.deepEqual(
      f.enqueued.map(({ tool, params }) => ({ tool, params })),
      expectedRuns(tool, 30, "arn_1"),
      tool,
    );
  }
});

// Extends "[happy-5] ... graphify keeps an asked deadline" / "data_model keeps an asked deadline":
// every builder, at the smallest and largest deadlines, with the graph run under another id.
for (const deadline of [1, 60, 120])
  test(`[happy-5] every context builder keeps an asked deadline of ${deadline}, while a map reader's graph run keeps 30`, async () => {
    for (const tool of builders()) {
      const f = fixture();
      f.answer(async (_owner, _snapshot, input) => ({
        ok: true,
        created: false,
        run: { ...run, id: `arn_${input.tool ?? "graphify"}_9` },
      }));
      const response = await f.request("repositories/ghr_1/runs", {
        tool,
        params: { deadlineMinutes: deadline },
      });
      assert.equal(response.status, 202, tool);
      assert.deepEqual(
        f.enqueued.map(({ tool, params }) => ({ tool, params })),
        expectedRuns(tool, deadline, "arn_graphify_9"),
        tool,
      );
      assert.ok(f.enqueued.every((each) => each.snapshot === "rsn_1"));
    }
  });

// --- unhappy-4 ---

// Extends "[unhappy-4] a removed builder's name is an invalid request": with params and a snapshot named.
const removedBodies: { name: string; body: unknown }[] = [
  {
    name: "deepwiki with an asked deadline",
    body: { tool: "deepwiki", params: { deadlineMinutes: 60 } },
  },
  {
    name: "dependency_cruiser on a named snapshot",
    body: { tool: "dependency_cruiser", snapshotId: "rsn_1" },
  },
  {
    name: "deepwiki on a named snapshot with an asked deadline",
    body: {
      tool: "deepwiki",
      snapshotId: "rsn_1",
      params: { deadlineMinutes: 30 },
    },
  },
];

for (const { name, body } of removedBodies)
  test(`[unhappy-4] a removed builder's name is an invalid request: ${name}`, async () => {
    const f = fixture();
    const response = await f.request("repositories/ghr_1/runs", body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Invalid analysis request.",
    });
    assert.deepEqual(f.enqueued, []);
    assert.equal(f.launches(), 0);
  });

// Extends "[unhappy-4] ...": on an app that has just accepted a remaining builder.
test("[unhappy-4] after a remaining builder is accepted, a removed one on the same app is still refused and enqueues nothing more", async () => {
  const f = fixture();
  const ok = await f.request("repositories/ghr_1/runs", { tool: "data_model" });
  assert.equal(ok.status, 202);
  const before = f.enqueued.length;
  const launches = f.launches();
  for (const tool of ["dependency_cruiser", "deepwiki"]) {
    const response = await f.request("repositories/ghr_1/runs", { tool });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Invalid analysis request.",
    });
  }
  assert.equal(f.enqueued.length, before);
  assert.equal(f.launches(), launches);
});

// --- happy-6 ---

// Extends "[happy-6] with a cap of 5, ...": a cap of 2 with one run active.
test("[happy-6] with a cap of 2 and one run active, the set is queued whole at [2, 5, 5]", async () => {
  const f = fixture(2);
  creating(f, 1);
  const response = await f.request("repositories/ghr_1/builds", {
    snapshotId: "rsn_1",
  });
  assert.equal(response.status, 202);
  const { runs } = (await response.json()) as { runs: StoredAnalysisRun[] };
  assert.deepEqual(
    runs.map(({ id, tool }) => ({ id, tool })),
    [
      { id: "arn_graphify", tool: "graphify" },
      { id: "arn_abstractions", tool: "abstractions" },
      { id: "arn_data_model", tool: "data_model" },
    ],
  );
  assert.deepEqual(
    f.enqueued.map((each) => each.maxActive),
    [2, 5, 5],
  );
  assert.deepEqual(f.contexts, [["org_1", "ghr_1", "rsn_1"]]);
  assert.equal(f.launches(), 1);
});

// Extends "[happy-6] a fresh set is queued whole, ...": no run active, and the current snapshot.
test("[happy-6] with nothing active and no snapshot named, the current snapshot's set is queued at [3, 6, 6]", async () => {
  const f = fixture();
  creating(f, 0);
  const response = await f.request("repositories/ghr_1/builds", {});
  assert.equal(response.status, 202);
  assert.deepEqual(
    f.enqueued.map(({ tool, snapshot, params }) => ({ tool, snapshot, params })),
    [
      { tool: "graphify", snapshot: "rsn_1", params: { deadlineMinutes: 30 } },
      {
        tool: "abstractions",
        snapshot: "rsn_1",
        params: {
          deadlineMinutes: 30,
          builder: "abstractions",
          graphRunId: "arn_graphify",
        },
      },
      {
        tool: "data_model",
        snapshot: "rsn_1",
        params: {
          deadlineMinutes: 30,
          builder: "data_model",
          graphRunId: "arn_graphify",
        },
      },
    ],
  );
  assert.deepEqual(
    f.enqueued.map((each) => each.maxActive),
    [3, 6, 6],
  );
  assert.deepEqual(f.contexts, [["org_1", "ghr_1", "rsn_1"]]);
  assert.equal(f.launches(), 1);
});

// Extends "[happy-6] ...": the graph is found, so the first created run is abstractions; only what follows it gets the headroom.
test("[happy-6] with the graph found and abstractions the first run created, only data_model gets the cap plus three", async () => {
  const f = fixture();
  f.answer(async (_owner, _snapshot, input) =>
    (input.tool ?? "graphify") === "graphify"
      ? found(input, "succeeded")
      : {
          ok: true,
          created: true,
          run: {
            ...run,
            id: `arn_${input.tool}`,
            tool: input.tool,
            params: input.params,
            status: "queued",
          },
        },
  );
  const response = await f.request("repositories/ghr_1/builds", {});
  assert.equal(response.status, 202);
  assert.deepEqual(
    f.enqueued.map((each) => each.tool),
    ["graphify", "abstractions", "data_model"],
  );
  assert.deepEqual(
    f.enqueued.map((each) => each.maxActive),
    [3, 3, 6],
  );
  assert.deepEqual(
    (f.enqueued[1]?.params as { graphRunId: string }).graphRunId,
    "arn_found_graphify",
  );
  assert.deepEqual(f.contexts, [["org_1", "ghr_1", "rsn_1"]]);
});

// --- boundary-8 ---

// Extends "[boundary-8] a set already built is answered as is, ...": a cap of 7, and the runs answered in order.
test("[boundary-8] with a cap of 7, a set already built is held to 7 throughout and answered in builder order", async () => {
  const f = fixture(7);
  f.answer(async (_owner, _snapshot, input) => found(input, "succeeded"));
  const response = await f.request("repositories/ghr_1/builds", {
    snapshotId: "rsn_1",
  });
  assert.equal(response.status, 202);
  const { runs } = (await response.json()) as { runs: StoredAnalysisRun[] };
  assert.deepEqual(
    runs.map(({ id, tool }) => ({ id, tool })),
    [
      { id: "arn_found_graphify", tool: "graphify" },
      { id: "arn_found_abstractions", tool: "abstractions" },
      { id: "arn_found_data_model", tool: "data_model" },
    ],
  );
  assert.deepEqual(
    f.enqueued.map((each) => each.maxActive),
    [7, 7, 7],
  );
  assert.equal(f.launches(), 0);
  assert.deepEqual(f.contexts, [["org_1", "ghr_1", "rsn_1"]]);
});

// --- boundary-9 ---

// Extends "[boundary-9] with the graph out of retries, only the graph is enqueued": a cap of 5 and a named snapshot.
test("[boundary-9] with a cap of 5 and the graph out of retries, only the graph is enqueued, at 5, and it alone is answered", async () => {
  const f = fixture(5);
  f.answer(async (_owner, _snapshot, input) => ({
    ...found(input, "failed"),
    run: {
      ...found(input, "failed").run,
      attempt: 2,
      errorCode: "tool_timeout",
    },
  }));
  const response = await f.request("repositories/ghr_1/builds", {
    snapshotId: "rsn_1",
  });
  assert.equal(response.status, 202);
  assert.deepEqual(
    f.enqueued.map(({ tool, maxActive }) => ({ tool, maxActive })),
    [{ tool: "graphify", maxActive: 5 }],
  );
  const { runs } = (await response.json()) as { runs: StoredAnalysisRun[] };
  assert.deepEqual(
    runs.map(({ id, tool, status }) => ({ id, tool, status })),
    [{ id: "arn_found_graphify", tool: "graphify", status: "failed" }],
  );
});

// --- unhappy-5 ---

// Extends "[unhappy-5] no slot left refuses the set ...": the graph is found, so the set's first enqueue
// that would create a run is abstractions, and that is where no slot is left.
test("[unhappy-5] with the graph found and no slot left, the set is refused at abstractions, its first run to create", async () => {
  const f = fixture();
  f.answer(async (_owner, _snapshot, input) =>
    (input.tool ?? "graphify") === "graphify"
      ? found(input, "succeeded")
      : { ok: false, reason: "run_limit" },
  );
  const response = await f.request("repositories/ghr_1/builds", {});
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "run_limit");
  assert.deepEqual(
    f.enqueued.map(({ tool, maxActive }) => ({ tool, maxActive })),
    [
      { tool: "graphify", maxActive: 3 },
      { tool: "abstractions", maxActive: 3 },
    ],
  );
});

// Extends "[unhappy-5] ...": the graph and abstractions are found, and data_model has no slot.
test("[unhappy-5] with the graph and abstractions found and no slot left, the set is refused at data_model", async () => {
  const f = fixture(4);
  f.answer(async (_owner, _snapshot, input) =>
    input.tool === "data_model"
      ? { ok: false, reason: "run_limit" }
      : found(input, "succeeded"),
  );
  const response = await f.request("repositories/ghr_1/builds", {});
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "run_limit");
  assert.deepEqual(
    f.enqueued.map(({ tool, maxActive }) => ({ tool, maxActive })),
    [
      { tool: "graphify", maxActive: 4 },
      { tool: "abstractions", maxActive: 4 },
      { tool: "data_model", maxActive: 4 },
    ],
  );
});

// --- happy-7 ---

// Extends "[happy-7] a scope request with only a succeeded data_model run names just that run": both succeeded.
test("[happy-7] a scope request with both map readers succeeded names both, and enqueues neither", async () => {
  const f = fixture();
  f.withLatest("data_model", "arn_model_2");
  f.withLatest("abstractions", "arn_abs_2");
  const response = await f.request("repositories/ghr_1/scope", {
    proposalId: "bpr_1",
  });
  assert.equal(response.status, 202);
  assert.deepEqual(
    f.enqueued.map((each) => each.tool),
    ["graphify", "scope"],
  );
  const params = f.enqueued[1]?.params as Record<string, unknown>;
  assert.equal(params["abstractionsRunId"], "arn_abs_2");
  assert.equal(params["dataModelRunId"], "arn_model_2");
  assert.equal(params["graphRunId"], "arn_1");
  assert.equal(params["proposalId"], "bpr_1");
  assert.equal(params["specRevision"], 2);
});

// Extends "[happy-7] ...": neither succeeded.
test("[happy-7] a scope request with no succeeded map reader names neither key, and enqueues no map reader", async () => {
  const f = fixture();
  const response = await f.request("repositories/ghr_1/scope", {
    proposalId: "bpr_1",
  });
  assert.equal(response.status, 202);
  assert.deepEqual(
    f.enqueued.map((each) => each.tool),
    ["graphify", "scope"],
  );
  const params = f.enqueued[1]?.params as Record<string, unknown>;
  assert.equal("abstractionsRunId" in params, false);
  assert.equal("dataModelRunId" in params, false);
});
