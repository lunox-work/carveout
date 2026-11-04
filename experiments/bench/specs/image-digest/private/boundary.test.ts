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

// --- boundary-1: ImageID values that are not exactly one digest -------------

const H63 = HEX64.slice(0, 63);

// Extends every "[boundary-1] an ImageID that is not exactly one digest: …"
// case with further values: other lengths and algorithms, other whitespace
// (including what String.prototype.trim would remove), case and Unicode
// look-alikes, several lines, and references whose last part is not a digest.
const notOneDigest: ReadonlyArray<readonly [string, string]> = [
  ["1 hex character", "sha256:0"],
  ["40 hex characters", `sha256:${HEX64.slice(0, 40)}`],
  ["128 hex characters", `sha256:${HEX64}${HEX64}`],
  ["two digests concatenated", `${DIGEST_A}${DIGEST_B}`],
  ["64 non-hex letters", `sha256:${"g".repeat(64)}`],
  ["64 spaces", `sha256:${" ".repeat(64)}`],
  ["one uppercase hex character first", `sha256:A${HEX64.slice(1)}`],
  ["one uppercase hex character last", `sha256:${H63}F`],
  ["capitalised algorithm", `Sha256:${HEX64}`],
  ["sha-256 algorithm name", `sha-256:${HEX64}`],
  ["sha1 algorithm", `sha1:${HEX64.slice(0, 40)}`],
  ["sha384 algorithm", `sha384:${HEX64}${HEX64.slice(0, 32)}`],
  ["double colon", `sha256::${HEX64}`],
  ["semicolon separator", `sha256;${HEX64}`],
  ["equals separator", `sha256=${HEX64}`],
  ["no separator", `sha256${HEX64}`],
  ["doubled prefix", `sha256:sha256:${HEX64}`],
  ["fullwidth hex letter", `sha256:${H63}ｆ`],
  ["Arabic-Indic digit", `sha256:${H63}٠`],
  ["leading newline", `\n${DIGEST_A}`],
  ["leading tab", `\t${DIGEST_A}`],
  ["trailing carriage return", `${DIGEST_A}\r`],
  ["trailing CRLF", `${DIGEST_A}\r\n`],
  ["leading byte-order mark", `﻿${DIGEST_A}`],
  ["trailing no-break space", `${DIGEST_A} `],
  ["trailing line separator", `${DIGEST_A} `],
  ["trailing NUL", `${DIGEST_A}\u0000`],
  ["tab inside", `sha256:\t${HEX64}`],
  ["digest then a second line", `${DIGEST_A}\n${DIGEST_B}`],
  ["a line of junk then the digest", `junk\n${DIGEST_A}`],
  ["text before the digest", `x${DIGEST_A}`],
  ["text after the digest", `${DIGEST_A}x`],
  ["tag-style reference ending in a digest", `sandbox-factory-api:${DIGEST_A}`],
  ["path ending in a digest", `registry/sandbox-factory-api/${DIGEST_A}`],
  ["reference whose last part is a word", `sandbox-factory-api@${DIGEST_A}@unknown`],
  ["digest followed by @ and a name", `${DIGEST_A}@sandbox-factory-api`],
  ["reference ending in a bare @", "sandbox-factory-api@"],
  ["a lone @", "@"],
  ["two @ signs", "@@"],
  ["reference with a 63-character digest", `sandbox-factory-api@sha256:${H63}`],
  ["reference with uppercase hex", `sandbox-factory-api@sha256:${HEX64.toUpperCase()}`],
  ["reference with uppercase algorithm", `sandbox-factory-api@SHA256:${HEX64}`],
  ["reference with a space after @", `sandbox-factory-api@ ${DIGEST_A}`],
  ["reference with a trailing space", `sandbox-factory-api@${DIGEST_A} `],
  ["reference with a trailing newline", `sandbox-factory-api@${DIGEST_A}\n`],
  ["reference with a bare 64-hex value", `sandbox-factory-api@${HEX64}`],
  ["the word null", "null"],
  ["the word undefined", "undefined"],
  ["a single space", " "],
];

for (const [name, value] of notOneDigest) {
  test(`[boundary-1] an ImageID that is not exactly one digest: ${name}`, async (t) => {
    fakeEndpoints(t, { [URI_A]: ok({ ImageID: value }) });
    const outcome = await settle(resolveImageDigest({ [KEY]: URI_A }));
    assert.deepEqual(outcome, { status: "fulfilled", value: undefined });
  });
}

// Extends "[boundary-1] an ImageID that is not exactly one digest": an
// invalid ImageID is not rescued by a valid digest elsewhere in the body.
test("[boundary-1] an invalid ImageID is not replaced by a digest from another field", async (t) => {
  fakeEndpoints(t, {
    [URI_A]: ok({
      Image: `sandbox-factory-api@${DIGEST_A}`,
      ImageID: "unknown",
      Digest: DIGEST_B,
    }),
  });
  assert.deepEqual(await settle(resolveImageDigest({ [KEY]: URI_A })), {
    status: "fulfilled",
    value: undefined,
  });
});

// Extends "[boundary-1] an ImageID that is not exactly one digest": an
// invalid ImageID is not rescued by IMAGE_DIGEST.
test("[boundary-1] an invalid ImageID is not replaced by IMAGE_DIGEST", async (t) => {
  fakeEndpoints(t, { [URI_A]: ok({ ImageID: `SHA256:${HEX64}` }) });
  assert.deepEqual(
    await settle(resolveImageDigest({ [KEY]: URI_A, IMAGE_DIGEST: DIGEST_C })),
    { status: "fulfilled", value: undefined },
  );
});

// Extends "[boundary-1] an ImageID that is not exactly one digest: uppercase hex":
// a digest other than DIGEST_A, uppercased, is not lowercased into a result.
test("[boundary-1] an uppercased form of an unseen digest resolves to undefined", async (t) => {
  fakeEndpoints(t, { [URI_A]: ok({ ImageID: DIGEST_C.toUpperCase() }) });
  assert.deepEqual(await settle(resolveImageDigest({ [KEY]: URI_A })), {
    status: "fulfilled",
    value: undefined,
  });
});

// Extends "[boundary-1] an ImageID that is not exactly one digest: surrounding spaces":
// an unseen digest padded with whitespace is not trimmed into a result.
test("[boundary-1] an unseen digest wrapped in whitespace resolves to undefined", async (t) => {
  fakeEndpoints(t, { [URI_A]: ok({ ImageID: ` \t${DIGEST_D}\n ` }) });
  assert.deepEqual(await settle(resolveImageDigest({ [KEY]: URI_A })), {
    status: "fulfilled",
    value: undefined,
  });
});

// Extends "[boundary-1] an ImageID that is not exactly one digest: no algorithm prefix":
// an unseen bare 64-hex value is not given the sha256: prefix.
test("[boundary-1] an unseen bare 64-hex value is not given the sha256: prefix", async (t) => {
  fakeEndpoints(t, { [URI_A]: ok({ ImageID: DIGEST_C.slice("sha256:".length) }) });
  assert.deepEqual(await settle(resolveImageDigest({ [KEY]: URI_A })), {
    status: "fulfilled",
    value: undefined,
  });
});
