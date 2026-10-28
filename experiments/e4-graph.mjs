// E4 step 1: how long does the import graph take on large repositories?
// node experiments/e4-graph.mjs  → results/e4.json
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, WORK, frozenCli, git, sh } from "./lib.mjs";

const cli = frozenCli();
const REPOS = [
  { name: "cal.com", url: "https://github.com/calcom/cal.com.git", target: "~5k" },
  { name: "n8n", url: "https://github.com/n8n-io/n8n.git", target: "~20k" },
  { name: "DefinitelyTyped", url: "https://github.com/DefinitelyTyped/DefinitelyTyped.git", target: "~45k (largest found under the 50k cap)" },
];
const RUNS = 3;
const results = [];
for (const repo of REPOS) {
  const dir = join(WORK, "e4", repo.name);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(join(WORK, "e4"), { recursive: true });
    process.stderr.write(`cloning ${repo.name}\n`);
    sh("git", ["clone", "-q", "--depth", "1", repo.url, dir]);
  }
  const commit = git(dir, ["rev-parse", "HEAD"]).trim();
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    // A process of its own per run: no JIT or module cache carried over.
    const script = `const m = await import(${JSON.stringify(cli.module("graph.js"))});
const t = performance.now();
const g = m.buildGraph(${JSON.stringify(dir)});
console.log(JSON.stringify({ files: g.files.length, nodes: g.graph.nodes.length, links: g.graph.links.length, totalMs: Math.round(performance.now() - t), ...g.timings, rssMb: Math.round(process.memoryUsage().rss / 1e6) }));`;
    const result = spawnSync(process.execPath, ["--max-old-space-size=6144", "--input-type=module", "-e", script], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`${repo.name}: ${result.stderr}`);
    runs.push(JSON.parse(result.stdout));
    process.stderr.write(`${repo.name} run ${i + 1}: ${result.stdout}`);
  }
  const median = (key) => runs.map((r) => r[key]).sort((a, b) => a - b)[Math.floor(RUNS / 2)];
  results.push({
    repo: repo.name,
    url: repo.url,
    commit,
    target: repo.target,
    files: runs[0].files,
    median: Object.fromEntries(["totalMs", "listMs", "parseMs", "resolveMs", "rssMb"].map((k) => [k, median(k)])),
    runs,
  });
}
const near20k = results.find((r) => r.repo === "n8n");
const result = {
  experiment: "E4",
  cli: cli.id,
  results,
  continueToStep2: near20k.median.totalMs > 10_000,
};
mkdirSync(join(HERE, "results"), { recursive: true });
const name = process.argv[2] ?? "e4";
writeFileSync(join(HERE, "results", `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
for (const r of results)
  process.stdout.write(`${r.repo} ${r.files} files: total ${r.median.totalMs} ms (list ${r.median.listMs}, parse ${r.median.parseMs}, resolve ${r.median.resolveMs}), rss ${r.median.rssMb} MB\n`);
process.stdout.write(`step 2: ${result.continueToStep2 ? "yes" : "no"} (20k-file median ${near20k.median.totalMs} ms against 10000)\n`);
