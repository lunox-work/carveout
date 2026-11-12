/**
 * The library entry, `carveout/api` (`src/api.ts`), as a platform uses
 * it: `dist/src/api.js` imported with every `child_process` function made
 * to throw (and each attempt recorded), HOME an empty folder and
 * CARVEOUT_HOME unset, every file call carveout makes under HOME recorded. `plan`, `cut`
 * and `patch` on a copy of the shop fixture (no Git checkout, so nothing
 * needs Git) must start no container and run nothing from the folder,
 * leave HOME untouched, and round-trip an unchanged cut to an empty patch
 * with the receipt passed as data.
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

type Api = typeof import("../src/api.js");

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");
const ENTRY = "apps/shop/src/cart.ts";
const require = createRequire(import.meta.url);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "carveout-api-")));
const home = join(scratch, "home");
const repo = join(scratch, "repo");
const out = join(scratch, "slice");
const removeScratch = () => rmSync(scratch, { recursive: true, force: true });
mkdirSync(home);
cpSync(FIXTURE, repo, { recursive: true });
// A test of the slice's own, on node:test, so the plan has one to carry.
writeFileSync(
  join(repo, "apps/shop/src/cart.test.ts"),
  [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { subtotal } from "./cart";',
    "",
    'test("subtotal", () => {',
    "  assert.equal(subtotal([{ cents: 100, quantity: 2 }]), 200);",
    "});",
    "",
  ].join("\n"),
);

/** Every file under `dir`, relative, sorted. */
const tree = (dir: string): string[] =>
  (readdirSync(dir, { recursive: true, withFileTypes: true }) as { name: string; parentPath: string; isFile(): boolean }[])
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();

const spawned: { fn: string; file: string; cwd: string | null }[] = [];
const homeCalls: string[] = [];
let api: Api;

before(async () => {
  process.env["HOME"] = home;
  delete process.env["CARVEOUT_HOME"];
  const childProcess = require("node:child_process") as Record<string, unknown>;
  for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    childProcess[fn] = (file: unknown, ...rest: unknown[]) => {
      const options = rest.find((item) => item !== null && typeof item === "object" && !Array.isArray(item)) as
        | { cwd?: string }
        | undefined;
      spawned.push({ fn, file: String(file), cwd: options?.cwd === undefined ? null : String(options.cwd) });
      throw new Error(`child_process.${fn} called from carveout/api`);
    };
  const inHome = (path: unknown) => {
    const text = path instanceof URL ? path.pathname : String(path);
    return text === home || text.startsWith(`${home}/`);
  };
  for (const module of [require("node:fs"), require("node:fs/promises")] as Record<string, unknown>[])
    for (const [name, original] of Object.entries(module))
      if (typeof original === "function" && /^[a-z]/.test(name) && name !== "watch") {
        const wrapped = function (this: unknown, ...argv: unknown[]) {
          // carveout's own calls only: this file lists HOME itself.
          if ((inHome(argv[0]) || inHome(argv[1])) && /[\\/]dist[\\/]src[\\/]/.test(new Error().stack ?? ""))
            homeCalls.push(`${name} ${String(argv[0])}`);
          return (original as (...args: unknown[]) => unknown).apply(this, argv);
        };
        if ("native" in original) Object.assign(wrapped, { native: (original as { native: unknown }).native });
        module[name] = wrapped;
      }
  syncBuiltinESMExports();
  api = await import("../src/api.js");
});

after(removeScratch);

test("carveout/api resolves to dist/src/api.js by the package's exports", () => {
  assert.equal(import.meta.resolve("carveout/api"), new URL("../src/api.js", import.meta.url).href);
  for (const name of ["plan", "walk", "cut", "patch", "integrityOf", "gainedIntegrity", "weakenedTest", "testsVerdict", "exposureOf"])
    assert.equal(typeof (api as unknown as Record<string, unknown>)[name], "function", name);
});

test("plan lists the files, cuts, surface and tests, and writes nothing", () => {
  const before = tree(scratch);
  const planned = api.plan({ root: repo, entries: [ENTRY], depth: 1, withTests: true });
  assert.deepEqual(tree(scratch), before);
  assert.deepEqual(planned.included, [
    "apps/shop/src/cart.css",
    "apps/shop/src/cart.test.ts",
    "apps/shop/src/cart.ts",
    "apps/shop/src/tax.ts",
  ]);
  // @fx/money is a workspace package, not followed: stubbed as a package, not cut as a module.
  assert.deepEqual(planned.cuts.modules, []);
  assert.deepEqual(planned.workspacePackages, ["@fx/money"]);
  assert.deepEqual(planned.tests.carried, [{ file: "apps/shop/src/cart.test.ts", runner: "node" }]);
  assert.deepEqual(planned.surface, [{ module: ENTRY, names: ["total"], importers: ["apps/shop/src/checkout.ts"] }]);
  assert.deepEqual(planned.packages, ["@fx/money", "stripe"]);
  assert.deepEqual(planned.blockers, []);
  const without = api.plan({ root: repo, entries: [ENTRY], depth: 1 });
  assert.deepEqual(without.tests.carried, []);
  assert.deepEqual(
    without.tests.left.map(({ file, reason }) => ({ file, reason })),
    [{ file: "apps/shop/src/cart.test.ts", reason: "not-asked" }],
  );
});

