#!/usr/bin/env node
// E8d (PLAN-benchmark.md, Phase 8): is a plan named from the spec alone a
// usable scope? For each E7 planning session, the planned cut (re-planned
// with the frozen CLI in the case's tree at B) against the commit's real
// package change; and `outsideScope` writes per arm across E6b and E7.
// Writes results/e8-scope.json. No model, no network.
//
//   node experiments/e8-scope.mjs [--tag e6b] [--cli ad8b99c8bd40]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const TAG = opt("--tag", "e6b");
const CLI = opt("--cli", "ad8b99c8bd40");
const RESULTS = join(HERE, "results", `bench-${TAG}.jsonl`);
const TEMPLATES = join(HERE, "work", "bench", `templates-${TAG}`);
const BIN = join(HERE, "work", "cli", CLI, "dist", "src", "cli.js");
const CLONE = join(HERE, "work", "clones", `sandbox-factory-${TAG}-base`, "sandbox-factory");
const CASES = JSON.parse(readFileSync(join(HERE, "e5-cases.json"), "utf8")).cases;

const rows = readFileSync(RESULTS, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const git = (list) => execFileSync("git", ["-C", CLONE, ...list], { encoding: "utf8" });

/** The commit's change inside its package: status and lines per file. */
function changeOf(item) {
  const status = new Map(
    git(["diff-tree", "--no-commit-id", "-r", "--name-status", item.commit, "--", item.package])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"))
      .map(([s, a, b]) => [b ?? a, s[0]]),
  );
  let lines = 0;
  for (const line of git(["diff-tree", "--no-commit-id", "-r", "--numstat", item.commit, "--", item.package]).trim().split("\n").filter(Boolean)) {
    const [added, deleted] = line.split("\t");
    lines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  const files = [...status.keys()];
  const isTest = (path) => /(^|\/)test\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
  return {
    files,
    lines,
    code: files.filter((path) => !isTest(path) && /\.[cm]?[jt]sx?$/.test(path)),
    modified: files.filter((path) => status.get(path) !== "A"),
    added: files.filter((path) => status.get(path) === "A"),
  };
}

function plan(tree, entries) {
  const out = execFileSync("node", [BIN, "plan", ...entries, "--repo", tree, "--depth", "1", "--max-files", "200", "--with-tests", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

function spearman(xs, ys) {
  const rank = (list) => {
    const sorted = list.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(list.length);
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[sorted[k][1]] = r;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

const plans = [];
const changes = new Map();
for (const row of rows.filter((r) => r.arm === "slice-plan")) {
  const item = CASES.find((c) => c.slug === row.slug);
  const tree = join(TEMPLATES, row.slug, "full");
  if (!item || !existsSync(tree)) continue;
  if (!changes.has(row.slug)) changes.set(row.slug, changeOf(item));
  const change = changes.get(row.slug);
  const entries = row.plan?.entries ?? [];
  let included = [];
  let error = null;
  try {
    included = plan(tree, entries).included;
  } catch (e) {
    error = String(e.message ?? e).slice(0, 200);
  }
  const held = new Set(included);
  const folders = new Set(included.map((path) => posix.dirname(path)));
  const modifiedCode = change.code.filter((path) => change.modified.includes(path));
  const addedCode = change.code.filter((path) => change.added.includes(path));
  const seamTemplate = join(TEMPLATES, CLI, row.slug, "slice-seam.json");
  const seamFiles = existsSync(seamTemplate) ? JSON.parse(readFileSync(seamTemplate, "utf8")).files : null;
  plans.push({
    slug: row.slug,
    run: row.run,
    verdict: row.verdict,
    entries,
    planned: included.length,
    setupFiles: row.setup?.files ?? null,
    seamFiles,
    changedFiles: change.files.length,
    changedCode: change.code.length,
    changedLines: change.lines,
    modifiedCodeHeld: modifiedCode.filter((path) => held.has(path)).length,
    modifiedCode: modifiedCode.length,
    addedCodeReached: addedCode.filter((path) => folders.has(posix.dirname(path))).length,
    addedCode: addedCode.length,
    coversChange: modifiedCode.every((path) => held.has(path)) && addedCode.every((path) => folders.has(posix.dirname(path))),
    error,
  });
}

const scope = {};
for (const row of rows) {
  const arm = row.arm;
  scope[arm] ??= { rows: 0, withOutsideWrites: 0, files: 0 };
  scope[arm].rows++;
  if ((row.outsideScope ?? []).length > 0) {
    scope[arm].withOutsideWrites++;
    scope[arm].files += row.outsideScope.length;
  }
}

const ok = plans.filter((p) => !p.error);
const summary = {
  tag: TAG,
  cli: CLI,
  plans: plans.length,
  replanned: ok.length,
  coversChange: ok.filter((p) => p.coversChange).length,
  modifiedCodeHeld: { held: ok.reduce((s, p) => s + p.modifiedCodeHeld, 0), of: ok.reduce((s, p) => s + p.modifiedCode, 0) },
  addedCodeReached: { reached: ok.reduce((s, p) => s + p.addedCodeReached, 0), of: ok.reduce((s, p) => s + p.addedCode, 0) },
  medianPlanned: median(ok.map((p) => p.planned)),
  medianSeam: median(ok.filter((p) => p.seamFiles != null).map((p) => p.seamFiles)),
  spearmanPlannedVsLines: spearman(ok.map((p) => p.planned), ok.map((p) => p.changedLines)),
  spearmanPlannedVsFiles: spearman(ok.map((p) => p.planned), ok.map((p) => p.changedFiles)),
  spearmanSeamVsLines: spearman(ok.filter((p) => p.seamFiles != null).map((p) => p.seamFiles), ok.filter((p) => p.seamFiles != null).map((p) => p.changedLines)),
  acceptedWhenCovers: { accepted: ok.filter((p) => p.coversChange && p.verdict === "accepted").length, of: ok.filter((p) => p.coversChange).length },
  acceptedWhenNot: { accepted: ok.filter((p) => !p.coversChange && p.verdict === "accepted").length, of: ok.filter((p) => !p.coversChange).length },
  outsideScope: scope,
};
writeFileSync(join(HERE, "results", "e8-scope.json"), `${JSON.stringify({ summary, plans }, null, 1)}\n`);

const pad = (s, n) => String(s ?? "-").padStart(n);
console.log(`E8d: ${plans.length} plans, ${ok.length} re-planned with CLI ${CLI}\n`);
console.log("case              | run | planned | seam | chg files | chg lines | mod held | add reached | covers | verdict");
for (const p of plans) {
  console.log(`${p.slug.padEnd(17)} | ${pad(p.run, 3)} | ${pad(p.planned, 7)} | ${pad(p.seamFiles, 4)} | ${pad(p.changedFiles, 9)} | ${pad(p.changedLines, 9)} | ${pad(`${p.modifiedCodeHeld}/${p.modifiedCode}`, 8)} | ${pad(`${p.addedCodeReached}/${p.addedCode}`, 11)} | ${p.coversChange ? "yes" : "no "}    | ${p.verdict}${p.error ? ` (${p.error})` : ""}`);
}
console.log(`\nplans whose cut holds every changed file: ${summary.coversChange} of ${ok.length}`);
console.log(`modified code files held: ${summary.modifiedCodeHeld.held} of ${summary.modifiedCodeHeld.of}; added code files whose folder is reached: ${summary.addedCodeReached.reached} of ${summary.addedCodeReached.of}`);
console.log(`median planned files ${summary.medianPlanned}, median seam files ${summary.medianSeam}`);
console.log(`Spearman planned files vs changed lines: ${summary.spearmanPlannedVsLines?.toFixed(2)}; vs changed files: ${summary.spearmanPlannedVsFiles?.toFixed(2)}; seam files vs changed lines: ${summary.spearmanSeamVsLines?.toFixed(2)}`);
console.log(`accepted when the plan covers the change: ${summary.acceptedWhenCovers.accepted} of ${summary.acceptedWhenCovers.of}; when it does not: ${summary.acceptedWhenNot.accepted} of ${summary.acceptedWhenNot.of}`);
console.log(`outside-scope writes by arm: ${Object.entries(scope).map(([arm, s]) => `${arm} ${s.withOutsideWrites}/${s.rows} rows (${s.files} files)`).join("; ")}`);
