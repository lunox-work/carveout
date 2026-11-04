#!/usr/bin/env node
// E6's bars (PLAN-benchmark.md, Phase 5), computed from results/bench.jsonl
// as fixed before the run:
//
// - acceptance per arm, and slice-seam minus full with a one-sided 95%
//   Newcombe (Wilson score) interval; non-inferior when its lower bound is
//   above -10 points;
// - "slice passed, repository failed": slice-seam runs whose in-slice
//   verdict passed and whose post-merge verdict is not accepted, at most 5%;
// - efficiency, paired per case: each arm's median over its runs, then
//   1 - slice/full per case, and the median of that over the cases; total
//   input (fresh, cache write and cache read) and cost per accepted run
//   (an arm's cost over a case's runs divided by its accepted runs) must
//   both be at least 30% lower.
//
//   node experiments/bench/analyze.mjs [--model claude-haiku-5-5] [--arm slice-seam]
//                                      [--cases a,b,...] [--json]
//
// --arm names the slice arm held to the bars (default slice-seam; E7 holds
// slice-plan to the same ones). --cases restricts every count to the cases
// named, so E6b is read on its corpus and E6a's on its own.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "../lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const model = option("--model", "claude-haiku-5-5");
const SLICE = option("--arm", "slice-seam");
const only = option("--cases", null)?.split(",") ?? null;
const path = process.env.BENCH_RESULTS ?? join(HERE, "results", "bench.jsonl");
const rows = existsSync(path)
  ? readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.model === model && (only === null || only.includes(row.slug)))
  : [];

const median = (values) => {
  const sorted = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Wilson score interval for k of n at one-sided z. */
function wilson(k, n, z) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z / (1 + (z * z) / n)) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [centre - half, centre + half];
}

/** Newcombe's hybrid score interval for p1 - p2, one-sided 95%: its lower bound. */
function newcombeLower(k1, n1, k2, n2) {
  const z = 1.6449;
  const [l1, u1] = wilson(k1, n1, z);
  const [l2, u2] = wilson(k2, n2, z);
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  return p1 - p2 - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2);
}

const byArm = (arm) => rows.filter((row) => row.arm === arm);
const accepted = (row) => row.verdict === "accepted";
const arms = [...new Set(rows.map((row) => row.arm))].sort();
const cases = [...new Set(rows.map((row) => row.slug))].sort();

const acceptance = Object.fromEntries(
  arms.map((arm) => {
    const list = byArm(arm);
    return [arm, { accepted: list.filter(accepted).length, runs: list.length, verdicts: Object.fromEntries([...new Set(list.map((r) => r.verdict))].map((v) => [v, list.filter((r) => r.verdict === v).length])) }];
  }),
);
const full = acceptance.full ?? { accepted: 0, runs: 0 };
const seam = acceptance[SLICE] ?? { accepted: 0, runs: 0 };
const lower = full.runs > 0 && seam.runs > 0 ? newcombeLower(seam.accepted, seam.runs, full.accepted, full.runs) : null;
const falsePass = byArm(SLICE).filter((row) => row.inSlice?.ok === true && !accepted(row));
const unknownParity = byArm(SLICE).filter((row) => row.inSlice?.ok !== true && row.inSlice?.ok !== false);
// Phase 7 (PLAN-benchmark.md): the unsafe direction over the rows with an
// in-slice verdict, with its one-sided 95% upper bound; the share of judged
// rows that have one; and Phase 2's agreement, reported beside them.
const judged = byArm(SLICE).filter((row) => row.inSlice?.ok === true || row.inSlice?.ok === false);
const agreeing = judged.filter((row) => row.inSlice.ok === accepted(row));
const safeMiss = judged.filter((row) => row.inSlice.ok === false && accepted(row));
const mergeback = {
  unsafe: { runs: falsePass.length, of: judged.length, share: judged.length ? falsePass.length / judged.length : null, upper95: judged.length ? wilson(falsePass.length, judged.length, 1.6449)[1] : null, cases: falsePass.map((r) => `${r.slug}/${r.run}`) },
  verdictCoverage: { runs: judged.length, of: byArm(SLICE).length, share: byArm(SLICE).length ? judged.length / byArm(SLICE).length : null },
  agreement: { runs: agreeing.length, of: judged.length, share: judged.length ? agreeing.length / judged.length : null },
  safeDirection: { runs: safeMiss.length, cases: safeMiss.map((r) => `${r.slug}/${r.run}`) },
};

/** Per case, an arm's median of `value` over its runs. */
const perCase = (arm, value) => Object.fromEntries(cases.map((slug) => [slug, median(rows.filter((r) => r.slug === slug && r.arm === arm).map(value))]));
const costPerAccepted = (arm) =>
  Object.fromEntries(
    cases.map((slug) => {
      const list = rows.filter((r) => r.slug === slug && r.arm === arm);
      const ok = list.filter(accepted).length;
      return [slug, ok === 0 || list.some((r) => typeof r.agent?.costUsd !== "number") ? null : list.reduce((sum, r) => sum + r.agent.costUsd, 0) / ok];
    }),
  );
