#!/usr/bin/env node
// The benchmark (PLAN-benchmark.md, Phases 3-5): the same ticket worked in
// the whole repository and in a carveout slice, judged the same way.
//
//   node experiments/bench/run.mjs [slug...] [--arms full,slice-seam] [--runs 2]
//                                  [--model claude-haiku-5-5] [--concurrency 2]
//   node experiments/bench/run.mjs --report
//
// Arms:
//   full        the repository at the commit's parent B (git archive, one
//               commit, no history), installed, its dependencies built
//   slice-seam  a cut at B from the case's seam (judge.mjs seamEntries)
//   slice-diff  a cut at B from the files the commit changed: a ceiling
//
// Every workdir is prepared off the clock, once per case and arm, and
// copied per run with APFS clones. The agent is briefed with the case's
// developer-confirmed spec (bench/specs/, from duediligence's in-repo
// evidence). Each run's change goes to a clean clone at B (the slice's
// patch, the full arm's diff), the spec's calibrated hidden suite is laid
// over it, and judge.mjs runs the package's tests, functional and gated,
// and builds its importers. A slice run is also judged in the slice: the
// change and the hidden suite applied with `carveout apply --stubs`,
// against the slice's baseline.
//
// One line per run in results/bench.jsonl. A run with a line is skipped;
// a session the usage limit refused is not recorded.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HERE, WORK, carveout, checkout, cloneOf, frozenCli, git } from "../lib.mjs";
import {
  install,
  buildDependencies,
  judge,
  log,
  packageChange,
  seamEntries,
  sliceTests,
  verdictOf,
} from "../judge.mjs";
import { WORK_ROOT, claude, discard, peeks } from "./lib.mjs";

const BENCH = join(HERE, "bench");
const CASES = JSON.parse(readFileSync(join(HERE, "e5-cases.json"), "utf8")).cases;
const RESULTS = join(HERE, "results", "bench.jsonl");
const TEMPLATES = join(WORK, "bench", "templates");
const JUDGING = join(WORK, "bench", "judging");
const RUNS = join(WORK, "bench", "runs");
const ARMS = ["full", "slice-seam", "slice-diff"];

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const valued = new Set(["--arms", "--runs", "--model", "--concurrency"]);
const slugs = args.filter((arg, i) => !arg.startsWith("--") && !valued.has(args[i - 1]));
const arms = option("--arms", "full,slice-seam").split(",");
const runs = Number(option("--runs", "2"));
const model = option("--model", "claude-haiku-5-5");
const concurrency = Number(option("--concurrency", "2"));
for (const arm of arms) if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}`);

const source = () => cloneOf("sandbox-factory", "bench-base");
const baseOf = (item) => git(source(), ["rev-parse", `${item.commit}^`]).trim();
/** The case's confirmed spec, its toolchain and its hidden suite, from duediligence. */
const specOf = (item) => join(BENCH, "specs", item.slug);
const toolchainOf = (item) => JSON.parse(readFileSync(join(specOf(item), "toolchain.json"), "utf8"));
const allowedOf = (item) => toolchainOf(item).allowedPaths;
/** The hidden suite's files, by the repository path they are judged at. */
const hiddenOf = (item) =>
  readdirSync(join(specOf(item), "private"), { recursive: true })
    .filter((name) => statSync(join(specOf(item), "private", name)).isFile())
    .sort()
    .map((name) => ({ path: `${toolchainOf(item).hiddenDir}/${name}`, from: join(specOf(item), "private", name) }));
const within = (path, allowed) => allowed.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));

function brief(item, arm, baseline) {
  const text = readFileSync(join(BENCH, "prompts", arm === "full" ? "full.md" : "slice.md"), "utf8");
  const failing = Object.entries(baseline?.tests ?? {}).filter(([, ok]) => !ok).map(([name]) => `\`${name}\``);
  return text
    .replaceAll("{{package}}", item.package)
    .replaceAll("{{allowed}}", allowedOf(item).map((path) => `\`${path}\``).join(", "))
    .replaceAll(
      "{{baseline}}",
      failing.length === 0
        ? "Before any change, every test in it passes."
        : `Before any change, ${failing.length} test(s) fail on the mocks, not on your change: ${failing.join(", ")}.`,
    )
    .replaceAll("{{spec}}", readFileSync(join(specOf(item), "spec.md"), "utf8").trim());
}

