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

// --- unhappy-1: the metadata URI is not set ---------------------------------

// Extends "[unhappy-1] the older ECS_CONTAINER_METADATA_URI is not used in its place":
// near-miss key names, each pointing at a working endpoint.
test("[unhappy-1] near-miss key names are not used in place of the metadata URI", async (t) => {
  const endpoints = fakeEndpoints(t);
  const result = await resolveImageDigest({
    ECS_CONTAINER_METADATA_URI: URI_A,
    ecs_container_metadata_uri_v4: URI_B,
    ECS_CONTAINER_METADATA_URI_V3: URI_C,
    [`${KEY} `]: URI_C,
    METADATA_URI: URI_A,
    BUILD_SHA: "abc",
  });
  assert.equal(result, undefined);
  assert.equal(endpoints.requests.length, 0);
});

// Extends "[unhappy-1] the metadata URI is not set": the default process.env
// without the key makes no request, even with IMAGE_DIGEST present.
test("[unhappy-1] with no argument and the key absent from process.env no request is made", async (t) => {
  const endpoints = fakeEndpoints(t);
  await withProcessEnv({ [KEY]: undefined, IMAGE_DIGEST: DIGEST_C }, async () => {
    assert.equal(await resolveImageDigest(), undefined);
  });
  assert.equal(endpoints.requests.length, 0);
});

// Extends "[unhappy-1] the metadata URI is not set": a null-prototype env.
test("[unhappy-1] a null-prototype env without the key makes no request", async (t) => {
  const endpoints = fakeEndpoints(t);
  const env = Object.assign(Object.create(null) as NodeJS.ProcessEnv, { PORT: "4000" });
  assert.equal(await resolveImageDigest(env), undefined);
  assert.equal(endpoints.requests.length, 0);
});

// --- unhappy-2: the metadata URI is the empty string ------------------------

// Extends "[unhappy-2] the metadata URI is the empty string": with other keys
// that would supply a digest, and nothing on the console.
test("[unhappy-2] an empty URI alongside other usable keys makes no request and logs nothing", async (t) => {
  const endpoints = fakeEndpoints(t);
  const spies = silentConsole(t);
  const outcome = await settle(
    resolveImageDigest({
      [KEY]: "",
      ECS_CONTAINER_METADATA_URI: URI_A,
      IMAGE_DIGEST: DIGEST_C,
    }),
  );
  assert.deepEqual(outcome, { status: "fulfilled", value: undefined });
  assert.equal(endpoints.requests.length, 0);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

// Extends "[unhappy-2] the metadata URI is the empty string": repeated calls
// never make a request.
test("[unhappy-2] five calls with an empty URI make no request", async (t) => {
  const endpoints = fakeEndpoints(t);
  const env: NodeJS.ProcessEnv = { [KEY]: "" };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => resolveImageDigest(env)),
  );
  assert.deepEqual(results, [undefined, undefined, undefined, undefined, undefined]);
  assert.equal(endpoints.requests.length, 0);
});

// --- unhappy-3: the metadata URI is explicitly undefined --------------------

