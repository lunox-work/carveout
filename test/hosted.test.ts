/**
 * The hosted round trip against a fake platform (a local HTTP server):
 * a public cut in pseudonyms, `handoff --platform` uploading it with the
 * owner's acceptance test, a contributor's submission handed back by
 * `GET .../submissions/:sid/files`, and `patch --from` judging it by the
 * local receipt. The patch is the one `patch <dir>` makes of the same
 * folder brought back by hand, and nothing uploaded names the repository.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { CARVEOUT_VERSION, cutSlice, patchProject } from "../src/carve.js";
import {
  commitmentCheck,
  findPlatformRecord,
  folderFiles,
  handoffPlatform,
  patchFrom,
  platformRecordDir,
  stagedHiddenSha256,
  type HostedDeps,
} from "../src/hosted.js";
import { PlatformError, saveCredential } from "../src/platform.js";
import { readReceipt } from "../src/receipt.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

const NAMES = /lunox/i;
const ACCEPT = "apps/web/src/LunoxCart.accept.test.ts";
const ACCEPT_TEXT = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { LunoxCart } from "./LunoxCart";',
  "",
  'test("a Lunox cart counts its lines", () => {',
  "  assert.equal(new LunoxCart().add(150).add(50).count(), 2);",
  "});",
  "",
].join("\n");

let scratch = "";
let repo = "";
let base = "";
let server: Server;
let env: NodeJS.ProcessEnv = {};
/** What the fake platform was sent, and what it answers a submission with. */
const seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let submission: { path: string; text: string }[] = [];
let uploadedRecordSha256 = "";
/** The acceptance tests the fake platform was sent, which its handout commits to. */
let uploadedTests: { path: string; text: string }[] = [];
/** Answers the upload route gives before it takes one, by bounty id. */
const uploadRefusals = new Map<string, { status: number; body: Record<string, unknown>; headers?: Record<string, string> }[]>();

/**
 * The platform's `hiddenCommitmentOf`, written again here from its
 * description rather than imported from carveout, so the two are checked
 * against each other.
 */
