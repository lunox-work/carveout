/**
 * `carveout gate` on a change made in the repository itself: what it holds
 * for a reviewer (protected paths, deleted and weakened tests, check
 * configuration, suppressions, files outside a scope) and what it lets by.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, test } from "node:test";
import { gateRepository } from "../src/gate.js";

const CLI = resolve(import.meta.dirname, "../src/cli.js");

const TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { price } from "./price.js";

test("prices", () => {
  assert.equal(price(1), 4);
  assert.equal(price(2), 8);
});
`;

let scratch = "";
let repo = "";

const git = (args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");

const write = (path: string, text: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};

const reasons = () =>
  gateRepository({ repo }).refused.map(({ path, reason }) => `${path}: ${reason}`);

beforeEach(() => {
  scratch ||= mkdtempSync(join(tmpdir(), "carveout-gate-"));
  repo = mkdtempSync(join(scratch, "repo-"));
  git(["init", "-q"]);
  write("package.json", '{ "name": "p", "type": "module" }\n');
  write("tsconfig.json", '{ "compilerOptions": { "strict": true } }\n');
  write("src/price.ts", "export const price = (n: number) => n * 4;\n");
  write("src/price.test.ts", TEST);
  write(".github/workflows/ci.yml", "on: push\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("a change to code alone, and a test only added to, pass", () => {
  write("src/price.ts", "export const price = (n: number) => n * 4 + 0;\n");
  write("src/price.test.ts", TEST.replace("});\n", "  assert.equal(price(0), 0);\n});\n"));
  write("src/new.ts", "export const two = 2;\n");
  const gate = gateRepository({ repo });
  assert.deepEqual(gate.refused, []);
  assert.deepEqual(
    gate.changes.map(({ path, change }) => `${change} ${path}`),
    ["added src/new.ts", "changed src/price.test.ts", "changed src/price.ts"],
  );
});

test("holds protected paths, deleted tests and weakened tests", () => {
  write("package.json", '{ "name": "p", "type": "module", "scripts": { "test": "true" } }\n');
  write(".github/workflows/ci.yml", "on: workflow_dispatch\n");
  write("src/price.test.ts", TEST.replace("price(1), 4", "price(1), 5"));
  write("src/other.test.ts", TEST);
  git(["add", "src/other.test.ts"]);
  git(["commit", "-q", "-m", "other"]);
  unlinkSync(join(repo, "src/other.test.ts"));
  const held = reasons();
  assert.equal(held.length, 4, held.join("\n"));
  assert.match(held.find((line) => line.startsWith(".github/")) ?? "", /protected path/);
  assert.match(held.find((line) => line.startsWith("package.json")) ?? "", /protected path/);
  assert.match(held.find((line) => line.startsWith("src/other.test.ts")) ?? "", /deletes a test$/);
  assert.match(
    held.find((line) => line.startsWith("src/price.test.ts")) ?? "",
    /rewrites 1 assertion of a test:/,
  );
});

test("holds a test skipped or focused with .only", () => {
  write("src/price.test.ts", TEST.replace('test("prices"', 'test.only("prices"'));
  assert.match(reasons().join("\n"), /focuses 1 more test with \.only/);
  write("src/price.test.ts", TEST.replace('test("prices"', 'test.skip("prices"'));
  assert.match(reasons().join("\n"), /skips 1 more test/);
});

test("holds check configuration edited and suppressions added", () => {
  write("tsconfig.json", '{ "compilerOptions": { "strict": false } }\n');
  write("src/price.ts", "// @ts-ignore\nexport const price = (n: number) => n * 4;\n");
  const held = reasons().join("\n");
  assert.match(held, /tsconfig\.json: changes what a check holds code to/);
  assert.match(held, /src\/price\.ts: adds 1 check suppression/);
  // A new tsconfig, for a new package, is not a loosening.
  write("packages/x/tsconfig.json", "{}\n");
  assert.doesNotMatch(reasons().join("\n"), /packages\/x/);
});

test("--scope holds files outside it, --allow lets one through", () => {
  write("src/price.ts", "export const price = (n: number) => n * 5;\n");
  write("docs/notes.md", "notes\n");
  const scoped = gateRepository({ repo, scope: ["src"] });
  assert.deepEqual(
    scoped.refused.map(({ path }) => path),
    ["docs/notes.md"],
  );
  assert.deepEqual(gateRepository({ repo, scope: ["src"], allow: ["docs/**"] }).refused, []);
});

test("compares with a base commit, committed changes included", () => {
  const base = git(["rev-parse", "HEAD"]).trim();
  write("src/price.test.ts", TEST.replace("  assert.equal(price(2), 8);\n", ""));
  git(["commit", "-qam", "drop an assertion"]);
  assert.deepEqual(gateRepository({ repo }).refused, []);
  assert.match(
    gateRepository({ repo, base }).refused.map(({ reason }) => reason).join("\n"),
    /removes or rewrites 1 assertion/,
  );
});

test("the CLI exits 6, or 2 once as a Stop hook", () => {
  write("src/price.test.ts", TEST.replace("price(1), 4", "price(1), 5"));
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, [CLI, "gate", ...args], { cwd: repo, input, encoding: "utf8" });
  const plain = run([]);
  assert.equal(plain.status, 6, plain.stderr);
  assert.match(plain.stdout, /1 held for review/);
  const hook = run(["--hook"], "{}");
  assert.equal(hook.status, 2);
  assert.match(hook.stderr, /say so plainly in your reply/);
  assert.equal(run(["--hook"], '{"stop_hook_active": true}').status, 0);
  const json = JSON.parse(run(["--json"]).stdout) as { refused: unknown[] };
  assert.equal(json.refused.length, 1);
});