const paired = (slice, base) => {
  const reductions = cases.flatMap((slug) => (slice[slug] == null || base[slug] == null || base[slug] === 0 ? [] : [{ slug, reduction: 1 - slice[slug] / base[slug] }]));
  return { perCase: reductions, median: median(reductions.map((r) => r.reduction)), lower: reductions.filter((r) => r.reduction > 0).length };
};
const metrics = {
  // A plan_failed run has only its planning session; its agent is that session.
  totalInput: (r) => r.agent?.usage.totalInput,
  output: (r) => r.agent?.usage.output,
  cost: (r) => r.agent?.costUsd,
  // Codex's JSONL command events are not a count of model turns. Earlier
  // pilot rows put that command count here; it cannot support this metric.
  turns: (r) => r.agent?.backend === "codex-cli" ? null : r.agent?.turns,
  minutes: (r) => r.agent?.minutes,
  toolResultBytes: (r) => r.agent?.tools.resultBytes,
};
const efficiency = {};
for (const arm of arms.filter((a) => a !== "full")) {
  efficiency[arm] = Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, paired(perCase(arm, value), perCase("full", value))]));
  efficiency[arm].costPerAccepted = paired(costPerAccepted(arm), costPerAccepted("full"));
}

const report = {
  model,
  arm: SLICE,
  cases: cases.length,
  acceptance,
  nonInferiority: { difference: seam.runs && full.runs ? seam.accepted / seam.runs - full.accepted / full.runs : null, lower95: lower, pass: lower !== null && lower > -0.1 },
  slicePassedRepositoryFailed: { runs: falsePass.length, of: byArm(SLICE).length, share: byArm(SLICE).length ? falsePass.length / byArm(SLICE).length : null, unknown: unknownParity.length, cases: falsePass.map((r) => `${r.slug}/${r.run}`) },
  mergeback,
  efficiency,
  bars: {
    totalInput: (efficiency[SLICE]?.totalInput.median ?? -1) >= 0.3,
    costPerAccepted: efficiency[SLICE]?.costPerAccepted.median == null ? null : efficiency[SLICE].costPerAccepted.median >= 0.3,
    unsafe: mergeback.unsafe.share == null ? null : mergeback.unsafe.share <= 0.02,
    verdictCoverage: mergeback.verdictCoverage.share == null ? null : mergeback.verdictCoverage.share >= 0.9,
  },
};

if (args.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  const pct = (v) => (v == null ? "–" : `${(v * 100).toFixed(1)}%`);
  const experiment = rows.some((row) => row.agent?.backend === "codex-cli") ? "Exploratory Codex analysis" : SLICE === "slice-plan" ? "E7" : "E6";
  process.stdout.write(`${experiment} on ${model}, ${cases.length} cases\n\n| arm | accepted | runs | verdicts |\n|---|---:|---:|---|\n`);
  for (const [arm, a] of Object.entries(acceptance)) process.stdout.write(`| ${arm} | ${a.accepted} | ${a.runs} | ${Object.entries(a.verdicts).map(([v, n]) => `${v} ${n}`).join(", ")} |\n`);
  process.stdout.write(`\nNon-inferiority, ${SLICE} - full: ${pct(report.nonInferiority.difference)}, one-sided 95% lower bound ${pct(lower)} (bar: above -10%): ${report.nonInferiority.pass ? "pass" : "fail"}\n`);
  process.stdout.write(`Slice passed, repository failed: ${falsePass.length} of ${report.slicePassedRepositoryFailed.of} (${pct(report.slicePassedRepositoryFailed.share)}; bar: at most 5%)\n`);
  if (unknownParity.length) process.stdout.write(`In-slice verdict unavailable: ${unknownParity.length}; the parity bar cannot be established from these runs.\n`);
  process.stdout.write(`\nMergeback (Phase 7), over the ${judged.length} rows with an in-slice verdict:\n`);
  process.stdout.write(`  unsafe direction (slice passed, repository failed): ${mergeback.unsafe.runs} (${pct(mergeback.unsafe.share)}, one-sided 95% upper bound ${pct(mergeback.unsafe.upper95)}; bar: at most 2%): ${report.bars.unsafe == null ? "unavailable" : report.bars.unsafe ? "pass" : "fail"}${mergeback.unsafe.cases.length ? ` — ${mergeback.unsafe.cases.join(", ")}` : ""}\n`);
  process.stdout.write(`  verdict coverage: ${mergeback.verdictCoverage.runs} of ${mergeback.verdictCoverage.of} (${pct(mergeback.verdictCoverage.share)}; bar: at least 90%): ${report.bars.verdictCoverage == null ? "unavailable" : report.bars.verdictCoverage ? "pass" : "fail"}\n`);
  process.stdout.write(`  agreement (Phase 2, reported): ${mergeback.agreement.runs} of ${mergeback.agreement.of} (${pct(mergeback.agreement.share)}); safe direction ${mergeback.safeDirection.runs}${mergeback.safeDirection.cases.length ? ` — ${mergeback.safeDirection.cases.join(", ")}` : ""}\n`);
  for (const [arm, metric] of Object.entries(efficiency)) {
    process.stdout.write(`\n${arm} against full, median over cases of the per-case reduction (cases where it is lower):\n\n| metric | median reduction | lower in |\n|---|---:|---:|\n`);
    for (const [name, m] of Object.entries(metric)) process.stdout.write(`| ${name} | ${pct(m.median)} | ${m.lower}/${m.perCase.length} |\n`);
  }
  process.stdout.write(`\nPer case, total input reduction (${SLICE}): ${(efficiency[SLICE]?.totalInput.perCase ?? []).map((r) => `${r.slug} ${pct(r.reduction)}`).join(", ")}\n`);
  process.stdout.write(`\nBars: total input ${report.bars.totalInput ? "pass" : "fail"}, cost per accepted run ${report.bars.costPerAccepted == null ? "unavailable" : report.bars.costPerAccepted ? "pass" : "fail"}\n`);
}
