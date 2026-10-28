/**
 * Moving changes between a slice and its repository, both ways.
 *
 * `applyPatch` brings a repository patch into a slice: it applies the
 * patch to a scratch clone at the cut's commit, cuts again in memory with
 * the recorded request, and writes the slice's files the patch touched as
 * that cut writes them, imports rewritten. Paths outside the slice and
 * stubs the change would need are reported; nothing else in the folder or
 * its record changes, so `patch` still diffs against the cut's commit.
 *
 * `mergeProject` takes a slice's edits the other way: `patch`, then
 * `git apply --3way` into a checkout the caller names, then a verify
 * command there. It never picks a checkout on its own.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  RECORD_PATH,
  computeCut,
  patchProject,
  readRecord,
  type CarveoutRecord,
  type ComputedCut,
  type Patch,
} from "./carve.js";
import {
  isTestPath,
  runtimePath,
  type ImportRewrite,
  type IncludedFile,
} from "./core.js";
import { symbolDiff } from "./status.js";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=carveout", "-c", "user.email=carveout@localhost", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
  ).toString("utf8");
}

export interface Applied {
  /** Slice files the patch changed, now as a cut of the patched repository writes them. */
  readonly changed: readonly string[];
  /** Files the patch adds that a cut of the patched repository reaches. */
  readonly added: readonly string[];
  readonly deleted: readonly string[];
  /** Paths the patch touches that the slice does not hold. */
  readonly outside: readonly string[];
  /**
   * Stubs a cut of the patched repository writes differently: what the
   * change needs from the modules the slice cuts. Written only when asked.
   */
  readonly stubs: readonly { path: string; detail: string; written: boolean }[];
}

/**
 * Brings `patchText`, a patch for the repository at the cut's commit, into
 * the folder. `stubs` also writes the stubs and mocks the change needs, and
 * records them as generated.
 */