function platformCommitment(tests: { path: string; text: string }[]): string | null {
  const hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  if (tests.length === 0) return null;
  const records = tests.map((test) => ({ path: test.path, sha256: hex(test.text) }));
  const lines = [...records]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((record) => `${record.sha256}  ${record.path}\n`);
  lines.push(`${hex(JSON.stringify(records.map((record) => record.path).sort()))}  calibration.kept\n`);
  return hex(lines.join(""));
}
/** The manual hand-off's patch, which `patch --from` must reproduce. */
let manualDiff = "";
const CLI = join(import.meta.dirname, "../src/cli.js");
/** The CLI as a child, answered by the fake platform in this process meanwhile. */
const cli = (args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-hosted-"));
  repo = join(scratch, "repo");
  write(repo, {
    "package.json": JSON.stringify({ name: "lunox-shop", private: true, type: "module", workspaces: ["packages/*", "apps/*"] }),
    "packages/lunox-money/package.json": JSON.stringify({ name: "@lunox/money", version: "1.0.0", type: "module", main: "src/index.ts" }),
    "packages/lunox-money/src/index.ts": 'export function lunoxFormat(cents: number): string {\n  return `${(cents / 100).toFixed(2)} LNX`;\n}\n',
    "apps/web/package.json": JSON.stringify({ name: "@lunox/web", version: "1.0.0", type: "module", dependencies: { "@lunox/money": "*" } }),
    "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }),
    "apps/web/src/LunoxCart.ts": [
      'import { lunoxFormat } from "@lunox/money";',
      "",
      "/** The Lunox cart. */",
      "export class LunoxCart {",
      "  private readonly lines: number[] = [];",
      "  add(cents: number): this {",
      "    this.lines.push(cents);",
      "    return this;",
      "  }",
      "  total(): string {",
      "    return lunoxFormat(this.lines.reduce((sum, cents) => sum + cents, 0));",
      "  }",
      "}",
      "",
    ].join("\n"),
    "apps/web/src/LunoxCart.test.ts": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { LunoxCart } from "./LunoxCart";\n\ntest("a Lunox cart totals its lines", () => {\n  assert.equal(new LunoxCart().add(150).add(50).total(), "2.00 LNX");\n});\n',
  });
  git(repo, ["init", "-q"]);
  git(repo, ["remote", "add", "origin", "git@github.com:lunox-work/lunox-shop.git"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== "Bearer lnx_test") return send(401, { error: "Unauthorized." });
      if (req.method === "POST" && req.url === "/api/v1/orgs/org_1/sandboxes/uploads") {
        const sent = JSON.parse(body) as { bountyId: string; carveout: { recordSha256: string }; acceptanceTests: { path: string; text: string }[] };
        const refusal = uploadRefusals.get(sent.bountyId)?.shift();
        if (refusal !== undefined) {
          res.writeHead(refusal.status, { "Content-Type": "application/json", ...(refusal.headers ?? {}) });
          return res.end(JSON.stringify(refusal.body));
        }
        uploadedRecordSha256 = sent.carveout.recordSha256;
        uploadedTests = sent.acceptanceTests.map(({ path, text }) => ({ path, text }));
        return send(202, { sandbox: { id: "sbx_1" }, version: { id: "sbv_1" }, source: {}, run: { id: "arn_import" } });
      }
      if (req.method === "GET" && req.url === "/api/v1/orgs/org_1/sandboxes/versions/sbv_1/handout")
        return send(200, { versionId: "sbv_1", files: [], hiddenTests: uploadedTests.length, hiddenSha256: platformCommitment(uploadedTests), hiddenSha256Version: 2 });
      if (req.method === "GET" && req.url === "/api/v1/orgs/org_1/sandboxes/versions/sbv_swapped/handout")
        return send(200, { versionId: "sbv_swapped", files: [], hiddenTests: 1, hiddenSha256: platformCommitment([{ path: "x.test.ts", text: "other" }]), hiddenSha256Version: 2 });
      if (req.method === "GET" && req.url === "/api/v1/orgs/org_1/sandboxes/versions/sbv_legacy/handout")
        return send(200, { versionId: "sbv_legacy", files: [], hiddenTests: 1, hiddenSha256: "f".repeat(64), hiddenSha256Version: 1 });
      const take = /^\/api\/v1\/orgs\/org_1\/sandboxes\/submissions\/(sbm_swapped|sbm_legacy)\/files$/.exec(req.url ?? "");
      if (req.method === "GET" && take !== null)
        return send(200, {
          submission: { id: take[1], sandboxVersionId: take[1] === "sbm_swapped" ? "sbv_swapped" : "sbv_legacy", status: "passed", verdict: "passed" },
          origin: "upload",
          upload: { recordSha256: uploadedRecordSha256, carveoutVersion: "0.4.0" },
          files: submission,
        });
      if (req.method === "GET" && req.url === "/api/v1/orgs/org_1/sandboxes/submissions/sbm_starter/files")
        return send(200, { submission: { id: "sbm_starter", sandboxVersionId: "sbv_gen" }, origin: "starter", upload: null, files: [{ path: "src/a.ts", text: "x" }] });
      if (req.method === "GET" && req.url === "/api/v1/orgs/org_1/sandboxes/submissions/sbm_1/files")
        return send(200, {
          submission: { id: "sbm_1", sandboxVersionId: "sbv_1", verdict: "passed" },
          upload: { recordSha256: uploadedRecordSha256, carveoutVersion: "0.4.0" },
          files: submission,
        });
      if (req.method === "GET" && req.url === "/api/v1/orgs/org_1/sandboxes/submissions/sbm_odd/files")
        return send(200, { submission: { id: "sbm_odd" }, upload: { recordSha256: uploadedRecordSha256, carveoutVersion: "0.4.0" }, files: [{ path: "../escape.ts", text: "x" }] });
      if (req.method === "GET" && req.url === "/api/v1/orgs/org_1/sandboxes/submissions/sbm_other/files")
        return send(200, { submission: { id: "sbm_other" }, upload: { recordSha256: "0".repeat(64), carveoutVersion: "0.4.0" }, files: [] });
      if (req.url?.includes("sbm_failed")) return send(409, { error: "Only a passing submission's files are taken back.", code: "not_passed" });
      return send(404, { error: "Not found." });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env = { LUNOX_CREDENTIALS: join(scratch, "credentials") };
  saveCredential(join(scratch, "credentials"), base, "carveout", {
    token: "lnx_test",
    organizationId: "org_1",
    organizationHandle: "shop",
    client: "carveout",
    createdAt: "2026-11-12T00:00:00.000Z",
    expiresAt: null,
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

const slept: number[] = [];
const warned: string[] = [];
const deps = (): HostedDeps => ({
  env,
  fetchImpl: fetch,
  now: () => Date.parse("2026-11-12T00:00:00.000Z"),
  sleep: async (ms) => slept.push(ms),
  warn: (text) => warned.push(text),
});

const cut = (name: string, more: object = {}) =>
  cutSlice({
    repo,
    out: join(scratch, name),
    entryPoints: ["apps/web/src/LunoxCart.ts"],
    budget: { maxFiles: 40, maxDepth: 2 },
    tests: true,
    copyPure: true,
    public: true,
    offline: true,
    unseen: [ACCEPT],
    ...more,
  });

/** The contributor's work, in the folder's names: a new method on the cart. */
function work(folder: string): { path: string; text: string }[] {
  const path = folderFiles(folder).find((file) => /src\/\w+Cart\.ts$/.test(file.path) && !file.path.includes("test"))?.path ?? "";
  const text = readFileSync(join(folder, path), "utf8").replace(
    "  total(): string {",
    "  count(): number {\n    return this.lines.length;\n  }\n  total(): string {",
  );
  return [
    { path, text },
    { path: path.replace(/Cart\.ts$/, "Lines.ts"), text: "export const lines = (n: number): number => n;\n" },
  ];
}

test("handoff --platform uploads the folder and the acceptance test in the folder's names, and patch --from gives the manual patch", async () => {
  const made = await cut("folder");
  assert.equal(made.record.ready, true, JSON.stringify(made.record.blockers));
  assert.ok(made.receipt !== null && made.pseudonyms !== null && made.pseudonyms.rules.length > 0);
  const uploaded = await handoffPlatform({
    platform: base,
    bountyId: "bty_1",
    folder: made.out,
    receiptPath: made.receipt,
    accepted: [{ path: ACCEPT, text: ACCEPT_TEXT }],
    deps: deps(),
  });
  assert.deepEqual(
    [uploaded.sandboxId, uploaded.versionId, uploaded.runId, uploaded.bountyId, uploaded.org],
    ["sbx_1", "sbv_1", "arn_import", "bty_1", "org_1"],
  );
  const [post] = seen.filter((call) => call.method === "POST");
  assert.ok(post !== undefined);
  assert.equal(post.headers["lunox-client-version"], `carveout/${CARVEOUT_VERSION}`);
  assert.match(String(post.headers["idempotency-key"]), /^[0-9a-f-]{36}$/);
  // Nothing the receipt maps leaves this machine: not in a path, a text, or
  // the acceptance test; and neither does the receipt.
  const receipt = readReceipt(made.receipt);
  assert.doesNotMatch(post.body, NAMES);
  for (const rule of receipt.pseudonyms?.rules ?? []) assert.ok(!post.body.includes(rule.before), rule.before);
  assert.ok(!post.body.includes(made.receipt));
  assert.ok(!post.body.includes('"generatedText"') && !post.body.includes('"rules"'));
  assert.ok(!post.body.includes(repo));
  const body = JSON.parse(post.body) as {
    bountyId: string;
    carveout: { version: string; recordSha256: string };
    files: { path: string; text: string }[];
    acceptanceTests: { path: string; text: string; expectedBaseline: string }[];
  };
  assert.equal(body.bountyId, "bty_1");
  assert.equal(body.carveout.version, CARVEOUT_VERSION);
  assert.deepEqual(body.files, folderFiles(made.out));
  assert.ok(!body.files.some((file) => file.path.startsWith("node_modules/") || file.path.startsWith(".git/")));
  assert.equal(body.acceptanceTests.length, 1);
  assert.equal(body.acceptanceTests[0]?.expectedBaseline, "fail");
  assert.match(body.acceptanceTests[0]?.path ?? "", /^apps\/web\/src\/\w+Cart\.accept\.test\.ts$/);
  // What was uploaded is recorded here, never sent.
  const record = findPlatformRecord(body.carveout.recordSha256);
  assert.equal(record?.versionId, "sbv_1");
  assert.equal(record?.hiddenSha256Version, 2);
  assert.equal(record?.hiddenSha256, platformCommitment(body.acceptanceTests));
  assert.equal(uploaded.hiddenSha256, record?.hiddenSha256);
  assert.equal(record?.receipt, made.receipt);
  assert.ok(existsSync(join(platformRecordDir(), `${receipt.cutId}.json`)));

  // The contributor's work, as the platform gives it back, and the same
  // folder brought back by hand.
  submission = work(made.out);
  const returned = join(scratch, "returned");
  cpSync(made.out, returned, { recursive: true });
  for (const file of submission) write(returned, { [file.path]: file.text });
  const manual = await patchProject(returned, { receipt: made.receipt });
  assert.notEqual(manual.diff, "");
  manualDiff = manual.diff;
  const from = await patchFrom({ platform: base, submissionId: "sbm_1", deps: deps() });
  assert.equal(from.cutAgain, false);
  // The platform's hidden suite is the acceptance test uploaded: the hash recorded here is the handout's.
  assert.deepEqual(
    [from.commitment.comparable, from.commitment.match, from.commitment.version],
    [true, true, 2],
  );
  assert.equal(from.commitment.actual, platformCommitment(uploadedTests));
  assert.equal(from.patch.diff, manual.diff);
  assert.deepEqual(
    [from.patch.changed, from.patch.added, from.patch.deleted, from.patch.refused, from.patch.boundary],
    [manual.changed, manual.added, manual.deleted, manual.refused, manual.boundary],
  );
  // In the repository's names again.
  assert.match(from.patch.diff, /apps\/web\/src\/LunoxCart\.ts/);
  // The folder itself was not touched.
  assert.ok(!readFileSync(join(made.out, submission[0]?.path ?? ""), "utf8").includes("count()"));

  // With the folder gone, it is cut again from the receipt at the cut's commit.
  renameSync(made.out, join(scratch, "folder-away"));
  try {
    const again = await patchFrom({ platform: base, submissionId: "sbm_1", deps: deps() });
    assert.equal(again.cutAgain, true);
    assert.equal(again.patch.diff, manual.diff);
  } finally {
    renameSync(join(scratch, "folder-away"), made.out);
  }
});

test("carveout patch --from prints what patch <dir> prints, with its exit codes; handoff --platform asks for what it needs first", async () => {
  const from = await cli(["patch", "--from", "sbm_1", "--platform", base]);
  assert.equal(from.status, 0, from.stderr);
  assert.equal(from.stdout, manualDiff);
  assert.match(from.stderr, /submission sbm_1: 2 file\(s\) from http:\/\/127\.0\.0\.1:\d+, on the folder uploaded as version sbv_1/);
  const json = await cli(["patch", "--from", "sbm_1", "--platform", base, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal((JSON.parse(json.stdout) as { diff: string }).diff, manualDiff);
  const refused = await cli(["patch", "--from", "sbm_failed", "--platform", base]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /patch --from: Only a passing submission's files are taken back\. \(not_passed\)/);
  assert.equal((await cli(["patch", "--from", "sbm_1", "some-folder"])).status, 1);
  const noBounty = await cli(["handoff", "apps/web/src/LunoxCart.ts", "--out", join(scratch, "never"), "--platform"]);
  assert.equal(noBounty.status, 1);
  assert.match(noBounty.stderr, /--bounty <id>/);
  const keptNames = await cli(["handoff", "apps/web/src/LunoxCart.ts", "--out", join(scratch, "never"), "--platform", "--bounty", "bty_1", "--keep-names"]);
  assert.match(keptNames.stderr, /drop --keep-names/);
  const noAccept = await cli(["handoff", "apps/web/src/LunoxCart.ts", "--out", join(scratch, "never"), "--platform", base, "--bounty", "bty_1"]);
  assert.match(noAccept.stderr, /needs --accept/);
  assert.ok(!existsSync(join(scratch, "never")));
});

test("patch --from refuses a submission it cannot place, a path outside the folder, and the platform's refusals", async () => {
  await assert.rejects(patchFrom({ platform: base, submissionId: "sbm_other", deps: deps() }), /this machine did not upload/);
  await assert.rejects(patchFrom({ platform: base, submissionId: "sbm_odd", deps: deps() }), /not a plain path/);
  await assert.rejects(patchFrom({ platform: base, submissionId: "sbm_failed", deps: deps() }), (error: unknown) => error instanceof PlatformError && error.code === "not_passed");
  await assert.rejects(patchFrom({ platform: base, submissionId: "sbm_1", deps: { ...deps(), env: { LUNOX_CREDENTIALS: join(scratch, "none") } } }), /Not signed in/);
});

test("handoff --platform uploads only a public folder in pseudonyms, with acceptance tests that map into its names", async () => {
  const kept = await cut("kept", { pseudonyms: false });
  assert.ok(kept.receipt !== null);
  await assert.rejects(
    handoffPlatform({ platform: base, bountyId: "bty_1", folder: kept.out, receiptPath: kept.receipt, accepted: [{ path: ACCEPT, text: ACCEPT_TEXT }], deps: deps() }),
    /public folder in pseudonyms/,
  );
  const made = await cut("second");
  assert.ok(made.receipt !== null);
  await assert.rejects(
    handoffPlatform({ platform: base, bountyId: "bty_1", folder: made.out, receiptPath: made.receipt, accepted: [], deps: deps() }),
    /--accept/,
  );
  // The receipt of another cut than the folder's.
  const other = await cut("third");
  assert.ok(other.receipt !== null);
  await assert.rejects(
    handoffPlatform({ platform: base, bountyId: "bty_1", folder: made.out, receiptPath: other.receipt, accepted: [{ path: ACCEPT, text: ACCEPT_TEXT }], deps: deps() }),
    /not the folder of cut/,
  );
  // A binary file is never sent as text.
  writeFileSync(join(made.out, "logo.bin"), Buffer.from([0, 1, 2, 255]));
  assert.throws(() => folderFiles(made.out), /not UTF-8 text/);
});

test("stagedHiddenSha256 is the platform's version 2 commitment, byte for byte with duediligence's", () => {
  // duediligence's bin/hash.mjs stagedHiddenSha256 on the same tests.
  const tests = [
    { path: "src/b/z.test.ts", text: "b\n" },
    { path: "src/a.spec.ts", text: "a\n" },
    { path: "src/\u00c4.test.ts", text: "\u00fc\n" },
    { path: "src/Z.test.ts", text: "" },
  ];
  assert.equal(stagedHiddenSha256(tests), "31fc23166e4c31e8aad16fe7554b04e3f818a9197e2016c0140cedf1844ceb23");
  assert.equal(stagedHiddenSha256(tests), platformCommitment(tests));
  assert.equal(stagedHiddenSha256([...tests].reverse()), stagedHiddenSha256(tests), "order-free");
  assert.equal(stagedHiddenSha256([]), null);
  const hash = stagedHiddenSha256(tests);
  assert.deepEqual(commitmentCheck({ hiddenSha256: hash, hiddenSha256Version: 2 }, { hiddenSha256: hash }).match, true);
  assert.deepEqual(commitmentCheck({ hiddenSha256: "0".repeat(64), hiddenSha256Version: 2 }, { hiddenSha256: hash }).match, false);
  const legacy = commitmentCheck({ hiddenSha256: hash, hiddenSha256Version: 1 }, { hiddenSha256: hash });
  assert.deepEqual([legacy.comparable, legacy.match], [false, null]);
  assert.match(legacy.reason, /hiddenSha256Version 1: .*not compared/);
  assert.match(commitmentCheck({ hiddenSha256: hash, hiddenSha256Version: 3 }, { hiddenSha256: hash }).reason, /newer than this carveout computes/);
  assert.match(commitmentCheck({ hiddenSha256: hash, hiddenSha256Version: 2 }, {}).reason, /did not keep the commitment/);
});

test("patch --from refuses a version whose hidden suite is not the one uploaded, says when it cannot compare, and refuses a starter submission", async () => {
  assert.ok(uploadedTests.length > 0, "runs after the round trip");
  await assert.rejects(
    patchFrom({ platform: base, submissionId: "sbm_swapped", deps: deps() }),
    (error: unknown) =>
      error instanceof PlatformError && error.code === "commitment_mismatch" && /not the acceptance tests uploaded from here/.test(error.message),
  );
  const legacy = await patchFrom({ platform: base, submissionId: "sbm_legacy", deps: deps() });
  assert.deepEqual([legacy.commitment.comparable, legacy.commitment.version], [false, 1]);
  assert.equal(legacy.patch.diff, manualDiff);
  const cli1 = await cli(["patch", "--from", "sbm_legacy", "--platform", base]);
  assert.equal(cli1.status, 0, cli1.stderr);
  assert.match(cli1.stderr, /hidden suite: hiddenSha256Version 1: .*not compared/);
  const cli2 = await cli(["patch", "--from", "sbm_1", "--platform", base, "--json"]);
  assert.equal((JSON.parse(cli2.stdout) as { commitment: { match: boolean } }).commitment.match, true);
  await assert.rejects(patchFrom({ platform: base, submissionId: "sbm_starter", deps: deps() }), /generated \(starter\) version.*get_submission_files/);
});

test("handoff --platform sends a refused upload again after Retry-After under a new key, bounded, and stops on what a person must act on", async () => {
  const made = await cut("retry");
  assert.ok(made.receipt !== null);
  const upload = (bountyId: string) =>
    handoffPlatform({ platform: base, bountyId, folder: made.out, receiptPath: made.receipt ?? "", accepted: [{ path: ACCEPT, text: ACCEPT_TEXT }], deps: deps() });
  const before = seen.length;
  slept.length = 0;
  uploadRefusals.set("bty_busy", [
    { status: 409, body: { error: "The active analysis limit has been reached.", code: "run_limit" }, headers: { "Retry-After": "7" } },
    { status: 409, body: { error: "In use.", code: "idempotency_key_in_use" } },
  ]);
  const done = await upload("bty_busy");
  assert.equal(done.versionId, "sbv_1");
  const posts = seen.slice(before).filter((call) => call.method === "POST");
  assert.equal(posts.length, 3);
  const keys = posts.map((call) => String(call.headers["idempotency-key"]));
  assert.notEqual(keys[0], keys[1], "a refusal that stored nothing is sent under a new key");
  assert.equal(keys[1], keys[2], "a key still in use is sent again under the same key");
  assert.deepEqual(slept, [7000, 30000]);
  assert.match(warned.join(""), /run_limit\); sending it again in 7 s \(attempt 2\)/);

  uploadRefusals.set("bty_full", Array.from({ length: 4 }, () => ({ status: 409, body: { error: "Busy.", code: "run_limit", retryable: true } })));
  await assert.rejects(upload("bty_full"), /Still refused after 4 attempts/);
  uploadRefusals.set("bty_old", [{ status: 422, body: { error: "Old.", code: "carveout_too_old", minimumVersion: "9.0.0" } }]);
  await assert.rejects(upload("bty_old"), (error: unknown) => error instanceof PlatformError && /upgrade to at least 9\.0\.0/.test(error.message));
  uploadRefusals.set("bty_quota", [{ status: 429, body: { error: "x", code: "quota_exceeded", kind: "evaluator_seconds", resetsAt: "2026-12-01T00:00:00.000Z" } }]);
  const sends = seen.length;
  await assert.rejects(upload("bty_quota"), /monthly evaluator time/);
  assert.equal(seen.slice(sends).filter((call) => call.method === "POST").length, 1, "a quota refusal is not looped on");
});
