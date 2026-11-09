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
// The slice-plan arm (E7: a model session in the whole repository named the
// entries) was retired on 2026-11-06: it read the private repository, which
// the slice exists to keep closed, cost 17% more input and accepted no more
// changes. Its rows stay in results/ for analyze.mjs --arm slice-plan.
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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HERE, ROOT, WORK, carveout, cloneOf, frozenCli, git } from "../lib.mjs";
import { hiddenVerdictOf, install, judge, log, sliceTests, verdictOf } from "../judge.mjs";
import { ARMS, BENCH, CASES, allowedOf, cutSlice, hiddenOf, specOf, template, within } from "./cases.mjs";
import { WORK_ROOT, claude, discard, peeks } from "./lib.mjs";
import { codex } from "./codex.mjs";

const RESULTS = process.env.BENCH_RESULTS ?? join(HERE, "results", "bench.jsonl");
const tag = process.env.BENCH_TAG ?? "";
const RUNS = join(WORK, "bench", tag === "" ? "runs" : `runs-${tag}`);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const valued = new Set(["--arms", "--runs", "--model", "--concurrency", "--backend", "--brief"]);
const slugs = args.filter((arg, i) => !arg.startsWith("--") && !valued.has(args[i - 1]));
const arms = option("--arms", "full,slice-seam").split(",");
const runs = Number(option("--runs", "2"));
const model = option("--model", "claude-haiku-5-5");
const backend = option("--backend", "claude");
const concurrency = Number(option("--concurrency", "2"));
// What briefs the agent: the confirmed spec, or the commit's own message
// (E8c: a loose brief, judged by the same hidden suite).
const briefKind = option("--brief", "spec");
if (!["spec", "ticket"].includes(briefKind)) throw new Error(`unknown brief ${briefKind}`);
if (briefKind === "ticket" && (tag === "" || !process.env.BENCH_RESULTS)) throw new Error("A ticket brief requires BENCH_TAG and BENCH_RESULTS of its own");
if (!["claude", "codex"].includes(backend)) throw new Error(`unknown backend ${backend}`);
if (backend === "codex" && (tag === "" || !process.env.BENCH_RESULTS || !args.includes("--model"))) throw new Error("Codex runs require BENCH_TAG, BENCH_RESULTS and an explicit --model");
if (backend === "codex" && concurrency !== 1) throw new Error("Codex sessions require --concurrency 1 until concurrent isolation is verified");
for (const arm of arms) if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}`);

function brief(item, arm) {
  const text = readFileSync(join(BENCH, "prompts", arm === "full" ? "full.md" : "slice.md"), "utf8");
  return text
    .replaceAll("{{package}}", item.package)
    .replaceAll("{{allowed}}", allowedOf(item).map((path) => `\`${path}\``).join(", "))
    // What the folder says of itself since eec1139: npm test names the
    // tests that fail on the mocks and does not count them.
    .replaceAll("{{baseline}}", "")
    .replaceAll("{{spec}}", briefKind === "ticket" ? ticketOf(item) : readFileSync(join(specOf(item), "spec.md"), "utf8").trim());
}

