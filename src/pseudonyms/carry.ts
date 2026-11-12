/**
 * Carrying a change between a version's public names and the repository's:
 * the reverse path merge-back needs (a submission, made in public names,
 * as a patch on the repository at the pinned commit), and the forward path
 * the CI judge needs (a pull request's files, in the repository's names,
 * as a submission on the version).
 *
 * The build's transforms are token-for-token and never add or remove a
 * line: the name table, import specifiers rewritten to the slice's layout,
 * mocked packages and environment variables renamed. So a version's file
 * and the repository's line up line by line, and a change carries by line:
 *
 * - A line the change kept is the other side's line at the same place,
 *   byte for byte. A change that touches nothing carries to the original.
 * - A line the change added is renamed token by token, first by what the
 *   two originals' differing lines show the build renamed in this file
 *   (an import specifier, a package, an environment variable), then by the
 *   name table. It is refused unless renaming it back gives it again, so
 *   new text holding a name the side it was written on never shows (the
 *   repository's own names, in a contribution) cannot pass through.
 * - A line the change added that imports the sandbox's harness (a mock, a
 *   stub), which the repository does not have, is refused.
 *
 * Pure and platform-neutral: the worker reads the files, the API writes
 * the pull request.
 *
 * Moved here verbatim from sandbox-factory's packages/core/src/sandbox/carry.ts
 * (commit f31d780), on carveout's alias implementation (`aliases.ts`). One
 * addition: `aliases` on `ReverseInput`, `ForwardInput` and `projectPathOf`,
 * so a version built with an older renaming carries back under it
 * (`ALIASES_V1`, `legacy.ts`).
 */

import { invertAliasRules, renameFile, type AliasRule, type AliasedFile } from "./aliases.js";

/**
 * The renaming a version was built with: how a file is renamed under a
 * table, and how a table is inverted. carveout's own by default
 * (`CURRENT_ALIASES`); `ALIASES_V1` for a version the platform built before.
 */
export interface AliasImplementation {
  readonly renameFile: (file: AliasedFile, rules: readonly AliasRule[]) => AliasedFile;
  readonly invertAliasRules: (rules: readonly AliasRule[]) => AliasRule[];
}

/** carveout's renaming (`aliases.ts`). */
export const CURRENT_ALIASES: AliasImplementation = { renameFile, invertAliasRules };

/** One file a change touched, on both sides. */
export interface CarriedFile {
  /** Where the change was made, and where it lands. */
  readonly fromPath: string;
  readonly toPath: string;
  /** The file before the change on each side; null for a new file. */
  readonly fromOriginal: string | null;
  readonly toOriginal: string | null;
  /** The file after the change, on the side it was made. */
  readonly edited: string;
}

export interface CarryRefusal {
  /** The path the change was made at. */
  readonly path: string;
  readonly reason: string;
}

export interface CarriedChange {
  /** Each changed file at its path on the other side, whole. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly refused: readonly CarryRefusal[];
}

/** How a line of new text is renamed into the other side's names, and back. */
export interface Renaming {
  readonly to: (text: string, file: CarriedFile) => string;
  readonly back: (text: string, file: CarriedFile) => string;
  /** Whether a path, resolved on the side the change was made, is harness. */
  readonly isHarness?: (path: string) => boolean;
}

/** More than this many lines changed in one file, and added lines are not matched to kept ones. */
const MATCH_CELLS = 4_000_000;

/** Splits text into lines, each with its line ending. */
export function linesOf(text: string): string[] {
  return text === "" ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []);
}

/** Where a string literal opened at `start` closes, past its quote; -1 for none on the line. */
function literalEnd(line: string, start: number): number {
  const quote = line[start];
  for (let at = start + 1; at < line.length; at += 1) {
    const char = line[at];
    if (char === "\\") at += 1;
    else if (char === quote) return at + 1;
    else if (char === "\n" || (quote === "`" && char === "$")) return -1;
  }
  return -1;
}

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const SPACE = /\s/;

/**
 * A line as tokens: string literals whole (a template literal only without
 * `${`), identifiers, runs of space, single characters. One pass, linear in
 * the line: a quote that does not close on it is a character of its own.
 */
