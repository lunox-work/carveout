import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type {
  EvaluationCommand,
  EvaluationEnvironment,
  EvaluationExecResult,
  EvaluationJob,
  EvaluationProvider,
  StagedFile,
} from "sandbox-factory";
import { EVALUATION_JOBS_MAX, limitJobs } from "../../src/evaluation/limit.js";

type Spec = { readonly label: string; readonly signal: AbortSignal };

/** One recorded call whose promise the test resolves or rejects. */
interface Call<A, R> {
  readonly args: A;
  resolve(value: R): void;
  reject(error: unknown): void;
}

function record<A, R>(calls: Call<A, R>[], args: A): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    calls.push({ args, resolve, reject });
  });
}

interface FakeJob extends EvaluationJob {
  readonly stages: Call<readonly StagedFile[], void>[];
  readonly execs: Call<EvaluationCommand, EvaluationExecResult>[];
  readonly reads: Call<string, string | null>[];
  readonly destroys: Call<undefined, void>[];
}

function fakeJob(
  id: string,
  environment: EvaluationEnvironment = {
    provider: "fake",
    environmentId: null,
    templateDigest: null,
  },
): FakeJob {
  const stages: Call<readonly StagedFile[], void>[] = [];
  const execs: Call<EvaluationCommand, EvaluationExecResult>[] = [];
  const reads: Call<string, string | null>[] = [];
  const destroys: Call<undefined, void>[] = [];
  return {
    id,
    environment,
    stages,
    execs,
    reads,
    destroys,
    stage: (files) => record(stages, files),
    exec: (command) => record(execs, command),
    read: (path) => record(reads, path),
    destroy: () => record(destroys, undefined),
  };
}

interface FakeProvider extends EvaluationProvider {
  readonly creates: Call<Spec, EvaluationJob>[];
  labels(): string[];
  /** The inner create call made for a label. */
  call(label: string): Call<Spec, EvaluationJob>;
}

function fakeProvider(name = "fake"): FakeProvider {
  const creates: Call<Spec, EvaluationJob>[] = [];
  return {
    name,
    creates,
    create: (spec) => record(creates, spec),
    labels: () => creates.map((call) => call.args.label),
    call: (label) => {
      const found = creates.find((call) => call.args.label === label);
      assert.ok(found, `inner create was not called for ${label}`);
      return found;
    },
  };
}

/** Lets pending promises run. */
const settle = () => new Promise<void>((done) => setImmediate(done));

interface Tracked<T> {
  state: "pending" | "resolved" | "rejected";
  value?: T;
  error?: unknown;
  readonly promise: Promise<T>;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { state: "pending", promise };
  promise.then(
    (value) => {
      tracked.state = "resolved";
      tracked.value = value;
    },
    (error: unknown) => {
      tracked.state = "rejected";
      tracked.error = error;
    },
  );
  return tracked;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function create(
  limited: EvaluationProvider,
  label: string,
  signal: AbortSignal = freshSignal(),
): Tracked<EvaluationJob> {
  return track(limited.create({ label, signal }));
}

function assertWaiting(
  fake: FakeProvider,
  tracked: Tracked<EvaluationJob>,
  label: string,
): void {
  assert.equal(tracked.state, "pending", `${label} is not pending`);
  assert.ok(!fake.labels().includes(label), `${label} reached the inner create`);
}

/** What a promise resolved with, once settled. */
async function resolves<T>(promise: Promise<T>): Promise<T> {
  const tracked = track(promise);
  await settle();
  assert.equal(tracked.state, "resolved", `rejected with ${String(tracked.error)}`);
  return tracked.value as T;
}

/** That a promise, once settled, rejected with this very value. */
async function rejectsWith(promise: Promise<unknown>, expected: unknown) {
  const tracked = track(promise);
  await settle();
  assert.equal(tracked.state, "rejected");
  assert.equal(tracked.error, expected);
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `no item at ${index}`);
  return item;
}

interface Live {
  readonly job: EvaluationJob;
  readonly inner: FakeJob;
}

/** Creates a job through the limited provider and resolves its inner create. */
async function open(
  limited: EvaluationProvider,
  fake: FakeProvider,
  label: string,
  signal: AbortSignal = freshSignal(),
): Promise<Live> {
  const created = limited.create({ label, signal });
  await settle();
  const inner = fakeJob(`sandbox-eval-${label}-1`);
  fake.call(label).resolve(inner);
  return { job: await resolves(created), inner };
}

/** Resolves a waiting create that has since been admitted. */
async function admit(
  fake: FakeProvider,
  tracked: Tracked<EvaluationJob>,
  label: string,
): Promise<Live> {
  const inner = fakeJob(`sandbox-eval-${label}-1`);
  fake.call(label).resolve(inner);
  return { job: await resolves(tracked.promise), inner };
}

/** Destroys a limited job and resolves its latest inner destroy. */
async function close(live: Live): Promise<void> {
  const destroyed = live.job.destroy();
  await settle();
  nth(live.inner.destroys, live.inner.destroys.length - 1).resolve();
  await resolves(destroyed);
  await settle();
}

/** Destroys a limited job and rejects its latest inner destroy with an error. */
async function closeRejecting(live: Live, error: unknown): Promise<void> {
  const destroyed = live.job.destroy();
  await settle();
  nth(live.inner.destroys, live.inner.destroys.length - 1).reject(error);
  await rejectsWith(destroyed, error);
  await settle();
}

const okResult: EvaluationExecResult = {
  exitCode: 0,
  timedOut: false,
  outputTruncated: false,
  stdout: "ok",
  stderr: "",
  durationMs: 5,
};

// --- @happy -------------------------------------------------------------

