import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

export interface LoadedConfig {
  readonly path: string | null;
  readonly options: ts.CompilerOptions;
  readonly rawOptions: Record<string, unknown> | undefined;
  readonly errors: readonly string[];
}

const isInside = (root: string, path: string) => {
  const rel = relative(root, resolve(path));
  return !isAbsolute(rel) && !rel.startsWith("..");
};

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Directories a workspace glob walks before it stops looking. */
const WORKSPACE_DIRECTORIES_MAX = 20_000;

/**
 * The `packages:` list of a `pnpm-workspace.yaml`, block or flow style.
 * Read by line: the file is a list of globs, and the worker has no YAML
 * parser to spare.
 */
export function pnpmWorkspacePatterns(text: string): string[] {
  const unquote = (value: string) =>
    value
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2")
      .trim();
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1) return [];
  const inline = /^packages\s*:\s*\[(.*)\]\s*(#.*)?$/.exec(lines[start] ?? "");
  if (inline !== null)
    return (inline[1] ?? "").split(",").map(unquote).filter(Boolean);
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-\s*(.+?)\s*(#.*)?$/.exec(line);
    if (item === null || (!/^\s/.test(line) && !line.startsWith("-"))) break;
    patterns.push(unquote(item[1] ?? ""));
  }
  return patterns.filter(Boolean);
}

