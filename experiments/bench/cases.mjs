// The benchmark's cases and the workdirs each arm starts from, shared by
// run.mjs and parity.mjs: a case's base B, its confirmed spec and hidden
// suite, and one template per case and arm (per CLI build for a slice).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, WORK, carveout, checkout, cloneOf, git } from "../lib.mjs";
import { install, buildDependencies, packageChange, seamEntries, sliceTests } from "../judge.mjs";

export const BENCH = join(HERE, "bench");
export const CASES = JSON.parse(readFileSync(join(HERE, "e5-cases.json"), "utf8")).cases;
// A second harness (parity.mjs) beside a running benchmark sets its own
// tag, so neither checks out the other's clone or writes its templates.
const tag = () => process.env.BENCH_TAG ?? "";
const templates = () => join(WORK, "bench", tag() === "" ? "templates" : `templates-${tag()}`);
// slice-plan (E7): the agent reads the repository and names the entries
// itself; its template is the full arm's, and its slice is cut per run.
export const ARMS = ["full", "slice-seam", "slice-diff", "slice-plan"];

export const source = () => cloneOf("sandbox-factory", tag() === "" ? "bench-base" : `${tag()}-base`);
export const baseOf = (item) => git(source(), ["rev-parse", `${item.commit}^`]).trim();
/** The case's confirmed spec, its toolchain and its hidden suite, from duediligence. */
export const specOf = (item) => join(BENCH, "specs", item.slug);
export const toolchainOf = (item) => JSON.parse(readFileSync(join(specOf(item), "toolchain.json"), "utf8"));
export const allowedOf = (item) => toolchainOf(item).allowedPaths;
/** The hidden suite's files, by the repository path they are judged at. */
export const hiddenOf = (item) =>
  readdirSync(join(specOf(item), "private"), { recursive: true })
    .filter((name) => statSync(join(specOf(item), "private", name)).isFile())
    .sort()
    .map((name) => ({ path: `${toolchainOf(item).hiddenDir}/${name}`, from: join(specOf(item), "private", name) }));
export const within = (path, allowed) => allowed.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));

/**
 * A slice cut from `entries` at the case's base into `dir`, then checked
 * as a person would next, its baseline recorded and its packages
 * installed. Throws when the cut fails or the slice does not pass its
 * baseline check. The clone is checked out, so callers serialize.
 */
export function cutSlice(cli, item, entries, dir) {
  const repo = source();
  const base = baseOf(item);
  const started = Date.now();
  checkout(repo, base);
  rmSync(dir, { recursive: true, force: true });
  const live = liveOf(repo, base, item);
  const cut = carveout(cli, ["cut", ...entries, "--repo", repo, "--depth", "1", "--max-files", "200", "--with-tests", ...live.flatMap((name) => ["--live", name]), "--out", dir]);
  if (cut.code !== 0 && cut.code !== 2) throw new Error(`${item.slug}: cut failed:\n${cut.stderr}`);
  const cutMs = Date.now() - started;
  // As a person would next: the check, which records the tests that fail
  // on the mocks before any change.
  const checked = carveout(cli, ["check", dir, "--json"]);
  const baseline = sliceTests(dir);
  if (checked.code !== 0 || !baseline.ok)
    throw new Error(`${item.slug}: the slice does not pass its baseline check at B:\n${baseline.output ?? checked.stdout ?? checked.stderr}`);
  execFileSync("sh", ["-c", existsSync(join(dir, "package-lock.json")) ? "npm ci --no-audit --no-fund --loglevel=error" : "npm install --no-audit --no-fund --loglevel=error"], { cwd: dir });
  const record = JSON.parse(readFileSync(join(dir, "carveout.json"), "utf8"));
  return { base, entries, live, files: record.manifest.included.length, cutMs, setupMs: Date.now() - started, checked: checked.code === 0, mockFailures: existsSync(join(dir, "carveout", "baseline.json")) ? JSON.parse(readFileSync(join(dir, "carveout", "baseline.json"), "utf8")).failing.length : 0, baseline: { tests: baseline.tests, pass: baseline.pass, fail: baseline.fail } };
}

/**
 * The service packages a case's slice keeps real (PLAN-benchmark.md, Phase
 * 7): a driver the package's own sources or tests import directly, whose
 * connection they read from the environment with a local default, and
 * which the judge's host serves as the repository's own test needs. A
 * package that reaches the driver through a workspace package gets
 * nothing: the slice mocks that package whatever the driver is. Fixed
 * before the run.
 */
export function liveOf(repo, base, item) {
  const LIVE = [{ specifier: "postgres", package: "postgres" }];
  const imports = (specifier) =>
    spawnSync("git", ["-C", repo, "grep", "-l", "-e", `from "${specifier}"`, base, "--", `${item.package}/src`, `${item.package}/test`], { encoding: "utf8" }).stdout.trim() !== "";
  return LIVE.filter(({ specifier }) => imports(specifier)).map(({ package: name }) => name);
}

/** The workdir every run of a case and arm starts from, made once. */
export function template(cli, item, arm) {
  // The plan arm starts every run in the repository, as the full arm does.
  if (arm === "slice-plan") return template(cli, item, "full");
  // A slice is the CLI's output: one template per build of it. A full
  // template is the repository at B: a run on the same corpus under another
  // tag may share one (`BENCH_FULL_TEMPLATES=<dir>`) rather than install it.
  const home = arm === "full" ? join(process.env.BENCH_FULL_TEMPLATES ?? templates(), item.slug) : join(templates(), cli.id.split("dist:")[1] ?? "cli", item.slug);
  const dir = join(home, arm);
  const ready = join(home, `${arm}.json`);
  if (existsSync(ready)) {
    const saved = JSON.parse(readFileSync(ready, "utf8"));
    if (saved.templateVersion === 2) return { dir, ...saved };
  }
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
    const entries = arm === "slice-seam" ? seamEntries(repo, base, item.seam) : packageChange(repo, item).code.filter((path) => packageChange(repo, item).changes.get(path) !== "A");
    try {
      meta = cutSlice(cli, item, entries, dir);
    } catch (error) {
      throw new Error(String(error?.message ?? error).replace(`${item.slug}:`, `${item.slug}/${arm}:`));
    }
  }
  meta.templateVersion = 2;
  writeFileSync(ready, JSON.stringify(meta));
  return { dir, ...meta };
}