export async function applyPatch(
  dir: string,
  patchText: string,
  options: { readonly stubs?: boolean; readonly log?: (line: string) => void } = {},
): Promise<Applied> {
  const root = resolve(dir);
  const record = readRecord(root);
  const commit = record.manifest.sourceCommitSha;
  if (commit === null)
    throw new Error("The cut was not made in a Git checkout, so there is no commit to apply the patch at.");
  const scratch = mkdtempSync(join(tmpdir(), "carveout-apply-"));
  const repo = join(scratch, "repo");
  try {
    git(scratch, ["clone", "-q", "--shared", "--no-checkout", record.repo, repo]);
    git(repo, ["checkout", "-q", "--detach", commit]);
    const file = join(scratch, "change.patch");
    writeFileSync(file, patchText);
    try {
      git(repo, ["apply", "--whitespace=nowarn", file]);
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
      throw new Error(`The patch does not apply at the cut's commit ${commit.slice(0, 12)}: ${stderr.trim()}`);
    }
    git(repo, ["add", "-A"]);
    const touched = new Map<string, "A" | "M" | "D">();
    const fields = git(repo, ["diff", "--cached", "--name-status", "--no-renames", "-z"]).split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = (fields[i] ?? "").charAt(0);
      const path = fields[i + 1] ?? "";
      if (path !== "")
        touched.set(path, status === "A" ? "A" : status === "D" ? "D" : "M");
    }
    const request = {
      repo,
      entryPoints: record.request.entryPoints,
      budget: record.request.budget,
      choices: record.request.choices,
      offline: record.request.offline,
      widenLiterals: record.request.widenLiterals,
      tests: record.request.tests === true,
      ...(options.log === undefined ? {} : { log: options.log }),
    };
    const cuts: ComputedCut[] = [await computeCut(request)];
    const reached = (cut: ComputedCut) =>
      new Set(cut.record.manifest.included.map((file) => file.path));
    // A test the patch adds is reached only from the tests' side: cut again
    // bringing tests along, with room for them, and take only those.
    const tests = [...touched.entries()].filter(
      ([path, status]) => status !== "D" && isTestPath(path) && !reached(cuts[0]!).has(path),
    );
    if (tests.length > 0)
      cuts.push(
        await computeCut({
          ...request,
          tests: true,
          budget: {
            ...record.request.budget,
            maxFiles: record.request.budget.maxFiles + tests.length,
          },
        }),
      );
    const included = new Set(record.manifest.included.map((file) => file.path));
    const changed: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];
    const outside: string[] = [];
    const grown: IncludedFile[] = [];
    const rewrites: ImportRewrite[] = [];
    for (const [path, status] of [...touched.entries()].sort(([a], [b]) => compare(a, b))) {
      if (status === "D") {
        if (included.has(path)) {
          await rm(join(root, path), { force: true });
          deleted.push(path);
        } else outside.push(path);
        continue;
      }
      const cut = cuts.find(
        (candidate, index) =>
          reached(candidate).has(path) && (index === 0 || isTestPath(path)),
      );
      if (cut === undefined) {
        outside.push(path);
        continue;
      }
      const text = cut.binaries.includes(path)
        ? null
        : cut.files.find((item) => item.path === path)?.text;
      if (text === undefined) {
        outside.push(path);
        continue;
      }
      await mkdir(dirname(join(root, path)), { recursive: true });
      if (text === null) await copyFile(join(repo, path), join(root, path));
      else await writeFile(join(root, path), text);
      if (!included.has(path) && status === "M") {
        // A repository file the slice did not hold: it joins the slice at
        // the bytes of the cut's commit, so `patch` diffs it from there.
        grown.push(includedAt(repo, path));
        rewrites.push(...cut.record.importRewrites.filter((rewrite) => rewrite.file === path));
      }
      (included.has(path) || status === "M" ? changed : added).push(path);
    }
    const stubs = await neededStubs(root, record, cuts, options.stubs === true);
    if (grown.length > 0) {
      const current = readRecord(root);
      const updated: CarveoutRecord = {
        ...current,
        manifest: {
          ...current.manifest,
          included: [...current.manifest.included, ...grown].sort((a, b) => compare(a.path, b.path)),
        },
        importRewrites: [...current.importRewrites, ...rewrites].sort((a, b) =>
          compare(`${a.file}\n${a.from}`, `${b.file}\n${b.from}`),
        ),
      };
      await writeFile(join(root, RECORD_PATH), `${JSON.stringify(updated, null, 2)}\n`);
    }
    return { changed, added, deleted, outside, stubs };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A file as the slice's record holds it, at the clone's HEAD (the cut's commit). */
function includedAt(repo: string, path: string): IncludedFile {
  const bytes = execFileSync("git", ["show", `HEAD:${path}`], { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
  const [mode = "100644", , blobId = ""] = git(repo, ["ls-tree", "HEAD", "--", path]).trim().split(/\s+/);
  return { path, blobId, sha256: sha256(bytes), mode, sizeBytes: bytes.length, operations: ["edit"] };
}

/** Stubs the cuts write that the folder's record says it does not hold. */
async function neededStubs(
  root: string,
  record: CarveoutRecord,
  cuts: readonly ComputedCut[],
  write: boolean,
): Promise<Applied["stubs"]> {
  const generated = new Map(record.generated.map((file) => [file.path, file.sha256]));
  const wanted = new Map<string, string>();
  for (const cut of cuts)
    for (const file of cut.files)
      if (file.class === "stub" || file.class === "mock") wanted.set(file.path, file.text);
  const found: { path: string; detail: string; written: boolean }[] = [];
  const writes: { path: string; text: string }[] = [];
  for (const [path, text] of [...wanted.entries()].sort(([a], [b]) => compare(a, b))) {
    const was = generated.get(path);
    if (was === sha256(text)) continue;
    writes.push({ path, text });
    // The declaration names the difference; its runtime follows it.
    if (!/\.d\.[cm]?ts$/.test(path)) continue;
    const old = existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
    found.push({
      path,
      detail:
        was === undefined || old === null
          ? `${runtimePath(path)}: a module the change needs and the slice did not cut.`
          : symbolDiff(old, text),
      written: write,
    });
  }
  if (write && writes.length > 0) {
    for (const { path, text } of writes) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const hashes = new Map(generated);
    for (const { path, text } of writes) hashes.set(path, sha256(text));
    const updated: CarveoutRecord = {
      ...record,
      generated: [...hashes.entries()]
        .map(([path, hash]) => ({ path, sha256: hash }))
        .sort((a, b) => compare(a.path, b.path)),
    };
    await writeFile(join(root, RECORD_PATH), `${JSON.stringify(updated, null, 2)}\n`);
  }
  return found;
}

export interface MergeStep {
  readonly step: "patch" | "apply" | "verify";
  readonly ok: boolean;
  readonly output: string;
}

export interface Merge {
  readonly patch: Patch;
  readonly steps: readonly MergeStep[];
  readonly ok: boolean;
}

/**
 * The folder's edits merged into `into`, a checkout of the repository the
 * caller chose: `git apply --3way` there, then `verify` as a shell command
 * at its root. Stops at the first step that fails.
 */
export async function mergeProject(
  dir: string,
  options: { readonly into: string; readonly verify?: string },
): Promise<Merge> {
  const into = resolve(options.into);
  if (!existsSync(join(into, ".git")))
    throw new Error(`${into} is not the root of a Git checkout.`);
  const patch = await patchProject(dir);
  const steps: MergeStep[] = [];
  if (patch.diff === "") {
    steps.push({ step: "patch", ok: false, output: "No edits to the slice." });
    return { patch, steps, ok: false };
  }
  steps.push({
    step: "patch",
    ok: true,
    output: `${patch.changed.length} changed, ${patch.added.length} new, ${patch.deleted.length} deleted.`,
  });
  const scratch = mkdtempSync(join(tmpdir(), "carveout-merge-"));
  try {
    const file = join(scratch, "slice.patch");
    writeFileSync(file, patch.diff);
    const apply = spawnSync("git", ["apply", "--3way", "--whitespace=nowarn", file], {
      cwd: into,
      encoding: "utf8",
    });
    const applied = apply.status === 0;
    steps.push({
      step: "apply",
      ok: applied,
      output: `${apply.stdout ?? ""}${apply.stderr ?? ""}`.trim(),
    });
    if (applied && options.verify !== undefined) {
      const verify = spawnSync("sh", ["-c", options.verify], {
        cwd: into,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      steps.push({
        step: "verify",
        ok: verify.status === 0,
        output: `${verify.stdout ?? ""}${verify.stderr ?? ""}`.slice(-20_000),
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { patch, steps, ok: steps.every((step) => step.ok) };
}
