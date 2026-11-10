/**
 * The hand-off policy on a test the slice was handed: an assertion removed
 * or rewritten, or a test skipped, is held for the maintainer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { weakenedTest } from "../src/policy.js";

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
});
