import assert from "node:assert/strict";
import { test } from "node:test";

import { unknownBuildInfo, type BuildInfoDto } from "@sandbox-factory/shared";

import type { Auth } from "../../src/auth.js";
import { createApp } from "../../src/routes.js";
import { createInMemoryStore } from "../../src/store.js";

const SECRET = "s3cret-Value";
const ORIGIN = "http://localhost:5173";

const sessionUser = {
  id: "user_1",
  email: "signed-in@example.test",
  name: "Signed In",
};

const todo1 = {
  id: "todo_1",
  userId: "user_1",
  title: "write tests",
  done: false,
  createdAt: "2026-09-16T00:00:00.000Z",
};

const build: BuildInfoDto = {
  version: "1.4.2",
  gitSha: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
  gitShortSha: "7f3a9c1",
  buildTime: "2026-09-17T09:14:00.000Z",
  gitRef: "main",
  dirty: false,
};

const healthBody = {
  status: "ok",
  version: "1.4.2",
  sha: "7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09",
};

/** The check's rejection body: no trailing period. */
const rejectedBody = { error: "Not found" };
/** The app's own unknown-route body: with a trailing period. */
const appNotFoundBody = { error: "Not found." };

/** Headers the fake auth accepts as a signed-in session. */
const cookie = { cookie: "better-auth.session_token=test-token" };

type App = ReturnType<typeof createApp>;

/**
 * A stand-in for Better Auth: `getSession` returns `sessionUser` when a
 * "cookie" or "authorization" header is present, and both members count their
 * calls. `gate`, when given, holds every `getSession` until it resolves.
 */
function fakeAuth(
  options: { gate?: Promise<void>; onGetSession?: (count: number) => void } = {},
) {
  const calls = { getSession: 0, handler: 0 };
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        calls.getSession += 1;
        options.onGetSession?.(calls.getSession);
        if (options.gate !== undefined) {
          await options.gate;
        }
        return headers.get("cookie") !== null ||
          headers.get("authorization") !== null
          ? { user: sessionUser, session: { id: "session_user_1" } }
          : null;
      },
    },
    handler: (request: Request) => {
      calls.handler += 1;
      return Promise.resolve(
        Response.json({ handled: new URL(request.url).pathname }),
      );
    },
  } as unknown as Auth;
  return { auth, calls };
}

interface Setup {
  /** Leaving this out leaves the key out of the options. */
  originVerify?: string;
  /** Pass `originVerify: undefined` explicitly. */
  explicitUndefined?: boolean;
  noAuth?: boolean;
  buildInfo?: BuildInfoDto;
  fake?: ReturnType<typeof fakeAuth>;
}

function setup(options: Setup = {}) {
  const store = createInMemoryStore([todo1]);
  const fake = options.fake ?? fakeAuth();
  const base = {
    store,
    corsOrigins: [ORIGIN],
    buildInfo: options.buildInfo ?? build,
    ...(options.noAuth === true ? {} : { auth: fake.auth }),
  };
  let app: App;
  if (options.originVerify !== undefined) {
    app = createApp({ ...base, originVerify: options.originVerify });
  } else if (options.explicitUndefined === true) {
    app = createApp({ ...base, originVerify: undefined });
  } else {
    app = createApp(base);
  }
  return { app, store, calls: fake.calls };
}

/** Sends one request; `verify` undefined means no X-Origin-Verify header. */
async function send(
  app: App,
  method: string,
  path: string,
  verify: string | undefined,
  extra: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (verify !== undefined) {
    headers["X-Origin-Verify"] = verify;
  }
  return await app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Headers carrying X-Origin-Verify once per given value, via `append`. */
function appended(values: readonly string[], extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra);
  for (const value of values) {
    headers.append("X-Origin-Verify", value);
  }
  return headers;
}

function mediaType(res: Response): string | undefined {
  return res.headers.get("content-type")?.split(";")[0]?.trim();
}

function accessControlHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((name) =>
    name.toLowerCase().startsWith("access-control-"),
  );
}

/** The check's rejection: 404, JSON, `{"error":"Not found"}`. */
async function assertRejected(res: Response, label = ""): Promise<void> {
  assert.equal(res.status, 404, label);
  assert.equal(mediaType(res), "application/json", label);
  assert.deepEqual(await res.json(), rejectedBody, label);
}

