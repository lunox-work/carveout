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

// ---- concurrency-1 -------------------------------------------------------

// Extends public "[concurrency-1] overlapping requests are each decided on
// their own header": more requests, across routes and methods.
test("[concurrency-1] twenty overlapping requests across routes are each decided on their own header", async () => {
  const { app } = setup({ originVerify: SECRET });
  const rows: [string, string, string | undefined, number][] = [];
  for (let i = 0; i < 4; i += 1) {
    rows.push(
      ["GET", "/version", SECRET, 200],
      ["GET", "/api/v1/todos", undefined, 404],
      ["GET", "/api/v1/todos", SECRET, 200],
      ["GET", "/health", "wrong", 200],
      ["GET", "/nowhere", i % 2 === 0 ? "wrong" : SECRET, 404],
    );
  }
  const responses = await Promise.all(
    rows.map(([method, path, value]) => send(app, method, path, value, cookie)),
  );
  assert.deepEqual(
    responses.map((r) => r.status),
    rows.map(([, , , status]) => status),
  );
  const bodies = await Promise.all(
    responses.map((r) => r.json() as Promise<unknown>),
  );
  rows.forEach(([, path, value], i) => {
    if (path === "/nowhere") {
      assert.deepEqual(
        bodies[i],
        value === SECRET ? appNotFoundBody : rejectedBody,
        `row ${String(i)}`,
      );
    }
  });
});

// Extends public "[concurrency-1] ...": an accepted request is still waiting
// on getSession when a rejected one arrives; the rejected one is answered
// without waiting and without reaching getSession.
test("[concurrency-1] a rejected request is answered while an accepted one is still waiting on getSession", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // If a second request reaches getSession, the check let it through; release
  // the gate then too, so the test fails on statuses rather than hanging.
  const fake = fakeAuth({
    gate,
    onGetSession: (count) => {
      if (count > 1) release();
    },
  });
  const { app, calls } = setup({ originVerify: SECRET, fake });
  const finished: string[] = [];

  const accepted = send(app, "GET", "/api/v1/todos", SECRET, cookie).then(
    (res) => {
      finished.push("accepted");
      return res;
    },
  );
  const rejected = send(app, "GET", "/api/v1/todos", undefined, cookie).then(
    (res) => {
      finished.push("rejected");
      release();
      return res;
    },
  );

  const [a, r] = await Promise.all([accepted, rejected]);
  assert.equal(a.status, 200);
  await assertOnlyTodo1(a);
  await assertRejected(r);
  assert.deepEqual(finished, ["rejected", "accepted"]);
  assert.equal(calls.getSession, 1);
});

// ---- concurrency-2 -------------------------------------------------------

// Extends public "[concurrency-2] two apps with different secrets do not
// share them": three apps (one without a secret, built between the other two)
// each asked with every header at once.
test("[concurrency-2] apps with alpha, no secret and beta each answer only on their own secret", async () => {
  const alpha = setup({ originVerify: "alpha" }).app;
  const open = setup().app;
  const beta = setup({ originVerify: "beta" }).app;
  const values = ["alpha", "beta", undefined] as const;
  const matrix: [App, string, number[]][] = [
    [alpha, "alpha", [200, 404, 404]],
    [open, "none", [200, 200, 200]],
    [beta, "beta", [404, 200, 404]],
  ];
  const responses = await Promise.all(
    matrix.flatMap(([app]) =>
      values.map((value) => send(app, "GET", "/version", value)),
    ),
  );
  const statuses = responses.map((r) => r.status);
  assert.deepEqual(
    statuses,
    matrix.flatMap(([, , expected]) => expected),
  );
});

test("[concurrency-2] creating a second app with another secret does not change the first", async () => {
  const a = setup({ originVerify: "alpha" }).app;
  const before = await send(a, "GET", "/version", "alpha");
  assert.equal(before.status, 200);
  await assertRejected(await send(a, "GET", "/version", undefined));

  const b = setup({ originVerify: "beta" }).app;
  const [aAlpha, aBeta, bAlpha, bBeta] = await Promise.all([
    send(a, "GET", "/version", "alpha"),
    send(a, "GET", "/version", "beta"),
    send(b, "GET", "/version", "alpha"),
    send(b, "GET", "/version", "beta"),
  ]);
  assert.equal(aAlpha.status, 200);
  await assertRejected(aBeta, "A with beta");
  await assertRejected(bAlpha, "B with alpha");
  assert.equal(bBeta.status, 200);
});
