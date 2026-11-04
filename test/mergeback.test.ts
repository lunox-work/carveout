/**
 * Mergeback on the shop fixture: what `patch` carries back beyond a plain
 * edit (deletions, new files, new imports), what it refuses to carry, and
 * `apply` and `merge` around it. Offline, like the end-to-end test.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { cutSlice, patchProject, undoRewrites } from "../src/carve.js";
import { applyPatch, mergeProject } from "../src/mergeback.js";

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const ENTRY = "apps/shop/src/cart.ts";
const CART = "apps/shop/src/cart.ts";

let scratch = "";
let repo = "";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");

/** A cut of the fixture into a new folder named `name`. */
const cut = async (name: string) =>
  (
    await cutSlice({
      repo,
      out: join(scratch, name),
      entryPoints: [ENTRY],
      budget: { maxFiles: 40, maxDepth: 1 },
      offline: true,
    })
  ).out;

/** A fresh clone of the fixture at its one commit. */
const clone = (name: string) => {
  const path = join(scratch, name);
  git(scratch, ["clone", "-q", repo, path]);
  return path;
};

const edit = (path: string, from: string, to: string) => {
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes(from), `${path} has ${from}`);
  writeFileSync(path, text.replace(from, to));
};

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-mergeback-"));
  repo = join(scratch, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  // A test outside the slice (cuts here do not bring tests along).
  writeFileSync(
    join(repo, "apps/shop/src/cart.test.ts"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtotal } from "./cart";\n\ntest("subtotal", () => assert.equal(subtotal([]), 0));\n',
  );
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("a patch carries deletions, new files and new imports as the repository writes them", async () => {
  const out = await cut("edits");
  const src = join(out, "apps/shop/src");
  // A new file importing a workspace stub and a slice file by folder paths.
  writeFileSync(
    join(src, "discount.ts"),
    [
      'import { format } from "../../../packages/money/src/index.js";',
      'import { TAX_RATE } from "./tax.js";',
      'export const discount = (cents: number) => format(cents * (1 - TAX_RATE), "usd");',
      "",
    ].join("\n"),
  );
  // What `npm run build` writes beside it.
  writeFileSync(join(src, "discount.js"), "export const discount = 1;\n");
  edit(join(src, "cart.ts"), 'import "./cart.css";\n', 'import { discount } from "./discount.js";\n');
  rmSync(join(src, "cart.css"));
  // A test against the mocks, which the repository cannot run.
  writeFileSync(
    join(src, "cart.mock.test.ts"),
    'import { recordedCalls } from "../../../carveout/mock.js";\nrecordedCalls();\n',
  );
  edit(
    join(out, "packages/money/src/index.d.ts"),
    "export declare function format",
    "export declare function parse(text: string): number;\nexport declare function format",
  );
  edit(join(out, "package.json"), '"dependencies": {', '"dependencies": {\n    "left-pad": "1.3.0",');

  const patch = await patchProject(out);
  assert.deepEqual(patch.changed, [CART]);
  assert.deepEqual(patch.added, ["apps/shop/src/discount.ts"]);
  assert.deepEqual(patch.deleted, ["apps/shop/src/cart.css"]);
  assert.deepEqual(patch.sliceOnly, ["apps/shop/src/cart.mock.test.ts"]);
  assert.deepEqual(patch.crossPackage, []);
  assert.deepEqual(
    patch.boundary.map((item) => [item.kind, item.path]),
    [
      ["dependency", "package.json"],
      ["stub", "packages/money/src/index.d.ts"],
    ],
  );
  assert.match(patch.boundary[0]?.detail ?? "", /adds left-pad/);
  // The workspace package by name, the alias the slice's own import uses,
  // and the app's extensionless style for the new file.
  assert.match(patch.diff, /^\+import \{ format \} from "@fx\/money";$/m);
  assert.match(patch.diff, /^\+import \{ TAX_RATE \} from "@\/tax";$/m);
  assert.match(patch.diff, /^\+import \{ discount \} from "\.\/discount";$/m);
  assert.match(patch.diff, /^deleted file mode/m);
  assert.doesNotMatch(patch.diff, /discount\.js|cart\.test|packages\/money/);
  const into = clone("edits-into");
  const file = join(scratch, "edits.patch");
  writeFileSync(file, patch.diff);
  git(into, ["apply", "--3way", file]);
  assert.match(readFileSync(join(into, CART), "utf8"), /^import \{ tax \} from "@\/tax";$/m);
});

test("apply brings a repository change into the slice, and patch gives it back", async () => {
  const out = await cut("applied");
  // The change, made in the repository: a new module in the slice, a new
  // function in the workspace package it uses, and a caller outside.
  const work = clone("change");
  writeFileSync(
    join(work, "apps/shop/src/discount.ts"),
    'import { format } from "@fx/money";\n\nexport const discount = (cents: number) => format(cents, "usd");\n',
  );
  edit(
    join(work, CART),
    'import { CURRENCIES, format, type Currency } from "@fx/money";',
    'import { CURRENCIES, format, parse, type Currency } from "@fx/money";\nimport { discount } from "./discount";',
  );
  edit(
    join(work, CART),
    "export function client",
    "export function parsed(text: string): string {\n  return discount(parse(text));\n}\n\nexport function client",
  );
  edit(
    join(work, "packages/money/src/index.ts"),
    "export function format",
    "export function parse(text: string): number {\n  return Math.round(Number(text) * 100);\n}\n\nexport function format",
  );
  edit(join(work, "apps/shop/src/checkout.ts"), "Total: ", "Total due: ");
  // An existing test the slice did not hold: it joins the slice.
  edit(join(work, "apps/shop/src/cart.test.ts"), "subtotal([]), 0", "subtotal([{ cents: 1, quantity: 2 }]), 2");
  git(work, ["add", "-A"]);
  const change = git(work, ["diff", "--cached", "--full-index"]);

  const needs = await applyPatch(out, change);
  assert.deepEqual(needs.changed, ["apps/shop/src/cart.test.ts", CART]);
  assert.deepEqual(needs.added, ["apps/shop/src/discount.ts"]);
  assert.deepEqual(needs.outside, ["apps/shop/src/checkout.ts", "packages/money/src/index.ts"]);
  assert.deepEqual(
    needs.stubs.map((stub) => [stub.path, stub.detail, stub.written]),
    [["packages/money/src/index.d.ts", "added parse", false]],
  );
  // The folder now holds the change as a cut writes it.
  assert.match(
    readFileSync(join(out, CART), "utf8"),
    /from "\.\/discount\.js"/,
  );
  const grown = await applyPatch(out, change, { stubs: true });
  assert.equal(grown.stubs[0]?.written, true);
  execFileSync(
    "npm",
    ["install", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: out, stdio: "pipe" },
  );
  execFileSync(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: out, stdio: "pipe" });

  // Back out: the slice's part of the change, byte for byte.
  const patch = await patchProject(out);
  assert.deepEqual(patch.boundary, []);
  assert.deepEqual(patch.changed, ["apps/shop/src/cart.test.ts", CART]);
  assert.deepEqual(patch.added, ["apps/shop/src/discount.ts"]);
  const into = clone("applied-into");
  const file = join(scratch, "applied.patch");
  writeFileSync(file, patch.diff);
  git(into, ["apply", file]);
  for (const path of [CART, "apps/shop/src/discount.ts", "apps/shop/src/cart.test.ts"])
    assert.equal(
      readFileSync(join(into, path), "utf8"),
      readFileSync(join(work, path), "utf8"),
      path,
    );
});

