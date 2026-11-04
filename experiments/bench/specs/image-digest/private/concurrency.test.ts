import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";

import { resolveImageDigest } from "../../src/image-digest.js";

const DIGEST_A =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DIGEST_B =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
/** Digests the public suite never uses, so a hard-coded answer cannot pass. */
const DIGEST_C = `sha256:${createHash("sha256").update("hidden image c").digest("hex")}`;
const DIGEST_D = `sha256:${createHash("sha256").update("hidden image d").digest("hex")}`;
const HEX64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const URI_A = "http://169.254.170.2/v4/task-a-container";
const URI_B = "http://169.254.170.2/v4/task-b-container";
const URI_C = "http://169.254.170.2:51678/v4/9c1d2e3f-hidden-container";
/** Nothing is routed here, so the fake refuses the connection. */
const URI_REFUSED = "http://127.0.0.1:9/v4/nothing-listens";

const KEY = "ECS_CONTAINER_METADATA_URI_V4";

/** Never settles; the fake fetch rejects it only when the request is aborted. */
const NEVER = Symbol("never responds");

type Handler = () => Response | Promise<Response> | typeof NEVER;

interface FakeRequest {
  url: string;
  method: string;
}

interface FakeEndpoints {
  routes: Map<string, Handler>;
  requests: FakeRequest[];
}

function ok(body: unknown): Handler {
  return () => Response.json(body, { status: 200 });
}

function status(code: number, body: unknown = { ImageID: DIGEST_A }): Handler {
  return () => Response.json(body, { status: code });
}

function text(body: string, code = 200): Handler {
  return () => new Response(body, { status: code });
}

/**
 * Replaces the global `fetch` for one test. URI_A, URI_B and URI_C answer
 * 200 with DIGEST_A, DIGEST_B and DIGEST_C unless overridden; any other URL
 * is a refused connection.
 */
function fakeEndpoints(
  t: TestContext,
  overrides: Record<string, Handler> = {},
): FakeEndpoints {
  const routes = new Map<string, Handler>([
    [URI_A, ok({ ImageID: DIGEST_A })],
    [URI_B, ok({ ImageID: DIGEST_B })],
    [URI_C, ok({ ImageID: DIGEST_C })],
  ]);
  for (const [url, handler] of Object.entries(overrides)) {
    routes.set(url, handler);
  }
  const requests: FakeRequest[] = [];
  const fake = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input, init);
    requests.push({ url: req.url, method: req.method });
    const signal = req.signal;
    if (signal.aborted) throw signal.reason;
    const handler = routes.get(req.url);
    if (handler === undefined) {
      const cause = Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
      throw new TypeError("fetch failed", { cause });
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    aborted.catch(() => {});
    const res = handler();
    if (res === NEVER) return aborted;
    return Promise.race([Promise.resolve(res), aborted]);
  };
  t.mock.method(globalThis, "fetch", fake);
  return { routes, requests };
}

/** Replaces the console methods so a test can check nothing was written. */
function silentConsole(t: TestContext) {
  return [
    t.mock.method(console, "log", () => {}),
    t.mock.method(console, "info", () => {}),
    t.mock.method(console, "warn", () => {}),
    t.mock.method(console, "error", () => {}),
    t.mock.method(console, "debug", () => {}),
    t.mock.method(console, "trace", () => {}),
  ];
}

type Settled =
  | { status: "fulfilled"; value: string | undefined }
  | { status: "rejected"; reason: unknown };

async function settle(p: Promise<string | undefined>): Promise<Settled> {
  try {
    return { status: "fulfilled", value: await p };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/** Lets pending promise callbacks run. setImmediate is never mocked here. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Mocks `setTimeout`, and replaces `AbortSignal.timeout` with one built on
 * the mocked `setTimeout`, so the 1000 ms timeout runs on a fake clock.
 */
function mockClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
    }, ms);
    return controller.signal;
  });
}

/** Sets process.env keys for the duration of `body`, restoring them after. */
async function withProcessEnv(
  values: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    saved.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
  }
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A promise with its resolve function exposed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// --- concurrency-1: changing env after the call -----------------------------