export function tokensOf(line: string): string[] {
  const tokens: string[] = [];
  // A quote that found no close cannot find one from further on: a later
  // quote of its kind was either escaped in that scan, which then went on
  // as a scan from it would, or would have closed it.
  const unclosed = new Set<string>();
  let at = 0;
  while (at < line.length) {
    const char = line[at] as string;
    let end = at + 1;
    if (char === '"' || char === "'" || char === "`") {
      const close = unclosed.has(char) ? -1 : literalEnd(line, at);
      if (close > 0) end = close;
      else unclosed.add(char);
    } else if (IDENTIFIER_START.test(char))
      while (end < line.length && IDENTIFIER_PART.test(line[end] as string))
        end += 1;
    else if (SPACE.test(char))
      while (end < line.length && SPACE.test(line[end] as string)) end += 1;
    tokens.push(line.slice(at, end));
    at = end;
  }
  return tokens;
}

/**
 * What the two sides' originals show was renamed in this file: each token
 * that differs where the lines otherwise line up, from one side to the
 * other. A token renamed two ways is listed as ambiguous.
 */
export function learnedRenames(
  from: readonly string[],
  to: readonly string[],
): { renames: Map<string, string>; ambiguous: Set<string> } {
  const renames = new Map<string, string>();
  const ambiguous = new Set<string>();
  from.forEach((line, index) => {
    const other = to[index];
    if (other === undefined || other === line) return;
    const a = tokensOf(line);
    const b = tokensOf(other);
    if (a.length !== b.length) return;
    a.forEach((token, at) => {
      const target = b[at] as string;
      if (token === target) return;
      const known = renames.get(token);
      if (known === undefined) renames.set(token, target);
      else if (known !== target) ambiguous.add(token);
    });
  });
  return { renames, ambiguous };
}

/**
 * For each line of `b`, the line of `a` it keeps, or -1 for one the change
 * added: a longest common subsequence, after the shared head and tail.
 */
export function keptLines(
  a: readonly string[],
  b: readonly string[],
): number[] {
  const kept = b.map(() => -1);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    kept[head] = head;
    head += 1;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    kept[b.length - 1 - tail] = a.length - 1 - tail;
    tail += 1;
  }
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MATCH_CELLS) return kept;
  const width = m + 1;
  const length = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      length[i * width + j] =
        a[head + i] === b[head + j]
          ? (length[(i + 1) * width + j + 1] as number) + 1
          : Math.max(
              length[(i + 1) * width + j] as number,
              length[i * width + j + 1] as number,
            );
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) {
      kept[head + j] = head + i;
      i += 1;
      j += 1;
    } else if (
      (length[(i + 1) * width + j] as number) >=
      (length[i * width + j + 1] as number)
    )
      i += 1;
    else j += 1;
  }
  return kept;
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"']*)\1/g;

