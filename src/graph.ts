/**
 * The import graph of a checkout, as the slice walk reads it.
 *
 * Every script file the checkout tracks becomes a `file:` node; each import
 * the compiler resolves to a file in the checkout is an `imports` edge to
 * that file, and every other import (a package, a path that resolves to
 * nothing, a dynamic import of a computed name) an edge to a `dependency:`
 * node, which the walk reports rather than follows. Modules resolve with
 * the nearest `tsconfig.json` (Node's resolution when there is none), and
 * never through `node_modules`, so a workspace package is a bare specifier
 * here, as it is in a snapshot without its installs.
 *
 * Nothing here runs repository code. The same files give the same graph.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  globSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  loadConfig,
  workspacePackages,
  type LoadedConfig,
} from "./extract/compiler-config.js";
import { isAssetPath } from "./project/project.js";
import type { SliceGraph, SliceGraphLink, SliceGraphNode } from "./core.js";

/** Directories never read, whatever Git tracks. */
export const IGNORED_DIRECTORIES: readonly string[] = [
  "vendor",
  "third_party",
  "node_modules",
  ".git",
  "dist",
  "build",
];

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
/** Files a graph reads before it stops; past it the checkout is too large. */
export const GRAPH_FILES_MAX = 50_000;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const posix = (path: string) => path.replaceAll("\\", "/");

function walk(root: string, directory = "", into: string[] = []): string[] {
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.includes(entry.name)) walk(root, path, into);
    } else if (entry.isFile()) into.push(path);
    if (into.length > GRAPH_FILES_MAX)
      throw new Error(
        `More than ${GRAPH_FILES_MAX} files under ${root}; point --repo at the package.`,
      );
  }
  return into;
}

/**
 * The checkout's files, `/`-separated and sorted: what Git tracks plus
 * untracked files it does not ignore, or every file outside Git.
 */
export function listFiles(root: string): string[] {
  let listed: string[];
  try {
    listed = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    listed = walk(root);
  }
  const paths = listed.map(posix);
  // A folder carveout cut inside the checkout is not part of it.
  const carved = paths
    .filter((path) => path === "carveout.json" || path.endsWith("/carveout.json"))
    .map((path) => path.slice(0, -"carveout.json".length));
  return paths
    .filter(
      (path) =>
        !carved.some((prefix) => path.startsWith(prefix)) &&
        !path.split("/").some((part) => IGNORED_DIRECTORIES.includes(part)) &&
        existsSync(join(root, path)) &&
        statSync(join(root, path)).isFile(),
    )
    .sort(compare);
}

/**
 * The checkout's files a Vite glob's patterns match, as the bundler reads
 * them: relative to the importing file's folder, or to the root for a
 * pattern starting with `/`; a `!` pattern excludes. Never node_modules.
 */
export function globMatches(
  root: string,
  directory: string,
  patterns: readonly string[],
): string[] {
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    const base = pattern.startsWith("/") ? root : directory;
    const relativePattern = pattern.replace(/^\/+/, "");
    let found: string[];
    try {
      found = globSync(relativePattern, { cwd: base });
    } catch {
      continue;
    }
    for (const match of found) {
      const absolute = resolve(base, match);
      const rel = posix(relative(root, absolute));
      if (
        rel.startsWith("..") ||
        rel.split("/").some((part) => IGNORED_DIRECTORIES.includes(part)) ||
        !statSync(absolute).isFile()
      )
        continue;
      (negated ? excluded : included).add(rel);
    }
  }
  return [...included].filter((path) => !excluded.has(path)).sort(compare);
}

export interface BuiltGraph {
  readonly graph: SliceGraph;
  /** Script files read, sorted. */
  readonly files: readonly string[];
  /** Files whose `tsconfig.json` could not be read. */
  readonly invalidConfigs: readonly string[];
  /** Where the time went, in milliseconds: resolving is the compiler's
   * configuration and module resolution, parsing the rest of the walk. */
  readonly timings: { readonly listMs: number; readonly parseMs: number; readonly resolveMs: number };
}

