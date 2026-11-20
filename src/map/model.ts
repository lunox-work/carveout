/**
 * The map's numbers: the repository's text files and their lines, and,
 * from the sessions' events, the line ranges each file showed the agents,
 * per session and across them.
 *
 * Lines are counted as the files are now; a range logged against an older
 * version of a file is clamped to its length today.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "../graph.js";
import type { ParsedSession, SeenEvent } from "./claude.js";
import { intersectRanges, rangeLines, subtractRanges, unionRanges, type Range } from "./ranges.js";

/** Files never mapped: lockfiles, binaries, minified and generated output. */
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|woff2?|ttf|otf|eot|mp[34]|m4a|mov|avi|webm|wav|flac|ogg|wasm|node|so|dylib|dll|exe|bin|dat|db|sqlite3?|class|pyc|o|a|lib|keystore|p12|der|heic)$/i;
const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "Cargo.lock",
  "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum", "Pipfile.lock", "uv.lock", "flake.lock", "mix.lock",
]);
const GENERATED = /(?:\.min\.(?:js|css)|\.map|\.snap|\.tsbuildinfo|(?:^|\/)carveout-map\.html)$/;
/** A file past this size is generated or data, not source anyone reads. */
const FILE_BYTES_MAX = 1024 * 1024;

export interface MapFile {
  readonly path: string;
  readonly lines: number;
}

/** Whether a repository path is one the map counts. */
export function mappable(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return !BINARY.test(path) && !LOCKFILES.has(name) && !GENERATED.test(path);
}

/** Lines in a text: its newlines, and one more for a last line with none. */
export function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let count = 0;
  let at = buffer.indexOf(10);
  while (at !== -1) {
    count++;
    at = buffer.indexOf(10, at + 1);
  }
  return buffer[buffer.length - 1] === 10 ? count : count + 1;
}

/** The repository's text files the map counts, with their lines; binary files (a NUL byte) left out. */
export function repoFiles(root: string, paths: readonly string[] = listFiles(root)): MapFile[] {
  const out: MapFile[] = [];
  for (const path of paths) {
    if (!mappable(path)) continue;
    let buffer: Buffer;
    try {
      if (statSync(join(root, path)).size > FILE_BYTES_MAX) continue;
      buffer = readFileSync(join(root, path));
    } catch {
      continue;
    }
    if (buffer.subarray(0, 8000).includes(0)) continue;
    const lines = countLines(buffer);
    if (lines > 0) out.push({ path, lines });
  }
  return out;
}

/** What one file showed: lines read by a file tool, inferred from a shell, and changed. */
export interface FileCoverage {
  /** Lines a file tool returned (Read, Grep, an edit's hunks), merged. */
  readonly read: Range[];
  /** Lines only a shell command showed, merged, less `read`. */
  readonly inferred: Range[];
  /** Lines an edit changed, merged. */
  readonly edited: Range[];
  readonly editedFile: boolean;
  readonly first: number;
  readonly last: number;
}

export interface MapNumbers {
  readonly files: number;
  readonly lines: number;
  /** Lines seen, read and inferred together. */
  readonly seenLines: number;
  readonly readLines: number;
  readonly inferredLines: number;
  readonly editedLines: number;
  readonly filesSeen: number;
  readonly filesEdited: number;
  /** `seenLines / lines`, in percent. */
  readonly percent: number;
}

export interface SessionData {
  readonly agent: "claude" | "codex";
  readonly id: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly title: string | null;
  /** Events in this repository's mapped files, in the order the results came back. */
  readonly events: readonly (SeenEvent & { readonly file: number })[];
  readonly numbers: MapNumbers;
  /** Calls in the repository whose lines could not be told. */
  readonly unplaced: number;
  /** Files it named that the map does not count now (deleted, binary, generated). */
  readonly unmapped: number;
}