/** The workdir every run of a case and arm starts from, made once. */
function template(cli, item, arm) {
  const dir = join(TEMPLATES, item.slug, arm);
  const ready = join(TEMPLATES, item.slug, `${arm}.json`);
  if (existsSync(ready)) return { dir, ...JSON.parse(readFileSync(ready, "utf8")) };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const repo = source();
  const base = baseOf(item);
  const started = Date.now();
  let meta;
  if (arm === "full") {
    execFileSync("sh", ["-c", `git -C '${repo}' archive ${base} | tar -x -C '${dir}'`]);
    git(dir, ["init", "-q"]);
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-q", "-m", "base"]);
    // What the harness and the build write beside the sources, never the change.
    writeFileSync(join(dir, ".git", "info", "exclude"), ".e5-lock\n.turbo/\n");
    install(dir, git(repo, ["rev-parse", `${base}:package-lock.json`]).trim());
    const built = buildDependencies(dir, item.package);
    if (!built.ok) throw new Error(`${item.slug}: dependencies do not build at B:\n${built.output}`);
    meta = { base, setupMs: Date.now() - started };
  } else {
    checkout(repo, base);
    const entries = arm === "slice-seam" ? seamEntries(repo, base, item.seam) : packageChange(repo, item).code.filter((path) => packageChange(repo, item).changes.get(path) !== "A");
    rmSync(dir, { recursive: true, force: true });
    const cut = carveout(cli, ["cut", ...entries, "--repo", repo, "--depth", "1", "--max-files", "200", "--with-tests", "--out", dir]);
    if (cut.code !== 0 && cut.code !== 2) throw new Error(`${item.slug}/${arm}: cut failed:\n${cut.stderr}`);
    const cutMs = Date.now() - started;
    const baseline = sliceTests(dir);
    if (baseline.step !== "test") throw new Error(`${item.slug}/${arm}: the slice does not build at B:\n${baseline.output}`);
    execFileSync("sh", ["-c", existsSync(join(dir, "package-lock.json")) ? "npm ci --no-audit --no-fund --loglevel=error" : "npm install --no-audit --no-fund --loglevel=error"], { cwd: dir });
    const record = JSON.parse(readFileSync(join(dir, "carveout.json"), "utf8"));
    meta = { base, entries, files: record.manifest.included.length, cutMs, setupMs: Date.now() - started, baseline: { tests: baseline.tests, pass: baseline.pass, fail: baseline.fail } };
  }
  writeFileSync(ready, JSON.stringify(meta));
  return { dir, ...meta };
}

function done() {
  const out = new Set();
  if (!existsSync(RESULTS)) return out;
  for (const line of readFileSync(RESULTS, "utf8").split("\n").filter(Boolean)) {
    const item = JSON.parse(line);
    out.add(`${item.slug}/${item.arm}/${item.model}/${item.run}`);
  }
  return out;
}

/** The session, and the change it leaves, from a copy of the template. */
async function session(cli, item, arm, n, prepared) {
  const work = mkdtempSync(join(WORK_ROOT, `${item.slug}-${arm}-${n}-`));
  execFileSync("cp", ["-c", "-R", `${prepared.dir}/.`, work]);
  const out = join(RUNS, item.slug, `${arm}-${model}`, String(n));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const transcript = join(out, "transcript.jsonl");
  try {
    const agent = await claude({ cwd: work, text: brief(item, arm, prepared.baseline), transcript, model });
    if (agent.apiError === "usage_limit_reached" || /usage limit/i.test(agent.stderr)) return { limited: true };
    const change = join(out, "change.patch");
    let patch = null;
    if (arm === "full") {
      git(work, ["add", "-A"]);
      writeFileSync(change, git(work, ["diff", "--cached", "--binary", "--full-index", "--no-renames"]));
    } else {
      const patched = carveout(cli, ["patch", work, "--json", "--output", change]);
      patch = JSON.parse(patched.stdout);
      delete patch.diff;
      // The slice as the agent left it, for the in-slice verdict.
      rmSync(join(out, "slice"), { recursive: true, force: true });
      execFileSync("cp", ["-c", "-R", work, join(out, "slice")]);
      rmSync(join(out, "slice", "node_modules"), { recursive: true, force: true });
    }
    return { agent, patch, change, out, peeks: peeks(transcript, work) };
  } finally {
    discard(work);
  }
}

