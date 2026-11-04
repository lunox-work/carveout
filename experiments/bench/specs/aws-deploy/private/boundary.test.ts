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

// ---- boundary-1 ----------------------------------------------------------

// Extends public "[boundary-1] an upper-cased header value is rejected": a
// change of case at each position, then the exact value accepted.
test("[boundary-1] a change of case anywhere in the value is rejected; only the exact value is accepted", async () => {
  const { app } = setup({ originVerify: SECRET });
  for (const value of [
    "S3cret-Value",
    "s3Cret-Value",
    "s3cRET-Value",
    "s3cret-VALUE",
    "s3cret-vALUE",
    "S3CRET-value",
  ]) {
    await assertRejected(await send(app, "GET", "/version", value), value);
  }
  const ok = await send(app, "GET", "/version", SECRET);
  assert.equal(ok.status, 200);
});

// Extends public "[boundary-1] ...": a secret that is upper case, so a
// comparison that lower-cases either side gets it wrong.
test("[boundary-1] an upper-case secret rejects its lower-case and fully upper-case forms", async () => {
  const { app } = setup({ originVerify: "ALPHA-Key" });
  await assertRejected(await send(app, "GET", "/version", "alpha-key"));
  await assertRejected(await send(app, "GET", "/version", "ALPHA-KEY"));
  await assertRejected(await send(app, "GET", "/version", "alpha-Key"));
  const ok = await send(app, "GET", "/version", "ALPHA-Key");
  assert.equal(ok.status, 200);
});

// ---- boundary-2 ----------------------------------------------------------

// Extends public "[boundary-2] the header name is matched in lower and upper
// case": mixed-case names, on a guarded route, with a Headers object too.
test("[boundary-2] mixed-case header names are accepted and the request is served as usual", async () => {
  const { app } = setup({ originVerify: SECRET });
  await assertRejected(
    await send(app, "GET", "/api/v1/todos", undefined, cookie),
  );
  for (const name of ["x-Origin-verify", "X-origin-VERIFY", "x-ORIGIN-Verify"]) {
    const res = await app.request("/api/v1/todos", {
      headers: { ...cookie, [name]: SECRET },
    });
    assert.equal(res.status, 200, name);
    await assertOnlyTodo1(res, name);
  }
  const headers = new Headers(cookie);
  headers.set("x-oRiGiN-vErIfY", SECRET);
  const res = await app.request("/version", { headers });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), build);
});

// ---- boundary-3 ----------------------------------------------------------

// Extends public "[boundary-3] surrounding spaces stripped by the Headers API
// do not cause a rejection": leading-only, trailing-only and mixed padding.
test("[boundary-3] leading-only, trailing-only and mixed space/tab padding is stripped and accepted", async () => {
  const { app } = setup({ originVerify: SECRET });
  await assertRejected(await send(app, "GET", "/version", undefined));
  for (const value of [
    ` ${SECRET}`,
    `${SECRET} `,
    `\t ${SECRET} \t`,
    `   ${SECRET}\t\t`,
  ]) {
    const sent = new Headers({ "X-Origin-Verify": value });
    assert.equal(sent.get("X-Origin-Verify"), SECRET);
    const res = await app.request("/version", { headers: sent });
    assert.equal(res.status, 200, JSON.stringify(value));
    assert.deepEqual(await res.json(), build);
  }
});

// Extends public "[boundary-3] ...": the Headers API strips only the ends, so
// whitespace inside the value still makes it differ.
test("[boundary-3] whitespace inside the value is not stripped and is rejected", async () => {
  const { app } = setup({ originVerify: SECRET });
  for (const value of ["s3cret -Value", "s3cret-\tValue", " s3cret- Value "]) {
    const sent = new Headers({ "X-Origin-Verify": value });
    assert.notEqual(sent.get("X-Origin-Verify"), SECRET);
    await assertRejected(
      await app.request("/version", { headers: sent }),
      JSON.stringify(value),
    );
  }
});

// ---- boundary-4 ----------------------------------------------------------

// Extends public "[boundary-4] the matching header sent twice is seen combined
// and rejected": three copies, and the secret first followed by other values.
test("[boundary-4] the secret sent three times, or followed by another value, is combined and rejected", async () => {
  const { app } = setup({ originVerify: SECRET });
  const cases: string[][] = [
    [SECRET, SECRET, SECRET],
    [SECRET, "wrong"],
    [SECRET, ""],
    [SECRET, "S3CRET-VALUE"],
    ["", SECRET],
  ];
  for (const values of cases) {
    const sent = appended(values);
    assert.equal(sent.get("X-Origin-Verify"), values.join(", "));
    await assertRejected(
      await app.request("/version", { headers: sent }),
      JSON.stringify(values),
    );
  }
});

test("[boundary-4] with an empty secret, an empty header sent twice is seen as \", \" and rejected", async () => {
  const { app } = setup({ originVerify: "" });
  const sent = appended(["", ""]);
  assert.equal(sent.get("X-Origin-Verify"), ", ");
  await assertRejected(await app.request("/version", { headers: sent }));
});

