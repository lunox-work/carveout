/**
 * The maintainer's copy of a cut, kept outside the folder.
 *
 * A folder handed to someone outside comes back in their hands: its
 * `carveout.json` and `carveout/baseline.json` are theirs to edit. The
 * record decides what a patch may carry (the slice's files and packages)
 * and how its imports are restored; the baseline decides which failing
 * tests `npm test` does not count. Both are written again, at the cut and
 * at the first check, into a receipt under `CARVEOUT_HOME/receipts/`, named
 * by the cut's random id, which the folder carries. `patch`, `status`,
 * `apply`, `merge` and `check` read the receipt when there is one, and the
 * folder's own record only when there is none (a folder cut on another
 * machine, or a receipt deleted): then the record is checked against the
 * repository as before.
 *
 * With the receipt holding the record, a public folder's own record needs
 * none of what names the repository beyond the slice: the commit, the
 * hashes of the repository's other files, the import specifiers the cut
 * rewrote (workspace package names, path aliases), the private paths.
 * `publicRecord` leaves them out.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RECORD_PATH, carveoutHome, readRecord, type CarveoutRecord } from "./carve.js";
import { recordToFolder, toFolder, type FolderPseudonyms } from "./pseudonyms/index.js";
import type { Readiness } from "./readiness.js";

export const RECEIPT_SCHEMA_VERSION = 1;

/** What the maintainer keeps of a cut. */
export interface Receipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  /** The cut's id, which the folder's record carries too. */
  readonly cutId: string;
  readonly createdAt: string;
  /** The checkout the cut read, absolute. */
  readonly repo: string;
  /** The folder the cut wrote, absolute, as it was then. */
  readonly out: string;
  /** The record as the cut made it, nothing left out. */
  readonly record: CarveoutRecord;
  /** The tests that failed on the mocks before any edit, once a check recorded them. */
  readonly baseline?: readonly string[];
  /**
   * The record as the folder holds it, when that differs from `record`: a
   * public folder's, scrubbed, and in pseudonyms by its own paths and
   * hashes. What an edit in the folder is measured against.
   */
  readonly folderRecord?: CarveoutRecord;
  /** A public folder's pseudonyms: the table and the kept names. */
  readonly pseudonyms?: FolderPseudonyms;
  /**
   * The generated files as the folder holds them, by folder path: the test
   * runner, the harness, the stubs and mocks, the manifests. `check` runs a
   * folder that came back on these, not on what it brought.
   */
  readonly generatedText?: Readonly<Record<string, string>>;
  /** What would make the folder's tests run on real code (`readinessOf`), public cut or not. */
  readonly readiness?: Readiness;
}

/** The record as the folder holds it: what its files are measured against. */
export const folderView = (receipt: Receipt): CarveoutRecord => receipt.folderRecord ?? receipt.record;

/** A new cut id: 128 random bits, as hex. */
export function newCutId(): string {
  return randomBytes(16).toString("hex");
}

const CUT_ID = /^[0-9a-f]{32}$/;

/** Where a cut's receipt is kept unless the maintainer names a file. */
export function receiptPathFor(cutId: string): string {
  if (!CUT_ID.test(cutId)) throw new Error(`${JSON.stringify(cutId)} is not a cut id.`);
  return join(carveoutHome(), "receipts", `${cutId}.json`);
}

/** Writes a receipt where only its owner reads it, replacing it whole. */
export function writeReceipt(path: string, receipt: Receipt): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // A name no one can have made first: the file is created, never followed.
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
}

/** Reads a receipt, or throws when the file is not one. */
export function readReceipt(path: string): Receipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not a receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  const receipt = parsed as Partial<Receipt>;
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    typeof receipt.cutId !== "string" ||
    !CUT_ID.test(receipt.cutId) ||
    typeof receipt.repo !== "string" ||
    receipt.record === undefined
  )
    throw new Error(`${path} is not a carveout receipt this version reads.`);
  return receipt as Receipt;
}

/** A folder's record, and the receipt that vouches for it when there is one. */
export interface TrustedCut {
  /** The record to act on: the receipt's, else the folder's own. */
  readonly record: CarveoutRecord;
  /** The folder's own record, as it came back. */
  readonly folder: CarveoutRecord;
  readonly receipt: Receipt | null;
  readonly receiptPath: string | null;
}

/**
 * The record a command on a folder acts on. `given` names a receipt file
 * (`--receipt`); else the receipt of the cut id the folder's record names
 * is looked for under `CARVEOUT_HOME`. A receipt of another cut is refused.
 * Without one, the folder's own record is all there is.
 */