/** The run judged in a clean clone at B; serial, since the clone is shared. */
function judgeRun(cli, item, arm, prepared, ran) {
  const line = {};
  const into = cloneOf("sandbox-factory", "bench-target");
  git(into, ["checkout", "-q", "-f", "--detach", prepared.base]);
  git(into, ["clean", "-q", "-fdx", "-e", "node_modules", "-e", ".e5-lock"]);
  install(into, git(into, ["rev-parse", `${prepared.base}:package-lock.json`]).trim());
  const diff = readFileSync(ran.change, "utf8");
  const files = [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);
  line.files = files.length;
  line.outsideScope = files.filter((path) => !within(path, [...allowedOf(item), `${item.package}/test/`]));
  if (files.length === 0) return { ...line, verdict: "no_change" };
  const applied = execFileSync("sh", ["-c", `git apply --3way --whitespace=nowarn '${ran.change}' 2>&1; echo "exit=$?"`], { cwd: into }).toString();
  if (!/exit=0\s*$/.test(applied)) return { ...line, verdict: "apply_failed", applyOutput: applied.slice(-1500) };
  for (const hidden of hiddenOf(item)) {
    mkdirSync(dirname(join(into, hidden.path)), { recursive: true });
    writeFileSync(join(into, hidden.path), readFileSync(hidden.from));
  }
  if (arm !== "full") {
    // In the slice: the change and the hidden suite, as one patch at B,
    // so a test of a module the change adds finds it.
    const slice = join(ran.out, "slice");
    const judged = join(ran.out, "judged.patch");
    git(into, ["add", "-A"]);
    writeFileSync(judged, git(into, ["diff", "--cached", "--binary", "--full-index", "--no-renames", prepared.base]));
    git(into, ["reset", "-q"]);
    const brought = carveout(cli, ["apply", slice, judged, "--stubs", "--json"]);
    line.inSlice =
      brought.code === 0 || brought.code === 5
        ? verdictOf(prepared.baseline, sliceTests(slice))
        : { ok: false, reason: `apply failed: ${brought.stderr.slice(-500)}` };
    rmSync(slice, { recursive: true, force: true });
  }
  const result = judge(into, item.package, { importers: true });
  delete result.functional?.tests;
  line.postMerge = result;
  const accepted = result.deps.ok && result.functional?.ok && result.gate?.ok && result.importers?.ok;
  line.verdict =
    line.outsideScope.length > 0
      ? "refused"
      : ran.patch !== null && ran.patch.boundary.length > 0
        ? "boundary"
        : accepted
          ? "accepted"
          : result.functional?.ok && result.importers?.ok
            ? "functional"
            : "rejected";
  return line;
}

