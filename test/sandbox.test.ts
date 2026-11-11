/**
 * A folder that came back holds someone else's code. Before any of it runs,
 * check reads what patch keeps out: the test side is put back as the cut
 * wrote it, what the folder added is taken out, and any other file patch
 * keeps out stops the check. What runs then runs in a container that mounts
 * only the check's copy, with no network but for the install. The container
 * test runs where Docker (or `CARVEOUT_CONTAINER`) answers; set
 * CARVEOUT_TEST_SANDBOX=0 to skip it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { checkProject, cutSlice, folderCameBack, patchProject } from "../src/carve.js";
import { installCommand } from "../src/mergeback.js";
import { defaultSandbox, sandboxUnavailable } from "../src/sandbox.js";

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");
const ENTRY = "apps/shop/src/cart.ts";

let scratch = "";
let repo = "";
let cuts = 0;

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

const cut = async () =>
  cutSlice({
    repo,
    out: join(scratch, `slice-${(cuts += 1)}`),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
  });

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-sandbox-"));
  repo = join(scratch, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("a folder came back when it is edited, or when no receipt can say it is not", async () => {
  const { out } = await cut();
  assert.equal(folderCameBack(out), false);
  write(join(out, "apps/shop/src/new.ts"), "export const n = 1;\n");
  assert.equal(folderCameBack(out), true);
  const bare = await cutSlice({ repo, out: join(scratch, "bare"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true, receipt: false });
  assert.equal(folderCameBack(bare.out), true, "its own record cannot vouch for it");
});

test("what patch keeps out never runs: an added file is taken out, a slice file that gained reach stops the check", async () => {
  const { out } = await cut();
  // A new test that reads the disk: taken out of the check's copy.
  write(join(out, "apps/shop/src/steal.test.ts"), 'import { readFileSync } from "node:fs";\nimport { test } from "node:test";\ntest("x", () => { readFileSync("/etc/hosts"); });\n');
  const held = (await patchProject(out)).refused.map((refusal) => refusal.path);
  assert.deepEqual(held, ["apps/shop/src/steal.test.ts"]);
  // The slice's own code reaching the network: nothing of the folder runs.
  write(join(out, ENTRY), `${"export const ping = () => fetch(\"https://example.invalid\");\n"}`);
  const reached = (await patchProject(out)).refused.map((refusal) => refusal.path).sort();
  assert.deepEqual(reached, [ENTRY, "apps/shop/src/steal.test.ts"]);
  const steps = await checkProject(out, { held: reached, refuseHeld: true });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.command, "policy");
  assert.equal(steps[0]?.ok, false);
  assert.match(steps[0]?.output ?? "", /apps\/shop\/src\/cart\.ts/);
  assert.doesNotMatch(steps[0]?.output ?? "", /steal\.test/, "an added file is taken out, not a reason to stop");
});

test("a sandboxed verify installs as the lockfile says, with scripts off", () => {
  const root = join(scratch, "locks");
  mkdirSync(root, { recursive: true });
  assert.equal(installCommand(root), null);
  writeFileSync(join(root, "package.json"), "{}\n");
  assert.match(installCommand(root) ?? "", /^npm install --ignore-scripts/);
  writeFileSync(join(root, "yarn.lock"), "");
  assert.match(installCommand(root) ?? "", /yarn install --frozen-lockfile --ignore-scripts/);
  writeFileSync(join(root, ".yarnrc.yml"), "");
  assert.match(installCommand(root) ?? "", /yarn install --immutable --mode=skip-build/);
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  assert.match(installCommand(root) ?? "", /pnpm install --frozen-lockfile --ignore-scripts/);
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  assert.match(installCommand(root) ?? "", /^npm ci --ignore-scripts/);
});

const spec = defaultSandbox();
const unavailable = process.env["CARVEOUT_TEST_SANDBOX"] === "0" ? "CARVEOUT_TEST_SANDBOX=0" : sandboxUnavailable(spec);

test("in the sandbox a folder's test sees only its copy: no maintainer's files, no network", { skip: unavailable ?? false, timeout: 10 * 60_000 }, async () => {
  const { out } = await cut();
  const marker = join(scratch, "marker.txt");
  // Allowed through (held: none), as a maintainer's --allow would: it tries
  // the maintainer's scratch folder, the receipts, and the network.
  write(
    join(out, "apps/shop/src/probe.test.ts"),
    [
      'import assert from "node:assert/strict";',
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { test } from "node:test";',
      `test("sees only its copy", async () => {`,
      `  assert.equal(existsSync(${JSON.stringify(scratch)}), false);`,
      `  assert.equal(existsSync(${JSON.stringify(process.env["CARVEOUT_HOME"] ?? "/nonexistent")}), false);`,
      `  assert.throws(() => writeFileSync(${JSON.stringify(marker)}, "x"));`,
      `  await assert.rejects(fetch("https://registry.npmjs.org/"));`,
      `  assert.equal(process.env["HOME"], "/tmp");`,
      "});",
      "",
    ].join("\n"),
  );
  const steps = await checkProject(out, { held: [], refuseHeld: true, sandbox: spec });
  const failed = steps.filter((step) => !step.ok);
  assert.deepEqual(failed.map((step) => `${step.command}: ${step.output}`), []);
  // The probe ran, and passed: it is the folder's only test.
  const counts = steps.find((step) => step.command === "npm test")?.counts;
  assert.equal(counts?.tests, 1);
  assert.equal(counts?.pass, 1);
  assert.equal(existsSync(marker), false);
  // The same probe on this machine fails: here it sees the maintainer's files.
  const host = await checkProject(out, { held: [], refuseHeld: true });
  assert.equal(host.find((step) => step.command === "npm test")?.ok, false);
});
