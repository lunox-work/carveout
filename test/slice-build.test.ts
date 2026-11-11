/**
 * A slice builds and tests as its package does in the repository: under
 * the package's Vitest settings (a component's tests in jsdom, after its
 * setup file), and held to noImplicitAny but for the implicit anys the
 * stubs leave, which its build does not count.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { cutSlice, patchProject } from "../src/carve.js";
import { buildScript } from "../src/project/project.js";
import { fileEnvironments, vitestConfigText, vitestSettings } from "../src/project/vitest-config.js";

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");

let scratch = "";

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-build-"));
});

after(() => rmSync(scratch, { recursive: true, force: true }));

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

test("a package's Vitest settings are read from its config, never run", () => {
  const repo = join(scratch, "settings");
  write(repo, {
    "apps/web/vitest.config.ts": [
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig({",
      "  plugins: [],",
      "  test: {",
      '    environment: "jsdom",',
      "    globals: true,",
      '    setupFiles: ["./test/setup.ts", "./test/missing.ts"],',
      "    testTimeout: 30_000,",
      "  },",
      "});",
      "",
    ].join("\n"),
    "apps/web/test/setup.ts": "export {};\n",
    "apps/api/vite.config.ts": "export default { test: { environment: process.env.ENV } };\n",
  });
  assert.deepEqual(vitestSettings(repo, "apps/web"), {
    environment: "jsdom",
    setupFiles: ["apps/web/test/setup.ts"],
    testTimeout: 30000,
    globals: true,
  });
  // A computed value is Vitest's to work out; nothing literal, nothing read.
  assert.equal(vitestSettings(repo, "apps/api"), null);
  assert.equal(vitestSettings(repo, "apps/none"), null);
  assert.match(vitestConfigText({ environment: "jsdom", setupFiles: ["apps/web/test/setup.ts"] }), /"setupFiles": \[\n\s+"\.\/apps\/web\/test\/setup\.ts"/);
});

test("the Vitest settings are found as configs commonly write them", () => {
  const repo = join(scratch, "settings-forms");
  write(repo, {
    // `test` by shorthand, from a name, through `satisfies`.
    "a/vitest.config.ts": 'import { defineConfig } from "vitest/config";\nconst test = { environment: "happy-dom" };\nexport default defineConfig({ test });\n',
    "b/vite.config.ts": 'const testConfig = { environment: "jsdom", globals: true };\nexport default { test: testConfig } satisfies Record<string, unknown>;\n',
    // A function's block, and a plugin whose options hold another `test` first.
    "c/vitest.config.mts": [
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig(({ mode }) => {",
      '  const plugins = [plugin({ test: { environment: "node" } })];',
      '  return { plugins, test: { environment: "jsdom", testTimeout: 5_000 } };',
      "});",
      "",
    ].join("\n"),
    // A package's setup file by specifier, a path with no extension, and `root`.
    "d/vitest.config.ts": 'export default { test: { root: "./src", setupFiles: ["@testing-library/jest-dom/vitest", "./setup"] } };\n',
    "d/src/setup.ts": "export {};\n",
    // A config at the repository's root only.
    "vitest.config.ts": 'export default { test: { environment: "jsdom" } };\n',
  });
  assert.deepEqual(vitestSettings(repo, "a"), { environment: "happy-dom", setupFiles: [] });
  assert.deepEqual(vitestSettings(repo, "b"), { environment: "jsdom", setupFiles: [], globals: true });
  assert.deepEqual(vitestSettings(repo, "c"), { environment: "jsdom", setupFiles: [], testTimeout: 5000 });
  assert.deepEqual(vitestSettings(repo, "d"), { setupFiles: ["d/src/setup.ts"], setupPackages: ["@testing-library/jest-dom/vitest"] });
  assert.deepEqual(vitestSettings(repo, "e"), { environment: "jsdom", setupFiles: [] });
  assert.match(
    vitestConfigText({ setupFiles: ["d/src/setup.ts"], setupPackages: ["@testing-library/jest-dom/vitest"] }),
    /"setupFiles": \[\n\s+"@testing-library\/jest-dom\/vitest",\n\s+"\.\/d\/src\/setup\.ts"/,
  );
  assert.deepEqual(fileEnvironments("/**\n * @vitest-environment happy-dom\n */\nimport { it } from 'vitest';\n"), ["happy-dom"]);
});