test("walk is the walk plan reports: included files, edges both ways, links inside, carried tests", () => {
  const before = tree(scratch);
  const walked = api.walk({ root: repo, entries: [ENTRY], depth: 1, withTests: true });
  const planned = api.plan({ root: repo, entries: [ENTRY], depth: 1, withTests: true });
  assert.deepEqual(tree(scratch), before);
  assert.deepEqual(walked.included, planned.included);
  assert.deepEqual(walked.entries, [ENTRY]);
  assert.deepEqual(walked.unknownEntryPoints, []);
  assert.deepEqual(walked.cuts.outbound, planned.cuts.outbound);
  assert.deepEqual(
    walked.cuts.inbound.map((edge) => edge.from),
    ["apps/shop/src/checkout.ts"],
  );
  assert.deepEqual(walked.tests, ["apps/shop/src/cart.test.ts"]);
  assert.ok(walked.internal.every((edge) => walked.included.includes(edge.from) && walked.included.includes(edge.to)));
  assert.ok(walked.dependencies.some((dependency) => dependency.specifier === "stripe" && dependency.status === "external"));
  assert.equal(walked.depthOf[ENTRY], 0);
  assert.deepEqual(api.walk({ root: repo, entries: ["nope.ts"] }).unknownEntryPoints, ["nope.ts"]);
});

let made: Awaited<ReturnType<Api["cut"]>>;

test("cut writes the folder and its carveout.json, and returns the receipt as data", async () => {
  made = await api.cut({ root: repo, entries: [ENTRY], depth: 1, withTests: true, out, offline: true });
  assert.equal(made.out, out);
  assert.equal(made.ready, true, JSON.stringify(made.blockers));
  assert.deepEqual(JSON.parse(readFileSync(join(out, "carveout.json"), "utf8")), made.record);
  assert.equal(made.receipt.cutId, made.record.cutId);
  assert.equal(made.receipt.repo, repo);
  assert.notEqual(made.record.request.public, true);
  for (const path of ["apps/shop/src/cart.ts", "apps/shop/src/cart.test.ts", "packages/money/src/index.d.ts"])
    assert.ok(tree(out).includes(path), path);
  // Written nowhere: not in HOME, not beside the folder.
  assert.deepEqual(tree(home), []);
  assert.deepEqual(readdirSync(scratch).sort(), ["home", "repo", "slice"]);
});

test("patch round-trips an unchanged cut to an empty patch, by the receipt given", async () => {
  const unchanged = await api.patch({ receipt: made.receipt, folder: out });
  assert.equal(unchanged.diff, "");
  assert.deepEqual([unchanged.changed, unchanged.added, unchanged.deleted, unchanged.refused, unchanged.boundary], [[], [], [], [], []]);
  assert.equal(unchanged.recordFrom, "receipt");
});

test("patch holds what the hand-off policy refuses, and a receipt of another cut", async () => {
  mkdirSync(join(out, ".github/workflows"), { recursive: true });
  writeFileSync(join(out, ".github/workflows/ci.yml"), "on: push\n");
  try {
    const held = await api.patch({ receipt: made.receipt, folder: out });
    assert.deepEqual(held.refused.map((refusal) => refusal.path), [".github/workflows/ci.yml"]);
    assert.equal(held.diff, "");
  } finally {
    rmSync(join(out, ".github"), { recursive: true, force: true });
  }
  const other = { ...made.receipt, cutId: "0".repeat(32) };
  await assert.rejects(api.patch({ receipt: other, folder: out }), /is the receipt of cut 00000000/);
  await assert.rejects(api.patch({ receipt: { ...made.receipt, schemaVersion: 2 } as never, folder: out }), /not a carveout receipt/);
});

test("the policy's text checks", () => {
  assert.deepEqual(api.integrityOf("src/a.ts", "export const a = 1;\n"), []);
  assert.ok(api.gainedIntegrity("src/a.ts", "export const a = 1;\n", 'export const a = process.env.NODE_ENV === "test" ? 2 : 1;\n').length > 0);
  const kept = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("a", () => {\n  assert.equal(1, 1);\n});\n';
  assert.equal(api.weakenedTest("src/a.test.ts", kept, kept), null);
  assert.equal(typeof api.weakenedTest("src/a.test.ts", kept, kept.replace("  assert.equal(1, 1);\n", "")), "string");
});

test("nothing started a container or ran the folder's code, and HOME was never touched", () => {
  // Git on the repository is the most the API may run; here it is no checkout, and each attempt threw.
  assert.ok(spawned.some((call) => call.cwd === repo), "the trap saw no attempt at all");
  for (const call of spawned) {
    assert.equal(call.file, "git", JSON.stringify(call));
    assert.ok(call.cwd === null || !(call.cwd === out || call.cwd.startsWith(`${out}/`)), JSON.stringify(call));
  }
  assert.deepEqual(homeCalls, []);
  assert.deepEqual(tree(home), []);
});
