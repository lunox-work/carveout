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
    "other.ts": 'import { one } from "./app.js";\nexport const two = one + 1;\n',
  };
  const without = walk(files, ["app.ts"]);
  assert.deepEqual(without.included, ["app.ts"]);
  assert.deepEqual(without.tests, []);
  const withTests = walk(files, ["app.ts"], undefined, { tests: true });
  assert.deepEqual(withTests.tests, ["app.test.ts", "app.vi.test.ts"]);
  assert.deepEqual(withTests.untestable, ["app.plain.test.ts"]);
  assert.deepEqual(withTests.included, ["app.test.ts", "app.ts", "app.vi.test.ts"]);
  assert.equal(withTests.depthOf["app.test.ts"], 1);
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