// Extends "[concurrency-1] changing env after the call does not change the pending result":
// other changes made after the call: emptied, pointed at a failing endpoint,
// redefined, or replaced by IMAGE_DIGEST.
for (const [name, change] of [
  ["emptied", (env: NodeJS.ProcessEnv) => { env[KEY] = ""; }],
  ["pointed at a refused URL", (env: NodeJS.ProcessEnv) => { env[KEY] = URI_REFUSED; }],
  ["pointed at an invalid URL", (env: NodeJS.ProcessEnv) => { env[KEY] = "not a url"; }],
  [
    "redefined with defineProperty",
    (env: NodeJS.ProcessEnv) => {
      Object.defineProperty(env, KEY, { value: URI_B, enumerable: true, configurable: true, writable: true });
    },
  ],
  [
    "deleted with IMAGE_DIGEST added",
    (env: NodeJS.ProcessEnv) => {
      delete env[KEY];
      env["IMAGE_DIGEST"] = DIGEST_B;
    },
  ],
] as const) {
  test(`[concurrency-1] the URI ${name} after the call does not change the pending result`, async (t) => {
    const endpoints = fakeEndpoints(t);
    const env: NodeJS.ProcessEnv = { [KEY]: URI_C };
    const pending = resolveImageDigest(env);
    change(env);
    assert.equal(await pending, DIGEST_C);
    assert.deepEqual(endpoints.requests, [{ url: URI_C, method: "GET" }]);
  });
}

// Extends "[concurrency-1] changing env after the call does not change the pending result":
// the URI is read exactly once, before the call returns.
test("[concurrency-1] the metadata URI is read once, synchronously, during the call", async (t) => {
  fakeEndpoints(t);
  let reads = 0;
  const env = new Proxy<NodeJS.ProcessEnv>(
    { [KEY]: URI_C },
    {
      get(obj, prop, receiver) {
        if (prop === KEY) reads += 1;
        return Reflect.get(obj, prop, receiver);
      },
    },
  );
  const pending = resolveImageDigest(env);
  assert.equal(reads, 1);
  assert.equal(await pending, DIGEST_C);
  assert.equal(reads, 1);
});

// Extends "[concurrency-1] changing env after the call does not change the pending result":
// a value that changes on every read; only the first read may be used.
test("[concurrency-1] a URI that changes on each read is used as first read", async (t) => {
  const endpoints = fakeEndpoints(t);
  const values = [URI_C, URI_B, URI_A];
  let index = 0;
  const env: NodeJS.ProcessEnv = {};
  Object.defineProperty(env, KEY, {
    enumerable: true,
    get: () => values[Math.min(index++, values.length - 1)],
  });
  assert.equal(await resolveImageDigest(env), DIGEST_C);
  assert.deepEqual(endpoints.requests, [{ url: URI_C, method: "GET" }]);
});

// Extends "[concurrency-1] changing env after the call does not change the pending result":
// the same holds for the default process.env.
test("[concurrency-1] changing process.env after a no-argument call does not change its result", async (t) => {
  fakeEndpoints(t);
  await withProcessEnv({ [KEY]: URI_C }, async () => {
    const pending = resolveImageDigest();
    process.env[KEY] = URI_A;
    const later = resolveImageDigest();
    delete process.env[KEY];
    assert.deepEqual(await Promise.all([pending, later]), [DIGEST_C, DIGEST_A]);
  });
});

// --- concurrency-2: overlapping calls see their own env ---------------------

// Extends "[concurrency-2] overlapping calls each see the environment as it was when they were made":
// a longer sequence of changes, including the empty string.
test("[concurrency-2] eight overlapping calls each see the env as it was when made", async (t) => {
  const endpoints = fakeEndpoints(t);
  const env: NodeJS.ProcessEnv = {};
  const calls: Promise<string | undefined>[] = [];
  const steps: Array<string | undefined> = [URI_C, URI_A, undefined, URI_B, "", URI_A, URI_REFUSED, URI_C];
  for (const uri of steps) {
    if (uri === undefined) delete env[KEY];
    else env[KEY] = uri;
    calls.push(resolveImageDigest(env));
  }
  delete env[KEY];
  assert.deepEqual(await Promise.all(calls), [
    DIGEST_C,
    DIGEST_A,
    undefined,
    DIGEST_B,
    undefined,
    DIGEST_A,
    undefined,
    DIGEST_C,
  ]);
  assert.deepEqual(
    endpoints.requests.map((r) => r.url).sort(),
    [URI_C, URI_A, URI_B, URI_A, URI_REFUSED, URI_C].sort(),
  );
});

// Extends "[concurrency-2] overlapping calls each see the environment as it was when they were made":
// the first call's endpoint answers last, so results cannot be matched up by
// completion order.
test("[concurrency-2] overlapping calls keep their own results when answers arrive out of order", async (t) => {
  const gate = deferred<void>();
  fakeEndpoints(t, {
    [URI_A]: () => gate.promise.then(() => Response.json({ ImageID: DIGEST_A })),
  });
  const env: NodeJS.ProcessEnv = { [KEY]: URI_A };
  const p1 = resolveImageDigest(env);
  env[KEY] = URI_B;
  const p2 = resolveImageDigest(env);
  delete env[KEY];
  const p3 = resolveImageDigest(env);
  assert.deepEqual(await Promise.all([p2, p3]), [DIGEST_B, undefined]);
  gate.resolve();
  assert.deepEqual(await Promise.all([p1, p2, p3]), [DIGEST_A, DIGEST_B, undefined]);
});

