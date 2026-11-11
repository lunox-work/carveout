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

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RECORD_PATH, carveoutHome, readRecord, type CarveoutRecord } from "./carve.js";

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
}

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
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
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
export function trustedCut(dir: string, given?: string, options: { readonly optional?: boolean } = {}): TrustedCut {
  const folder = readRecord(dir);
  const path =
    given !== undefined
      ? resolve(given)
      : typeof folder.cutId === "string" && CUT_ID.test(folder.cutId) && existsSync(receiptPathFor(folder.cutId))
        ? receiptPathFor(folder.cutId)
        : null;
  if (path === null) {
    // `check` in the contributor's hands has no receipt, and needs none.
    if (folder.publicScrubbed === true && options.optional !== true)
      throw new Error(
        `${dir} is a public folder whose record keeps the repository's names out; its receipt holds them. Pass --receipt <file> (the cut printed where it wrote it), or work on the machine that cut it.`,
      );
    return { record: folder, folder, receipt: null, receiptPath: null };
  }
  if (!existsSync(path)) throw new Error(`${path}: no such receipt.`);
  const receipt = readReceipt(path);
  if (folder.cutId !== undefined && folder.cutId !== receipt.cutId)
    throw new Error(
      `${path} is the receipt of cut ${receipt.cutId.slice(0, 8)}, and the folder says it is cut ${String(folder.cutId).slice(0, 8)}: name the receipt of this folder's cut.`,
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
  const { private: _requestPrivate, ...request } = record.request;
  const unnamed = <T extends { readonly specifier: string | null }>(edge: T): T => ({ ...edge, specifier: null });
  return {
    ...record,
    manifest: {
      ...record.manifest,
      sourceCommitSha: null,
      graphSha256: "",
      params,
      internalImports: record.manifest.internalImports.map(unnamed),
      cuts: {
        ...record.manifest.cuts,
        outbound: record.manifest.cuts.outbound.map(unnamed),
        inbound: record.manifest.cuts.inbound.map(unnamed),
      },
    },
    importRewrites: [],
    inputs: [],
    request,
    publicScrubbed: true,
  };
}

/**
 * Writes a record a command changed (`apply` growing the slice, writing
 * stubs) to the folder and, when the cut has one, to its receipt: the
 * folder's copy public-scrubbed as the cut wrote it.
 */
export function saveRecord(dir: string, trusted: TrustedCut, updated: CarveoutRecord): TrustedCut {
  const scrub = trusted.receipt !== null && updated.request.public === true;
  const folder = scrub ? publicRecord(updated) : updated;
  writeFileSync(join(resolve(dir), RECORD_PATH), `${JSON.stringify(folder, null, 2)}\n`);
  if (trusted.receipt === null || trusted.receiptPath === null) return { ...trusted, record: updated, folder };
  // The receipt keeps the record as the cut makes it, checkout included.
  const { repo: _repo, ...kept } = updated;
  const record = (trusted.receipt.record.repo === undefined ? kept : updated) as CarveoutRecord;
  const receipt = { ...trusted.receipt, record };
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
