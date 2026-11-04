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

// ---- unhappy-1 -----------------------------------------------------------

// Extends public "[unhappy-1] requests with no or a plainly wrong header are
// rejected on every path and method": methods and paths the public rows do not
// try, including routes outside /api and routes that do not exist.
test("[unhappy-1] requests without the header are rejected on further methods and paths", async () => {
  const { app } = setup({ originVerify: SECRET });
  const rows: [string, string, unknown?][] = [
    ["PUT", "/api/v1/todos", { title: "x" }],
    ["GET", "/api/v1/todos/todo_1"],
    ["GET", "/api/v1/me/emails"],
    ["PUT", "/api/v1/me/username", { username: "x" }],
    ["POST", "/api/auth/sign-in/social", { provider: "github" }],
    ["POST", "/version"],
    ["OPTIONS", "/version"],
    ["GET", "/"],
    ["GET", "/version/"],
    ["GET", "/favicon.ico"],
  ];
  for (const [method, path, body] of rows) {
    await assertRejected(
      await send(app, method, path, undefined, cookie, body),
      `${method} ${path}`,
    );
  }
});

// Extends public "[unhappy-1] near-miss header values are rejected": suffixes,
// prefixes, substitutions, quoting and comma lists inside one header value.
test("[unhappy-1] more near-miss header values are rejected on /version and /api/v1/todos", async () => {
  const { app } = setup({ originVerify: SECRET });
  const values = [
    "s3cret-Value-",
    "xs3cret-Value",
    "s3cret Value",
    "s3cret_Value",
    "s3cret-",
    "Value",
    `"${SECRET}"`,
    `${SECRET}=`,
    `${SECRET},${SECRET}`,
    `${SECRET}, wrong`,
    `wrong,${SECRET}`,
    "undefined",
    "null",
    "true",
  ];
  for (const value of values) {
    await assertRejected(await send(app, "GET", "/version", value), value);
    await assertRejected(
      await send(app, "GET", "/api/v1/todos", value, cookie),
      value,
    );
  }
});

// Extends public "[unhappy-1] requests with no or a plainly wrong header ...":
// the secret is present, but not in X-Origin-Verify, so the header is absent.
test("[unhappy-1] the secret carried anywhere but the X-Origin-Verify header is rejected", async () => {
  const { app } = setup({ originVerify: SECRET });
  const elsewhere: [string, string, Record<string, string>][] = [
    ["X-Origin-Verified", "/version", { "X-Origin-Verified": SECRET }],
    ["Origin-Verify", "/version", { "Origin-Verify": SECRET }],
    ["X-Origin", "/version", { "X-Origin": SECRET }],
    ["Authorization", "/version", { Authorization: SECRET }],
    ["Origin", "/version", { Origin: SECRET }],
    ["query", `/version?X-Origin-Verify=${SECRET}`, {}],
    ["query lower", `/version?x-origin-verify=${SECRET}`, {}],
  ];
  for (const [label, path, headers] of elsewhere) {
    await assertRejected(await app.request(path, { headers }), label);
  }
});

test("[unhappy-1] HEAD /version without the header is 404", async () => {
  const { app } = setup({ originVerify: SECRET });
  const res = await send(app, "HEAD", "/version", undefined);
  assert.equal(res.status, 404);
  const wrong = await send(app, "HEAD", "/version", "wrong");
  assert.equal(wrong.status, 404);
});

// ---- unhappy-2 -----------------------------------------------------------

// Extends public "[unhappy-2] an unknown route without the header gets the
// check's 404 body": other methods, deeper paths, and the app without auth,
// which has its own not-found handler.
test("[unhappy-2] unknown routes on any method get the check's body rather than the app's own", async () => {
  const { app } = setup({ originVerify: SECRET });
  const rows: [string, string, string | undefined][] = [
    ["POST", "/api/v1/does-not-exist", undefined],
    ["DELETE", "/deeply/nested/nowhere", "wrong"],
    ["PATCH", "/api", ""],
    ["GET", "/api/v2/todos", "S3CRET-VALUE"],
    ["PUT", "/nowhere", undefined],
  ];
  for (const [method, path, value] of rows) {
    const res = await send(app, method, path, value, cookie);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(await res.json(), rejectedBody, `${method} ${path}`);
  }

  const noAuth = setup({ originVerify: SECRET, noAuth: true }).app;
  const res = await send(noAuth, "GET", "/does-not-exist", undefined);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), rejectedBody);
});

// ---- unhappy-3 -----------------------------------------------------------

