#!/usr/bin/env node
// E5: replaying real commits through a slice (PLAN-benchmark.md, Phase 2).
// A commit is an agent whose answer is known. Per case, at the commit's
// parent B:
//
//   1. cut the entries at B (--with-tests --depth 1 --max-files 200) and check it;
//   2. carveout apply the whole commit into a copy of the slice, --stubs;
//      what lands outside the slice is the coverage measurement;
//   3. check that copy: the in-slice verdict;
//   4. carveout patch it: the round trip is every applied path, patched
//      onto B, byte-identical to the commit;
//   5. carveout merge into a clean clone at B, lay the commit's test files
//      of the package over it, build the package's dependencies and run its
//      tests without the coverage gate (functional) and as written (gate).
//
// The oracle is the same judge on B plus the commit's whole package change.
//
//   node experiments/e5-replay.mjs [slug...] [--mode seam|diff] [--force]
//   node experiments/e5-replay.mjs --report
//
// --mode seam (default) cuts from the case's seam, diff from the files the
// commit changed in its package outside tests. One line per case and mode
// in results/e5.jsonl, newest wins; a case with a line is skipped unless
// --force.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  changesOf,
  log as logAs,
  judge,
  overlay,
  packageChange,
  seamEntries,
  show,
  sliceTests,
  target,
  verdictOf,
} from "./judge.mjs";
import { HERE, WORK, carveout, checkout, cloneOf, frozenCli, git } from "./lib.mjs";

const CASES = JSON.parse(readFileSync(join(HERE, "e5-cases.json"), "utf8")).cases;
const RESULTS = join(HERE, "results", "e5.jsonl");
const E5 = join(WORK, "e5");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const mode = option("--mode", "seam");
const slugs = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--mode");

const log = (line) => logAs("e5", line);

async function replay(cli, item) {
  const source = cloneOf("sandbox-factory", "e5-base");
  const base = git(source, ["rev-parse", `${item.commit}^`]).trim();
  const { changes, tests, code } = packageChange(source, item);
  // At B, so a file the commit adds is no entry.
  const entries = mode === "diff" ? code.filter((path) => changes.get(path) !== "A") : seamEntries(source, base, item.seam);
  const dir = join(E5, item.slug, mode);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const line = { slug: item.slug, mode, commit: item.commit, base, cli: cli.id, entries };

  // 1. The cut at B.
  checkout(source, base);
  const present = entries.filter((path) => existsSync(join(source, path)));
  line.entries = present;
  if (present.length === 0) return { ...line, verdict: "no_entries" };
  const slice = join(dir, "slice");
  const cut = carveout(cli, ["cut", ...present, "--repo", source, "--depth", "1", "--max-files", "200", "--with-tests", "--out", slice]);
  line.cut = { code: cut.code, ms: cut.ms };
  if (cut.code !== 0 && cut.code !== 2) return { ...line, verdict: "cut_failed", output: cut.stderr.slice(-3000) };
  const record = JSON.parse(readFileSync(join(slice, "carveout.json"), "utf8"));
  line.cut.files = record.manifest.included.length;
  line.cut.stubs = record.dependencies.filter((d) => d.kind === "module").length;
  line.cut.blockers = record.blockers.map((b) => b.code);
  log(`${item.slug}/${mode}: cut ${line.cut.files} files, checking`);
  const baseline = sliceTests(slice);
  line.baseline = { ...baseline, tests: undefined, names: Object.keys(baseline.tests ?? {}).length };

  // 2. The commit, applied in a copy.
  const grown = join(dir, "grown");
  cpSync(slice, grown, { recursive: true });
  const patchFile = join(dir, "commit.patch");
  writeFileSync(patchFile, git(source, ["diff", "--binary", "--full-index", "--no-renames", base, item.commit]));
  const applied = carveout(cli, ["apply", grown, patchFile, "--stubs", "--json"]);
  let apply;
  try {
    apply = JSON.parse(applied.stdout);
  } catch {
    return { ...line, verdict: "apply_failed", output: `${applied.stdout}${applied.stderr}`.slice(-3000) };
  }
  const touched = new Set([...apply.changed, ...apply.added, ...apply.deleted]);
  line.apply = {
    changed: apply.changed.length,
    added: apply.added.length,
    deleted: apply.deleted.length,
    stubs: apply.stubs.map((stub) => `${stub.path}: ${stub.detail}`),
    outsideCode: code.filter((path) => !touched.has(path)),
    testsInSlice: tests.filter((path) => touched.has(path)),
    testsOutside: tests.filter((path) => !touched.has(path)),
  };

  // 3. In the slice.
  log(`${item.slug}/${mode}: applied ${touched.size} paths, checking the grown slice`);
  const after = sliceTests(grown);
  line.inSlice = { ...verdictOf(baseline, after), step: after.step, pass: after.pass, fail: after.fail, ...(after.step === "test" ? {} : { output: after.output }) };

  // 4. Back out.
  const patched = carveout(cli, ["patch", grown, "--json", "--output", join(dir, "slice.patch")]);
  let patch;
  try {
    patch = JSON.parse(patched.stdout);
  } catch {
    return { ...line, verdict: "patch_failed", output: `${patched.stdout}${patched.stderr}`.slice(-3000) };
  }
  line.patch = {
    code: patched.code,
    changed: patch.changed.length,
    added: patch.added.length,
    deleted: patch.deleted.length,
    boundary: patch.boundary.map((edit) => edit.path),
    sliceOnly: patch.sliceOnly,
    crossPackage: patch.crossPackage,
  };

  // 5. Merged, at B.
  const into = target(base);
  const merged = carveout(cli, ["merge", grown, "--into", into, "--json"]);
  let merge;
  try {
    merge = JSON.parse(merged.stdout);
  } catch {
    return { ...line, verdict: "merge_failed", output: `${merged.stdout}${merged.stderr}`.slice(-3000) };
  }
  line.merge = merge.steps.map((step) => ({ step: step.step, ok: step.ok, ...(step.ok ? {} : { output: step.output.slice(-2000) }) }));
  if (!merge.ok) return { ...line, verdict: "merge_failed" };
  const wrong = [];
  for (const path of touched) {
    const want = show(source, item.commit, path);
    const have = existsSync(join(into, path)) ? readFileSync(join(into, path)) : null;
    if (want === null ? have !== null : have === null || !want.equals(have)) wrong.push(path);
  }
  const patchedPaths = new Set([
    ...patch.changed,
    ...patch.added,
    ...patch.deleted,
  ]);
  line.roundTrip = {
    ok: wrong.length === 0 && [...touched].every((path) => patchedPaths.has(path)) && patchedPaths.size === touched.size,
    differ: wrong,
    notPatched: [...touched].filter((path) => !patchedPaths.has(path)),
    extra: [...patchedPaths].filter((path) => !touched.has(path)),
  };
  overlay(into, source, item.commit, changes, tests.filter((path) => !touched.has(path)));
  log(`${item.slug}/${mode}: merged, judging`);
  line.postMerge = judge(into, item.package);
  line.verdict = "ran";
  return line;
}

