/**
 * The import graph of a checkout, as the slice walk reads it.
 *
 * Every script file the checkout tracks becomes a `file:` node, with the
 * names it exports itself. Each import, re-export and module reference the
 * compiler resolves to a file in the checkout is a link to that file, with
 * the names it takes and whether only types; each literal path a file reads
 * at runtime is a `reads` link. Every other import (a package, a path that
 * resolves to nothing, a dynamic import of a computed name) is a link to a
 * `dependency:` node, which the walk reports rather than follows. Modules resolve with
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
import {
  ALL,
  isDataPath,
  isScriptPath,
  namespaceUses,
} from "./extract/typescript.js";
import { isAssetPath } from "./project/project.js";
import {
  reach,
  type FileExports,
  type ReachOptions,
  type ReachResult,
  type SliceBudget,
  type SliceGraph,
  type SliceGraphLink,
  type SliceGraphNode,
} from "./core.js";

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

/** The graph of every script file of the checkout. */
export function buildGraph(root: string, listed?: readonly string[]): BuiltGraph {
  const started = performance.now();
  const files = listed ?? listFiles(root);
  const builder = graphBuilder(root, files, performance.now() - started);
  builder.add(files);
  return builder.built();
}

/**
 * The graph a slice walk needs, read lazily: the entry points, every file
 * the walk reaches, what those files name and what that re-exports (so a
 * barrel and an import of types are judged from their targets), and every
 * file that may import the slice. The walk on this graph gives what it
 * gives on the whole checkout's graph, without parsing the rest of a large
 * monorepo.
 *
 * Importers are found by text first and confirmed by the compiler: a file
 * is read when it mentions an included file's name (its folder's, for an
 * `index`), an alias with no wildcard that maps to it, `import.meta.glob`,
 * or an import of folders alone (`.`, `..`, `../..`). A relative or wildcard-alias import spells
 * the file's name or its folder's, and a workspace package's name is a
 * package here, not a link, so no importer is missed for being unread.
 */
export function walkGraph(
  root: string,
  entryPoints: readonly string[],
  budget: SliceBudget,
  options: ReachOptions = {},
): { built: BuiltGraph; walk: ReachResult } {
  const started = performance.now();
  const files = listFiles(root);
  const builder = graphBuilder(root, files, performance.now() - started);
  const absoluteRoot = resolve(root);
  const scripts = files.filter((file) => SCRIPT.test(file));
  const prefixes = entryPoints.map((entry) =>
    entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, ""),
  );
  builder.add(
    scripts.filter((file) =>
      prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
    ),
  );
  const aliases = exactAliases(absoluteRoot, files);
  const searched = new Set<string>();
  const read = new Set<string>();
  for (;;) {
    const built = builder.built();
    for (const file of built.files) read.add(file);
    const walk = reach(built.graph, entryPoints, budget, options);
    // What the reached files name, and what that forwards to in turn.
    const outOf = new Map<string, SliceGraphLink[]>();
    for (const link of built.graph.links)
      if (link.target.startsWith("file:")) {
        const from = link.source.slice("file:".length);
        const list = outOf.get(from) ?? [];
        list.push(link);
        outOf.set(from, list);
      }
    const wanted = new Set<string>();
    const reached = [...walk.included, ...walk.dropped];
    for (const file of reached)
      for (const link of outOf.get(file) ?? [])
        wanted.add(link.target.slice("file:".length));
    const queue = [...wanted];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      for (const link of outOf.get(file) ?? []) {
        const to = link.target.slice("file:".length);
        if (link.forwards !== null && !wanted.has(to)) {
          wanted.add(to);
          queue.push(to);
        }
      }
    }
    const needles = new Set<string>();
    for (const file of walk.included) {
      if (searched.has(file)) continue;
      searched.add(file);
      for (const needle of needlesOf(file, aliases)) needles.add(needle);
    }
    if (needles.size > 0) {
      const pattern = new RegExp(
        [...needles]
          .map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .concat(["import\\.meta\\.glob", "(['\"`])(?:\\.\\.?/)*\\.\\.?/?\\1"])
          .join("|"),
        "i",
      );
      for (const file of scripts)
        if (!read.has(file) && pattern.test(readFileSync(join(absoluteRoot, file), "utf8")))
          wanted.add(file);
    }
    const fresh = [...wanted].filter((file) => !read.has(file) && SCRIPT.test(file));
    if (fresh.length === 0) return { built, walk };
    builder.add(fresh);
  }
}

