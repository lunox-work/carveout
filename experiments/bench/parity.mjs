#!/usr/bin/env node
// Parity: does the slice say what the repository says? No model runs. Each
// change E6 already judged in the repository is replayed into a slice cut
// by the current CLI, and the slice's own verdict, `npm run build` then
// `npm test` as an agent reads them, is set beside the repository's.
//
//   node experiments/bench/parity.mjs [slug...] [--arms slice-seam,slice-diff]
//                                     [--from slice,full,commit] [--concurrency 2]
//   node experiments/bench/parity.mjs --report [--cli <dist hash>]
//
// What is replayed, each as a patch at B with the hidden suite laid over
// (and without it, for the agent's view; see inSlice):
//   slice   every slice run in results/bench.jsonl, into its own arm
//   full    every full run, into each slice arm: changes made without a slice
//   commit  the case's real commit, into each slice arm: a known-good change
// The repository's verdict is the one bench.jsonl recorded (accepted, or
// not); a commit's is judged here once and kept in results/parity-repo.jsonl.
//
// The bar: no change the slice passes and the repository fails. A change
// the slice fails and the repository passes costs an agent time, not
// correctness, and is counted beside it. One line per replay in
// results/parity.jsonl, keyed by the CLI build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HERE, WORK, carveout, cloneOf, frozenCli, git } from "../lib.mjs";
import { counts, install, judge, log, shell, testResults } from "../judge.mjs";
import { CASES, baseOf, hiddenOf, source, template, toolchainOf } from "./cases.mjs";
import { WORK_ROOT, discard, freeMemoryPercent } from "./lib.mjs";

const RESULTS = process.env.BENCH_RESULTS ?? join(HERE, "results", "bench.jsonl");
const PARITY = process.env.PARITY_RESULTS ?? join(HERE, "results", "parity.jsonl");
const REPO_VERDICTS = process.env.PARITY_REPO_RESULTS ?? join(HERE, "results", "parity-repo.jsonl");
const RUNS = process.env.BENCH_RUNS ?? join(WORK, "bench", "runs");
const PATCHES = join(WORK, "bench", `${process.env.BENCH_TAG ?? "parity"}-patches`);
const SLICE_ARMS = ["slice-seam", "slice-diff"];
// Earlier replay rows did not detect a partially applied change.
const REPLAY_VERSION = 2;
// Its own clones and templates, beside a benchmark that may be running.
process.env.BENCH_TAG ??= "parity";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const valued = new Set(["--arms", "--from", "--concurrency", "--cli"]);
const slugs = args.filter((arg, i) => !arg.startsWith("--") && !valued.has(args[i - 1]));
const arms = option("--arms", SLICE_ARMS.join(",")).split(",");
const from = option("--from", "slice,full,commit").split(",");
const concurrency = Number(option("--concurrency", "2"));
const MIN_FREE = Number(process.env.CARVEOUT_BENCH_MIN_FREE ?? 30);