// Extends "[happy-1] EVALUATION_JOBS_MAX is 2": the value as a cap, past
// admission and through a destroy.
test("[happy-1] EVALUATION_JOBS_MAX caps a limited provider at exactly two live jobs through a destroy", async () => {
  assert.equal(typeof EVALUATION_JOBS_MAX, "number");
  assert.equal(EVALUATION_JOBS_MAX, 2);
  const fake = fakeProvider();
  const limited = limitJobs(fake, EVALUATION_JOBS_MAX);
  const j1 = await open(limited, fake, "j1");
  await open(limited, fake, "j2");
  create(limited, "j3");
  const j4 = create(limited, "j4");
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  await close(j1);
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  assertWaiting(fake, j4, "j4");
});

// Extends "[happy-2] the limited provider keeps the name and is a new object":
// other names and maxes, including Infinity, where returning the provider
// itself would be a tempting shortcut.
test("[happy-2] the name passes through and the result is a new object for other names and any max", () => {
  const cases: [string, number][] = [
    ["e2b", Infinity],
    ["", 1],
    ["hosted provider/odd name", 9007199254740991],
    ["fake", NaN],
    ["x", -1],
  ];
  for (const [name, max] of cases) {
    const fake = fakeProvider(name);
    const limited = limitJobs(fake, max);
    assert.equal(limited.name, name, `name ${name}, max ${max}`);
    assert.notEqual(limited, fake, `name ${name}, max ${max}`);
    assert.equal(fake.creates.length, 0, `name ${name}, max ${max}`);
  }
});

// Extends "[happy-2] the limited provider keeps the name and is a new object":
// the name survives two wraps, and each wrap is a new object.
test("[happy-2] wrapping twice keeps the inner name and gives a new object each time", () => {
  const fake = fakeProvider("local-process");
  const l1 = limitJobs(fake, 2);
  const l2 = limitJobs(l1, 1);
  assert.equal(l1.name, "local-process");
  assert.equal(l2.name, "local-process");
  assert.notEqual(l2, l1);
  assert.notEqual(l2, fake);
  assert.notEqual(limitJobs(fake, 2), l1);
  assert.equal(fake.creates.length, 0);
});

// Extends "[happy-3] a create under the cap reaches the inner provider with
// the same label and signal": three slots, three distinct signals and labels.
test("[happy-3] with max 3 each of three creates reaches the inner provider with its own label and signal", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 3);
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const labels = ["sbv_1/odd label", "", "run_starter 2"];
  const tracked = labels.map((label, index) =>
    create(limited, label, nth(controllers, index).signal),
  );
  await settle();
  assert.equal(fake.creates.length, 3);
  for (const [index, label] of labels.entries()) {
    const call = nth(fake.creates, index);
    assert.equal(call.args.label, label);
    assert.equal(call.args.signal, nth(controllers, index).signal);
    assert.equal(nth(tracked, index).state, "pending");
  }
});

// Extends "[happy-3] a create under the cap ...": a slot free again after a
// destroy, with nobody waiting, is used straight away with the same spec.
test("[happy-3] a create under the cap after a destroy with nobody waiting reaches the inner provider at once", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  await close(await open(limited, fake, "j1"));
  const c = new AbortController();
  create(limited, "j2", c.signal);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assert.equal(nth(fake.creates, 1).args.signal, c.signal);
});

// Extends "[happy-4] the limited job forwards to the inner job and keeps its
// id and environment": other id and environment values, richer arguments,
// text results, and several calls in flight resolved out of order.
test("[happy-4] the limited job keeps other ids and environments and forwards several calls in flight to the right callers", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const created = limited.create({ label: "y", signal: freshSignal() });
  await settle();
  const environment = {
    provider: "e2b",
    environmentId: "env-42",
    templateDigest: "sha256:abc",
  };
  const inner = fakeJob("job-77", environment);
  fake.call("y").resolve(inner);
  const job = await resolves(created);
  assert.equal(job.id, "job-77");
  assert.equal(job.environment, environment);
  assert.notEqual(job, inner);

  const files = [
    { path: "package.json", text: "{}" },
    { path: "src/index.ts", text: "export {};" },
    { path: "test/a.test.ts", text: "" },
  ];
  const staged = job.stage(files);
  const first = { argv: ["npm", "ci"], cwd: "app", env: { CI: "1" }, limits: { timeoutMs: 1, maxOutputBytes: 2 } };
  const second = { argv: ["npm", "test"] };
  const ranFirst = job.exec(first);
  const ranSecond = job.exec(second);
  const readA = job.read("a.txt");
  const readB = job.read("b.txt");
  await settle();
  assert.equal(inner.stages.length, 1);
  assert.equal(nth(inner.stages, 0).args, files);
  assert.equal(inner.execs.length, 2);
  assert.equal(nth(inner.execs, 0).args, first);
  assert.equal(nth(inner.execs, 1).args, second);
  assert.equal(inner.reads.length, 2);
  assert.equal(nth(inner.reads, 0).args, "a.txt");
  assert.equal(nth(inner.reads, 1).args, "b.txt");

  const secondResult = { ...okResult, exitCode: 1, stdout: "second" };
  const firstResult = { ...okResult, stdout: "first" };
  nth(inner.execs, 1).resolve(secondResult);
  nth(inner.reads, 1).resolve("B");
  nth(inner.execs, 0).resolve(firstResult);
  nth(inner.reads, 0).resolve("A");
  nth(inner.stages, 0).resolve(undefined);
  assert.equal(await resolves(ranFirst), firstResult);
  assert.equal(await resolves(ranSecond), secondResult);
  assert.equal(await resolves(readA), "A");
  assert.equal(await resolves(readB), "B");
  assert.equal(await resolves(staged), undefined);
  assert.equal(inner.execs.length, 2);
  assert.equal(inner.reads.length, 2);
  assert.equal(inner.stages.length, 1);
});

