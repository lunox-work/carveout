// The judge E5 and the benchmark share: a clean clone at the base with the
// monorepo installed, the package's tests run without and with the
// coverage gate, a slice's tests run by name, and the in-slice verdict
// against the slice's own baseline. experiments/README.md fixes the rules.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cloneOf, git } from "./lib.mjs";

/** A package's test files, by their path inside the package. */
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|test)\//;
const MEMORY = { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" };

export const log = (tag, line) =>
  process.stderr.write(`[${tag} ${new Date().toISOString().slice(11, 19)}] ${line}\n`);

/** `sh -c`, with the output's tail, never throwing. */
export function shell(cwd, command, { env = MEMORY, timeoutMs = 20 * 60_000 } = {}) {
  const started = Date.now();
  const result = spawnSync("sh", ["-c", command], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, code: result.status, output: output.slice(-6000), full: output, ms: Date.now() - started };
}

/** Test counts from node:test (spec or TAP) and Vitest output, summed. */
export function counts(output) {
  let pass = 0;
  let fail = 0;
  for (const match of output.matchAll(/^(?:ℹ|#) pass (\d+)$/gm)) pass += Number(match[1]);
  for (const match of output.matchAll(/^(?:ℹ|#) fail (\d+)$/gm)) fail += Number(match[1]);
  const vitest = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(output);
  if (vitest !== null) {
    fail += Number(vitest[1] ?? 0);
    pass += Number(vitest[2]);
  }
  return { pass, fail };
}

/** Each test's result by name, from node:test's spec output and Vitest's. */
export function testResults(output) {
  const out = {};
  for (const match of output.matchAll(/^\s*([✔✖]) (.+?) \([\d.]+m?s\)$/gm)) {
    // The summary repeats each failure; a name keeps its first result.
    if (!(match[2] in out)) out[match[2]] = match[1] === "✔";
  }
  for (const match of output.matchAll(/^\s*([✓×]) (.+?)(?: \d+ms)?$/gm))
    if (!(match[2] in out)) out[match[2]] = match[1] === "✓";
  return out;
}

export const show = (repo, ref, path) => {
  const out = spawnSync("git", ["-C", repo, "show", `${ref}:${path}`], { maxBuffer: 256 * 1024 * 1024 });
  return out.status === 0 ? out.stdout : null;
};

/** What the commit changed, by path: A, M or D. */
export function changesOf(repo, commit) {
  const out = new Map();
  const fields = git(repo, ["diff", "--name-status", "--no-renames", "-z", `${commit}^`, commit]).split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) out.set(fields[i + 1], fields[i].charAt(0));
  return out;
}

/** The commit's change split in its package: test files, and code. */
export function packageChange(repo, item) {
  const changes = changesOf(repo, item.commit);
  const inPackage = [...changes.keys()].filter((path) => path.startsWith(`${item.package}/`));
  const tests = inPackage.filter((path) => TEST_FILE.test(path.slice(item.package.length + 1)));
  const code = inPackage.filter((path) => !tests.includes(path) && /\.[cm]?tsx?$/.test(path));
  return { changes, inPackage, tests, code };
}

/**
 * A clean clone at `sha` with the monorepo installed: npm ci only when the
 * lockfile differs from the one installed last. node_modules survive the
 * clean, and nothing else does. `tag` names the clone.
 */
export function target(sha, tag = "e5-target") {
  const clone = cloneOf("sandbox-factory", tag);
  git(clone, ["checkout", "-q", "-f", "--detach", sha]);
  git(clone, ["clean", "-q", "-fdx", "-e", "node_modules", "-e", ".e5-lock"]);
  install(clone, git(clone, ["rev-parse", `${sha}:package-lock.json`]).trim());
  return clone;
}

/** npm ci in `dir` unless its marker says this lockfile is installed. */
export function install(dir, lock) {
  const marker = join(dir, ".e5-lock");
  if (existsSync(marker) && readFileSync(marker, "utf8") === lock) return;
  log("judge", `npm ci in ${basename(dir)} (lockfile ${lock.slice(0, 7)})`);
  const installed = shell(dir, "npx -y npm@10.9.2 ci --ignore-scripts --no-audit --no-fund --loglevel=error", { timeoutMs: 30 * 60_000 });
  if (!installed.ok) throw new Error(`npm ci failed in ${dir}:\n${installed.output}`);
  writeFileSync(marker, lock);
}

/** Builds the package's workspace dependencies, as its tests need them. */
export function buildDependencies(clone, pkg) {
  const { name } = JSON.parse(readFileSync(join(clone, pkg, "package.json"), "utf8"));
  return shell(clone, `npx turbo run build --filter='${name}^...' --output-logs=errors-only`);
}

/**
 * The package's tests: functional (coverage gate stripped) and as written;
 * with `importers`, also a build of every package that depends on it.
 */
export function judge(clone, pkg, { importers = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(clone, pkg, "package.json"), "utf8"));
  const deps = buildDependencies(clone, pkg);
  if (!deps.ok) return { deps: { ok: false, output: deps.output } };
  const script = manifest.scripts.test;
  const functionalScript = script
    .replace(/\s--experimental-test-coverage/g, "")
    .replace(/\s--test-coverage-\S+/g, "")
    .replace(/\s>\s*dist-test\/coverage\.txt[\s\S]*$/, "")
    // Hidden suites sit in a folder of their own under test/.
    .replace(/(\s)dist-test\/test\/\*\.test\.js/, "$1'dist-test/test/**/*.test.js'");
  const bin = `${join(clone, pkg, "node_modules", ".bin")}:${join(clone, "node_modules", ".bin")}:${process.env.PATH}`;
  const functional = shell(join(clone, pkg), functionalScript, { env: { ...MEMORY, PATH: bin } });
  const gate = shell(join(clone, pkg), "npm test --silent");
  const out = {
    deps: { ok: true },
    functional: { ok: functional.ok, ...counts(functional.full), tests: testResults(functional.full), ...(functional.ok ? {} : { output: functional.output }) },
    gate: { ok: gate.ok, ...counts(gate.full), ...(gate.ok ? {} : { output: gate.output.slice(-2000) }) },
  };
  if (importers) {
    const built = shell(clone, `npx turbo run build --filter='...^${manifest.name}' --output-logs=errors-only`);
    out.importers = { ok: built.ok, ...(built.ok ? {} : { output: built.output.slice(-3000) }) };
  }
  return out;
}

/** Lays files of `commit` over the clone: `paths` by their A/M/D status. */
export function overlay(clone, repo, commit, changes, paths) {
  for (const path of paths) {
    const status = changes.get(path);
    if (status === "D") rmSync(join(clone, path), { force: true });
    else {
      mkdirSync(dirname(join(clone, path)), { recursive: true });
      writeFileSync(join(clone, path), show(repo, commit, path));
    }
  }
}

/**
 * The slice's install, build and tests, in a scratch copy, with every
 * test's result: what `carveout check` runs, kept whole.
 */
export function sliceTests(dir) {
  const work = join(dirname(dir), `${basename(dir)}-run`);
  rmSync(work, { recursive: true, force: true });
  cpSync(dir, work, { recursive: true });
  rmSync(join(work, "node_modules"), { recursive: true, force: true });
  try {
    const install = shell(work, existsSync(join(work, "package-lock.json")) ? "npm ci --no-audit --no-fund --loglevel=error" : "npm install --no-audit --no-fund --loglevel=error");
    if (!install.ok) return { ok: false, step: "install", output: install.output.slice(-3000) };
    const build = shell(work, "npm run build --silent");
    if (!build.ok) return { ok: false, step: "build", output: build.output.slice(-3000) };
    const run = shell(work, "node carveout/test.js");
    return {
      ok: run.ok,
      step: "test",
      ...counts(run.full),
      tests: testResults(run.full),
      // What fails npm test besides a test: the coverage gate, or a test
      // the repository's script would not run.
      gateFailed: /coverage does not meet threshold/.test(run.full),
      unrun: /so it would not run these/.test(run.full),
      ...(run.ok ? {} : { output: run.output.slice(-3000) }),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The in-slice verdict against the slice's own baseline: no test that
 * passed before the change fails after it, and the tests the change adds
 * pass. A test failing at baseline fails on the mocks, not on the change.
 */
export function verdictOf(baseline, after) {
  if (!after.ok && after.step !== "test") return { ok: false, reason: `${after.step} failed` };
  const before = baseline.tests ?? {};
  const now = after.tests ?? {};
  const regressions = Object.keys(before).filter((name) => before[name] && now[name] === false);
  const added = Object.keys(now).filter((name) => !(name in before));
  const addedFailing = added.filter((name) => !now[name]);
  return {
    ok: regressions.length === 0 && addedFailing.length === 0 && after.gateFailed !== true && after.unrun !== true,
    ...(after.gateFailed === true ? { gateFailed: true } : {}),
    ...(after.unrun === true ? { unrun: true } : {}),
    regressions,
    added: added.length,
    addedFailing,
    failingAtBaseline: Object.keys(before).filter((name) => !before[name]).length,
  };
}

/** Hidden tests are run separately by the judge, outside the package's glob. */
export function hiddenVerdictOf(baseline, after) {
  return verdictOf(baseline, { ...after, gateFailed: false, unrun: false });
}

/**
 * A seam file as an entry point at `base`. Most seams are files the commit
 * adds, so a person cutting for the ticket starts where the file will go:
 * its nearest folder that exists at the base, through that folder's
 * index.ts when it has one. Chosen from the seam alone, never the diff.
 */
export function seamEntries(repo, base, seam) {
  const exists = (path) => spawnSync("git", ["-C", repo, "cat-file", "-e", `${base}:${path}`]).status === 0;
  const out = new Set();
  for (const path of seam) {
    if (exists(path)) {
      out.add(path);
      continue;
    }
    let dir = dirname(path);
    while (dir !== "." && !exists(dir)) dir = dirname(dir);
    out.add(exists(`${dir}/index.ts`) ? `${dir}/index.ts` : dir);
  }
  return [...out].sort();
}