test("a cut whose package runs its Vitest tests in jsdom carries the settings and the setup file", async () => {
  const repo = join(scratch, "web");
  cpSync(FIXTURE, repo, { recursive: true });
  write(repo, {
    "apps/shop/package.json": JSON.stringify({
      name: "@fx/shop",
      version: "1.0.0",
      type: "module",
      dependencies: { "@fx/money": "*", stripe: "^17.0.0" },
      devDependencies: { vitest: "^3.0.0" },
    }),
    "apps/shop/vitest.config.ts": 'export default { test: { environment: "jsdom", setupFiles: ["./test/setup.ts"] } };\n',
    "apps/shop/test/setup.ts": "globalThis.ready = true;\n",
    "apps/shop/src/tax.test.ts": 'import { expect, it } from "vitest";\nimport { tax } from "./tax";\nit("taxes", () => expect(tax(100)).toBe(10));\n',
  });
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const cut = await cutSlice({
    repo,
    out: join(scratch, "web-slice"),
    entryPoints: ["apps/shop/src/tax.ts"],
    budget: { maxFiles: 40, maxDepth: 1 },
    tests: true,
    offline: true,
    choices: { vitest: "approved-package" },
  });
  assert.ok(existsSync(join(cut.out, "apps/shop/test/setup.ts")), "the setup file comes along");
  const config = readFileSync(join(cut.out, "vitest.config.mjs"), "utf8");
  assert.match(config, /"environment": "jsdom"/);
  assert.match(config, /"\.\/apps\/shop\/test\/setup\.ts"/);
  // Walked from, but no entry point: not in the entry points an agent is
  // told of, nor imported by the interface test.
  assert.deepEqual(cut.record.manifest.entryPoints, ["apps/shop/src/tax.ts"]);
  assert.deepEqual(cut.record.manifest.params.setupFiles, ["apps/shop/test/setup.ts"]);
  assert.doesNotMatch(readFileSync(join(cut.out, "AGENTS.md"), "utf8"), /setup\.ts/);
  // A mock of the code under test in the setup file replaces it in every
  // test of the package: held as the runner's configuration is.
  writeFileSync(join(cut.out, "apps/shop/test/setup.ts"), 'import { vi } from "vitest";\nvi.mock("../src/tax", () => ({ tax: () => 10 }));\nglobalThis.ready = true;\n');
  const patch = await patchProject(cut.out);
  assert.match(
    patch.refused.find((refusal) => refusal.path === "apps/shop/test/setup.ts")?.reason ?? "",
    /changes what a check holds code to/,
    JSON.stringify(patch.refused),
  );
  assert.doesNotMatch(patch.diff, /vi\.mock/);
});