// Extends "[happy-4] the limited job forwards ...": two live jobs each
// forward to their own inner job, never to the other's.
test("[happy-4] two limited jobs each forward to their own inner job", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const a = await open(limited, fake, "a");
  const b = await open(limited, fake, "b");
  assert.equal(a.job.id, "sandbox-eval-a-1");
  assert.equal(b.job.id, "sandbox-eval-b-1");
  const readB = b.job.read("b.txt");
  const readA = a.job.read("a.txt");
  await settle();
  assert.equal(a.inner.reads.length, 1);
  assert.equal(b.inner.reads.length, 1);
  assert.equal(nth(a.inner.reads, 0).args, "a.txt");
  assert.equal(nth(b.inner.reads, 0).args, "b.txt");
  nth(a.inner.reads, 0).resolve("from a");
  nth(b.inner.reads, 0).resolve("from b");
  assert.equal(await resolves(readA), "from a");
  assert.equal(await resolves(readB), "from b");
});

// Extends "[happy-5] destroy forwards to the inner job and resolves with
// undefined": with two live jobs, destroying the second reaches only its own
// inner job.
test("[happy-5] destroying the second of two live jobs calls only its own inner destroy", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const j1 = await open(limited, fake, "j1");
  const j2 = await open(limited, fake, "j2");
  const destroyed = j2.job.destroy();
  await settle();
  assert.equal(j2.inner.destroys.length, 1);
  assert.equal(j1.inner.destroys.length, 0);
  nth(j2.inner.destroys, 0).resolve();
  assert.equal(await resolves(destroyed), undefined);
  assert.equal(j2.inner.destroys.length, 1);
  assert.equal(j1.inner.destroys.length, 0);
});

// --- @boundary ----------------------------------------------------------

// Extends "[boundary-1] any max is accepted without throwing": other values.
test("[boundary-1] other odd maxes are accepted without throwing", () => {
  for (const max of [-Infinity, 0.5, -0, Number.MAX_VALUE, Number.MIN_VALUE, 2 ** 53, -2.5]) {
    const fake = fakeProvider();
    let limited: EvaluationProvider | undefined;
    assert.doesNotThrow(() => {
      limited = limitJobs(fake, max);
    }, `max ${max}`);
    assert.equal(typeof limited?.create, "function", `max ${max}`);
    assert.equal(limited?.name, "fake", `max ${max}`);
    assert.equal(fake.creates.length, 0, `max ${max}`);
  }
});

// Extends "[boundary-2] with max 0 several creates all keep waiting": more
// creates, more settling.
test("[boundary-2] with max 0 ten creates keep waiting over many rounds of settling", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 0);
  const waiting = Array.from({ length: 10 }, (_, index) => create(limited, `j${index + 1}`));
  for (let round = 0; round < 5; round += 1) await settle();
  for (const [index, tracked] of waiting.entries()) {
    assertWaiting(fake, tracked, `j${index + 1}`);
  }
  assert.equal(fake.creates.length, 0);
});

// Extends "[boundary-2] with max 0 a create is never admitted": a looser
// wrap around a max 0 provider still never reaches the inner provider.
test("[boundary-2] a max 2 wrap around a max 0 limited provider never reaches the inner create", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(limitJobs(fake, 0), 2);
  const j1 = create(limited, "j1");
  const j2 = create(limited, "j2");
  const j3 = create(limited, "j3");
  await settle();
  await settle();
  assertWaiting(fake, j1, "j1");
  assertWaiting(fake, j2, "j2");
  assertWaiting(fake, j3, "j3");
  assert.equal(fake.creates.length, 0);
});

// Extends "[boundary-3] a signal already aborted at call time is admitted
// when a slot is free": a slot free but not every slot, and the admitted
// call then holds its slot like any other.
test("[boundary-3] with max 2 and one live job an already aborted create is admitted and holds the last slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  await open(limited, fake, "j1");
  const c = new AbortController();
  const gone = new Error("gone");
  c.abort(gone);
  const j2 = limited.create({ label: "j2", signal: c.signal });
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assert.equal(nth(fake.creates, 1).args.signal, c.signal);
  const j3 = create(limited, "j3");
  await settle();
  assertWaiting(fake, j3, "j3");
  fake.call("j2").reject(gone);
  await rejectsWith(j2, gone);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
});

// Extends "[boundary-3] an already aborted create taking the last free slot
// resolves when the inner create does": a non-Error reason, and the job's
// slot is held until it is destroyed.
test("[boundary-3] an already aborted create admitted with a free slot yields a job that holds its slot until destroyed", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const c = new AbortController();
  c.abort("gone");
  const j1 = limited.create({ label: "j1", signal: c.signal });
  await settle();
  assert.deepEqual(fake.labels(), ["j1"]);
  const inner = fakeJob("sandbox-eval-j1-1");
  fake.call("j1").resolve(inner);
  const job = await resolves(j1);
  assert.equal(job.id, "sandbox-eval-j1-1");
  const j2 = create(limited, "j2");
  await settle();
  assertWaiting(fake, j2, "j2");
  await close({ job, inner });
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
});

