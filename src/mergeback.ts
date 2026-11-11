/**
 * Moving changes between a slice and its repository, both ways.
 *
 * `applyPatch` brings a repository patch into a slice: it applies the
 * patch to a scratch clone at the cut's commit, cuts again in memory with
 * the recorded request, and writes the slice's files the patch touched as
 * that cut writes them, imports rewritten. A module the patch adds past
 * the cut's reach joins the slice as an entry of its own, with its tests.
 * Paths outside the slice and stubs the change would need are reported;
 * nothing else in the folder or its record changes, so `patch` still diffs
 * against the cut's commit.
 *
 * `mergeProject` takes a slice's edits the other way: `patch`, then
 * `git apply --3way` into a checkout the caller names, then a verify
 * command there. It never picks a checkout on its own.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  checkRecordFiles,
  computeCut,
  cutSlice,
  patchProject,
  type CarveoutRecord,
  type CutResult,
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
import { trustedRepo } from "./policy.js";
import { folderView, saveRecord, trustedCut } from "./receipt.js";
import { fromFolder, looseLeaks, toFolder, wordsToFolder, type FolderPseudonyms } from "./pseudonyms/index.js";

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
  /** Slice files the folder had edited, the change merged into them (three-way). */
  readonly merged: readonly string[];
  /**
   * Slice files where the folder's edit and the change overlap: left as the
   * folder had them, for a person to merge.
   */
  readonly conflicts: readonly string[];
  /**
   * Names the repository goes by that what the command wrote into a folder
   * in pseudonyms still holds (a term the cut found nowhere, so has no
   * placeholder for; a binary file): the folder must not go out as it is.
   * By term, with the folder paths it is in.
   */
  readonly leaks: readonly { readonly term: string; readonly files: readonly string[] }[];
}

/** `theirs` merged into `ours` from `base`, as `git merge-file` does; conflicts when they overlap. */
function mergeText(scratch: string, ours: string, base: string, theirs: string): { text: string; conflicts: boolean } {
  const at = mkdtempSync(join(scratch, "merge-"));
  writeFileSync(join(at, "ours"), ours);
  writeFileSync(join(at, "base"), base);
  writeFileSync(join(at, "theirs"), theirs);
  const result = spawnSync("git", ["merge-file", "-p", join(at, "ours"), join(at, "base"), join(at, "theirs")], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status === null || result.status < 0) throw new Error(`git merge-file failed: ${result.stderr}`);
  return { text: result.stdout, conflicts: result.status > 0 };
}

/**
 * Brings `patchText`, a patch for the repository at the cut's commit, into
 * the folder. `stubs` also writes the stubs and mocks the change needs, and
 * records them as generated.
 */