/** Coverage of a set of events over the repository's files. */
export function coverOf(files: readonly MapFile[], events: Iterable<SeenEvent & { readonly file: number }>): Map<number, FileCoverage> {
  const raw = new Map<number, { read: Range[]; inferred: Range[]; edited: Range[]; editedFile: boolean; first: number; last: number }>();
  for (const event of events) {
    let entry = raw.get(event.file);
    if (entry === undefined) {
      entry = { read: [], inferred: [], edited: [], editedFile: false, first: event.at, last: event.at };
      raw.set(event.file, entry);
    }
    entry.first = Math.min(entry.first, event.at);
    entry.last = Math.max(entry.last, event.at);
    if (event.kind === "inferred") entry.inferred.push(...event.ranges);
    else entry.read.push(...event.ranges);
    if (event.kind === "edit") {
      entry.editedFile = true;
      entry.edited.push(...(event.edited ?? []));
    }
  }
  const out = new Map<number, FileCoverage>();
  for (const [index, entry] of raw) {
    const max = files[index]?.lines ?? 0;
    const read = unionRanges(entry.read, max);
    const inferred = subtractRanges(unionRanges(entry.inferred, max), read);
    const edited = intersectRanges(unionRanges(entry.edited, max), unionRanges([...read, ...inferred]));
    if (read.length === 0 && inferred.length === 0 && !entry.editedFile) continue;
    out.set(index, { read, inferred, edited: edited.length > 0 ? edited : unionRanges(entry.edited, max), editedFile: entry.editedFile, first: entry.first, last: entry.last });
  }
  return out;
}

/** The numbers of a coverage over the repository. */
export function numbersOf(files: readonly MapFile[], cover: ReadonlyMap<number, FileCoverage>): MapNumbers {
  let lines = 0;
  for (const file of files) lines += file.lines;
  let readLines = 0;
  let inferredLines = 0;
  let editedLines = 0;
  let filesSeen = 0;
  let filesEdited = 0;
  for (const coverage of cover.values()) {
    const read = rangeLines(coverage.read);
    const inferred = rangeLines(coverage.inferred);
    readLines += read;
    inferredLines += inferred;
    editedLines += rangeLines(coverage.edited);
    if (read + inferred > 0) filesSeen++;
    if (coverage.editedFile) filesEdited++;
  }
  const seenLines = readLines + inferredLines;
  return {
    files: files.length,
    lines,
    seenLines,
    readLines,
    inferredLines,
    editedLines,
    filesSeen,
    filesEdited,
    percent: lines === 0 ? 0 : (100 * seenLines) / lines,
  };
}

/** A percentage as the map prints it: `0.4%`, `3.8%`, `38%`. */
export function formatPercent(percent: number): string {
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  if (percent < 10) return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(percent)}%`;
}

/** Sessions' events placed on the repository's files, each session with its own numbers. */
export function sessionData(files: readonly MapFile[], sessions: readonly ParsedSession[]): SessionData[] {
  const index = new Map(files.map((file, i) => [file.path, i]));
  return sessions
    .map((session): SessionData => {
      let unmapped = 0;
      const unmappedPaths = new Set<string>();
      const events = session.events
        .flatMap((event) => {
          const file = index.get(event.path);
          if (file === undefined) {
            unmappedPaths.add(event.path);
            return [];
          }
          return [{ ...event, file }];
        })
        .sort((a, b) => a.at - b.at);
      unmapped = unmappedPaths.size;
      return {
        agent: session.agent,
        id: session.id,
        start: session.start,
        end: session.end,
        title: session.title,
        events,
        numbers: numbersOf(files, coverOf(files, events)),
        unplaced: session.unplaced,
        unmapped,
      };
    })
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/** `7d`, `24h`, `2w` back from `now`, or a date; null when it is neither. */
export function parseSince(value: string, now = Date.now()): number | null {
  const relative = /^(\d+)\s*([hdwm])$/i.exec(value.trim());
  if (relative !== null) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000 }[(relative[2] ?? "d").toLowerCase() as "h" | "d" | "w" | "m"];
    return now - Number(relative[1]) * unit;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}
