/**
 * Mergeback on the shop fixture: what `patch` carries back beyond a plain
 * edit (deletions, new files, new imports), what it refuses to carry, and
 * `apply` and `merge` around it. Offline, like the end-to-end test.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { cutSlice, patchProject } from "../src/carve.js";
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
    join(src, "cart.test.ts"),
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
  assert.deepEqual(patch.sliceOnly, ["apps/shop/src/cart.test.ts"]);
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
  git(work, ["add", "-A"]);
  const change = git(work, ["diff", "--cached", "--full-index"]);

  const needs = await applyPatch(out, change);
  assert.deepEqual(needs.changed, [CART]);
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
  assert.deepEqual(patch.changed, [CART]);
  assert.deepEqual(patch.added, ["apps/shop/src/discount.ts"]);
  const into = clone("applied-into");
  const file = join(scratch, "applied.patch");
  writeFileSync(file, patch.diff);
  git(into, ["apply", file]);
  for (const path of [CART, "apps/shop/src/discount.ts"])
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
