import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";

import { type BuildInfoDto } from "@sandbox-factory/shared";

import { buildInfo, parseEnv } from "../../src/env.js";
import { createApp } from "../../src/routes.js";
import { createInMemoryStore } from "../../src/store.js";
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


// --- happy-1: the digest reported by the runtime is returned verbatim -------

// Extends "[happy-1] the digest reported by the runtime is returned verbatim":
// another URI and a digest the public suite never uses.
test("[happy-1] a digest not seen in the public suite is returned from another URI", async (t) => {
  const endpoints = fakeEndpoints(t);
  const result = await resolveImageDigest({ [KEY]: URI_C });
  assert.deepEqual(endpoints.requests, [{ url: URI_C, method: "GET" }]);
  assert.equal(result, DIGEST_C);
});

// Extends "[happy-1] the digest reported by the runtime is returned verbatim":
// the request goes to whatever URI is set, not a fixed or derived one.
test("[happy-1] the URI is used exactly as given, with port, path and query", async (t) => {
  const uri = "http://10.0.3.17:8080/v4/abc-123/container?x=1&y=two";
  const endpoints = fakeEndpoints(t, { [uri]: ok({ ImageID: DIGEST_D }) });
  const result = await resolveImageDigest({ [KEY]: uri });
  assert.deepEqual(endpoints.requests, [{ url: uri, method: "GET" }]);
  assert.equal(result, DIGEST_D);
});

// Extends "[happy-1] the digest reported by the runtime is returned verbatim":
// a 2xx status other than 200 is still a success.
for (const code of [201, 202, 203, 206, 299]) {
  test(`[happy-1] a ${code} response with a valid ImageID resolves to the digest`, async (t) => {
    const endpoints = fakeEndpoints(t, {
      [URI_A]: status(code, { ImageID: DIGEST_C }),
    });
    assert.equal(await resolveImageDigest({ [KEY]: URI_A }), DIGEST_C);
    assert.equal(endpoints.requests.length, 1);
  });
}

// Extends "[happy-1] the digest reported by the runtime is returned verbatim":
// the edges of the hex alphabet are all accepted.
for (const hex of ["0".repeat(64), "9".repeat(64), "a".repeat(64), "f".repeat(64)]) {
  test(`[happy-1] the digest sha256:${hex.slice(0, 4)}… made of one hex character is accepted`, async (t) => {
    fakeEndpoints(t, { [URI_A]: ok({ ImageID: `sha256:${hex}` }) });
    assert.equal(await resolveImageDigest({ [KEY]: URI_A }), `sha256:${hex}`);
  });
}

