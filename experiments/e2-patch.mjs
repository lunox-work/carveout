// E2: does `git apply --3way` (with --full-index blob ids) carry a patch
// over a moved repository where plain `git apply` cannot?
// node experiments/e2-patch.mjs [slice ids...]  → results/e2.jsonl
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  HERE,
  REPOS,
  SLICES,
  WORK,
  carveout,
  chooseC0,
  cloneOf,
  firstParent,
  frozenCli,
  git,
  touching,
} from "./lib.mjs";

const ts = createRequire(import.meta.url)("typescript");
const cli = frozenCli();
const only = process.argv.slice(2);
const out = join(HERE, "results", "e2.jsonl");
mkdirSync(join(HERE, "results"), { recursive: true });

/** node_modules folders of the live checkout, at its root and its workspaces. */
function borrowed(key) {
  const live = REPOS[key];
  const links = [];
  if (existsSync(join(live, "node_modules"))) links.push("node_modules");
  for (const group of readdirSync(live, { withFileTypes: true }))
    if (group.isDirectory() && group.name !== "node_modules" && !group.name.startsWith("."))
      for (const pkg of readdirSync(join(live, group.name), { withFileTypes: true }))
        if (pkg.isDirectory() && existsSync(join(live, group.name, pkg.name, "node_modules")))
          links.push(`${group.name}/${pkg.name}/node_modules`);
  return links;
}

function unlinkBorrowed(clone, links) {
  for (const link of links) {
    const path = join(clone, link);
    try {
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
    } catch {}
  }
}

/** Checks out in the scratch clone with the borrowed links taken off first. */
function checkoutClean(clone, sha, links) {
  if (!clone.startsWith(join(WORK, "clones"))) throw new Error("not a scratch clone");
  unlinkBorrowed(clone, links);
  git(clone, ["reset", "-q", "--hard"]);
  git(clone, ["checkout", "-q", "-f", "--detach", sha]);
  git(clone, ["clean", "-q", "-fdx"]);
}

function linkBorrowed(clone, key, links) {
  for (const link of links)
    if (existsSync(dirname(join(clone, link))) && !existsSync(join(clone, link)))
      symlinkSync(join(REPOS[key], link), join(clone, link));
}

/** The line after the top-level statement whose end is nearest the middle. */
function insertMarker(path, n) {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const middle = text.length / 2;
  let best = null;
  for (const statement of source.statements) {
    const end = statement.getEnd();
    if (best === null || Math.abs(end - middle) < Math.abs(best - middle)) best = end;
  }
  const at = best === null ? text.length : text.indexOf("\n", best);
  const cut = at === -1 ? text.length : at + 1;
  const marker = `export const carveoutE2Marker${n} = ${n};\n`;
  writeFileSync(path, `${text.slice(0, cut)}${at === -1 ? "\n" : ""}${marker}${text.slice(cut)}`);
}

function nearestTsconfig(clone, file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const candidate = join(clone, dir === "." ? "" : dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (dir === "." || dir === "") return null;
  }
}

/** tsc's errors as (file, code, message), lines left out. */
function typecheck(clone, key, tsconfig) {
  const tsc = join(REPOS[key], "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", tsconfig], {
    cwd: clone,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60_000,
  });
  const errors = new Map();
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const match = /^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line) ?? /^error (TS\d+): (.*)$/.exec(line);
    if (match === null) continue;
    const key = match.length === 4 ? `${match[1]}|${match[2]}|${match[3]}` : `|${match[1]}|${match[2]}`;
    errors.set(key, (errors.get(key) ?? 0) + 1);
  }
  return { errors, timedOut: result.error !== undefined };
}

const added = (base, patched) => {
  const extra = [];
  for (const [key, count] of patched) if (count > (base.get(key) ?? 0)) extra.push(key);
  return extra;
};

for (const slice of SLICES.slices) {
  if (only.length > 0 && !only.includes(slice.id)) continue;
  const clone = cloneOf(slice.repo, "e2");
  const links = borrowed(slice.repo);
  unlinkBorrowed(clone, links);
  const scratch = join(WORK, "e2", slice.id);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const c0 = chooseC0(cli, clone, slice, scratch);
  const record = JSON.parse(readFileSync(join(c0.out, "carveout.json"), "utf8"));
  const scripts = record.manifest.included
    .map((file) => file.path)
    .filter((path) => /\.[cm]?tsx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path));
  const changes = new Map(
    scripts.map((path) => [path, touching(clone, c0.head, [path], c0.sha).length]),
  );
  const edited = [...scripts]
    .sort((a, b) => changes.get(b) - changes.get(a) || (a < b ? -1 : 1))
    .slice(0, 2);
  edited.forEach((path, index) => insertMarker(join(c0.out, path), index + 1));
  const patchFile = join(scratch, "edit.patch");
  const patch = carveout(cli, ["patch", c0.out, "--output", patchFile]);
  if (patch.code !== 0) throw new Error(`${slice.id}: patch failed: ${patch.stderr}`);
  const cases = touching(clone, c0.head, edited, c0.sha).slice(0, 50);
  process.stderr.write(`${slice.id}: C0 ${c0.sha.slice(0, 10)}, edited ${edited.join(", ")}, ${cases.length} cases\n`);
  const baselines = new Map();
  for (const sha of cases) {
    checkoutClean(clone, sha, links);
    const present = edited.filter((path) => existsSync(join(clone, path)));
    const plain = spawnSync("git", ["-C", clone, "apply", "--check", patchFile]).status === 0;
    const three = spawnSync("git", ["-C", clone, "apply", "--3way", patchFile], { encoding: "utf8" });
    const unmerged = git(clone, ["diff", "--name-only", "--diff-filter=U"]).trim();
    const threeWay = three.status === 0 && unmerged === "";
    let typechecks = null;
    let newErrors = [];
    let baseErrors = null;
    let patchedErrors = null;
    if (threeWay) {
      const configs = [...new Set(present.map((path) => nearestTsconfig(clone, path)).filter(Boolean))];
      // Baseline: the same commit without the patch.
      const patched = new Map();
      linkBorrowed(clone, slice.repo, links);
      for (const config of configs) patched.set(config, typecheck(clone, slice.repo, config));
      unlinkBorrowed(clone, links);
      git(clone, ["reset", "-q", "--hard"]);
      linkBorrowed(clone, slice.repo, links);
      for (const config of configs) {
        const key = `${sha}|${config}`;
        if (!baselines.has(key)) baselines.set(key, typecheck(clone, slice.repo, config));
        newErrors.push(...added(baselines.get(key).errors, patched.get(config).errors));
        const total = (errors) => [...errors.values()].reduce((a, b) => a + b, 0);
        baseErrors = (baseErrors ?? 0) + total(baselines.get(key).errors);
        patchedErrors = (patchedErrors ?? 0) + total(patched.get(config).errors);
      }
      typechecks = newErrors.length === 0;
    }
    const line = {
      experiment: "E2",
      cli: cli.id,
      slice: slice.id,
      repo: slice.repo,
      c0: c0.sha,
      commit: sha,
      edited,
      editedPresent: present.length,
      plain,
      threeWay,
      typechecks,
      newErrors: newErrors.slice(0, 5),
      baseErrors,
      patchedErrors,
    };
    appendFileSync(out, `${JSON.stringify(line)}\n`);
  }
  checkoutClean(clone, c0.head, links);
}
