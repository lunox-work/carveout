/**
 * Handing a slice to someone outside the repository and taking their
 * folder back: what the folder may reveal, and what a folder that comes
 * back may make carveout do. A returned folder is untrusted: its record
 * cannot lead carveout outside the folder or the repository, its patch
 * carries only a change to the slice's packages, and merge runs the verify
 * command without the caller's environment. Offline, on the shop fixture.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { cutSlice, patchProject } from "../src/carve.js";
import { filterDeclaration } from "../src/extract/typescript.js";
import { walkGraph } from "../src/graph.js";
import { extensionStyles, restoreImports } from "../src/imports.js";
import { applyPatch, mergeProject } from "../src/mergeback.js";

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");
const ENTRY = "apps/shop/src/cart.ts";

let scratch = "";
let repo = "";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");

const cut = async (name: string, options: { public?: boolean } = {}) =>
  (
    await cutSlice({
      repo,
      out: join(scratch, name),
      entryPoints: [ENTRY],
      budget: { maxFiles: 40, maxDepth: 1 },
      offline: true,
      ...options,
    })
  ).out;

const clone = (name: string) => {
  const path = join(scratch, name);
  git(scratch, ["clone", "-q", repo, path]);
  return path;
};

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-handoff-"));
  repo = join(scratch, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  writeFileSync(
    join(repo, "apps/shop/src/cart.test.ts"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtotal } from "./cart";\n\ntest("subtotal", () => assert.equal(subtotal([]), 0));\n',
  );
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("a one-line barrel's stub declares only the names asked of it", () => {
  const barrel = filterDeclaration(
    'export { priceFor, riskScore, DISCOUNT, ENDPOINT } from "./pricing";\nexport type { Tier } from "./pricing";\n',
    new Set(["priceFor"]),
  );
  assert.equal(barrel.text.trim(), 'export { priceFor } from "./pricing";');
  assert.deepEqual(
    barrel.imports.map((item) => [item.specifier, [...(item.names as Set<string>)]]),
    [["./pricing", ["priceFor"]]],
  );
  const local = filterDeclaration(
    "declare const DISCOUNT: 0.37;\ndeclare function priceFor(base: number): number;\nexport { DISCOUNT, priceFor };\n",
    new Set(["priceFor"]),
  );
  assert.doesNotMatch(local.text, /DISCOUNT/);
  assert.match(local.text, /declare function priceFor/);
  assert.match(local.text, /export \{ priceFor \}/);
});

test("a new file's import takes the package's .ts style, and the source over what a build emitted", () => {
  const edges = [
    { from: "pkg/test/a.test.ts", to: "pkg/src/a.ts", specifier: "../src/a.ts" },
    { from: "pkg/src/b.ts", to: "pkg/src/a.ts", specifier: "./a.ts" },
  ];
  const packageOf = () => "pkg";
  const restored = restoreImports(
    "pkg/test/new.test.ts",
    'import { a } from "../src/a.js";\n',
    null,
    [],
    {
      edges,
      // The build wrote a.js beside a.ts.
      files: new Set(["pkg/src/a.ts", "pkg/src/a.js", "pkg/test/new.test.ts"]),
      stubs: new Set(),
      packageOf,
      extensionStyle: extensionStyles(edges, packageOf),
    },
  );
  assert.equal(restored.text, 'import { a } from "../src/a.ts";\n');
  const js = extensionStyles(
    [{ from: "pkg/src/b.ts", specifier: "./a.js" }],
    packageOf,
  );
  assert.equal(js("pkg"), "js");
  assert.equal(extensionStyles([{ from: "pkg/src/b.ts", specifier: "./a" }], packageOf)("pkg"), "none");
});

test("a cut that would carry a credential writes nothing", async () => {
  const work = join(scratch, "secret-repo");
  cpSync(repo, work, { recursive: true });
  writeFileSync(
    join(work, "apps/shop/src/keys.ts"),
    'export const stripe = "sk_live_51HabcdefghijklmnopqrstuvWXYZ0123456789";\n',
  );
  const out = join(scratch, "secret-cut");
  await assert.rejects(
    cutSlice({
      repo: work,
      out,
      entryPoints: ["apps/shop/src/keys.ts"],
      budget: { maxFiles: 40, maxDepth: 0 },
      offline: true,
    }),
    /Nothing written: the cut would carry a credential[\s\S]*stripe-live-key/,
  );
  assert.equal(existsSync(out), false);
});

test("a public cut names neither the checkout nor the files outside that import it", async () => {
  const out = await cut("public", { public: true });
  const record = JSON.parse(readFileSync(join(out, "carveout.json"), "utf8"));
  assert.equal(record.repo, undefined);
  assert.equal(record.request.public, true);
  assert.equal(record.request.widenLiterals, true);
  // No file in the folder names checkout.ts, the importer outside it.
  let named = "";
  try {
    named = execFileSync("grep", ["-rl", "checkout.ts", out], { encoding: "utf8" });
  } catch {
    // grep exits 1 when nothing matches.
  }
  assert.equal(named, "");
  const contract = readFileSync(join(out, "carveout/contract.json"), "utf8");
  assert.doesNotMatch(contract, /checkout\.ts/);
  assert.match(contract, /apps\/shop\/\(outside the slice\)/);
  assert.doesNotMatch(readFileSync(join(out, "carveout.json"), "utf8"), new RegExp(scratch));
  assert.doesNotMatch(readFileSync(join(out, "packages/money/src/index.d.ts"), "utf8"), /"usd"/);
  // The maintainer names the repository; nothing in the folder does.
  await assert.rejects(patchProject(out), /does not name its repository/);
  const edited = join(out, "apps/shop/src/tax.ts");
  writeFileSync(edited, readFileSync(edited, "utf8").replace("0.1", "0.2"));
  const patch = await patchProject(out, { repo });
  assert.deepEqual(patch.changed, ["apps/shop/src/tax.ts"]);
});

test("a patch keeps out protected paths, new files outside the slice's packages and deleted tests", async () => {
  const out = await cut("hostile");
  write(join(out, ".github/workflows/x.yml"), "on: push\n");
  write(join(out, "apps/shop/.npmrc"), "registry=https://evil.example\n");
  write(join(out, "apps/shop/install.sh"), "#!/bin/sh\n");
  write(join(out, "packages/money/src/backdoor.ts"), "export const x = 1;\n");
  write(join(out, "apps/shop/src/extra.ts"), "export const y = 2;\n");
  const withTest = await cutSlice({
    repo,
    out: join(scratch, "hostile-tests"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
    tests: true,
  });
  rmSync(join(withTest.out, "apps/shop/src/cart.test.ts"));

  const patch = await patchProject(out);
  assert.deepEqual(patch.added, ["apps/shop/src/extra.ts"]);
  assert.deepEqual(
    patch.refused.map((refusal) => refusal.path).sort(),
    [
      ".github/workflows/x.yml",
      "apps/shop/.npmrc",
      "apps/shop/install.sh",
      "packages/money/src/backdoor.ts",
    ],
  );
  assert.doesNotMatch(patch.diff, /\.github|evil\.example|backdoor|install\.sh/);
  const allowed = await patchProject(out, { allow: [".github/workflows/x.yml"] });
  assert.ok(allowed.added.includes(".github/workflows/x.yml"));

  const deletion = await patchProject(withTest.out);
  assert.deepEqual(deletion.deleted, []);
  assert.deepEqual(
    deletion.refused.map((refusal) => [refusal.path, refusal.reason]),
    [["apps/shop/src/cart.test.ts", "deletes a test the slice was handed"]],
  );

  // merge applies nothing while the policy keeps a path out.
  const into = clone("hostile-into");
  const merged = await mergeProject(out, { into });
  assert.equal(merged.ok, false);
  assert.match(merged.steps[0]?.output ?? "", /nothing was applied/);
  assert.equal(git(into, ["status", "--porcelain"]), "");
});

test("a record that names a path outside the folder, or another repository, is refused", async () => {
  const out = await cut("tampered");
  const victim = join(scratch, "victim.txt");
  writeFileSync(victim, "keep me\n");
  const path = join(out, "carveout.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  const tampered = {
    ...record,
    manifest: {
      ...record.manifest,
      included: [
        ...record.manifest.included,
        { path: "../../victim.txt", sha256: "0".repeat(64), depth: 0, sizeBytes: 1 },
      ],
    },
  };
  writeFileSync(path, JSON.stringify(tampered));
  await assert.rejects(patchProject(out), /leaves its folder/);
  await assert.rejects(applyPatch(out, ""), /leaves its folder/);
  assert.equal(readFileSync(victim, "utf8"), "keep me\n");

  writeFileSync(path, JSON.stringify({ ...record, repo: scratch }));
  await assert.rejects(patchProject(out), /does not hold the cut's commit/);
  for (const bad of ["/etc/passwd", "a/./b", ".git/config", "a\\b"]) {
    writeFileSync(
      path,
      JSON.stringify({ ...record, generated: [{ path: bad, sha256: "0" }] }),
    );
    await assert.rejects(patchProject(out), /is not one carveout wrote/, bad);
  }
});

test("merge runs the verify command with only the environment it is given", async () => {
  const out = await cut("env");
  const edited = join(out, "apps/shop/src/tax.ts");
  writeFileSync(edited, readFileSync(edited, "utf8").replace("0.1", "0.2"));
  process.env["CARVEOUT_TEST_SECRET"] = "s3cret";
  try {
    const bare = await mergeProject(out, {
      into: clone("env-bare"),
      verify: `test -z "$CARVEOUT_TEST_SECRET" && test "$HOME" != "${process.env["HOME"] ?? ""}"`,
    });
    assert.equal(bare.ok, true, JSON.stringify(bare.steps));
    const given = await mergeProject(out, {
      into: clone("env-given"),
      verify: 'test "$CARVEOUT_TEST_SECRET" = s3cret',
      verifyEnv: ["CARVEOUT_TEST_SECRET"],
    });
    assert.equal(given.ok, true, JSON.stringify(given.steps));
  } finally {
    delete process.env["CARVEOUT_TEST_SECRET"];
  }
});

test("the walk ends when it reaches a file under an ignored folder", () => {
  const root = join(scratch, "build-folder");
  write(join(root, "src/build/info.ts"), "export const v = 1;\n");
  write(join(root, "src/app.ts"), 'import { v } from "./build/info.js";\nexport const w = v;\n');
  const started = Date.now();
  const { walk } = walkGraph(root, ["src/app.ts"], { maxFiles: 40, maxDepth: 2 });
  assert.ok(Date.now() - started < 10_000);
  assert.ok(walk.included.includes("src/app.ts"));
});