test("[boundary-4] a single header literally holding the combined value is rejected too", async () => {
  const { app } = setup({ originVerify: SECRET });
  await assertRejected(
    await send(app, "GET", "/version", `${SECRET}, ${SECRET}`),
  );
});

// ---- boundary-5 ----------------------------------------------------------

// Extends public "[boundary-5] GET /health?probe=1 without the header is still
// exempt": other query strings, including ones naming other paths or the
// header itself, while /version with a query is still checked.
test("[boundary-5] /health with assorted query strings is exempt and returns the health body", async () => {
  const { app } = setup({ originVerify: SECRET });
  for (const path of [
    "/health?",
    "/health?probe=/version",
    "/health?X-Origin-Verify=wrong",
    "/health?a=1&b=2&c",
    "/health?path=%2Fapi%2Fv1%2Ftodos",
  ]) {
    for (const value of [undefined, "wrong"]) {
      const res = await send(app, "GET", path, value);
      assert.equal(res.status, 200, `${path} ${String(value)}`);
      assert.deepEqual(await res.json(), healthBody, path);
    }
  }
  await assertRejected(await send(app, "GET", "/version?probe=1", undefined));
});

// ---- boundary-6 ----------------------------------------------------------

// Extends public "[boundary-6] POST /health without the header gets the app's
// own 404": PUT, PATCH and OPTIONS, contrasted with /version, where the same
// methods get the check's 404.
test("[boundary-6] PUT, PATCH and OPTIONS on /health get the app's own 404 while on /version they get the check's", async () => {
  const { app } = setup({ originVerify: SECRET });
  for (const method of ["PUT", "PATCH", "OPTIONS"]) {
    const health = await send(app, method, "/health", undefined);
    assert.equal(health.status, 404, `${method} /health`);
    assert.deepEqual(await health.json(), appNotFoundBody, `${method} /health`);

    await assertRejected(
      await send(app, method, "/version", undefined),
      `${method} /version`,
    );
  }
});

test("[boundary-6] HEAD /health without the header answers 200 like GET, while HEAD /version is 404", async () => {
  const { app } = setup({ originVerify: SECRET });
  const health = await send(app, "HEAD", "/health", undefined);
  assert.equal(health.status, 200);
  const version = await send(app, "HEAD", "/version", undefined);
  assert.equal(version.status, 404);
});

// ---- boundary-7 ----------------------------------------------------------

// Extends public "[boundary-7] /healthz, /HEALTH and /api/health without the
// header are not exempt": more lookalikes, with the check's body asserted.
test("[boundary-7] more lookalike paths are rejected with the check's body", async () => {
  const { app } = setup({ originVerify: SECRET });
  for (const path of [
    "/Health",
    "/health.json",
    "/healthcheck",
    "/health-check",
    "/api/v1/health",
    "/v1/health",
    "/health/health",
    "/xhealth",
    "/healthz",
    "/HEALTH",
    "/api/health",
    "//health",
  ]) {
    await assertRejected(await send(app, "GET", path, undefined), path);
  }
});

// Extends public "[boundary-7] ...": "/health" only in the query string, so a
// check on the whole URL rather than the path would exempt these.
test("[boundary-7] a path carrying /health only in its query string is not exempt", async () => {
  const { app } = setup({ originVerify: SECRET });
  for (const path of [
    "/version?next=/health",
    "/nowhere?/health",
    "/api/v1/todos?health",
    "/version?x=/health",
  ]) {
    await assertRejected(
      await send(app, "GET", path, undefined, cookie),
      path,
    );
  }
});

// ---- boundary-8 ----------------------------------------------------------

// Extends public "[boundary-8] an empty secret installs the check": a blank
// header, which the Headers API strips to empty, matches.
test("[boundary-8] with an empty secret, a whitespace-only header (stripped to empty) is accepted", async () => {
  const { app } = setup({ originVerify: "" });
  await assertRejected(await send(app, "GET", "/version", undefined));
  for (const value of ["   ", "\t", " \t "]) {
    const sent = new Headers({ "X-Origin-Verify": value });
    assert.equal(sent.get("X-Origin-Verify"), "");
    const res = await app.request("/version", { headers: sent });
    assert.equal(res.status, 200, JSON.stringify(value));
    assert.deepEqual(await res.json(), build);
  }
});

test("[boundary-8] with an empty secret, /health needs no header and a write needs the empty header", async () => {
  const { app, store } = setup({ originVerify: "" });
  const health = await send(app, "GET", "/health", undefined);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), healthBody);

  await assertRejected(
    await send(app, "POST", "/api/v1/todos", undefined, cookie, {
      title: "no header",
    }),
  );
  await assertRejected(
    await send(app, "POST", "/api/v1/todos", "x", cookie, {
      title: "non-empty header",
    }),
  );
  await assertStoreUntouched(store);

  const created = await send(app, "POST", "/api/v1/todos", "", cookie, {
    title: "empty header",
  });
  assert.equal(created.status, 201);
  assert.equal((await store.list(todo1.userId)).length, 2);
});

