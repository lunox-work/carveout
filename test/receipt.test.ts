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
  assert.equal(trustedCut(bare.out).receipt, null);
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
