/**
 * `carveout impact` on the shop fixture: the importers a change reaches
 * (through a workspace package's name, through barrels, across hops), the
 * exports whose type changed and who takes them, the tests among the
 * importers with their runner, and the commands that run just them.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, test } from "node:test";
import { impactOf } from "../src/impact.js";

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");
const CLI = resolve(import.meta.dirname, "../src/cli.js");

let scratch = "";
let repo = "";

const git = (args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");

const write = (path: string, text: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};

const edit = (path: string, from: string, to: string) => {
  const text = readFileSync(join(repo, path), "utf8");
  assert.ok(text.includes(from), `${path} holds ${from}`);
  writeFileSync(join(repo, path), text.replace(from, to));
};

beforeEach(() => {
  scratch ||= mkdtempSync(join(tmpdir(), "carveout-impact-"));
  repo = mkdtempSync(join(scratch, "repo-"));
  cpSync(FIXTURE, repo, { recursive: true });
  write(
    "apps/shop/package.json",
    '{ "name": "@fx/shop", "type": "module", "dependencies": { "@fx/money": "*", "stripe": "^17.0.0" }, "devDependencies": { "vitest": "^3.0.0" } }\n',
  );
  // A Vitest test two hops from cart.ts, and one on its globals.
  write(
    "apps/shop/src/checkout.test.ts",
    'import { describe, expect, it } from "vitest";\nimport { receipt } from "./checkout";\n\ndescribe("receipt", () => it("totals", () => expect(receipt([])).toMatch(/Total/)));\n',
  );
  write("apps/shop/src/globals.test.ts", 'import { subtotal } from "./cart";\n\ntest("sum", () => expect(subtotal([])).toBe(0));\n');
  // A barrel that forwards subtotal under another name, and its user.
  write("apps/shop/src/lib/index.ts", 'export { subtotal as sum } from "../cart";\nexport { tax } from "../tax";\n');
  // A file that takes only an unrelated name from that barrel.
  write("apps/shop/src/taxes.ts", 'import { tax } from "./lib";\n\nexport const taxes = (cents: number) => tax(cents);\n');
  write("apps/shop/src/report.ts", 'import { sum } from "./lib";\n\nexport const report = () => sum([]);\n');
  // A file that takes only a type, inline.
  write("apps/shop/src/view.ts", 'import { isCurrency, type Line } from "./cart";\n\nexport const view = (line: Line) => isCurrency(String(line.cents));\n');
  write(
    "packages/money/src/index.test.ts",
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { format } from "./index.ts";\n\ntest("format", () => assert.equal(format(100, "usd"), "1.00 USD"));\n',
  );
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("a change reaches importers through a workspace name and across hops", () => {
  edit("packages/money/src/index.ts", "currency: Currency): string", "currency: Currency, symbol = false): string");
  const impact = impactOf({ repo });
  assert.deepEqual(
    impact.changed.map(({ path }) => path),
    ["packages/money/src/index.ts"],
  );
  const depth = Object.fromEntries(impact.importers.map(({ file, depth }) => [file, depth]));
  assert.equal(depth["apps/shop/src/cart.ts"], 1, "imported as @fx/money");
  assert.equal(depth["apps/shop/src/checkout.ts"], 2);
  assert.equal(depth["apps/shop/src/checkout.test.ts"], 3);
  // report.ts and globals.test.ts take subtotal, whose code never reaches format.
  assert.equal(depth["apps/shop/src/report.ts"], undefined);
  assert.equal(depth["apps/shop/src/globals.test.ts"], undefined);
  const [format] = impact.exports;
  assert.equal(impact.exports.length, 1);
  assert.equal(format?.name, "format");
  assert.equal(format?.change, "changed");
  assert.match(format?.after ?? "", /symbol\?: boolean/);
  assert.deepEqual(format?.usedBy, ["apps/shop/src/cart.ts", "packages/money/src/index.test.ts"]);
  assert.deepEqual(
    impact.tests.map(({ file, runner }) => `${file} ${runner}`),
    ["packages/money/src/index.test.ts node", "apps/shop/src/checkout.test.ts vitest"],
  );
  assert.deepEqual(
    impact.commands.map(({ cwd, argv }) => `${cwd}: ${argv.join(" ")}`),
    [
      "apps/shop: npx --no vitest run src/checkout.test.ts",
      "packages/money: node --experimental-strip-types --test src/index.test.ts",
    ],
  );
});

test("an export's users are found through barrels and inline type imports", () => {
  edit("apps/shop/src/cart.ts", "readonly quantity: number;", "readonly quantity: number;\n  readonly sku: string;");
  edit("apps/shop/src/cart.ts", "export function subtotal(lines: readonly Line[]): number", "export function subtotal(lines: readonly Line[], rounding = 0): number");
  const byName = Object.fromEntries(impactOf({ repo }).exports.map((item) => [item.name, item]));
  assert.deepEqual(Object.keys(byName).sort(), ["Line", "subtotal"]);
  assert.match(byName["Line"]?.after ?? "", /readonly sku: string/);
  assert.deepEqual(byName["Line"]?.usedBy, ["apps/shop/src/checkout.ts", "apps/shop/src/view.ts"]);
  assert.deepEqual(byName["subtotal"]?.usedBy, ["apps/shop/src/globals.test.ts", "apps/shop/src/report.ts"]);
});

test("a barrel carries a change only through the names it forwards from it", () => {
  edit("apps/shop/src/cart.ts", "lines.reduce(", "0 + lines.reduce(");
  const impact = impactOf({ repo });
  const reached = impact.importers.map(({ file }) => file);
  // subtotal's change reaches total through cart.ts's own code, and on.
  assert.ok(reached.includes("apps/shop/src/checkout.test.ts"));
  assert.ok(impact.tests.some(({ file, runner }) => file === "apps/shop/src/globals.test.ts" && runner === "vitest"));
  assert.ok(reached.includes("apps/shop/src/lib/index.ts"));
  assert.ok(reached.includes("apps/shop/src/report.ts"), "takes sum, forwarded from cart");
  assert.ok(!reached.includes("apps/shop/src/taxes.ts"), "takes only tax from the barrel");
});

test("a deleted module's importers are found, and its exports are gone", () => {
  unlinkSync(join(repo, "apps/shop/src/tax.ts"));
  const impact = impactOf({ repo });
  assert.deepEqual(impact.changed, [{ path: "apps/shop/src/tax.ts", change: "deleted" }]);
  assert.equal(impact.importers[0]?.file, "apps/shop/src/cart.ts");
  assert.deepEqual(
    impact.exports.map(({ name, change }) => `${name} ${change}`),
    ["TAX_RATE removed", "tax removed"],
  );
});

test("--depth bounds the hops; named files have no base to compare", () => {
  const bounded = impactOf({ repo, files: ["apps/shop/src/cart.ts"], maxDepth: 1 });
  assert.ok(bounded.importers.every(({ depth }) => depth === 1));
  assert.ok(!bounded.importers.some(({ file }) => file === "apps/shop/src/checkout.test.ts"));
  assert.equal(bounded.base, null);
  assert.deepEqual(bounded.unchecked, [{ file: "apps/shop/src/cart.ts", reason: "no base to compare with (files were named)" }]);
});

test("--run runs the selected tests and exits 2 when one fails", () => {
  edit("packages/money/src/index.ts", "toFixed(2)", "toFixed(3)");
  const run = spawnSync(process.execPath, [CLI, "impact", "packages/money/src/index.ts", "--depth", "1", "--run", "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  const result = JSON.parse(run.stdout) as { runs: { ok: boolean; command: { cwd: string } }[] };
  const money = result.runs.find((item) => item.command.cwd === "packages/money");
  assert.equal(money?.ok, false);
  assert.equal(run.status, 2);
});