// ---- boundary-9 ----------------------------------------------------------

// Extends public "[boundary-9] a space-prefixed secret is not trimmed":
// trailing, both-sided and tab padding; no header value can match.
test("[boundary-9] a trailing-, both-sided- or tab-padded secret admits nothing but /health", async () => {
  for (const secret of [`${SECRET} `, ` ${SECRET} `, `\t${SECRET}`]) {
    const label = JSON.stringify(secret);
    let app: ReturnType<typeof setup>["app"] | undefined;
    assert.doesNotThrow(() => {
      app = setup({ originVerify: secret }).app;
    }, label);
    assert.ok(app);
    for (const value of [undefined, secret, SECRET, "", secret.trim()]) {
      await assertRejected(
        await send(app, "GET", "/version", value),
        `${label} with ${JSON.stringify(value)}`,
      );
    }
    const health = await send(app, "GET", "/health", undefined);
    assert.equal(health.status, 200, label);
  }
});

test("[boundary-9] a whitespace-only secret admits no request, not even one with an empty or blank header", async () => {
  let app: ReturnType<typeof setup>["app"] | undefined;
  assert.doesNotThrow(() => {
    app = setup({ originVerify: "   " }).app;
  });
  assert.ok(app);
  for (const value of [undefined, "", "   ", "\t"]) {
    await assertRejected(
      await send(app, "GET", "/version", value),
      JSON.stringify(value),
    );
  }
  const health = await send(app, "GET", "/health", undefined);
  assert.equal(health.status, 200);
});

// ---- boundary-10 ---------------------------------------------------------

// Extends public "[boundary-10] a secret with interior spaces and punctuation
// is matched verbatim": a long secret of base64 and URL punctuation.
test("[boundary-10] a long punctuated secret is matched verbatim; one character short or recased is rejected", async () => {
  const secret = "Zx9/+=_-.~!*'();:@&$?#[]AbC".repeat(8);
  assert.ok(secret.length > 200);
  const { app } = setup({ originVerify: secret });

  const ok = await send(app, "GET", "/version", secret);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), build);

  await assertRejected(
    await send(app, "GET", "/version", secret.slice(0, -1)),
    "one short",
  );
  await assertRejected(
    await send(app, "GET", "/version", `${secret.slice(0, -1)}c`),
    "last letter recased",
  );
  await assertRejected(
    await send(app, "GET", "/version", `${secret}C`),
    "one long",
  );
});

test("[boundary-10] a secret with regular-expression metacharacters is compared literally", async () => {
  const secret = "a.b*c+d?(e)[f]{2}";
  const { app } = setup({ originVerify: secret });
  const ok = await send(app, "GET", "/version", secret);
  assert.equal(ok.status, 200);
  // Each of these matches the secret read as a regular expression.
  for (const value of ["aXceff", "abbbccdeff", "a-ceff"]) {
    await assertRejected(await send(app, "GET", "/version", value), value);
  }
});

test("[boundary-10] a secret containing a comma and a space matches the same single header value", async () => {
  const { app } = setup({ originVerify: "a, b" });
  const ok = await send(app, "GET", "/version", "a, b");
  assert.equal(ok.status, 200);
  await assertRejected(await send(app, "GET", "/version", "a"));
  await assertRejected(await send(app, "GET", "/version", "b"));
});

// ---- boundary-11 ---------------------------------------------------------

// Extends public "[boundary-11] an accepted request does not let the next
// unverified one through": a longer alternating sequence.
test("[boundary-11] a long alternating sequence is decided request by request", async () => {
  const { app } = setup({ originVerify: SECRET });
  const sequence: [string, string | undefined, number][] = [
    ["/version", undefined, 404],
    ["/version", SECRET, 200],
    ["/version", "wrong", 404],
    ["/health", undefined, 200],
    ["/version", undefined, 404],
    ["/version", SECRET, 200],
    ["/version", SECRET, 200],
    ["/version", "S3CRET-VALUE", 404],
    ["/version", SECRET, 200],
    ["/version", "", 404],
  ];
  const statuses: number[] = [];
  for (const [path, value] of sequence) {
    statuses.push((await send(app, "GET", path, value)).status);
  }
  assert.deepEqual(
    statuses,
    sequence.map(([, , status]) => status),
  );
});

test("[boundary-11] an accepted request on one route does not admit an unverified write on another", async () => {
  const { app, store } = setup({ originVerify: SECRET });
  const read = await send(app, "GET", "/api/v1/todos", SECRET, cookie);
  assert.equal(read.status, 200);
  await assertRejected(
    await send(app, "DELETE", "/api/v1/todos/todo_1", undefined, cookie),
  );
  await assertStoreUntouched(store);
});
