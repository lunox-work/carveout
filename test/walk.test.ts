/**
 * The walk on a small repository written per test: barrels followed by
 * name, imports of types cut, modules named to a test runner never
 * followed, files read by path copied, tests brought along on request,
 * and the files a full budget leaves out named.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { buildGraph, walkGraph } from "../src/graph.js";
import { undoRewrites } from "../src/carve.js";
import { specifiersOf } from "../src/imports.js";
import { serviceOf } from "../src/slice/externals.js";
import { reach } from "../src/slice/reach.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "carveout-walk-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const walk = (
  files: Record<string, string>,
  entries: string[],
  budget = { maxFiles: 40, maxDepth: 1 },
  options = {},
) => reach(buildGraph(repository(files)).graph, entries, budget, options);

const BARREL = {
  "lib/index.ts": 'export * from "./a.js";\nexport * from "./b.js";\nexport { c as see } from "./c.js";\n',
  "lib/a.ts": 'export const a = () => "a";\n',
  "lib/b.ts": 'export const b = () => "b";\n',
  "lib/c.ts": 'export const c = () => "c";\n',
};

test("a barrel is followed only to the modules that supply the names", () => {
  const result = walk(
    { ...BARREL, "app.ts": 'import { a, see } from "./lib/index.js";\nexport const x = a() + see();\n' },
    ["app.ts"],
  );
  assert.deepEqual(result.included, ["app.ts", "lib/a.ts", "lib/c.ts", "lib/index.ts"]);
  // A re-export is not an import of the barrel's own code: same depth.
  assert.equal(result.depthOf["lib/a.ts"], 1);
  assert.deepEqual(
    result.cuts.outbound.map((edge) => edge.to),
    ["lib/b.ts"],
  );
});

test("a namespace import or a side-effect import takes the whole barrel", () => {
  const result = walk(
    { ...BARREL, "app.ts": 'import * as lib from "./lib/index.js";\nexport const all = lib;\n' },
    ["app.ts"],
  );
  assert.deepEqual(result.included, [
    "app.ts",
    "lib/a.ts",
    "lib/b.ts",
    "lib/c.ts",
    "lib/index.ts",
  ]);
});

test("an import of types only is cut, never copied", () => {
  const result = walk(
    {
      "app.ts": [
        'import type { Order } from "./types.js";',
        'import { Shape } from "./shapes.js";',
        'import { total } from "./money.js";',
        "export const f = (o: Order, s: Shape) => total(o.id + s.kind);",
      ].join("\n"),
      "types.ts": "export interface Order { id: string }\n",
      "shapes.ts": 'export type Shape = { kind: "a" };\nexport const unused = 1;\n',
      "money.ts": "export const total = (s: string) => s;\n",
    },
    ["app.ts"],
  );
  assert.deepEqual(result.included, ["app.ts", "money.ts"]);
  const cut = new Map(result.cuts.outbound.map((edge) => [edge.to, edge.typeOnly]));
  assert.equal(cut.get("types.ts"), true);
  // Named without `type`, but the module declares it as a type alias.
  assert.equal(cut.has("shapes.ts"), true);
});

test("a module named to a test runner is cut, a file read by path is copied", () => {
  const result = walk(
    {
      "job.ts": [
        'import { join } from "node:path";',
        'import { vi } from "vitest";',
        'vi.mock("./db.js");',
        'export const worker = new URL("./worker.ts", import.meta.url);',
        'export const query = join(__dirname, "sql", "get.sql");',
        'export const folder = join(__dirname, "sql");',
        'export const later = join(__dirname, "made-at-runtime.json");',
      ].join("\n"),
      "db.ts": "export const db = {};\n",
      "worker.ts": "export const w = 1;\n",
      "sql/get.sql": "select 1;\n",
    },
    ["job.ts"],
  );
  assert.deepEqual(result.included, ["job.ts", "sql/get.sql", "worker.ts"]);
  const db = result.cuts.outbound.find((edge) => edge.to === "db.ts");
  assert.equal(db?.relation, "references");
  assert.equal(db?.specifier, "./db.js");
  // A folder read by path cannot be copied; a missing path is the
  // repository's own runtime business.
  assert.deepEqual(
    result.dependencies
      .filter((dependency) => dependency.status === "path")
      .map((dependency) => dependency.specifier),
    ["sql"],
  );
});

test("tests that import the slice come along on request", () => {
  const files = {
    "app.ts": "export const one = 1;\n",
    "app.test.ts": 'import { test } from "node:test";\nimport { one } from "./app.js";\ntest("one", () => void one);\n',
    "app.vi.test.ts": 'import { test } from "vitest";\nimport { one } from "./app.js";\ntest("one", () => void one);\n',
    "app.plain.test.ts": 'import { one } from "./app.js";\nvoid one;\n',
    // A computed import comes along: what it names is the baseline's business.
    "app.url.test.ts": 'import { test } from "node:test";\nimport { one } from "./app.js";\nconst m = await import(new URL("../x.mjs", import.meta.url).href);\ntest("one", () => void [one, m]);\n',
    // Beside an import of a file of its own package the slice does not
    // hold, it comes along too, and that file with it as a helper.
    "app.url.stray.test.ts": 'import { test } from "node:test";\nimport { one } from "./app.js";\nimport { two } from "./other.js";\nconst m = await import(new URL("../x.mjs", import.meta.url).href);\ntest("one", () => void [one, two, m]);\n',
    "other.ts": 'import { one } from "./app.js";\nexport const two = one + 1;\n',
    // Beside an import of a file of another package, it does not.
    "app.url.far.test.ts": 'import { test } from "node:test";\nimport { one } from "./app.js";\nimport { three } from "../far/lib.js";\nconst m = await import(new URL("../x.mjs", import.meta.url).href);\ntest("one", () => void [one, three, m]);\n',
  };
  const without = walk(files, ["app.ts"]);
  assert.deepEqual(without.included, ["app.ts"]);
  assert.deepEqual(without.tests, []);
  const far = (file: string) => (file.startsWith("far/") ? "far" : "");
  const withTests = walk(files, ["app.ts"], undefined, { tests: true, packageOf: far });
  assert.deepEqual(withTests.tests, ["app.test.ts", "app.url.stray.test.ts", "app.url.test.ts", "app.vi.test.ts"]);
  assert.deepEqual(withTests.helpers, ["other.ts"]);
  assert.deepEqual(withTests.untestable, ["app.plain.test.ts", "app.url.far.test.ts"]);
  assert.deepEqual(withTests.included, ["app.test.ts", "app.ts", "app.url.stray.test.ts", "app.url.test.ts", "app.vi.test.ts", "other.ts"]);
  assert.equal(withTests.depthOf["app.test.ts"], 1);
  assert.equal(withTests.depthOf["other.ts"], 2);
});

test("a test brings its own helpers, from its package or a test folder, never a stub in a fake's place", () => {
  const files = {
    "packages/db/src/store.ts": 'import type { Db } from "./db.js";\nexport const count = (db: Db) => db.rows.length;\n',
    "packages/db/src/db.ts": 'export interface Db { rows: unknown[] }\nexport const connect = () => ({ rows: [] });\n',
    "packages/db/test/fake-db.ts": 'import type { Db } from "../src/db.js";\nimport { rows } from "./rows.js";\nexport const fakeDb = (): Db => ({ rows });\n',
    "packages/db/test/rows.ts": "export const rows = [1, 2];\n",
    "packages/db/test/store.test.ts": 'import { test } from "node:test";\nimport { count } from "../src/store.js";\nimport { fakeDb } from "./fake-db.js";\nimport { build } from "../../shared/testing/build.js";\nimport { other } from "../../other/src/index.js";\ntest("count", () => void [count(fakeDb()), build, other]);\n',
    "packages/shared/testing/build.ts": "export const build = () => 1;\n",
    "packages/other/src/index.ts": "export const other = 1;\n",
  };
  const packageOf = (file: string) => file.split("/").slice(0, 2).join("/");
  const result = walk(files, ["packages/db/src/store.ts"], { maxFiles: 40, maxDepth: 0 }, { tests: true, packageOf });
  assert.deepEqual(result.tests, ["packages/db/test/store.test.ts"]);
  // The fake and what it imports, and a helper from a test folder of another
  // package; the other package's module is a cut, as the type-only db.ts is.
  assert.deepEqual(result.helpers, ["packages/db/test/fake-db.ts", "packages/db/test/rows.ts", "packages/shared/testing/build.ts"]);
  assert.deepEqual([...new Set(result.cuts.outbound.map((edge) => edge.to))].sort(), ["packages/db/src/db.ts", "packages/other/src/index.ts"]);
  assert.equal(result.depthOf["packages/db/test/fake-db.ts"], 2);
  assert.equal(result.depthOf["packages/db/test/rows.ts"], 3);
  // Without the request, nothing of the kind.
  assert.deepEqual(walk(files, ["packages/db/src/store.ts"], { maxFiles: 40, maxDepth: 0 }).included, ["packages/db/src/store.ts"]);
});

test("the whole package comes along on request, and the cut falls at its edge", () => {
  const files = {
    "packages/api/src/handler.ts": 'import { parse } from "./parse.js";\nimport { price } from "../../core/src/index.js";\nexport const handle = () => price(parse());\n',
    "packages/api/src/parse.ts": 'import { norm } from "./norm.js";\nexport const parse = () => norm();\n',
    "packages/api/src/norm.ts": 'import type { Shape } from "./types.js";\nexport const norm = (): Shape => ({});\n',
    "packages/api/src/types.ts": "export interface Shape {}\n",
    "packages/api/src/unrelated.ts": "export const unrelated = 1;\n",
    "packages/api/test/parse.test.ts": 'import { test } from "node:test";\nimport { parse } from "../src/parse.js";\ntest("parse", () => void parse());\n',
    "packages/core/src/index.ts": "export const price = (x: unknown) => x;\n",
  };
  const packageOf = (file: string) => file.split("/").slice(0, 2).join("/");
  const depth = walk(files, ["packages/api/src/handler.ts"], { maxFiles: 40, maxDepth: 0 }, { packageOf });
  assert.deepEqual(depth.included, ["packages/api/src/handler.ts"]);
  const whole = walk(files, ["packages/api/src/handler.ts"], { maxFiles: 40, maxDepth: 0 }, { packageOf, wholePackage: true });
  // Every file of the package the imports reach, types included, at any
  // depth; not a file nothing reaches, not another package's past the
  // depth, and not a test without the request.
  assert.deepEqual(whole.included, ["packages/api/src/handler.ts", "packages/api/src/norm.ts", "packages/api/src/parse.ts", "packages/api/src/types.ts"]);
  assert.equal(whole.depthOf["packages/api/src/types.ts"], 3);
  assert.deepEqual([...new Set(whole.cuts.outbound.map((edge) => edge.to))], ["packages/core/src/index.ts"]);
  const tested = walk(files, ["packages/api/src/handler.ts"], { maxFiles: 40, maxDepth: 0 }, { packageOf, wholePackage: true, tests: true });
  assert.deepEqual(tested.tests, ["packages/api/test/parse.test.ts"]);
  // The budget still bounds it, and names what it left out.
  const bounded = walk(files, ["packages/api/src/handler.ts"], { maxFiles: 3, maxDepth: 0 }, { packageOf, wholePackage: true });
  assert.equal(bounded.included.length, 3);
  assert.deepEqual(bounded.dropped, ["packages/api/src/types.ts"]);
});

test("a private file is never entered: cut and stubbed wherever it is reached", () => {
  const files = {
    "src/app.ts": 'import { rate } from "./pricing/rules.js";\nimport { fmt } from "./fmt.js";\nexport const app = () => fmt(rate());\n',
    "src/pricing/rules.ts": 'import { base } from "./base.js";\nexport const rate = () => base * 2;\n',
    "src/pricing/base.ts": "export const base = 21;\n",
    "src/fmt.ts": "export const fmt = (n: number) => String(n);\n",
    "src/app.test.ts": 'import { test } from "node:test";\nimport { app } from "./app.js";\nimport { base } from "./pricing/base.js";\ntest("app", () => void [app(), base]);\n',
  };
  const isPrivate = (file: string) => file.startsWith("src/pricing/");
  const result = walk(files, ["src/app.ts"], { maxFiles: 40, maxDepth: 3 }, { isPrivate, tests: true, wholePackage: true });
  assert.deepEqual(result.included, ["src/app.test.ts", "src/app.ts", "src/fmt.ts"]);
  assert.deepEqual(result.privateFiles, ["src/pricing/base.ts", "src/pricing/rules.ts"]);
  assert.deepEqual([...new Set(result.cuts.outbound.map((edge) => edge.to))].sort(), ["src/pricing/base.ts", "src/pricing/rules.ts"]);
  // Not at the file limit: a private file is kept out, not dropped.
  assert.deepEqual(result.dropped, []);
});

test("a test that reaches the slice through a barrel comes along, and the barrel with it", () => {
  const files = {
    ...BARREL,
    "lib/a.test.ts": 'import { test } from "node:test";\nimport { a } from "./index.js";\ntest("a", () => void a());\n',
    "lib/b.test.ts": 'import { test } from "node:test";\nimport { b } from "./index.js";\ntest("b", () => void b());\n',
    "lib/all.test.ts": 'import { test } from "node:test";\nimport * as lib from "./index.js";\ntest("all", () => void lib);\n',
  };
  const result = walk(files, ["lib/a.ts"], undefined, { tests: true });
  // b is not in the slice, so the test of b through the barrel stays behind.
  assert.deepEqual(result.tests, ["lib/a.test.ts", "lib/all.test.ts"]);
  assert.deepEqual(result.included, ["lib/a.test.ts", "lib/a.ts", "lib/all.test.ts", "lib/index.ts"]);
  // The barrel sits at the depth of what it forwards, as a re-export does,
  // and its other re-exports are cut.
  assert.equal(result.depthOf["lib/index.ts"], 0);
  assert.equal(result.depthOf["lib/a.test.ts"], 1);
  assert.deepEqual([...new Set(result.cuts.outbound.map((edge) => edge.to))].sort(), ["lib/b.ts", "lib/c.ts"]);
  assert.deepEqual(walk(files, ["lib/a.ts"]).included, ["lib/a.ts"]);
});

test("the files a full budget leaves out are named", () => {
  const result = walk(
    {
      "app.ts": 'import "./a.js";\nimport "./b.js";\nimport "./c.js";\n',
      "a.ts": "export {};\n",
      "b.ts": "export {};\n",
      "c.ts": "export {};\n",
    },
    ["app.ts"],
    { maxFiles: 2, maxDepth: 3 },
  );
  assert.deepEqual(result.included, ["a.ts", "app.ts"]);
  assert.deepEqual(result.dropped, ["b.ts", "c.ts"]);
});

test("the same graph in any order gives the same slice", () => {
  const root = repository({
    ...BARREL,
    "app.ts": 'import { b } from "./lib/index.js";\nimport type { T } from "./t.js";\nexport const x = (t: T) => b() + t;\n',
    "t.ts": "export type T = string;\n",
  });
  const { graph } = buildGraph(root);
  const shuffled = {
    nodes: [...graph.nodes].reverse(),
    links: [...graph.links].reverse(),
  };
  const budget = { maxFiles: 40, maxDepth: 2 };
  assert.deepEqual(reach(shuffled, ["app.ts"], budget), reach(graph, ["app.ts"], budget));
});

test("a doc comment that says import does not swallow the import below it", () => {
  const text = [
    "/**",
    " * Callers import this app, and the contract has to sit where both can reach it.",
    " * `routes.ts` and its tests keep importing from",
    " * `./store.js` as they always have.",
    " */",
    "",
    'import { normalizeTitle } from "sandbox-factory";',
    "import {",
    "  NotFoundError,",
    "  type TodoStore,",
    '} from "@sandbox-factory/db";',
    "",
  ].join("\n");
  assert.deepEqual([...specifiersOf(text)], ["sandbox-factory", "@sandbox-factory/db"]);
  const rewrites = [{ file: "store.ts", from: "sandbox-factory", to: "../../../packages/core/src/index.js" }];
  const rewritten = text.replace('"sandbox-factory"', '"../../../packages/core/src/index.js"');
  assert.equal(undoRewrites(rewritten, rewrites), text);
});

