/**
 * A public folder in pseudonyms: the names the repository goes by are not
 * in it, its own commands work on it, and a patch from it comes back in the
 * repository's names, new files and new identifiers included.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  assert.ok(files.some((file) => file.path === "apps/web/src/ZorvexCart.ts"));
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
  const cart = join(cut.out, "apps/web/src/ZorvexCart.ts");
  writeFileSync(
    cart,
    readFileSync(cart, "utf8").replace(
      "  total(): string {",
      "  /** An Zorvex discount, in cents off the total. */\n  discounted(off: number): string {\n    return zorvexFormat(Math.max(0, this.lines.reduce((sum, cents) => sum + cents, 0) - off));\n  }\n  total(): string {",
    ),
  );
  write(cut.out, {
    "apps/web/src/ZorvexDiscount.test.ts":
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ZorvexCart } from "./ZorvexCart";\n\nconst ZORVEX_OFF = 25;\ntest("an Zorvex cart takes a discount", () => {\n  assert.equal(new ZorvexCart().add(150).add(50).discounted(ZORVEX_OFF), "1.75 LNX");\n});\n',
  });
  const patch = await patchProject(cut.out);
  assert.deepEqual(patch.refused, []);
  assert.deepEqual(patch.changed, ["apps/web/src/LunoxCart.ts"]);
  assert.deepEqual(patch.added, ["apps/web/src/LunoxDiscount.test.ts"]);
  assert.match(patch.diff, /\+ {2}discounted\(off: number\): string \{\n\+ {4}return lunoxFormat\(/);
  assert.match(patch.diff, /import \{ LunoxCart \} from "\.\/LunoxCart";/);
  assert.match(patch.diff, /const LUNOX_OFF = 25;/);
  assert.doesNotMatch(patch.diff, /zorvex/i);
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
  const held = readFileSync(join(cut.out, "apps/web/src/ZorvexCart.ts"), "utf8");
  assert.match(held, /\/\*\* Empties a Zorvex cart\. \*\/\n {2}clear\(\): this/);
  assert.equal(tree(cut.out).filter((file) => NAMES.test(file.path) || NAMES.test(file.text)).length, 0);
  // A patch is against the cut's commit, so it gives the applied change
  // back, with the contributor's edit on top, in the repository's names.
  const zorvex = join(cut.out, "apps/web/src/ZorvexCart.ts");
  writeFileSync(zorvex, readFileSync(zorvex, "utf8").replace("this.lines.length = 0;", "this.lines.splice(0);"));
  const patch = await patchProject(cut.out);
  assert.deepEqual(patch.refused, []);
  assert.deepEqual(patch.changed, ["apps/web/src/LunoxCart.ts"]);
  assert.match(patch.diff, /\+ {2}\/\*\* Empties a Lunox cart\. \*\/\n\+ {2}clear\(\): this \{\n\+ {4}this\.lines\.splice\(0\);/);
  assert.doesNotMatch(patch.diff, /zorvex/i);
});

test("round two: the names a repository goes by, in the forms a reviewer found missed", async () => {
  const { workspaceNames: names, workspaceVocabulary: vocabularyOf } = await import("../src/pseudonyms/index.js");
  const at = (remote: string, manifest: Record<string, unknown> = { name: "platform" }, folder = "platform") => {
    const root = join(scratch, `remote-${Math.random().toString(36).slice(2)}`, folder);
    write(root, { "package.json": JSON.stringify(manifest) });
    git(root, ["init", "-q"]);
    git(root, ["remote", "add", "origin", remote]);
    return vocabularyOf(names(root, []));
  };
  // A private host's own name, and an account on it.
  assert.ok(at("git@git.lunox.work:platform/shop.git").includes("lunox"));
  assert.ok(at("ssh://git@bitbucket.lunox.work:7999/plat/shop.git").includes("lunox"));
  assert.ok(at("https://dev.azure.com/lunox/project/_git/shop").includes("lunox"));
  // npm's shorthand, and a handle's stem.
  assert.ok(at("git@github.com:x/y.git", { name: "platform", repository: "github:lunoxhq/shop" }).includes("lunox"));
  assert.ok(at("git@github.com:getlunox/platform.git").includes("lunox"));
  // A digit between words, and a name with accents.
  assert.ok(at("git@github.com:web3labs/platform.git").includes("web3-labs"));
  assert.ok(at("git@github.com:x/y.git", { name: "platform", author: "Lunöx Ltd <a@b.c>" }).includes("lunox"));
  // A one-word name the code calls its own things by is not scanned alone.
  const common = at("git@github.com:acme-lunox/search.git", { name: "search" }, "search");
  assert.ok(!common.includes("search"));
});

test("round two: a copied folder's binary file is copied as bytes, and a patch of it carries nothing", async () => {
  const root = join(scratch, "bytes");
  cpSync(repo, root, { recursive: true });
  // Not UTF-8, no NUL, named like text: decoded and written back, it would change.
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xe2, 0x28, 0xa1, 0x0a, 0x4c, 0x75, 0x6e, 0x6f, 0x78, 0x0a]);
  mkdirSync(join(root, "apps/web/docs"), { recursive: true });
  writeFileSync(join(root, "apps/web/docs/terms.txt"), bytes);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "terms"]);
  const cut = await cutSlice({ ...request("bytes-out"), repo: root, copy: ["apps/web/docs"] });
  assert.ok(Buffer.compare(readFileSync(join(cut.out, "apps/web/docs/terms.txt")), bytes) === 0);
  // Its bytes hold the name, which no table renames: a blocker.
  assert.ok(cut.record.blockers.some((blocker) => blocker.code === "vocabulary_leaked" && /terms\.txt/.test(blocker.detail)));
  assert.equal((await patchProject(cut.out)).diff, "");
});

