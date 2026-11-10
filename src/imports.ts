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
import { relativeSpecifier, type ImportRewrite } from "./core.js";
import { moduleSpecifiers, rewriteSpecifiers } from "./specifiers.js";

/**
 * `text` with the folder's import rewrites put back as the source wrote
 * them. Two specifiers the cut rewrote to one (`@/lib/format` and
 * `../../lib/format` both to `../../lib/format.js`) are told apart by
 * `original`, the file as the cut read it: they come back in the order it
 * wrote them. Without it, the last recorded wins. `path` tells the parser
 * what kind of file the text is (`.tsx` reads JSX); a `.ts` without it.
 */
export function undoRewrites(
  text: string,
  rewrites: readonly ImportRewrite[],
  original: string | null = null,
  path = "file.ts",
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
    for (const { specifier } of moduleSpecifiers(path, original))
      for (const [to, list] of froms)
        if (list.length > 1 && list.includes(specifier))
          queues.set(to, [...(queues.get(to) ?? []), specifier]);
  return rewriteSpecifiers(path, text, ({ specifier }) => {
    const list = froms.get(specifier);
    if (list === undefined) return null;
    return queues.get(specifier)?.shift() ?? list.at(-1) ?? specifier;
  });
}

/** Every specifier a source writes, in source order. */
export function specifiersOf(text: string, path = "file.ts"): Set<string> {
  return new Set(moduleSpecifiers(path, text).map((item) => item.specifier));
}

const isRelative = (specifier: string) =>
  specifier.startsWith("./") || specifier.startsWith("../");

/** How a package spells a relative import's extension. */
export type ExtensionStyle = "none" | "js" | "ts";

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
  /**
   * How a package writes the extension of a relative import: none, the
   * emitted `.js`, or the source's own `.ts` (Node's type stripping,
   * `allowImportingTsExtensions`).
   */
  readonly extensionStyle: (pkg: string) => ExtensionStyle;
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
      : // The source before a `.js` of the same name: in a folder that was
        // built, that is what the build emitted beside it.
        [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, base];
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
  const undone = undoRewrites(text, rewrites, original, file);
  const kept = original === null ? new Set<string>() : specifiersOf(original, file);
  const crossPackage: string[] = [];
  const restored = rewriteSpecifiers(file, undone, ({ specifier }) => {
    if (!isRelative(specifier) || kept.has(specifier)) return null;
    const target = importTarget(file, specifier, context);
    if (target === null) return null;
    const spelling = spellingOf(file, target, context);
    if (spelling === null) crossPackage.push(specifier);
    return spelling ?? relativeIn(file, target, context);
  });
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
  const style = context.extensionStyle(context.packageOf(file));
  if (style === "js") return written;
  if (style === "ts") {
    // The target's own extension: `.tsx` stays `.tsx`, `.mts` stays `.mts`.
    const extension = /\.[cm]?tsx?$/.exec(target)?.[0];
    return extension === undefined
      ? written
      : written.replace(/\.[cm]?jsx?$/, extension.replace(/^\.d(?=\.)/, ""));
  }
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
 * How each package writes relative imports, by the imports the cut read
 * there: without an extension, with the emitted `.js`, or with the
 * source's `.ts`. The most common style wins; `.js` on a tie or none.
 */
export function extensionStyles(
  edges: readonly { from: string; specifier: string }[],
  packageOf: (path: string) => string,
): (pkg: string) => ExtensionStyle {
  const votes = new Map<string, Record<ExtensionStyle, number>>();
  for (const edge of edges) {
    if (!isRelative(edge.specifier)) continue;
    const style: ExtensionStyle | null = !/\.[a-z0-9]+$/i.test(edge.specifier)
      ? "none"
      : /\.[cm]?tsx?$/.test(edge.specifier) && !/\.d\.[cm]?ts$/.test(edge.specifier)
        ? "ts"
        : /\.[cm]?jsx?$/.test(edge.specifier)
          ? "js"
          : null;
    if (style === null) continue;
    const pkg = packageOf(edge.from);
    const counts = votes.get(pkg) ?? { none: 0, js: 0, ts: 0 };
    counts[style] += 1;
    votes.set(pkg, counts);
  }
  return (pkg) => {
    const counts = votes.get(pkg);
    if (counts === undefined) return "js";
    if (counts.ts > counts.js && counts.ts >= counts.none) return "ts";
    if (counts.none > counts.js && counts.none > counts.ts) return "none";
    return "js";
  };
}