/** The nearest ancestor of `path` with a package.json, relative to the repository; "" at the root. */
function packageDirOf(repo: string, path: string): string {
  let dir = dirname(path);
  while (dir !== "." && dir !== "") {
    if (existsSync(join(repo, dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return "";
}

export async function applyPatch(
  dir: string,
  patchText: string,
  options: {
    readonly stubs?: boolean;
    readonly log?: (line: string) => void;
    /** The repository's checkout; else the one the record names. */
    readonly repo?: string;
    /** The cut's receipt file; else the one `CARVEOUT_HOME` keeps for its id. */
    readonly receipt?: string;
    /** No receipt: the folder's own record is all there is. */
    readonly noReceipt?: boolean;
    /**
     * Filled with each slice file the command wrote, by repository path:
     * the hash of the file as the cut of the patched repository writes it,
     * in the repository's names and in the folder's, whatever the folder's
     * own edits merged into it. What `refresh` moves the folder's base to.
     */
    readonly written?: Map<string, { readonly folderPath: string; readonly sha256: string; readonly folderSha256: string }>;
  } = {},
): Promise<Applied> {
  const root = resolve(dir);
  let trusted = trustedCut(root, options.receipt, options.noReceipt === true ? { noReceipt: true } : {});
  // A public folder in pseudonyms takes the change in its own names: each
  // file at its folder path, its text renamed by the receipt's table.
  const names = namesOf(trusted.receipt?.pseudonyms);
  const record = trusted.record;
  const source = trustedRepo(record, options.repo);
  checkRecordFiles(record, source);
  const commit = record.manifest.sourceCommitSha;
  if (commit === null)
    throw new Error("The cut was not made in a Git checkout, so there is no commit to apply the patch at.");
  const scratch = mkdtempSync(join(tmpdir(), "carveout-apply-"));
  const repo = join(scratch, "repo");
  try {
    git(scratch, ["clone", "-q", "--shared", "--no-checkout", source, repo]);
    git(repo, ["checkout", "-q", "--detach", commit]);
    // The slice files the folder holds edits in, by their folder paths: the
    // change is merged into those, never written over them.
    const view = trusted.receipt === null ? record : folderView(trusted.receipt);
    const editedInFolder = new Set(
      (view.copied ?? [])
        .filter((file) => {
          const at = join(root, file.path);
          return existsSync(at) && createHash("sha256").update(readFileSync(at)).digest("hex") !== file.sha256;
        })
        .map((file) => file.path),
    );
    const file = join(scratch, "change.patch");
    writeFileSync(file, patchText);
    try {
      git(repo, ["apply", "--whitespace=nowarn", file]);
    } catch (plain) {
      // A patch made against an earlier commit (a folder widened after the
      // repository moved) merges by the blobs its index lines name.
      try {
        git(repo, ["apply", "--3way", "--whitespace=nowarn", file]);
        git(repo, ["reset", "-q"]);
      } catch {
        const stderr = (plain as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
        throw new Error(`The patch does not apply at the cut's commit ${commit.slice(0, 12)}: ${stderr.trim()}`);
      }
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
      ...(record.request.live === undefined ? {} : { live: record.request.live }),
      // The cut's own bounds: a private path given as a flag stays private,
      // and a public folder stays public, when the cut is made again.
      wholePackage: record.request.wholePackage === true,
      followWorkspaces: record.request.followWorkspaces === true,
      copyPure: record.request.copyPure === true,
      private: record.request.private ?? [],
      copy: record.request.copy ?? [],
      public: record.request.public === true,
      ...(options.log === undefined ? {} : { log: options.log }),
    };
    const cuts: ComputedCut[] = [await computeCut(request)];
    // The text the cut wrote for each slice file, for the three-way merge:
    // a cut of the repository at the cut's commit, before the change.
    let baseCut: ComputedCut | null = null;
    if (editedInFolder.size > 0) {
      const baseRepo = join(scratch, "base");
      git(scratch, ["clone", "-q", "--shared", "--no-checkout", source, baseRepo]);
      git(baseRepo, ["checkout", "-q", "--detach", commit]);
      baseCut = await computeCut({ ...request, repo: baseRepo });
    }
    const reached = (cut: ComputedCut) =>
      new Set(cut.record.manifest.included.map((file) => file.path));
    // What the patch adds that the entries do not reach is still the
    // change: a module added past the depth, and the tests of it or of the
    // slice, which are reached only from the tests' side. Cut again with
    // the added modules as entries too, bringing tests along, with room for
    // them, and take only those files from it.
    const first = reached(cuts[0]!);
    const beyond = [...touched.entries()].filter(
      ([path, status]) => status !== "D" && !first.has(path),
    );
    // Only within the packages the slice holds: a module another package
    // gains is outside, as before. Taken in, it builds against mocks it
    // was never cut for and its imports come back rewritten (Phase 7's
    // E5: every cross-package commit failed the round trip).
    const packages = new Set([...first].map((path) => packageDirOf(repo, path)));
    const within = (path: string) => packages.has(packageDirOf(repo, path));
    const modules = beyond
      .filter(([path, status]) => status === "A" && !isTestPath(path) && /\.[cm]?[jt]sx?$/.test(path) && within(path))
      .map(([path]) => path);
    if (modules.length > 0 || beyond.some(([path]) => isTestPath(path) && within(path)))
      cuts.push(
        await computeCut({
          ...request,
          entryPoints: [...request.entryPoints, ...modules],
          tests: true,
          budget: {
            ...record.request.budget,
            maxFiles: record.request.budget.maxFiles + beyond.length,
          },
        }),
      );
    const included = new Set(record.manifest.included.map((file) => file.path));
    const changed: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];
    const outside: string[] = [];
    const merged: string[] = [];
    const conflicts: string[] = [];
    const grown: IncludedFile[] = [];
    const rewrites: ImportRewrite[] = [];
    /** Folder paths the command wrote, for the leak scan. */
    const wrote: string[] = [];
    /** Each slice file written, by repository path, as the cut writes it (the folder's edits aside). */
    const newly = new Map<string, { folderPath: string; sha256: string; folderSha256: string }>();
    for (const [path, status] of [...touched.entries()].sort(([a], [b]) => compare(a, b))) {
      if (status === "D") {
        if (included.has(path)) {
          // A file the folder edited is never deleted under it.
          if (editedInFolder.has(names.path(path))) {
            conflicts.push(path);
            continue;
          }
          await rm(join(root, names.path(path)), { force: true });
          deleted.push(path);
        } else outside.push(path);
        continue;
      }
      const cut = cuts.find((candidate) => reached(candidate).has(path));
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
      await mkdir(dirname(join(root, names.path(path))), { recursive: true });
      const folderPath = names.path(path);
      const base = baseCut?.files.find((item) => item.path === path)?.text;
      if (editedInFolder.has(folderPath) && (text === null || base === undefined)) {
        // The folder edited a file the change writes and there is no text
        // at the cut's commit to merge from (one an earlier apply added, a
        // binary): left as the folder has it, for a person.
        conflicts.push(path);
        continue;
      }
      if (text !== null && editedInFolder.has(folderPath) && base !== undefined) {
        // The folder's edit, read back in the repository's names, with the
        // change merged in; left alone where the two overlap.
        const ours = names.back(folderPath, readFileSync(join(root, folderPath), "utf8"));
        const result = mergeText(scratch, ours, base, text);
        if (result.conflicts) {
          conflicts.push(path);
          continue;
        }
        await writeFile(join(root, folderPath), names.text(path, result.text));
        merged.push(path);
      } else if (text === null) await copyFile(join(repo, path), join(root, folderPath));
      else await writeFile(join(root, folderPath), names.text(path, text));
      wrote.push(folderPath);
      const clean =
        text === null
          ? (() => {
              const bytes = readFileSync(join(repo, path));
              return { folderPath, sha256: sha256(bytes), folderSha256: sha256(bytes) };
            })()
          : { folderPath, sha256: sha256(text), folderSha256: sha256(names.text(path, text)) };
      newly.set(path, clean);
      options.written?.set(path, clean);
      if (!included.has(path) && status === "M") {
        // A repository file the slice did not hold: it joins the slice at
        // the bytes of the cut's commit, so `patch` diffs it from there.
        grown.push(includedAt(repo, path));
        rewrites.push(...cut.record.importRewrites.filter((rewrite) => rewrite.file === path));
      }
      (included.has(path) || status === "M" ? changed : added).push(path);
    }
    const stubs = await neededStubs(root, record, cuts, options.stubs === true, names, (updated, written) => {
      wrote.push(...Object.keys(written));
      trusted = saveRecord(root, trusted, updated, written);
    });
    // A file the change added or the slice grew is the folder's copy from
    // now on, at what the command wrote: a later apply sees the folder's
    // edits to it, and merges into them or leaves them, never over them.
    const copiedNow = new Set((trusted.record.copied ?? []).map((file) => file.path));
    const fresh = trusted.record.copied === undefined ? [] : [...newly.entries()].filter(([path]) => !copiedNow.has(path));
    if (grown.length > 0 || fresh.length > 0) {
      const current = trusted.record;
      const updated: CarveoutRecord = {
        ...current,
        manifest: {
          ...current.manifest,
          included: [...current.manifest.included, ...grown].sort((a, b) => compare(a.path, b.path)),
        },
        importRewrites: [...current.importRewrites, ...rewrites].sort((a, b) =>
          compare(`${a.file}\n${a.from}`, `${b.file}\n${b.from}`),
        ),
        ...(current.copied === undefined
          ? {}
          : {
              copied: [...current.copied, ...fresh.map(([path, { sha256: hash }]) => ({ path, sha256: hash }))].sort((a, b) =>
                compare(a.path, b.path),
              ),
            }),
      };
      trusted = saveRecord(root, trusted, updated, {}, new Map(fresh.map(([, { folderPath, folderSha256 }]) => [folderPath, folderSha256])));
    }
    return { changed, added, deleted, outside, stubs, merged, conflicts, leaks: leaksIn(root, wrote, trusted.receipt?.pseudonyms) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** How a path and a text in the repository's names are put in the folder's, and back. */
interface Names {
  readonly path: (path: string) => string;
  readonly text: (path: string, text: string) => string;
  readonly back: (folderPath: string, text: string) => string;
}

/** The folder's names for a cut in pseudonyms (its table), or the repository's own. */
function namesOf(table: FolderPseudonyms | undefined): Names {
  if (table === undefined) return { path: (path) => path, text: (_path, text) => text, back: (_path, text) => text };
  // The table's rules, then a placeholder for each term they did not reach:
  // a file the repository added since the cut, or a line it wrote, spells
  // a term where no rule of the cut's matches.
  return {
    path: (path) => wordsToFolder(table, toFolder(table, path, "").path),
    text: (path, text) => wordsToFolder(table, toFolder(table, path, text).text),
    back: (path, text) => fromFolder(table, path, text).text,
  };
}

/** The names a folder in pseudonyms must not hold, in the files a command wrote there. */
function leaksIn(root: string, paths: readonly string[], table: FolderPseudonyms | undefined): Applied["leaks"] {
  if (table === undefined || paths.length === 0) return [];
  const files = [...new Set(paths)].sort(compare).flatMap((path) => {
    const at = join(root, path);
    if (!existsSync(at)) return [];
    const bytes = readFileSync(at);
    return [{ path, text: bytes.includes(0) ? bytes.toString("latin1") : bytes.toString("utf8") }];
  });
  return looseLeaks(files, table.vocabulary, table.kept).map(({ term, files: found }) => ({ term, files: found }));
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
  names: Names,
  save: (updated: CarveoutRecord, written: Readonly<Record<string, string>>) => void,
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
    const held = join(root, names.path(path));
    const old = existsSync(held) ? names.back(names.path(path), readFileSync(held, "utf8")) : null;
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
      await mkdir(dirname(join(root, names.path(path))), { recursive: true });
      await writeFile(join(root, names.path(path)), names.text(path, text));
    }
    const hashes = new Map(generated);
    for (const { path, text } of writes) hashes.set(path, sha256(text));
    const updated: CarveoutRecord = {
      ...record,
      generated: [...hashes.entries()]
        .map(([path, hash]) => ({ path, sha256: hash }))
        .sort((a, b) => compare(a.path, b.path)),
    };
    save(updated, Object.fromEntries(writes.map(({ path, text }) => [names.path(path), names.text(path, text)])));
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
  options: {
    readonly into: string;
    readonly verify?: string;
    /** The repository's checkout to diff against; else `into`, else the record's. */
    readonly repo?: string;
    /** Paths and globs the hand-off policy lets through. */
    readonly allow?: readonly string[];
    /** Environment variables the verify command is given, by name. */
    readonly verifyEnv?: readonly string[];
    /** The cut's receipt file; else the one `CARVEOUT_HOME` keeps for its id. */
    readonly receipt?: string;
    /** No receipt: judge the folder by its own record. */
    readonly noReceipt?: boolean;
  },
): Promise<Merge> {
  const into = resolve(options.into);
  if (!existsSync(join(into, ".git")))
    throw new Error(`${into} is not the root of a Git checkout.`);
  const patch = await patchProject(dir, {
    repo: options.repo ?? into,
    ...(options.allow === undefined ? {} : { allow: options.allow }),
    ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
    ...(options.noReceipt === true ? { noReceipt: true } : {}),
  });
  const steps: MergeStep[] = [];
  // Nothing is applied while the policy keeps a path out: the maintainer
  // reads those first, then allows them or asks for the change without.
  if (patch.refused.length > 0) {
    steps.push({
      step: "patch",
      ok: false,
      output: `Kept out by the hand-off policy, so nothing was applied:\n${patch.refused
        .map((refusal) => `  ${refusal.path}: ${refusal.reason}`)
        .join("\n")}`,
    });
    return { patch, steps, ok: false };
  }
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
      // The command runs code the folder brought: a minimal environment
      // and a scratch HOME, so it reads no credential of the caller's but
      // what is passed by name.
      const home = join(scratch, "home");
      mkdirSync(home, { recursive: true });
      const env: Record<string, string> = { HOME: home, PATH: process.env["PATH"] ?? "", CI: "1" };
      for (const name of options.verifyEnv ?? []) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      const verify = spawnSync("sh", ["-c", options.verify], {
        cwd: into,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env,
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

export interface Widened {
  /** The new, wider folder. */
  readonly out: string;
  readonly cut: CutResult;
  /** The contributor's work in the folder widened, as a patch for the repository. */
  readonly patch: Patch;
  /** That work, brought into the new folder; null when there was none. */
  readonly applied: Applied | null;
}

/**
 * A folder cut again, wider, with the contributor's work in it: a change
 * that turns out to need a module the slice cut. The work so far is taken
 * as a patch (`patchProject`: none of its code runs, and a file the policy
 * holds stops the widening), the cut is made again with the entries added
 * and every other bound as it was, its pseudonyms keep the placeholders the
 * folder had where they fit, and the work is applied to the new folder in
 * its names. The old folder is left as it was.
 */
export async function widenProject(
  dir: string,
  options: {
    readonly entries: readonly string[];
    readonly out?: string;
    readonly maxDepth?: number;
    readonly maxFiles?: number;
    readonly receipt?: string;
    readonly noReceipt?: boolean;
    readonly repo?: string;
    readonly allow?: readonly string[];
    readonly log?: (line: string) => void;
  },
): Promise<Widened> {
  const root = resolve(dir);
  const trusted = trustedCut(root, options.receipt, options.noReceipt === true ? { noReceipt: true } : {});
  const repo = trustedRepo(trusted.record, options.repo);
  const patch = await patchProject(root, {
    repo,
    ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
    ...(options.noReceipt === true ? { noReceipt: true } : {}),
    ...(options.allow === undefined ? {} : { allow: options.allow }),
  });
  if (patch.refused.length > 0)
    throw new Error(
      `The folder's work holds what the hand-off policy keeps out, which a wider folder would carry on:\n${patch.refused
        .map((refusal) => `  ${refusal.path}: ${refusal.reason}`)
        .join("\n")}\nRead those files, and pass --allow for the ones you accept.`,
    );
  const request = trusted.record.request;
  const out = resolve(options.out ?? `${root}-wide`);
  const cut = await cutSlice({
    repo,
    out,
    entryPoints: [...new Set([...request.entryPoints, ...options.entries])],
    budget: {
      maxFiles: options.maxFiles ?? request.budget.maxFiles,
      maxDepth: options.maxDepth ?? request.budget.maxDepth,
    },
    choices: request.choices,
    offline: request.offline,
    widenLiterals: request.widenLiterals,
    tests: request.tests === true,
    ...(request.live === undefined ? {} : { live: request.live }),
    wholePackage: request.wholePackage === true,
    followWorkspaces: request.followWorkspaces === true,
    copyPure: request.copyPure === true,
    private: request.private ?? [],
    copy: request.copy ?? [],
    public: request.public === true,
    ...(request.task === undefined ? {} : { task: request.task }),
    ...(trusted.receipt?.pseudonyms === undefined ? {} : { earlierPseudonyms: trusted.receipt.pseudonyms }),
    ...(trusted.receipt === null ? { receipt: false as const } : {}),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const applied =
    patch.diff === ""
      ? null
      : await applyPatch(out, patch.diff, {
          repo,
          ...(cut.receipt === null ? { noReceipt: true } : { receipt: cut.receipt }),
          ...(options.log === undefined ? {} : { log: options.log }),
        });
  return { out, cut, patch, applied };
}

/**
 * The repository's commits since the cut, brought into the folder: the
 * change from the cut's commit to the checkout's HEAD in the packages the
 * slice holds files of and in the modules it stubs, applied as `apply`
 * applies a patch (the folder's own edits merged, an overlap left for a
 * person, the stubs the change needs written). For a job long enough that
 * the repository moves under it. Null when nothing it reads has moved.
 */
export async function refreshProject(
  dir: string,
  options: {
    readonly repo?: string;
    readonly receipt?: string;
    readonly noReceipt?: boolean;
    readonly log?: (line: string) => void;
  } = {},
): Promise<{ readonly from: string; readonly to: string; readonly applied: Applied } | null> {
  const root = resolve(dir);
  const trusted = trustedCut(root, options.receipt, options.noReceipt === true ? { noReceipt: true } : {});
  const record = trusted.record;
  const repo = trustedRepo(record, options.repo);
  const from = record.manifest.sourceCommitSha;
  if (from === null) throw new Error("The cut was not made in a Git checkout: there is no commit to refresh from.");
  const to = git(repo, ["rev-parse", "HEAD"]).trim();
  const packages = [...new Set(record.manifest.included.map((file) => packageDirOf(repo, file.path)))];
  const stubbed = [...new Set(record.manifest.cuts.outbound.map((edge) => edge.to))];
  const paths = [...new Set([...packages.map((dir) => (dir === "" ? "." : dir)), ...stubbed])].sort(compare);
  const change = git(repo, ["diff", "--binary", "--full-index", from, to, "--", ...paths]);
  if (change.trim() === "") return null;
  const written = new Map<string, { folderPath: string; sha256: string; folderSha256: string }>();
  const applied = await applyPatch(root, change, {
    stubs: true,
    repo,
    written,
    ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
    ...(options.noReceipt === true ? { noReceipt: true } : {}),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  // The repository holds these commits: the folder's base moves to them, so
  // a patch of it carries the contributor's work alone, not the commits it
  // was brought (and `git apply` takes it at the new HEAD). Not past an
  // overlap, which leaves a file at the old base for a person to merge.
  if (applied.conflicts.length === 0) {
    const now = trustedCut(root, options.receipt, options.noReceipt === true ? { noReceipt: true } : {});
    const gone = new Set(applied.deleted);
    const known = new Set(now.record.manifest.included.map((file) => file.path));
    const atTo = (path: string): IncludedFile => {
      const bytes = execFileSync("git", ["show", `${to}:${path}`], { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
      const [mode = "100644", , blobId = ""] = git(repo, ["ls-tree", to, "--", path]).trim().split(/\s+/);
      return { path, blobId, sha256: sha256(bytes), mode, sizeBytes: bytes.length, operations: ["edit"] };
    };
    const included = [
      ...now.record.manifest.included.filter((file) => !gone.has(file.path)).map((file) => (written.has(file.path) ? { ...file, ...atTo(file.path) } : file)),
      ...[...written.keys()].filter((path) => !known.has(path)).map(atTo),
    ].sort((a, b) => compare(a.path, b.path));
    const copiedNow = new Map((now.record.copied ?? []).filter((file) => !gone.has(file.path)).map((file) => [file.path, file.sha256]));
    for (const [path, { sha256: hash }] of written) copiedNow.set(path, hash);
    const updated: CarveoutRecord = {
      ...now.record,
      manifest: { ...now.record.manifest, sourceCommitSha: to, included },
      ...(now.record.copied === undefined
        ? {}
        : { copied: [...copiedNow.entries()].map(([path, hash]) => ({ path, sha256: hash })).sort((a, b) => compare(a.path, b.path)) }),
    };
    saveRecord(root, now, updated, {}, new Map([...written.values()].map(({ folderPath, folderSha256 }) => [folderPath, folderSha256])));
  }
  return { from, to, applied };
}