/** A path without its script extension or a trailing `/index`. */
const moduleKey = (path: string) =>
  path.replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");

/**
 * What an import of `file` must spell: its name, its folder's for an
 * index, or an exact alias that maps to it.
 */
function needlesOf(
  file: string,
  aliases: ReadonlyMap<string, readonly string[]>,
): string[] {
  const parts = file.split("/");
  const base = (parts.at(-1) ?? file).replace(/\.d\.[cm]?ts$|\.[^.]+$/, "");
  const needles = [base];
  if (base === "index" && parts.length > 1) needles.push(parts.at(-2) ?? "");
  needles.push(...(aliases.get(moduleKey(file)) ?? []));
  return needles.filter((needle) => needle !== "");
}

/**
 * Alias keys with no wildcard, by the module they map to: compiler `paths`
 * (from the config's folder or its `baseUrl`) and package.json `imports`.
 * An import through one need not spell the file's name.
 */
function exactAliases(root: string, files: readonly string[]): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const add = (key: string, target: unknown, base: string) => {
    if (typeof target === "string") {
      const module = moduleKey(posix(relative(root, resolve(root, base, target))));
      aliases.set(module, [...(aliases.get(module) ?? []), key]);
    } else if (Array.isArray(target)) for (const item of target) add(key, item, base);
    else if (target !== null && typeof target === "object")
      for (const item of Object.values(target)) add(key, item, base);
  };
  for (const file of files) {
    const base = file.split("/").at(-1) ?? file;
    const directory = dirname(file);
    try {
      if (/^[jt]sconfig.*\.json$/.test(base)) {
        const options = (
          ts.parseConfigFileTextToJson(file, readFileSync(join(root, file), "utf8"))
            .config as { compilerOptions?: { paths?: unknown; baseUrl?: unknown } } | undefined
        )?.compilerOptions;
        const paths = options?.paths;
        const from = join(
          directory,
          typeof options?.baseUrl === "string" ? options.baseUrl : ".",
        );
        if (paths !== null && typeof paths === "object")
          for (const [key, target] of Object.entries(paths))
            if (!key.includes("*")) add(key, target, from);
      } else if (base === "package.json") {
        const imports = (
          JSON.parse(readFileSync(join(root, file), "utf8")) as { imports?: unknown }
        ).imports;
        if (imports !== null && typeof imports === "object")
          for (const [key, target] of Object.entries(imports))
            if (!key.includes("*")) add(key, target, directory);
      }
    } catch {
      // A configuration that does not parse maps nothing.
    }
  }
  return aliases;
}

/**
 * Reads files into one graph as they are asked for, each once: what
 * `buildGraph` reads all of and `walkGraph` reads as the walk needs.
 */