// Extends "[boundary-4] an abort after admission is left to the inner
// provider": a create admitted from the queue, whose signal aborts after
// admission, is not rejected by the wrapper and leaves no listener.
test("[boundary-4] a create admitted from the queue ignores a later abort and holds no listener on its signal", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  const c = new AbortController();
  const j2 = create(limited, "j2", c.signal);
  await settle();
  assertWaiting(fake, j2, "j2");
  await close(j1);
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assert.equal(nth(fake.creates, 1).args.signal, c.signal);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
  c.abort(new Error("R"));
  await settle();
  assert.equal(j2.state, "pending");
  const j3 = create(limited, "j3");
  await settle();
  assertWaiting(fake, j3, "j3");
  const live = await admit(fake, j2, "j2");
  assert.equal(live.job.id, "sandbox-eval-j2-1");
  await settle();
  assertWaiting(fake, j3, "j3");
});

// Extends "[boundary-4] an abort after admission ...": two jobs on one
// signal keep both slots after it aborts; a create admitted at call time
// holds no listener on its signal.
test("[boundary-4] with max 2 two jobs on one aborted signal keep both slots until destroyed", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const c = new AbortController();
  const j1 = await open(limited, fake, "j1", c.signal);
  await open(limited, fake, "j2", c.signal);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
  c.abort(new Error("R"));
  await settle();
  const j3 = create(limited, "j3");
  const j4 = create(limited, "j4");
  await settle();
  assertWaiting(fake, j3, "j3");
  assertWaiting(fake, j4, "j4");
  await close(j1);
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  assertWaiting(fake, j4, "j4");
});

// Extends "[boundary-5] destroying the same job twice frees only one slot":
// three destroys, three waiters.
test("[boundary-5] destroying the same job three times frees only one slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  const j2 = create(limited, "j2");
  const j3 = create(limited, "j3");
  const j4 = create(limited, "j4");
  await settle();
  await close(j1);
  await close(j1);
  await close(j1);
  assert.equal(j1.inner.destroys.length, 3);
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assert.equal(j2.state, "pending");
  assertWaiting(fake, j3, "j3");
  assertWaiting(fake, j4, "j4");
});

// Extends "[boundary-5] destroying the same job twice ...": a second destroy
// of J1 after j2's job is live does not free j2's slot, and the count stays
// right afterwards.
test("[boundary-5] a repeat destroy after the slot was handed on does not free the next job's slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  const j2 = create(limited, "j2");
  const j3 = create(limited, "j3");
  const j4 = create(limited, "j4");
  await settle();
  await close(j1);
  const live2 = await admit(fake, j2, "j2");
  await close(j1);
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assertWaiting(fake, j3, "j3");
  await close(live2);
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  assertWaiting(fake, j4, "j4");
});

// Extends "[boundary-5] destroying the same job twice ...": the first
// destroy rejects and the second resolves; still only one slot.
test("[boundary-5] a destroy that rejects then a destroy that resolves free only one slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  create(limited, "j2");
  const j3 = create(limited, "j3");
  await settle();
  await closeRejecting(j1, new Error("teardown"));
  await close(j1);
  assert.equal(j1.inner.destroys.length, 2);
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assertWaiting(fake, j3, "j3");
});

// Extends "[boundary-6] a job that is never destroyed keeps its slot": two
// live jobs used but never destroyed, three waiters, many rounds.
test("[boundary-6] with max 2 two used but never destroyed jobs keep both slots", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const j1 = await open(limited, fake, "j1");
  const j2 = await open(limited, fake, "j2");
  const waiting = ["j3", "j4", "j5"].map((label) => create(limited, label));
  for (const live of [j1, j2]) {
    const read = live.job.read("a.txt");
    await settle();
    nth(live.inner.reads, 0).resolve("a");
    await resolves(read);
  }
  for (let round = 0; round < 5; round += 1) await settle();
  for (const [index, tracked] of waiting.entries()) {
    assertWaiting(fake, tracked, `j${index + 3}`);
  }
  assert.equal(fake.creates.length, 2);
});

// Extends "[boundary-7] read still forwards after destroy": stage and exec
// after a destroy that resolved, a rejection after destroy, and none of it
// touching the slot.
test("[boundary-7] stage, exec and read still forward after a resolved destroy without touching the slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  create(limited, "j2");
  const j3 = create(limited, "j3");
  await settle();
  await close(j1);
  assert.deepEqual(fake.labels(), ["j1", "j2"]);

  const files = [{ path: "b.txt", text: "b" }];
  const staged = j1.job.stage(files);
  await settle();
  assert.equal(nth(j1.inner.stages, 0).args, files);
  nth(j1.inner.stages, 0).resolve(undefined);
  assert.equal(await resolves(staged), undefined);

  const command = { argv: ["node", "-v"] };
  const executed = j1.job.exec(command);
  await settle();
  assert.equal(nth(j1.inner.execs, 0).args, command);
  const result = { ...okResult, stdout: "v22" };
  nth(j1.inner.execs, 0).resolve(result);
  assert.equal(await resolves(executed), result);

  const read = j1.job.read("gone.txt");
  await settle();
  assert.equal(nth(j1.inner.reads, 0).args, "gone.txt");
  const E = new Error("job is gone");
  nth(j1.inner.reads, 0).reject(E);
  await rejectsWith(read, E);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assertWaiting(fake, j3, "j3");
});

// --- @unhappy -----------------------------------------------------------

