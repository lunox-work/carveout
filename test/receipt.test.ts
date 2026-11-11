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
  // The folder's base moved to the commits it was brought: a patch carries
  // the contributor's work alone, and applies at the repository's HEAD.
  const { patchProject } = await import("../src/carve.js");
  const patch = await patchProject(cut.out, { repo: moving });
  assert.deepEqual(patch.changed, [ENTRY]);
  assert.doesNotMatch(patch.diff, /0\.2|the repository's note/);
  writeFileSync(join(scratch, "refresh.patch"), patch.diff);
  git(moving, ["apply", "--check", join(scratch, "refresh.patch")]);
  // A file the repository adds, which the contributor then edits, is never
  // written over by the next refresh.
  // Through the package's alias, which the cut rewrites in the folder.
  writeFileSync(join(moving, "apps/shop/src/discount.ts"), 'import { tax } from "@/tax";\nexport const DISCOUNT = 0.05;\nexport const taxed = (cents: number): number => tax(cents);\n');
  writeFileSync(cart, `import { DISCOUNT } from "./discount";\n${readFileSync(cart, "utf8")}export const discount = DISCOUNT;\n`);
  git(moving, ["add", "-A"]);
  git(moving, ["commit", "-qm", "upstream: a discount"]);
  const added = await refreshProject(cut.out);
  assert.ok(added !== null && added.applied.added.includes("apps/shop/src/discount.ts"), JSON.stringify(added?.applied));
  // Before the contributor edits it, a patch carries nothing of the added
  // file: its rewritten alias import reads back as the repository writes it.
  const unedited = await patchProject(cut.out, { repo: moving });
  assert.doesNotMatch(unedited.diff, /discount\.ts/, unedited.diff);
  const discount = join(cut.out, "apps/shop/src/discount.ts");
  writeFileSync(discount, readFileSync(discount, "utf8").replace("0.05", "0.05; // the contributor's"));
  writeFileSync(join(moving, "apps/shop/src/discount.ts"), 'import { tax } from "@/tax";\nexport const DISCOUNT = 0.07;\nexport const taxed = (cents: number): number => tax(cents);\n');
  git(moving, ["commit", "-qam", "upstream: a bigger discount"]);
  const again = await refreshProject(cut.out);
  assert.ok(again !== null);
  assert.ok(again.applied.conflicts.includes("apps/shop/src/discount.ts") || again.applied.merged.includes("apps/shop/src/discount.ts"), JSON.stringify(again.applied));
  assert.match(readFileSync(discount, "utf8"), /the contributor's/);
});