// Extends "[happy-1] the digest reported by the runtime is returned verbatim":
// the value comes from the parsed JSON, not from the raw text of the body.
test("[happy-1] an ImageID written with JSON escapes resolves to the decoded digest", async (t) => {
  // Digits first, so the colon's escape is not itself rewritten.
  const escaped = DIGEST_A.replace(/0/g, "\\u0030").replace(":", "\\u003a");
  fakeEndpoints(t, {
    [URI_A]: () =>
      new Response(`{"ImageID":"${escaped}"}`, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.equal(await resolveImageDigest({ [KEY]: URI_A }), DIGEST_A);
});

// Extends "[happy-1] the digest reported by the runtime is returned verbatim":
// nothing is written to the console on success either.
test("[happy-1] resolving a digest writes nothing to the console", async (t) => {
  fakeEndpoints(t);
  const spies = silentConsole(t);
  assert.equal(await resolveImageDigest({ [KEY]: URI_B }), DIGEST_B);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

// --- happy-2: other keys in the environment do not affect the result --------

// Extends "[happy-2] other keys in the environment do not affect the result":
// IMAGE_DIGEST disagrees with the endpoint, among many other keys.
test("[happy-2] many other keys, including a conflicting IMAGE_DIGEST, do not affect the result", async (t) => {
  fakeEndpoints(t);
  const env: NodeJS.ProcessEnv = {
    IMAGE_DIGEST: DIGEST_B,
    ECS_CONTAINER_METADATA_URI: URI_B,
    ecs_container_metadata_uri_v4: URI_B,
    BUILD_SHA: "7f3a9c1e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a",
    BUILD_VERSION: "1.4.2",
    PORT: "4000",
    NODE_ENV: "production",
    [KEY]: URI_C,
  };
  for (let i = 0; i < 50; i++) env[`EXTRA_${i}`] = DIGEST_D;
  assert.equal(await resolveImageDigest(env), DIGEST_C);
});

// Extends "[happy-2] no key of env other than the metadata URI is read":
// the env is not copied, enumerated or probed for other keys.
test("[happy-2] the env is not enumerated and no other key is touched", async (t) => {
  fakeEndpoints(t);
  const target: NodeJS.ProcessEnv = {
    [KEY]: URI_C,
    IMAGE_DIGEST: DIGEST_A,
    BUILD_SHA: "abc",
  };
  const touched: string[] = [];
  const guard = (prop: string | symbol) => {
    if (typeof prop === "string" && prop !== KEY) {
      touched.push(prop);
      throw new Error(`env.${prop} must not be read`);
    }
  };
  const env = new Proxy(target, {
    get(obj, prop, receiver) {
      guard(prop);
      return Reflect.get(obj, prop, receiver);
    },
    has(obj, prop) {
      guard(prop);
      return Reflect.has(obj, prop);
    },
    getOwnPropertyDescriptor(obj, prop) {
      guard(prop);
      return Reflect.getOwnPropertyDescriptor(obj, prop);
    },
    ownKeys() {
      touched.push("<ownKeys>");
      throw new Error("env must not be enumerated");
    },
  });
  assert.equal(await resolveImageDigest(env), DIGEST_C);
  assert.deepEqual(touched, []);
});

// --- happy-3: other fields in the metadata body do not affect the result ----

// Extends "[happy-3] a digest in a field other than ImageID is not used":
// ImageID comes first and later fields carry other digests.
test("[happy-3] ImageID is used even when later fields carry other digests", async (t) => {
  fakeEndpoints(t, {
    [URI_A]: ok({
      ImageID: DIGEST_C,
      Image: `sandbox-factory-api@${DIGEST_A}`,
      Digest: DIGEST_B,
      Labels: { "com.example.digest": DIGEST_D, ImageID: DIGEST_D },
      Containers: [{ ImageID: DIGEST_A }],
    }),
  });
  assert.equal(await resolveImageDigest({ [KEY]: URI_A }), DIGEST_C);
});

// Extends "[happy-3] other fields in the metadata body do not affect the result":
// a realistic, larger ECS v4 container metadata document.
test("[happy-3] a full ECS container metadata document resolves to its ImageID", async (t) => {
  fakeEndpoints(t, {
    [URI_A]: ok({
      DockerId: "ea32192c8553fbff06c9340478a2ff089b2bb5646fb718b4ee206641c9086d66",
      Name: "api",
      DockerName: "ecs-sandbox-factory-api-1-api-a0b1c2d3e4f5",
      Image: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/sandbox-factory-api:latest",
      ImageID: DIGEST_D,
      Labels: {
        "com.amazonaws.ecs.cluster": "sandbox-factory",
        "com.amazonaws.ecs.task-definition-version": "17",
      },
      DesiredStatus: "RUNNING",
      KnownStatus: "RUNNING",
      Limits: { CPU: 256, Memory: 512 },
      CreatedAt: "2026-11-01T12:00:00.000Z",
      StartedAt: "2026-11-01T12:00:01.000Z",
      Type: "NORMAL",
      Networks: [{ NetworkMode: "awsvpc", IPv4Addresses: ["10.0.3.17"] }],
      ContainerARN: "arn:aws:ecs:eu-west-1:123456789012:container/abc",
      LogDriver: "awslogs",
    }),
  });
  assert.equal(await resolveImageDigest({ [KEY]: URI_A }), DIGEST_D);
});

// --- happy-4: an image reference with the digest appended -------------------

// Extends "[happy-4] an ECR reference with the digest appended is reduced to the digest":
// a digest the public suite never uses, so the answer cannot be hard-coded.
test("[happy-4] an ECR reference with another digest appended is reduced to that digest", async (t) => {
  fakeEndpoints(t, {
    [URI_A]: ok({
      ImageID: `123456789012.dkr.ecr.us-east-1.amazonaws.com/team/sandbox-factory-api@${DIGEST_C}`,
    }),
  });
  assert.equal(await resolveImageDigest({ [KEY]: URI_A }), DIGEST_C);
});

// Extends "[happy-4] with more than one @ only the part after the last one is kept":
// both parts are valid digests, so only the last-@ rule picks the right one.
test("[happy-4] when two digests are joined by @, the one after the last @ is returned", async (t) => {
  fakeEndpoints(t, {
    [URI_A]: ok({ ImageID: `sandbox-factory-api@${DIGEST_A}@${DIGEST_B}` }),
  });
  assert.equal(await resolveImageDigest({ [KEY]: URI_A }), DIGEST_B);
});

// Extends "[happy-4] with more than one @ only the part after the last one is kept":
// more @ signs than the public case.
test("[happy-4] with four @ signs only the part after the last one is kept", async (t) => {
  fakeEndpoints(t, {
    [URI_A]: ok({ ImageID: `a@b@c:1@registry/x@${DIGEST_D}` }),
  });
  assert.equal(await resolveImageDigest({ [KEY]: URI_A }), DIGEST_D);
});

// Extends "[happy-4] a tagged reference with the digest appended is reduced to the digest":
// nothing before the @.
test("[happy-4] an ImageID that is @ followed by a digest is reduced to the digest", async (t) => {
  fakeEndpoints(t, { [URI_A]: ok({ ImageID: `@${DIGEST_C}` }) });
  assert.equal(await resolveImageDigest({ [KEY]: URI_A }), DIGEST_C);
});

// Extends "[happy-4] a tagged reference with the digest appended is reduced to the digest":
// a docker-pullable reference as some runtimes report it.
test("[happy-4] a docker-pullable reference with a digest is reduced to the digest", async (t) => {
  fakeEndpoints(t, {
    [URI_A]: ok({ ImageID: `docker-pullable://registry.example:5000/api:v2@${DIGEST_B}` }),
  });
  assert.equal(await resolveImageDigest({ [KEY]: URI_A }), DIGEST_B);
});

// --- happy-5: the result is a Promise ---------------------------------------

// Extends "[happy-5] the result is a Promise that resolves to the digest":
// the failure paths also return a Promise and do not throw synchronously.
for (const [name, env, overrides] of [
  ["a 500 response", { [KEY]: URI_A }, { [URI_A]: status(500) }],
  ["an invalid URI", { [KEY]: "::not a url::" }, {}],
  ["a refused connection", { [KEY]: URI_REFUSED }, {}],
  ["an empty URI", { [KEY]: "" }, {}],
  ["an invalid ImageID", { [KEY]: URI_A }, { [URI_A]: ok({ ImageID: "unknown" }) }],
] as const) {
  test(`[happy-5] the result is a Promise resolving to undefined for ${name}`, async (t) => {
    fakeEndpoints(t, overrides);
    let pending: Promise<string | undefined> | undefined;
    assert.doesNotThrow(() => {
      pending = resolveImageDigest({ ...env });
    });
    assert.ok(pending instanceof Promise);
    assert.deepEqual(await settle(pending), { status: "fulfilled", value: undefined });
  });
}

// Extends "[happy-5] the result is a Promise that resolves to the digest":
// another digest, through a reference.
test("[happy-5] the result is a Promise resolving to a digest taken from a reference", async (t) => {
  fakeEndpoints(t, { [URI_B]: ok({ ImageID: `api:1@${DIGEST_D}` }) });
  const pending = resolveImageDigest({ [KEY]: URI_B });
  assert.ok(pending instanceof Promise);
  assert.equal(await pending, DIGEST_D);
});

// --- happy-6: with no argument the resolver reads process.env ---------------

// Extends "[happy-6] with no argument the resolver reads process.env":
// another URI and digest, set only after the module was loaded.
test("[happy-6] with no argument process.env is read at call time", async (t) => {
  const endpoints = fakeEndpoints(t);
  await withProcessEnv({ [KEY]: URI_C, IMAGE_DIGEST: undefined }, async () => {
    assert.equal(await resolveImageDigest(), DIGEST_C);
    process.env[KEY] = URI_B;
    assert.equal(await resolveImageDigest(), DIGEST_B);
    delete process.env[KEY];
    assert.equal(await resolveImageDigest(), undefined);
  });
  assert.deepEqual(endpoints.requests, [
    { url: URI_C, method: "GET" },
    { url: URI_B, method: "GET" },
  ]);
});

// Extends "[happy-6] with no argument the resolver reads process.env":
// an explicit undefined argument falls back to process.env as well.
test("[happy-6] an explicit undefined argument reads process.env", async (t) => {
  fakeEndpoints(t);
  await withProcessEnv({ [KEY]: URI_C }, async () => {
    assert.equal(await resolveImageDigest(undefined), DIGEST_C);
  });
});

// --- happy-7: the input environment is left unchanged -----------------------

// Extends "[happy-7] the input environment is left unchanged":
// no write, define or delete reaches env, on success or failure.
for (const [name, overrides, expected] of [
  ["on success", {}, DIGEST_C],
  ["when the body is not JSON", { [URI_C]: text("ok") }, undefined],
  ["when ImageID is invalid", { [URI_C]: ok({ ImageID: "unknown" }) }, undefined],
] as const) {
  test(`[happy-7] env receives no writes ${name}`, async (t) => {
    fakeEndpoints(t, overrides);
    const target: NodeJS.ProcessEnv = { [KEY]: URI_C, BUILD_SHA: "abc", IMAGE_DIGEST: DIGEST_A };
    const writes: string[] = [];
    const env = new Proxy(target, {
      set(obj, prop, value, receiver) {
        writes.push(`set ${String(prop)}`);
        return Reflect.set(obj, prop, value, receiver);
      },
      defineProperty(obj, prop, desc) {
        writes.push(`define ${String(prop)}`);
        return Reflect.defineProperty(obj, prop, desc);
      },
      deleteProperty(obj, prop) {
        writes.push(`delete ${String(prop)}`);
        return Reflect.deleteProperty(obj, prop);
      },
      setPrototypeOf(obj, proto) {
        writes.push("setPrototypeOf");
        return Reflect.setPrototypeOf(obj, proto);
      },
    });
    assert.equal(await resolveImageDigest(env), expected);
    assert.deepEqual(writes, []);
    assert.deepEqual(target, { [KEY]: URI_C, BUILD_SHA: "abc", IMAGE_DIGEST: DIGEST_A });
  });
}

// Extends "[happy-7] the input environment is left unchanged":
// a frozen env works, so nothing needs to write to it.
test("[happy-7] a frozen env resolves the digest and stays as it was", async (t) => {
  fakeEndpoints(t);
  const env: NodeJS.ProcessEnv = Object.freeze({ [KEY]: URI_B, BUILD_SHA: "abc" });
  assert.deepEqual(await settle(resolveImageDigest(env)), {
    status: "fulfilled",
    value: DIGEST_B,
  });
  assert.deepEqual(env, { [KEY]: URI_B, BUILD_SHA: "abc" });
});

// Extends "[happy-7] the input environment is left unchanged":
// process.env is not changed when it is the default.
test("[happy-7] process.env is left unchanged when used as the default", async (t) => {
  fakeEndpoints(t);
  await withProcessEnv({ [KEY]: URI_A, IMAGE_DIGEST: undefined }, async () => {
    const before = { ...process.env };
    assert.equal(await resolveImageDigest(), DIGEST_A);
    assert.deepEqual({ ...process.env }, before);
  });
});

// --- happy-8: parseEnv neither validates nor keeps the metadata URI ---------

/** The required variables from env.test.ts. */
const required = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4000",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  ATLASSIAN_CLIENT_ID: "atlassian-client-id",
  ATLASSIAN_CLIENT_SECRET: "atlassian-client-secret",
};

// Extends "[happy-8] parseEnv neither validates nor keeps the metadata URI":
// the parsed Env no longer carries the URI, so resolving from it makes no
// request, while the raw env still resolves.
test("[happy-8] the Env from parseEnv carries no metadata URI for the resolver to use", async (t) => {
  const endpoints = fakeEndpoints(t);
  const raw: NodeJS.ProcessEnv = { ...required, [KEY]: URI_C, IMAGE_DIGEST: "not-a-digest" };
  assert.equal(await resolveImageDigest(raw), DIGEST_C);
  const parsed = parseEnv(raw);
  assert.equal(Object.hasOwn(parsed, KEY), false);
  assert.equal(Object.hasOwn(parsed, "IMAGE_DIGEST"), false);
  assert.equal(
    await resolveImageDigest(parsed as unknown as NodeJS.ProcessEnv),
    undefined,
  );
  assert.equal(endpoints.requests.length, 1);
});

// Extends "[happy-8] parseEnv drops a well-formed metadata URI and digest too":
// other values (empty, whitespace, garbage) change nothing in the parsed Env.
for (const [uri, digest] of [
  ["", ""],
  ["   ", "  sha256:  "],
  ["::::", DIGEST_D],
] as const) {
  test(`[happy-8] parseEnv ignores ${KEY}=${JSON.stringify(uri)} and IMAGE_DIGEST=${JSON.stringify(digest)}`, async (t) => {
    fakeEndpoints(t);
    const raw: NodeJS.ProcessEnv = { ...required, [KEY]: uri, IMAGE_DIGEST: digest };
    assert.equal(await resolveImageDigest(raw), undefined);
    assert.deepEqual(parseEnv(raw), parseEnv(required));
  });
}

// --- happy-9 / happy-10: GET /version ---------------------------------------

/** The record the server entry point hands to createApp. */
type BuildRecord = BuildInfoDto & { imageDigest?: string | undefined };

function versionApp(record: BuildRecord) {
  return createApp({
    store: createInMemoryStore([]),
    corsOrigins: ["http://localhost:5173"],
    buildInfo: record,
  });
}

const provenance = {
  BUILD_VERSION: "2.0.0-rc.1",
  BUILD_SHA: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
  BUILD_TIME: "2026-10-30T08:15:00Z",
  BUILD_REF: "release/2.0",
  BUILD_DIRTY: "true",
};

// Extends "[happy-9] GET /version has no imageDigest key when it is undefined in the record":
// the record is built the way the entry point builds it, with a resolver that
// found nothing.
for (const [name, env, overrides] of [
  ["no metadata URI", {}, {}],
  ["a failing endpoint", { [KEY]: URI_A }, { [URI_A]: status(503) }],
  ["an invalid ImageID", { [KEY]: URI_A }, { [URI_A]: ok({ ImageID: "sha256:" }) }],
] as const) {
  test(`[happy-9] GET /version returns the build record without imageDigest for ${name}`, async (t) => {
    fakeEndpoints(t, overrides);
    const raw: NodeJS.ProcessEnv = { ...required, ...provenance, ...env };
    const info = buildInfo(parseEnv(raw));
    const record: BuildRecord = { ...info, imageDigest: await resolveImageDigest(raw) };
    const res = await versionApp(record).request("/version");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      version: "2.0.0-rc.1",
      gitSha: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
      gitShortSha: "0a1b2c3",
      buildTime: "2026-10-30T08:15:00Z",
      gitRef: "release/2.0",
      dirty: true,
    });
    assert.equal(Object.hasOwn(body, "imageDigest"), false);
  });
}

// Extends "[happy-10] GET /version passes an imageDigest in the build record through unchanged":
// the digest comes from the resolver, as at boot, and is one the public suite
// never uses.
test("[happy-10] GET /version reports the digest the resolver found", async (t) => {
  fakeEndpoints(t, { [URI_A]: ok({ ImageID: `api@${DIGEST_D}` }) });
  const raw: NodeJS.ProcessEnv = { ...required, ...provenance, [KEY]: URI_A };
  const info = buildInfo(parseEnv(raw));
  const record: BuildRecord = { ...info, imageDigest: await resolveImageDigest(raw) };
  const res = await versionApp(record).request("/version");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ...info, imageDigest: DIGEST_D });
});

// Extends "[happy-10] GET /version passes an imageDigest in the build record through unchanged":
// the unknown build record with a resolved digest.
test("[happy-10] GET /version passes a resolved digest through on the unknown build record", async (t) => {
  fakeEndpoints(t);
  const info = buildInfo(parseEnv(required));
  const record: BuildRecord = { ...info, imageDigest: await resolveImageDigest({ [KEY]: URI_C }) };
  const res = await versionApp(record).request("/version");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ...info, imageDigest: DIGEST_C });
});