// Extends "[unhappy-1] a failure of a forwarded job call passes through
// unchanged and does not touch the slot": max 2, non-Error values, every
// call kind on one job, then exactly one slot freed by its destroy.
test("[unhappy-1] with max 2 failures of every forwarded call pass through and only destroy frees the slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const a = await open(limited, fake, "A");
  await open(limited, fake, "A2");
  create(limited, "B");
  const c = create(limited, "C");
  await settle();

  const staged = track(a.job.stage([{ path: "a.txt", text: "a" }]));
  const executed = track(a.job.exec({ argv: ["npm", "test"] }));
  const read = track(a.job.read("a.txt"));
  await settle();
  nth(a.inner.stages, 0).reject("stage failed");
  nth(a.inner.execs, 0).reject(null);
  const readError = new TypeError("read failed");
  nth(a.inner.reads, 0).reject(readError);
  await settle();
  assert.equal(staged.state, "rejected");
  assert.equal(staged.error, "stage failed");
  assert.equal(executed.state, "rejected");
  assert.equal(executed.error, null);
  assert.equal(read.state, "rejected");
  assert.equal(read.error, readError);
  assert.deepEqual(fake.labels(), ["A", "A2"]);

  await close(a);
  assert.deepEqual(fake.labels(), ["A", "A2", "B"]);
  assertWaiting(fake, c, "C");
});

// Extends "[unhappy-1] a failure of a forwarded job call ...": many failures
// in a row on one job never free a slot.
test("[unhappy-1] five failed execs in a row on one job do not free its slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const a = await open(limited, fake, "A");
  const b = create(limited, "B");
  await settle();
  for (let index = 0; index < 5; index += 1) {
    const E = new Error(`exec ${index}`);
    const pending = a.job.exec({ argv: ["npm", "test"] });
    await settle();
    nth(a.inner.execs, index).reject(E);
    await rejectsWith(pending, E);
  }
  await settle();
  assertWaiting(fake, b, "B");
  assert.equal(fake.creates.length, 1);
});

// Extends "[unhappy-2] an inner create that rejects frees its slot": with
// nobody waiting, repeated rejections leave the count right, so the cap is
// still exactly one afterwards.
test("[unhappy-2] three inner creates that reject in a row each free their slot and the cap stays one", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  for (const [index, error] of ["boom", new Error("e2"), { code: 3 }].entries()) {
    const label = `f${index + 1}`;
    const failed = limited.create({ label, signal: freshSignal() });
    await settle();
    assert.equal(fake.creates.length, index + 1);
    fake.call(label).reject(error);
    await rejectsWith(failed, error);
  }
  const j1 = create(limited, "j1");
  const j2 = create(limited, "j2");
  await settle();
  assert.deepEqual(fake.labels(), ["f1", "f2", "f3", "j1"]);
  assert.equal(j1.state, "pending");
  assertWaiting(fake, j2, "j2");
});

// Extends "[unhappy-2] an inner create that rejects frees exactly one slot":
// max 2, the second admitted create rejects, three waiting.
test("[unhappy-2] with max 2 the second admitted create rejecting admits only the oldest waiter", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  create(limited, "j1");
  const j2 = limited.create({ label: "j2", signal: freshSignal() });
  create(limited, "j3");
  const j4 = create(limited, "j4");
  const j5 = create(limited, "j5");
  await settle();
  const E = new RangeError("create failed");
  fake.call("j2").reject(E);
  await rejectsWith(j2, E);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  assertWaiting(fake, j4, "j4");
  assertWaiting(fake, j5, "j5");
});

// Extends "[unhappy-3] an inner create that throws synchronously is treated
// as a rejection": a non-Error thrown value, thrown three times in a row;
// the count is not left too high nor too low.
test("[unhappy-3] three synchronous throws of a non-Error value in a row leave the cap at exactly one", async () => {
  const fake = fakeProvider();
  const inner: { readonly name: string; create: EvaluationProvider["create"] } = {
    name: "fake",
    create: () => {
      throw "thrown";
    },
  };
  const limited = limitJobs(inner, 1);
  for (let index = 0; index < 3; index += 1) {
    let returned: Promise<EvaluationJob> | undefined;
    assert.doesNotThrow(() => {
      returned = limited.create({ label: `t${index}`, signal: freshSignal() });
    });
    assert.ok(returned !== undefined);
    assert.equal(typeof returned.then, "function");
    await rejectsWith(returned, "thrown");
  }
  inner.create = (spec) => fake.create(spec);
  create(limited, "j1");
  const j2 = create(limited, "j2");
  await settle();
  assert.deepEqual(fake.labels(), ["j1"]);
  assertWaiting(fake, j2, "j2");
});

// Extends "[unhappy-3] an inner create that throws synchronously ...": with
// max 2 and a live job, a throw for the last free slot gives it back.
test("[unhappy-3] with max 2 a synchronous throw for the last free slot gives it back at once", async () => {
  const fake = fakeProvider();
  const E = new Error("thrown");
  const inner: { readonly name: string; create: EvaluationProvider["create"] } = {
    name: "fake",
    create: (spec) => {
      if (spec.label === "boom") throw E;
      return fake.create(spec);
    },
  };
  const limited = limitJobs(inner, 2);
  await open(limited, fake, "j1");
  let returned: Promise<EvaluationJob> | undefined;
  assert.doesNotThrow(() => {
    returned = limited.create({ label: "boom", signal: freshSignal() });
  });
  assert.ok(returned !== undefined);
  await rejectsWith(returned, E);
  create(limited, "j2");
  const j3 = create(limited, "j3");
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assertWaiting(fake, j3, "j3");
});

// Extends "[unhappy-4] an abort the inner create reacts to is the inner
// create's rejection": the default abort reason, max 2, two waiters.
test("[unhappy-4] with max 2 an abort with the default reason that the inner create rejects with frees one slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const c = new AbortController();
  create(limited, "j1");
  const j2 = limited.create({ label: "j2", signal: c.signal });
  create(limited, "j3");
  const j4 = create(limited, "j4");
  await settle();
  c.abort();
  const R: unknown = c.signal.reason;
  assert.ok(R !== undefined);
  fake.call("j2").reject(R);
  await rejectsWith(j2, R);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  assertWaiting(fake, j4, "j4");
});

