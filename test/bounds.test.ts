/**
 * Where the cut falls, on the shop fixture grown by a test with a fake
 * beside it, a migrations folder and a test that patches a package's
 * prototype: a test's helpers come along, a workspace package is followed
 * on request, the owner's configuration bounds every cut, a copied folder
 * is in the patch, and specifiers are read from the syntax tree.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { CONFIG_PATH, cutSlice, patchProject, planSlice, readRepoConfig } from "../src/carve.js";
import { specifiersOf } from "../src/imports.js";
import { pathMatcher } from "../src/slice/analysis.js";
import { moduleSpecifiers, rewriteSpecifiers } from "../src/specifiers.js";

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");
const ENTRY = "apps/shop/src/cart.ts";
const TEST = "apps/shop/test/cart.test.ts";
const FAKE = "apps/shop/test/fake-lines.ts";
const MIGRATION = "apps/shop/migrations/0001.sql";

let scratch = "";
let repo = "";
let cuts = 0;

const git = (args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");

const cut = (options: Partial<Parameters<typeof cutSlice>[0]>) =>
  cutSlice({
    repo,
    out: join(scratch, `slice-${(cuts += 1)}`),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
    ...options,
  });

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-bounds-"));
  repo = join(scratch, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  mkdirSync(join(repo, "apps/shop/test"), { recursive: true });
  writeFileSync(
    join(repo, FAKE),
    'import type { Line } from "../src/cart";\nexport const lines: Line[] = [{ cents: 100, quantity: 2 }];\n',
  );
  writeFileSync(
    join(repo, TEST),
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import Stripe from "stripe";',
      'import { client, subtotal } from "../src/cart";',
      'import { lines } from "./fake-lines";',
      "",
      'test("subtotal", () => assert.equal(subtotal(lines), 200));',
      'test("client", () => {',
      '  Stripe.prototype.toString = () => "patched";',
      "  assert.ok(client());",
      "});",
      "",
    ].join("\n"),
  );
  mkdirSync(join(repo, "apps/shop/migrations"), { recursive: true });
  writeFileSync(join(repo, MIGRATION), "create table carts (id int);\n");
  // A module on two packages of one scope, and a test that patches the
  // client's prototype.
  const manifest = join(repo, "apps/shop/package.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies: Record<string, string> };
  parsed.dependencies["@aws-sdk/client-s3"] = "^3.700.0";
  parsed.dependencies["@aws-sdk/s3-request-presigner"] = "^3.700.0";
  writeFileSync(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
  writeFileSync(
    join(repo, "apps/shop/src/objects.ts"),
    [
      'import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";',
      'import { getSignedUrl } from "@aws-sdk/s3-request-presigner";',
      "export const client = new S3Client({});",
      "export const signedUrl = (key: string) => getSignedUrl(client, new GetObjectCommand({ Bucket: \"b\", Key: key }));",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "apps/shop/test/objects.test.ts"),
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { S3Client } from "@aws-sdk/client-s3";',
      'import { signedUrl } from "../src/objects";',
      'test("signs", async () => {',
      "  const original = S3Client.prototype.send;",
      "  Object.assign(S3Client.prototype, { send: async () => ({}) });",
      '  assert.ok(await signedUrl("k"));',
      "  Object.assign(S3Client.prototype, { send: original });",
      "});",
      "",
    ].join("\n"),
  );
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("a test brings its fake along, and a package whose prototype it patches is installed", async () => {
  const { out, record } = await cut({ tests: true });
  assert.ok(existsSync(join(out, TEST)));
  assert.ok(existsSync(join(out, FAKE)), "the fake is copied, not stubbed");
  assert.equal(existsSync(join(out, "apps/shop/test/fake-lines.d.ts")), false);
  assert.deepEqual(record.manifest.included.map((file) => file.path).filter((path) => path.startsWith("apps/shop/test/")), [TEST, FAKE]);
  const stripe = record.dependencies.find((dependency) => dependency.name === "stripe");
  assert.equal(stripe?.resolution, "approved-package");
  assert.equal(stripe?.version, "^17.0.0");
  // Without the test, the service SDK is mocked as before.
  const plain = await cut({});
  assert.equal(plain.record.dependencies.find((dependency) => dependency.name === "stripe")?.resolution, "runtime-mock");
  // A scope's other packages the slice imports are installed with it.
  const scoped = await cut({ entryPoints: ["apps/shop/src/objects.ts"], tests: true });
  const resolution = Object.fromEntries(scoped.record.dependencies.map((dependency) => [dependency.name, dependency.resolution]));
  assert.equal(resolution["@aws-sdk/client-s3"], "approved-package");
  assert.equal(resolution["@aws-sdk/s3-request-presigner"], "approved-package");
  const unpatched = await cut({ entryPoints: ["apps/shop/src/objects.ts"] });
  assert.equal(unpatched.record.dependencies.find((dependency) => dependency.name === "@aws-sdk/client-s3")?.resolution, "runtime-mock");
});

test("a workspace package is followed into its source on request", async () => {
  const { out, record } = await cut({ followWorkspaces: true });
  assert.ok(existsSync(join(out, "packages/money/src/index.ts")), "the package's source is copied");
  assert.equal(existsSync(join(out, "packages/money/src/index.d.ts")), false);
  assert.match(readFileSync(join(out, ENTRY), "utf8"), /from "\.\.\/\.\.\/\.\.\/packages\/money\/src\/index\.js"/);
  assert.equal(record.request.followWorkspaces, true);
  assert.equal(record.dependencies.some((dependency) => dependency.name === "@fx/money"), false);
  // The plan says the same.
  const plan = planSlice({ repo, entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, followWorkspaces: true });
  assert.ok(plan.walk.included.includes("packages/money/src/index.ts"));
  assert.equal(plan.followWorkspaces, true);
  // Past the depth, it is cut like any module.
  const far = planSlice({ repo, entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 0 }, followWorkspaces: true });
  assert.ok(far.cutModules.includes("packages/money/src/index.ts"));
});

test("a copied folder comes along, and an edit to it is in the patch", async () => {
  const { out, record } = await cut({ copy: ["apps/shop/migrations"] });
  assert.ok(existsSync(join(out, MIGRATION)));
  assert.deepEqual(record.extras?.map((extra) => extra.path), [MIGRATION]);
  assert.deepEqual(record.request.copy, ["apps/shop/migrations"]);
  assert.equal((await patchProject(out)).diff, "");
  writeFileSync(join(out, MIGRATION), "create table carts (id int, total int);\n");
  writeFileSync(join(out, "apps/shop/migrations/0002.sql"), "alter table carts add owner text;\n");
  const patch = await patchProject(out);
  assert.deepEqual(patch.changed, [MIGRATION]);
  assert.deepEqual(patch.added, ["apps/shop/migrations/0002.sql"]);
  assert.match(patch.diff, /\+create table carts \(id int, total int\);/);
  await assert.rejects(cut({ copy: ["apps/shop/nowhere"] }), /no such file or folder/);
});

test("the owner's configuration bounds every cut", async () => {
  writeFileSync(
    join(repo, CONFIG_PATH),
    `${JSON.stringify({ wholePackage: true, private: ["apps/shop/src/tax.ts"] })}\n`,
  );
  try {
    assert.deepEqual(readRepoConfig(repo), { wholePackage: true, private: ["apps/shop/src/tax.ts"] });
    const plan = planSlice({ repo, entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 0 } });
    assert.equal(plan.wholePackage, true);
    assert.deepEqual(plan.private, ["apps/shop/src/tax.ts"]);
    // The whole package at depth 0, but for the private file, which is cut.
    assert.deepEqual(plan.walk.privateFiles, ["apps/shop/src/tax.ts"]);
    assert.ok(plan.cutModules.includes("apps/shop/src/tax.ts"));
    assert.ok(plan.walk.included.includes("apps/shop/src/cart.css"));
    // A flag overrides a boolean; the lists are joined.
    assert.equal(planSlice({ repo, entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 0 }, wholePackage: false }).wholePackage, false);
    assert.deepEqual(
      planSlice({ repo, entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 0 }, private: ["apps/shop/src/cart.css"] }).private,
      ["apps/shop/src/cart.css", "apps/shop/src/tax.ts"],
    );
    const { out, record } = await cut({ budget: { maxFiles: 40, maxDepth: 0 } });
    assert.equal(record.request.wholePackage, true);
    assert.deepEqual(record.request.private, ["apps/shop/src/tax.ts"]);
    // A private module is a stub, and its literals are widened (the cut
    // asks for it; the mechanism is covered with the other stubs).
    assert.equal(record.request.widenLiterals, true);
    assert.equal(existsSync(join(out, "apps/shop/src/tax.ts")), false);
    assert.match(readFileSync(join(out, "apps/shop/src/tax.d.ts"), "utf8"), /export declare function tax\(cents: number\): number;/);
    assert.deepEqual(record.inputs.filter((input) => input.path === CONFIG_PATH).map((input) => input.sha256 !== null), [true]);
    writeFileSync(join(repo, CONFIG_PATH), '{"private": "apps"}\n');
    assert.throws(() => readRepoConfig(repo), /private must be a list of paths/);
  } finally {
    rmSync(join(repo, CONFIG_PATH), { force: true });
  }
});

test("a path matcher takes paths, folders and globs", () => {
  const matches = pathMatcher(["a/b", "src/**/*.test.ts", "lib/*.ts", "./deep/"]);
  for (const path of ["a/b", "a/b/c.ts", "src/x/y.test.ts", "src/y.test.ts", "lib/z.ts", "deep/x/y.ts"])
    assert.ok(matches(path), path);
  for (const path of ["a/bc", "lib/z/w.ts", "src/x.ts", "a", "deeper/x.ts"])
    assert.equal(matches(path), false, path);
  // A trailing `**`, as the README writes a private folder, is all under it.
  const under = pathMatcher(["packages/core/src/pricing/**"]);
  for (const path of ["packages/core/src/pricing/a.ts", "packages/core/src/pricing/x/a.ts"])
    assert.ok(under(path), path);
  assert.equal(under("packages/core/src/pricingx/a.ts"), false);
});

test("specifiers are read from the syntax tree, not from comments or strings", () => {
  const text = [
    "/** Callers import this from \"nowhere\". */",
    "const s = 'import { x } from \"pkg\"';",
    '// import z from "gone";',
    'import y from "real";',
    'import type { T } from "./types";',
    'const t: import("./other").T = 1;',
    'vi.mock("./m");',
    'const r = require("./r");',
    'export * from "./e";',
    'const d = await import("./d");',
    "",
  ].join("\n");
  assert.deepEqual([...specifiersOf(text)], ["real", "./types", "./other", "./m", "./r", "./e", "./d"]);
  const kinds = Object.fromEntries(moduleSpecifiers("x.ts", text).map((item) => [item.specifier, `${item.kind}${item.typeOnly ? ":type" : ""}`]));
  assert.deepEqual(kinds, {
    real: "import",
    "./types": "import:type",
    "./other": "type:type",
    "./m": "reference",
    "./r": "require",
    "./e": "import",
    "./d": "import",
  });
  // Rewritten in place, the rest byte for byte.
  const rewritten = rewriteSpecifiers("x.ts", text, ({ specifier }) => (specifier === "real" ? "./real.js" : null));
  assert.equal(rewritten, text.replace('from "real"', 'from "./real.js"'));
});

