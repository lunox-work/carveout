/**
 * Whether a folder is ready for a fixed-scope hand-off: the cut names what
 * would turn a test that fails on the mocks toward real code (pure code to
 * copy, a database client to keep live, a migrations folder no import
 * names), and `check` says whether the tests pass before any edit.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { cutSlice } from "../src/carve.js";
import { configuredFolders, hasAdvice, liveCandidates, renderReadiness } from "../src/readiness.js";
import { serviceOf } from "../src/core.js";

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");

let scratch = "";

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-readiness-"));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

test("the folders a package reads by a configured name are found, not walked", () => {
  const repo = join(scratch, "folders");
  write(repo, {
    "packages/db/drizzle.config.ts": 'export default { schema: "./src/schema.ts", out: "./sql", dialect: "postgresql" };\n',
    "packages/db/sql/0000_init.sql": "create table t (id int);\n",
    "packages/db/sql/meta/_journal.json": "{}\n",
    "packages/api/drizzle/meta/_journal.json": "{}\n",
    "packages/api/drizzle/0000_a.sql": "select 1;\n",
    "packages/orm/prisma/schema.prisma": "datasource db { provider = \"postgresql\" }\n",
    "packages/old/knexfile.ts": 'export default { migrations: { directory: "./db/changes" } };\n',
    "packages/old/db/changes/001.ts": "export const up = () => {};\n",
    "packages/plain/migrations/001.sql": "select 1;\n",
    "packages/none/src/index.ts": "export {};\n",
  });
  const found = configuredFolders(
    repo,
    ["packages/db", "packages/api", "packages/orm", "packages/old", "packages/plain", "packages/none"],
    () => false,
  );
  assert.deepEqual(
    found.map(({ path, files }) => [path, files]),
    [
      ["packages/api/drizzle", 2],
      ["packages/db/sql", 2],
      ["packages/old/db/changes", 1],
      ["packages/orm/prisma", 1],
      ["packages/plain/migrations", 1],
    ],
  );
  assert.match(found.find((item) => item.path === "packages/db/sql")?.why ?? "", /out in drizzle\.config\.ts/);
  // A folder the cut copies or holds already is not advice.
  assert.deepEqual(
    configuredFolders(repo, ["packages/db"], (path) => path === "packages/db/sql").map((item) => item.path),
    [],
  );
  // A path that leaves the package is not followed.
  write(repo, { "packages/evil/drizzle.config.ts": 'export default { out: "../../../etc" };\n' });
  assert.deepEqual(configuredFolders(repo, ["packages/evil"], () => false), []);
});

test("a mocked database, cache or queue client is a --live candidate; an SDK is not", () => {
  const live = liveCandidates(
    [
      { name: "postgres", kind: "package", resolution: "runtime-mock" },
      { name: "ioredis", kind: "package", resolution: "runtime-mock" },
      { name: "better-sqlite3", kind: "package", resolution: "runtime-mock" },
      { name: "stripe", kind: "package", resolution: "runtime-mock" },
      { name: "pg", kind: "package", resolution: "approved-package" },
      { name: "packages/db/src/index.ts", kind: "module", resolution: "runtime-mock" },
    ],
    serviceOf,
  );
  assert.deepEqual(
    live.map(({ name }) => name),
    ["better-sqlite3", "ioredis", "postgres"],
  );
  const lines = renderReadiness({ tests: 1, copyPure: null, live, copy: [] });
  assert.match(lines.join("\n"), /--live postgres: keeps the postgres client real; the folder's tests then need a Postgres server/);
  assert.match(lines.join("\n"), /--live better-sqlite3: .*nothing: SQLite is a file/);
});

test("a cut whose tests reach mocked pure code names --copy-pure, and a public cut keeps the advice out of the folder", async () => {
  const repo = join(scratch, "shop");
  cpSync(FIXTURE, repo, { recursive: true });
  write(repo, {
    "apps/shop/src/checkout.test.ts": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { receipt } from "./checkout";',
      'test("receipt totals with tax", () => {',
      '  assert.equal(receipt([{ cents: 1000, quantity: 2 }]), "Total: 22.00 USD");',
      "});",
      "",
    ].join("\n"),
  });
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  const request = {
    repo,
    entryPoints: ["apps/shop/src/checkout.ts"],
    budget: { maxFiles: 40, maxDepth: 2 },
    tests: true,
    offline: true,
  } as const;
  const plain = await cutSlice({ ...request, out: join(scratch, "plain") });
  assert.equal(plain.readiness.tests, 1);
  assert.deepEqual(plain.readiness.copyPure?.files, ["packages/money/src/index.ts"]);
  assert.ok(hasAdvice(plain.readiness));
  assert.deepEqual(plain.record.readiness, plain.readiness);
  // With --copy-pure there is nothing more to copy.
  const pure = await cutSlice({ ...request, copyPure: true, out: join(scratch, "pure") });
  assert.equal(pure.readiness.copyPure, null);
  assert.ok(!hasAdvice(pure.readiness));
  // A public cut prints it and does not write it into the folder.
  const outside = await cutSlice({ ...request, public: true, out: join(scratch, "public") });
  assert.ok(hasAdvice(outside.readiness));
  assert.equal(outside.record.readiness, undefined);
  // Without tests there is nothing to turn green.
  const untested = await cutSlice({ ...request, tests: false, out: join(scratch, "untested") });
  assert.equal(untested.readiness.tests, 0);
  assert.equal(untested.readiness.copyPure, null);
});