export function trustedCut(
  dir: string,
  given?: string,
  options: {
    /**
     * Go on without a receipt: the folder's own record is all there is,
     * checked against the repository (`--no-receipt`). Without it, a folder
     * whose receipt cannot be found is refused: the folder decides which
     * id it carries, and so whether one is found.
     */
    readonly noReceipt?: boolean;
    /** `check`: go on without one, and trust nothing of the folder's own (its baseline). */
    readonly optional?: boolean;
  } = {},
): TrustedCut {
  const hasRecord = existsSync(join(resolve(dir), RECORD_PATH));
  const named = given !== undefined ? resolve(given) : null;
  if (!hasRecord && named === null) readRecord(dir);
  const folderOwn = hasRecord ? readRecord(dir) : null;
  const path =
    named ??
    (folderOwn !== null && typeof folderOwn.cutId === "string" && CUT_ID.test(folderOwn.cutId) && existsSync(receiptPathFor(folderOwn.cutId))
      ? receiptPathFor(folderOwn.cutId)
      : null);
  if (path === null) {
    const folder = folderOwn as CarveoutRecord;
    if (options.noReceipt === true || options.optional === true) {
      if (folder.publicScrubbed === true && options.optional !== true)
        throw new Error(
          `${dir} is a public folder whose record keeps the repository's names out; its receipt holds them. Pass --receipt <file> (the cut printed where it wrote it), or work on the machine that cut it.`,
        );
      return { record: folder, folder, receipt: null, receiptPath: null };
    }
    throw new Error(
      `No receipt for ${dir}: ${typeof folder.cutId === "string" ? `cut ${folder.cutId.slice(0, 8)} has none under ${dirname(receiptPathFor(CUT_ID.test(folder.cutId) ? folder.cutId : "0".repeat(32)))}` : "its carveout.json names no cut"}. A folder that comes back is judged by the receipt its cut wrote: pass --receipt <file>, or --no-receipt to judge it by its own record, checked against the repository.`,
    );
  }
  if (!existsSync(path)) throw new Error(`${path}: no such receipt.`);
  const receipt = readReceipt(path);
  const view = folderView(receipt);
  const folder = folderOwn ?? view;
  if (folder.cutId !== undefined && folder.cutId !== receipt.cutId)
    throw new Error(
      `${path} is the receipt of cut ${receipt.cutId.slice(0, 8)}, and the folder says it is cut ${String(folder.cutId).slice(0, 8)}: name the receipt of this folder's cut.`,
    );
  // A folder whose generated files are another cut's is not this receipt's.
  const shape = (record: CarveoutRecord) =>
    record.generated
      .map((file) => file.path)
      .filter((file) => file !== "package-lock.json")
      .sort()
      .join("\n");
  // A folder holds the cut's own files (the folder's view), or, renamed
  // back for a patch, the cut's record itself.
  if (folderOwn !== null && shape(folderOwn) !== shape(view) && shape(folderOwn) !== shape(receipt.record))
    throw new Error(
      `${dir} does not hold the files of cut ${receipt.cutId.slice(0, 8)}'s folder: name the receipt of the cut that wrote it.`,
    );
  // A public record names no checkout; the receipt does.
  const record: CarveoutRecord = receipt.record.repo === undefined ? { ...receipt.record, repo: receipt.repo } : receipt.record;
  return { record, folder, receipt, receiptPath: path };
}

/**
 * The record a public folder carries: what the folder's own commands need
 * (its files and their hashes, what it stubs, its tests), less what names
 * the repository beyond the slice, which the receipt keeps: the commit and
 * the graph's hash, the hashes of the repository's other files, the
 * specifiers the cut rewrote (a workspace package's name, a path alias),
 * and the private paths the owner keeps out.
 */
export function publicRecord(record: CarveoutRecord): CarveoutRecord {
  const { private: _private, ...params } = record.manifest.params as typeof record.manifest.params & {
    private?: unknown;
  };
  const { private: _requestPrivate, choices: _choices, task: _task, ...request } = record.request;
  const { repo: _repo, ...rest } = record;
  const unnamed = <T extends { readonly specifier: string | null }>(edge: T): T => ({ ...edge, specifier: null });
  // A slice file's original hash, blob id and size confirm a guess at what
  // it held before the cut rewrote it: the folder's own copy's stand in.
  const copied = new Map((record.copied ?? []).map((file) => [file.path, file.sha256]));
  return {
    ...rest,
    manifest: {
      ...record.manifest,
      sourceCommitSha: null,
      graphSha256: "",
      boundaryContractSha256: "",
      params,
      included: record.manifest.included.map((file) => {
        const own = copied.get(file.path);
        return own === undefined ? file : { ...file, blobId: "", sha256: own };
      }),
      internalImports: record.manifest.internalImports.map(unnamed),
      cuts: {
        ...record.manifest.cuts,
        outbound: record.manifest.cuts.outbound.map(unnamed),
        inbound: record.manifest.cuts.inbound.map(unnamed),
      },
    },
    importRewrites: [],
    inputs: [],
    request: { ...request, choices: {} },
    publicScrubbed: true,
  };
}

/**
 * The record a public folder holds, made from the cut's: scrubbed
 * (`publicRecord`), a leak's blocker kept without the name it is about,
 * and for a folder in pseudonyms, in its names, with its files' folder
 * paths and the hashes of what the folder holds at them (`dir`), so its
 * own commands (the coverage guard, check) read it as written.
 */