test("round two: a package the contributor imports by its own name keeps it, a placeholder in it included", async () => {
  const cut = await cutSlice(request("shield"));
  write(cut.out, {
    "apps/web/src/cert.ts": 'import client from "zorvex-client";\nexport const directory = "https://zorvex-v02.example/directory";\nexport { client };\n',
  });
  const patch = await patchProject(cut.out, { allow: ["apps/web/src/cert.ts"] });
  assert.match(patch.diff, /import client from "zorvex-client";/);
});

test("round two: the owner's path rule renames the folder and the imports that reach it", async () => {
  const root = join(scratch, "owner-path");
  cpSync(repo, root, { recursive: true });
  write(root, {
    "carveout.config.json": JSON.stringify({ pseudonyms: [{ before: "packages/lunox-money", after: "packages/wallet", kind: "path" }] }),
    "apps/web/src/[lunoxId]/page.ts": 'import { lunoxFormat } from "../../../../packages/lunox-money/src/index";\nexport const page = () => lunoxFormat(1);\n',
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "owner rule"]);
  const cut = await cutSlice({ ...request("owner-path-out"), repo: root, entryPoints: ["apps/web/src/[lunoxId]/page.ts"] });
  const files = tree(cut.out);
  assert.ok(files.some((file) => file.path === "packages/wallet/src/index.ts"), files.map((file) => file.path).join(" "));
  const page = files.find((file) => file.path.endsWith("/page.ts"));
  assert.ok(page !== undefined && /packages\/wallet\/src\/index/.test(page.text), page?.text);
});

test("round two: a name inside a longer word blocks the folder; a private registry's URL leaves the lock", async () => {
  const { seededLockfile } = await import("../src/carve.js");
  const root = join(scratch, "loose");
  cpSync(repo, root, { recursive: true });
  write(root, { "apps/web/src/links.ts": 'export const help = "https://getlunox.com/help";\nexport const app = "lunoxapp";\n' });
  writeFileSync(join(root, "apps/web/src/LunoxCart.ts"), `${readFileSync(join(root, "apps/web/src/LunoxCart.ts"), "utf8")}export { help } from "./links";\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "links"]);
  const cut = await cutSlice({ ...request("loose-out"), repo: root });
  assert.equal(cut.record.ready, false);
  assert.ok(cut.record.blockers.some((blocker) => blocker.code === "vocabulary_leaked" && /links\.ts/.test(blocker.detail)));
  // The seed keeps a privately resolved package's version, not its URL.
  write(root, {
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "x" },
        "node_modules/left-pad": { version: "1.3.0", resolved: "https://lunox.jfrog.io/npm/left-pad-1.3.0.tgz", integrity: "sha512-x" },
        "node_modules/zod": { version: "4.0.0", resolved: "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz", integrity: "sha512-y" },
      },
    }),
  });
  const seeded = seededLockfile(root, [""], { name: "slice" }) as { packages: Record<string, Record<string, unknown>> };
  assert.deepEqual(seeded.packages["node_modules/left-pad"], { version: "1.3.0" });
  assert.equal(seeded.packages["node_modules/zod"]?.["resolved"], "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz");
});

test("a task written into a public folder says when the work is accepted, in the folder's names", async () => {
  const cut = await cutSlice({ ...request("task"), task: "Give LunoxCart a discounted(off) method." });
  const task = readFileSync(join(cut.out, "TASK.md"), "utf8");
  assert.match(task, /^# Task\n\nGive ZorvexCart a discounted\(off\) method\.\n\n## Accepted when\n/);
  assert.match(task, /`npm test` passes in this folder/);
  assert.match(task, /The 1 test file\(s\) that came with the folder still pass, and only grew\./);
  assert.doesNotMatch(task, /lunox/i);
  const agents = readFileSync(join(cut.out, "AGENTS.md"), "utf8");
  assert.match(agents, /## What comes back, and what is held for the owner/);
  assert.match(agents, /is in `TASK\.md`: read it first\./);
});