// Extends public "[unhappy-3] a rejected request never calls getSession":
// many rejected requests, other paths and methods, a bearer token as well as a
// cookie, then one accepted request to show the counter works.
test("[unhappy-3] many rejected /api/v1 requests never call getSession; one accepted request calls it once", async () => {
  const { app, calls } = setup({ originVerify: SECRET });
  const bearer = { Authorization: "Bearer test-token" };
  const rows: [string, string, string | undefined, Record<string, string>][] = [
    ["GET", "/api/v1/todos", undefined, cookie],
    ["GET", "/api/v1/me", "", cookie],
    ["POST", "/api/v1/todos", "wrong", cookie],
    ["DELETE", "/api/v1/todos/todo_1", "S3CRET-VALUE", cookie],
    ["GET", "/api/v1/todos/todo_1", "s3cret-Valu", bearer],
    ["PATCH", "/api/v1/todos/todo_1", undefined, bearer],
    ["GET", "/api/v1/nope", "s3cret-Value2", bearer],
  ];
  for (const [method, path, value, extra] of rows) {
    await assertRejected(
      await send(app, method, path, value, extra),
      `${method} ${path}`,
    );
  }
  assert.equal(calls.getSession, 0);

  const ok = await send(app, "GET", "/api/v1/todos", SECRET, bearer);
  assert.equal(ok.status, 200);
  assert.equal(calls.getSession, 1);
});

// ---- unhappy-4 -----------------------------------------------------------

// Extends public "[unhappy-4] a request with no cookie and no header is 404,
// not 401": other guarded paths and methods, with absent and wrong headers.
test("[unhappy-4] unauthenticated requests on other guarded routes are 404 with the check's body, not 401", async () => {
  const { app, calls } = setup({ originVerify: SECRET });
  const rows: [string, string, string | undefined, unknown?][] = [
    ["POST", "/api/v1/todos", undefined, { title: "x" }],
    ["GET", "/api/v1/me", "wrong"],
    ["DELETE", "/api/v1/todos/todo_1", "S3CRET-VALUE"],
    ["GET", "/api/v1/todos/todo_1", ""],
    ["PATCH", "/api/v1/todos/todo_1", "s3cret-Valu", { done: true }],
  ];
  for (const [method, path, value, body] of rows) {
    await assertRejected(
      await send(app, method, path, value, {}, body),
      `${method} ${path}`,
    );
  }
  assert.equal(calls.getSession, 0);
});

// ---- unhappy-5 -----------------------------------------------------------

// Extends public "[unhappy-5] a rejected GET /api/auth/session never calls
// the auth handler": more /api/auth paths, methods and header values.
test("[unhappy-5] rejected requests to any /api/auth path and method never call the handler", async () => {
  const { app, calls } = setup({ originVerify: SECRET });
  const rows: [string, string, string | undefined][] = [
    ["GET", "/api/auth/session", "S3CRET-VALUE"],
    ["POST", "/api/auth/sign-in/social", ""],
    ["GET", "/api/auth/callback/github?code=abc&state=xyz", undefined],
    ["POST", "/api/auth/sign-out", "s3cret-Value2"],
    ["GET", "/api/auth/get-session", `${SECRET}, ${SECRET}`],
  ];
  for (const [method, path, value] of rows) {
    await assertRejected(
      await send(app, method, path, value, cookie),
      `${method} ${path}`,
    );
  }
  assert.equal(calls.handler, 0);
  assert.equal(calls.getSession, 0);
});

// ---- unhappy-6 -----------------------------------------------------------

// Extends public "[unhappy-6] a rejected DELETE leaves todo_1 in the store":
// every write method, several header values, the store read directly.
test("[unhappy-6] rejected DELETE, PATCH and POST leave the store exactly as seeded", async () => {
  const { app, store } = setup({ originVerify: SECRET });
  const rows: [string, string, string | undefined, unknown?][] = [
    ["DELETE", "/api/v1/todos/todo_1", "S3CRET-VALUE"],
    ["PATCH", "/api/v1/todos/todo_1", undefined, { done: true }],
    ["PATCH", "/api/v1/todos/todo_1", "", { title: "renamed" }],
    ["POST", "/api/v1/todos", "s3cret-Valu", { title: "sneaked in" }],
    ["DELETE", "/api/v1/todos/todo_1", undefined],
  ];
  for (const [method, path, value, body] of rows) {
    await assertRejected(
      await send(app, method, path, value, cookie, body),
      `${method} ${path}`,
    );
  }
  await assertStoreUntouched(store);
});

test("[unhappy-6] a DELETE carrying the secret twice is rejected and leaves todo_1 in place", async () => {
  const { app, store } = setup({ originVerify: SECRET });
  const res = await app.request("/api/v1/todos/todo_1", {
    method: "DELETE",
    headers: appended([SECRET, SECRET], cookie),
  });
  assert.equal(res.status, 404);
  await assertStoreUntouched(store);
});