function graphBuilder(
  root: string,
  files: readonly string[],
  listMs: number,
): { add: (paths: Iterable<string>) => void; built: () => BuiltGraph } {
  const started = performance.now() - listMs;
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
  const scripts: string[] = [];
  const listedFiles = new Set(files);
  const listedDirectories = new Set<string>();
  for (const file of files)
    for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1))
      listedDirectories.add(file.slice(0, at));
  const nodes = new Map<string, SliceGraphNode>();
  const exportsOf = new Map<string, FileExports | null>();
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
        dependencyStatus: null,
        exports: null,
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
  const read = (file: string) => {
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
    exportsOf.set(file, ownExports(source));
    const dependency = (
      key: string,
      status: "external" | "unresolved" | "path",
    ) => {
      const id = `dependency:${file}:${key}`;
      if (!nodes.has(id))
        nodes.set(id, {
          id,
          kind: "dependency",
          label: key,
          sourceFile: file,
          dependencyStatus: status,
          exports: null,
        });
      return id;
    };
    const facts = factsOf(source);
    for (const fact of facts.modules) {
      const { specifier } = fact;
      const resolving = performance.now();
      const result = ts.resolveModuleName(
        specifier,
        absolute,
        options,
        host,
        cacheOf(options),
      ).resolvedModule;
      // An asset the compiler does not resolve (a stylesheet, an image)
      // is still a file the slice copies when the import names one.
      const asset =
        result === undefined && specifier.startsWith(".")
          ? resolve(directory, specifier.split(/[?#]/)[0] ?? "")
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
        relation: fact.relation,
        specifier,
        location: `L${fact.line}`,
        typeOnly: fact.typeOnly,
        names: fact.names,
        forwards: fact.forwards,
      });
    }
    // A path read at runtime: a file the slice can copy is a link to it;
    // anything else the checkout has there (a folder, a file of another
    // kind) a dependency the cut reports. A path the checkout has nothing
    // at is made at runtime, by the repository as by the slice.
    for (const read of facts.reads) {
      const target = posix(relative(absoluteRoot, resolve(directory, read.path)));
      const copyable =
        listedFiles.has(target) && (isScriptPath(target) || isDataPath(target));
      if (
        !copyable &&
        !listedFiles.has(target) &&
        !listedDirectories.has(target)
      )
        continue;
      links.push({
        source: from,
        target: copyable ? fileNode(target) : dependency(target, "path"),
        relation: "reads",
        specifier: null,
        location: `L${read.line}`,
        typeOnly: false,
        names: null,
        forwards: null,
      });
    }
    // Vite's `import.meta.glob("./icons/*.svg")`: each file a literal
    // pattern matches is a dependency, as an import of it would be.
    for (const glob of facts.globs)
      for (const match of globMatches(absoluteRoot, directory, glob.patterns))
        if (match !== file)
          links.push({
            source: from,
            target: fileNode(match),
            relation: "imports",
            specifier: null,
            location: `L${glob.line}`,
            typeOnly: false,
            names: null,
            forwards: null,
          });
    for (const line of facts.computed)
      links.push({
        source: from,
        target: dependency(`dynamic:L${line}`, "unresolved"),
        relation: "imports",
        specifier: null,
        location: `L${line}`,
        typeOnly: false,
        names: null,
        forwards: null,
      });
  };
  const parsed = new Set<string>();
  const key = (link: SliceGraphLink) =>
    `${link.source}\n${link.target}\n${link.relation}\n${link.specifier ?? ""}\n${link.location ?? ""}`;
  return {
    add: (paths) => {
      for (const file of [...paths].sort(compare))
        if (!parsed.has(file) && listedFiles.has(file) && SCRIPT.test(file)) {
          parsed.add(file);
          scripts.push(file);
          read(file);
        }
    },
    built: () => {
      const unique = [...new Map(links.map((link) => [key(link), link])).values()];
      return {
        graph: {
          nodes: [...nodes.values()]
            .map((node) =>
              node.kind === "file"
                ? { ...node, exports: exportsOf.get(node.sourceFile) ?? null }
                : node,
            )
            .sort((a, b) => compare(a.id, b.id)),
          links: unique.sort((a, b) => compare(key(a), key(b))),
        },
        files: [...scripts].sort(compare),
        invalidConfigs: [...invalidConfigs].sort(compare),
        timings: {
          listMs: Math.round(listMs),
          resolveMs: Math.round(resolveMs),
          parseMs: Math.round(performance.now() - started - listMs - resolveMs),
        },
      };
    },
  };
}

/** One module a file names, as the walk follows it. */
interface ModuleFact {
  readonly relation: "imports" | "references";
  readonly specifier: string;
  readonly line: number;
  readonly typeOnly: boolean;
  readonly names: readonly string[] | null;
  readonly forwards: SliceGraphLink["forwards"];
}

