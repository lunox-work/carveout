#!/usr/bin/env node
// E8a (PLAN-benchmark.md, Phase 8): what a `full` agent read that the
// slice does not hold. Reads the saved E6b `full` transcripts, names every
// repository file each `Read` call or `Bash` command reached, and sets it
// against the slice-seam template's copied files (carveout.json
// `manifest.included`). Writes results/e8-exposure.json and prints the
// per-case table. No model, no network.
//
//   node experiments/e8-exposure.mjs [--tag e6b] [--cli ad8b99c8bd40]
import { existsSync, globSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, posix } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const TAG = opt("--tag", "e6b");
const CLI = opt("--cli", "ad8b99c8bd40");
const MODEL = opt("--model", "claude-haiku-5-5");
const RESULTS = join(HERE, "results", `bench-${TAG}.jsonl`);
const RUNS = join(HERE, "work", "bench", `runs-${TAG}`);
const TEMPLATES = join(HERE, "work", "bench", `templates-${TAG}`);

/** Commands whose arguments are read as content, not merely named. */
const READERS = new Set(["cat", "head", "tail", "sed", "grep", "rg", "awk", "less", "more", "bat", "wc", "diff", "nl", "cut", "sort", "uniq", "jq", "tac", "strings"]);
const SKIP = /(^|\/)(node_modules|\.git|dist|dist-test|\.turbo|coverage)(\/|$)/;
const SENSITIVE = /(^|\/)\.env|^infra\/|^\.github\/|credential|secret|\.pem$|\.key$/i;