/** A relative specifier resolved against the importing file's folder. */
export function resolveRelative(importer: string, specifier: string): string {
  const parts = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/**
 * The change carried to the other side, file by file, with what cannot be
 * carried refused. A refused file is left out of `files`.
 */
export function carryChange(
  files: readonly CarriedFile[],
  renaming: Renaming,
): CarriedChange {
  const carried: { path: string; text: string }[] = [];
  const refused: CarryRefusal[] = [];
  for (const file of files) {
    const refuse = (reason: string) =>
      refused.push({ path: file.fromPath, reason });
    if (file.edited === file.fromOriginal) continue;
    const from = linesOf(file.fromOriginal ?? "");
    const to = linesOf(file.toOriginal ?? "");
    if (from.length !== to.length) {
      refuse(
        "The version's copy of this file does not line up with the repository's, so the change cannot be carried.",
      );
      continue;
    }
    const { renames, ambiguous } = learnedRenames(from, to);
    const back = new Map([...renames].map(([a, b]) => [b, a]));
    const edited = linesOf(file.edited);
    const kept = keptLines(from, edited);
    const out: string[] = [];
    const problems = new Set<string>();
    edited.forEach((line, index) => {
      const keptAt = kept[index] as number;
      if (keptAt >= 0) {
        out.push(to[keptAt] as string);
        return;
      }
      const tokens = tokensOf(line);
      if (tokens.some((token) => ambiguous.has(token))) {
        problems.add(
          "An added line uses a name the build renamed two ways in this file.",
        );
        return;
      }
      const renamed = renaming.to(
        tokens.map((token) => renames.get(token) ?? token).join(""),
        file,
      );
      const again = tokensOf(renaming.back(renamed, file))
        .map((token) => back.get(token) ?? token)
        .join("");
      if (again !== line) {
        problems.add(
          "An added line holds a name the other side would read differently, so it does not map back.",
        );
        return;
      }
      if (renaming.isHarness !== undefined)
        for (const match of line.matchAll(IMPORT_SPECIFIER))
          if (
            renaming.isHarness(
              resolveRelative(file.fromPath, match[2] as string),
            )
          )
            problems.add(
              `An added line imports ${match[2]}, part of the sandbox's harness, which the repository does not have.`,
            );
      out.push(renamed);
    });
    if (problems.size > 0) {
      for (const problem of [...problems].sort()) refuse(problem);
      continue;
    }
    carried.push({ path: file.toPath, text: out.join("") });
  }
  return {
    files: carried.sort((a, b) => (a.path < b.path ? -1 : 1)),
    refused,
  };
}

/** A file's path without its script extension, for matching an import to it. */
const stem = (path: string) => path.replace(/\.(?:[cm]?[jt]sx?|d\.ts)$/, "");

export interface ReverseInput {
  /** The submission's files, at their paths in the version's project. */
  readonly submitted: readonly {
    readonly path: string;
    readonly text: string;
  }[];
  /** The version's public file at a project path; null for none. */
  readonly publicText: (path: string) => string | null;
  /** The repository's file at the pinned commit; null for none. */
  readonly repositoryText: (path: string) => string | null;
  /** The version's name table (`pseudonym.lunox`). */
  readonly rules: readonly AliasRule[];
  /** Repository path to project path, for each file the build moved. */
  readonly renames: readonly { readonly from: string; readonly to: string }[];
  /** The version's harness files (mocks, stubs, tests), at project paths. */
  readonly harness: readonly string[];
  /** The renaming the version was built with; carveout's by default. */
  readonly aliases?: AliasImplementation;
}

/**
 * A submission, made in the version's public names, as whole files on the
 * repository at the pinned commit: merge-back's reverse path.
 */
export function reverseSubmission(input: ReverseInput): CarriedChange {
  const { renameFile, invertAliasRules } = input.aliases ?? CURRENT_ALIASES;
  const inverse = invertAliasRules(input.rules);
  const repositoryPathOf = new Map(
    input.renames.map(({ from, to }) => [to, from]),
  );
  const harness = new Set(input.harness.map(stem));
  const files = input.submitted.map((file): CarriedFile => {
    const toPath =
      repositoryPathOf.get(file.path) ??
      renameFile({ path: file.path, text: "" }, inverse).path;
    return {
      fromPath: file.path,
      toPath,
      fromOriginal: input.publicText(file.path),
      toOriginal: input.repositoryText(toPath),
      edited: file.text,
    };
  });
  return carryChange(files, {
    to: (text, file) => renameFile({ path: file.toPath, text }, inverse).text,
    back: (text, file) =>
      renameFile({ path: file.toPath, text }, input.rules).text,
    isHarness: (path) => harness.has(stem(path)),
  });
}

/**
 * Where a repository file is in the version's project: where the build
 * moved it, else where the name table's path rules put it.
 */
export function projectPathOf(
  path: string,
  renames: readonly { readonly from: string; readonly to: string }[],
  rules: readonly AliasRule[],
  aliases: AliasImplementation = CURRENT_ALIASES,
): string {
  const { renameFile } = aliases;
  return (
    renames.find((rename) => rename.from === path)?.to ??
    renameFile({ path, text: "" }, rules).path
  );
}

export interface ForwardInput {
  /** A change's files, at their repository paths. */
  readonly changed: readonly { readonly path: string; readonly text: string }[];
  readonly publicText: (path: string) => string | null;
  readonly repositoryText: (path: string) => string | null;
  readonly rules: readonly AliasRule[];
  readonly renames: readonly { readonly from: string; readonly to: string }[];
  /** The renaming the version was built with; carveout's by default. */
  readonly aliases?: AliasImplementation;
}

/**
 * A change made in the repository's names, as whole files on the version's
 * project: the CI judge's forward path. Only files the version has (or its
 * paths name) are carried; the caller keeps to the editable ones.
 */
export function forwardChange(input: ForwardInput): CarriedChange {
  const aliases = input.aliases ?? CURRENT_ALIASES;
  const { renameFile } = aliases;
  const inverse = aliases.invertAliasRules(input.rules);
  const files = input.changed.map((file): CarriedFile => {
    const toPath = projectPathOf(file.path, input.renames, input.rules, aliases);
    return {
      fromPath: file.path,
      toPath,
      fromOriginal: input.repositoryText(file.path),
      toOriginal: input.publicText(toPath),
      edited: file.text,
    };
  });
  return carryChange(files, {
    to: (text, file) =>
      renameFile({ path: file.fromPath, text }, input.rules).text,
    back: (text, file) =>
      renameFile({ path: file.fromPath, text }, inverse).text,
  });
}