async function main() {
  const cli = frozenCli();
  const finished = done();
  const tasks = [];
  for (const item of CASES.filter((c) => slugs.length === 0 || slugs.includes(c.slug)))
    for (const arm of arms)
      for (let n = 1; n <= runs; n += 1)
        if (!finished.has(`${item.slug}/${arm}/${model}/${n}`)) tasks.push({ item, arm, n });
  // Every template first, one at a time: a case with an arm whose template
  // does not build is unusable, reported and left out of every arm.
  const unusable = new Set();
  for (const { item, arm } of tasks) {
    if (unusable.has(item.slug)) continue;
    try {
      template(cli, item, arm);
    } catch (error) {
      unusable.add(item.slug);
      const line = { slug: item.slug, arm, reason: String(error?.message ?? error).slice(0, 3000), at: new Date().toISOString() };
      writeFileSync(join(HERE, "results", "bench-unusable.jsonl"), `${JSON.stringify(line)}\n`, { flag: "a" });
      log("bench", `${item.slug}: unusable, ${arm} template: ${line.reason.split("\n")[0]}`);
    }
  }
  for (let i = tasks.length - 1; i >= 0; i -= 1) if (unusable.has(tasks[i].item.slug)) tasks.splice(i, 1);
  log("bench", `${tasks.length} runs to do`);
  let judging = Promise.resolve();
  let stopped = false;
  const next = async () => {
    while (!stopped && tasks.length > 0) {
      const { item, arm, n } = tasks.shift();
      const prepared = template(cli, item, arm);
      log("bench", `${item.slug}/${arm}/${n}: session`);
      const ran = await session(cli, item, arm, n, prepared);
      if (ran.limited) {
        log("bench", "usage limit reached: stopping; rerun to resume");
        stopped = true;
        return;
      }
      judging = judging.then(() => {
        log("bench", `${item.slug}/${arm}/${n}: judging`);
        let judged;
        try {
          judged = judgeRun(cli, item, arm, prepared, ran);
        } catch (error) {
          judged = { verdict: "judge_error", output: String(error?.stack ?? error).slice(-2000) };
        }
        const line = {
          slug: item.slug,
          arm,
          model,
          run: n,
          cli: cli.id,
          setup: { setupMs: prepared.setupMs, ...(prepared.files === undefined ? {} : { files: prepared.files, cutMs: prepared.cutMs, entries: prepared.entries }) },
          agent: ran.agent,
          patch: ran.patch,
          peeks: ran.peeks,
          ...judged,
          at: new Date().toISOString(),
        };
        mkdirSync(dirname(RESULTS), { recursive: true });
        writeFileSync(RESULTS, `${JSON.stringify(line)}\n`, { flag: "a" });
        log("bench", `${item.slug}/${arm}/${n}: ${line.verdict}, ${line.agent.usage.totalInput} in / ${line.agent.usage.output} out, $${line.agent.costUsd?.toFixed(3)}`);
      });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, next));
  await judging;
}

function report() {
  const rows = existsSync(RESULTS) ? readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const median = (values) => {
    const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.arm} ${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  process.stdout.write("| arm | runs | accepted | functional | rejected | other | in-slice ok | median input | median output | median cost | median turns |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n");
  for (const [key, list] of [...groups.entries()].sort()) {
    const count = (verdict) => list.filter((row) => row.verdict === verdict).length;
    const other = list.length - count("accepted") - count("functional") - count("rejected");
    const inSlice = list.filter((row) => row.inSlice !== undefined);
    process.stdout.write(
      `| ${key} | ${list.length} | ${count("accepted")} | ${count("functional")} | ${count("rejected")} | ${other} | ${inSlice.length === 0 ? "–" : `${inSlice.filter((row) => row.inSlice.ok).length}/${inSlice.length}`} | ${median(list.map((row) => row.agent.usage.totalInput))} | ${median(list.map((row) => row.agent.usage.output))} | ${median(list.map((row) => row.agent.costUsd))?.toFixed(3)} | ${median(list.map((row) => row.agent.turns))} |\n`,
    );
  }
  process.stdout.write("\nPer case:\n\n| case | arm | run | verdict | in slice | input | output | cost |\n|---|---|---:|---|---|---:|---:|---:|\n");
  for (const row of rows.sort((a, b) => `${a.slug}${a.arm}${a.run}`.localeCompare(`${b.slug}${b.arm}${b.run}`)))
    process.stdout.write(
      `| ${row.slug} | ${row.arm} | ${row.run} | ${row.verdict} | ${row.inSlice === undefined ? "–" : row.inSlice.ok ? "ok" : "fail"} | ${row.agent.usage.totalInput} | ${row.agent.usage.output} | ${row.agent.costUsd?.toFixed(3)} |\n`,
    );
}

if (args.includes("--report")) report();
else await main();