const rows = readFileSync(RESULTS, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const slugs = [...new Set(rows.filter((r) => r.arm === "full" && r.model === MODEL).map((r) => r.slug))];

/** Splits a shell command into simple segments, honouring quotes loosely. */
function segments(command) {
  const out = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Tokens of a segment, quotes stripped, redirection targets dropped. */
function tokens(segment) {
  const raw = segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  const out = [];
  let dropNext = false;
  for (let token of raw) {
    if (/^\d*>{1,2}$|^<$|^2>&1$/.test(token)) {
      dropNext = true;
      continue;
    }
    if (dropNext) {
      dropNext = false;
      continue;
    }
    if (/^\d*>{1,2}./.test(token)) continue; // >file, 2>/dev/null
    token = token.replace(/^['"]|['"]$/g, "").replace(/^\$\(|\)$/g, "");
    out.push(token);
  }
  return out;
}

/** Repository files a token names, resolved against `cwd` in the tree at B. */
function filesOf(token, cwd, tree) {
  if (token.startsWith("-") || token === "" || /^[A-Z_]+=/.test(token)) return [];
  if (token.includes("://")) return [];
  token = token.replace(/[:,;]+$/, "").replace(/:\d+(:\d+)?$/, "");
  const rel = token.startsWith("/") ? null : posix.normalize(posix.join(cwd, token));
  const candidates = rel === null ? [] : [rel];
  if (candidates.length === 0) return [];
  const found = [];
  for (const candidate of candidates) {
    if (candidate.startsWith("..")) continue;
    if (/[*?{[]/.test(candidate)) {
      for (const match of globSync(candidate, { cwd: tree })) {
        const path = posix.normalize(match);
        if (!SKIP.test(path) && isFile(join(tree, path))) found.push(path);
      }
    } else if (!SKIP.test(candidate) && isFile(join(tree, candidate))) found.push(candidate);
  }
  return found;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Every file a transcript's tool calls reached, with how: read or named. */
function reads(transcript, tree) {
  const text = readFileSync(transcript, "utf8");
  const workdir = text.match(/\/carveout-bench-work\/[^/"'\\\s]+/)?.[0] ?? null;
  const strip = (path) => {
    if (!workdir) return path;
    const at = path.indexOf(workdir);
    return at === -1 ? path : path.slice(at + workdir.length).replace(/^\//, "");
  };
  const read = new Map(); // path -> "read" | "named"
  const mark = (path, how) => {
    if (how === "read" || !read.has(path)) read.set(path, how);
  };
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      const input = block.input ?? {};
      if (block.name === "Read" && typeof input.file_path === "string") {
        for (const path of filesOf(strip(input.file_path), ".", tree)) mark(path, "read");
      } else if (block.name === "Grep" && typeof input.path === "string") {
        const base = strip(input.path);
        for (const path of filesOf(base, ".", tree)) mark(path, "read");
      } else if (block.name === "Bash" && typeof input.command === "string") {
        let cwd = ".";
        for (const segment of segments(input.command)) {
          if (segment.includes("<<")) continue; // a heredoc: a write
          const words = tokens(segment);
          let i = 0;
          while (i < words.length && /^[A-Z_]+=/.test(words[i])) i++;
          let cmd = words[i] ?? "";
          if (cmd === "cd") {
            const target = words[i + 1] ?? ".";
            cwd = target.startsWith("/") ? strip(target) || "." : posix.normalize(posix.join(cwd, target));
            continue;
          }
          if (["npx", "node", "npm", "timeout", "sudo", "xargs"].includes(cmd) && words[i + 1]) cmd = words[i + 1];
          const how = READERS.has(cmd) ? "read" : "named";
          for (const token of words.slice(i + 1)) {
            const target = token.startsWith("/") ? strip(token) : token;
            if (target.startsWith("/")) continue;
            for (const path of filesOf(target, cwd, tree)) mark(path, how);
          }
        }
      }
    }
  }
  return read;
}

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

const perRun = [];
const perCase = [];
for (const slug of slugs) {
  const tree = join(TEMPLATES, slug, "full");
  const manifestPath = join(TEMPLATES, CLI, slug, "slice-seam", "carveout.json");
  if (!existsSync(tree) || !existsSync(manifestPath)) {
    perCase.push({ slug, skipped: `missing ${existsSync(tree) ? "slice template" : "full template"}` });
    continue;
  }
  const held = new Set(JSON.parse(readFileSync(manifestPath, "utf8")).manifest.included.map((entry) => entry.path));
  const runs = [];
  for (const row of rows.filter((r) => r.arm === "full" && r.model === MODEL && r.slug === slug)) {
    const transcript = join(RUNS, slug, `full-${MODEL}`, String(row.run), "transcript.jsonl");
    if (!existsSync(transcript)) continue;
    const touched = reads(transcript, tree);
    const all = [...touched.keys()];
    const readOnly = all.filter((path) => touched.get(path) === "read");
    const outside = all.filter((path) => !held.has(path));
    const outsideRead = outside.filter((path) => touched.get(path) === "read");
    const bytes = (list) => list.reduce((sum, path) => sum + statSync(join(tree, path)).size, 0);
    const run = {
      slug,
      run: row.run,
      verdict: row.verdict,
      sliceHolds: held.size,
      files: all.length,
      filesRead: readOnly.length,
      outside: outside.length,
      outsideRead: outsideRead.length,
      outsideReadBytes: bytes(outsideRead),
      outsidePackages: [...new Set(outside.map((path) => path.split("/").slice(0, 2).join("/")))],
      sensitive: all.filter((path) => SENSITIVE.test(path)),
      outsideReadFiles: outsideRead,
    };
    runs.push(run);
    perRun.push(run);
  }
  perCase.push({
    slug,
    runs: runs.length,
    sliceHolds: held.size,
    files: median(runs.map((r) => r.files)),
    filesRead: median(runs.map((r) => r.filesRead)),
    outside: median(runs.map((r) => r.outside)),
    outsideRead: median(runs.map((r) => r.outsideRead)),
    outsideReadBytes: median(runs.map((r) => r.outsideReadBytes)),
    sensitive: runs.reduce((sum, r) => sum + r.sensitive.length, 0),
    runsReadingOutside: runs.filter((r) => r.outsideRead > 0).length,
  });
}

const measured = perCase.filter((c) => !c.skipped);
const summary = {
  tag: TAG,
  cli: CLI,
  model: MODEL,
  cases: measured.length,
  runs: perRun.length,
  medianFilesRead: median(measured.map((c) => c.filesRead)),
  medianOutsideRead: median(measured.map((c) => c.outsideRead)),
  medianOutsideReadBytes: median(measured.map((c) => c.outsideReadBytes)),
  runsReadingOutside: perRun.filter((r) => r.outsideRead > 0).length,
  casesReadingOutsideInEveryRun: measured.filter((c) => c.runsReadingOutside === c.runs).length,
  sensitiveReads: perRun.reduce((sum, r) => sum + r.sensitive.length, 0),
  sensitiveFiles: [...new Set(perRun.flatMap((r) => r.sensitive))],
  packagesReadOutside: Object.entries(
    perRun.flatMap((r) => r.outsidePackages).reduce((acc, pkg) => ((acc[pkg] = (acc[pkg] ?? 0) + 1), acc), {}),
  ).sort((a, b) => b[1] - a[1]),
};
writeFileSync(join(HERE, "results", "e8-exposure.json"), `${JSON.stringify({ summary, perCase, perRun }, null, 1)}\n`);

const pad = (s, n) => String(s).padStart(n);
console.log(`E8a: ${summary.runs} full runs over ${summary.cases} cases, ${MODEL}, slice templates ${CLI}\n`);
console.log("case              | holds | files | read | outside | out.read | out.bytes | sensitive | runs>0");
for (const c of measured) {
  console.log(`${c.slug.padEnd(17)} | ${pad(c.sliceHolds, 5)} | ${pad(c.files, 5)} | ${pad(c.filesRead, 4)} | ${pad(c.outside, 7)} | ${pad(c.outsideRead, 8)} | ${pad(c.outsideReadBytes, 9)} | ${pad(c.sensitive, 9)} | ${c.runsReadingOutside}/${c.runs}`);
}
for (const c of perCase.filter((c) => c.skipped)) console.log(`${c.slug.padEnd(17)} | skipped: ${c.skipped}`);
console.log(`\nmedian over cases: files read ${summary.medianFilesRead}, outside the slice ${summary.medianOutsideRead} (${summary.medianOutsideReadBytes} bytes)`);
console.log(`runs that read outside the slice: ${summary.runsReadingOutside} of ${summary.runs}; cases where every run did: ${summary.casesReadingOutsideInEveryRun} of ${summary.cases}`);
console.log(`sensitive reads: ${summary.sensitiveReads}${summary.sensitiveFiles.length ? ` (${summary.sensitiveFiles.join(", ")})` : ""}`);
console.log(`packages read outside, by runs: ${summary.packagesReadOutside.map(([pkg, n]) => `${pkg} ${n}`).join(", ")}`);