test("an ORM over a mocked driver is installed, not mocked", () => {
  assert.equal(serviceOf("drizzle-orm"), null);
  assert.equal(serviceOf("drizzle-orm/pg-core"), null);
  assert.equal(serviceOf("postgres"), "postgres");
  assert.equal(serviceOf("@prisma/client"), "orm");
});

test("a module named to a test runner is rewritten and restored like an import", () => {
  const rewrites = [{ file: "a.test.ts", from: "@/db", to: "../db.js" }];
  assert.equal(
    undoRewrites('vi.mock("../db.js");\njest.requireActual("../db.js");\n', rewrites),
    'vi.mock("@/db");\njest.requireActual("@/db");\n',
  );
});

test("the lazy graph walks as the whole graph does, importers through ../.. included", () => {
  const root = repository({
    ...BARREL,
    "lib/deep/use.ts": 'import { a } from "../..";\nexport const u = a;\n',
    "lib/deep/other.ts": "export const unrelated = 1;\n",
    "index.ts": 'export * from "./lib/index.js";\n',
    "app.ts": 'import { b } from "./lib/index.js";\nexport const x = b;\n',
  });
  for (const entries of [["index.ts"], ["app.ts"], ["lib"]]) {
    const budget = { maxFiles: 40, maxDepth: 2 };
    const lazy = walkGraph(root, entries, budget, { tests: true });
    assert.deepEqual(lazy.walk, reach(buildGraph(root).graph, entries, budget, { tests: true }));
  }
  const lazy = walkGraph(root, ["index.ts"], { maxFiles: 40, maxDepth: 0 });
  assert.deepEqual(
    lazy.walk.cuts.inbound.map((edge) => edge.from),
    ["lib/deep/use.ts"],
  );
  assert.equal(lazy.built.files.includes("lib/deep/other.ts"), false);
});

test("a file that imports the slice by its package's name is an importer, followed or not", () => {
  const root = repository({
    "package.json": '{"type":"module","workspaces":["packages/*","apps/*"]}\n',
    "packages/money/package.json": '{"name":"@fx/money","type":"module","main":"./src/index.ts"}\n',
    "packages/money/src/index.ts": "export const format = (cents: number) => `${cents}`;\n",
    "apps/shop/package.json": '{"name":"shop","type":"module"}\n',
    "apps/shop/src/cart.ts": 'import { format } from "@fx/money";\nexport const total = format(1);\n',
  });
  const budget = { maxFiles: 40, maxDepth: 1 };
  for (const followWorkspaces of [false, true]) {
    const { walk: result } = walkGraph(root, ["packages/money/src/index.ts"], budget, { followWorkspaces });
    assert.deepEqual(result.included, ["packages/money/src/index.ts"]);
    assert.deepEqual(
      result.cuts.inbound.map((edge) => [edge.from, edge.to, edge.specifier]),
      [["apps/shop/src/cart.ts", "packages/money/src/index.ts", "@fx/money"]],
      `followWorkspaces: ${followWorkspaces}`,
    );
  }
});
