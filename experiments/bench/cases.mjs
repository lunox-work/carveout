// The benchmark's cases and the workdirs each arm starts from, shared by
// run.mjs and parity.mjs: a case's base B, its confirmed spec and hidden
// suite, and one template per case and arm (per CLI build for a slice).

import { execFileSync } from "node:child_process";
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
export const ARMS = ["full", "slice-seam", "slice-diff"];

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

/** The workdir every run of a case and arm starts from, made once. */
export function template(cli, item, arm) {
  // A slice is the CLI's output: one template per build of it.
  const home = arm === "full" ? join(templates(), item.slug) : join(templates(), cli.id.split("dist:")[1] ?? "cli", item.slug);
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
    checkout(repo, base);
    const entries = arm === "slice-seam" ? seamEntries(repo, base, item.seam) : packageChange(repo, item).code.filter((path) => packageChange(repo, item).changes.get(path) !== "A");
    rmSync(dir, { recursive: true, force: true });
    const cut = carveout(cli, ["cut", ...entries, "--repo", repo, "--depth", "1", "--max-files", "200", "--with-tests", "--out", dir]);
    if (cut.code !== 0 && cut.code !== 2) throw new Error(`${item.slug}/${arm}: cut failed:\n${cut.stderr}`);
    const cutMs = Date.now() - started;
    // As a person would next: the check, which records the tests that fail
    // on the mocks before any change.
    const checked = carveout(cli, ["check", dir, "--json"]);
    const baseline = sliceTests(dir);
    if (checked.code !== 0 || !baseline.ok)
      throw new Error(`${item.slug}/${arm}: the slice does not pass its baseline check at B:\n${baseline.output ?? checked.stdout ?? checked.stderr}`);
    execFileSync("sh", ["-c", existsSync(join(dir, "package-lock.json")) ? "npm ci --no-audit --no-fund --loglevel=error" : "npm install --no-audit --no-fund --loglevel=error"], { cwd: dir });
    const record = JSON.parse(readFileSync(join(dir, "carveout.json"), "utf8"));
    meta = { base, entries, files: record.manifest.included.length, cutMs, setupMs: Date.now() - started, checked: checked.code === 0, mockFailures: existsSync(join(dir, "carveout", "baseline.json")) ? JSON.parse(readFileSync(join(dir, "carveout", "baseline.json"), "utf8")).failing.length : 0, baseline: { tests: baseline.tests, pass: baseline.pass, fail: baseline.fail } };
  }
  meta.templateVersion = 2;
  writeFileSync(ready, JSON.stringify(meta));
  return { dir, ...meta };
}