/** Whether one path segment matches one glob segment (`*`, `pkg-*`, `?`). */
function segmentMatches(glob: string, name: string): boolean {
  const pattern = glob
    .split("")
    .map((char) =>
      char === "*"
        ? "[^/]*"
        : char === "?"
          ? "[^/]"
          : char.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}$`).test(name);
}

/**
 * The directories a workspace glob names under `root`: `*` and `?` within
 * one level's name, `**` for any number of levels. `node_modules` and hidden
 * directories are never walked; a walk past `WORKSPACE_DIRECTORIES_MAX`
 * directories stops where it is.
 */
function globDirectories(root: string, pattern: string): string[] {
  const segments = pattern
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  const found = new Set<string>();
  let walked = 0;
  const children = (dir: string) => {
    walked += 1;
    if (walked > WORKSPACE_DIRECTORIES_MAX) return [];
    try {
      // Sorted, so the first of two packages with one name is always the same.
      return readdirSync(dir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name !== "node_modules" &&
            !entry.name.startsWith("."),
        )
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  };
  const visit = (dir: string, at: number) => {
    if (!isInside(root, dir)) return;
    if (at === segments.length) {
      found.add(dir);
      return;
    }
    const segment = segments[at] ?? "";
    if (segment === "**") {
      visit(dir, at + 1);
      for (const name of children(dir)) visit(join(dir, name), at);
    } else if (segment === "..") {
      visit(dirname(dir), at + 1);
    } else if (!/[*?]/.test(segment)) {
      const next = join(dir, segment);
      if (existsSync(next)) visit(next, at + 1);
    } else
      for (const name of children(dir))
        if (segmentMatches(segment, name)) visit(join(dir, name), at + 1);
  };
  visit(root, 0);
  return [...found];
}

/**
 * The globs that say where the repository's workspace packages live: the
 * root `package.json`'s `workspaces` (npm and Yarn, a list or
 * `{ packages }`), `pnpm-workspace.yaml`'s `packages` and `lerna.json`'s
 * `packages`.
 */
function workspacePatterns(root: string): string[] {
  const manifest = readJson(join(root, "package.json"));
  const declared = isRecord(manifest) ? manifest["workspaces"] : undefined;
  const lerna = readJson(join(root, "lerna.json"));
  let pnpm = "";
  try {
    pnpm = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    pnpm = "";
  }
  return [
    ...(Array.isArray(declared)
      ? declared
      : isRecord(declared) && Array.isArray(declared["packages"])
        ? declared["packages"]
        : []),
    ...pnpmWorkspacePatterns(pnpm),
    ...(isRecord(lerna) && Array.isArray(lerna["packages"])
      ? lerna["packages"]
      : []),
  ].filter((pattern): pattern is string => typeof pattern === "string");
}

/**
 * The repository's own workspace packages, by name, to their directories.
 * A shared base (`@scope/tsconfig/react.json`) is usually one of them, and a
 * snapshot has no node_modules to find it in; and an import of one is the
 * repository's own code, which the slice must never fetch by its name.
 * Every directory a workspace glob names (`workspacePatterns`) that holds a
 * named `package.json`, less those a `!` glob excludes.
 */
export function workspacePackages(root: string): Map<string, string> {
  const included: string[] = [];
  const excluded = new Set<string>();
  for (const pattern of workspacePatterns(root)) {
    if (pattern.startsWith("!"))
      for (const directory of globDirectories(root, pattern.slice(1)))
        excluded.add(directory);
    else included.push(...globDirectories(root, pattern));
  }
  const packages = new Map<string, string>();
  for (const directory of included) {
    if (excluded.has(directory)) continue;
    const own = readJson(join(directory, "package.json"));
    const name = isRecord(own) ? own["name"] : undefined;
    if (typeof name === "string" && !packages.has(name))
      packages.set(name, directory);
  }
  return packages;
}

/** A bare specifier split into its package name and the path within it. */
function packageSpecifier(specifier: string): {
  readonly name: string;
  readonly subpath: string;
} {
  const parts = specifier.split("/");
  const size = specifier.startsWith("@") ? 2 : 1;
  return {
    name: parts.slice(0, size).join("/"),
    subpath: parts.slice(size).join("/"),
  };
}

/**
 * Where a path under some `node_modules` really is, when the package is one
 * of the repository's workspaces; any other path is itself.
 */
function throughWorkspaces(
  path: string,
  packages: () => ReadonlyMap<string, string>,
): string {
  const normalized = path.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const at = normalized.lastIndexOf(marker);
  if (at === -1) return path;
  const { name, subpath } = packageSpecifier(
    normalized.slice(at + marker.length),
  );
  const directory = packages().get(name);
  return directory === undefined ? path : join(directory, subpath);
}

/** The file a bare `extends` names, when its package is a workspace. */
function workspaceBase(
  specifier: string,
  packages: () => ReadonlyMap<string, string>,
): string | undefined {
  const { name, subpath } = packageSpecifier(specifier);
  const directory = packages().get(name);
  if (directory === undefined) return undefined;
  if (subpath === "") {
    // A package's own `tsconfig` field names its base, as TypeScript reads it.
    const manifest = readJson(join(directory, "package.json"));
    const named = isRecord(manifest) ? manifest["tsconfig"] : undefined;
    return typeof named === "string" && named !== ""
      ? resolve(directory, named)
      : join(directory, "tsconfig.json");
  }
  const target = join(directory, subpath);
  return target.endsWith(".json") ||
    (existsSync(target) && statSync(target).isFile())
    ? target
    : `${target}.json`;
}

/** Read once, on the first bare base: most configs never need it. */
function lazyWorkspaces(root: string): () => ReadonlyMap<string, string> {
  let packages: Map<string, string> | undefined;
  return () => (packages ??= workspacePackages(root));
}

/**
 * The nearest `tsconfig.json` above a file, read without following `extends`
 * outside the root. A base in an installed package resolves when the
 * package is one of the repository's own workspaces.
 */
export function loadConfig(root: string, file: string): LoadedConfig {
  let config: string | undefined;
  for (let dir = dirname(resolve(root, file)); ; dir = dirname(dir)) {
    const rel = relative(root, dir);
    if (rel.startsWith("..") || isAbsolute(rel)) break;
    const candidate = resolve(dir, "tsconfig.json");
    if (existsSync(candidate)) {
      config = candidate;
      break;
    }
    if (rel === "") break;
  }
  const defaults: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    resolveJsonModule: true,
  };
  if (config === undefined)
    return { path: null, options: defaults, rawOptions: undefined, errors: [] };
  // TypeScript looks for a package base under node_modules; the snapshot
  // has none, so those lookups are answered from the workspaces.
  const packages = lazyWorkspaces(root);
  const real = (path: string) => throughWorkspaces(path, packages);
  const exists = (path: string) =>
    isInside(root, real(path)) && existsSync(real(path));
  const read = (path: string) =>
    exists(path) ? readFileSync(real(path), "utf8") : undefined;
  const loaded = ts.readConfigFile(config, read);
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config ?? {},
    {
      fileExists: exists,
      readFile: read,
      realpath: real,
      readDirectory: () => [],
      useCaseSensitiveFileNames: true,
    },
    dirname(config),
    undefined,
    config,
  );
  const errors = [
    ...(loaded.error === undefined ? [] : [loaded.error]),
    ...parsed.errors.filter((error) => error.code !== 18003),
  ].map((error) => ts.flattenDiagnosticMessageText(error.messageText, " "));
  return {
    path: relative(root, config).replaceAll("\\", "/"),
    options: { ...defaults, ...parsed.options },
    rawOptions: rawOptionsOf(root, config),
    errors,
  };
}

/** Active recursion detects cycles; a base resolved on a sibling branch still applies. */
function rawOptionsOf(
  root: string,
  configPath: string,
): Record<string, unknown> | undefined {
  const packages = lazyWorkspaces(root);
  const active = new Set<string>();
  const cache = new Map<string, Record<string, unknown>>();
  const resolveOptions = (path: string): Record<string, unknown> => {
    const rel = relative(root, path);
    if (
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      active.has(path) ||
      !existsSync(path)
    )
      return {};
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    active.add(path);
    const config = ts.readConfigFile(path, ts.sys.readFile).config as
      { extends?: unknown; compilerOptions?: unknown } | undefined;
    const bases =
      typeof config?.extends === "string"
        ? [config.extends]
        : Array.isArray(config?.extends)
          ? config.extends.filter(
              (base): base is string => typeof base === "string",
            )
          : [];
    let options: Record<string, unknown> = {};
    for (const base of bases) {
      // Snapshots have no installed packages: a bare base resolves only to
      // one of the repository's workspaces, and never outside it.
      if (!base.startsWith(".")) {
        const target = workspaceBase(base, packages);
        if (target !== undefined)
          options = { ...options, ...resolveOptions(target) };
        continue;
      }
      const target = resolve(dirname(path), base);
      options = {
        ...options,
        ...resolveOptions(
          target.endsWith(".json") || existsSync(target)
            ? target
            : `${target}.json`,
        ),
      };
    }
    const own = config?.compilerOptions;
    if (own !== null && typeof own === "object" && !Array.isArray(own))
      options = { ...options, ...own };
    active.delete(path);
    cache.set(path, options);
    return options;
  };
  const options = resolveOptions(configPath);
  return Object.keys(options).length === 0 ? undefined : options;
}

/** Conditions an `exports` target is read under, types first. */
const EXPORT_CONDITIONS = [
  "types",
  "typings",
  "import",
  "module",
  "node",
  "default",
  "require",
];

/** The target an `exports` map gives a package subpath, or null. */
export function exportTarget(exports: unknown, subpath: string): string | null {
  const key = subpath === "" ? "." : `./${subpath}`;
  const conditional = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const target = conditional(item);
        if (target !== null) return target;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    for (const condition of EXPORT_CONDITIONS)
      if (condition in value) {
        const target = conditional(value[condition]);
        if (target !== null) return target;
      }
    return null;
  };
  // A string, an array or a map of conditions is the root's alone.
  if (
    !isRecord(exports) ||
    !Object.keys(exports).some((name) => name.startsWith("."))
  )
    return key === "." ? conditional(exports) : null;
  if (key in exports) return conditional(exports[key]);
  for (const pattern of Object.keys(exports)) {
    const [prefix, suffix, ...more] = pattern.split("*");
    if (prefix === undefined || suffix === undefined || more.length > 0)
      continue;
    if (
      key.length >= prefix.length + suffix.length &&
      key.startsWith(prefix) &&
      key.endsWith(suffix)
    ) {
      const target = conditional(exports[pattern]);
      return target === null
        ? null
        : target.replaceAll(
            "*",
            key.slice(prefix.length, key.length - suffix.length),
          );
    }
  }
  return null;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * The repository source a bare specifier of one of the repository's own
 * packages stands for, by path, or null for any other specifier. The
 * package's `exports` (or `types`, `module`, `main`) name what it ships,
 * which is usually a build output the snapshot does not have; a target
 * under the package's `outDir` is read back under its `rootDir`, as the
 * build wrote it from there, and a script target that is not an output is
 * the source itself. Memoized; the resolver never leaves the root.
 */
export function workspaceModuleResolver(
  root: string,
  packages: () => ReadonlyMap<string, string>,
): (specifier: string) => string | null {
  const found = new Map<string, string | null>();
  const isFile = (path: string) =>
    isInside(root, path) &&
    !path.split(/[\\/]/).includes("node_modules") &&
    existsSync(path) &&
    statSync(path).isFile();
  const locate = (specifier: string): string | null => {
    if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
    const { name, subpath } = packageSpecifier(specifier);
    const directory = packages().get(name);
    if (directory === undefined) return null;
    const manifest = readJson(join(directory, "package.json"));
    const own = isRecord(manifest) ? manifest : {};
    const field = (key: string) => {
      const value = own[key];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const target =
      own["exports"] !== undefined
        ? exportTarget(own["exports"], subpath)
        : subpath !== ""
          ? subpath
          : (field("types") ??
            field("typings") ??
            field("module") ??
            field("main") ??
            "index");
    if (target === null) return null;
    const absolute = resolve(directory, target);
    const base = absolute.replace(/(\.d)?\.[cm]?[jt]sx?$/, "");
    const { outDir, rootDir } = loadConfig(
      root,
      join(directory, "package.json"),
    ).options;
    const built =
      typeof outDir === "string" &&
      !relative(outDir, base).startsWith("..") &&
      !isAbsolute(relative(outDir, base));
    const bases = built
      ? [join(rootDir ?? join(directory, "src"), relative(outDir, base)), base]
      : [base];
    for (const candidate of bases)
      for (const extension of SOURCE_EXTENSIONS)
        for (const path of [
          `${candidate}${extension}`,
          join(candidate, `index${extension}`),
        ])
          if (isFile(path)) return relative(root, path).replaceAll("\\", "/");
    // A JavaScript package's own source, when it is not a build output.
    if (!built && /\.[cm]?jsx?$/.test(absolute) && isFile(absolute))
      return relative(root, absolute).replaceAll("\\", "/");
    return null;
  };
  return (specifier) => {
    const hit = found.get(specifier);
    if (hit !== undefined) return hit;
    const module = locate(specifier);
    found.set(specifier, module);
    return module;
  };
}

export function nearestCompilerOptions(
  root: string,
  file: string,
): Record<string, unknown> | undefined {
  return loadConfig(root, file).rawOptions;
}