const lines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const append = (path, line) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(line)}\n`, { flag: "a" });
};
const accepted = (judged) => Boolean(judged.deps?.ok && judged.functional?.ok && judged.gate?.ok && judged.importers?.ok);

/** A clean clone at B with the repository installed. */
function cleanAt(base) {
  const into = cloneOf("sandbox-factory", `${process.env.BENCH_TAG}-target`);
  git(into, ["checkout", "-q", "-f", "--detach", base]);
  git(into, ["clean", "-q", "-fdx", "-e", "node_modules", "-e", ".e5-lock"]);
  install(into, git(into, ["rev-parse", `${base}:package-lock.json`]).trim());
  return into;
}

/** `patch` (a diff at B) with the hidden suite over it, as one patch at B; null when it does not apply. */
function judgedPatch(item, base, patch, out) {
  if (existsSync(out)) return out;
  const into = cleanAt(base);
  if (patch !== null) {
    const applied = shell(into, `git apply --3way --whitespace=nowarn '${patch}'`);
    if (!applied.ok) return null;
  }
  for (const hidden of hiddenOf(item)) {
    mkdirSync(dirname(join(into, hidden.path)), { recursive: true });
    writeFileSync(join(into, hidden.path), readFileSync(hidden.from));
  }
  git(into, ["add", "-A"]);
  // The dependency-install cache marker is harness state, not a change.
  git(into, ["reset", "-q", "--", ".e5-lock"]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, git(into, ["diff", "--cached", "--binary", "--full-index", "--no-renames", base]));
  git(into, ["reset", "-q"]);
  return out;
}

/** The real commit as a diff at B. */
function commitDiff(item, base) {
  const diff = join(PATCHES, item.slug, "commit-scoped-v2.diff");
  if (existsSync(diff)) return diff;
  mkdirSync(dirname(diff), { recursive: true });
  // Some commits span many unrelated features. Use the same allowed code
  // and package test paths that the agent is permitted to change.
  writeFileSync(diff, git(source(), ["diff", "--binary", "--full-index", "--no-renames", base, item.commit, "--", ...toolchainOf(item).allowedPaths, `${item.package}/test`]));
  return diff;
}

/** The real commit's verdict in the repository, judged once. */
function commitVerdict(item, base) {
  const known = lines(REPO_VERDICTS).find((line) => line.slug === item.slug && line.commit === item.commit && line.scopeVersion === 2);
  if (known !== undefined) return known.accepted;
  const diff = commitDiff(item, base);
  const into = cleanAt(base);
  const applied = shell(into, `git apply --whitespace=nowarn '${diff}'`);
  if (!applied.ok) throw new Error(`${item.slug}: the commit does not apply at B`);
  for (const hidden of hiddenOf(item)) {
    mkdirSync(dirname(join(into, hidden.path)), { recursive: true });
    writeFileSync(join(into, hidden.path), readFileSync(hidden.from));
  }
  const judged = judge(into, item.package, { importers: true });
  delete judged.functional?.tests;
  append(REPO_VERDICTS, { slug: item.slug, commit: item.commit, scopeVersion: 2, accepted: accepted(judged), judged, at: new Date().toISOString() });
  return accepted(judged);
}

/** Old judged patches accidentally included the harness's install marker. */
function cleanJudgedPatch(patch, out) {
  if (existsSync(out)) return out;
  mkdirSync(dirname(out), { recursive: true });
  const sections = readFileSync(patch, "utf8").split(/(?=^diff --git )/m);
  writeFileSync(out, sections.filter((section) => !section.startsWith("diff --git a/.e5-lock b/.e5-lock\n")).join(""));
  return out;
}

/** What to replay: one entry per change and slice arm. */
function plan(cli) {
  const out = [];
  const bench = lines(RESULTS).filter((row) => row.cli !== undefined);
  for (const item of CASES.filter((c) => slugs.length === 0 || slugs.includes(c.slug))) {
    const base = baseOf(item);
    for (const arm of arms) {
      if (from.includes("slice"))
        for (const row of bench.filter((r) => r.slug === item.slug && r.arm === arm && ["accepted", "functional", "rejected"].includes(r.verdict))) {
          const patch = join(RUNS, item.slug, `${arm}-${row.model}`, String(row.run), "judged.patch");
          const clean = join(PATCHES, item.slug, `${arm}-${row.model}-${row.run}-v2.patch`);
          out.push({ item, arm, base, change: `slice ${row.model} ${row.run}`, patch: () => existsSync(patch) ? cleanJudgedPatch(patch, clean) : null, repo: () => row.verdict === "accepted", repoVerdict: row.verdict });
        }
      if (from.includes("full"))
        for (const row of bench.filter((r) => r.slug === item.slug && r.arm === "full" && ["accepted", "functional", "rejected"].includes(r.verdict))) {
          const change = join(RUNS, item.slug, `full-${row.model}`, String(row.run), "change.patch");
          const at = join(PATCHES, item.slug, `full-${row.model}-${row.run}-v2.patch`);
          out.push({ item, arm, base, change: `full ${row.model} ${row.run}`, patch: () => existsSync(change) ? judgedPatch(item, base, change, at) : null, repo: () => row.verdict === "accepted", repoVerdict: row.verdict });
        }
      if (from.includes("commit")) {
        const at = join(PATCHES, item.slug, "commit-scoped-v2.patch");
        out.push({
          item,
          arm,
          base,
          change: "commit",
          patch: () => {
            commitVerdict(item, base);
            return judgedPatch(item, base, commitDiff(item, base), at);
          },
          repo: () => commitVerdict(item, base),
        });
      }
    }
  }
  const done = new Set(lines(PARITY).filter((line) => line.cli === cli.id && line.replayVersion === REPLAY_VERSION).map((line) => `${line.slug}/${line.arm}/${line.change}`));
  return out.filter((entry) => !done.has(`${entry.item.slug}/${entry.arm}/${entry.change}`));
}

/** `patch` without the hidden suite's files: the change as the agent left it. */
function withoutHidden(item, patch) {
  const out = patch.replace(/\.patch$/, ".change.patch");
  if (existsSync(out)) return out;
  const hidden = `${toolchainOf(item).hiddenDir}/`;
  const sections = readFileSync(patch, "utf8").split(/(?=^diff --git )/m);
  writeFileSync(out, sections.filter((section) => !section.startsWith(`diff --git a/${hidden}`)).join(""));
  return out;
}

/** A copy of the template with `patch` applied, built and tested; the copy is removed. */
function tried(cli, prepared, patch) {
  const work = mkdtempSync(join(WORK_ROOT, "parity-"));
  try {
    execFileSync("cp", ["-c", "-R", `${prepared.dir}/.`, work]);
    if (readFileSync(patch, "utf8").trim() !== "") {
      const brought = carveout(cli, ["apply", work, patch, "--stubs", "--json"]);
      if (brought.code !== 0) return { ok: false, step: "apply", output: `${brought.stdout}${brought.stderr}`.slice(-1500) };
      // apply can succeed while leaving files outside the slice, including
      // hidden tests. A partial change cannot establish verdict parity.
      const applied = JSON.parse(brought.stdout);
      if (applied.outside.length > 0) return { ok: false, step: "outside", outside: applied.outside };
    }
    const install = shell(work, existsSync(join(work, "package-lock.json")) ? "npm ci --no-audit --no-fund --loglevel=error" : "npm install --no-audit --no-fund --loglevel=error");
    if (!install.ok) return { ok: false, step: "install", output: install.output.slice(-1500) };
    const build = shell(work, "npm run build --silent");
    if (!build.ok) return { ok: false, step: "build", output: build.output.slice(-1500) };
    const test = shell(work, "node carveout/test.js");
    return { ok: test.ok, step: "test", ...counts(test.full), tests: testResults(test.full), ...(test.ok ? {} : { output: test.output.slice(-1500) }) };
  } finally {
    discard(work);
  }
}

/**
 * The slice's verdict, as the repository's judge splits it: the change
 * alone passes the slice's `npm test` (what the agent sees, gate and all),
 * and with the hidden suite laid over, the suite passes and nothing that
 * passed at the cut fails, read by test name as the repository's
 * functional run reads them.
 */
function inSlice(cli, item, prepared, patch) {
  const agent = tried(cli, prepared, withoutHidden(item, patch));
  delete agent.tests;
  if (agent.step === "outside") return { ok: false, step: "outside", outside: agent.outside };
  if (!agent.ok) return { ok: false, step: `agent ${agent.step}`, agent };
  const hidden = tried(cli, prepared, patch);
  if (hidden.step === "outside") return { ok: false, step: "outside", outside: hidden.outside };
  if (hidden.step !== "test") return { ok: false, step: `hidden ${hidden.step}`, agent, hidden };
  const before = prepared.baseline.tests ?? {};
  const now = hidden.tests ?? {};
  const regressions = Object.keys(before).filter((name) => before[name] && now[name] === false);
  const addedFailing = Object.keys(now).filter((name) => !(name in before) && !now[name]);
  delete hidden.tests;
  const ok = regressions.length === 0 && addedFailing.length === 0;
  return { ok, step: ok ? "pass" : "hidden suite", agent, hidden: { ...hidden, regressions, addedFailing } };
}

async function main() {
  const cli = frozenCli();
  const tasks = plan(cli);
  log("parity", `${tasks.length} replays on ${cli.id}`);
  // Templates and the patches made in the shared clones first, one at a
  // time: each checks a clone out.
  const unusable = new Map();
  const templates = new Map();
  for (const task of tasks) {
    const key = `${task.item.slug}/${task.arm}`;
    if (templates.has(key) || unusable.has(key)) continue;
    try {
      templates.set(key, template(cli, task.item, task.arm));
    } catch (error) {
      unusable.set(key, String(error?.message ?? error).slice(0, 1500));
      log("parity", `${key}: no template: ${unusable.get(key).split("\n").slice(0, 2).join(" ")}`);
    }
  }
  for (const task of tasks) task.made = task.patch();
  const next = async () => {
    while (tasks.length > 0) {
      const task = tasks.shift();
      const key = `${task.item.slug}/${task.arm}`;
      while (freeMemoryPercent() < MIN_FREE) await new Promise((resolve) => setTimeout(resolve, 5_000));
      const prepared = templates.get(key);
      const line = { slug: task.item.slug, arm: task.arm, change: task.change, cli: cli.id, replayVersion: REPLAY_VERSION };
      if (prepared === undefined) {
        append(PARITY, { ...line, slice: { ok: false, step: "template", output: unusable.get(key) }, repo: task.repo(), at: new Date().toISOString() });
        continue;
      }
      const patch = task.made;
      const slice = patch === null ? { ok: false, step: "no patch" } : inSlice(cli, task.item, prepared, patch);
      const repo = task.repo();
      append(PARITY, { ...line, repo, ...(task.repoVerdict === undefined ? {} : { repoVerdict: task.repoVerdict }), slice, at: new Date().toISOString() });
      log("parity", `${key} ${task.change}: slice ${slice.ok ? "pass" : `fail (${slice.step})`}, repository ${repo ? "pass" : "fail"}${slice.ok && !repo ? "  <-- slice passed, repository failed" : ""}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, next));
}

