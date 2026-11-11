// Share of sandbox-factory's TypeScript source lines each slice in slices.json copies as-is (the hero's "under 1%").
// Run from the carveout root after npm run build: node experiments/hero-exposure.mjs > experiments/results/hero-exposure.json
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const repo = path.resolve("../sandbox-factory");
const cfg = JSON.parse(fs.readFileSync("experiments/slices.json", "utf8"));
const files = execFileSync("git", ["-C", repo, "ls-files", "*.ts", "*.tsx", "*.mts", "*.cts"], { encoding: "utf8" })
  .split("\n").filter((f) => f && !f.endsWith(".d.ts") && !f.includes("node_modules/"));
const lines = (f) => { try { return fs.readFileSync(path.join(repo, f), "utf8").split("\n").length; } catch { return 0; } };
const total = files.reduce((n, f) => n + lines(f), 0);
const head = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const out = [];
for (const s of cfg.slices.filter((s) => s.repo === "sandbox-factory")) {
  for (const mode of [[], ["--with-tests", "--whole-package", "--copy-pure"]]) {
    const args = ["dist/src/cli.js", "plan", ...s.entries, "--repo", repo, "--depth", String(s.depth), "--max-files", "200", ...s.flags, ...mode, "--json"];
    let j; try { j = JSON.parse(execFileSync("node", ["--max-old-space-size=2048", ...args], { encoding: "utf8", maxBuffer: 1 << 26 })); } catch (e) { out.push({ id: s.id, mode: mode.length ? "wide" : "plain", error: String(e.message).slice(0, 200) }); continue; }
    const shown = new Set([...(j.included ?? []), ...(j.pure ?? []), ...(j.tests ?? []).map((t) => t.file ?? t), ...(j.helpers ?? []).map((t) => t.file ?? t)]);
    const shownLines = [...shown].reduce((n, f) => n + lines(f), 0);
    out.push({ id: s.id, mode: mode.length ? "wide" : "plain", files: shown.size, lines: shownLines, pct: +(100 * shownLines / total).toFixed(2) });
  }
}
console.log(JSON.stringify({ repo: "sandbox-factory", head, totalFiles: files.length, totalLines: total, slices: out }, null, 1));
