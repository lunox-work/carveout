/**
 * A slice builds and tests as its package does in the repository: under
 * the package's Vitest settings (a component's tests in jsdom, after its
 * setup file), and held to noImplicitAny but for the implicit anys the
 * stubs leave, which its build does not count.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { cutSlice } from "../src/carve.js";
import { buildScript } from "../src/project/project.js";
import { vitestConfigText, vitestSettings } from "../src/project/vitest-config.js";

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
});

test("a service package the code's own types are built from is installed, not mocked", async () => {
  const repo = join(scratch, "typed");
  cpSync(FIXTURE, repo, { recursive: true });
  write(repo, {
    // Untyped, `Pick<Stripe.Customer, …>` demands what Stripe's own type leaves optional.
    "apps/shop/src/customer.ts": [
      'import type Stripe from "stripe";',
      "",
      'export function blank(): Pick<Stripe.Customer, "email" | "phone"> {',
      "  return {} as never;",
      "}",
      'export function partial(): Pick<Stripe.CustomerCreateParams, "email" | "phone"> {',
      "  return {};",
      "}",
      "",
    ].join("\n"),
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
  const stripe = cut.record.dependencies.find((dependency) => dependency.name === "stripe");
  assert.equal(stripe?.resolution, "approved-package", JSON.stringify(cut.record.dependencies));
});