// Extends "[unhappy-5] a signal already aborted at call time rejects at once
// when no slot is free": the slot is taken and someone already waits; a
// non-Error reason; the queue order is untouched.
test("[unhappy-5] an already aborted create behind a waiter rejects with its reason and the queue is untouched", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  const j2 = create(limited, "j2");
  await settle();
  const c = new AbortController();
  c.abort("gone");
  const j3 = limited.create({ label: "j3", signal: c.signal });
  await rejectsWith(j3, "gone");
  assert.deepEqual(fake.labels(), ["j1"]);
  await close(j1);
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  await close(await admit(fake, j2, "j2"));
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  create(limited, "j4");
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j4"]);
});

// Extends "[unhappy-5] a signal already aborted at call time rejects at
// once ...": the default reason, no other waiter, and no slot taken or
// listener left behind.
test("[unhappy-5] an already aborted create with the default reason and no slot free rejects with that reason and takes nothing", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const j1 = await open(limited, fake, "j1");
  await open(limited, fake, "j2");
  const c = new AbortController();
  c.abort();
  const reason: unknown = c.signal.reason;
  const j3 = limited.create({ label: "j3", signal: c.signal });
  await rejectsWith(j3, reason);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
  await close(j1);
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  create(limited, "j4");
  const j5 = create(limited, "j5");
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j4"]);
  assertWaiting(fake, j5, "j5");
});

// Extends "[unhappy-6] an inner destroy that rejects still frees the slot":
// max 2, both destroys reject with non-Error values, three waiters.
test("[unhappy-6] with max 2 each rejecting inner destroy frees exactly one slot and passes its value through", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const j1 = await open(limited, fake, "j1");
  const j2 = await open(limited, fake, "j2");
  create(limited, "j3");
  create(limited, "j4");
  const j5 = create(limited, "j5");
  await settle();
  await closeRejecting(j1, "teardown 1");
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  await closeRejecting(j2, { code: "EBUSY" });
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3", "j4"]);
  assertWaiting(fake, j5, "j5");
});

// --- @concurrency -------------------------------------------------------

// Extends "[concurrency-1] only max creates reach the inner provider at
// once": other rows, larger sizes.
test("[concurrency-1] only max creates reach the inner provider at once for larger rows", async () => {
  const rows = [
    { max: 1, calls: 6, admitted: 1 },
    { max: 4, calls: 7, admitted: 4 },
    { max: 5, calls: 5, admitted: 5 },
    { max: 9007199254740991, calls: 10, admitted: 10 },
  ];
  for (const { max, calls, admitted } of rows) {
    const fake = fakeProvider();
    const limited = limitJobs(fake, max);
    const tracked = Array.from({ length: calls }, (_, index) =>
      create(limited, `j${index + 1}`),
    );
    await settle();
    const labels = Array.from({ length: admitted }, (_, index) => `j${index + 1}`);
    assert.deepEqual(fake.labels(), labels, `max ${max}, ${calls} calls`);
    for (const [index, entry] of tracked.entries()) {
      if (index >= admitted) assertWaiting(fake, entry, `j${index + 1}`);
    }
  }
});

// Extends "[concurrency-2] a slot is held from admission until destroy
// settles": max 1, forwarded calls around a destroy that stays pending over
// many rounds.
test("[concurrency-2] with max 1 the slot is held while destroy stays pending across many rounds", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = create(limited, "j1");
  const j2 = create(limited, "j2");
  await settle();
  assertWaiting(fake, j2, "j2");
  const live = await admit(fake, j1, "j1");
  const read = live.job.read("a.txt");
  await settle();
  nth(live.inner.reads, 0).resolve("a");
  await resolves(read);
  const destroyed = track(live.job.destroy());
  for (let round = 0; round < 5; round += 1) await settle();
  assertWaiting(fake, j2, "j2");
  const late = live.job.exec({ argv: ["npm", "test"] });
  await settle();
  nth(live.inner.execs, 0).resolve({ ...okResult });
  await resolves(late);
  await settle();
  assertWaiting(fake, j2, "j2");
  assert.equal(destroyed.state, "pending");
  nth(live.inner.destroys, 0).resolve();
  await settle();
  assert.equal(destroyed.state, "resolved");
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
});

// Extends "[concurrency-2] a slot is held ...": the second job's destroy, not
// the first's, frees the slot when it settles, and not before.
test("[concurrency-2] with max 2 the second job's pending destroy holds its slot until it settles", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  await open(limited, fake, "j1");
  const j2 = await open(limited, fake, "j2");
  const j3 = create(limited, "j3");
  const j4 = create(limited, "j4");
  await settle();
  const destroyed = j2.job.destroy();
  await settle();
  await settle();
  assertWaiting(fake, j3, "j3");
  nth(j2.inner.destroys, 0).resolve();
  await resolves(destroyed);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  assertWaiting(fake, j4, "j4");
});

// Extends "[concurrency-3] waiting creates are admitted in the order they
// were called": max 2, six waiters, slots freed by destroy, by a rejecting
// create and by a rejecting destroy.
test("[concurrency-3] with max 2 six waiters are admitted in call order whatever frees each slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const j1 = await open(limited, fake, "j1");
  const j2 = await open(limited, fake, "j2");
  const waiters = ["j3", "j4", "j5", "j6", "j7", "j8"].map((label) => create(limited, label));
  await settle();

  await close(j2);
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);

  const E = new Error("create failed");
  fake.call("j3").reject(E);
  await rejectsWith(nth(waiters, 0).promise, E);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3", "j4"]);

  await closeRejecting(j1, new Error("teardown"));
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3", "j4", "j5"]);

  const j4 = await admit(fake, nth(waiters, 1), "j4");
  await close(j4);
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3", "j4", "j5", "j6"]);

  const j5 = await admit(fake, nth(waiters, 2), "j5");
  await close(j5);
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3", "j4", "j5", "j6", "j7"]);
  assertWaiting(fake, nth(waiters, 5), "j8");
});

