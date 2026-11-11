/**
 * The maintainer's receipt: the record a folder that comes back is judged
 * by, kept outside the folder where its holder cannot edit it, with the
 * baseline the first check recorded.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { cutSlice } from "../src/carve.js";
import { applyPatch } from "../src/mergeback.js";
import { readReceipt, receiptPathFor, trustedBaseline, trustedCut } from "../src/receipt.js";

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");
const ENTRY = "apps/shop/src/cart.ts";

let scratch = "";
let repo = "";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-receipt-"));
  repo = join(scratch, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("a cut writes a receipt only its owner reads, named by the id the folder carries", async () => {
  const result = await cutSlice({
    repo,
    out: join(scratch, "slice"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
  });
  const record = JSON.parse(readFileSync(join(result.out, "carveout.json"), "utf8"));
  assert.match(record.cutId, /^[0-9a-f]{32}$/);
  assert.equal(result.receipt, receiptPathFor(record.cutId));
  assert.ok(result.receipt !== null && existsSync(result.receipt));
  assert.equal(statSync(result.receipt ?? "").mode & 0o777, 0o600);
  const receipt = readReceipt(result.receipt ?? "");
  assert.equal(receipt.cutId, record.cutId);
  assert.equal(receipt.repo, repo);
  assert.deepEqual(receipt.record, record);
  // The folder says which receipt is its own; another file is refused.
  assert.equal(trustedCut(result.out).receiptPath, result.receipt);
  writeFileSync(join(scratch, "not-a-receipt.json"), "{}");
  assert.throws(() => trustedCut(result.out, join(scratch, "not-a-receipt.json")), /is not a carveout receipt/);
  // Asked for none, there is none, and the folder's record is all there is.
  const bare = await cutSlice({
    repo,
    out: join(scratch, "bare"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
    receipt: false,
  });
  assert.equal(bare.receipt, null);
  // The folder alone decides nothing: without a receipt it is refused,
  // unless the caller says to go on without one.
  assert.throws(() => trustedCut(bare.out), /No receipt for/);
  assert.equal(trustedCut(bare.out, undefined, { noReceipt: true }).receipt, null);
  // Or at a file the maintainer names.
  const named = join(scratch, "keep", "slice-receipt.json");
  const elsewhere = await cutSlice({
    repo,
    out: join(scratch, "elsewhere"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
    receipt: named,
  });
  assert.equal(elsewhere.receipt, named);
  assert.equal(trustedCut(elsewhere.out, named).receipt?.cutId, elsewhere.record.cutId);
});

test("a check reads the receipt's baseline, and names what the folder's own adds", () => {
  // The receipt's baseline, whatever the folder's says.
  assert.deepEqual(trustedBaseline({ baseline: ["mock fails"] }, ["mock fails", "my change fails"]), {
    use: ["mock fails"],
    edited: ["my change fails"],
  });
  // A receipt with none: a folder's baseline it never saw is not read.
  assert.deepEqual(trustedBaseline({}, ["my change fails"]), { use: null, edited: ["my change fails"] });
  assert.deepEqual(trustedBaseline({}, null), { use: null, edited: [] });
  // No receipt: the folder's own is all there is.
  assert.deepEqual(trustedBaseline(null, ["x"]), { use: "folder", edited: [] });
});

test("apply keeps the receipt in step with the folder it grows", async () => {
  const result = await cutSlice({
    repo,
    out: join(scratch, "apply"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
  });
  // A repository change that makes the slice reach a file it did not
  // hold, and edits it: the file joins the slice.
  const work = join(scratch, "apply-work");
  git(scratch, ["clone", "-q", repo, work]);
  writeFileSync(
    join(work, "apps/shop/src/cart.ts"),
    `${readFileSync(join(work, "apps/shop/src/cart.ts"), "utf8")}export { receipt } from "./checkout";\n`,
  );
  writeFileSync(
    join(work, "apps/shop/src/checkout.ts"),
    readFileSync(join(work, "apps/shop/src/checkout.ts"), "utf8").replace("Total:", "Sum:"),
  );
  const patch = git(work, ["diff"]);
  const applied = await applyPatch(result.out, patch);
  assert.deepEqual(applied.changed, ["apps/shop/src/cart.ts", "apps/shop/src/checkout.ts"]);
  const folder = JSON.parse(readFileSync(join(result.out, "carveout.json"), "utf8"));
  const receipt = readReceipt(result.receipt ?? "");
  assert.ok(folder.manifest.included.some((file: { path: string }) => file.path === "apps/shop/src/checkout.ts"));
  assert.deepEqual(
    receipt.record.manifest.included.map((file) => file.path),
    folder.manifest.included.map((file: { path: string }) => file.path),
  );
});

test("check runs no folder with a link in it, and in place no folder whose generated files are not the cut's", async () => {
  const { checkProject } = await import("../src/carve.js");
  const { symlinkSync } = await import("node:fs");
  const result = await cutSlice({
    repo,
    out: join(scratch, "linked"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
  });
  writeFileSync(join(scratch, "victim.txt"), "precious\n");
  symlinkSync(join(scratch, "victim.txt"), join(result.out, "carveout", "baseline.json"));
  const linked = await checkProject(result.out, { isolated: true });
  assert.equal(linked.length, 1);
  assert.equal(linked[0]?.ok, false);
  assert.match(linked[0]?.output ?? "", /symbolic links[\s\S]*carveout\/baseline\.json/);
  assert.equal(readFileSync(join(scratch, "victim.txt"), "utf8"), "precious\n");
  // In place, a changed test runner is not run: nothing is put back there.
  const edited = await cutSlice({
    repo,
    out: join(scratch, "inplace"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
  });
  writeFileSync(join(edited.out, "carveout", "test.js"), "process.exitCode = 0;\n");
  const steps = await checkProject(edited.out, { inPlace: true });
  assert.equal(steps.length, 1);
  assert.match(steps[0]?.output ?? "", /not the cut's \(carveout\/test\.js\)/);
});

test("a folder that is not the receipt's cut is refused, whatever id it carries", async () => {
  const first = await cutSlice({ repo, out: join(scratch, "shape-a"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  const second = await cutSlice({
    repo,
    out: join(scratch, "shape-b"),
    entryPoints: ["apps/shop/src/checkout.ts"],
    budget: { maxFiles: 40, maxDepth: 0 },
    offline: true,
  });
  // The first folder, claiming the second cut's id.
  const path = join(first.out, "carveout.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...record, cutId: second.record.cutId }));
  assert.throws(() => trustedCut(first.out), /does not hold the files of cut/);
});

test("apply merges a change into the folder's own edits, and leaves an overlap to a person", async () => {
  const cut = async (name: string) =>
    cutSlice({ repo, out: join(scratch, name), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  const upstream = (from: string, to: string) => {
    const work = join(scratch, `up-${Math.random().toString(36).slice(2)}`);
    git(scratch, ["clone", "-q", repo, work]);
    const file = join(work, ENTRY);
    writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
    return git(work, ["diff"]);
  };
  // Apart: the contributor's line and the repository's both stay.
  const apart = await cut("merge-apart");
  const held = join(apart.out, ENTRY);
  writeFileSync(held, readFileSync(held, "utf8").replace("export function subtotal", "// the contributor's note\nexport function subtotal"));
  const merged = await applyPatch(apart.out, upstream("  return new Stripe", "  // the repository's note\n  return new Stripe"));
  assert.deepEqual(merged.merged, [ENTRY]);
  assert.deepEqual(merged.conflicts, []);
  const text = readFileSync(held, "utf8");
  assert.match(text, /the contributor's note/);
  assert.match(text, /the repository's note/);
  // Over the same lines: left as the folder had them, and named.
  const over = await cut("merge-over");
  const mine = join(over.out, ENTRY);
  writeFileSync(mine, readFileSync(mine, "utf8").replace("export function subtotal", "export function subtotalMine"));
  const clash = await applyPatch(over.out, upstream("export function subtotal", "export function subtotalTheirs"));
  assert.deepEqual(clash.conflicts, [ENTRY]);
  assert.match(readFileSync(mine, "utf8"), /subtotalMine/);
  assert.doesNotMatch(readFileSync(mine, "utf8"), /subtotalTheirs|<<<<<<</);
});

test("a folder in pseudonyms keeps its edits through an apply that writes stubs, and the next apply merges into them", async () => {
  const cut = await cutSlice({
    repo,
    out: join(scratch, "pseudonym-apply"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
    public: true,
    names: ["subtotal"],
  });
  assert.ok(cut.pseudonyms !== null && cut.pseudonyms.rules.length > 0);
  const held = join(cut.out, ENTRY);
  writeFileSync(held, readFileSync(held, "utf8").replace("export interface Line", "// the contributor's note\nexport interface Line"));
  const change = (edit: (work: string) => void) => {
    const work = join(scratch, `up-${Math.random().toString(36).slice(2)}`);
    git(scratch, ["clone", "-q", repo, work]);
    edit(work);
    return git(work, ["diff"]);
  };
  // A: a new export of the stubbed package, used by tax.ts; cart.ts untouched.
  const first = await applyPatch(
    cut.out,
    change((work) => {
      const money = join(work, "packages/money/src/index.ts");
      writeFileSync(money, `${readFileSync(money, "utf8")}export function parse(text: string): number {\n  return Number(text);\n}\n`);
      const tax = join(work, "apps/shop/src/tax.ts");
      writeFileSync(tax, `import { parse } from "@fx/money";\n${readFileSync(tax, "utf8")}export const rate = (text: string): number => parse(text);\n`);
    }),
    { stubs: true },
  );
  assert.ok(first.stubs.some((stub) => stub.written), JSON.stringify(first.stubs));
  assert.match(readFileSync(held, "utf8"), /the contributor's note/);
  // B: over cart.ts. Merged into the folder's edit, not written over it.
  const second = await applyPatch(cut.out, change((work) => {
    const cart = join(work, ENTRY);
    writeFileSync(cart, readFileSync(cart, "utf8").replace("  return new Stripe", "  // the repository's note\n  return new Stripe"));
  }));
  assert.deepEqual(second.merged, [ENTRY]);
  assert.deepEqual(second.changed, [ENTRY]);
  assert.match(readFileSync(held, "utf8"), /the contributor's note[\s\S]*the repository's note/);
});

test("refresh brings the repository's commits since the cut into a folder that holds work", async () => {
  const { refreshProject } = await import("../src/mergeback.js");
  const moving = join(scratch, "moving");
  git(scratch, ["clone", "-q", repo, moving]);
  const cut = await cutSlice({ repo: moving, out: join(scratch, "refresh"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  assert.equal(await refreshProject(cut.out), null);
  // The contributor works; the repository moves on, in two files.
  const held = join(cut.out, ENTRY);
  writeFileSync(held, readFileSync(held, "utf8").replace("export function subtotal", "// the contributor's note\nexport function subtotal"));
  const cart = join(moving, ENTRY);
  writeFileSync(cart, readFileSync(cart, "utf8").replace("  return new Stripe", "  // the repository's note\n  return new Stripe"));
  const tax = join(moving, "apps/shop/src/tax.ts");
  writeFileSync(tax, readFileSync(tax, "utf8").replace("0.1", "0.2"));
  git(moving, ["commit", "-qam", "upstream"]);
  const refreshed = await refreshProject(cut.out);
  assert.ok(refreshed !== null);
  assert.deepEqual(refreshed.applied.merged, [ENTRY]);
  assert.deepEqual(refreshed.applied.conflicts, []);
  assert.ok(refreshed.applied.changed.includes("apps/shop/src/tax.ts"));
  assert.match(readFileSync(held, "utf8"), /the contributor's note[\s\S]*the repository's note/);
  assert.match(readFileSync(join(cut.out, "apps/shop/src/tax.ts"), "utf8"), /0\.2/);
});