/** The commit's subject and body, as the ticket an agent would be handed. */
function ticketOf(item) {
  const repo = cloneOf("sandbox-factory", tag === "" ? "bench-base" : `${tag}-base`);
  return git(repo, ["log", "-1", "--format=%B", item.commit]).trim();
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

/**
 * `turbo` writes a managed block into AGENTS.md when it detects an agent
 * (E6a: every full run of ticket-content). It is the tool's write, not the
 * agent's change: taken out before the diff, and recorded. A block the
 * repository had committed at B is left alone: taking it out would be a
 * deletion the agent never made (E6b: every full run of step-holds,
 * context-sources and workspace-stubs was refused for one).
 */
function stripToolBlocks(work) {
  const stripped = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(work, name);
    if (!existsSync(path)) continue;
    let committed = "";
    try {
      committed = execFileSync("git", ["-C", work, "show", `HEAD:${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // Not committed at B: any block is the tool's.
    }
    if (/<!-- BEGIN:turborepo-agent-rules -->/.test(committed)) continue;
    const text = readFileSync(path, "utf8");
    const clean = text.replace(/\n*<!-- BEGIN:turborepo-agent-rules -->[\s\S]*?<!-- END:turborepo-agent-rules -->\n?/, "\n");
    if (clean === text) continue;
    writeFileSync(path, clean);
    stripped.push(name);
  }
  return stripped;
}


/** The session, and the change it leaves, from a copy of the template. */
async function session(cli, item, arm, n, prepared) {
  const out = join(RUNS, item.slug, `${arm}-${model}`, String(n));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(WORK_ROOT, `${item.slug}-${arm}-${n}-`));
  execFileSync("cp", ["-c", "-R", `${prepared.dir}/.`, work]);
  const transcript = join(out, "transcript.jsonl");
  try {
    const agent = await (backend === "codex" ? codex : claude)({ cwd: work, text: brief(item, arm), transcript, model });
    if (agent.apiError === "usage_limit_reached" || /usage limit/i.test(agent.stderr)) return { limited: true };
    if (!agent.ok) return { failed: true, agent, out };
    const change = join(out, "change.patch");
    let patch = null;
    let toolWrites = [];
    if (arm === "full") {
      toolWrites = stripToolBlocks(work);
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
    const seen = backend === "codex" ? null : peeks(transcript, work);
    return { agent, patch, change, out, toolWrites, peeks: seen };
  } finally {
    discard(work);
  }
}

/** The run judged in a clean clone at B; serial, since the clone is shared. */
function judgeRun(cli, item, arm, prepared, ran) {
  const line = {};
  const into = cloneOf("sandbox-factory", tag === "" ? "bench-target" : `${tag}-bench-target`);
  git(into, ["checkout", "-q", "-f", "--detach", prepared.base]);
  git(into, ["clean", "-q", "-fdx", "-e", "node_modules", "-e", ".e5-lock"]);
  install(into, git(into, ["rev-parse", `${prepared.base}:package-lock.json`]).trim());
  const diff = readFileSync(ran.change, "utf8");
  const files = [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);
  line.files = files.length;
  line.outsideScope = files.filter((path) => !within(path, [...allowedOf(item), `${item.package}/test/`]));
  if (files.length === 0) return { ...line, verdict: ran.patch?.boundary?.length ? "boundary" : "no_change" };
  const applied = execFileSync("sh", ["-c", `git apply --3way --whitespace=nowarn '${ran.change}' 2>&1; echo "exit=$?"`], { cwd: into }).toString();
  if (!/exit=0\s*$/.test(applied)) return { ...line, verdict: "apply_failed", applyOutput: applied.slice(-1500) };
  for (const hidden of hiddenOf(item)) {
    mkdirSync(dirname(join(into, hidden.path)), { recursive: true });
    writeFileSync(join(into, hidden.path), readFileSync(hidden.from));
  }
  if (arm !== "full") {
    // In the slice: the change and the hidden suite, as one patch at B,
    // so a test of a module the change adds finds it.
    const agentSlice = join(ran.out, "slice");
    const agentVerdict = verdictOf(prepared.baseline, sliceTests(agentSlice));
    // Apply the combined patch to a clean cut at B. Applying it a second
    // time to the agent's edited folder can leave additions unresolved.
    const slice = join(ran.out, "judged-slice");
    rmSync(slice, { recursive: true, force: true });
    execFileSync("cp", ["-c", "-R", prepared.dir, slice]);
    const judged = join(ran.out, "judged.patch");
    git(into, ["add", "-A"]);
    // The install cache marker belongs to the harness, not to the change.
    git(into, ["reset", "-q", "--", ".e5-lock"]);
    writeFileSync(judged, git(into, ["diff", "--cached", "--binary", "--full-index", "--no-renames", prepared.base]));
    git(into, ["reset", "-q"]);
    const brought = carveout(cli, ["apply", slice, judged, "--stubs", "--json"]);
    if (brought.code === 0 || brought.code === 5) {
      const appliedInSlice = JSON.parse(brought.stdout);
      if (!agentVerdict.ok) line.inSlice = agentVerdict;
      else if (appliedInSlice.outside.length > 0) line.inSlice = { ok: null, reason: "partial apply", outside: appliedInSlice.outside };
      else {
        const hiddenTests = sliceTests(slice);
        // The hidden suite is deliberately under a separate folder and is
        // run by the judge, not by the repository's ordinary test glob. Its
        // placement and coverage must not fail the agent's own gate, which
        // was checked above without the hidden suite.
        line.inSlice = hiddenVerdictOf(prepared.baseline, hiddenTests);
      }
    } else {
      line.inSlice = { ok: null, reason: `apply failed: ${brought.stderr.slice(-500)}` };
    }
    rmSync(slice, { recursive: true, force: true });
    rmSync(agentSlice, { recursive: true, force: true });
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
      if (ran.failed) {
        log("bench", `model session failed: ${ran.agent.error ?? ran.agent.stderr ?? "unknown error"}; transcript: ${ran.out}/transcript.jsonl`);
        stopped = true;
        process.exitCode = 1;
        return;
      }
      judging = judging.then(() => {
        log("bench", `${item.slug}/${arm}/${n}: judging`);
        const used = prepared;
        let judged;
        try {
          judged = judgeRun(cli, item, arm, used, ran);
        } catch (error) {
          judged = { verdict: "judge_error", output: String(error?.stack ?? error).slice(-2000) };
        }
        const line = {
          slug: item.slug,
          arm,
          model,
          run: n,
          cli: cli.id,
          ...(briefKind === "spec" ? {} : { brief: briefKind }),
          setup: { setupMs: used.setupMs, ...(used.files === undefined ? {} : { files: used.files, cutMs: used.cutMs, entries: used.entries, baseline: used.baseline }) },
          agent: ran.agent ?? null,
          patch: ran.patch ?? null,
          peeks: ran.peeks ?? null,
          toolWrites: ran.toolWrites ?? [],
          ...judged,
          at: new Date().toISOString(),
        };
        mkdirSync(dirname(RESULTS), { recursive: true });
        writeFileSync(RESULTS, `${JSON.stringify(line)}\n`, { flag: "a" });
        const cost = line.agent?.costUsd == null ? "cost unavailable" : `$${line.agent.costUsd.toFixed(3)}`;
        log("bench", `${item.slug}/${arm}/${n}: ${line.verdict}, ${line.agent?.usage.totalInput ?? "?"} in / ${line.agent?.usage.output ?? "?"} out, ${cost}`);
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
    const inSlice = list.filter((row) => typeof row.inSlice?.ok === "boolean");
    process.stdout.write(
      `| ${key} | ${list.length} | ${count("accepted")} | ${count("functional")} | ${count("rejected")} | ${other} | ${inSlice.length === 0 ? "–" : `${inSlice.filter((row) => row.inSlice.ok).length}/${inSlice.length}`} | ${median(list.map((row) => row.agent.usage.totalInput))} | ${median(list.map((row) => row.agent.usage.output))} | ${median(list.map((row) => row.agent.costUsd))?.toFixed(3) ?? "–"} | ${median(list.map((row) => row.agent.turns)) ?? "–"} |\n`,
    );
  }
  process.stdout.write("\nPer case:\n\n| case | arm | run | verdict | in slice | input | output | cost |\n|---|---|---:|---|---|---:|---:|---:|\n");
  for (const row of rows.sort((a, b) => `${a.slug}${a.arm}${a.run}`.localeCompare(`${b.slug}${b.arm}${b.run}`)))
    process.stdout.write(
      `| ${row.slug} | ${row.arm} | ${row.run} | ${row.verdict} | ${row.inSlice?.ok == null ? "–" : row.inSlice.ok ? "ok" : "fail"} | ${row.agent.usage.totalInput} | ${row.agent.usage.output} | ${row.agent.costUsd?.toFixed(3) ?? "–"} |\n`,
    );
}

if (args.includes("--report")) report();
else await main();