test("merge applies the edits in a named checkout and runs the verify command there", async () => {
  const out = await cut("merged");
  edit(join(out, "apps/shop/src/tax.ts"), "0.1", "0.2");
  const into = clone("merged-into");
  const passed = await mergeProject(out, {
    into,
    verify: "grep -q 'TAX_RATE = 0.2' apps/shop/src/tax.ts",
  });
  assert.deepEqual(
    passed.steps.map((step) => [step.step, step.ok]),
    [
      ["patch", true],
      ["apply", true],
      ["verify", true],
    ],
  );
  const again = await mergeProject(out, { into: clone("merged-again"), verify: "exit 3" });
  assert.equal(again.ok, false);
  assert.deepEqual(again.steps.at(-1), { step: "verify", ok: false, output: "" });
  await assert.rejects(mergeProject(out, { into: scratch }), /not the root of a Git checkout/);
});

test("npm test runs a test added after the cut, and patch carries it", async () => {
  const out = await cut("late-test");
  writeFileSync(
    join(out, "apps/shop/src/late.test.ts"),
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { subtotal } from "./cart.js";',
      'test("added after the cut", () => assert.equal(subtotal([{ cents: 2, quantity: 3 }]), 6));',
      "",
    ].join("\n"),
  );
  execFileSync(
    "npm",
    ["install", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: out, stdio: "pipe" },
  );
  execFileSync(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: out, stdio: "pipe" });
  const output = execFileSync(process.execPath, ["carveout/test.js"], {
    cwd: out,
    stdio: "pipe",
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
    ),
  }).toString("utf8");
  assert.match(output, /added after the cut/);
  const patch = await patchProject(out);
  assert.deepEqual(patch.added, ["apps/shop/src/late.test.ts"]);
  assert.match(patch.diff, /^\+import \{ subtotal \} from "\.\/cart";$/m);
});

