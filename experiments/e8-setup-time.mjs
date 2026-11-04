#!/usr/bin/env node
// E8b (PLAN-benchmark.md, Phase 8): time and disk to the first test run,
// a slice against the whole repository. For each E6b case, in a fresh
// copy: `npm ci` with a warm npm cache, the build the arm's agent needs
// (the package's workspace dependencies for `full`; the slice's own
// `npm test` builds), and one test run of the package. One case at a time,
// nothing else running. Appends a line per case to
// results/e8-setup-time.jsonl; a case with a line is done.
//
//   node experiments/e8-setup-time.mjs [slug...] [--tag e6b] [--cli ad8b99c8bd40]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDependencies } from "./judge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const TAG = opt("--tag", "e6b");
const CLI = opt("--cli", "ad8b99c8bd40");
const only = args.filter((a) => !a.startsWith("--") && a !== TAG && a !== CLI);
// --force: measure a case again (a later CLI); its earlier line stays.
const force = args.includes("--force");
const RESULTS = join(HERE, "results", `bench-${TAG}.jsonl`);
const OUT = join(HERE, "results", "e8-setup-time.jsonl");
const TEMPLATES = join(HERE, "work", "bench", `templates-${TAG}`);
const CLONE = join(HERE, "work", "clones", `sandbox-factory-${TAG}-base`, "sandbox-factory");
const CASES = JSON.parse(readFileSync(join(HERE, "e5-cases.json"), "utf8")).cases;
const NPM = "npx -y npm@10.9.2";

const rows = readFileSync(RESULTS, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const slugs = [...new Set(rows.filter((r) => r.arm === "slice-seam").map((r) => r.slug))].filter((s) => only.length === 0 || only.includes(s));
const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).slug) : []);

const log = (text) => process.stderr.write(`[e8b ${new Date().toISOString().slice(11, 19)}] ${text}\n`);

/** Runs a shell command, timed; returns ok, seconds and the output's tail. */
function timed(cwd, command, env = {}) {
  const started = Date.now();
  const result = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", env: { ...process.env, ...env, CI: "1" }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, seconds: Math.round((Date.now() - started) / 100) / 10, tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-5).join("\n") };
}

const kb = (path) => (existsSync(path) ? Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0]) : 0);
const files = (path) => (existsSync(path) ? Number(execFileSync("sh", ["-c", `find '${path}' -type f | wc -l`], { encoding: "utf8" }).trim()) : 0);

for (const slug of slugs) {
  if (done.has(slug) && !force) continue;
  const item = CASES.find((c) => c.slug === slug);
  const sliceTemplate = join(TEMPLATES, CLI, slug, "slice-seam");
  if (!item || !existsSync(sliceTemplate)) {
    log(`${slug}: no slice template, skipped`);
    continue;
  }
  const base = execFileSync("git", ["-C", CLONE, "rev-parse", `${item.commit}^`], { encoding: "utf8" }).trim();
  const scratch = mkdtempSync(join(tmpdir(), `e8b-${slug}-`));
  const line = { slug, package: item.package, base, cli: CLI, at: new Date().toISOString() };
  try {
    // The repository at B, sources only.
    const full = join(scratch, "full");
    mkdirSync(full);
    execFileSync("sh", ["-c", `git -C '${CLONE}' archive ${base} | tar -x -C '${full}'`]);
    log(`${slug}/full: npm ci`);
    const fullInstall = timed(full, `${NPM} ci --ignore-scripts --no-audit --no-fund --loglevel=error`);
    log(`${slug}/full: build dependencies`);
    const buildStarted = Date.now();
    const built = buildDependencies(full, item.package);
    const fullBuild = { ok: built.ok, seconds: Math.round((Date.now() - buildStarted) / 100) / 10 };
    log(`${slug}/full: npm test`);
    const fullTest = timed(join(full, item.package), "npm test --silent");
    line.full = {
      install: fullInstall,
      build: fullBuild,
      test: fullTest,
      secondsToFirstTest: Math.round((fullInstall.seconds + fullBuild.seconds + fullTest.seconds) * 10) / 10,
      nodeModulesKb: kb(join(full, "node_modules")) + kb(join(full, item.package, "node_modules")),
      sourceFiles: files(full) - files(join(full, "node_modules")) - files(join(full, item.package, "node_modules")),
    };
    rmSync(full, { recursive: true, force: true });

    // The slice, its sources only.
    const slice = join(scratch, "slice");
    mkdirSync(slice);
    execFileSync("sh", ["-c", `tar --exclude=node_modules -C '${sliceTemplate}' -cf - . | tar -x -C '${slice}'`]);
    log(`${slug}/slice: npm ci`);
    const sliceInstall = timed(slice, `${NPM} ci --ignore-scripts --no-audit --no-fund --loglevel=error`);
    log(`${slug}/slice: npm test`);
    const sliceTest = timed(slice, "npm test --silent");
    line.slice = {
      install: sliceInstall,
      test: sliceTest,
      secondsToFirstTest: Math.round((sliceInstall.seconds + sliceTest.seconds) * 10) / 10,
      nodeModulesKb: kb(join(slice, "node_modules")),
      sourceFiles: files(slice) - files(join(slice, "node_modules")),
    };
    line.ratio = {
      secondsToFirstTest: line.slice.secondsToFirstTest / line.full.secondsToFirstTest,
      nodeModulesKb: line.slice.nodeModulesKb / line.full.nodeModulesKb,
    };
    log(`${slug}: full ${line.full.secondsToFirstTest}s / ${Math.round(line.full.nodeModulesKb / 1024)} MB, slice ${line.slice.secondsToFirstTest}s / ${Math.round(line.slice.nodeModulesKb / 1024)} MB`);
  } catch (error) {
    line.error = String(error?.message ?? error).slice(0, 500);
    log(`${slug}: ${line.error}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(OUT, `${JSON.stringify(line)}\n`, { flag: "a" });
}
log("done");