// Extends "[unhappy-3] the metadata URI is explicitly undefined": on a
// null-prototype env, with nothing on the console.
test("[unhappy-3] an explicitly undefined URI on a null-prototype env makes no request", async (t) => {
  const endpoints = fakeEndpoints(t);
  const spies = silentConsole(t);
  const env = Object.assign(Object.create(null) as NodeJS.ProcessEnv, {
    [KEY]: undefined,
    ECS_CONTAINER_METADATA_URI: URI_B,
  });
  assert.deepEqual(await settle(resolveImageDigest(env)), {
    status: "fulfilled",
    value: undefined,
  });
  assert.equal(endpoints.requests.length, 0);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

// --- unhappy-4: IMAGE_DIGEST alone is ignored -------------------------------

// Extends "[unhappy-4] IMAGE_DIGEST alone is ignored": other IMAGE_DIGEST
// values, including a reference form.
for (const value of [DIGEST_C, `sandbox-factory-api@${DIGEST_D}`]) {
  test(`[unhappy-4] IMAGE_DIGEST=${value.slice(0, 24)}… alone is ignored`, async (t) => {
    const endpoints = fakeEndpoints(t);
    assert.equal(await resolveImageDigest({ IMAGE_DIGEST: value }), undefined);
    assert.equal(endpoints.requests.length, 0);
  });
}

// Extends "[unhappy-4] IMAGE_DIGEST alone is ignored": through the default
// process.env.
test("[unhappy-4] IMAGE_DIGEST in process.env alone is ignored", async (t) => {
  const endpoints = fakeEndpoints(t);
  await withProcessEnv({ [KEY]: undefined, IMAGE_DIGEST: DIGEST_D }, async () => {
    assert.equal(await resolveImageDigest(), undefined);
  });
  assert.equal(endpoints.requests.length, 0);
});

// --- unhappy-5: the endpoint cannot be used ---------------------------------

/** Settles the call and checks it fulfilled with undefined and logged nothing. */
async function assertUnusable(
  t: TestContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const spies = silentConsole(t);
  const outcome = await settle(resolveImageDigest(env));
  assert.deepEqual(outcome, { status: "fulfilled", value: undefined });
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
}

// Extends "[unhappy-5] the endpoint cannot be used: non-2xx status" and
// "[unhappy-5] a 3xx status just outside 2xx": more statuses, each with a
// valid ImageID in the body, and exactly one request (no retry).
for (const code of [300, 301, 302, 307, 400, 401, 403, 418, 429, 502, 503, 504, 599]) {
  test(`[unhappy-5] a ${code} status with a valid ImageID resolves to undefined after one request`, async (t) => {
    const endpoints = fakeEndpoints(t, { [URI_A]: status(code, { ImageID: DIGEST_C }) });
    await assertUnusable(t, { [KEY]: URI_A });
    assert.deepEqual(endpoints.requests, [{ url: URI_A, method: "GET" }]);
  });
}

// Extends "[unhappy-5] the endpoint cannot be used: body is not JSON": the
// text is the digest itself, or JSON with extra text, or truncated JSON.
for (const [name, body] of [
  ["the bare digest as plain text", DIGEST_A],
  ["ImageID as a text line", `ImageID: ${DIGEST_A}`],
  ["an empty body", ""],
  ["truncated JSON", `{"ImageID":"${DIGEST_A}"`],
  ["JSON followed by extra text", `{"ImageID":"${DIGEST_A}"} trailing`],
  ["an HTML page", `<html><body>${DIGEST_A}</body></html>`],
  ["single-quoted pseudo-JSON", `{'ImageID':'${DIGEST_A}'}`],
] as const) {
  test(`[unhappy-5] the endpoint cannot be used: body is ${name}`, async (t) => {
    const endpoints = fakeEndpoints(t, { [URI_A]: text(body) });
    await assertUnusable(t, { [KEY]: URI_A });
    assert.equal(endpoints.requests.length, 1);
  });
}

// Extends "[unhappy-5] the endpoint cannot be used: body is JSON null": other
// JSON values that are not an object with ImageID.
for (const [name, body] of [
  ["a JSON string holding the digest", DIGEST_A],
  ["a JSON array holding an object with ImageID", [{ ImageID: DIGEST_A }]],
  ["a JSON array holding the digest", [DIGEST_A]],
  ["a JSON number", 42],
  ["JSON true", true],
  ["an empty object", {}],
] as const) {
  test(`[unhappy-5] the endpoint cannot be used: body is ${name}`, async (t) => {
    fakeEndpoints(t, { [URI_A]: ok(body) });
    await assertUnusable(t, { [KEY]: URI_A });
  });
}

// Extends "[unhappy-5] the endpoint cannot be used: no ImageID field": the
// digest is present, but not in a top-level field named exactly ImageID.
for (const [name, body] of [
  ["Image", { Image: `sandbox-factory-api@${DIGEST_A}` }],
  ["imageId", { imageId: DIGEST_A }],
  ["IMAGEID", { IMAGEID: DIGEST_A }],
  ["ImageId", { ImageId: DIGEST_A }],
  ["Labels.ImageID", { Labels: { ImageID: DIGEST_A } }],
  ["Containers[0].ImageID", { Containers: [{ ImageID: DIGEST_A }] }],
] as const) {
  test(`[unhappy-5] the endpoint cannot be used: the digest is only in ${name}`, async (t) => {
    fakeEndpoints(t, { [URI_A]: ok(body) });
    await assertUnusable(t, { [KEY]: URI_A });
  });
}

// Extends "[unhappy-5] the endpoint cannot be used: ImageID is not a string":
// other non-string types, some of which stringify to a valid digest.
for (const [name, value] of [
  ["null", null],
  ["true", true],
  ["false", false],
  ["0", 0],
  ["an array holding the digest", [DIGEST_A]],
  ["an object holding the digest", { digest: DIGEST_A }],
  ["an empty array", []],
] as const) {
  test(`[unhappy-5] the endpoint cannot be used: ImageID is ${name}`, async (t) => {
    fakeEndpoints(t, { [URI_A]: ok({ ImageID: value }) });
    await assertUnusable(t, { [KEY]: URI_A });
  });
}

// Extends "[unhappy-5] the endpoint cannot be used: body is not JSON": the
// connection drops while the body is being read.
test("[unhappy-5] the endpoint cannot be used: the body stream fails part way", async (t) => {
  fakeEndpoints(t, {
    [URI_A]: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`{"ImageID":"${DIGEST_A}`));
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  await assertUnusable(t, { [KEY]: URI_A });
});

// Extends "[unhappy-5] the endpoint cannot be used: not a URL": other
// strings that are not absolute URLs.
for (const uri of [
  "169.254.170.2/v4/task-a-container",
  "/v4/task-a-container",
  "://169.254.170.2/v4",
  "http://",
  "http://[::1",
  " ",
  "\t\n",
]) {
  test(`[unhappy-5] the endpoint cannot be used: ${JSON.stringify(uri)} is not a URL`, async (t) => {
    fakeEndpoints(t);
    await assertUnusable(t, { [KEY]: uri });
  });
}

// Extends "[unhappy-5] the endpoint cannot be used: connection refused": other
// unreachable URLs, and other network errors, each tried exactly once.
for (const uri of [
  "http://127.0.0.1:1/",
  "http://169.254.170.2/v4/unknown-container",
  `${URI_A}/task`,
]) {
  test(`[unhappy-5] the endpoint cannot be used: connection to ${uri} refused, one request`, async (t) => {
    const endpoints = fakeEndpoints(t);
    await assertUnusable(t, { [KEY]: uri });
    assert.deepEqual(endpoints.requests, [{ url: uri, method: "GET" }]);
  });
}

for (const [name, error] of [
  [
    "DNS lookup fails",
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    }),
  ],
  [
    "connection is reset",
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    }),
  ],
] as const) {
  test(`[unhappy-5] the endpoint cannot be used: ${name}`, async (t) => {
    const endpoints = fakeEndpoints(t, {
      [URI_A]: () => Promise.reject(error),
    });
    await assertUnusable(t, { [KEY]: URI_A });
    assert.equal(endpoints.requests.length, 1);
  });
}

