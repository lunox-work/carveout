/**
 * A public folder in pseudonyms: the names the repository goes by are not
 * in it, its own commands work on it, and a patch from it comes back in the
 * repository's names, new files and new identifiers included.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { cutSlice, patchProject } from "../src/carve.js";
import { fromFolder, toFolder, workspaceNames, workspaceVocabulary } from "../src/pseudonyms/index.js";
import { readReceipt } from "../src/receipt.js";

let scratch = "";
let repo = "";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

/** Every file under a folder, outside node_modules, with its text. */
const tree = (root: string, dir = ""): { path: string; text: string }[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tree(root, path);
    return [{ path, text: readFileSync(join(root, path), "utf8") }];
  });

const NAMES = /lunox/i;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-names-"));
  repo = join(scratch, "repo");
  write(repo, {
    "package.json": JSON.stringify({
      name: "lunox-shop",
      private: true,
      type: "module",
      workspaces: ["packages/*", "apps/*"],
      repository: "https://github.com/lunox-work/lunox-shop",
    }),
    "packages/lunox-money/package.json": JSON.stringify({ name: "@lunox/money", version: "1.0.0", type: "module", main: "src/index.ts" }),
    "packages/lunox-money/src/index.ts": [
      "// Lunox money helpers. Questions: billing@lunox.work",
      'export const LUNOX_CURRENCY = "LNX";',
      "export function lunoxFormat(cents: number): string {",
      "  return `${(cents / 100).toFixed(2)} ${LUNOX_CURRENCY}`;",
      "}",
      "",
    ].join("\n"),
    "apps/web/package.json": JSON.stringify({ name: "@lunox/web", version: "1.0.0", type: "module", dependencies: { "@lunox/money": "*" } }),
    "apps/web/tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" },
      include: ["src"],
    }),
    "apps/web/src/LunoxCart.ts": [
      'import { lunoxFormat } from "@lunox/money";',
      "",
      "/** The Lunox cart: what a Lunox shopper is about to buy. */",
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
    "apps/web/src/LunoxCart.test.ts": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { LunoxCart } from "./LunoxCart";',
      "",
      'test("a Lunox cart totals its lines", () => {',
      '  assert.equal(new LunoxCart().add(150).add(50).total(), "2.00 LNX");',
      "});",
      "",
    ].join("\n"),
  });
  git(repo, ["init", "-q"]);
  git(repo, ["remote", "add", "origin", "git@github.com:lunox-work/lunox-shop.git"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

const request = (out: string) => ({
  repo,
  out: join(scratch, out),
  entryPoints: ["apps/web/src/LunoxCart.ts"],
  budget: { maxFiles: 40, maxDepth: 2 },
  tests: true,
  copyPure: true,
  public: true,
  offline: true,
});

test("the names a repository goes by come from its packages, its remote and its owner", () => {
  const vocabulary = workspaceVocabulary(workspaceNames(repo, ["apps/web", "packages/lunox-money"], ["Initrode"]));
  for (const term of ["initrode", "lunox-shop", "lunox-work", "lunox"]) assert.ok(vocabulary.includes(term), term);
  // A generic or short name says nothing about whose code it is.
  assert.ok(!vocabulary.includes("web"));
  assert.ok(!vocabulary.includes("repo"));
});

test("a public folder carries none of them, and its record matches the files it holds", async () => {
  const cut = await cutSlice(request("public"));
  assert.equal(cut.record.ready, true, JSON.stringify(cut.record.blockers));
  assert.ok(cut.pseudonyms !== null && cut.pseudonyms.rules.length > 0);
  const files = tree(cut.out);
  const leaks = files.filter((file) => NAMES.test(file.path) || NAMES.test(file.text)).map((file) => file.path);
  assert.deepEqual(leaks, []);
  assert.ok(files.some((file) => file.path === "apps/web/src/AcmeCart.ts"));
  // The folder's record lists its files at their folder paths and hashes:
  // the folder's own commands (the coverage guard, check) read it.
  const record = JSON.parse(readFileSync(join(cut.out, "carveout.json"), "utf8"));
  const text = new Map(files.map((file) => [file.path, file.text]));
  for (const entry of record.copied) {
    const held = text.get(entry.path);
    assert.ok(held !== undefined, entry.path);
    assert.equal(createHash("sha256").update(held).digest("hex"), entry.sha256, entry.path);
  }
  assert.ok(record.manifest.included.every((file: { path: string }) => text.has(file.path)));
  // The receipt keeps the table and the record in the repository's names.
  const receipt = readReceipt(cut.receipt ?? "");
  assert.ok(receipt.pseudonyms !== undefined && receipt.pseudonyms.rules.length > 0);
  assert.ok(receipt.record.manifest.included.some((file) => file.path === "apps/web/src/LunoxCart.ts"));
});

test("a patch from the folder comes back in the repository's names, new names included", async () => {
  const cut = await cutSlice(request("edited"));
  const cart = join(cut.out, "apps/web/src/AcmeCart.ts");
  writeFileSync(
    cart,
    readFileSync(cart, "utf8").replace(
      "  total(): string {",
      "  /** An Acme discount, in cents off the total. */\n  discounted(off: number): string {\n    return acmeFormat(Math.max(0, this.lines.reduce((sum, cents) => sum + cents, 0) - off));\n  }\n  total(): string {",
    ),
  );
  write(cut.out, {
    "apps/web/src/AcmeDiscount.test.ts":
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { AcmeCart } from "./AcmeCart";\n\nconst ACME_OFF = 25;\ntest("an Acme cart takes a discount", () => {\n  assert.equal(new AcmeCart().add(150).add(50).discounted(ACME_OFF), "1.75 LNX");\n});\n',
  });
  const patch = await patchProject(cut.out);
  assert.deepEqual(patch.refused, []);
  assert.deepEqual(patch.changed, ["apps/web/src/LunoxCart.ts"]);
  assert.deepEqual(patch.added, ["apps/web/src/LunoxDiscount.test.ts"]);
  assert.match(patch.diff, /\+ {2}discounted\(off: number\): string \{\n\+ {4}return lunoxFormat\(/);
  assert.match(patch.diff, /import \{ LunoxCart \} from "\.\/LunoxCart";/);
  assert.match(patch.diff, /const LUNOX_OFF = 25;/);
  assert.doesNotMatch(patch.diff, /acme/i);
  // It applies to the repository as it is.
  writeFileSync(join(scratch, "edited.patch"), patch.diff);
  git(repo, ["apply", "--check", join(scratch, "edited.patch")]);
});

test("two folder files that map back to one repository file are refused", async () => {
  const cut = await cutSlice(request("clash"));
  // The repository's own name, written in the folder beside its pseudonym.
  write(cut.out, { "apps/web/src/LunoxCart.ts": "export const x = 1;\n" });
  await assert.rejects(patchProject(cut.out), /both map back to one file of the repository/);
});

test("a placeholder's spelling maps back as the term's, in a path, an identifier and prose", () => {
  const table = {
    rules: [{ before: "Lunox", after: "Acme", kind: "text" as const, paths: [] }],
    kept: ["@lunox/ui"],
    vocabulary: ["lunox", "lunox-work"],
    words: [
      { term: "lunox", placeholder: "acme" },
      { term: "lunox-work", placeholder: "globex-labs" },
    ],
  };
  const back = fromFolder(table, "src/acme-totals.ts", 'import { Button } from "@lunox/ui";\nconst acmeTotal = 1; const ACME_KEY = 2;\n// GlobexLabs ships it: globex-labs.\nconst GLOBEX_LABS = 3; const globexLabsId = 4;\n');
  assert.equal(back.path, "src/lunox-totals.ts");
  assert.equal(
    back.text,
    'import { Button } from "@lunox/ui";\nconst lunoxTotal = 1; const LUNOX_KEY = 2;\n// LunoxWork ships it: lunox-work.\nconst LUNOX_WORK = 3; const lunoxWorkId = 4;\n',
  );
  // And the table's own direction, the kept package name untouched.
  assert.equal(toFolder(table, "a.ts", 'import "@lunox/ui"; // Lunox\n').text, 'import "@lunox/ui"; // Acme\n');
});

test("a name left in a public folder is a blocker, and --keep-names leaves them all", async () => {
  const kept = await cutSlice({ ...request("kept"), pseudonyms: false });
  assert.equal(kept.pseudonyms, null);
  assert.equal(kept.record.ready, false);
  const leaked = kept.record.blockers.filter((blocker) => blocker.code === "vocabulary_leaked");
  assert.ok(leaked.some((blocker) => /"lunox"/.test(blocker.detail)));
  // The folder's own record says a name is there, not which.
  const folder = readFileSync(join(kept.out, "carveout.json"), "utf8");
  assert.match(folder, /vocabulary_leaked/);
  assert.doesNotMatch(JSON.stringify(JSON.parse(folder).blockers), /lunox/i);
});

test("apply brings the repository's change into a folder in pseudonyms, in its names", async () => {
  const { applyPatch } = await import("../src/mergeback.js");
  const cut = await cutSlice(request("applied"));
  // The repository moves on: a new method, written in its own names.
  const work = join(scratch, "applied-work");
  git(scratch, ["clone", "-q", repo, work]);
  const cart = join(work, "apps/web/src/LunoxCart.ts");
  writeFileSync(
    cart,
    readFileSync(cart, "utf8").replace("  total(): string {", "  /** Empties a Lunox cart. */\n  clear(): this {\n    this.lines.length = 0;\n    return this;\n  }\n  total(): string {"),
  );
  const change = git(work, ["diff"]);
  const applied = await applyPatch(cut.out, change);
  assert.deepEqual(applied.changed, ["apps/web/src/LunoxCart.ts"]);
  const held = readFileSync(join(cut.out, "apps/web/src/AcmeCart.ts"), "utf8");
  assert.match(held, /\/\*\* Empties a Acme cart\. \*\/\n {2}clear\(\): this/);
  assert.equal(tree(cut.out).filter((file) => NAMES.test(file.path) || NAMES.test(file.text)).length, 0);
  // A patch is against the cut's commit, so it gives the applied change
  // back, with the contributor's edit on top, in the repository's names.
  const acme = join(cut.out, "apps/web/src/AcmeCart.ts");
  writeFileSync(acme, readFileSync(acme, "utf8").replace("this.lines.length = 0;", "this.lines.splice(0);"));
  const patch = await patchProject(cut.out);
  assert.deepEqual(patch.refused, []);
  assert.deepEqual(patch.changed, ["apps/web/src/LunoxCart.ts"]);
  assert.match(patch.diff, /\+ {2}\/\*\* Empties a Lunox cart\. \*\/\n\+ {2}clear\(\): this \{\n\+ {4}this\.lines\.splice\(0\);/);
  assert.doesNotMatch(patch.diff, /acme/i);
});