test("the owner's bound on what a folder shows: plan says, a cut past it is never ready", async () => {
  const plan = planSlice({ repo, entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 } });
  assert.equal(plan.exposureBudget, undefined, "no bound, no budget");
  const shown = plan.exposure.lines;
  assert.ok(shown > 1);
  // Under the bound: measured, nothing over, and the cut is as it was.
  const within = planSlice({ repo, entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, maxExposure: { lines: shown, percent: 100 } });
  assert.equal(within.exposureBudget?.over, null);
  assert.ok((within.exposureBudget?.repositoryLines ?? 0) >= shown);
  // Over it, by lines from the configuration and by percent from the request.
  writeFileSync(join(repo, CONFIG_PATH), JSON.stringify({ maxExposureLines: shown - 1 }));
  try {
    assert.equal(readRepoConfig(repo).maxExposureLines, shown - 1);
    const over = planSlice({ repo, entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 } });
    assert.match(over.exposureBudget?.over ?? "", new RegExp(`past the bound of ${(shown - 1).toLocaleString("en-US")}`));
    const { record } = await cut({});
    assert.equal(record.ready, false);
    assert.match(record.blockers.find((blocker) => blocker.code === "exposure_exceeded")?.detail ?? "", /more of the repository than the owner allows/);
    // A flag overrides the configuration.
    const flagged = await cut({ maxExposure: { lines: shown } });
    assert.equal(flagged.record.blockers.some((blocker) => blocker.code === "exposure_exceeded"), false);
  } finally {
    rmSync(join(repo, CONFIG_PATH), { force: true });
  }
  const tiny = planSlice({ repo, entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, maxExposure: { percent: 0.0001 } });
  assert.match(tiny.exposureBudget?.over ?? "", /% of the repository's/);
  writeFileSync(join(repo, CONFIG_PATH), JSON.stringify({ maxExposurePercent: -1 }));
  try {
    assert.throws(() => readRepoConfig(repo), /maxExposurePercent must be a number above 0/);
  } finally {
    rmSync(join(repo, CONFIG_PATH), { force: true });
  }
});