export function buildGraph(root: string, listed?: readonly string[]): BuiltGraph {
  const started = performance.now();
  const files = listed ?? listFiles(root);
  const listMs = performance.now() - started;
  let resolveMs = 0;
  const absoluteRoot = resolve(root);
  const inside = (path: string) => {
    const rel = relative(absoluteRoot, resolve(path));
    return (
      !isAbsolute(rel) &&
      !rel.startsWith("..") &&
      !rel.split(/[\\/]/).includes("node_modules")
    );
  };
  // One run sees one tree, so what exists is read once per path, and each
  // compiler configuration keeps one resolution cache for the run.
  const memo = <T>(read: (path: string) => T) => {
    const known = new Map<string, T>();
    return (path: string): T => {
      let value = known.get(path);
      if (value === undefined && !known.has(path)) {
        value = read(path);
        known.set(path, value);
      }
      return value as T;
    };
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: memo((path) => inside(path) && ts.sys.fileExists(path)),
    readFile: memo((path) => (inside(path) ? ts.sys.readFile(path) : undefined)),
    directoryExists: memo((path) => inside(path) && ts.sys.directoryExists(path)),
    getCurrentDirectory: () => absoluteRoot,
    getDirectories: (path) => (inside(path) ? ts.sys.getDirectories(path) : []),
    realpath: (path) => path,
  };
  const scripts = files.filter((file) => SCRIPT.test(file));
  const nodes = new Map<string, SliceGraphNode>();
  const links: SliceGraphLink[] = [];
  const invalidConfigs: string[] = [];
  const fileNode = (path: string) => {
    const id = `file:${path}`;
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        kind: "file",
        label: path,
        sourceFile: path,
        community: null,
        dependencyStatus: null,
        line: null,
      });
    return id;
  };
  const configs = new Map<string, ts.CompilerOptions>();
  const byConfig = new Map<string | null, ts.CompilerOptions>();
  let workspaces: ReadonlyMap<string, string> | undefined;
  const shared = {
    packages: () => (workspaces ??= workspacePackages(absoluteRoot)),
    loaded: new Map<string, LoadedConfig>(),
  };
  const caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  const cacheOf = (options: ts.CompilerOptions) => {
    let cache = caches.get(options);
    if (cache === undefined) {
      cache = ts.createModuleResolutionCache(absoluteRoot, (name) => name, options);
      caches.set(options, cache);
    }
    return cache;
  };
  for (const file of scripts) {
    const absolute = join(absoluteRoot, file);
    const directory = dirname(absolute);
    let options = configs.get(directory);
    if (options === undefined) {
      const resolving = performance.now();
      const loaded = loadConfig(absoluteRoot, absolute, shared);
      if (loaded.errors.length > 0) invalidConfigs.push(file);
      // One options object per tsconfig, so its directories share a cache.
      options = byConfig.get(loaded.path);
      if (options === undefined) {
        options = {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          allowJs: true,
          resolveJsonModule: true,
          ...(loaded.path === null ? {} : loaded.options),
        };
        byConfig.set(loaded.path, options);
      }
      configs.set(directory, options);
      resolveMs += performance.now() - resolving;
    }
    const text = readFileSync(absolute, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const from = fileNode(file);
    const lineOf = (pos: number) =>
      source.getLineAndCharacterOfPosition(pos).line + 1;
    const dependency = (key: string, status: "external" | "unresolved") => {
      const id = `dependency:${file}:${key}`;
      if (!nodes.has(id))
        nodes.set(id, {
          id,
          kind: "dependency",
          label: key,
          sourceFile: file,
          community: null,
          dependencyStatus: status,
          line: null,
        });
      return id;
    };
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const specifier = imported.fileName;
      const resolving = performance.now();
      const result = ts.resolveModuleName(
        specifier,
        absolute,
        options,
        host,
        cacheOf(options),
      ).resolvedModule;
      const line = lineOf(imported.pos);
      // An asset the compiler does not resolve (a stylesheet, an image)
      // is still a file the slice copies when the import names one.
      const asset =
        result === undefined && specifier.startsWith(".")
          ? resolve(dirname(absolute), specifier.split(/[?#]/)[0] ?? "")
          : null;
      const target =
        result !== undefined && inside(result.resolvedFileName)
          ? posix(relative(absoluteRoot, result.resolvedFileName))
          : asset !== null &&
              isAssetPath(asset) &&
              inside(asset) &&
              existsSync(asset) &&
              statSync(asset).isFile()
            ? posix(relative(absoluteRoot, asset))
            : null;
      resolveMs += performance.now() - resolving;
      const bare =
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        !/^[A-Za-z]:[\\/]/.test(specifier);
      links.push({
        source: from,
        target:
          target === null
            ? dependency(specifier, bare ? "external" : "unresolved")
            : fileNode(target),
        relation: "imports",
        confidence: "EXTRACTED",
        specifier,
        location: `L${line}`,
      });
    }
    const visit = (node: ts.Node) => {
      // Vite's `import.meta.glob("./icons/*.svg")`: each file a literal
      // pattern matches is a dependency, as an import of it would be.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "glob" &&
        ts.isMetaProperty(node.expression.expression)
      ) {
        const argument = node.arguments[0];
        const patterns =
          argument === undefined
            ? []
            : ts.isStringLiteralLike(argument)
              ? [argument.text]
              : ts.isArrayLiteralExpression(argument)
                ? argument.elements.flatMap((element) =>
                    ts.isStringLiteralLike(element) ? [element.text] : [],
                  )
                : [];
        const line = lineOf(node.getStart(source));
        for (const match of globMatches(absoluteRoot, directory, patterns))
          if (match !== file)
            links.push({
              source: from,
              target: fileNode(match),
              relation: "imports",
              confidence: "EXTRACTED",
              specifier: null,
              location: `L${line}`,
            });
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        if (argument === undefined || !ts.isStringLiteralLike(argument)) {
          const line = lineOf(node.getStart(source));
          links.push({
            source: from,
            target: dependency(`dynamic:L${line}`, "unresolved"),
            relation: "imports",
            confidence: "EXTRACTED",
            specifier: null,
            location: `L${line}`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const key = (link: SliceGraphLink) =>
    `${link.source}\n${link.target}\n${link.specifier ?? ""}\n${link.location ?? ""}`;
  const unique = [...new Map(links.map((link) => [key(link), link])).values()];
  return {
    graph: {
      nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)),
      links: unique.sort((a, b) => compare(key(a), key(b))),
      communities: new Map(),
    },
    files: scripts,
    invalidConfigs: invalidConfigs.sort(compare),
    timings: {
      listMs: Math.round(listMs),
      resolveMs: Math.round(resolveMs),
      parseMs: Math.round(performance.now() - started - listMs - resolveMs),
    },
  };
}