test("apply into a folder in pseudonyms names what the cut never saw by the same words, and names what it cannot", async () => {
  const named = join(scratch, "named-repo");
  cpSync(FIXTURE, named, { recursive: true });
  writeFileSync(join(named, "apps/shop/src/acme-cases.ts"), "// Acme fixtures\nexport const ACME_CASES = [1, 2];\n");
  const tax = join(named, "apps/shop/src/tax.ts");
  writeFileSync(tax, `import { ACME_CASES } from "./acme-cases";\n${readFileSync(tax, "utf8")}export const cases = ACME_CASES.length;\n`);
  git(named, ["init", "-q"]);
  git(named, ["add", "-A"]);
  git(named, ["commit", "-q", "-m", "fixture"]);
  const cut = await cutSlice({
    repo: named,
    out: join(scratch, "named"),
    entryPoints: ["apps/shop/src/tax.ts"],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
    public: true,
    names: ["acme"],
  });
  assert.ok(cut.receipt !== null);
  const placeholder = readReceipt(cut.receipt).pseudonyms?.words?.find((word) => word.term === "acme")?.placeholder ?? "";
  assert.ok(placeholder !== "" && placeholder !== "acme", JSON.stringify(readReceipt(cut.receipt).pseudonyms?.words));
  // The repository adds a file whose name and first line spell the term
  // where no rule of the cut's reaches, and a picture that spells it.
  const work = join(scratch, "named-up");
  git(scratch, ["clone", "-q", named, work]);
  writeFileSync(join(work, "apps/shop/src/acme-cases-v2.ts"), "// Acme checkout fixtures, v2\nexport const ACME_V2 = [3];\n");
  writeFileSync(join(work, "apps/shop/src/acme-logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>Acme Corp</title></svg>\n");
  const upTax = join(work, "apps/shop/src/tax.ts");
  writeFileSync(
    upTax,
    `import { ACME_V2 } from "./acme-cases-v2";\nimport logo from "./acme-logo.svg";\n${readFileSync(upTax, "utf8")}export const v2 = ACME_V2.length + String(logo).length;\n`,
  );
  git(work, ["add", "-A"]);
  const applied = await applyPatch(cut.out, git(work, ["diff", "--cached"]), { stubs: true });
  assert.ok(applied.added.includes("apps/shop/src/acme-cases-v2.ts"), JSON.stringify(applied));
  // Written under the placeholder, where the renamed import looks for it.
  assert.equal(existsSync(join(cut.out, "apps/shop/src/acme-cases-v2.ts")), false);
  const renamed = join(cut.out, `apps/shop/src/${placeholder}-cases-v2.ts`);
  assert.ok(existsSync(renamed), `expected ${renamed}`);
  assert.doesNotMatch(readFileSync(renamed, "utf8"), /acme/i);
  const folderTax = readFileSync(join(cut.out, "apps/shop/src/tax.ts"), "utf8");
  assert.match(folderTax, new RegExp(`from "\\./${placeholder}-cases-v2(\\.js)?"`));
  assert.doesNotMatch(folderTax, /acme/i);
  // What no word reaches (a picture copied as it is) is named, not sent.
  const logo = [`apps/shop/src/${placeholder}-logo.svg`, "apps/shop/src/acme-logo.svg"].find((path) => existsSync(join(cut.out, path)));
  if (logo !== undefined && /acme/i.test(readFileSync(join(cut.out, logo), "utf8")))
    assert.ok(applied.leaks.some((leak) => leak.files.includes(logo)), JSON.stringify(applied.leaks));
  else assert.deepEqual(applied.leaks, []);
});

test("refresh into a folder in pseudonyms brings the commits in its names, and its work stays", async () => {
  const { refreshProject } = await import("../src/mergeback.js");
  const moving = join(scratch, "moving-named");
  git(scratch, ["clone", "-q", repo, moving]);
  const cut = await cutSlice({
    repo: moving,
    out: join(scratch, "refresh-named"),
    entryPoints: [ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
    public: true,
    names: ["subtotal"],
  });
  const held = join(cut.out, ENTRY);
  assert.doesNotMatch(readFileSync(held, "utf8"), /subtotal/i);
  writeFileSync(held, readFileSync(held, "utf8").replace("export interface Line", "// the contributor's note\nexport interface Line"));
  // The repository moves on, and its new line spells the name where no
  // rule of the cut's reaches.
  const cart = join(moving, ENTRY);
  writeFileSync(cart, readFileSync(cart, "utf8").replace("  return new Stripe", "  // keep subtotal in cents\n  return new Stripe"));
  git(moving, ["commit", "-qam", "upstream"]);
  const refreshed = await refreshProject(cut.out);
  assert.ok(refreshed !== null);
  assert.deepEqual(refreshed.applied.merged, [ENTRY]);
  assert.deepEqual(refreshed.applied.leaks, []);
  const text = readFileSync(held, "utf8");
  assert.match(text, /the contributor's note[\s\S]*keep \w+ in cents/);
  assert.doesNotMatch(text, /subtotal/i);
});

test("apply and refresh bring no credential into the folder, as a cut of the same commit would not", async () => {
  const { refreshProject } = await import("../src/mergeback.js");
  const moving = join(scratch, "moving-secret");
  git(scratch, ["clone", "-q", repo, moving]);
  const cut = await cutSlice({ repo: moving, out: join(scratch, "refresh-secret"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  const tax = join(moving, "apps/shop/src/tax.ts");
  const key = ["AKIA", "Z7QXW4B9", "TNRLK2PM"].join("");
  writeFileSync(tax, `${readFileSync(tax, "utf8")}export const AWS_KEY = "${key}";\n`);
  git(moving, ["commit", "-qam", "upstream: a key"]);
  await assert.rejects(refreshProject(cut.out), /Nothing applied: the change would bring a credential/);
  assert.doesNotMatch(readFileSync(join(cut.out, "apps/shop/src/tax.ts"), "utf8"), new RegExp(key));
});

test("a renamed package name inside a file's own text data reads back, so a patch of an unedited folder is empty", async () => {
  const { patchProject } = await import("../src/carve.js");
  const data = join(scratch, "data-repo");
  cpSync(FIXTURE, data, { recursive: true });
  // A scope long enough to be a name the folder hides.
  for (const file of ["package.json", "apps/shop/package.json", "packages/money/package.json", "apps/shop/src/cart.ts", "apps/shop/src/checkout.ts"])
    if (existsSync(join(data, file))) writeFileSync(join(data, file), readFileSync(join(data, file), "utf8").replaceAll("@fx/", "@acmecorp/"));
  // The repository's own package name, inside a string a test or a doc holds.
  writeFileSync(
    join(data, "apps/shop/src/sample.ts"),
    "export const SAMPLE = 'import { format } from \"@acmecorp/money\";\\nimport { tax } from \"@acmecorp/money/tax\";\\n';\nexport const OTHER = \"from '@acmecorp/money'\";\n",
  );
  git(data, ["init", "-q"]);
  git(data, ["add", "-A"]);
  git(data, ["commit", "-q", "-m", "fixture"]);
  const cut = await cutSlice({
    repo: data,
    out: join(scratch, "data-slice"),
    entryPoints: ["apps/shop/src/sample.ts", ENTRY],
    budget: { maxFiles: 40, maxDepth: 1 },
    offline: true,
    public: true,
    names: ["acmecorp"],
  });
  assert.doesNotMatch(readFileSync(join(cut.out, "apps/shop/src/sample.ts"), "utf8"), /acmecorp/);
  const patch = await patchProject(cut.out);
  assert.deepEqual(patch.refused, []);
  assert.equal(patch.diff, "");
});

test("a refresh with an overlap moves the files it wrote, and a patch carries none of their commits", async () => {
  const { refreshProject } = await import("../src/mergeback.js");
  const { patchProject } = await import("../src/carve.js");
  const moving = join(scratch, "moving-partial");
  git(scratch, ["clone", "-q", repo, moving]);
  const cut = await cutSlice({ repo: moving, out: join(scratch, "refresh-partial"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  const held = join(cut.out, ENTRY);
  writeFileSync(held, readFileSync(held, "utf8").replace("export function subtotal", "export function subtotalMine"));
  const cart = join(moving, ENTRY);
  writeFileSync(cart, readFileSync(cart, "utf8").replace("export function subtotal", "export function subtotalTheirs"));
  const tax = join(moving, "apps/shop/src/tax.ts");
  writeFileSync(tax, readFileSync(tax, "utf8").replace("0.1", "0.2"));
  git(moving, ["commit", "-qam", "upstream: overlap and a clean change"]);
  const refreshed = await refreshProject(cut.out);
  assert.ok(refreshed !== null);
  assert.deepEqual(refreshed.applied.conflicts, [ENTRY]);
  assert.ok(refreshed.applied.changed.includes("apps/shop/src/tax.ts"));
  const patch = await patchProject(cut.out, { repo: moving });
  assert.ok(patch.changed.includes(ENTRY));
  assert.doesNotMatch(patch.diff, /apps\/shop\/src\/tax\.ts|0\.2/, patch.diff);
});

test("refresh keeps a file the folder deleted, and never moves the base past a file it did not write", async () => {
  const { refreshProject } = await import("../src/mergeback.js");
  const { patchProject } = await import("../src/carve.js");
  // The contributor deletes a file the repository then edits.
  const moving = join(scratch, "moving-deleted");
  git(scratch, ["clone", "-q", repo, moving]);
  const cut = await cutSlice({ repo: moving, out: join(scratch, "refresh-deleted"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  rmSync(join(cut.out, "apps/shop/src/tax.ts"));
  const tax = join(moving, "apps/shop/src/tax.ts");
  writeFileSync(tax, readFileSync(tax, "utf8").replace("0.1", "0.2"));
  git(moving, ["commit", "-qam", "upstream: tax"]);
  const refreshed = await refreshProject(cut.out);
  assert.ok(refreshed !== null);
  assert.deepEqual(refreshed.applied.conflicts, ["apps/shop/src/tax.ts"]);
  assert.equal(existsSync(join(cut.out, "apps/shop/src/tax.ts")), false);
  assert.ok((await patchProject(cut.out, { repo: moving })).deleted.includes("apps/shop/src/tax.ts"));
  // The repository stops importing a slice file and edits it: the file is
  // no longer reached, so not written; the folder still patches.
  const moving2 = join(scratch, "moving-unreached");
  git(scratch, ["clone", "-q", repo, moving2]);
  const second = await cutSlice({ repo: moving2, out: join(scratch, "refresh-unreached"), entryPoints: ["apps/shop/src/checkout.ts"], budget: { maxFiles: 40, maxDepth: 2 }, offline: true });
  const checkout = join(second.out, "apps/shop/src/checkout.ts");
  writeFileSync(checkout, `${readFileSync(checkout, "utf8")}// the contributor's note\n`);
  const cart2 = join(moving2, ENTRY);
  writeFileSync(cart2, readFileSync(cart2, "utf8").replace('import { tax } from "@/tax";\n', "const tax = (cents: number): number => Math.round(cents * 0.1);\n"));
  const tax2 = join(moving2, "apps/shop/src/tax.ts");
  writeFileSync(tax2, readFileSync(tax2, "utf8").replace("0.1", "0.3"));
  git(moving2, ["commit", "-qam", "upstream: inline tax"]);
  assert.ok((await refreshProject(second.out)) !== null);
  const patch = await patchProject(second.out, { repo: moving2 });
  assert.match(patch.diff, /the contributor's note/);
});

test("a failing test apply brings in is never recorded as the folder's baseline", async () => {
  const cut = await cutSlice({ repo, out: join(scratch, "applied-test"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true, tests: true });
  const work = join(scratch, `up-${Math.random().toString(36).slice(2)}`);
  git(scratch, ["clone", "-q", repo, work]);
  writeFileSync(join(work, "apps/shop/src/cart.test.ts"), 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { subtotal } from "./cart";\ntest("fails", () => assert.equal(subtotal([]), 1));\n');
  git(work, ["add", "-A"]);
  const applied = await applyPatch(cut.out, git(work, ["diff", "--cached"]));
  assert.ok(applied.added.includes("apps/shop/src/cart.test.ts"), JSON.stringify(applied));
  assert.ok(cut.receipt !== null);
  const copied = readReceipt(cut.receipt).record.copied ?? [];
  assert.equal(copied.find((file) => file.path === "apps/shop/src/cart.test.ts")?.applied, true);
});

test("an unedited public folder patches to nothing though a comment names a renamed package that is no dependency", async () => {
  const { patchProject } = await import("../src/carve.js");
  const doc = join(scratch, "doc-repo");
  cpSync(FIXTURE, doc, { recursive: true });
  const cartPath = join(doc, ENTRY);
  writeFileSync(cartPath, `/**\n * Example: import { client } from "@acmecorp/sdk";\n */\n${readFileSync(cartPath, "utf8")}`);
  git(doc, ["init", "-q"]);
  git(doc, ["add", "-A"]);
  git(doc, ["commit", "-q", "-m", "fixture"]);
  const cut = await cutSlice({ repo: doc, out: join(scratch, "doc-slice"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true, public: true, names: ["acmecorp"] });
  assert.doesNotMatch(readFileSync(join(cut.out, ENTRY), "utf8"), /acmecorp/);
  const patch = await patchProject(cut.out);
  assert.equal(patch.diff, "");
  assert.deepEqual(patch.refused, []);
});

test("after refresh, an import the repository added reads back as it wrote it", async () => {
  const { refreshProject } = await import("../src/mergeback.js");
  const { patchProject } = await import("../src/carve.js");
  const moving = join(scratch, "moving-rewrites");
  git(scratch, ["clone", "-q", repo, moving]);
  const cut = await cutSlice({ repo: moving, out: join(scratch, "refresh-rewrites"), entryPoints: ["apps/shop/src/checkout.ts"], budget: { maxFiles: 40, maxDepth: 2 }, offline: true });
  const tax = join(cut.out, "apps/shop/src/tax.ts");
  writeFileSync(tax, `${readFileSync(tax, "utf8")}// the contributor's note\n`);
  const checkout = join(moving, "apps/shop/src/checkout.ts");
  writeFileSync(checkout, `import { TAX_RATE } from "./tax";\n${readFileSync(checkout, "utf8")}export const rate = TAX_RATE;\n`);
  git(moving, ["commit", "-qam", "upstream: an import"]);
  const refreshed = await refreshProject(cut.out);
  assert.ok(refreshed !== null && refreshed.applied.changed.includes("apps/shop/src/checkout.ts"), JSON.stringify(refreshed?.applied));
  const patch = await patchProject(cut.out, { repo: moving });
  assert.deepEqual(patch.changed, ["apps/shop/src/tax.ts"], patch.diff);
});

test("an overlap merged by hand is taken as resolved, and the folder patches at the new HEAD", async () => {
  const { refreshProject } = await import("../src/mergeback.js");
  const { patchProject } = await import("../src/carve.js");
  const moving = join(scratch, "moving-resolved");
  git(scratch, ["clone", "-q", repo, moving]);
  const cut = await cutSlice({ repo: moving, out: join(scratch, "refresh-resolved"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  const held = join(cut.out, ENTRY);
  writeFileSync(held, readFileSync(held, "utf8").replace("export function subtotal", "export function subtotalMine"));
  const cart = join(moving, ENTRY);
  writeFileSync(cart, readFileSync(cart, "utf8").replace("export function subtotal", "export function subtotalTheirs"));
  const tax = join(moving, "apps/shop/src/tax.ts");
  writeFileSync(tax, readFileSync(tax, "utf8").replace("0.1", "0.2"));
  git(moving, ["commit", "-qam", "upstream: overlap"]);
  const first = await refreshProject(cut.out);
  assert.deepEqual(first?.applied.conflicts, [ENTRY]);
  // Merged by hand: the contributor keeps its name, and takes upstream's too.
  writeFileSync(held, readFileSync(held, "utf8").replace("export function subtotalMine", "export function subtotalMine(lines: readonly Line[]): number {\n  return subtotalTheirs(lines);\n}\n\nexport function subtotalTheirs"));
  const second = await refreshProject(cut.out, { resolved: [ENTRY] });
  assert.ok(second !== null);
  assert.deepEqual(second.applied.conflicts, []);
  const patch = await patchProject(cut.out, { repo: moving });
  assert.deepEqual(patch.changed, [ENTRY], patch.diff);
  assert.doesNotMatch(patch.diff, /0\.2/);
  writeFileSync(join(scratch, "resolved.patch"), patch.diff);
  git(moving, ["apply", "--check", join(scratch, "resolved.patch")]);
});

test("the receipt keeps the test side as the cut wrote it, never the code", async () => {
  const sided = join(scratch, "sided-repo");
  cpSync(FIXTURE, sided, { recursive: true });
  writeFileSync(join(sided, "apps/shop/src/fakes.ts"), "export const expectTotal = (got: number, want: number): void => {\n  if (got !== want) throw new Error(`${got}`);\n};\n");
  writeFileSync(join(sided, "apps/shop/src/cart.test.ts"), 'import { test } from "node:test";\nimport { subtotal } from "./cart";\nimport { expectTotal } from "./fakes";\ntest("subtotal", () => expectTotal(subtotal([]), 0));\n');
  git(sided, ["init", "-q"]);
  git(sided, ["add", "-A"]);
  git(sided, ["commit", "-q", "-m", "fixture"]);
  const cut = await cutSlice({ repo: sided, out: join(scratch, "sided-slice"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true, tests: true });
  assert.ok(cut.receipt !== null);
  const kept = Object.keys(readReceipt(cut.receipt).testText ?? {}).sort();
  assert.deepEqual(kept, ["apps/shop/src/cart.test.ts", "apps/shop/src/fakes.ts"]);
});

test("after an overlap moves a file alone, the folder still patches once the repository moves again", async () => {
  const { refreshProject } = await import("../src/mergeback.js");
  const { patchProject } = await import("../src/carve.js");
  const moving = join(scratch, "moving-bases");
  git(scratch, ["clone", "-q", repo, moving]);
  const cut = await cutSlice({ repo: moving, out: join(scratch, "refresh-bases"), entryPoints: [ENTRY], budget: { maxFiles: 40, maxDepth: 1 }, offline: true });
  const held = join(cut.out, ENTRY);
  writeFileSync(held, readFileSync(held, "utf8").replace("export function subtotal", "export function subtotalMine"));
  const cart = join(moving, ENTRY);
  const tax = join(moving, "apps/shop/src/tax.ts");
  writeFileSync(cart, readFileSync(cart, "utf8").replace("export function subtotal", "export function subtotalTheirs"));
  writeFileSync(tax, readFileSync(tax, "utf8").replace("0.1", "0.2"));
  git(moving, ["commit", "-qam", "upstream C1"]);
  assert.deepEqual((await refreshProject(cut.out))?.applied.conflicts, [ENTRY]);
  writeFileSync(tax, readFileSync(tax, "utf8").replace("0.2", "0.3"));
  git(moving, ["commit", "-qam", "upstream C2"]);
  // Not refused as forged: tax.ts's base is its own.
  const patch = await patchProject(cut.out, { repo: moving });
  assert.ok(patch.changed.includes(ENTRY), patch.diff);
  const again = await refreshProject(cut.out);
  assert.ok(again !== null);
  assert.match(readFileSync(join(cut.out, "apps/shop/src/tax.ts"), "utf8"), /0\.3/);
  // Merged by hand, then resolved: the folder patches at HEAD.
  writeFileSync(held, readFileSync(held, "utf8").replace(/export function subtotalMine/, "export function subtotalTheirs"));
  await refreshProject(cut.out, { resolved: [ENTRY] });
  const last = await patchProject(cut.out, { repo: moving });
  writeFileSync(join(scratch, "bases.patch"), last.diff);
  if (last.diff !== "") git(moving, ["apply", "--check", join(scratch, "bases.patch")]);
});