export function folderRecordFor(
  record: CarveoutRecord,
  table: FolderPseudonyms | undefined,
  dir: string,
  /** A hash already known for a folder path, over what the folder holds there now. */
  known: (folderPath: string) => string | undefined = () => undefined,
): CarveoutRecord {
  const scrubbed = publicRecord(record);
  const quiet: CarveoutRecord = {
    ...scrubbed,
    blockers: scrubbed.blockers.map((blocker) =>
      blocker.code === "vocabulary_leaked"
        ? { code: blocker.code, file: null, detail: "A name the repository goes by is still in the folder; the maintainer has the list." }
        : blocker,
    ),
  };
  if (table === undefined) return quiet;
  const renamed = recordToFolder(table, quiet);
  const pathOf = (path: string) => toFolder(table, path, "").path;
  const hashAt = (path: string) => {
    const given = known(path);
    if (given !== undefined) return given;
    const at = join(resolve(dir), path);
    return existsSync(at) ? createHash("sha256").update(readFileSync(at)).digest("hex") : "";
  };
  const asWritten = (entry: { readonly path: string }) => ({ path: pathOf(entry.path), sha256: hashAt(pathOf(entry.path)) });
  return {
    ...renamed,
    manifest: {
      ...renamed.manifest,
      included: record.manifest.included.map((file) => ({ ...file, path: pathOf(file.path), blobId: "", sha256: hashAt(pathOf(file.path)) })),
    },
    generated: record.generated.map(asWritten),
    ...(record.copied === undefined ? {} : { copied: record.copied.map(asWritten) }),
    ...(record.extras === undefined ? {} : { extras: record.extras.map(asWritten) }),
  };
}

/**
 * Writes a record a command changed (`apply` growing the slice, writing
 * stubs) to the folder and, when the cut has one, to its receipt: the
 * folder's copy public-scrubbed as the cut wrote it.
 */
export function saveRecord(
  dir: string,
  trusted: TrustedCut,
  updated: CarveoutRecord,
  /** Generated files the command wrote into the folder, by folder path. */
  written: Readonly<Record<string, string>> = {},
  /**
   * Slice files whose hash the record takes anew, by folder path: as the
   * command wrote them, the folder's edits aside (`refresh` moving the
   * folder's base). Every other path keeps the hash it had.
   */
  rebased: ReadonlyMap<string, string> = new Map(),
): TrustedCut {
  const scrub = trusted.receipt !== null && updated.request.public === true;
  // Each path keeps the hash the folder's record had for it: the folder's
  // edits since are still edits, and a file an earlier apply wrote still
  // differs from the cut's, so the next apply merges into it rather than
  // over it. Only a generated file the command wrote, or a path new to the
  // record, is hashed as the folder holds it now.
  const previous = new Map<string, string>();
  const before = trusted.receipt?.folderRecord;
  if (before !== undefined)
    for (const file of [...before.manifest.included, ...before.generated, ...(before.copied ?? []), ...(before.extras ?? [])])
      if (file.sha256 !== "") previous.set(file.path, file.sha256);
  const known = (path: string) => {
    const text = written[path];
    return text !== undefined ? createHash("sha256").update(text).digest("hex") : (rebased.get(path) ?? previous.get(path));
  };
  const folder = scrub ? folderRecordFor(updated, trusted.receipt?.pseudonyms, dir, known) : updated;
  writeFileSync(join(resolve(dir), RECORD_PATH), `${JSON.stringify(folder, null, 2)}\n`);
  if (trusted.receipt === null || trusted.receiptPath === null) return { ...trusted, record: updated, folder };
  // The receipt keeps the record as the cut makes it, checkout included,
  // and the folder's own when it differs.
  const { repo: _repo, ...kept } = updated;
  const record = (trusted.receipt.record.repo === undefined ? kept : updated) as CarveoutRecord;
  const receipt = {
    ...trusted.receipt,
    record,
    ...(trusted.receipt.folderRecord === undefined ? {} : { folderRecord: folder }),
    ...(trusted.receipt.generatedText === undefined
      ? {}
      : { generatedText: { ...trusted.receipt.generatedText, ...written } }),
  };
  writeReceipt(trusted.receiptPath, receipt);
  return { ...trusted, record: updated, folder, receipt };
}

/**
 * The baseline a check of the folder reads, given its receipt and the
 * folder's own `carveout/baseline.json` (its failing names, or null when it
 * has none): the receipt's when it holds one, none when the receipt holds
 * none (a baseline the receipt never saw is not read), the folder's own
 * when there is no receipt to judge it by. `edited` names what the
 * folder's own adds beyond the receipt's.
 */
export function trustedBaseline(
  receipt: Pick<Receipt, "baseline"> | null,
  folder: readonly string[] | null,
): { readonly use: readonly string[] | null | "folder"; readonly edited: readonly string[] } {
  if (receipt === null) return { use: "folder", edited: [] };
  const known = receipt.baseline ?? null;
  const edited = (folder ?? []).filter((name) => known === null || !known.includes(name)).sort();
  return { use: known, edited };
}