// --- concurrency-3: concurrent calls on the same env ------------------------

// Extends "[concurrency-3] concurrent calls on the same environment agree and each make their own request":
// more calls, on a digest the public suite never uses.
test("[concurrency-3] 40 concurrent calls agree and make 40 requests", async (t) => {
  const endpoints = fakeEndpoints(t);
  const env: NodeJS.ProcessEnv = { [KEY]: URI_C };
  const results = await Promise.all(
    Array.from({ length: 40 }, () => resolveImageDigest(env)),
  );
  assert.deepEqual(results, Array.from({ length: 40 }, () => DIGEST_C));
  assert.equal(endpoints.requests.length, 40);
  for (const r of endpoints.requests) {
    assert.deepEqual(r, { url: URI_C, method: "GET" });
  }
});

// Extends "[concurrency-3] concurrent calls on the same environment agree and each make their own request":
// each call uses its own response, so in-flight sharing shows up in the results.
test("[concurrency-3] concurrent calls each use the answer to their own request", async (t) => {
  let served = 0;
  const endpoints = fakeEndpoints(t, {
    [URI_B]: () => {
      served += 1;
      return Response.json({ ImageID: served <= 4 ? DIGEST_B : DIGEST_D });
    },
  });
  const env: NodeJS.ProcessEnv = { [KEY]: URI_B };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => resolveImageDigest(env)),
  );
  assert.equal(endpoints.requests.length, 10);
  assert.deepEqual(
    [...results].sort(),
    [...Array(4).fill(DIGEST_B), ...Array(6).fill(DIGEST_D)].sort(),
  );
});

// Extends "[concurrency-3] sequential calls each make their own request":
// separate env objects with the same URI share nothing either.
test("[concurrency-3] calls on separate env objects with the same URI each make a request", async (t) => {
  const endpoints = fakeEndpoints(t);
  for (let i = 0; i < 6; i++) {
    assert.equal(await resolveImageDigest({ [KEY]: URI_C }), DIGEST_C);
  }
  assert.equal(endpoints.requests.length, 6);
});

// --- concurrency-4: a later call sees a changed endpoint response -----------

// Extends "[concurrency-4] a later call sees a changed endpoint response":
// several changes in a row, including to an unseen digest and back.
test("[concurrency-4] each later call sees the endpoint's current response", async (t) => {
  const endpoints = fakeEndpoints(t);
  const env: NodeJS.ProcessEnv = { [KEY]: URI_A };
  const sequence: Array<readonly [Handler, string | undefined]> = [
    [ok({ ImageID: DIGEST_A }), DIGEST_A],
    [ok({ ImageID: DIGEST_C }), DIGEST_C],
    [ok({ ImageID: "unknown" }), undefined],
    [ok({ ImageID: `api@${DIGEST_D}` }), DIGEST_D],
    [ok({ ImageID: DIGEST_A }), DIGEST_A],
  ];
  for (const [handler, expected] of sequence) {
    endpoints.routes.set(URI_A, handler);
    assert.equal(await resolveImageDigest(env), expected);
  }
  assert.equal(endpoints.requests.length, sequence.length);
});

// Extends "[concurrency-4] a later call sees an endpoint that has started failing":
// the reverse, a failure is not remembered once the endpoint recovers.
for (const [name, failing] of [
  ["a 500 response", status(500)],
  ["a non-JSON body", text("ok")],
  ["a refused connection", undefined],
] as const) {
  test(`[concurrency-4] a later call sees an endpoint that recovered from ${name}`, async (t) => {
    const endpoints = fakeEndpoints(t);
    if (failing === undefined) endpoints.routes.delete(URI_C);
    else endpoints.routes.set(URI_C, failing);
    const env: NodeJS.ProcessEnv = { [KEY]: URI_C };
    assert.equal(await resolveImageDigest(env), undefined);
    endpoints.routes.set(URI_C, ok({ ImageID: DIGEST_C }));
    assert.equal(await resolveImageDigest(env), DIGEST_C);
  });
}

// Extends "[concurrency-4] a later call sees a changed endpoint response":
// after a timeout, a later call to the same, now answering, endpoint resolves.
test("[concurrency-4] a later call sees an endpoint that answers after an earlier timeout", async (t) => {
  const endpoints = fakeEndpoints(t, { [URI_A]: () => NEVER });
  mockClock(t);
  const env: NodeJS.ProcessEnv = { [KEY]: URI_A };
  let first: Settled | undefined;
  void settle(resolveImageDigest(env)).then((o) => {
    first = o;
  });
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(first, { status: "fulfilled", value: undefined });
  endpoints.routes.set(URI_A, ok({ ImageID: DIGEST_D }));
  assert.equal(await resolveImageDigest(env), DIGEST_D);
});