function report() {
  const all = lines(PARITY).filter((line) => line.replayVersion === REPLAY_VERSION);
  const cli = option("--cli", null);
  const builds = [...new Set(all.map((line) => line.cli))];
  const id = cli === null ? builds.at(-1) : builds.find((b) => b.includes(cli));
  const rows = all.filter((line) => line.cli === id);
  process.stdout.write(`CLI ${id}: ${rows.length} replays\n\n`);
  process.stdout.write("| arm | change | n | both pass | both fail | slice pass, repo fail | slice fail, repo pass | excluded |\n|---|---|---:|---:|---:|---:|---:|---:|\n");
  const kind = (row) => row.change.split(" ")[0];
  for (const arm of SLICE_ARMS)
    for (const k of ["slice", "full", "commit"]) {
      const group = rows.filter((row) => row.arm === arm && kind(row) === k);
      if (group.length === 0) continue;
      const usable = group.filter((row) => !["template", "outside", "no patch"].includes(row.slice.step));
      const n = (s, r) => usable.filter((row) => row.slice.ok === s && row.repo === r).length;
      process.stdout.write(`| ${arm} | ${k} | ${group.length} | ${n(true, true)} | ${n(false, false)} | ${n(true, false)} | ${n(false, true)} | ${group.length - usable.length} |\n`);
    }
  const danger = rows.filter((row) => row.slice.ok && !row.repo);
  const cost = rows.filter((row) => !row.slice.ok && row.repo && !["template", "outside", "no patch"].includes(row.slice.step));
  process.stdout.write(`\nSlice passed, repository failed (${danger.length}):\n`);
  for (const row of danger) process.stdout.write(`- ${row.slug}/${row.arm} ${row.change}: repository ${row.repoVerdict ?? "rejected"}\n`);
  process.stdout.write(`\nSlice failed, repository passed (${cost.length}):\n`);
  for (const row of cost) process.stdout.write(`- ${row.slug}/${row.arm} ${row.change}: ${row.slice.step}: ${(row.slice.output ?? "").split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 240)}\n`);
  const templates = [...new Set(rows.filter((row) => row.slice.step === "template").map((row) => `${row.slug}/${row.arm}`))];
  if (templates.length > 0) process.stdout.write(`\nNo template: ${templates.join(", ")}\n`);
  const outside = rows.filter((row) => row.slice.step === "outside");
  if (outside.length > 0) process.stdout.write(`\nIncomplete changes excluded: ${outside.length}\n`);
}

if (args.includes("--report")) report();
else await main();