/** Asserts the body is `{ todos: [todo_1] }`, without asserting `userId`. */
async function assertOnlyTodo1(res: Response, label = ""): Promise<void> {
  const body = (await res.json()) as { todos: Record<string, unknown>[] };
  assert.equal(body.todos.length, 1, label);
  const [only] = body.todos;
  assert.ok(only, label);
  assert.equal(only["id"], todo1.id, label);
  assert.equal(only["title"], todo1.title, label);
  assert.equal(only["done"], todo1.done, label);
  assert.equal(only["createdAt"], todo1.createdAt, label);
}

/** Asserts the store still holds exactly todo_1 for user_1, unchanged. */
async function assertStoreUntouched(
  store: ReturnType<typeof createInMemoryStore>,
): Promise<void> {
  const todos = await store.list(todo1.userId);
  assert.equal(todos.length, 1);
  const [only] = todos;
  assert.ok(only);
  assert.equal(only.id, todo1.id);
  assert.equal(only.title, todo1.title);
  assert.equal(only.done, todo1.done);
}

// ---- happy-1 -------------------------------------------------------------

// Extends public "[happy-1] without originVerify, GET /version with
// X-Origin-Verify "anything" or "" returns the build record": more header
// values, and the unchecked app is built after one with a secret, so a secret
// kept in module state would leak into it.
test("[happy-1] an app built without originVerify after one built with it serves /version whatever the header holds", async () => {
  const guarded = setup({ originVerify: SECRET }).app;
  await assertRejected(await send(guarded, "GET", "/version", undefined));

  const { app } = setup();
  for (const value of [
    undefined,
    "anything",
    "",
    SECRET,
    "S3CRET-VALUE",
    "undefined",
  ]) {
    const res = await send(app, "GET", "/version", value);
    assert.equal(res.status, 200, `header ${String(value)}`);
    assert.deepEqual(await res.json(), build, `header ${String(value)}`);
  }
  const twice = await app.request("/version", {
    headers: appended([SECRET, "wrong"]),
  });
  assert.equal(twice.status, 200);
  assert.deepEqual(await twice.json(), build);
});

// Extends public "[happy-1] without originVerify, GET /version with no
// X-Origin-Verify header ...": other routes, where an app with a secret
// rejects the very same requests.
test("[happy-1] without originVerify, todos, unknown routes and preflights ignore X-Origin-Verify, unlike an app with a secret", async () => {
  const guarded = setup({ originVerify: SECRET }).app;
  const { app } = setup();

  const todos = await send(app, "GET", "/api/v1/todos", "wrong", cookie);
  assert.equal(todos.status, 200);
  await assertOnlyTodo1(todos);
  await assertRejected(
    await send(guarded, "GET", "/api/v1/todos", "wrong", cookie),
  );

  const nowhere = await send(app, "GET", "/nowhere", "");
  assert.equal(nowhere.status, 404);
  assert.deepEqual(await nowhere.json(), appNotFoundBody);
  await assertRejected(await send(guarded, "GET", "/nowhere", ""));

  const preflight = await send(app, "OPTIONS", "/api/v1/todos", "wrong", {
    Origin: ORIGIN,
    "Access-Control-Request-Method": "POST",
  });
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

// ---- happy-2 -------------------------------------------------------------

// Extends public "[happy-2] originVerify passed as undefined serves GET
// /api/v1/todos without the header": built after an app with a secret, with
// header values including the string "undefined", and a write.
test("[happy-2] originVerify undefined, built after an app with a secret, serves reads and writes with or without the header", async () => {
  const guarded = setup({ originVerify: SECRET }).app;
  await assertRejected(
    await send(guarded, "GET", "/api/v1/todos", undefined, cookie),
  );

  const { app, store } = setup({ explicitUndefined: true });
  for (const value of [undefined, "undefined", "", SECRET]) {
    const res = await send(app, "GET", "/api/v1/todos", value, cookie);
    assert.equal(res.status, 200, `header ${String(value)}`);
    await assertOnlyTodo1(res, `header ${String(value)}`);
  }

  const created = await send(
    app,
    "POST",
    "/api/v1/todos",
    undefined,
    cookie,
    { title: "added without a header" },
  );
  assert.equal(created.status, 201);
  assert.equal((await store.list(todo1.userId)).length, 2);
});

// ---- happy-3 -------------------------------------------------------------

// Extends public "[happy-3] with the matching header, /version and
// /api/v1/todos are served as usual": more routes and methods, each compared
// with what an app without the check answers, and each rejected without it.
test("[happy-3] with the matching header every route answers exactly as an unchecked app does", async () => {
  const rows: [string, string, unknown?][] = [
    ["GET", "/version"],
    ["GET", "/api/v1/todos"],
    ["GET", "/api/v1/todos/todo_1"],
    ["GET", "/api/v1/todos/nope"],
    ["GET", "/api/v1/me"],
    ["GET", "/api/v1/nope"],
    ["GET", "/nowhere"],
    ["GET", "/"],
    ["POST", "/version"],
    ["PUT", "/api/v1/todos"],
    ["PATCH", "/api/v1/todos/nope", { done: true }],
    ["POST", "/api/v1/todos", { title: "" }],
    ["GET", "/api/auth/session"],
  ];
  for (const [method, path, body] of rows) {
    const label = `${method} ${path}`;
    const guarded = setup({ originVerify: SECRET }).app;
    const plain = setup().app;

    await assertRejected(
      await send(guarded, method, path, undefined, cookie, body),
      label,
    );

    const got = await send(guarded, method, path, SECRET, cookie, body);
    const want = await send(plain, method, path, SECRET, cookie, body);
    assert.equal(got.status, want.status, label);
    assert.equal(mediaType(got), mediaType(want), label);
    assert.equal(await got.text(), await want.text(), label);
  }
});

test("[happy-3] with the matching header, POST, PATCH and DELETE reach the store", async () => {
  const { app, store } = setup({ originVerify: SECRET });
  await assertRejected(
    await send(app, "POST", "/api/v1/todos", undefined, cookie, {
      title: "rejected",
    }),
  );

  const created = await send(app, "POST", "/api/v1/todos", SECRET, cookie, {
    title: "accepted",
  });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { title: string }).title, "accepted");

  const patched = await send(
    app,
    "PATCH",
    "/api/v1/todos/todo_1",
    SECRET,
    cookie,
    { done: true },
  );
  assert.equal(patched.status, 200);
  assert.equal(((await patched.json()) as { done: boolean }).done, true);

  const removed = await send(
    app,
    "DELETE",
    "/api/v1/todos/todo_1",
    SECRET,
    cookie,
  );
  assert.equal(removed.status, 204);

  const titles = (await store.list(todo1.userId)).map((t) => t.title);
  assert.deepEqual(titles, ["accepted"]);
});