test("two imports rewritten to one come back as the source wrote each", () => {
  const original = 'import { a } from "@/lib/format";\nimport { b } from "../lib/format";\n';
  const cut = 'import { a } from "../lib/format.js";\nimport { b } from "../lib/format.js";\n';
  const rewrites = [
    { file: "src/x/y.ts", from: "../lib/format", to: "../lib/format.js" },
    { file: "src/x/y.ts", from: "@/lib/format", to: "../lib/format.js" },
  ];
  assert.equal(undoRewrites(cut, rewrites, original), original);
});

test("a slice holds the repository's checks and its coverage of added code", async () => {
  const { coverageGateOf, projectCompilerOptions } = await import("../src/core.js");
  const options = projectCompilerOptions({ noUnusedLocals: true, noUnusedParameters: true, paths: { "@/*": ["x"] } });
  assert.equal(options["noUnusedLocals"], true);
  assert.equal(options["noUnusedParameters"], true);
  assert.equal(options["paths"], undefined);
  assert.deepEqual(
    coverageGateOf(
      "packages/core",
      "tsc -p tsconfig.test.json && node --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=85 --test dist-test/test/*.test.js",
    ),
    { folder: "packages/core", tests: "test/*.test.ts", lines: 90, branches: 85 },
  );
  assert.equal(coverageGateOf("", "vitest run"), null);
  // The never-loaded-file guard, with its exemptions, back at the sources.
  assert.deepEqual(
    coverageGateOf(
      "packages/db",
      "rm -rf dist-test && tsc -p tsconfig.test.json && node --experimental-test-coverage --test-coverage-lines=90 --test dist-test/test/*.test.js > dist-test/coverage.txt; status=$?; cat dist-test/coverage.txt; [ $status -eq 0 ] && assert-all-covered dist-test/src dist-test/coverage.txt index.js migrate-cli.js",
    ),
    { folder: "packages/db", tests: "test/*.test.ts", allCovered: { dir: "src", excluded: ["index.js", "migrate-cli.js"] }, lines: 90 },
  );
});