// Extends "[unhappy-5] the endpoint cannot be used": IMAGE_DIGEST is not a
// fallback when the endpoint fails.
for (const [name, overrides, uri] of [
  ["a 500 response", { [URI_A]: status(500) }, URI_A],
  ["a refused connection", {}, URI_REFUSED],
  ["a non-JSON body", { [URI_A]: text("ok") }, URI_A],
  ["no ImageID field", { [URI_A]: ok({ Image: "api:latest" }) }, URI_A],
] as const) {
  test(`[unhappy-5] IMAGE_DIGEST is not used as a fallback after ${name}`, async (t) => {
    fakeEndpoints(t, overrides);
    await assertUnusable(t, { [KEY]: uri, IMAGE_DIGEST: DIGEST_C });
  });
}

// --- unhappy-6: an endpoint that never answers times out after 1000 ms ------

// Extends "[unhappy-6] an endpoint that never answers times out after 1000 ms":
// it has settled once the clock reaches 1000 ms, not later.
test("[unhappy-6] an endpoint that never answers has settled by exactly 1000 ms", async (t) => {
  const endpoints = fakeEndpoints(t, { [URI_A]: () => NEVER });
  mockClock(t);
  const spies = silentConsole(t);
  let outcome: Settled | undefined;
  void settle(resolveImageDigest({ [KEY]: URI_A })).then((o) => {
    outcome = o;
  });
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(outcome, { status: "fulfilled", value: undefined });
  assert.deepEqual(endpoints.requests, [{ url: URI_A, method: "GET" }]);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

// Extends "[unhappy-6] an endpoint that never answers is still pending at 999 ms":
// a response that arrives at 999 ms is used, so the timeout is not shorter.
test("[unhappy-6] a response arriving at 999 ms is not cut off by the timeout", async (t) => {
  fakeEndpoints(t, {
    [URI_A]: () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(Response.json({ ImageID: DIGEST_C })), 999);
      }),
  });
  mockClock(t);
  let outcome: Settled | undefined;
  void settle(resolveImageDigest({ [KEY]: URI_A })).then((o) => {
    outcome = o;
  });
  await flush();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(outcome, undefined);
  t.mock.timers.tick(499);
  await flush();
  assert.deepEqual(outcome, { status: "fulfilled", value: DIGEST_C });
});

// Extends "[unhappy-6] an endpoint that never answers times out after 1000 ms":
// a slow endpoint behind a reference still times out, and only for that call.
test("[unhappy-6] a hanging call times out while a call to a live endpoint resolves", async (t) => {
  fakeEndpoints(t, { [URI_A]: () => NEVER });
  mockClock(t);
  let hung: Settled | undefined;
  void settle(resolveImageDigest({ [KEY]: URI_A })).then((o) => {
    hung = o;
  });
  assert.equal(await resolveImageDigest({ [KEY]: URI_C }), DIGEST_C);
  assert.equal(hung, undefined);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(hung, { status: "fulfilled", value: undefined });
});