// Extends "[concurrency-3] waiting creates are admitted in the order ...":
// a queued create is given its own signal when admitted.
test("[concurrency-3] each waiter is admitted with its own label and signal in call order", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const waiters = ["j2", "j3", "j4"].map((label, index) =>
    create(limited, label, nth(controllers, index).signal),
  );
  await settle();
  let previous: Live = j1;
  for (const [index, label] of ["j2", "j3", "j4"].entries()) {
    await close(previous);
    const call = nth(fake.creates, index + 1);
    assert.equal(call.args.label, label);
    assert.equal(call.args.signal, nth(controllers, index).signal);
    previous = await admit(fake, nth(waiters, index), label);
  }
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3", "j4"]);
});

// Extends "[concurrency-4] a freed slot goes to the oldest waiter, not to a
// create called after it was freed": the slot is freed by a destroy that
// rejects, and later creates queue behind the waiter in order.
test("[concurrency-4] a slot freed by a rejecting destroy goes to the oldest waiter, and later creates queue behind it", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  const j2 = create(limited, "j2");
  await settle();
  const destroyed = j1.job.destroy();
  await settle();
  const E = new Error("teardown");
  nth(j1.inner.destroys, 0).reject(E);
  let j3: Tracked<EvaluationJob> | undefined;
  let j4: Tracked<EvaluationJob> | undefined;
  await destroyed.catch((error: unknown) => {
    assert.equal(error, E);
    j3 = create(limited, "j3");
    j4 = create(limited, "j4");
  });
  assert.ok(j3 !== undefined && j4 !== undefined);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assertWaiting(fake, j3, "j3");
  assertWaiting(fake, j4, "j4");
  await close(await admit(fake, j2, "j2"));
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  assertWaiting(fake, j4, "j4");
});

// Extends "[concurrency-4] a freed slot goes to the oldest waiter ...": max
// 2, two creates called straight after the destroy returns.
test("[concurrency-4] with max 2 creates called straight after a destroy returns wait behind the oldest waiter", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const j1 = await open(limited, fake, "j1");
  const j2 = await open(limited, fake, "j2");
  create(limited, "j3");
  await settle();
  const destroyed = j1.job.destroy();
  await settle();
  nth(j1.inner.destroys, 0).resolve();
  await destroyed;
  const j4 = create(limited, "j4");
  const j5 = create(limited, "j5");
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  assertWaiting(fake, j4, "j4");
  assertWaiting(fake, j5, "j5");
  await close(j2);
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3", "j4"]);
  assertWaiting(fake, j5, "j5");
});

// Extends "[concurrency-5] each destroy frees exactly one slot": max 3,
// three destroys together, inner destroys resolved in reverse order.
test("[concurrency-5] with max 3 three destroys together admit exactly three of four waiters in order", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 3);
  const live = [
    await open(limited, fake, "j1"),
    await open(limited, fake, "j2"),
    await open(limited, fake, "j3"),
  ];
  create(limited, "j4");
  create(limited, "j5");
  create(limited, "j6");
  const j7 = create(limited, "j7");
  await settle();
  const all = Promise.all(live.map((entry) => entry.job.destroy()));
  await settle();
  for (const entry of [...live].reverse()) nth(entry.inner.destroys, 0).resolve();
  await resolves(all);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3", "j4", "j5", "j6"]);
  assertWaiting(fake, j7, "j7");
});

// Extends "[concurrency-6] a waiter whose signal aborts leaves the queue
// without taking a slot": the middle of three waiters aborts.
test("[concurrency-6] when the middle waiter aborts, the waiters on either side keep their order", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  const c = new AbortController();
  const j2 = create(limited, "j2");
  const j3 = create(limited, "j3", c.signal);
  const j4 = create(limited, "j4");
  await settle();
  const stop = new Error("stop");
  c.abort(stop);
  await rejectsWith(j3.promise, stop);
  assert.deepEqual(fake.labels(), ["j1"]);
  assertWaiting(fake, j2, "j2");
  assertWaiting(fake, j4, "j4");
  await close(j1);
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  await close(await admit(fake, j2, "j2"));
  assert.deepEqual(fake.labels(), ["j1", "j2", "j4"]);
  assert.ok(!fake.labels().includes("j3"));
});

// Extends "[concurrency-6] when the only waiter aborts ...": every waiter
// aborts; afterwards the cap is still exactly one.
test("[concurrency-6] after every waiter aborts, a freed slot admits exactly one new create", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  const reasons = ["r2", "r3", "r4"];
  const controllers = reasons.map(() => new AbortController());
  const waiters = reasons.map((_, index) =>
    create(limited, `j${index + 2}`, nth(controllers, index).signal),
  );
  await settle();
  for (const [index, reason] of reasons.entries()) {
    nth(controllers, index).abort(reason);
  }
  await settle();
  for (const [index, reason] of reasons.entries()) {
    const waiter = nth(waiters, index);
    assert.equal(waiter.state, "rejected");
    assert.equal(waiter.error, reason);
    assert.equal(getEventListeners(nth(controllers, index).signal, "abort").length, 0);
  }
  assert.deepEqual(fake.labels(), ["j1"]);
  await close(j1);
  assert.deepEqual(fake.labels(), ["j1"]);
  create(limited, "j5");
  const j6 = create(limited, "j6");
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j5"]);
  assertWaiting(fake, j6, "j6");
});