/** Calls that name a module to a test runner or a resolver. */
const MODULE_REFERENCES: readonly string[] = [
  "vi.mock",
  "vi.doMock",
  "vi.unmock",
  "vi.doUnmock",
  "vi.importActual",
  "vi.importMock",
  "jest.mock",
  "jest.doMock",
  "jest.unmock",
  "jest.dontMock",
  "jest.requireActual",
  "jest.requireMock",
  "jest.createMockFromModule",
  "require.resolve",
  "import.meta.resolve",
];

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
const isDefault = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
  );

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text);
  else
    for (const element of name.elements)
      if (ts.isBindingElement(element)) bindingNames(element.name, into);
}

/**
 * The names a file declares and exports itself; null after `export =`. A
 * local `export { x }` of an imported `x` is a forward, which `factsOf`
 * puts on the import instead.
 */
function ownExports(source: ts.SourceFile): FileExports | null {
  const imported = importedBindings(source);
  const values = new Set<string>();
  const types = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals === true) return null;
      values.add("default");
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements)
        if (!imported.has((element.propertyName ?? element.name).text))
          (statement.isTypeOnly || element.isTypeOnly ? types : values).add(
            element.name.text,
          );
    } else if (isExported(statement)) {
      const name = isDefault(statement) ? "default" : null;
      if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      )
        types.add(name ?? statement.name.text);
      else if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          bindingNames(declaration.name, values);
      else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement)) &&
        (name !== null ||
          (statement.name !== undefined && ts.isIdentifier(statement.name)))
      )
        values.add(name ?? (statement.name as ts.Identifier).text);
    }
  }
  return {
    values: [...values].sort(compare),
    types: [...types].sort(compare),
  };
}

/** Each name an import binds, to the statement and the name it imports. */
function importedBindings(
  source: ts.SourceFile,
): Map<string, { statement: ts.ImportDeclaration; name: string }> {
  const bound = new Map<string, { statement: ts.ImportDeclaration; name: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined)
      bound.set(clause.name.text, { statement, name: "default" });
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings))
      bound.set(bindings.name.text, { statement, name: "*" });
    else if (bindings !== undefined)
      for (const element of bindings.elements)
        bound.set(element.name.text, {
          statement,
          name: (element.propertyName ?? element.name).text,
        });
  }
  return bound;
}

/**
 * What a file names, from its syntax: the modules it imports, re-exports
 * or references, the paths it reads, its Vite globs, and the lines of
 * imports of a computed name.
 */
