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
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
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
  sliceSpecifierPackages,
} from "./carve.js";
import {
  isTestPath,
  runtimePath,
  type ImportRewrite,
  type IncludedFile,
} from "./core.js";
import { symbolDiff } from "./status.js";
import { trustedRepo } from "./policy.js";
import { sandboxRun, type SandboxSpec } from "./sandbox.js";
import { folderView, saveRecord, trustedCut } from "./receipt.js";
import { exactToFolder, fromFolder, looseLeaks, toFolder, wordsToFolder, type FolderPseudonyms } from "./pseudonyms/index.js";
import { workspacePackages } from "./extract/compiler-config.js";

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
  /**
   * Slice files not written: in the folder's names their text would not
   * map back to the repository's byte for byte (a mixed-case name, a
   * placeholder word the repository's text holds), so a patch of them
   * would rewrite the repository's. Left as the folder had them.
   */
  readonly unmapped: readonly string[];
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
  const record = trusted.record;
  const source = trustedRepo(record, options.repo);
  // The packages the repository knows, as patch reads them back.
  const known = new Set([
    ...workspacePackages(source).keys(),
    ...record.dependencies.map((dependency) => dependency.name),
    ...record.manifest.requiredBuildInputs.packages.map((item) => item.name),
    ...sliceSpecifierPackages(record, source),
  ]);
  const names = namesOf(trusted.receipt?.pseudonyms, ownPackagesOf(root), (name) => known.has(name));
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
    // A file the folder deleted is an edit too: the change neither brings
    // it back nor writes over its absence.
    const deletedInFolder = new Set((view.copied ?? []).filter((file) => !existsSync(join(root, file.path))).map((file) => file.path));
    const editedInFolder = new Set(
      (view.copied ?? [])
        .filter((file) => {
          const at = join(root, file.path);
          return !existsSync(at) || createHash("sha256").update(readFileSync(at)).digest("hex") !== file.sha256;
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
      // A copied folder the change deleted whole is copied no more: its
      // files go as any deleted file does.
      copy: (record.request.copy ?? []).filter((dir) => existsSync(join(repo, dir))),
      public: record.request.public === true,
      // The owner's acceptance tests stay unread in every later cut.
      ...(trusted.receipt?.unseen === undefined ? {} : { unseen: trusted.receipt.unseen }),
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
    // A credential the change brings never reaches the folder, as a cut of
    // the same commit would write nothing: refused before anything is.
    const credentials = cuts.flatMap((cut) =>
      cut.record.blockers.filter((blocker) => blocker.code === "secret_found" || blocker.code === "secret_file"),
    );
    if (credentials.length > 0)
      throw new Error(
        `Nothing applied: the change would bring a credential into the folder.\n${[
          ...new Set(credentials.map((blocker) => `  ${blocker.code}${blocker.file === null ? "" : ` ${blocker.file}`}: ${blocker.detail}`)),
        ].join("\n")}`,
      );
    const included = new Set(record.manifest.included.map((file) => file.path));
    const changed: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];
    const outside: string[] = [];
    const merged: string[] = [];
    const conflicts: string[] = [];
    const unmapped: string[] = [];
    const grown: IncludedFile[] = [];
    const rewrites: ImportRewrite[] = [];
    /** Folder paths the command wrote, for the leak scan. */
    const wrote: string[] = [];
    /** Each slice file written, by repository path, as the cut writes it (the folder's edits aside). */
    const newly = new Map<string, { folderPath: string; sha256: string; folderSha256: string }>();
    /** The import rewrites of the cut that wrote each file. */
    const rewrittenBy = new Map<string, ImportRewrite[]>();
    for (const [path, status] of [...touched.entries()].sort(([a], [b]) => compare(a, b))) {
      if (status === "D") {
        if (included.has(path)) {
          // Deleted on both sides: nothing to do.
          if (deletedInFolder.has(names.path(path))) {
            deleted.push(path);
            continue;
          }
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
      if (deletedInFolder.has(folderPath)) {
        // The folder deleted what the change edits: left deleted, named.
        conflicts.push(path);
        continue;
      }
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
        const folderText = names.exact(path, result.text);
        if (folderText === null) {
          unmapped.push(path);
          continue;
        }
        await writeFile(join(root, folderPath), folderText);
        merged.push(path);
      } else if (text === null) await copyFile(join(repo, path), join(root, folderPath));
      else {
        const folderText = names.exact(path, text);
        if (folderText === null) {
          unmapped.push(path);
          continue;
        }
        await writeFile(join(root, folderPath), folderText);
      }
      wrote.push(folderPath);
      const clean =
        text === null
          ? (() => {
              const bytes = readFileSync(join(repo, path));
              return { folderPath, sha256: sha256(bytes), folderSha256: sha256(bytes) };
            })()
          : { folderPath, sha256: sha256(text), folderSha256: sha256(names.exact(path, text) ?? "") };
      newly.set(path, clean);
      // The imports the cut that wrote it rewrote, which a patch undoes.
      rewrittenBy.set(path, cut.record.importRewrites.filter((rewrite) => rewrite.file === path));
      options.written?.set(path, clean);
      if (!included.has(path) && status === "M") {
        // A repository file the slice did not hold: it joins the slice at
        // the bytes of the cut's commit, so `patch` diffs it from there.
        grown.push(includedAt(repo, path));
        rewrites.push(...cut.record.importRewrites.filter((rewrite) => rewrite.file === path));
      } else if (!included.has(path) && status === "A")
        // A file the change adds keeps the imports the cut rewrote in it on
        // record, so a patch reads them back as the repository writes them.
        rewrites.push(...cut.record.importRewrites.filter((rewrite) => rewrite.file === path));
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
    // A file written takes the rewrites of the cut that wrote it, in place of
    // the ones its earlier text had (an import the change added, rewritten).
    const rewritesNow = [
      ...trusted.record.importRewrites.filter((rewrite) => !rewrittenBy.has(rewrite.file)),
      ...[...rewrittenBy.values()].flat(),
    ].sort((a, b) => compare(`${a.file}\n${a.from}`, `${b.file}\n${b.from}`));
    const rewritesMoved =
      JSON.stringify(rewritesNow) !==
      JSON.stringify([...trusted.record.importRewrites].sort((a, b) => compare(`${a.file}\n${a.from}`, `${b.file}\n${b.from}`)));
    if (grown.length > 0 || fresh.length > 0 || rewritesMoved) {
      const current = trusted.record;
      const updated: CarveoutRecord = {
        ...current,
        manifest: {
          ...current.manifest,
          included: [...current.manifest.included, ...grown].sort((a, b) => compare(a.path, b.path)),
        },
        importRewrites: [
          ...current.importRewrites.filter((rewrite) => !rewrittenBy.has(rewrite.file)),
          ...[...rewrittenBy.values()].flat(),
          ...rewrites.filter((rewrite) => !rewrittenBy.has(rewrite.file)),
        ].sort((a, b) => compare(`${a.file}\n${a.from}`, `${b.file}\n${b.from}`)),
        ...(current.copied === undefined
          ? {}
          : {
              copied: [...current.copied, ...fresh.map(([path, { sha256: hash }]) => ({ path, sha256: hash, applied: true as const }))].sort((a, b) =>
                compare(a.path, b.path),
              ),
            }),
      };
      trusted = saveRecord(root, trusted, updated, {}, new Map(fresh.map(([, { folderPath, folderSha256 }]) => [folderPath, folderSha256])));
    }
    // The folder's own record names paths too: scanned with what was written.
    return {
      changed,
      added,
      deleted,
      outside,
      stubs,
      merged,
      conflicts,
      leaks: leaksIn(root, wrote.length === 0 ? [] : [...wrote, "carveout.json"], trusted.receipt?.pseudonyms),
      unmapped,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** How a path and a text in the repository's names are put in the folder's, and back. */
interface Names {
  readonly path: (path: string) => string;
  /** A generated file's text (a stub), which never goes back. */
  readonly text: (path: string, text: string) => string;
  /** A slice file's text in the folder's names when it maps back byte for byte; else null. */
  readonly exact: (path: string, text: string) => string | null;
  readonly back: (folderPath: string, text: string) => string;
}

/** The folder's own mock packages, which go by the table's names. */
function ownPackagesOf(root: string): (name: string) => boolean {
  const own = new Set<string>();
  const mocks = join(root, "carveout", "packages");
  if (existsSync(mocks))
    for (const entry of readdirSync(mocks, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@"))
        for (const inner of readdirSync(join(mocks, entry.name), { withFileTypes: true }))
          if (inner.isDirectory()) own.add(`${entry.name}/${inner.name}`);
      else own.add(entry.name);
    }
  return (name) => own.has(name);
}

/** The folder's names for a cut in pseudonyms (its table), or the repository's own. */
function namesOf(
  table: FolderPseudonyms | undefined,
  own: (name: string) => boolean = () => false,
  known: (name: string) => boolean = () => false,
): Names {
  if (table === undefined)
    return { path: (path) => path, text: (_path, text) => text, exact: (_path, text) => text, back: (_path, text) => text };
  // The table's rules, then a placeholder for each term they did not reach:
  // a file the repository added since the cut, or a line it wrote, spells
  // a term where no rule of the cut's matches.
  return {
    path: (path) => exactToFolder(table, path, "", own, known)?.path ?? toFolder(table, path, "").path,
    text: (path, text) => wordsToFolder(table, toFolder(table, path, text).text),
    exact: (path, text) => exactToFolder(table, path, text, own, known)?.text ?? null,
    back: (path, text) => fromFolder(table, path, text, own, known).text,
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
  readonly step: "patch" | "apply" | "setup" | "verify";
  readonly ok: boolean;
  readonly output: string;
}

export interface Merge {
  readonly patch: Patch;
  readonly steps: readonly MergeStep[];
  readonly ok: boolean;
}

/**
 * The checkout's tracked and unignored files, copied to `to`: what a
 * sandboxed verify mounts. A symbolic link is copied as a link, which in the
 * container reaches nothing outside the copy.
 */
function copyCheckout(from: string, to: string): void {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: from,
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");
  for (const path of new Set(listed.split("\0"))) {
    if (path === "") continue;
    const source = join(from, path);
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      continue; // Listed, deleted from the working tree.
    }
    const target = join(to, path);
    mkdirSync(dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else if (stat.isFile()) copyFileSync(source, target);
  }
}

/** The install a lockfile names, lifecycle scripts off; null with no package.json. */
export function installCommand(root: string): string | null {
  if (existsSync(join(root, "package-lock.json")) || existsSync(join(root, "npm-shrinkwrap.json")))
    return "npm ci --ignore-scripts --no-audit --no-fund";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "corepack pnpm install --frozen-lockfile --ignore-scripts";
  if (existsSync(join(root, "yarn.lock")))
    return existsSync(join(root, ".yarnrc.yml"))
      ? "corepack yarn install --immutable --mode=skip-build"
      : "corepack yarn install --frozen-lockfile --ignore-scripts";
  if (existsSync(join(root, "package.json"))) return "npm install --ignore-scripts --no-audit --no-fund";
  return null;
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
    /**
     * Verify in a container (`sandbox.ts`) on a copy of the checkout as the
     * patch left it (tracked and unignored files: no `node_modules`, no
     * ignored `.env`): `verifySetup` (else an install the lockfile names,
     * scripts off) with a network, then `verify` with none.
     */
    readonly sandbox?: SandboxSpec;
    /** The install before a sandboxed verify, run with a network; else one the lockfile names, scripts off. */
    readonly verifySetup?: string;
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
      if (options.sandbox !== undefined) {
        // A copy of the checkout as the patch left it, so nothing of this
        // machine but that copy is mounted: tracked and unignored files.
        const work = join(scratch, "checkout");
        copyCheckout(into, work);
        const setupCommand = options.verifySetup ?? installCommand(work);
        if (setupCommand !== null) {
          const setup = await sandboxRun(options.sandbox, work, ["sh", "-c", setupCommand], { network: true, limitMs: 20 * 60_000 });
          steps.push({
            step: "setup",
            ok: setup.status === 0,
            output: `${setupCommand}\n${setup.stdout}${setup.stderr}`.slice(-20_000),
          });
          if (setup.status !== 0) return { patch, steps, ok: false };
        }
        const passed: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) if (key !== "HOME" && key !== "PATH") passed[key] = value;
        const verify = await sandboxRun(options.sandbox, work, ["sh", "-c", options.verify], { env: passed, network: false, limitMs: 30 * 60_000 });
        steps.push({
          step: "verify",
          ok: verify.status === 0,
          output: `${verify.stdout}${verify.stderr}`.slice(-20_000),
        });
      } else {
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
    ...(trusted.receipt?.unseen === undefined ? {} : { unseen: trusted.receipt.unseen }),
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
    /**
     * Slice files the folder's holder merged by hand after an overlap, by
     * repository path: the folder's text stands as resolved, the change
     * leaves them alone, and their base moves to the new commit.
     */
    readonly resolved?: readonly string[];
  } = {},
): Promise<{
  readonly from: string;
  readonly to: string;
  readonly applied: Applied;
  /** Files taken as resolved whose text leaves out some of the repository's change to them. */
  readonly droppedUpstream?: readonly string[];
  /** Files taken as resolved where the repository changed the same lines: no merge can say what the folder's text keeps. */
  readonly overlapResolved?: readonly string[];
  /** Copied folders' files the repository changed, left as the folder holds them. */
  readonly copiedLeft?: readonly string[];
  /** Copied folders' files the folder had not edited, taken as the repository has them. */
  readonly copiedTaken?: readonly string[];
} | null> {
  const root = resolve(dir);
  const trusted = trustedCut(root, options.receipt, options.noReceipt === true ? { noReceipt: true } : {});
  const record = trusted.record;
  const repo = trustedRepo(record, options.repo);
  const from = record.manifest.sourceCommitSha;
  if (from === null) throw new Error("The cut was not made in a Git checkout: there is no commit to refresh from.");
  const to = git(repo, ["rev-parse", "HEAD"]).trim();
  const packages = [...new Set(record.manifest.included.map((file) => packageDirOf(repo, file.path)))];
  const stubbed = [...new Set(record.manifest.cuts.outbound.map((edge) => edge.to))];
  // And the copied folders' files, which may sit outside those packages.
  const copiedFolders = (record.extras ?? []).map((file) => file.path);
  const paths = [...new Set([...packages.map((dir) => (dir === "" ? "." : dir)), ...stubbed, ...copiedFolders])].sort(compare);
  const resolved = [...new Set(options.resolved ?? [])];
  // Only the slice's own files and the copied folders': a path outside
  // would join the record, and the next patch would delete it.
  const sliceFiles = new Set([...record.manifest.included.map((file) => file.path), ...copiedFolders]);
  const outsideSlice = resolved.filter((path) => !sliceFiles.has(path));
  if (outsideSlice.length > 0)
    throw new Error(`--resolved takes the slice's own files and its copied folders'; these are not: ${outsideSlice.join(", ")}.`);
  const change = git(repo, ["diff", "--binary", "--full-index", from, to, "--", ...paths, ...resolved.map((path) => `:(exclude)${path}`)]);
  if (change.trim() === "" && resolved.length === 0) return null;
  const written = new Map<string, { folderPath: string; sha256: string; folderSha256: string }>();
  const applied: Applied =
    change.trim() === ""
      ? { changed: [], added: [], deleted: [], outside: [], stubs: [], merged: [], conflicts: [], leaks: [], unmapped: [] }
      : await applyPatch(root, change, {
    stubs: true,
    repo,
    written,
    ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
    ...(options.noReceipt === true ? { noReceipt: true } : {}),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  // A file resolved by hand moves to the new base as the folder holds it:
  // the repository's bytes there are its base, the folder's text an edit.
  // One whose text leaves out some of the repository's change is named.
  const table = trusted.receipt?.pseudonyms;
  const droppedUpstream: string[] = [];
  const overlapResolved: string[] = [];
  const mergeScratch = resolved.length === 0 ? null : mkdtempSync(join(tmpdir(), "carveout-resolved-"));
  for (const path of resolved) {
    try {
      const baseCommit = record.bases?.[path] ?? from;
      const show = (commit: string) => execFileSync("git", ["show", `${commit}:${path}`], { cwd: repo, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
      const folderPathOf = table === undefined ? path : (exactToFolder(table, path, "")?.path ?? toFolder(table, path, "").path);
      const folderText = readFileSync(join(root, folderPathOf), "utf8");
      const ours = table === undefined ? folderText : fromFolder(table, folderPathOf, folderText).text;
      const merged = mergeText(mergeScratch ?? tmpdir(), ours, show(baseCommit), show(to));
      // Clean, a merge shows what the folder's text leaves out; over the
      // same lines it cannot, and the person's merge stands, named.
      if (merged.conflicts) overlapResolved.push(path);
      else if (merged.text !== ours) droppedUpstream.push(path);
    } catch {
      // A file the commit deleted, or the folder did: nothing to compare.
    }
  }
  if (mergeScratch !== null) await rm(mergeScratch, { recursive: true, force: true });
  /** Copied files the new commit deleted: no longer the repository's copies. */
  const copiedGone: string[] = [];
  for (const path of resolved) {
    let bytes: Buffer;
    try {
      bytes = execFileSync("git", ["show", `${to}:${path}`], { cwd: repo, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // A copied file the repository deleted, taken as resolved: what the
      // folder holds of it is the folder's own, a new file to a patch.
      if (copiedFolders.includes(path)) copiedGone.push(path);
      continue;
    }
    const folderPath = table === undefined ? path : (exactToFolder(table, path, "")?.path ?? toFolder(table, path, "").path);
    // The folder's record holds hashes in the folder's names, never the
    // repository's (which would confirm a guess at a pseudonym).
    const text = bytes.toString("utf8");
    const folderText = table === undefined ? text : (exactToFolder(table, path, text)?.text ?? toFolder(table, path, text).text);
    written.set(path, { folderPath, sha256: sha256(bytes), folderSha256: sha256(folderText) });
  }
  // The repository holds these commits: the folder's base moves to them, so
  // a patch of it carries the contributor's work alone, not the commits it
  // was brought (and `git apply` takes it at the new HEAD). Each file
  // written moves on its own (patch reads its base from the checkout, whose
  // bytes it has); the commit moves only when nothing was left at the old
  // base, an overlap or a file that would not map back to the folder's
  // names.
  // And only when every slice file the commits changed was written or
  // deleted: one the cut no longer reaches, or a copied folder's, keeps the
  // bytes of the old base, which the new commit does not hold.
  const changedNames = git(repo, ["diff", "--name-only", from, to, "--", ...paths]).split("\n").filter((name) => name !== "");
  // A copied file the folder never edited takes the repository's bytes as
  // they are: nothing of the folder's to merge. In pseudonyms, where the
  // bytes would need renaming, it is left to the person, named.
  const copiedTaken: string[] = [];
  if (table === undefined) {
    const copiedHashes = new Map((trusted.record.extras ?? []).map((file) => [file.path, file.sha256]));
    for (const name of changedNames) {
      const original = copiedHashes.get(name);
      const at = join(root, name);
      if (original === undefined || written.has(name) || !existsSync(at) || sha256(readFileSync(at)) !== original) continue;
      let bytes: Buffer;
      try {
        bytes = execFileSync("git", ["show", `${to}:${name}`], { cwd: repo, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        // Deleted upstream, and never edited here: deleted here too.
        await rm(at, { force: true });
        copiedGone.push(name);
        copiedTaken.push(name);
        continue;
      }
      writeFileSync(at, bytes);
      written.set(name, { folderPath: name, sha256: sha256(bytes), folderSha256: sha256(bytes) });
      copiedTaken.push(name);
    }
  }
  const held = new Set([
    ...trusted.record.manifest.included.map((file) => file.path),
    ...(trusted.record.extras ?? []).map((file) => file.path),
  ]);
  const left = changedNames.filter((name) => held.has(name) && !written.has(name) && !applied.deleted.includes(name) && !copiedGone.includes(name));
  // A copied folder's file the repository changed is never written over
  // what the folder holds: named, to bring by hand and pass as resolved.
  const copiedSet = new Set(copiedFolders);
  const copiedLeft = left.filter((name) => copiedSet.has(name));
  const whole = applied.conflicts.length === 0 && applied.unmapped.length === 0 && left.length === 0;
  if (written.size > 0 || whole || copiedGone.length > 0) {
    const now = trustedCut(root, options.receipt, options.noReceipt === true ? { noReceipt: true } : {});
    const gone = new Set(applied.deleted);
    const known = new Set(now.record.manifest.included.map((file) => file.path));
    const atTo = (path: string): IncludedFile => {
      const bytes = execFileSync("git", ["show", `${to}:${path}`], { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
      const [mode = "100644", , blobId = ""] = git(repo, ["ls-tree", to, "--", path]).trim().split(/\s+/);
      return { path, blobId, sha256: sha256(bytes), mode, sizeBytes: bytes.length, operations: ["edit"] };
    };
    // A copied folder's file stays one, at the new base's bytes: patch
    // reads its base by the hash `extras` keeps.
    const extrasPaths = new Set((now.record.extras ?? []).map((file) => file.path));
    const included = [
      ...now.record.manifest.included.filter((file) => !gone.has(file.path)).map((file) => (written.has(file.path) ? { ...file, ...atTo(file.path) } : file)),
      ...[...written.keys()].filter((path) => !known.has(path) && !extrasPaths.has(path)).map(atTo),
    ].sort((a, b) => compare(a.path, b.path));
    const extras = now.record.extras
      ?.filter((file) => !gone.has(file.path) && !copiedGone.includes(file.path))
      .map((file) => {
        const moved = written.get(file.path);
        return moved === undefined ? file : { path: file.path, sha256: moved.sha256 };
      });
    // A file refresh wrote is the repository's at the new base; any other
    // keeps what it was, a patch's mark included.
    const copiedNow = new Map<string, { path: string; sha256: string; applied?: true }>(
      (now.record.copied ?? []).filter((file) => !gone.has(file.path)).map((file) => [file.path, file]),
    );
    for (const [path, { sha256: hash }] of written) copiedNow.set(path, { path, sha256: hash });
    // Each file written moved to the new commit; the record's commit too
    // when whole, when no file is left behind it.
    const bases = whole
      ? undefined
      : { ...(now.record.bases ?? {}), ...Object.fromEntries([...written.keys()].map((path) => [path, to])) };
    const updated: CarveoutRecord = {
      ...now.record,
      manifest: { ...now.record.manifest, ...(whole ? { sourceCommitSha: to } : {}), included },
      ...(extras === undefined ? {} : { extras }),
      ...(bases === undefined ? { bases: undefined } : { bases }),
      ...(now.record.copied === undefined ? {} : { copied: [...copiedNow.values()].sort((a, b) => compare(a.path, b.path)) }),
    };
    saveRecord(root, now, updated, {}, new Map([...written.values()].map(({ folderPath, folderSha256 }) => [folderPath, folderSha256])));
  }
  return {
    from,
    to,
    applied,
    ...(droppedUpstream.length === 0 ? {} : { droppedUpstream }),
    ...(overlapResolved.length === 0 ? {} : { overlapResolved }),
    ...(copiedLeft.length === 0 ? {} : { copiedLeft }),
    ...(copiedTaken.length === 0 ? {} : { copiedTaken }),
  };
}