test("[happy-3] with the matching header, /api/auth/* reaches the auth handler once", async () => {
  const { app, calls } = setup({ originVerify: SECRET });
  await assertRejected(await send(app, "GET", "/api/auth/session", undefined));
  assert.equal(calls.handler, 0);

  const res = await send(app, "GET", "/api/auth/callback/github", SECRET);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { handled: "/api/auth/callback/github" });
  assert.equal(calls.handler, 1);
});

// ---- happy-4 -------------------------------------------------------------

// Extends public "[happy-4] an accepted request without a cookie gets the
// session guard's 401": other methods and paths, getSession called once per
// accepted request and never for rejected ones.
test("[happy-4] accepted requests without a cookie get 401 on every guarded method and path; rejected ones never reach the guard", async () => {
  const { app, calls, store } = setup({ originVerify: SECRET });
  const rows: [string, string, unknown?][] = [
    ["POST", "/api/v1/todos", { title: "anon" }],
    ["PATCH", "/api/v1/todos/todo_1", { done: true }],
    ["DELETE", "/api/v1/todos/todo_1"],
    ["GET", "/api/v1/todos/todo_1"],
    ["GET", "/api/v1/nope"],
  ];
  let accepted = 0;
  for (const [method, path, body] of rows) {
    const label = `${method} ${path}`;
    await assertRejected(
      await send(app, method, path, undefined, {}, body),
      label,
    );
    assert.equal(calls.getSession, accepted, label);

    const res = await send(app, method, path, SECRET, {}, body);
    accepted += 1;
    assert.equal(res.status, 401, label);
    assert.deepEqual(
      await res.json(),
      { error: "Authentication required." },
      label,
    );
    assert.equal(calls.getSession, accepted, label);
  }
  await assertStoreUntouched(store);
});

// ---- happy-5 -------------------------------------------------------------