test("the folder's build does not count the implicit anys the stubs leave, and counts every other error", () => {
  const folder = join(scratch, "harness");
  write(folder, { "carveout/build.js": buildScript(["src/a.ts"]) });
  const run = (diagnostics: string) => {
    write(folder, { "node_modules/.bin/tsc": `#!/bin/sh\ncat <<'EOF'\n${diagnostics}\nEOF\nexit 2\n` });
    chmodSync(join(folder, "node_modules/.bin/tsc"), 0o755);
    return spawnSync(process.execPath, ["carveout/build.js"], { cwd: folder, encoding: "utf8" });
  };
  const waivedOnly = run("src/a.ts(3,10): error TS7006: Parameter 'x' implicitly has an 'any' type.");
  assert.equal(waivedOnly.status, 0, waivedOnly.stdout);
  assert.match(waivedOnly.stdout, /1 implicit any\(s\) the stubs leave/);
  // An implicit any in a file the cut did not find one in, or any other error, fails it.
  assert.equal(run("src/b.ts(1,1): error TS7006: Parameter 'y' implicitly has an 'any' type.").status, 1);
  const other = run("src/a.ts(2,2): error TS2322: Type 'string' is not assignable to type 'number'.\n  The expected type comes from here.");
  assert.equal(other.status, 1);
  assert.match(other.stdout, /TS2322[\s\S]*The expected type comes from here/);
  // The 7xxx checks that are no implicit any hold in a waived file too.
  assert.equal(run("src/a.ts(9,3): error TS7030: Not all code paths return a value.").status, 1);
  // An error of the project's, with no file before it, fails it.
  assert.equal(run("error TS18003: No inputs were found in config file 'tsconfig.json'.").status, 1);
  // So does a compiler that fails saying nothing, or is not there.
  assert.equal(run("").status, 1);
  rmSync(join(folder, "node_modules"), { recursive: true, force: true });
  const missing = spawnSync(process.execPath, ["carveout/build.js"], { cwd: folder, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /tsc did not run to the end/);
});

test("a service package the code's own types are built from is installed, not mocked", async () => {
  const repo = join(scratch, "typed");
  cpSync(FIXTURE, repo, { recursive: true });
  write(repo, {
    // Untyped, `Pick<Stripe.Customer, …>` demands what Stripe's own type leaves optional.
    "apps/shop/src/customer.ts": [
      'import type Stripe from "stripe";',
      // Beside it, for their values alone: installed, they would dial a
      // Redis and a Postgres the folder has none of.
      'import Redis from "ioredis";',
      'import pg from "pg";',
      "",
      'export function blank(): Pick<Stripe.Customer, "email" | "phone"> {',
      "  return {} as never;",
      "}",
      // Through a type of the file's own, as code often names an SDK's.
      "type Params = Stripe.CustomerCreateParams;",
      'export function partial(): Pick<Params, "email" | "phone"> {',
      "  return {};",
      "}",
      "export const cache = () => new Redis();",
      "export const pool = () => new pg.Pool();",
      "",
    ].join("\n"),
    "apps/shop/package.json": JSON.stringify({
      name: "@fx/shop",
      version: "1.0.0",
      type: "module",
      dependencies: { "@fx/money": "*", stripe: "^17.0.0", ioredis: "^5.4.0", pg: "^8.13.0" },
    }),
  });
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const cut = await cutSlice({
    repo,
    out: join(scratch, "typed-slice"),
    entryPoints: ["apps/shop/src/customer.ts"],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
  });
  const resolution = (name: string) => cut.record.dependencies.find((dependency) => dependency.name === name)?.resolution;
  assert.equal(resolution("stripe"), "approved-package", JSON.stringify(cut.record.dependencies));
  assert.equal(resolution("ioredis"), "runtime-mock");
  assert.equal(resolution("pg"), "runtime-mock");
});

test("a module that is no package (a Vite virtual module) is mocked in the folder and found by its name", async () => {
  const repo = join(scratch, "virtual");
  cpSync(FIXTURE, repo, { recursive: true });
  write(repo, {
    "apps/shop/src/version.ts":
      'import build from "virtual:build-info";\nimport { useRegisterSW } from "virtual:build-info/react";\n\nexport const version = (): string => String(build.version ?? "dev");\nexport const register = () => useRegisterSW();\n',
    "apps/shop/src/virtual.d.ts":
      'declare module "virtual:build-info" {\n  const build: { version?: string };\n  export default build;\n}\ndeclare module "virtual:build-info/react" {\n  export function useRegisterSW(): unknown;\n}\n',
  });
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const cut = await cutSlice({ repo, out: join(scratch, "virtual-slice"), entryPoints: ["apps/shop/src/version.ts"], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  const manifest = JSON.parse(readFileSync(join(cut.out, "package.json"), "utf8"));
  assert.equal(manifest.dependencies?.["virtual:build-info"], undefined);
  const map = JSON.parse(readFileSync(join(cut.out, "carveout/virtual/map.json"), "utf8"));
  assert.deepEqual(Object.keys(map), ["virtual:build-info"]);
  const tsconfig = JSON.parse(readFileSync(join(cut.out, "tsconfig.json"), "utf8"));
  assert.ok(tsconfig.compilerOptions.paths["virtual:build-info"]);
  assert.ok(tsconfig.compilerOptions.paths["virtual:build-info/*"], "a subpath answers from the module's mock");
  // The folder's loader finds it, and its subpath, at runtime: a recording mock.
  const run = spawnSync(
    process.execPath,
    ["--import", "./carveout/assets.js", "--input-type=module", "-e", 'const m = await import("virtual:build-info"); const r = await import("virtual:build-info/react"); console.log(typeof m.default, typeof r.useRegisterSW);'],
    { cwd: cut.out, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^(function|object) (function|object)/);
});

test("Vitest finds a module that is no package, and its subpaths, at the mock the folder holds", async () => {
  const at = join(scratch, "virtual-config");
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, "vitest.config.mjs"),
    vitestConfigText({ environment: "jsdom", setupFiles: [] }, undefined, { "virtual:pwa-register": "carveout/virtual/virtual-pwa-register" }),
  );
  const config = (await import(join(at, "vitest.config.mjs"))).default as {
    test: { environment: string };
    resolve: { alias: { find: RegExp; replacement: string }[] };
  };
  assert.equal(config.test.environment, "jsdom");
  const [alias] = config.resolve.alias;
  assert.ok(alias !== undefined);
  assert.ok(alias.find.test("virtual:pwa-register") && alias.find.test("virtual:pwa-register/react"));
  assert.ok(!alias.find.test("virtual:pwa-registered"));
  assert.equal(alias.replacement, join(realpathSync(at), "carveout/virtual/virtual-pwa-register/index.js"));
});

test("a git clone of a folder keeps the stubs' runtime mocks the build output's ignore would hide", async () => {
  const repo = join(scratch, "ignored");
  cpSync(FIXTURE, repo, { recursive: true });
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
  const cut = await cutSlice({ repo, out: join(scratch, "ignored-slice"), entryPoints: ["apps/shop/src/cart.ts"], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  const mocks = cut.record.generated.map((file) => file.path).filter((path) => /\.[cm]?js$/.test(path) && !path.startsWith("carveout/"));
  assert.ok(mocks.length > 0, JSON.stringify(cut.record.generated.map((file) => file.path)));
  git(cut.out, ["init", "-q"]);
  git(cut.out, ["add", "-A"]);
  const tracked = new Set(git(cut.out, ["ls-files"]).split("\n"));
  for (const path of mocks) assert.ok(tracked.has(path), `${path} is ignored`);
  // The build's output still is not.
  writeFileSync(join(cut.out, "apps/shop/src/cart.js"), "export {};\n");
  assert.equal(git(cut.out, ["status", "--porcelain", "--", "apps/shop/src/cart.js"]), "");
});

test("an alias or a bundler's module that starts with ~ is no package", async () => {
  const { isPackageName } = await import("../src/project/provenance.js");
  assert.equal(isPackageName("~"), false);
  assert.equal(isPackageName("~icons"), false);
  assert.equal(isPackageName("lodash"), true);
  assert.equal(isPackageName("@scope/pkg-name"), true);
  assert.equal(isPackageName("a".repeat(215)), false);
});

test("a name the interface test cannot know is a value (imported without `type` and exported again) is not asserted", async () => {
  const { guessedFromImport, runtimeKindOf } = await import("../src/project/project.js");
  const reexported = { name: "Item", kind: "unknown", declaration: 'import { total, Item } from "./cart.js";' };
  // A mock may export it; harmless for an interface.
  assert.equal(runtimeKindOf(reexported), "value");
  assert.equal(guessedFromImport(reexported), true);
  assert.equal(guessedFromImport({ name: "total", kind: "function", declaration: "export function total(): number;" }), false);
  assert.equal(guessedFromImport({ name: "LIMIT", kind: "unknown", declaration: "export const LIMIT = 3;" }), false);
});

test("two modules that are no package and make one folder name each get their own", async () => {
  const repo = join(scratch, "virtual-pair");
  cpSync(FIXTURE, repo, { recursive: true });
  write(repo, {
    "apps/shop/src/pair.ts": 'import a from "virtual:api";\nimport b from "#virtual-api";\n\nexport const pair = (): string => String(a) + String(b);\n',
    "apps/shop/src/pair.d.ts": "",
    "apps/shop/src/virtual.d.ts": 'declare module "virtual:api" {\n  const a: unknown;\n  export default a;\n}\ndeclare module "#virtual-api" {\n  const b: unknown;\n  export default b;\n}\n',
  });
  rmSync(join(repo, "apps/shop/src/pair.d.ts"));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const cut = await cutSlice({ repo, out: join(scratch, "virtual-pair-slice"), entryPoints: ["apps/shop/src/pair.ts"], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  const map = JSON.parse(readFileSync(join(cut.out, "carveout/virtual/map.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(map).sort(), ["#virtual-api", "virtual:api"]);
  assert.notEqual(map["virtual:api"], map["#virtual-api"]);
  assert.deepEqual(cut.record.blockers.filter((blocker) => blocker.code === "path_conflict"), []);
});

test("a file read by path is a path to copy, never a package named for its first folder", async () => {
  const repo = join(scratch, "path-read");
  cpSync(FIXTURE, repo, { recursive: true });
  write(repo, {
    "apps/shop/src/runner.ts": 'import { fileURLToPath } from "node:url";\n\nexport const script = (): string => fileURLToPath(new URL("../python/run.py", import.meta.url));\n',
    "apps/shop/python/run.py": 'print("hi")\n',
  });
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const request = { repo, entryPoints: ["apps/shop/src/runner.ts"], budget: { maxFiles: 40, maxDepth: 1 }, offline: true };
  const cut = await cutSlice({ ...request, out: join(scratch, "path-read-slice") });
  assert.equal(cut.record.dependencies.some((dependency) => dependency.name === "apps"), false, JSON.stringify(cut.record.dependencies));
  const blocker = cut.record.blockers.find((each) => each.code === "path_read");
  assert.match(blocker?.detail ?? "", /apps\/shop\/python\/run\.py is read by path[\s\S]*--copy apps\/shop\/python\/run\.py/);
  // Brought with --copy, it is there and nothing blocks.
  const copied = await cutSlice({ ...request, out: join(scratch, "path-read-copied"), copy: ["apps/shop/python"] });
  assert.ok(existsSync(join(copied.out, "apps/shop/python/run.py")));
  assert.equal(copied.record.blockers.some((each) => each.code === "path_read"), false, JSON.stringify(copied.record.blockers));
});

test("the folder's Vitest reads the source beside a built .js, as the repository's does", async () => {
  const at = join(scratch, "source-first");
  write(at, {
    "src/mod.ts": 'export const value = "source";\n',
    "src/mod.js": 'export const value = "the last build";\n',
    "src/only.js": "export {};\n",
    "vitest.config.mjs": vitestConfigText({ setupFiles: [] }),
  });
  const config = (await import(join(at, "vitest.config.mjs"))).default as {
    plugins: { resolveId: (source: string, importer?: string) => string | null }[];
  };
  const [plugin] = config.plugins;
  assert.ok(plugin !== undefined);
  const importer = join(at, "src/mod.test.ts");
  assert.equal(plugin.resolveId("./mod.js", importer), join(at, "src/mod.ts"));
  // A .js with no source beside it, a package, or an import from inside one is left to Vite.
  assert.equal(plugin.resolveId("./only.js", importer), null);
  assert.equal(plugin.resolveId("react", importer), null);
  assert.equal(plugin.resolveId("./mod.js", join(at, "node_modules/x/index.js")), null);
});

test("what a setup file loads is held as the setup is, a setup file named as an entry too, and a module only its own test imports is code", async () => {
  const repo = join(scratch, "setup-reach");
  cpSync(FIXTURE, repo, { recursive: true });
  write(repo, {
    "apps/shop/package.json": JSON.stringify({ name: "@fx/shop", version: "1.0.0", type: "module", dependencies: { "@fx/money": "*", stripe: "^17.0.0" }, devDependencies: { vitest: "^3.0.0" } }),
    "apps/shop/vitest.config.ts": 'export default { test: { environment: "jsdom", setupFiles: ["./test/setup.ts"] } };\n',
    "apps/shop/test/setup.ts": 'import "./register";\n',
    "apps/shop/test/register.ts": "globalThis.ready = true;\nexport {};\n",
    "apps/shop/src/tax.test.ts": 'import { expect, it } from "vitest";\nimport { tax } from "./tax";\nit("taxes", () => expect(tax(100)).toBe(10));\n',
    "apps/shop/src/rounding.ts": "export const round = (cents: number): number => Math.round(cents);\n",
    "apps/shop/src/rounding.test.ts": 'import { expect, it } from "vitest";\nimport { round } from "./rounding";\nit("rounds", () => expect(round(1.4)).toBe(1));\n',
  });
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const cutOf = async (name: string, entryPoints: string[]) =>
    (await cutSlice({ repo, out: join(scratch, name), entryPoints, budget: { maxFiles: 40, maxDepth: 1 }, tests: true, offline: true, choices: { vitest: "approved-package" } })).out;
  const mock = 'import { vi } from "vitest";\nvi.mock("../src/tax", () => ({ tax: () => 10 }));\n';
  // A module the setup file loads.
  const loaded = await cutOf("setup-reach-loaded", ["apps/shop/src/tax.ts"]);
  writeFileSync(join(loaded, "apps/shop/test/register.ts"), `${mock}globalThis.ready = true;\nexport {};\n`);
  const first = await patchProject(loaded);
  assert.ok(first.refused.some((refusal) => refusal.path === "apps/shop/test/register.ts"), JSON.stringify(first.refused));
  // A setup file the cut was asked for by name, as cuts before setup files were recorded apart named them.
  const named = await cutOf("setup-reach-named", ["apps/shop/src/tax.ts", "apps/shop/test/setup.ts"]);
  writeFileSync(join(named, "apps/shop/test/setup.ts"), `${mock}import "./register";\n`);
  const second = await patchProject(named);
  assert.match(second.refused.find((refusal) => refusal.path === "apps/shop/test/setup.ts")?.reason ?? "", /changes what a check holds code to/, JSON.stringify(second.refused));
  // Under a folder entry, a module only its own test imports is the task's code.
  const folder = await cutOf("setup-reach-folder", ["apps/shop/src"]);
  writeFileSync(join(folder, "apps/shop/src/rounding.ts"), "export const round = (cents: number): number => Math.round(cents + 0);\n");
  const third = await patchProject(folder);
  assert.equal(third.refused.some((refusal) => refusal.path === "apps/shop/src/rounding.ts"), false, JSON.stringify(third.refused));
  assert.ok(third.changed.includes("apps/shop/src/rounding.ts"));
});

test("a config's inline projects are read, each with its paths, and carried extending the folder's config", async () => {
  const repo = join(scratch, "projects");
  write(repo, {
    "apps/web/vitest.config.ts": [
      'import { defineConfig, defineProject } from "vitest/config";',
      "export default defineConfig({",
      "  test: {",
      "    projects: [",
      '      { test: { name: "unit", include: ["src/**/*.unit.test.ts"], environment: "node" } },',
      '      defineProject({ test: { name: "dom", include: ["src/**/*.dom.test.ts"], environment: "jsdom", setupFiles: ["./test/dom-setup.ts"] } }),',
      "    ],",
      "  },",
      "});",
      "",
    ].join("\n"),
    "apps/web/test/dom-setup.ts": "export {};\n",
  });
  const settings = vitestSettings(repo, "apps/web");
  assert.deepEqual(settings, {
    setupFiles: [],
    projects: [
      { name: "unit", include: ["apps/web/src/**/*.unit.test.ts"], environment: "node", setupFiles: [] },
      { name: "dom", include: ["apps/web/src/**/*.dom.test.ts"], environment: "jsdom", setupFiles: ["apps/web/test/dom-setup.ts"] },
    ],
  });
  assert.ok(settings !== null);
  write(repo, { "out/vitest.config.mjs": vitestConfigText(settings) });
  const config = (await import(join(repo, "out/vitest.config.mjs"))).default as {
    test: { projects: { extends: boolean; test: { name: string; include: string[]; environment: string; setupFiles?: string[] } }[] };
  };
  assert.deepEqual(
    config.test.projects.map((project) => [project.extends, project.test.name, project.test.environment, project.test.include, project.test.setupFiles ?? []]),
    [
      [true, "unit", "node", ["apps/web/src/**/*.unit.test.ts"], []],
      [true, "dom", "jsdom", ["apps/web/src/**/*.dom.test.ts"], ["./apps/web/test/dom-setup.ts"]],
    ],
  );
});
