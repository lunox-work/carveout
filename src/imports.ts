/**
 * Imports as the repository writes them. The cut rewrites a slice's
 * imports to paths Node resolves inside the folder, and records each
 * rewrite; `patch` turns them back. An import the folder's own edits added
 * has no record, so it is restored by what it resolves to: the specifier
 * the slice already uses for that target, else one the target's other
 * importers use, else a relative path in the package's own style.
 */

import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { IMPORT_LITERAL, relativeSpecifier, type ImportRewrite } from "./core.js";

/**
 * `text` with the folder's import rewrites put back as the source wrote
 * them. Two specifiers the cut rewrote to one (`@/lib/format` and
 * `../../lib/format` both to `../../lib/format.js`) are told apart by
 * `original`, the file as the cut read it: they come back in the order it
 * wrote them. Without it, the last recorded wins.
 */
export function undoRewrites(
  text: string,
  rewrites: readonly ImportRewrite[],
  original: string | null = null,
): string {
  if (rewrites.length === 0) return text;
  const froms = new Map<string, string[]>();
  for (const rewrite of rewrites) {
    const list = froms.get(rewrite.to) ?? [];
    if (!list.includes(rewrite.from)) list.push(rewrite.from);
    froms.set(rewrite.to, list);
  }
  // Each ambiguous target's originals, in the order the source has them.
  const queues = new Map<string, string[]>();
  if (original !== null)
    for (const match of original.matchAll(IMPORT_LITERAL)) {
      const specifier = match[3] ?? "";
      for (const [to, list] of froms)
        if (list.length > 1 && list.includes(specifier))
          queues.set(to, [...(queues.get(to) ?? []), specifier]);
    }
  return text.replace(
    IMPORT_LITERAL,
    (whole, prefix: string, quote: string, specifier: string) => {
      const list = froms.get(specifier);
      if (list === undefined) return whole;
      const from = queues.get(specifier)?.shift() ?? list.at(-1) ?? specifier;
      return `${prefix}${quote}${from}${quote}`;
    },
  );
}

/** Every specifier a source writes, as `IMPORT_LITERAL` finds them. */
export function specifiersOf(text: string): Set<string> {
  return new Set(
    [...text.matchAll(IMPORT_LITERAL)].map((match) => match[3] ?? ""),
  );
}

const isRelative = (specifier: string) =>
  specifier.startsWith("./") || specifier.startsWith("../");

/** What a cut knows about the slice's imports, for restoring new ones. */
export interface ImportContext {
  /** Import edges the cut resolved, by importer, target and specifier. */
  readonly edges: readonly { from: string; to: string; specifier: string }[];
  /** The folder's source files, by repository path: slice and new files. */
  readonly files: ReadonlySet<string>;
  /** Cut modules by repository path; their stubs sit beside them. */
  readonly stubs: ReadonlySet<string>;
  /** The repository's package folder holding a path, "" for the root. */
  readonly packageOf: (path: string) => string;
  /** Whether a package writes relative imports without extensions. */
  readonly extensionless: (pkg: string) => boolean;
}