test("npm test fails on a file added under the package that no test loads, as the repository's guard does", async () => {
  const work = clone("guard-repo");
  const manifest = join(work, "apps/shop/package.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        ...JSON.parse(readFileSync(manifest, "utf8")),
        scripts: {
          test: "tsc -p tsconfig.test.json && node --experimental-test-coverage --test-coverage-lines=1 --test dist-test/test/*.test.js > dist-test/coverage.txt; status=$?; cat dist-test/coverage.txt; [ $status -eq 0 ] && assert-all-covered dist-test/src dist-test/coverage.txt index.js",
        },
      },
      null,
      2,
    ),
  );
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "a guard"]);
  const out = (
    await cutSlice({
      repo: work,
      out: join(scratch, "guard"),
      entryPoints: [ENTRY],
      budget: { maxFiles: 40, maxDepth: 1 },
      offline: true,
      tests: true,
    })
  ).out;
  assert.match(readFileSync(join(out, "README.md"), "utf8"), /loaded by no test/);
  // A new source nothing imports, and an exempted one.
  writeFileSync(join(out, "apps/shop/src/report.ts"), "export const report = (cents: number) => cents * 2;\n");
  writeFileSync(join(out, "apps/shop/src/index.ts"), 'export { report } from "./report.js";\n');
  execFileSync(
    "npm",
    ["install", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: out, stdio: "pipe" },
  );
  cpSync(resolve(import.meta.dirname, "../../node_modules/@types/node"), join(out, "node_modules/@types/node"), { recursive: true });
  const build = () => execFileSync(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: out, stdio: "pipe" });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const run = () => spawnSync(process.execPath, ["carveout/test.js"], { cwd: out, env, encoding: "utf8" });
  build();
  const unloaded = run();
  assert.equal(unloaded.status, 1, unloaded.stdout);
  assert.match(unloaded.stdout, /never-loaded-file guard/);
  assert.match(unloaded.stdout, /^  apps\/shop\/src\/report\.js$/m);
  assert.doesNotMatch(unloaded.stdout, /^  apps\/shop\/src\/index\.js$/m);
  // A test that loads it, where the repository's script runs tests.
  mkdirSync(join(out, "apps/shop/test"), { recursive: true });
  writeFileSync(
    join(out, "apps/shop/test/report.test.ts"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { report } from "../src/report.js";\n\ntest("report", () => assert.equal(report(2), 4));\n',
  );
  build();
  const loaded = run();
  assert.equal(loaded.status, 0, loaded.stdout);
});