/** B plus the commit's whole package change, judged the same way. */
function oracle(item) {
  const source = cloneOf("sandbox-factory", "e5-base");
  const base = git(source, ["rev-parse", `${item.commit}^`]).trim();
  const changes = changesOf(source, item.commit);
  const into = target(base);
  const atBase = judge(into, item.package);
  overlay(into, source, item.commit, changes, [...changes.keys()].filter((path) => path.startsWith(`${item.package}/`)));
  return { atBase: { functional: atBase.functional, gate: atBase.gate }, atCommit: judge(into, item.package) };
}

function results() {
  const out = new Map();
  if (!existsSync(RESULTS)) return out;
  for (const text of readFileSync(RESULTS, "utf8").split("\n").filter(Boolean)) {
    const item = JSON.parse(text);
    out.set(`${item.slug}/${item.mode}`, item);
  }
  return out;
}

function report() {
  const rows = [...results().values()].filter((row) => row.mode !== "oracle");
  const oracles = new Map([...results().values()].filter((row) => row.mode === "oracle").map((row) => [row.slug, row]));
  const yes = (value) => (value === undefined ? "–" : value ? "yes" : "no");
  process.stdout.write("| case | mode | files | outside code | tests in slice | in slice | round trip | merged functional | merged gate | oracle |\n|---|---|---:|---|---|---|---|---|---|---|\n");
  for (const row of rows.sort((a, b) => `${a.mode}${a.slug}`.localeCompare(`${b.mode}${b.slug}`))) {
    const oracle = oracles.get(row.slug);
    process.stdout.write(
      `| ${row.slug} | ${row.mode} | ${row.cut?.files ?? "–"} | ${row.apply?.outsideCode.length ?? "–"} | ${row.apply === undefined ? "–" : `${row.apply.testsInSlice.length}/${row.apply.testsInSlice.length + row.apply.testsOutside.length}`} | ${yes(row.inSlice?.ok)} | ${yes(row.roundTrip?.ok)} | ${yes(row.postMerge?.functional?.ok)} | ${yes(row.postMerge?.gate?.ok)} | ${yes(oracle?.atCommit?.functional?.ok)} |${row.verdict === "ran" ? "" : ` ${row.verdict}`}\n`,
    );
  }
}

if (flag("--report")) report();
else {
  const cli = frozenCli();
  const done = results();
  mkdirSync(dirname(RESULTS), { recursive: true });
  for (const item of CASES.filter((c) => slugs.length === 0 || slugs.includes(c.slug))) {
    if (mode === "oracle") {
      if (done.has(`${item.slug}/oracle`) && !flag("--force")) continue;
      log(`${item.slug}: oracle`);
      const line = { slug: item.slug, mode: "oracle", commit: item.commit, ...oracle(item), at: new Date().toISOString() };
      writeFileSync(RESULTS, `${JSON.stringify(line)}\n`, { flag: "a" });
      continue;
    }
    if (done.has(`${item.slug}/${mode}`) && !flag("--force")) continue;
    log(`${item.slug}/${mode}`);
    let line;
    try {
      line = await replay(cli, item);
    } catch (error) {
      line = { slug: item.slug, mode, verdict: "error", output: String(error?.stack ?? error).slice(-3000) };
    }
    writeFileSync(RESULTS, `${JSON.stringify({ ...line, at: new Date().toISOString() })}\n`, { flag: "a" });
    log(`${item.slug}/${mode}: ${line.verdict}${line.roundTrip ? ` round trip ${line.roundTrip.ok}` : ""}`);
  }
}
