// Shared by the experiment scripts: the frozen CLI, scratch clones, history
// and the cut commit C0, as experiments/README.md fixes them.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const WORK = join(HERE, "work");
export const SLICES = JSON.parse(readFileSync(join(HERE, "slices.json"), "utf8"));
export const REPOS = JSON.parse(readFileSync(join(HERE, "repos.local.json"), "utf8"));

export const sh = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).toString("utf8");

export const git = (repo, args) => sh("git", ["-C", repo, ...args]);

const hashTree = (dir) => {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        hash.update(p.slice(dir.length));
        hash.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 12);
};

/** Copies dist/ once per content hash, so a rebuild mid-run changes nothing. */
export function frozenCli() {
  const hash = hashTree(join(ROOT, "dist", "src"));
  const dir = join(WORK, "cli", hash);
  if (!existsSync(join(dir, "dist"))) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(ROOT, "dist", "src"), join(dir, "dist", "src"), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
  }
  const commit = git(ROOT, ["rev-parse", "--short", "HEAD"]).trim();
  const dirty = git(ROOT, ["status", "--porcelain", "--", "src"]).trim() !== "";
  return {
    bin: join(dir, "dist", "src", "cli.js"),
    module: (name) => join(dir, "dist", "src", name),
    id: `${commit}${dirty ? "+dirty" : ""} dist:${hash}`,
  };
}

/** carveout <args>, returning exit code, stdout and stderr. */
export function carveout(cli, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli.bin, ...args], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: "utf8",
    ...options,
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ms: Math.round(performance.now() - started),
  };
}

/** A scratch clone sharing the repository's objects, one per key. */
export function cloneOf(key, tag = "") {
  const source = REPOS[key];
  const dir = join(WORK, "clones", `${key}${tag === "" ? "" : `-${tag}`}`, basename(source));
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    sh("git", ["clone", "-q", "--shared", "--no-checkout", source, dir]);
  }
  return dir;
}

/** Checks out a commit in a scratch clone, and only there. */
export function checkout(clone, sha) {
  if (!clone.startsWith(join(WORK, "clones")))
    throw new Error(`refusing to check out outside the scratch clones: ${clone}`);
  git(clone, ["checkout", "-q", "-f", "--detach", sha]);
  git(clone, ["clean", "-q", "-fdx"]);
}

export const firstParent = (clone, head) =>
  git(clone, ["rev-list", "--first-parent", "--reverse", head])
    .trim()
    .split("\n")
    .filter(Boolean);

/** First-parent commits in (after, head] that touch any path, oldest first. */
export function touching(clone, head, paths, after = null) {
  if (paths.length === 0) return [];
  const range = after === null ? head : `${after}..${head}`;
  const out = [];
  // In chunks: a long path list would pass the argument limit.
  const chunks = [];
  for (let i = 0; i < paths.length; i += 200) chunks.push(paths.slice(i, i + 200));
  const set = new Set();
  for (const chunk of chunks)
    for (const sha of git(clone, [
      "rev-list",
      "--first-parent",
      range,
      "--",
      ...chunk,
    ])
      .trim()
      .split("\n")
      .filter(Boolean))
      set.add(sha);
  for (const sha of firstParent(clone, head)) if (set.has(sha)) out.push(sha);
  return out;
}

export function recordedPaths(record) {
  return [
    ...new Set([
      ...record.manifest.included.map((file) => file.path),
      ...record.manifest.cuts.outbound.map((edge) => edge.to),
      ...record.inputs.map((input) => input.path),
    ]),
  ].sort();
}

export const cutArgs = (slice, out) => [
  "cut",
  ...slice.entries,
  "--depth",
  String(slice.depth),
  "--max-files",
  "200",
  "--offline",
  ...slice.flags,
  "--out",
  out,
];

export function cutAt(cli, clone, slice, sha, out) {
  checkout(clone, sha);
  rmSync(out, { recursive: true, force: true });
  return carveout(cli, [...cutArgs(slice, out), "--repo", clone]);
}

export const exists = (clone, sha, path) =>
  spawnSync("git", ["-C", clone, "cat-file", "-e", `${sha}:${path}`]).status === 0;

/** C0, by experiments/README.md: Common. */
export function chooseC0(cli, clone, slice, scratch) {
  const head = SLICES.repositories[slice.repo].head;
  const headOut = join(scratch, "head-cut");
  const atHead = cutAt(cli, clone, slice, head, headOut);
  if (atHead.code !== 0 && atHead.code !== 2)
    throw new Error(`${slice.id}: no cut at HEAD: ${atHead.stderr}`);
  const record = JSON.parse(readFileSync(join(headOut, "carveout.json"), "utf8"));
  const touched = touching(clone, head, recordedPaths(record));
  const history = firstParent(clone, head);
  const anchor = touched.length >= 50 ? touched[touched.length - 50] : touched[0];
  let index = Math.max(0, history.indexOf(anchor) - 1);
  for (; index < history.length; index++) {
    const sha = history[index];
    if (!slice.entries.every((entry) => exists(clone, sha, entry))) continue;
    const out = join(scratch, "c0");
    const result = cutAt(cli, clone, slice, sha, out);
    if (result.code === 0 || result.code === 2) return { sha, out, history, head };
  }
  throw new Error(`${slice.id}: no commit where the cut succeeds`);
}

/** Every file under dir but carveout.json, path to bytes hash. */
export function treeHashes(dir) {
  const files = new Map();
  const walk = (d, prefix) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(p, rel);
      } else if (rel !== "carveout.json")
        files.set(rel, createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(dir, "");
  return files;
}

export function sameTree(a, b) {
  const x = treeHashes(a);
  const y = treeHashes(b);
  const differ = [];
  for (const path of new Set([...x.keys(), ...y.keys()]))
    if (x.get(path) !== y.get(path)) differ.push(path);
  return differ.sort();
}