test("apply brings a module the patch adds past the cut's reach, with its test", async () => {
  const out = await cut("apply-added");
  const work = clone("apply-added-repo");
  // A module nothing in the slice imports, and a test of it.
  writeFileSync(
    join(work, "apps/shop/src/report.ts"),
    'import { TAX_RATE } from "./tax.js";\nexport const taxed = (cents: number) => cents * (1 + TAX_RATE);\n',
  );
  writeFileSync(
    join(work, "apps/shop/src/report.test.ts"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { taxed } from "./report.js";\n\ntest("taxed", () => assert.equal(taxed(100), 110));\n',
  );
  git(work, ["add", "-A"]);
  const change = git(work, ["diff", "--cached", "--full-index"]);
  const applied = await applyPatch(out, change);
  assert.deepEqual(applied.added, ["apps/shop/src/report.test.ts", "apps/shop/src/report.ts"]);
  assert.deepEqual(applied.outside, []);
  assert.deepEqual(applied.stubs, []);
  assert.match(readFileSync(join(out, "apps/shop/src/report.ts"), "utf8"), /from "\.\/tax\.js"/);
  // Back out as the repository wrote it.
  const patch = await patchProject(out);
  assert.deepEqual(patch.added, ["apps/shop/src/report.test.ts", "apps/shop/src/report.ts"]);
  // Its import comes back as the repository's neighbours spell the target.
  assert.match(patch.diff, /^\+import \{ TAX_RATE \} from "@\/tax";$/m);
});

test("a live package is installed, and the environment its importers read is left to the shell", async () => {
  const { computeCut } = await import("../src/carve.js");
  const work = clone("live-repo");
  const manifest = join(work, "apps/shop/package.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  writeFileSync(manifest, `${JSON.stringify({ ...parsed, dependencies: { ...parsed.dependencies, pg: "^8.11.0" } }, null, 2)}\n`);
  writeFileSync(
    join(work, "apps/shop/src/db.ts"),
    'import pg from "pg";\n\nexport const url = process.env["DATABASE_URL"] ?? "postgres://localhost/shop";\nexport const pool = new pg.Pool({ connectionString: url });\nexport const region = process.env["SHOP_REGION"] ?? "sg";\n',
  );
  writeFileSync(join(work, "apps/shop/src/flags.ts"), 'export const beta = process.env["SHOP_BETA"] === "1";\n');
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "a database"]);
  const request = {
    repo: work,
    entryPoints: ["apps/shop/src/db.ts", "apps/shop/src/flags.ts"],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
  };
  const text = (cut: Awaited<ReturnType<typeof computeCut>>, path: string) => cut.files.find((file) => file.path === path)?.text ?? "";
  const mocked = await computeCut(request);
  assert.equal(mocked.record.dependencies.find((d) => d.name === "pg")?.resolution, "runtime-mock");
  assert.match(text(mocked, "carveout.env"), /^DATABASE_URL=carveout-database-url$/m);
  assert.equal(mocked.record.request.live, undefined);
  const live = await computeCut({ ...request, live: ["pg"] });
  assert.equal(live.record.dependencies.find((d) => d.name === "pg")?.resolution, "approved-package");
  assert.deepEqual(live.record.request.live, ["pg"]);
  // What db.ts reads is the shell's; what flags.ts reads is still a placeholder.
  assert.doesNotMatch(text(live, "carveout.env"), /^DATABASE_URL=/m);
  assert.doesNotMatch(text(live, "carveout.env"), /^SHOP_REGION=/m);
  assert.match(text(live, "carveout.env"), /^SHOP_BETA=carveout-shop-beta$/m);
  assert.match(text(live, "carveout.env"), /left to the shell: DATABASE_URL, SHOP_REGION/);
  assert.match(text(live, "README.md"), /Live packages[\s\S]*- `pg`[\s\S]*left to the shell[\s\S]*- `DATABASE_URL`/);
  assert.match(text(live, "README.md"), /need their service running: pg/);
});

test("npm test does not count the tests that failed when the folder was checked", async () => {
  // A test that needs the real money module: on its mock it fails.
  const work = clone("baseline-repo");
  writeFileSync(
    join(work, "apps/shop/src/total.test.ts"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { total } from "./cart";\n\ntest("a total is formatted", () => assert.equal(total([{ cents: 100, quantity: 1 }], "usd"), "1.10 USD"));\n',
  );
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "a test"]);
  const out = (
    await cutSlice({
      repo: work,
      out: join(scratch, "baseline"),
      entryPoints: [ENTRY],
      budget: { maxFiles: 40, maxDepth: 1 },
      offline: true,
      tests: true,
    })
  ).out;
  execFileSync(
    "npm",
    ["install", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: out, stdio: "pipe" },
  );
  // Node's types, which the folder installs as a dev dependency.
  cpSync(resolve(import.meta.dirname, "../../node_modules/@types/node"), join(out, "node_modules/@types/node"), { recursive: true });
  execFileSync(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: out, stdio: "pipe" });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const run = () => spawnSync(process.execPath, ["carveout/test.js"], { cwd: out, env, encoding: "utf8" });
  assert.equal(run().status, 1);
  writeFileSync(join(out, "carveout/baseline.json"), JSON.stringify({ failing: ["a total is formatted"] }));
  const counted = run();
  assert.equal(counted.status, 0, counted.stdout);
  assert.match(counted.stdout, /1 test\(s\) failed as they did when the folder was checked/);
  writeFileSync(
    join(out, "apps/shop/src/late.test.ts"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("a new failure", () => assert.equal(1, 2));\n',
  );
  execFileSync(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: out, stdio: "pipe" });
  const fresh = run();
  assert.equal(fresh.status, 1);
  assert.match(fresh.stdout, /Failing now and not when the folder was checked:\n {2}a new failure/);
  // The baseline is the folder's own: the patch leaves it out.
  assert.doesNotMatch((await patchProject(out)).diff, /baseline\.json/);
});