// Extends "[concurrency-6] a waiter whose signal aborts ...": with max 0 a
// waiter still leaves the queue with its signal's reason.
test("[concurrency-6] with max 0 a waiter whose signal aborts rejects with the reason and others keep waiting", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 0);
  const c = new AbortController();
  const j1 = create(limited, "j1", c.signal);
  const j2 = create(limited, "j2");
  await settle();
  assertWaiting(fake, j1, "j1");
  const stop = new Error("stop");
  c.abort(stop);
  await settle();
  assert.equal(j1.state, "rejected");
  assert.equal(j1.error, stop);
  assertWaiting(fake, j2, "j2");
  assert.equal(fake.creates.length, 0);
});

// Extends "[concurrency-7] two overlapping destroys of the same job free
// only one slot": the second inner destroy settles first, which frees the
// slot then; the first settling later frees nothing more.
test("[concurrency-7] overlapping destroys free the slot when whichever inner destroy settles first does, and only once", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 1);
  const j1 = await open(limited, fake, "j1");
  create(limited, "j2");
  const j3 = create(limited, "j3");
  await settle();
  const first = track(j1.job.destroy());
  const second = j1.job.destroy();
  await settle();
  assert.equal(j1.inner.destroys.length, 2);
  nth(j1.inner.destroys, 1).resolve();
  await resolves(second);
  await settle();
  assert.equal(first.state, "pending");
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assertWaiting(fake, j3, "j3");
  nth(j1.inner.destroys, 0).resolve();
  await resolves(first.promise);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
  assertWaiting(fake, j3, "j3");
});

// Extends "[concurrency-7] two overlapping destroys ...": three overlapping
// destroys with max 2 and three waiters.
test("[concurrency-7] with max 2 three overlapping destroys of one job free only one slot", async () => {
  const fake = fakeProvider();
  const limited = limitJobs(fake, 2);
  const j1 = await open(limited, fake, "j1");
  await open(limited, fake, "j2");
  create(limited, "j3");
  const j4 = create(limited, "j4");
  const j5 = create(limited, "j5");
  await settle();
  const all = Promise.all([j1.job.destroy(), j1.job.destroy(), j1.job.destroy()]);
  await settle();
  assert.equal(j1.inner.destroys.length, 3);
  for (const call of j1.inner.destroys) call.resolve();
  await resolves(all);
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "j2", "j3"]);
  assertWaiting(fake, j4, "j4");
  assertWaiting(fake, j5, "j5");
});

// Extends "[concurrency-8] two limited providers over the same inner
// provider do not share slots": three providers with different caps.
test("[concurrency-8] three limited providers with caps 1, 2 and 0 over one inner provider count separately", async () => {
  const fake = fakeProvider();
  const l1 = limitJobs(fake, 1);
  const l2 = limitJobs(fake, 2);
  const l3 = limitJobs(fake, 0);
  const a1 = await open(l1, fake, "a1");
  create(l2, "b1");
  create(l2, "b2");
  const c1 = create(l3, "c1");
  const a2 = create(l1, "a2");
  const b3 = create(l2, "b3");
  await settle();
  assert.deepEqual(fake.labels(), ["a1", "b1", "b2"]);
  assertWaiting(fake, a2, "a2");
  assertWaiting(fake, b3, "b3");
  assertWaiting(fake, c1, "c1");
  await close(a1);
  assert.deepEqual(fake.labels(), ["a1", "b1", "b2", "a2"]);
  assertWaiting(fake, b3, "b3");
  assertWaiting(fake, c1, "c1");
});

// Extends "[concurrency-9] wrapping a limited provider again applies the
// tighter cap": the outer and inner wraps used side by side, with a destroy
// through the outer job freeing the inner wrap's slot first.
test("[concurrency-9] a destroy through the outer wrap frees the inner wrap's slot for its own oldest waiter", async () => {
  const fake = fakeProvider();
  const l1 = limitJobs(fake, 2);
  const l2 = limitJobs(l1, 1);
  const j1 = create(l2, "j1");
  await settle();
  create(l1, "k1");
  const k2 = create(l1, "k2");
  const j2 = create(l2, "j2");
  await settle();
  assert.deepEqual(fake.labels(), ["j1", "k1"]);
  assertWaiting(fake, k2, "k2");
  assertWaiting(fake, j2, "j2");
  const live = await admit(fake, j1, "j1");
  await close(live);
  assert.deepEqual(fake.labels(), ["j1", "k1", "k2"]);
  assertWaiting(fake, j2, "j2");
});

// Extends "[concurrency-9] wrapping a limited provider again ...": a job
// through two wraps keeps its id and environment and forwards its calls,
// and its destroy lets the next outer waiter through.
test("[concurrency-9] a job through two wraps forwards to the inner job and its destroy admits the next waiter", async () => {
  const fake = fakeProvider();
  const l2 = limitJobs(limitJobs(fake, 3), 1);
  const j1 = create(l2, "j1");
  const j2 = create(l2, "j2");
  await settle();
  assert.deepEqual(fake.labels(), ["j1"]);
  const live = await admit(fake, j1, "j1");
  assert.equal(live.job.id, "sandbox-eval-j1-1");
  assert.equal(live.job.environment, live.inner.environment);
  const command = { argv: ["npm", "test"] };
  const executed = live.job.exec(command);
  await settle();
  assert.equal(live.inner.execs.length, 1);
  assert.equal(nth(live.inner.execs, 0).args, command);
  const result = { ...okResult };
  nth(live.inner.execs, 0).resolve(result);
  assert.equal(await resolves(executed), result);
  assertWaiting(fake, j2, "j2");
  await close(live);
  assert.equal(live.inner.destroys.length, 1);
  assert.deepEqual(fake.labels(), ["j1", "j2"]);
});
