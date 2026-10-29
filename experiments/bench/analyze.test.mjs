import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("analysis reports missing in-slice verdicts without counting them as passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "carveout-analysis-"));
  try {
    const results = join(dir, "results.jsonl");
    const agent = { usage: { totalInput: 100, output: 10 }, costUsd: 1, turns: 1, minutes: 1, tools: { resultBytes: 0 } };
    const row = (arm, run, verdict, inSlice) => ({ slug: "case", arm, run, model: "test-model", verdict, inSlice, agent });
    writeFileSync(results, [row("full", 1, "accepted"), row("slice-seam", 1, "rejected", { ok: null, reason: "partial apply" }), row("slice-seam", 2, "rejected", { ok: true })].map(JSON.stringify).join("\n"));
    const output = execFileSync(process.execPath, [new URL("./analyze.mjs", import.meta.url).pathname, "--model", "test-model", "--json"], { env: { ...process.env, BENCH_RESULTS: results }, encoding: "utf8" });
    const report = JSON.parse(output);
    assert.equal(report.slicePassedRepositoryFailed.runs, 1);
    assert.equal(report.slicePassedRepositoryFailed.unknown, 1);
    assert.equal(report.slicePassedRepositoryFailed.of, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analysis treats unavailable subscription costs as unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "carveout-cost-"));
  try {
    const results = join(dir, "results.jsonl");
    const agent = { usage: { totalInput: 100, output: 10 }, costUsd: null, turns: 1, minutes: 1, tools: { resultBytes: 0 } };
    const rows = ["full", "slice-seam"].map((arm) => ({ slug: "case", arm, run: 1, model: "test-model", verdict: "accepted", inSlice: { ok: true }, agent }));
    writeFileSync(results, rows.map(JSON.stringify).join("\n"));
    const output = execFileSync(process.execPath, [new URL("./analyze.mjs", import.meta.url).pathname, "--model", "test-model", "--json"], { env: { ...process.env, BENCH_RESULTS: results }, encoding: "utf8" });
    assert.equal(JSON.parse(output).bars.costPerAccepted, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
