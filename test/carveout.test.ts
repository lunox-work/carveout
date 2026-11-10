/**
 * End to end on a small monorepo: a workspace package, a path alias,
 * bundler-style imports, a service SDK and a stylesheet. Offline: the
 * folder is built with this package's own TypeScript and tested with
 * Node, which is what `npm run build` and `npm test` run in it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import {
  cutSlice,
  patchProject,
  planSlice,
  undoRewrites,
  type CutResult,
} from "../src/carve.js";
import { sanitizeDeclaration } from "../src/extract/typescript.js";
import { withoutRoots } from "../src/extract/fixture.js";
import { buildGraph, globMatches } from "../src/graph.js";
import { statusProject, symbolDiff } from "../src/status.js";
import { scanSecrets } from "../src/project/secrets.js";

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const ENTRY = "apps/shop/src/cart.ts";

let scratch = "";
let repo = "";
let cut: CutResult;

const git = (args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  ).toString("utf8");

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-test-"));
  repo = join(scratch, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  cut = await cutSlice({
    repo,
    out: join(scratch, "slice"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
  });
});

after(() => {
  execFileSync("rm", ["-rf", scratch]);
});

test("the graph follows aliases and bundler imports, and names packages", () => {
  const { graph } = buildGraph(repo);
  const targets = graph.links
    .filter((link) => link.source === `file:${ENTRY}`)
    .map((link) => link.target)
    .sort();
  assert.deepEqual(targets, [
    "dependency:apps/shop/src/cart.ts:@fx/money",
    "dependency:apps/shop/src/cart.ts:stripe",
    "file:apps/shop/src/cart.css",
    "file:apps/shop/src/tax.ts",
  ]);
});

test("a plan lists the slice, its importers and its packages", () => {
  const plan = planSlice({
    repo,
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
  });
  assert.deepEqual(plan.walk.included, [
    "apps/shop/src/cart.css",
    "apps/shop/src/cart.ts",
    "apps/shop/src/tax.ts",
  ]);
  assert.deepEqual(plan.packages, ["@fx/money", "stripe"]);
  assert.deepEqual(plan.workspacePackages, ["@fx/money"]);
  assert.deepEqual(
    plan.walk.cuts.inbound.map((edge) => edge.from),
    ["apps/shop/src/checkout.ts"],
  );
  assert.deepEqual(
    plan.externals.environment.map((item) => item.name),
    ["STRIPE_KEY"],
  );
});

test("a cut is ready: the workspace package stubbed, the SDK mocked", () => {
  assert.equal(cut.record.ready, true, JSON.stringify(cut.record.blockers));
  assert.equal(cut.record.manifest.meta.stubCoverage, "full");
  const resolution = Object.fromEntries(
    cut.record.dependencies.map((d) => [d.name, d.resolution]),
  );
  assert.equal(resolution["packages/money/src/index.ts"], "runtime-mock");
  assert.equal(resolution["stripe"], "runtime-mock");
  const out = cut.out;
  for (const path of [
    "apps/shop/src/cart.ts",
    "apps/shop/src/tax.ts",
    "apps/shop/src/cart.css",
    "packages/money/src/index.d.ts",
    "packages/money/src/index.js",
    "carveout/packages/stripe/index.js",
    "carveout/mock.js",
    "carveout/assets.js",
    "carveout/tests/interface.test.ts",
    "carveout/contract.json",
    "carveout.json",
    "carveout.env",
    "BOUNDARY.md",
    "README.md",
    "package.json",
    "tsconfig.json",
  ])
    assert.ok(existsSync(join(out, path)), path);
  // Nothing outside the slice is copied.
  assert.equal(existsSync(join(out, "apps/shop/src/checkout.ts")), false);
  assert.equal(existsSync(join(out, "packages/money/src/index.ts")), false);
});

test("stubs keep literal types unless asked to widen them, and a type's members either way", async () => {
  const stub = readFileSync(
    join(cut.out, "packages/money/src/index.d.ts"),
    "utf8",
  );
  assert.match(stub, /"usd"/);
  const widened = await cutSlice({
    repo,
    out: join(scratch, "widened"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
    widenLiterals: true,
  });
  const text = readFileSync(
    join(widened.out, "packages/money/src/index.d.ts"),
    "utf8",
  );
  // `Currency` is `(typeof CURRENCIES)[number]`: its members stay, or the
  // slice would type-check `format(cents, "anything")`.
  assert.match(text, /readonly \["usd", "eur"\]|readonly \[\s*"usd",\s*"eur"\s*\]/);
  const values = sanitizeDeclaration(
    [
      'export declare const KINDS: readonly ["github", "jira"];',
      "export type Kind = (typeof KINDS)[number];",
      'export declare const ENDPOINT = "https://rates.internal.example/v2";',
      "export declare const DISCOUNT = 0.37;",
      'export declare const MIXED: readonly ["draft", "https://x.example", 3];',
      "export type Mixed = (typeof MIXED)[number];",
      'export declare const LONE: "draft";',
      "",
    ].join("\n"),
    { widenLiterals: true },
  );
  assert.match(values, /KINDS: readonly \[\s*"github",\s*"jira"\s*\]/);
  assert.match(values, /ENDPOINT: string/);
  assert.match(values, /DISCOUNT: number/);
  // Read as a type: the name stays, the URL and the number widen.
  assert.match(values, /MIXED: readonly \[\s*"draft",\s*string,\s*number\s*\]/);
  // Not read as a type: a value like any other.
  assert.match(values, /LONE: string/);
  assert.doesNotMatch(values, /rates\.internal|0\.37/);
});

test("imports are rewritten to what Node resolves, and recorded", () => {
  const cart = readFileSync(join(cut.out, "apps/shop/src/cart.ts"), "utf8");
  assert.match(cart, /from "\.\/tax\.js"/);
  assert.match(cart, /from "\.\.\/\.\.\/\.\.\/packages\/money\/src\/index\.js"/);
  assert.match(cart, /from "stripe"/);
  assert.match(cart, /import "\.\/cart\.css"/);
  const original = readFileSync(join(repo, ENTRY), "utf8");
  const rewrites = cut.record.importRewrites.filter((r) => r.file === ENTRY);
  assert.equal(undoRewrites(cart, rewrites), original);
});

test("the folder builds and its tests pass on its own", () => {
  // Links the mock packages, which are local; nothing is fetched.
  execFileSync(
    "npm",
    ["install", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: cut.out, stdio: "pipe" },
  );
  execFileSync(process.execPath, [TSC, "-p", "tsconfig.json"], {
    cwd: cut.out,
    stdio: "pipe",
  });
  const output = execFileSync(
    process.execPath,
    [
      "--env-file=carveout.env",
      "--import=./carveout/assets.js",
      "--test",
      "--test-reporter=tap",
      "carveout/tests/interface.test.js",
    ],
    {
      cwd: cut.out,
      stdio: "pipe",
      // A test run inside this one would otherwise skip its files.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
      ),
    },
  ).toString("utf8");
  assert.match(output, /# pass 1\n/);
  assert.match(output, /# fail 0\n/);
});

test("the public surface's types are checked, and a changed signature names its export", () => {
  const check = readFileSync(join(cut.out, "carveout/surface/check.ts"), "utf8");
  assert.match(check, /apps\/shop\/src\/cart\.ts \| total \| value$/m);
  assert.match(check, /apps\/shop\/src\/cart\.ts \| Line \| type$/m);
  // The folder's own build leaves the check to npm test.
  assert.match(readFileSync(join(cut.out, "tsconfig.json"), "utf8"), /"carveout\/surface"/);
  const surface = () => {
    try {
      execFileSync(process.execPath, [TSC, "-p", "carveout/surface/tsconfig.json", "--pretty", "false"], {
        cwd: cut.out,
        stdio: "pipe",
      });
      return "";
    } catch (error) {
      return String((error as { stdout?: Buffer }).stdout ?? error);
    }
  };
  assert.equal(surface(), "");
  const cart = join(cut.out, "apps/shop/src/cart.ts");
  const before = readFileSync(cart, "utf8");
  try {
    writeFileSync(
      cart,
      before.replace(
        "export function total(lines: readonly Line[], currency: Currency): string {",
        "export function total(lines: readonly Line[], currency: Currency, rounding: number): string {\n  void rounding;",
      ),
    );
    const errors = surface();
    const at = /check\.ts\((\d+),\d+\): error TS2322/.exec(errors);
    assert.ok(at !== null, errors);
    assert.match(check.split("\n")[Number(at[1]) - 1] ?? "", /\| total \| value$/);
  } finally {
    writeFileSync(cart, before);
  }
});

test("status is current until the repository changes what a cut writes", async () => {
  const fresh = await cutSlice({
    repo,
    out: join(scratch, "status"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
  });
  assert.equal((await statusProject(fresh.out)).current, true);
  // A body change in a cut module leaves its stub, and the folder, alone.
  const money = join(repo, "packages/money/src/index.ts");
  const before = readFileSync(money, "utf8");
  writeFileSync(money, before.replace("toFixed(2)", "toFixed(3)"));
  assert.equal((await statusProject(fresh.out)).current, true);
  // A signature change does not.
  writeFileSync(
    money,
    before.replace(
      "currency: Currency): string",
      "currency: Currency, locale?: string): string",
    ),
  );
  const changed = await statusProject(fresh.out);
  assert.equal(changed.current, false);
  const stub = changed.stale.find((item) => item.cause === "stub_changed");
  assert.equal(stub?.path, "packages/money/src/index.d.ts");
  assert.equal(stub?.detail, "changed format");
  assert.ok(changed.inputsChanged.length === 0);
  writeFileSync(money, before);
  const tax = join(repo, "apps/shop/src/tax.ts");
  const taxBefore = readFileSync(tax, "utf8");
  writeFileSync(tax, `${taxBefore}// moved\n`);
  const source = await statusProject(fresh.out);
  // BOUNDARY.md is an index of the boundary, which the edit left alone.
  assert.deepEqual(
    source.stale.map((item) => [item.cause, item.path]),
    [["source_changed", "apps/shop/src/tax.ts"]],
  );
  writeFileSync(tax, taxBefore);
  assert.equal((await statusProject(fresh.out)).current, true);
});

test("a symbol diff names what was added, removed and changed", () => {
  assert.equal(
    symbolDiff(
      "export declare function a(): void;\nexport declare const b: number;\n",
      "export declare function a(x: string): void;\nexport interface C {}\n",
    ),
    "added C; removed b; changed a",
  );
});

test("a patch carries edits back with the rewrites undone", async () => {
  const cart = join(cut.out, "apps/shop/src/cart.ts");
  writeFileSync(
    cart,
    readFileSync(cart, "utf8").replace(
      "return lines.reduce(",
      "return Math.max(0, lines.reduce(",
    ).replace("line.quantity, 0);", "line.quantity, 0));"),
  );
  writeFileSync(
    join(cut.out, "apps/shop/src/discount.ts"),
    "export const discount = (cents: number) => cents;\n",
  );
  const patch = await patchProject(cut.out);
  assert.deepEqual(patch.changed, ["apps/shop/src/cart.ts"]);
  assert.deepEqual(patch.added, ["apps/shop/src/discount.ts"]);
  assert.deepEqual(patch.drifted, []);
  // Only the edit: no import of the folder's makes it back.
  assert.doesNotMatch(patch.diff, /packages\/money\/src\/index\.js/);
  assert.match(patch.diff, /^\+\s+return Math\.max\(0, lines\.reduce\(/m);
  // Full blob ids, so `git apply --3way` can find the base.
  assert.match(patch.diff, /^index [0-9a-f]{40}\.\.[0-9a-f]{40} /m);
  assert.deepEqual(patch.noThreeWay, []);
  const file = join(scratch, "edit.patch");
  writeFileSync(file, patch.diff);
  git(["apply", "--check", file]);
  git(["apply", file]);
  assert.match(readFileSync(join(repo, ENTRY), "utf8"), /from "@\/tax"/);
  assert.match(readFileSync(join(repo, ENTRY), "utf8"), /Math\.max/);
});

test("a cut refuses a folder that is not empty", async () => {
  await assert.rejects(
    cutSlice({
      repo,
      out: cut.out,
      entryPoints: [ENTRY],
      offline: true,
    }),
    /not empty/,
  );
});

test("vite globs match from the importing folder", () => {
  assert.deepEqual(
    globMatches(repo, join(repo, "apps/shop/src"), ["./*.css"]),
    ["apps/shop/src/cart.css"],
  );
});

test("a schema field named token is not a credential", () => {
  assert.deepEqual(
    scanSecrets([
      { path: "a.ts", text: "  token: z.string().min(1),\n" },
    ]),
    [],
  );
  assert.equal(
    scanSecrets([{ path: ".env.ts", text: "API_TOKEN=Zx81kPq7Lm2vR9tYw4Bn\n" }])
      .length,
    1,
  );
});

test("a compiler message names files from the repository's root, never the checkout", () => {
  const message =
    "File '/home/me/code/acme/packages/a/test/x.ts' is not under 'rootDir' '/home/me/code/acme/packages/a/src'. Types at '/tmp/carveout-types/node_modules/zod/index.d.ts'.";
  assert.equal(
    withoutRoots(message, "/home/me/code/acme", "/tmp/carveout-types"),
    "File 'packages/a/test/x.ts' is not under 'rootDir' 'packages/a/src'. Types at '<package types>/node_modules/zod/index.d.ts'.",
  );
});