// Extends public "[happy-5] an accepted request gets the usual
// Access-Control-Allow-Origin header": every Access-Control-* header, on more
// requests, compared with an app without the check.
test("[happy-5] accepted requests carry the same CORS headers an unchecked app sends", async () => {
  const rows: [string, string, Record<string, string>][] = [
    ["GET", "/api/v1/todos", { ...cookie, Origin: ORIGIN }],
    ["GET", "/api/auth/session", { Origin: ORIGIN }],
    [
      "OPTIONS",
      "/api/v1/todos/todo_1",
      { Origin: ORIGIN, "Access-Control-Request-Method": "DELETE" },
    ],
    ["GET", "/api/v1/todos", { ...cookie, Origin: "http://evil.example" }],
  ];
  for (const [method, path, extra] of rows) {
    const label = `${method} ${path} from ${extra["Origin"] ?? ""}`;
    const guarded = setup({ originVerify: SECRET }).app;
    const plain = setup().app;

    const rejected = await send(guarded, method, path, undefined, extra);
    assert.equal(rejected.status, 404, label);
    assert.deepEqual(accessControlHeaders(rejected), [], label);

    const got = await send(guarded, method, path, SECRET, extra);
    const want = await send(plain, method, path, SECRET, extra);
    assert.equal(got.status, want.status, label);
    const pick = (res: Response) =>
      accessControlHeaders(res)
        .sort()
        .map((name) => [name, res.headers.get(name)]);
    assert.deepEqual(pick(got), pick(want), label);
  }
});

// ---- happy-6 -------------------------------------------------------------

// Extends public "[happy-6] with no auth, an accepted GET /api/v1/todos still
// gets the 503": more methods and paths, plus the routes outside /api.
test("[happy-6] with no auth, accepted requests across /api get the 503 and the rest are served as usual", async () => {
  const { app } = setup({ originVerify: SECRET, noAuth: true });
  await assertRejected(await send(app, "GET", "/api/v1/todos", undefined));

  const rows: [string, string, unknown?][] = [
    ["POST", "/api/v1/todos", { title: "x" }],
    ["DELETE", "/api/v1/todos/todo_1"],
    ["GET", "/api/v1/me"],
    ["GET", "/api/auth/callback/github"],
    ["PATCH", "/api/v1/nope", { done: true }],
  ];
  for (const [method, path, body] of rows) {
    const res = await send(app, method, path, SECRET, cookie, body);
    assert.equal(res.status, 503, `${method} ${path}`);
    assert.deepEqual(
      await res.json(),
      { error: "Authentication is not configured." },
      `${method} ${path}`,
    );
  }

  const version = await send(app, "GET", "/version", SECRET);
  assert.equal(version.status, 200);
  assert.deepEqual(await version.json(), build);

  const nowhere = await send(app, "GET", "/nowhere", SECRET);
  assert.equal(nowhere.status, 404);
  assert.deepEqual(await nowhere.json(), appNotFoundBody);
});

// ---- happy-7 -------------------------------------------------------------

// Extends public "[happy-7] /health answers whether the header is wrong or
// right": more header values, each rejected on /version.
test("[happy-7] /health answers for empty, case-changed, padded-secret and doubled headers, which /version rejects", async () => {
  const { app } = setup({ originVerify: SECRET });
  const variants: [string, Headers | Record<string, string>][] = [
    ["empty", { "X-Origin-Verify": "" }],
    ["upper case", { "X-Origin-Verify": "S3CRET-VALUE" }],
    ["prefix", { "X-Origin-Verify": "s3cret-Valu" }],
    ["twice", appended([SECRET, SECRET])],
    ["cookie only", cookie],
  ];
  for (const [label, headers] of variants) {
    const health = await app.request("/health", { headers });
    assert.equal(health.status, 200, label);
    assert.deepEqual(await health.json(), healthBody, label);

    await assertRejected(await app.request("/version", { headers }), label);
  }
});

test("[happy-7] /health is exempt with no auth and with another build record", async () => {
  const noAuth = setup({ originVerify: SECRET, noAuth: true }).app;
  const health = await send(noAuth, "GET", "/health", undefined);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), healthBody);
  await assertRejected(await send(noAuth, "GET", "/version", undefined));

  const unknown = setup({
    originVerify: SECRET,
    buildInfo: unknownBuildInfo,
  }).app;
  const res = await send(unknown, "GET", "/health", "wrong");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    status: "ok",
    version: unknownBuildInfo.version,
    sha: unknownBuildInfo.gitSha,
  });
  await assertRejected(await send(unknown, "GET", "/version", "wrong"));
});