// ---- unhappy-7 -----------------------------------------------------------

// Extends public "[unhappy-7] a rejected request from an allowed Origin
// carries no Access-Control-Allow-Origin": no Access-Control-* header of any
// kind, on more paths and methods.
test("[unhappy-7] rejected requests from an allowed Origin carry no Access-Control-* header at all", async () => {
  const { app } = setup({ originVerify: SECRET });
  const rows: [string, string, string | undefined, unknown?][] = [
    ["GET", "/api/v1/todos", undefined],
    ["GET", "/api/auth/session", "wrong"],
    ["GET", "/api/v1/nope", ""],
    ["POST", "/api/v1/todos", "S3CRET-VALUE", { title: "x" }],
    ["DELETE", "/api/v1/todos/todo_1", "s3cret-Valu"],
  ];
  for (const [method, path, value, body] of rows) {
    const label = `${method} ${path}`;
    const res = await send(
      app,
      method,
      path,
      value,
      { ...cookie, Origin: ORIGIN },
      body,
    );
    assert.equal(res.status, 404, label);
    assert.deepEqual(accessControlHeaders(res), [], label);
    assert.deepEqual(await res.json(), rejectedBody, label);
  }
});

// ---- unhappy-8 -----------------------------------------------------------

// Extends public "[unhappy-8] a CORS preflight without the header is 404 with
// no Access-Control-Allow-Origin": other paths and requested methods, request
// headers, and no Access-Control-* header of any kind.
test("[unhappy-8] preflights to other paths and for other methods without a valid header are 404 with no Access-Control-* header", async () => {
  const { app } = setup({ originVerify: SECRET });
  const rows: [string, Record<string, string>, string | undefined][] = [
    [
      "/api/v1/todos/todo_1",
      { "Access-Control-Request-Method": "DELETE" },
      undefined,
    ],
    [
      "/api/v1/todos",
      {
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "content-type",
      },
      "wrong",
    ],
    ["/api/auth/sign-in/social", { "Access-Control-Request-Method": "POST" }, ""],
    ["/api/v1/me", { "Access-Control-Request-Method": "GET" }, "s3cret-Valu"],
  ];
  for (const [path, extra, value] of rows) {
    const res = await send(app, "OPTIONS", path, value, {
      Origin: ORIGIN,
      ...extra,
    });
    assert.equal(res.status, 404, path);
    assert.deepEqual(accessControlHeaders(res), [], path);
    assert.deepEqual(await res.json(), rejectedBody, path);
  }
});

// ---- unhappy-9 -----------------------------------------------------------

// Extends public "[unhappy-9] with no auth, GET /api/v1/todos without the
// header is 404, not 503": other /api methods and paths, preflights and
// unknown routes in the app without auth.
test("[unhappy-9] with no auth, other /api requests without a valid header are 404 with the check's body, not 503", async () => {
  const { app } = setup({ originVerify: SECRET, noAuth: true });
  const rows: [string, string, string | undefined, Record<string, string>][] = [
    ["POST", "/api/v1/todos", undefined, {}],
    ["DELETE", "/api/v1/todos/todo_1", "wrong", cookie],
    ["GET", "/api/v1/me", "", {}],
    ["GET", "/api/auth/callback/github", "S3CRET-VALUE", {}],
    [
      "OPTIONS",
      "/api/v1/todos",
      undefined,
      { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
    ],
    ["GET", "/nowhere", undefined, {}],
  ];
  for (const [method, path, value, extra] of rows) {
    const res = await send(app, method, path, value, extra);
    await assertRejected(res, `${method} ${path}`);
  }
});

// ---- unhappy-10 ----------------------------------------------------------

// Extends public "[unhappy-10] with no auth, GET /version without the header
// is 404": more header values, plus the accepted case for contrast.
test("[unhappy-10] with no auth, /version with assorted wrong headers is 404 and with the secret is the build record", async () => {
  const { app } = setup({ originVerify: SECRET, noAuth: true });
  const variants: [string, Headers | Record<string, string>][] = [
    ["absent", {}],
    ["empty", { "X-Origin-Verify": "" }],
    ["wrong", { "X-Origin-Verify": "wrong" }],
    ["longer", { "X-Origin-Verify": "s3cret-Value2" }],
    ["twice", appended([SECRET, SECRET])],
  ];
  for (const [label, headers] of variants) {
    const res = await app.request("/version", { headers });
    assert.equal(res.status, 404, label);
  }
  const ok = await send(app, "GET", "/version", SECRET);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), build);
});

test("[unhappy-10] with no auth and an empty secret, /version without the header is 404", async () => {
  const { app } = setup({ originVerify: "", noAuth: true });
  const res = await send(app, "GET", "/version", undefined);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), rejectedBody);
});