/** The folder file or cut module a relative specifier in `file` names. */
export function importTarget(
  file: string,
  specifier: string,
  context: Pick<ImportContext, "files" | "stubs">,
): string | null {
  const base = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (base.startsWith("../")) return null;
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  const candidates =
    stem === base
      ? [base, ...["ts", "tsx", "mts", "cts"].flatMap((ext) => [`${base}.${ext}`, `${base}/index.${ext}`])]
      : [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`];
  return (
    candidates.find((path) => context.files.has(path) || context.stubs.has(path)) ??
    null
  );
}

export interface RestoredImports {
  readonly text: string;
  /** Specifiers restored relative across packages: no spelling was known. */
  readonly crossPackage: readonly string[];
}

/**
 * A slice file's text with its imports as the repository writes them.
 * `original` is the file as the cut read it (null for a new file): the
 * specifiers it wrote are kept as they are.
 */
export function restoreImports(
  file: string,
  text: string,
  original: string | null,
  rewrites: readonly ImportRewrite[],
  context: ImportContext,
): RestoredImports {
  const undone = undoRewrites(text, rewrites, original);
  const kept = original === null ? new Set<string>() : specifiersOf(original);
  const crossPackage: string[] = [];
  const restored = undone.replace(
    IMPORT_LITERAL,
    (whole, prefix: string, quote: string, specifier: string) => {
      if (!isRelative(specifier) || kept.has(specifier)) return whole;
      const target = importTarget(file, specifier, context);
      if (target === null) return whole;
      const spelling = spellingOf(file, target, context);
      if (spelling === null) crossPackage.push(specifier);
      const to = spelling ?? relativeIn(file, target, context);
      return to === specifier ? whole : `${prefix}${quote}${to}${quote}`;
    },
  );
  return { text: restored, crossPackage };
}

/**
 * The specifier the repository uses for `target` from `file`: the file's
 * own, else a bare one (an alias or a workspace package) another importer
 * uses and that resolves the same from here, else relative within the
 * package. Null when the target is in another package and no importer
 * names it.
 */
function spellingOf(
  file: string,
  target: string,
  context: ImportContext,
): string | null {
  const own = context.edges.find(
    (edge) => edge.from === file && edge.to === target,
  );
  if (own !== undefined) return own.specifier;
  const here = context.packageOf(file);
  const there = context.packageOf(target);
  const counts = new Map<string, number>();
  let relative = 0;
  for (const edge of context.edges) {
    if (edge.to !== target) continue;
    const from = context.packageOf(edge.from);
    if (isRelative(edge.specifier)) {
      if (from === here) relative += 1;
      continue;
    }
    // An alias resolves the same within its package; a package name from
    // anywhere but the package itself.
    if (from === here || (from !== there && here !== there))
      counts.set(edge.specifier, (counts.get(edge.specifier) ?? 0) + 1);
  }
  const bare = [...counts.entries()].sort(
    ([a, m], [b, n]) => n - m || (a < b ? -1 : a > b ? 1 : 0),
  )[0];
  // Within a package, the spelling more of the target's importers use.
  if (bare !== undefined && (here !== there || bare[1] > relative)) return bare[0];
  return here === there ? relativeIn(file, target, context) : null;
}

function relativeIn(file: string, target: string, context: ImportContext): string {
  const written = relativeSpecifier(file, target);
  if (!context.extensionless(context.packageOf(file))) return written;
  return written.replace(/\.[cm]?js$/, "").replace(/\/index$/, "") || ".";
}

/** The nearest folder above `path` with a package.json in `repo`, "" for none. */
export function packageFolder(
  repo: string,
  cache: Map<string, string> = new Map(),
): (path: string) => string {
  return (path) => {
    const dirs: string[] = [];
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      const key = dir === "." ? "" : dir;
      const known = cache.get(key);
      if (known !== undefined) {
        for (const d of dirs) cache.set(d, known);
        return known;
      }
      dirs.push(key);
      if (key === "" || existsSync(join(repo, key, "package.json"))) {
        for (const d of dirs) cache.set(d, key);
        return key;
      }
    }
  };
}

/**
 * Whether relative imports in a package are written without extensions,
 * by the imports the cut read there: the more common style wins.
 */
export function extensionlessPackages(
  edges: readonly { from: string; specifier: string }[],
  packageOf: (path: string) => string,
): (pkg: string) => boolean {
  const votes = new Map<string, number>();
  for (const edge of edges) {
    if (!isRelative(edge.specifier)) continue;
    const bare = !/\.[a-z0-9]+$/i.test(edge.specifier);
    const script = /\.([cm]?jsx?|[cm]?tsx?)$/.test(edge.specifier);
    if (!bare && !script) continue;
    const pkg = packageOf(edge.from);
    votes.set(pkg, (votes.get(pkg) ?? 0) + (bare ? 1 : -1));
  }
  return (pkg) => (votes.get(pkg) ?? 0) > 0;
}