function factsOf(source: ts.SourceFile): {
  modules: ModuleFact[];
  reads: { path: string; line: number }[];
  globs: { patterns: string[]; line: number }[];
  computed: number[];
} {
  const modules: ModuleFact[] = [];
  const reads: { path: string; line: number }[] = [];
  const globs: { patterns: string[]; line: number }[] = [];
  const computed: number[] = [];
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = (node: ts.Node | undefined) =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
  const textOf = (node: ts.Node) => node.getText(source).replace(/\s+/g, "");
  // `import { x } from "./a"; export { x }` forwards x, as `export { x }
  // from "./a"` would.
  const forwarded = new Map<ts.ImportDeclaration, [string, string][]>();
  const imported = importedBindings(source);
  for (const statement of source.statements)
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) {
        const binding = imported.get((element.propertyName ?? element.name).text);
        if (binding === undefined) continue;
        const list = forwarded.get(binding.statement) ?? [];
        list.push([binding.name, element.name.text]);
        forwarded.set(binding.statement, list);
      }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      const clause = node.importClause;
      if (specifier !== null) {
        const names = new Set<string>();
        let all = clause === undefined;
        let types = 0;
        if (clause !== undefined) {
          if (clause.name !== undefined) names.add("default");
          const bindings = clause.namedBindings;
          if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            const used = namespaceUses(
              source.statements,
              bindings.name.text,
              bindings.name,
            );
            if (used === ALL) all = true;
            else for (const name of used) names.add(name);
          } else if (bindings !== undefined)
            for (const element of bindings.elements)
              if (element.isTypeOnly) types += 1;
              else names.add((element.propertyName ?? element.name).text);
        }
        const forwards = forwarded.get(node) ?? null;
        modules.push({
          relation: "imports",
          specifier,
          line: lineOf(node),
          typeOnly:
            clause !== undefined &&
            (clause.isTypeOnly ||
              (types > 0 && names.size === 0 && !all && forwards === null)),
          // `import {} from "x"` loads x as a side-effect import does.
          names: all || (names.size === 0 && types === 0) ? null : [...names].sort(compare),
          forwards,
        });
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier === null) return;
      const clause = node.exportClause;
      const forwards: SliceGraphLink["forwards"] =
        clause === undefined
          ? "*"
          : ts.isNamespaceExport(clause)
            ? [["*", clause.name.text]]
            : clause.elements.map((element) => [
                (element.propertyName ?? element.name).text,
                element.name.text,
              ]);
      modules.push({
        relation: "imports",
        specifier,
        line: lineOf(node),
        typeOnly:
          node.isTypeOnly ||
          (clause !== undefined &&
            ts.isNamedExports(clause) &&
            clause.elements.length > 0 &&
            clause.elements.every((element) => element.isTypeOnly)),
        // A re-export takes nothing for the file's own code.
        names: [],
        forwards,
      });
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = literal(node.moduleReference.expression);
      if (specifier !== null)
        modules.push({
          relation: "imports",
          specifier,
          line: lineOf(node),
          typeOnly: node.isTypeOnly,
          names: null,
          forwards: null,
        });
      return;
    }
    if (ts.isImportTypeNode(node)) {
      const specifier =
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
          ? node.argument.literal.text
          : null;
      if (specifier !== null)
        modules.push({
          relation: "imports",
          specifier,
          line: lineOf(node),
          typeOnly: true,
          names: null,
          forwards: null,
        });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const argument = node.arguments[0];
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      ) {
        const specifier = literal(argument);
        if (specifier === null) computed.push(lineOf(node));
        else
          modules.push({
            relation: "imports",
            specifier,
            line: lineOf(node),
            typeOnly: false,
            names: null,
            forwards: null,
          });
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "glob" &&
        ts.isMetaProperty(callee.expression)
      ) {
        // Vite's `import.meta.glob`, of one pattern or a list of them.
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
        globs.push({ patterns, line: lineOf(node) });
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        MODULE_REFERENCES.includes(textOf(callee))
      ) {
        const specifier = literal(argument);
        if (specifier !== null)
          modules.push({
            relation: "references",
            specifier,
            line: lineOf(node),
            typeOnly: false,
            names: null,
            forwards: null,
          });
      } else if (
        (ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression)
            ? callee.name.text
            : null) !== null &&
        ["join", "resolve"].includes(
          ts.isIdentifier(callee)
            ? callee.text
            : (callee as ts.PropertyAccessExpression).name.text,
        ) &&
        argument !== undefined &&
        ["__dirname", "import.meta.dirname"].includes(textOf(argument))
      ) {
        // `join(__dirname, "fixtures", "a.json")`: a path from the file's
        // folder, when every other part is a literal.
        const parts = node.arguments.slice(1).map(literal);
        if (parts.length > 0 && parts.every((part) => part !== null))
          reads.push({ path: parts.join("/"), line: lineOf(node) });
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments !== undefined &&
      node.arguments[1] !== undefined &&
      textOf(node.arguments[1]) === "import.meta.url"
    ) {
      // `new URL("./worker.ts", import.meta.url)`: a file beside this one.
      const path = literal(node.arguments[0]);
      if (path !== null && !path.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(path))
        reads.push({ path: path.split(/[?#]/)[0] ?? path, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { modules, reads, globs, computed };
}
