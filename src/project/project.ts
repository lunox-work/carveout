/**
 * The standalone project a cut becomes, as a pure function of the slice,
 * the copied source and the dependency resolution.
 *
 * Copied source keeps its repository structure. Everything generated lives
 * apart from it under `carveout/` and is classified: declaration stubs
 * beside runtime mocks for the modules the slice imports from outside,
 * mock packages for the packages it does not install, the recording mock
 * runtime and the ambient declarations the slice compiled against, an
 * interface test for the surface outside code imports, and the
 * configuration that makes `npm ci`, `npm run dev`, `npm run build` and
 * `npm test` work on a clean machine with no credentials.
 *
 * An import the source makes through a compiler alias is rewritten to a
 * relative path and recorded, so `carveout patch` can undo it; a bare
 * specifier that neither a package nor a cut module explains is a blocker,
 * never a guess. Bodies of copied source are never rewritten beyond those
 * specifiers.
 */

import { createHash } from "node:crypto";
import ts from "typescript";
import { vitestConfigText, type VitestSettings } from "./vitest-config.js";
import type {
  BoundaryContract,
  BoundaryModule,
  BoundarySymbol,
  SliceManifest,
} from "../slice/manifest.js";
import {
  SANDBOX_COMMANDS,
  SANDBOX_TOOLCHAIN,
  type Toolchain,
} from "./build.js";
import {
  isPackageName,
  packageNameOf,
  type PathClass,
  type ResolvedDependency,
} from "./provenance.js";
import {
  TEST_PATH_PATTERN,
  isTestPath,
  testRunnerOf,
} from "../slice/reach.js";
import { GLOBAL_CALL_SOURCE, usesTestGlobals } from "./runner.js";
import { scanSecrets, secretBlockers } from "./secrets.js";
import { moduleSpecifiers, rewriteSpecifiers } from "../specifiers.js";

export const HARNESS_DIR = "carveout";
export const MOCKS_DIR = `${HARNESS_DIR}/packages`;
/** Mocks of modules that are no package (`virtual:build-info`), with the loader's map of them. */
export const VIRTUAL_DIR = `${HARNESS_DIR}/virtual`;
export const VIRTUAL_MAP_PATH = `${VIRTUAL_DIR}/map.json`;
export const TESTS_DIR = `${HARNESS_DIR}/tests`;
export const MOCK_RUNTIME_PATH = `${HARNESS_DIR}/mock.js`;
export const AMBIENT_PATH = `${HARNESS_DIR}/ambient.d.ts`;
export const RUN_PATH = `${HARNESS_DIR}/run.ts`;
export const TEST_RUNNER_PATH = `${HARNESS_DIR}/test.js`;
/** The public surface's declarations and their type check (`extract/surface.ts`). */
export const SURFACE_DIR = `${HARNESS_DIR}/surface`;
export const SURFACE_CHECK_PATH = `${SURFACE_DIR}/check.ts`;
export const SURFACE_CONFIG_PATH = `${SURFACE_DIR}/tsconfig.json`;
/**
 * The last test run, as TAP: node:test's, then a `not ok` line for each
 * failing Vitest test and surface check, then `# carveout` lines with each
 * runner's counts. What `check` reads the baseline and the counts from.
 */
export const LAST_RUN_PATH = `${HARNESS_DIR}/.last-run.tap`;
/**
 * Folders a contributor's tools write at a folder's root: npm's cache kept
 * in the folder (`npm ci --cache .npm-cache`), a coverage report, a build
 * tool's cache. None is part of a change: a patch leaves them out, and
 * nothing in them is built or run.
 */
export const TOOL_DIRS: readonly string[] = [".npm-cache", ".npm", ".pnpm-store", ".cache", "coverage", ".nyc_output", ".turbo"];
/** The last run's counts, by runner, written by the runner after every test ran. */
export const COUNTS_PATH = `${HARNESS_DIR}/.last-run.json`;
/** The last Vitest run's JSON report, which the runner reads into the TAP. */
export const VITEST_REPORT_PATH = `${HARNESS_DIR}/.vitest.json`;
/** The tests that failed when the folder was first checked: they fail on the mocks. */
export const BASELINE_PATH = `${HARNESS_DIR}/baseline.json`;
export const ENV_FILE = "carveout.env";
export const ASSETS_LOADER_PATH = `${HARNESS_DIR}/assets.js`;

/**
 * Files a script imports that are not code: copied with the slice, typed
 * as untyped modules, and loaded at runtime as their own path.
 */
export const ASSET_EXTENSIONS: readonly string[] = [
  "css",
  "scss",
  "sass",
  "less",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "mp4",
  "webm",
  "mp3",
  "wav",
  "txt",
  "md",
  "html",
];

export function isAssetPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && ASSET_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

const ASSETS_LOADER = [
  "// Loads a stylesheet, image or other asset a module imports as a module",
  "// whose default export is the asset's path, as a bundler would give its",
  "// URL, gives the project's modules Vite's import.meta.glob over the",
  "// files the cut copied, and resolves a relative import written as the",
  "// repository's bundler takes it (`./cart`, `./cart.ts`, `./ui` for",
  "// `./ui/index.ts`) to the compiled file: the cut rewrote the slice's own",
  "// imports so Node takes them, and one written after the cut runs too.",
  "// Registered with --import before anything runs.",
  "import { globSync, readFileSync } from \"node:fs\";",
  "import { register } from \"node:module\";",
  "import { dirname, relative, resolve as resolvePath, sep } from \"node:path\";",
  "import { fileURLToPath, pathToFileURL } from \"node:url\";",
  "",
  "const ASSETS = new Set(__ASSETS__);",
  "const isAsset = (path) => {",
  "  const clean = path.split(/[?#]/)[0] ?? \"\";",
  "  const dot = clean.lastIndexOf(\".\");",
  "  return dot !== -1 && ASSETS.has(clean.slice(dot + 1).toLowerCase());",
  "};",
  "",
  "/** import.meta.glob, as Vite answers it, over the project's own files. */",
  "export function carveoutGlob(base, patterns, options = {}) {",
  "  const directory = dirname(fileURLToPath(base));",
  "  const root = process.cwd();",
  "  const matches = new Map();",
  "  for (const raw of [patterns].flat()) {",
  "    const negated = raw.startsWith(\"!\");",
  "    const pattern = negated ? raw.slice(1) : raw;",
  "    const from = pattern.startsWith(\"/\") ? root : directory;",
  "    for (const match of globSync(pattern.replace(/^\\/+/, \"\"), { cwd: from })) {",
  "      const absolute = resolvePath(from, match);",
  "      if (absolute.split(sep).includes(\"node_modules\")) continue;",
  "      let key = pattern.startsWith(\"/\")",
  "        ? `/${relative(root, absolute).split(sep).join(\"/\")}`",
  "        : relative(directory, absolute).split(sep).join(\"/\");",
  "      if (!key.startsWith(\"/\") && !key.startsWith(\".\")) key = `./${key}`;",
  "      if (negated) matches.delete(key);",
  "      else matches.set(key, absolute);",
  "    }",
  "  }",
  "  const result = {};",
  "  const pick = (module) =>",
  "    options.import === undefined ? module : module[options.import];",
  "  for (const [key, absolute] of [...matches].sort(([a], [b]) => (a < b ? -1 : 1))) {",
  "    const runtime = absolute.replace(/\\.(m|c)?tsx?$/, (_, kind) => `.${kind ?? \"\"}js`);",
  "    const url = pathToFileURL(runtime).href;",
  "    if (isAsset(absolute)) {",
  "      const module = { default: absolute };",
  "      result[key] = options.eager ? pick(module) : async () => pick(module);",
  "    } else if (!options.eager) result[key] = async () => pick(await import(url));",
  "    // An eager glob of modules needs a bundler; it finds nothing here.",
  "  }",
  "  return result;",
  "}",
  "",
  "const RELATIVE = /^\\.\\.?\\//;",
  "// Modules that are no package (`virtual:build-info`), mocked under carveout/virtual.",
  "const VIRTUAL = (() => {",
  "  try {",
  "    return JSON.parse(readFileSync(new URL(\"./virtual/map.json\", import.meta.url), \"utf8\"));",
  "  } catch {",
  "    return {};",
  "  }",
  "})();",
  "/** The mock of a virtual module, or of one of its subpaths (`virtual:pwa-register/react`). */",
  "const virtualOf = (specifier) => {",
  "  if (Object.hasOwn(VIRTUAL, specifier)) return VIRTUAL[specifier];",
  "  const name = Object.keys(VIRTUAL).find((each) => specifier.startsWith(`${each}/`));",
  "  return name === undefined ? null : VIRTUAL[name];",
  "};",
  "export async function resolve(specifier, context, nextResolve) {",
  "  const virtual = virtualOf(specifier);",
  "  if (virtual !== null)",
  "    return { url: new URL(`../${virtual}/index.js`, import.meta.url).href, shortCircuit: true };",
  "  try {",
  "    return await nextResolve(specifier, context);",
  "  } catch (error) {",
  "    const parent = context.parentURL ?? \"\";",
  "    if (",
  "      !RELATIVE.test(specifier) ||",
  "      !parent.startsWith(\"file:\") ||",
  "      parent.includes(\"/node_modules/\") ||",
  "      ![\"ERR_MODULE_NOT_FOUND\", \"ERR_UNSUPPORTED_DIR_IMPORT\"].includes(error?.code)",
  "    )",
  "      throw error;",
  "    const base = specifier.replace(/\\.(m|c)?tsx?$/, \"\").replace(/\\/$/, \"\");",
  "    const kind = /\\.(m|c)tsx?$/.exec(specifier)?.[1] ?? \"\";",
  "    for (const candidate of [`${base}.${kind}js`, `${base}/index.js`]) {",
  "      try {",
  "        return await nextResolve(candidate, context);",
  "      } catch {",
  "        // The next form, if any.",
  "      }",
  "    }",
  "    throw error;",
  "  }",
  "}",
  "",
  "export async function load(url, context, nextLoad) {",
  "  if (url.startsWith(\"file:\") && isAsset(url))",
  "    return {",
  "      format: \"module\",",
  "      shortCircuit: true,",
  "      source: `export default ${JSON.stringify(fileURLToPath(url))};`,",
  "    };",
  "  const loaded = await nextLoad(url, context);",
  "  if (",
  "    loaded.format === \"module\" &&",
  "    loaded.source !== undefined &&",
  "    url.startsWith(\"file:\") &&",
  "    !url.includes(\"/node_modules/\")",
  "  ) {",
  "    const original = String(loaded.source);",
  "    let text = original;",
  "    // Vite's env reads take carveout.env's values, which Node loads.",
  "    if (text.includes(\"import.meta.env\"))",
  "      text = text.replace(/\\bimport\\.meta\\.env\\b/g, \"process.env\");",
  "    if (text.includes(\"import.meta.glob\"))",
  "      return {",
  "        ...loaded,",
  "        source: `import { carveoutGlob as __carveoutGlob } from ${JSON.stringify(import.meta.url.split(\"#\")[0])};\\n${text.replace(/import\\.meta\\.glob(?:<[^>()]*>)?\\(/g, \"__carveoutGlob(import.meta.url, \")}`,",
  "      };",
  "    if (text !== original) return { ...loaded, source: text };",
  "  }",
  "  return loaded;",
  "}",
  "",
  "if (!import.meta.url.includes(\"#hooks\"))",
  "  register(`${import.meta.url}#hooks`);",
  "",
].join("\n").replace("__ASSETS__", JSON.stringify(ASSET_EXTENSIONS));

/** Where a cut came from, as the README and package name say it. */
export interface ProjectOrigin {
  /** The repository folder's name; null for a public folder. */
  readonly repository: string | null;
  /** The project's package name. */
  readonly name: string;
}

export interface ProjectSource {
  /** The repository path. */
  readonly originalPath: string;
  /** The path in the project; the same as the repository's. */
  readonly path: string;
  readonly text: string;
}

export interface ProjectStub {
  /** The cut module's repository path. */
  readonly module: string;
  /** The module's path in the project, with its source extension. */
  readonly path: string;
  /** The declaration stub's text. */
  readonly text: string;
}

/**
 * A mock package's version: the floor of the importer's pin when it is a
 * plain or caret/tilde version, else a marker no real package carries.
 */
function mockVersion(pin: string | null): string {
  return pin?.match(/^[\^~=]?v?(\d+\.\d+\.\d+)$/)?.[1] ?? "0.0.0-carveout";
}

export interface ProjectInput {
  readonly origin: ProjectOrigin;
  readonly manifest: SliceManifest;
  readonly contract: BoundaryContract;
  readonly sources: readonly ProjectSource[];
  readonly stubs: readonly ProjectStub[];
  readonly dependencies: readonly ResolvedDependency[];
  /** Bare specifiers that need no rewrite: Node's modules and packages. */
  readonly knownSpecifiers: readonly string[];
  /** A safe subset of the source's compiler options, if they were read. */
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
  /** What the sources read of each package, declared as the slice's check declared it. */
  readonly packageModules?: PackageModules;
  readonly toolchain?: Toolchain;
  /** The coverage the repository's package test holds its sources to. */
  readonly coverage?: CoverageGate;
  /** Keep the source's noImplicitAny: the slice compiled under it. */
  readonly keepsImplicitAny?: boolean;
  /** Where the stubs leave an implicit any; see `SliceAnalysis.implicitAnyFiles`. */
  readonly implicitAnyFiles?: readonly string[];
  /** The package's Vitest settings, for the folder's `vitest.config.mjs`; see `vitest-config.ts`. */
  readonly vitest?: VitestSettings;
  /** The runner the package's own tests run on, when it is Vitest: the folder is set up for it with no test of it carried. */
  readonly testRunner?: "vitest";
  /** The folder installs Node's own types instead of the fallback globals. */
  readonly hasNodeTypes?: boolean;
  /** Service packages kept real rather than mocked, sorted. */
  readonly live?: readonly string[];
  /**
   * Of the environment the slice reads, the names the live packages'
   * importers read: left out of `carveout.env`, so the shell's values or
   * the code's own defaults apply.
   */
  readonly liveEnvironment?: readonly string[];
  /** The public surface's declarations and type check, `carveout/surface/`. */
  readonly surface?: readonly { path: string; text: string }[];
}

/**
 * Coverage thresholds a package's `node --test` script sets, in percent,
 * over the sources under `folder` (a package's root, "" for the root).
 */
export interface CoverageGate {
  readonly folder: string;
  readonly lines?: number;
  readonly branches?: number;
  readonly functions?: number;
  /**
   * The test sources the package's script runs, relative to `folder`
   * (`test/*.test.ts` for `--test dist-test/test/*.test.js`): a test
   * elsewhere never runs in the repository, and never covers anything.
   */
  readonly tests?: string;
  /**
   * The script also fails when a compiled source under `dir` (relative to
   * `folder`, back at the sources) was loaded by no test, except the files
   * named: `assert-all-covered <dir> <report> [exclude...]`.
   */
  readonly allCovered?: { readonly dir: string; readonly excluded: readonly string[] };
}

/**
 * The test sources a package's test script runs, relative to its folder,
 * when it names them (`--test dist-test/test/*.test.js`, back at the
 * sources: `test/*.test.ts`); undefined when it leaves them to the
 * runner's defaults, which find a test anywhere.
 */
export function testsGlobOf(script: string): string | undefined {
  // The script runs compiled tests: its glob, back at the sources.
  const glob = /\s--test\s+["']?([^\s"'-][^\s"']*)/.exec(script)?.[1];
  return glob === undefined ? undefined : glob.replace(/^dist[^/]*\//, "").replace(/\.js$/, ".ts");
}

/** The thresholds a package's test script passes to `node --test`, if any. */
export function coverageGateOf(folder: string, script: string): CoverageGate | null {
  if (!/--experimental-test-coverage/.test(script)) return null;
  const read = (name: string) => {
    const match = new RegExp(`--test-coverage-${name}=(\\d+(?:\\.\\d+)?)`).exec(script);
    return match === null ? undefined : Number(match[1]);
  };
  const gate = { lines: read("lines"), branches: read("branches"), functions: read("functions") };
  if (gate.lines === undefined && gate.branches === undefined && gate.functions === undefined) return null;
  const tests = testsGlobOf(script);
  const guard = /\bassert-all-covered\s+(\S+)\s+\S+((?:[ \t]+[^\s;&|]+)*)/.exec(script);
  const allCovered =
    guard === null
      ? undefined
      : {
          dir: (guard[1] ?? "").replace(/^dist[^/]*\//, ""),
          excluded: (guard[2] ?? "").trim().split(/\s+/).filter((name) => name !== ""),
        };
  return {
    folder,
    ...(tests === undefined ? {} : { tests }),
    ...(allCovered === undefined ? {} : { allCovered }),
    ...(gate.lines === undefined ? {} : { lines: gate.lines }),
    ...(gate.branches === undefined ? {} : { branches: gate.branches }),
    ...(gate.functions === undefined ? {} : { functions: gate.functions }),
  };
}

export interface GeneratedFile {
  readonly path: string;
  readonly text: string;
  readonly class: PathClass;
  readonly public: boolean;
}

export interface ImportRewrite {
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

export interface ProjectBlocker {
  readonly code:
    | "import_unrewritable"
    | "language_unsupported"
    | "mock_unsupported"
    | "path_conflict"
    | "secret_found"
    | "test_runner_mocked"
    | "vocabulary_leaked";
  readonly file: string | null;
  readonly detail: string;
}

export interface GeneratedProject {
  readonly files: readonly GeneratedFile[];
  readonly importRewrites: readonly ImportRewrite[];
  readonly tests: readonly string[];
  readonly blockers: readonly ProjectBlocker[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const VALUE_KINDS: readonly string[] = [
  "function",
  "class",
  "variable",
  "module",
];
const TYPE_KINDS: readonly string[] = ["interface", "type"];

/**
 * The runtime shape of a symbol. The extractor names most kinds; a
 * re-export it could only follow by name arrives as `unknown`, and its
 * declaration text says whether it is a type (`export type { X }`,
 * `interface`, `type`) or a value. A symbol with neither a kind nor a
 * declaration cannot be mocked.
 */
export function runtimeKindOf(
  symbol: BoundarySymbol,
): "value" | "type" | "enum" | "unknown" {
  if (symbol.kind === "enum") return "enum";
  if (VALUE_KINDS.includes(symbol.kind)) return "value";
  if (TYPE_KINDS.includes(symbol.kind)) return "type";
  const declaration = symbol.declaration?.trim() ?? "";
  if (declaration === "") return "unknown";
  if (/^(export|import)\s+type\s*\{/.test(declaration)) return "type";
  if (/^(export\s+)?(declare\s+)?(interface|type)\s/.test(declaration))
    return "type";
  if (/^(export\s+)?(declare\s+)?(const\s+)?enum\s/.test(declaration))
    return "enum";
  if (
    /^(export\s+)?(declare\s+)?(abstract\s+)?(function|class|const|let|var|namespace|module)\s/.test(
      declaration,
    )
  )
    return "value";
  if (/^export\s+(default\s+|\{)/.test(declaration)) return "value";
  // A name the module imports and exports again (`import { LIMITS } from
  // "./jira"; export { LIMITS };`): a value, unless it is imported as a type.
  if (/^import\s/.test(declaration)) {
    const escaped = symbol.name.replace(/[$]/g, "\\$");
    return new RegExp(`\\btype\\s+${escaped}\\b`).test(declaration) ? "type" : "value";
  }
  return "unknown";
}
/**
 * Whether `runtimeKindOf` read a symbol's kind off the import it is
 * exported again from, which says nothing of what it is: a mock may export
 * it (harmless for a type), a test must not assert it.
 */
export function guessedFromImport(symbol: BoundarySymbol): boolean {
  if (symbol.kind === "enum" || VALUE_KINDS.includes(symbol.kind) || TYPE_KINDS.includes(symbol.kind)) return false;
  return /^import\s/.test(symbol.declaration?.trim() ?? "");
}

// Module specifiers are read from the syntax tree (`../specifiers.ts`);
// this pattern finds only the named bindings of an import, for the mock
// packages' exports.
const NAMED_IMPORT =
  /\bimport\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"\n]+)['"]/g;

export function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** `../lib/service.js` from `src/app.ts` to `lib/service.ts`. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  const from = dirnameOf(fromFile).split("/").filter(Boolean);
  const to = toFile.split("/").filter(Boolean);
  let common = 0;
  while (
    common < from.length &&
    common < to.length - 1 &&
    from[common] === to[common]
  )
    common += 1;
  const up = from.length - common;
  const rest = to.slice(common).join("/");
  const prefix = up === 0 ? "./" : "../".repeat(up);
  return `${prefix}${runtimePath(rest)}`;
}

/** The emitted JavaScript path of a TypeScript source path. */
export function runtimePath(path: string): string {
  if (path.endsWith(".d.ts")) return `${path.slice(0, -5)}.js`;
  if (path.endsWith(".mts")) return `${path.slice(0, -4)}.mjs`;
  if (path.endsWith(".cts")) return `${path.slice(0, -4)}.cjs`;
  if (path.endsWith(".tsx") || path.endsWith(".ts"))
    return `${path.replace(/\.tsx?$/, "")}.js`;
  return path;
}

/** What `npm run dev` and `npm test` run once the project is built. */
export const SANDBOX_RUN_ARGV = {
  dev: [
    "node",
    `--env-file=${ENV_FILE}`,
    `--import=./${ASSETS_LOADER_PATH}`,
    runtimePath(RUN_PATH),
  ],
  test: [
    "node",
    `--env-file=${ENV_FILE}`,
    `--import=./${ASSETS_LOADER_PATH}`,
    "--test",
    `${TESTS_DIR}/**/*.test.js`,
  ],
} as const;

/** One command line, a glob quoted so node expands it rather than a shell. */
const commandLine = (argv: readonly string[]) =>
  argv.map((arg) => (arg.includes("*") ? `"${arg}"` : arg)).join(" ");

/** A carved-out project's `package.json` scripts. */
export const SANDBOX_SCRIPTS = {
  build: "tsc -p tsconfig.json",
  dev: `npm run build && ${commandLine(SANDBOX_RUN_ARGV.dev)}`,
  test: `npm run build && ${commandLine(SANDBOX_RUN_ARGV.test)}`,
} as const;

/** `x.ts`, `x.tsx` and `x.js` → `x.d.ts`; `x.mts` → `x.d.mts`; `x.cts` → `x.d.cts`. */
export function declarationPath(path: string): string {
  if (/\.d\.[cm]?ts$/.test(path)) return path;
  const match = /\.([cm]?)[jt]sx?$/.exec(path);
  return match === null
    ? `${path}.d.ts`
    : `${path.slice(0, -match[0].length)}.d.${match[1] ?? ""}ts`;
}

/** A TypeScript source the project compiles, as opposed to a declaration or an asset. */
export function isScript(path: string): boolean {
  return /\.(m|c)?tsx?$/.test(path) && !path.endsWith(".d.ts");
}

/** Members of a `declare enum` declaration, as `[name, value]` pairs. */
export function enumMembers(
  declaration: string,
): { name: string; value: string | number }[] | null {
  const match = /\benum\s+[\w$]+\s*\{([^}]*)\}/.exec(declaration);
  if (match === null) return null;
  const members: { name: string; value: string | number }[] = [];
  let next = 0;
  for (const raw of (match[1] ?? "").split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const parts = /^([\w$]+|"[^"]*"|'[^']*')\s*(?:=([\s\S]+))?$/.exec(entry);
    if (parts === null) return null;
    const name = (parts[1] ?? "").replace(/^['"]|['"]$/g, "");
    const initializer = parts[2]?.trim();
    if (initializer === undefined) {
      members.push({ name, value: next });
      next += 1;
    } else if (/^-?\d+(\.\d+)?$/.test(initializer)) {
      const value = Number(initializer);
      members.push({ name, value });
      next = value + 1;
    } else if (/^(['"]).*\1$/.test(initializer))
      members.push({ name, value: initializer.slice(1, -1) });
    else return null;
  }
  return members;
}

const RESERVED_WORDS = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(
    " ",
  ),
);
/**
 * `export const name = value;`, or for a name that is not an identifier
 * (`"weird-name"`, a reserved word) a local binding exported under the
 * string name, which ES2022 modules allow.
 */
function exportValue(name: string, value: string, index: number): string {
  if (/^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED_WORDS.has(name))
    return `export const ${name} = ${value};`;
  const local = `__export${index}`;
  return `const ${local} = ${value};\nexport { ${local} as ${JSON.stringify(name)} };`;
}

/** A stub's `export * from "./x.js"`: the modules a barrel forwards to. */
const STAR_EXPORT = /^export \* from (["'])(\.{1,2}\/[^"'\n]+)\1;?$/gm;

function mockRuntimeFor(
  modulePath: string,
  originalModule: string,
  symbols: readonly BoundarySymbol[],
  blockers: ProjectBlocker[],
  stubText = "",
): string {
  const lines = [
    `// Generated runtime for the declarations in ${declarationPath(modulePath).split("/").pop() ?? ""}.`,
    `// Every value is a recording mock; see ${MOCK_RUNTIME_PATH} and the README.`,
    `import { createMock } from "${relativeSpecifier(modulePath, MOCK_RUNTIME_PATH)}";`,
    `const mock = createMock(${JSON.stringify(`module:${modulePath}`)});`,
  ];
  let exported = 0;
  for (const symbol of [...symbols].sort((a, b) => compare(a.name, b.name))) {
    const shape = runtimeKindOf(symbol);
    if (shape === "type") continue;
    if (shape === "enum") {
      const members = enumMembers(symbol.declaration ?? "");
      if (members === null) {
        blockers.push({
          code: "mock_unsupported",
          file: originalModule,
          detail: `The enum ${symbol.name} has members the generator cannot evaluate.`,
        });
        continue;
      }
      const entries = members.flatMap((member) => [
        `${JSON.stringify(member.name)}: ${JSON.stringify(member.value)}`,
        ...(typeof member.value === "number"
          ? [
              `${JSON.stringify(String(member.value))}: ${JSON.stringify(member.name)}`,
            ]
          : []),
      ]);
      lines.push(
        exportValue(
          symbol.name,
          `Object.freeze({ ${entries.join(", ")} })`,
          exported,
        ),
      );
      exported += 1;
      continue;
    }
    if (shape === "unknown") {
      blockers.push({
        code: "mock_unsupported",
        file: originalModule,
        detail: `${symbol.name} has kind ${symbol.kind} and no declaration that says its runtime shape.`,
      });
      continue;
    }
    lines.push(
      symbol.name === "default"
        ? "export default mock.default;"
        : exportValue(
            symbol.name,
            `mock[${JSON.stringify(symbol.name)}]`,
            exported,
          ),
    );
    exported += 1;
  }
  // A barrel's names come from the modules it forwards to, whose runtimes
  // sit beside their stubs as this one does.
  for (const [, , specifier] of stubText.matchAll(STAR_EXPORT)) {
    lines.push(`export * from ${JSON.stringify(specifier)};`);
    exported += 1;
  }
  if (exported === 0) lines.push("export {};");
  return `${lines.join("\n")}\n`;
}

const MOCK_RUNTIME = `// The recording mock every generated module and package shares.
//
// A mock answers any property with another mock, any call with a mock and
// records the call. It is not thenable, so awaiting one gives the mock
// back, and it prints as [mock <name>]. Tests can install an implementation
// for a path with mockImplementation() and read what was called with
// recordedCalls(). Nothing here reaches a network or a credential.
const calls = [];
const implementations = new Map();
const fixtures = new Map();
export function recordedCalls() {
  return calls.slice();
}
/** Clears recorded calls and installed implementations; fixtures stay. */
export function resetMocks() {
  calls.length = 0;
  implementations.clear();
}
/** @param {string} path such as "module:lib/service.ts.createService" */
export function mockImplementation(path, implementation) {
  implementations.set(path, implementation);
}
/** The task's default behaviour for a path; mockImplementation() overrides it. */
export function fixture(path, implementation) {
  fixtures.set(path, implementation);
}
export function createMock(origin, name = origin) {
  const target = function mock() {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.toPrimitive) return () => \`[mock \${name}]\`;
      if (property === Symbol.iterator) return function* iterate() {};
      if (property === "toJSON") return () => ({ mock: name });
      if (typeof property === "symbol") return undefined;
      return createMock(origin, \`\${name}.\${property}\`);
    },
    apply(_target, _self, args) {
      calls.push({ name, args });
      const implementation = implementations.get(name) ?? fixtures.get(name);
      return implementation === undefined
        ? createMock(origin, \`\${name}()\`)
        : implementation(...args);
    },
    construct(_target, args) {
      calls.push({ name: \`new \${name}\`, args });
      const implementation =
        implementations.get(\`new \${name}\`) ?? fixtures.get(\`new \${name}\`);
      return implementation === undefined
        ? createMock(origin, \`\${name}#\`)
        : implementation(...args);
    },
    has() {
      return true;
    },
  });
}
`;

export const MOCK_RUNTIME_TYPES = `export interface RecordedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}
export function recordedCalls(): RecordedCall[];
export function resetMocks(): void;
export function mockImplementation(
  path: string,
  implementation: (...args: unknown[]) => unknown,
): void;
export function fixture(
  path: string,
  implementation: (...args: any[]) => unknown,
): void;
export function createMock(origin: string, name?: string): any;
`;

/**
 * Module declarations for the specifiers a slice reads names of, each
 * exporting those names as values and types, as the worker writes them for
 * the slice's own check. They take the place of the specifier's untyped
 * shorthand, which only works as a value: `import type { X }` from it fails.
 * An installed package's are patterns (`"zod*"`), so its own types win.
 */
export interface PackageModules {
  readonly specifiers: readonly string[];
  readonly text: string;
}

/** Classes Node has and the ES libraries do not, read as both a value and a type. */
const NODE_CLASSES = [
  "AbortController",
  "AbortSignal",
  "Blob",
  "Buffer",
  "BroadcastChannel",
  "DOMException",
  "Event",
  "EventTarget",
  "File",
  "FormData",
  "Headers",
  "MessageChannel",
  "MessagePort",
  "ReadableStream",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "WebSocket",
  "WritableStream",
] as const;

/** Types code reads off Node's own `NodeJS` namespace. */
const NODE_NAMESPACE_TYPES = [
  "Dict",
  "ErrnoException",
  "Immediate",
  "Process",
  "ProcessEnv",
  "ReadOnlyDict",
  "ReadableStream",
  "ReadWriteStream",
  "Signals",
  "Timeout",
  "Timer",
  "WritableStream",
] as const;

/**
 * Node's own modules and globals, untyped: what `@types/node` gives code
 * the ES libraries alone do not. The slice is type-checked against these
 * and a generated project builds against them. Where the DOM library
 * declares a global too, the library's declaration comes first and keeps
 * its type; the clash is in a declaration file, which `skipLibCheck`
 * leaves unchecked.
 */
export const NODE_GLOBAL_DECLARATIONS: readonly string[] = [
  'declare module "node:*";',
  "declare var process: any;",
  "declare var global: any;",
  "declare var require: any;",
  "declare var module: any;",
  "declare var exports: any;",
  "declare var __dirname: string;",
  "declare var __filename: string;",
  "declare var console: any;",
  "declare var performance: any;",
  "declare var crypto: any;",
  "declare function setTimeout(handler: (...args: any[]) => void, ms?: number, ...args: any[]): any;",
  "declare function clearTimeout(handle: any): void;",
  "declare function setInterval(handler: (...args: any[]) => void, ms?: number, ...args: any[]): any;",
  "declare function clearInterval(handle: any): void;",
  "declare function setImmediate(handler: (...args: any[]) => void, ...args: any[]): any;",
  "declare function clearImmediate(handle: any): void;",
  "declare function queueMicrotask(callback: () => void): void;",
  "declare function structuredClone<T>(value: T): T;",
  "declare function fetch(input: any, init?: any): Promise<any>;",
  "declare function atob(data: string): string;",
  "declare function btoa(data: string): string;",
  ...NODE_CLASSES.flatMap((name) => [
    `type ${name}<T0 = any, T1 = any> = any;`,
    `declare var ${name}: any;`,
  ]),
  ...ASSET_EXTENSIONS.map((extension) => `declare module "*.${extension}";`),
  "interface ImportMetaEnv { readonly [key: string]: any }",
  "interface ImportMeta { readonly env: ImportMetaEnv; glob<T = any>(pattern: string | readonly string[], options?: any): Record<string, any> }",
  "declare namespace NodeJS {",
  ...NODE_NAMESPACE_TYPES.map((name) => `  type ${name} = any;`),
  "}",
];

export function ambientDeclarations(
  packages: readonly string[],
  modules: PackageModules = { specifiers: [], text: "" },
  installed: ReadonlySet<string> = new Set(),
  hasNodeTypes = false,
): string {
  const declared = new Set(modules.specifiers);
  const lines = [
    "// The same declarations the slice was type-checked against: Node's",
    "// modules and globals untyped, and every package untyped. A package the",
    "// project installs is declared by a pattern, which the compiler",
    "// consults only when the package brings no types of its own.",
    ...(hasNodeTypes
      ? [
          ...ASSET_EXTENSIONS.map((extension) => `declare module "*.${extension}";`),
          "interface ImportMetaEnv { readonly [key: string]: any }",
          "interface ImportMeta { readonly env: ImportMetaEnv; glob<T = any>(pattern: string | readonly string[], options?: any): Record<string, any> }",
        ]
      : [...NODE_GLOBAL_DECLARATIONS, "declare var globalThis: any;"]),
  ];
  for (const name of [...new Set(packages)].sort(compare))
    if (installed.has(name)) {
      if (!declared.has(name)) lines.push(`declare module "${name}*";`);
    } else {
      if (!declared.has(name)) lines.push(`declare module "${name}";`);
      lines.push(`declare module "${name}/*";`);
    }
  return `${lines.join("\n")}\n${modules.text}`;
}

/**
 * What the slice's check relaxes for its untyped packages, which the
 * project must relax too to build what the check passed: a callback passed
 * to an untyped function has no parameter types to take.
 */
const UNTYPED_PACKAGE_OPTIONS = { noImplicitAny: false } as const;

const SAFE_COMPILER_KEYS: readonly string[] = [
  "strict",
  "target",
  "lib",
  "jsx",
  "esModuleInterop",
  "allowSyntheticDefaultImports",
  "exactOptionalPropertyTypes",
  "noUncheckedIndexedAccess",
  "noImplicitAny",
  "strictNullChecks",
  "useDefineForClassFields",
  "verbatimModuleSyntax",
  "isolatedModules",
  "resolveJsonModule",
  "experimentalDecorators",
  "emitDecoratorMetadata",
  "noImplicitOverride",
  "noPropertyAccessFromIndexSignature",
  "useUnknownInCatchVariables",
  // Checks that only reject code: the slice holds the code to them as the
  // repository does, so what passes here passes there.
  "noUnusedLocals",
  "noUnusedParameters",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "allowUnreachableCode",
  "allowUnusedLabels",
  "forceConsistentCasingInFileNames",
];

/**
 * The compiler options a generated project builds with: the source's safe
 * options carried over, the source's bundler resolution when it uses one,
 * otherwise Node's ESM resolution, and no emitted declarations.
 */
export function projectCompilerOptions(
  options: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const key of SAFE_COMPILER_KEYS)
    if (options !== undefined && options[key] !== undefined)
      carried[key] = options[key];
  const bundler = String(options?.["moduleResolution"] ?? "").toLowerCase() === "bundler";
  return {
    strict: true,
    target: "ES2022",
    ...carried,
    module: bundler ? "ESNext" : "NodeNext",
    moduleResolution: bundler ? "Bundler" : "NodeNext",
    rootDir: ".",
    declaration: false,
    sourceMap: false,
    // A build that waives the stubs' implicit anys (`buildScript`) still
    // emits: those are errors tsc reports, and the folder's tests need the
    // JavaScript.
    noEmitOnError: options?.["noEmitOnError"] !== false,
    skipLibCheck: true,
    types: [],
    allowJs: false,
  };
}

/** `tsconfig.json` for a generated project. */
export function tsconfigFor(
  options: Readonly<Record<string, unknown>> | undefined,
  types: readonly string[] = [],
  excluded: readonly string[] = [],
  /** Module names TypeScript finds by path: the folder's virtual modules. */
  paths: Readonly<Record<string, readonly string[]>> = {},
) {
  return `${JSON.stringify(
    {
      compilerOptions: {
        ...projectCompilerOptions(options),
        types: [...types],
        ...(Object.keys(paths).length === 0 ? {} : { paths }),
      },
      include: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      // The surface check has its own config, which `npm test` compiles.
      exclude: ["node_modules", MOCKS_DIR, SURFACE_DIR, ...TOOL_DIRS, ...excluded],
    },
    null,
    2,
  )}\n`;
}

/** The folder's build when the stubs leave implicit anys: tsc, with those not counted. */
export const BUILD_SCRIPT_PATH = `${HARNESS_DIR}/build.js`;

/**
 * `carveout/build.js`: runs the folder's tsc, holding the code to the
 * repository's noImplicitAny but for the files where the cut found the
 * stubs leave an implicit any (a callback passed to a mocked package has
 * no parameter types to take): those errors are the stubs', and are not
 * counted. Any other error, an implicit any elsewhere included, fails it.
 */
/**
 * The implicit-any diagnostics, by code: TypeScript's 7xxx family but its
 * other checks there (TS7027 unreachable code, TS7028 an unused label,
 * TS7029 a switch case that falls through, TS7030 a path that returns
 * nothing), which hold the code to the repository's rules and are never
 * the stubs' doing. The source of a regular expression over the digits.
 */
export const IMPLICIT_ANY_CODE = "7(?!02[7-9]|030)\\d{3}";

export function buildScript(waived: readonly string[]): string {
  // Raw, so the backslashes of its regular expressions reach the file as
  // written; no `${` in it, which a raw template would read.
  return String.raw`// The folder's build: tsc, with the implicit anys the cut's stubs leave not counted.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const WAIVED = new Set(__WAIVED__);
const IMPLICIT = new RegExp("^(.+?)\\(\\d+,\\d+\\): error TS(" + __CODE__ + "):");
// The installed compiler's own command: typescript 7 exports no bin/tsc to resolve.
const tsc = join("node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const result = spawnSync(tsc, ["-p", "tsconfig.json", "--pretty", "false"], { encoding: "utf8", shell: process.platform === "win32" });
// A compiler that did not run, or did not finish, passed nothing.
if (result.error || result.signal) {
  process.stdout.write("tsc did not run to the end (" + (result.error ? result.error.message : result.signal) + "): run npm ci first.\n");
  process.exit(1);
}
const lines = ((result.stdout || "") + (result.stderr || "")).split("\n");
const kept = [];
let waivedCount = 0;
let skipping = false;
for (const line of lines) {
  if (line.trim() === "") continue;
  // An indented line belongs to the diagnostic above it.
  if (/^\s/.test(line)) {
    if (!skipping) kept.push(line);
    continue;
  }
  const match = IMPLICIT.exec(line);
  skipping = match !== null && WAIVED.has(match[1].split("\\").join("/"));
  if (skipping) waivedCount += 1;
  else kept.push(line);
}
if (kept.length > 0) process.stdout.write(kept.join("\n") + "\n");
if (waivedCount > 0)
  process.stdout.write(waivedCount + " implicit any(s) the stubs leave (a callback into a mocked package) not counted: the repository's types give them.\n");
// Any error but those, a file's or the project's (TS18003, TS5083), fails
// the build; so does tsc failing with nothing it printed waived or kept.
process.exitCode = kept.some((line) => /(^|\s)error TS\d+:/.test(line)) || (result.status !== 0 && waivedCount === 0) ? 1 : 0;
`
    .replace("__WAIVED__", JSON.stringify(waived))
    .replace("__CODE__", JSON.stringify(IMPLICIT_ANY_CODE));
}

export function scanNamedImports(
  sources: readonly ProjectSource[],
): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  for (const source of sources) {
    for (const match of source.text.matchAll(NAMED_IMPORT)) {
      // Type-only imports need no runtime export.
      if (match[1] !== undefined) continue;
      const specifier = match[3] ?? "";
      const list = names.get(packageNameOf(specifier)) ?? new Set();
      for (const part of (match[2] ?? "").split(",")) {
        const trimmed = part.trim();
        if (trimmed === "" || /^type\s/.test(trimmed)) continue;
        const name = /^\S+/.exec(trimmed)?.[0];
        if (name !== undefined && name !== "" && name !== "default")
          list.add(name);
      }
      names.set(packageNameOf(specifier), list);
    }
    const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
        const initializer = node.initializer;
        const call = initializer && ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
        if (call && ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword && call.arguments[0] && ts.isStringLiteral(call.arguments[0])) {
          const name = packageNameOf(call.arguments[0].text);
          const list = names.get(name) ?? new Set<string>();
          for (const element of node.name.elements) {
            const imported = element.propertyName ?? element.name;
            if (ts.isIdentifier(imported) && imported.text !== "default") list.add(imported.text);
          }
          names.set(name, list);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return names;
}

function escapeJs(text: string): string {
  return JSON.stringify(text);
}

function interfaceTests(
  inbound: readonly BoundaryModule[],
  aliasedOf: (original: string) => string | null,
  entries: readonly string[],
): string {
  const lines = [
    "// The public surface: what code outside the slice imports from it in",
    "// the repository. Keep every one of these exports in place, or the",
    "// change will not fit back; their types are in BOUNDARY.md.",
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    "",
  ];
  const testFile = `${TESTS_DIR}/interface.test.ts`;
  let count = 0;
  for (const module of inbound) {
    const path = aliasedOf(module.module);
    if (path === null) continue;
    // Only what is known to exist at runtime; a name whose kind the
    // extractor could not tell is not asserted, nor one it guessed from the
    // import the module exports it again from (an interface imported
    // without `type` and exported again is gone from the emitted code).
    const values = module.symbols
      .filter((symbol) => {
        const kind = runtimeKindOf(symbol);
        return (kind === "value" || kind === "enum") && !guessedFromImport(symbol);
      })
      .map((symbol) => symbol.name);
    if (values.length === 0) continue;
    count += 1;
    lines.push(
      `test(${escapeJs(`${path} keeps its public surface`)}, async () => {`,
      `  const module = (await import(${escapeJs(relativeSpecifier(testFile, path))})) as Record<string, unknown>;`,
    );
    for (const name of values)
      lines.push(
        `  assert.notEqual(module[${escapeJs(name)}], undefined, ${escapeJs(`${name} must stay exported`)});`,
      );
    lines.push("});", "");
  }
  if (count === 0)
    for (const entry of entries) {
      lines.push(
        `test(${escapeJs(`${entry} loads`)}, async () => {`,
        `  assert.ok(await import(${escapeJs(relativeSpecifier(testFile, entry))}));`,
        "});",
        "",
      );
    }
  return `${lines.join("\n")}\n`;
}

/**
 * `npm test`: every test in the folder at the time it runs, so a test added
 * after the cut runs too. Each goes to the runner it imports; Node runs the
 * compiled `.js`, Vitest the source.
 */
export function testRunnerScript(coverage: CoverageGate | undefined, globals = false, waived: readonly string[] = []): string {
  // The gate covers the package's compiled sources the folder holds: a
  // \`.js\` beside its \`.ts\`, never a stub's mock or a test.
  const gate =
    coverage === undefined
      ? ["const gate = [];"]
      : [
          `const folder = ${JSON.stringify(coverage.folder)};`,
          "// Only sources the cut did not copy: the slice's tests cannot reach",
          "// the repository's coverage of the rest, so the gate holds new code.",
          "// Holding a copied file the change edited to the threshold on its own",
          "// over-rejects (Phase 7: 47 changes the repository accepted), since",
          "// the repository measures the whole package.",
          "const copied = new Set(JSON.parse(readFileSync(\"carveout.json\", \"utf8\")).manifest.included.map((file) => file.path));",
          "const source = (path) => /\\.js$/.test(path) && !TEST.test(path) &&",
          '  [".ts", ".tsx"].some((ext) => existsSync(path.replace(/\\.js$/, ext)) && !copied.has(path.replace(/\\.js$/, ext)));',
          "const covered = node.length === 0 ? [] : listed(folder).filter(source).sort();",
          "const gate = covered.length === 0 ? [] : [",
          '  "--experimental-test-coverage",',
          ...(["lines", "branches", "functions"] as const).flatMap((name) =>
            coverage[name] === undefined ? [] : [`  "--test-coverage-${name}=${coverage[name]}",`],
          ),
          "  ...covered.map((path) => `--test-coverage-include=${path}`),",
          "  // Loaded in every test process, so a file no test imports counts",
          "  // as uncovered rather than unseen.",
          "  ...covered.map((path) => `--import=./${path}`),",
          "];",
          ...(coverage.tests === undefined
            ? ["const unrun = [];"]
            : [
                `const pattern = new RegExp("^" + ${JSON.stringify(coverage.tests)}.split("**/").map((part) => part.split("*").map((text) => text.replace(/[.+?^\${}()|[\\]\\\\]/g, "\\\\$&")).join("[^/]*")).join("(?:.*/)?") + "$");`,
                "// Added tests the repository's script would not run: they cover",
                "// nothing there.",
                "const unrun = node",
                '  .map((path) => path.replace(/\\.js$/, ".ts"))',
                "  .filter((path) => path.startsWith(`${folder}/`) && !copied.has(path))",
                "  .filter((path) => !pattern.test(path.slice(folder.length + 1)));",
              ]),
          `const guard = ${JSON.stringify(coverage.allCovered ?? null)};`,
        ];
  return `${[
    "// \`npm test\`, after \`npm run build\`: finds the folder's tests now, the",
    "// interface test and any the slice holds or gained, and runs each on the",
    "// runner it imports. Generated by carveout.",
    'import { spawnSync } from "node:child_process";',
    'import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";',
    'import { dirname, join, relative as relativeTo } from "node:path";',
    "",
    `const TEST = ${TEST_PATH_PATTERN.toString()};`,
    // A tool's folder at the root (npm's cache, a coverage report) holds no
    // test of the folder's: the patch leaves it out, so nothing in it runs.
    `const SKIP = new Set(["node_modules", ".git", "${MOCKS_DIR}", ${TOOL_DIRS.map((dir) => JSON.stringify(dir)).join(", ")}]);`,
    "const node = [];",
    "const vitest = [];",
    "const walk = (dir) => {",
    "  for (const entry of readdirSync(dir || \".\", { withFileTypes: true })) {",
    "    const path = dir === \"\" ? entry.name : `${dir}/${entry.name}`;",
    "    if (SKIP.has(path) || entry.name === \"node_modules\") continue;",
    "    if (entry.isDirectory()) walk(path);",
    "    else if (TEST.test(path) && /\\.[cm]?tsx?$/.test(path) && !/\\.d\\.[cm]?ts$/.test(path)) {",
    "      const text = readFileSync(path, \"utf8\");",
    "      if (/['\"]node:test['\"]/.test(text)) node.push(path.replace(/\\.tsx?$/, \".js\").replace(/\\.mts$/, \".mjs\").replace(/\\.cts$/, \".cjs\"));",
    "      else if (/['\"]vitest(\\/[^'\"]*)?['\"]/.test(text)) vitest.push(path);",
    ...(globals
      ? [
          // The package runs Vitest with its globals: a test importing no
          // runner that calls them is Vitest's.
          `      else if (${GLOBAL_CALL_SOURCE}.test(text)) vitest.push(path);`,
        ]
      : []),
    "    }",
    "  }",
    "};",
    'walk("");',
    "/** The files under a folder of the slice, outside node_modules and carveout/. */",
    "const listed = (dir) =>",
    '  readdirSync(dir || ".", { recursive: true, withFileTypes: true })',
    "    .filter((entry) => entry.isFile())",
    '    .map((entry) => join(entry.parentPath, entry.name).replace(/^\\.\\//, ""))',
    '    .filter((path) => !path.split("/").includes("node_modules") && !path.startsWith("carveout/"));',
    "node.sort();",
    ...gate,
    "vitest.sort();",
    "let failed = false;",
    `rmSync(${JSON.stringify(LAST_RUN_PATH)}, { force: true });`,
    `rmSync(${JSON.stringify(COUNTS_PATH)}, { force: true });`,
    `const baseline = existsSync(${JSON.stringify(BASELINE_PATH)}) ? new Set(JSON.parse(readFileSync(${JSON.stringify(BASELINE_PATH)}, "utf8")).failing) : null;`,
    "// Each runner's counts of the folder's tests, and of carveout's own",
    "// checks of the public surface (exports kept, types kept) apart from",
    "// them: written to the TAP for `carveout check`, and summed at the end.",
    "const counted = [];",
    "const surface = { checks: 0, fail: 0 };",
    "// Failures the baseline names, which do not fail the run.",
    "let notCounted = 0;",
    "/** A test's name as a TAP line carries it: one line, `#` escaped. */",
    'const tapName = (name) => String(name).replace(/\\s*[\\r\\n\\u2028\\u2029]+\\s*/g, " ").replace(/\\\\/g, "\\\\\\\\").replace(/#/g, "\\\\#");',
    "if (node.length > 0) {",
    "  // With a baseline (the tests that failed on the mocks before any edit),",
    "  // the run is read from its TAP alone and reported in short: the counts,",
    "  // then each failure that is not the baseline's, in full. Printing every",
    "  // failure printed mostly the baseline's (E6c: 7% of what a session read).",
    "  // Without one, the usual report, with a TAP copy for the baseline.",
    "  const result = spawnSync(process.execPath, [",
    `    "--env-file=${ENV_FILE}", "--import=./${ASSETS_LOADER_PATH}", "--test",`,
    '    ...(baseline === null ? ["--test-reporter=spec", "--test-reporter-destination=stdout"] : []),',
    `    "--test-reporter=tap", "--test-reporter-destination=${LAST_RUN_PATH}",`,
    "    ...gate, ...node,",
    '  ], { stdio: "inherit" });',
    `  const tap = existsSync(${JSON.stringify(LAST_RUN_PATH)}) ? readFileSync(${JSON.stringify(LAST_RUN_PATH)}, "utf8") : "";`,
    "  const failing = [...new Set([...tap.matchAll(/^\\s*not ok \\d+ - (.+?)(?: # .*)?$/gm)].map((m) => m[1]))];",
    "  const gateFailed = /coverage does not meet threshold/.test(tap);",
    "  const fresh = failing.filter((name) => baseline === null || !baseline.has(name));",
    "  // node's own summary is the TAP's last such line: a test's output, which",
    "  // the TAP carries as `#` lines, comes before it.",
    '  const count = (key) => Number([...tap.matchAll(new RegExp("^# " + key + " (\\\\d+)$", "gm"))].at(-1)?.[1] ?? 0);',
    "  // The interface test's checks are carveout's, not the folder's tests:",
    "  // a top-level test named for a file of the folder that keeps its",
    "  // public surface, or loads.",
    "  const own = (ok) => [...tap.matchAll(new RegExp(`^${ok ? \"ok\" : \"not ok\"} \\\\d+ - (.+) (?:keeps its public surface|loads)(?: # .*)?$`, \"gm\"))].filter((m) => existsSync(m[1])).length;",
    "  const ownPass = own(true);",
    "  const ownFail = own(false);",
    "  surface.checks += ownPass + ownFail;",
    "  surface.fail += ownFail;",
    '  counted.push({ runner: "node:test", tests: count("tests") - ownPass - ownFail, pass: count("pass") - ownPass, fail: count("fail") - ownFail });',
    "  if (baseline !== null) notCounted += failing.length - fresh.length;",
    "  if (baseline !== null) {",
    "    const lines = tap.split(\"\\n\");",
    "    /** A failure's TAP lines: its `not ok` and the diagnostic under it. */",
    "    const block = (name) => {",
    "      const at = lines.findIndex((line) => /^\\s*not ok \\d+ - /.test(line) && line.replace(/^\\s*not ok \\d+ - /, \"\").replace(/ # .*$/, \"\") === name);",
    "      if (at === -1) return `not ok - ${name}`;",
    "      const indent = /^\\s*/.exec(lines[at])[0].length;",
    "      const out = [lines[at].trim()];",
    "      for (let i = at + 1; i < lines.length && out.length < 40; i++) {",
    "        const own = /^\\s*/.exec(lines[i])[0].length;",
    "        if (own <= indent && /^\\s*((not )?ok \\d+|# |\\d+\\.\\.\\d+)/.test(lines[i])) break;",
    "        out.push(lines[i].slice(indent));",
    "      }",
    "      return out.join(\"\\n\");",
    "    };",
    "    if (fresh.length > 0)",
    "      process.stdout.write(`\\nFailing now and not when the folder was checked:\\n\\n${fresh.map(block).join(\"\\n\\n\")}\\n`);",
    "    if (failing.length > fresh.length)",
    `      process.stdout.write(\`\\n\${failing.length - fresh.length} test(s) fail on the mocks as they did when the folder was checked, not on your change; not counted (${BASELINE_PATH} names them).\\n\`);`,
    "  }",
    "  if (result.status !== 0 && !(baseline !== null && failing.length > 0 && fresh.length === 0 && !gateFailed)) {",
    "    failed = true;",
    "    if (gateFailed)",
    "      process.stdout.write(",
    `        "\\nnpm test fails on coverage: the files you added are below the repository's coverage threshold (the report is above, or in ${LAST_RUN_PATH}). The repository measures its whole package, so its result may differ.\\n",`,
    "      );",
    "  }",
    "}",
    "if (typeof guard !== \"undefined\" && guard !== null && node.length > 0 && !failed) {",
    "  // The repository's test also fails when a compiled source was loaded by",
    "  // no test (assert-all-covered). Here, for the sources the cut did not",
    "  // copy: what the folder's tests import, followed statically.",
    "  const relative = /\\b(?:import|export)\\b[^'\"\\n]*?\\sfrom\\s+['\"](\\.[^'\"]+)['\"]|\\bimport\\s+['\"](\\.[^'\"]+)['\"]|\\b(?:require|import)\\(\\s*['\"](\\.[^'\"]+)['\"]\\s*\\)/g;",
    "  const loaded = new Set();",
    "  const queue = [...node];",
    "  while (queue.length > 0) {",
    "    const file = queue.pop();",
    "    if (loaded.has(file) || !existsSync(file)) continue;",
    "    loaded.add(file);",
    "    for (const match of readFileSync(file, \"utf8\").matchAll(relative)) {",
    "      const target = join(dirname(file), match[1] ?? match[2] ?? match[3] ?? \"\");",
    "      queue.push(target, `${target}.js`, join(target, \"index.js\"));",
    "    }",
    "  }",
    "  const under = join(folder, guard.dir);",
    "  const unloaded = listed(under)",
    "    .filter(source)",
    "    .filter((path) => !loaded.has(path) && !guard.excluded.includes(path.slice(under.length + 1)))",
    "    .sort();",
    "  if (unloaded.length > 0) {",
    "    failed = true;",
    "    process.stdout.write(",
    "      `\\nnpm test fails on the repository's never-loaded-file guard: no test loads these files you added, so the repository's npm test (assert-all-covered) would fail. Import each from a test:\\n${unloaded.map((path) => `  ${path}`).join(\"\\n\")}\\n`,",
    "    );",
    "  }",
    "}",
    "const tscBin = join(\"node_modules\", \".bin\", \"tsc\");",
    "if (existsSync(\"carveout/surface/check.ts\") && !existsSync(tscBin))",
    "  process.stdout.write(\"\\nTypeScript is not installed, so the public surface's types were not checked.\\n\");",
    "else if (existsSync(\"carveout/surface/check.ts\")) {",
    "  // The public surface's types: check.ts holds each export code outside",
    "  // the slice uses to the type it had at the cut, one per line. An error",
    "  // on a line is that export's type changed; each is reported as a test,",
    "  // and one that failed when the folder was checked is not counted.",
    "  const result = spawnSync(tscBin, [\"-p\", \"carveout/surface/tsconfig.json\", \"--pretty\", \"false\"], { encoding: \"utf8\" });",
    "  const output = `${result.stdout ?? \"\"}${result.stderr ?? \"\"}`;",
    "  const lines = readFileSync(\"carveout/surface/check.ts\", \"utf8\").split(\"\\n\");",
    "  const DECLARATIONS = \"the public surface's declarations compile\";",
    "  const failures = new Map();",
    "  // The implicit anys the stubs leave, which the build does not count either.",
    "  let waivedHere = 0;",
    `  const waived = new Set(${JSON.stringify(waived)});`,
    `  const implicit = new RegExp(${JSON.stringify(`^TS${IMPLICIT_ANY_CODE}$`)});`,
    "  for (const [, file, line, code, message] of output.matchAll(/^(.+?)\\((\\d+),\\d+\\): error (TS\\d+): (.*)$/gm)) {",
    "    if (implicit.test(code) && waived.has(file.replaceAll(\"\\\\\", \"/\"))) {",
    "      waivedHere += 1;",
    "      continue;",
    "    }",
    "    const label = file.replaceAll(\"\\\\\", \"/\").endsWith(\"carveout/surface/check.ts\") ? / \\/\\/ (.+) \\| (.+) \\| (value|type)$/.exec(lines[Number(line) - 1] ?? \"\") : null;",
    "    const name = label === null ? DECLARATIONS : `${label[1]} keeps the type of ${label[2]}`;",
    "    failures.set(name, [...(failures.get(name) ?? []), `${code}: ${message}`]);",
    "  }",
    "  if (result.status !== 0 && failures.size === 0 && waivedHere === 0) failures.set(DECLARATIONS, [output.trim().slice(0, 2000) || `tsc exited ${result.status}`]);",
    "  // The baseline as it was read before any test ran: a test may write the file.",
    "  const known = baseline ?? new Set();",
    "  const names = [...failures.keys()].sort();",
    "  surface.checks += Math.max(lines.filter((line) => / \\/\\/ (.+) \\| (.+) \\| (value|type)$/.test(line)).length, names.length);",
    "  surface.fail += names.length;",
    "  // Into the TAP `carveout check` reads, so a failure before any edit",
    "  // joins the baseline as a test's does.",
    "  const tap = names.map((name, index) => `not ok ${index + 1} - ${name}\\n`).join(\"\");",
    "  appendFileSync(\"carveout/.last-run.tap\", tap);",
    "  const changed = names.filter((name) => !known.has(name));",
    "  if (changed.length > 0) {",
    "    failed = true;",
    "    process.stdout.write(`\\nThe public surface changed type: code outside the slice uses these exports with the types they had at the cut, and may no longer compile. Keep each compatible, or tell the maintainer the change is meant:\\n\\n${changed.map((name) => `not ok - ${name}\\n${failures.get(name).slice(0, 5).map((message) => `  ${message}`).join(\"\\n\")}`).join(\"\\n\\n\")}\\n`);",
    "  }",
    "  if (names.length > changed.length)",
    "    process.stdout.write(`\\n${names.length - changed.length} surface check(s) fail as they did when the folder was checked; not counted.\\n`);",
    "}",
    "if (vitest.length > 0) {",
    '  const bin = join("node_modules", ".bin", "vitest");',
    "  if (!existsSync(bin)) {",
    "    failed = true;",
    "    process.stderr.write(`vitest is not installed, so ${vitest.length} Vitest test file(s) did not run.\\n`);",
    "  } else {",
    "    // Its report as JSON beside the usual output: each test by file and",
    "    // name, so a failure joins the TAP, and the baseline, as a node:test",
    "    // one does, and a test that failed on the mocks before any edit is",
    "    // not counted here either.",
    `    rmSync(${JSON.stringify(VITEST_REPORT_PATH)}, { force: true });`,
    "    // With a baseline, the report alone, and only what fails anew printed",
    "    // below: Vitest's own report printed the baseline's failures too.",
    `    const reporters = baseline === null ? ["--reporter=default", "--reporter=json"] : ["--reporter=json"];`,
    `    const result = spawnSync(bin, ["run", ${globals ? '"--globals", ' : ""}...reporters, "--outputFile.json=${VITEST_REPORT_PATH}", ...vitest], { stdio: baseline === null ? "inherit" : ["inherit", "ignore", "inherit"] });`,
    "    let report = null;",
    "    try {",
    `      report = JSON.parse(readFileSync(${JSON.stringify(VITEST_REPORT_PATH)}, "utf8"));`,
    "    } catch {}",
    "    if (report === null || !Array.isArray(report.testResults)) {",
    "      if (result.status !== 0) failed = true;",
    "    } else {",
    '      const here = realpathSync(".");',
    "      const pathOf = (file) => {",
    "        const path = relativeTo(here, String(file)).split(\"\\\\\").join(\"/\");",
    "        return path.startsWith(\"..\") ? String(file) : path;",
    "      };",
    "      const results = [];",
    "      for (const file of report.testResults) {",
    "        const path = pathOf(file.name);",
    "        const cases = Array.isArray(file.assertionResults) ? file.assertionResults : [];",
    "        // A file that failed before any of its tests ran (an import that",
    "        // throws) is one failing test, named for the file, as node:test's is.",
    '        if (file.status === "failed" && !cases.some((each) => each.status === "failed")) results.push({ name: tapName(path), status: "failed", messages: [String(file.message ?? "")] });',
    "        for (const each of cases)",
    '          results.push({ name: tapName([path, ...(each.ancestorTitles ?? []), each.title].join(" > ")), status: each.status, messages: Array.isArray(each.failureMessages) ? each.failureMessages.map(String) : [] });',
    "      }",
    '      const failing = [...new Set(results.filter((each) => each.status === "failed").map((each) => each.name))].sort();',
    "      const fresh = failing.filter((name) => baseline === null || !baseline.has(name));",
    `      appendFileSync(${JSON.stringify(LAST_RUN_PATH)}, failing.map((name, index) => \`not ok \${index + 1} - \${name}\\n\`).join(""));`,
    '      counted.push({ runner: "vitest", tests: results.length, pass: results.filter((each) => each.status === "passed").length, fail: failing.length });',
    "      if (baseline !== null) notCounted += failing.length - fresh.length;",
    "      if (fresh.length > 0) failed = true;",
    "      // A run that failed with no failing test: an error outside any test.",
    "      else if (result.status !== 0 && failing.length === 0) failed = true;",
    "      // Each in full, its first 40 lines, at the folder's paths and without",
    "      // the runner's own frames: what to fix.",
    "      const detail = (name) => {",
    "        const messages = results.find((each) => each.name === name)?.messages ?? [];",
    "        const lines = messages",
    "          .join(\"\\n\")",
    "          .split(here + \"/\").join(\"\")",
    "          .split(\"\\n\")",
    "          .filter((line) => line.trim() !== \"\" && !/node_modules\\/|\\(<anonymous>\\)|\\(node:internal\\//.test(line))",
    "          .map((line) => line.replace(/file:\\/\\//g, \"\"))",
    "          .slice(0, 40);",
    "        return [`not ok - ${name}`, ...lines.map((line) => `  ${line}`)].join(\"\\n\");",
    "      };",
    "      if (baseline !== null && fresh.length > 0)",
    "        process.stdout.write(`\\nFailing now and not when the folder was checked:\\n\\n${fresh.map(detail).join(\"\\n\\n\")}\\n`);",
    "      if (baseline !== null && failing.length > fresh.length)",
    `        process.stdout.write(\`\\n\${failing.length - fresh.length} Vitest test(s) fail on the mocks as they did when the folder was checked, not on your change; not counted (${BASELINE_PATH} names them).\\n\`);`,
    "    }",
    "  }",
    "}",
    "if (typeof unrun !== \"undefined\" && unrun.length > 0) {",
    "  failed = true;",
    `  process.stdout.write(\`\\nThe repository's npm test runs only \${folder}/${coverage?.tests ?? ""}, so it would not run these, and they would cover nothing there. Move them:\\n\${unrun.map((path) => \`  \${path}\`).join("\\n")}\\n\`);`,
    "}",
    "// The counts, for `carveout check` and for whoever ran this.",
    "const total = counted.reduce((sum, each) => ({ tests: sum.tests + each.tests, pass: sum.pass + each.pass }), { tests: 0, pass: 0 });",
    "const shown = counted.filter((each) => each.tests > 0);",
    "const countLines = [",
    "  ...counted.map((each) => `# carveout ${each.runner} tests ${each.tests} pass ${each.pass} fail ${each.fail}\\n`),",
    "  ...(surface.checks > 0 ? [`# carveout surface checks ${surface.checks} fail ${surface.fail}\\n`] : []),",
    "];",
    `if (countLines.length > 0) appendFileSync(${JSON.stringify(LAST_RUN_PATH)}, countLines.join(""));`,
    "// And as JSON, written after every test ran, which check reads: a test",
    "// can print lines like those into the TAP, not into this.",
    `writeFileSync(${JSON.stringify(COUNTS_PATH)}, JSON.stringify({ counted, surface }) + "\\n");`,
    "if (counted.length > 0 || surface.checks > 0)",
    "  process.stdout.write(",
    "    `\\nnpm test: ${total.pass} of ${total.tests} test(s) pass${shown.length > 1 ? ` (${shown.map((each) => `${each.runner} ${each.pass} of ${each.tests}`).join(\", \")})` : shown.length === 1 ? ` (${shown[0].runner})` : \"\"}${notCounted > 0 ? `; ${notCounted} failure(s) as before any edit, on the mocks, not counted` : \"\"}${surface.checks > 0 ? `; ${surface.checks - surface.fail} of ${surface.checks} check(s) of the public surface hold` : \"\"}.\\n`,",
    "  );",
    "process.exitCode = failed ? 1 : 0;",
  ].join("\n")}\n`;
}

function runScript(entries: readonly string[]): string {
  const lines = [
    "// `npm run dev`: load every entry point with the mocks in place and",
    "// report what it exports. Replace or extend this to exercise the slice.",
    "export {};",
    "",
  ];
  if (entries.length === 0) lines.push('console.log("No entry points.");');
  else {
    // Imported by name at run time, so an entry point the folder's edits
    // removed is reported here rather than failing the build.
    lines.push("const entries: [string, string][] = [");
    for (const entry of entries)
      lines.push(`  [${escapeJs(entry)}, ${escapeJs(relativeSpecifier(RUN_PATH, entry))}],`);
    lines.push(
      "];",
      "for (const [entry, specifier] of entries) {",
      "  try {",
      "    console.log(entry, Object.keys(await import(specifier)));",
      "  } catch (error) {",
      "    console.log(entry, \"does not load:\", error instanceof Error ? error.message : error);",
      "  }",
      "}",
    );
  }
  return `${lines.join("\n")}\n`;
}


function readme(input: {
  origin: ProjectOrigin;
  toolchain: Toolchain;
  editable: readonly string[];
  mockedModules: readonly string[];
  mockedPackages: readonly string[];
  installedPackages: readonly { name: string; version: string }[];
  environment: readonly string[];
  live: readonly string[];
  liveEnvironment: readonly string[];
  rewrites: readonly ImportRewrite[];
  tests: readonly string[];
  coverage?: CoverageGate | undefined;
}): string {
  const list = (items: readonly string[], empty: string) =>
    items.length === 0 ? [empty] : items.map((item) => `- \`${item}\``);
  // The commit is in carveout.json only: what the folder holds is a
  // function of the slice's content, so a cut at a later commit that
  // changed nothing of it writes the same files.
  return `${[
    `# ${input.origin.name}`,
    "",
    `A slice of ${input.origin.repository === null ? "a repository" : `\`${input.origin.repository}\``}, carved out by carveout (${input.origin.repository === null ? "the maintainer keeps the record of the cut" : "\`carveout.json\` names the commit"}). It holds only the files below; every module it imports from the rest of the repository is a stub with a recording mock behind it.`,
    "",
    "## Run it",
    "",
    `Node ${input.toolchain.nodeRange} and npm ${input.toolchain.npm.split(".")[0]} or later. ${
      input.live.length === 0
        ? "No account, service or credential is needed."
        : `The live packages below need their service running: ${input.live.join(", ")}, configured by ${input.liveEnvironment.length === 0 ? "the code's own defaults" : `your shell's ${input.liveEnvironment.map((name) => `\`${name}\``).join(", ")} or the code's own defaults`}. Nothing else needs an account, service or credential.`
    }`,
    "",
    "```sh",
    SANDBOX_COMMANDS.install,
    SANDBOX_COMMANDS.build,
    SANDBOX_COMMANDS.test,
    SANDBOX_COMMANDS.dev,
    "```",
    "",
    `\`${SANDBOX_COMMANDS.dev}\` runs \`${RUN_PATH}\`, which loads each entry point; replace it to exercise the slice.`,
    "",
    ...(input.coverage === undefined
      ? []
      : [
          `\`${SANDBOX_COMMANDS.test}\` holds the source files you add under \`${input.coverage.folder || "."}\` to the coverage the repository's own test requires of the package: ${(["lines", "branches", "functions"] as const)
            .flatMap((name) => (input.coverage?.[name] === undefined ? [] : [`${name} ${input.coverage[name]}%`]))
            .join(", ")}. Write tests for what you add; the files the cut copied are measured in the repository, not here.${
            input.coverage.allCovered === undefined
              ? ""
              : ` It also fails, as the repository's does, when a file you add under \`${[input.coverage.folder, input.coverage.allCovered.dir].filter((part) => part !== "").join("/")}\` is loaded by no test.`
          }`,
          "",
        ]),
    "## The slice",
    "",
    "Copied from the repository, at the same paths. Edit these:",
    "",
    ...list(input.editable, "No files."),
    "",
    "Everything under `carveout/`, and the configuration at the root, is generated. `carveout patch` turns your edits back into a patch for the repository, with the import rewrites below undone.",
    "",
    "What comes back: your edits to these files and new files beside them, in the same packages. A test that imports `carveout/` (to make a mock answer) stays here, so write the tests you hand back against the slice's own code, and keep mock-driven ones as your own check. New files elsewhere, CI and hook files, package manifests and lockfiles, and deleted tests are not carried back. Passing here means the change builds and passes against mocks; the repository's own checks decide after the merge.",
    "",
    "## Mocks",
    "",
    `Modules outside the slice are declared by \`.d.ts\` stubs beside generated \`.js\` runtimes whose values are recording mocks (\`${MOCK_RUNTIME_PATH}\`). Packages it does not install are mock packages under \`${MOCKS_DIR}/\`. A mock answers any property or call with another mock and records the call; \`mockImplementation(path, fn)\` installs behaviour and \`recordedCalls()\` reads it back. Environment values are placeholders in \`${ENV_FILE}\`.`,
    "",
    "Mocked modules:",
    "",
    ...list(input.mockedModules, "None."),
    "",
    "Mocked packages:",
    "",
    ...list(input.mockedPackages, "None."),
    "",
    "Installed packages:",
    "",
    ...list(
      input.installedPackages.map((item) => `${item.name}@${item.version}`),
      "None.",
    ),
    "",
    "Environment:",
    "",
    ...list(input.environment, "None."),
    "",
    ...(input.live.length === 0
      ? []
      : [
          "Live packages, real rather than mocked (their service must be running):",
          "",
          ...list(input.live, "None."),
          "",
          "Environment left to the shell, read by their importers:",
          "",
          ...list(input.liveEnvironment, "None."),
          "",
        ]),
    "## Import rewrites",
    "",
    ...(input.rewrites.length === 0
      ? ["None."]
      : input.rewrites.map((item) =>
          // A public folder names what an import became, not how the
          // repository spelled it (a workspace package's name, a path alias).
          input.origin.repository === null
            ? `- \`${item.file}\`: an import rewritten to \`${item.to}\``
            : `- \`${item.file}\`: \`${item.from}\` → \`${item.to}\``,
        )),
    "",
    "## Tests",
    "",
    ...list(input.tests, "None."),
    "",
    `\`${SANDBOX_COMMANDS.test}\` builds the folder, then runs every test file in it (\`*.test.*\`, \`*.spec.*\`), the tests above and any you add, each on the runner it imports: a node:test test on its compiled \`.js\` (so run it through \`npm test\`), a Vitest test on its source. Tests that failed on the mocks before any edit, on either runner, are listed in \`${BASELINE_PATH}\` once the folder has been checked; the run prints in full only the failures that are not among them, and does not count them. Its last line counts the tests that pass, by runner, and apart from them the checks that the public surface keeps its exports and types. There is nothing to read in \`${TEST_RUNNER_PATH}\` beyond this.`,
    "",
    "`BOUNDARY.md` is an index of the modules the slice imports from outside and of the exports outside code takes from it; the types are in the `.d.ts` stubs beside the mocks. `carveout.json` records the cut.",
  ].join("\n")}\n`;
}

/**
 * Generates the project. Deterministic: the same inputs give the same
 * files in the same order.
 */
export function generateProject(input: ProjectInput): GeneratedProject {
  const toolchain = input.toolchain ?? SANDBOX_TOOLCHAIN;
  const blockers: ProjectBlocker[] = [];
  const rewrites: ImportRewrite[] = [];
  const files = new Map<string, GeneratedFile>();
  const add = (file: GeneratedFile) => {
    if (files.has(file.path))
      blockers.push({
        code: "path_conflict",
        file: file.path,
        detail: `${file.path} is produced twice.`,
      });
    else files.set(file.path, file);
  };
  const projectPaths = new Map<string, string>();
  for (const source of input.sources)
    projectPaths.set(source.originalPath, source.path);
  for (const stub of input.stubs) projectPaths.set(stub.module, stub.path);
  const pathOf = (original: string) => projectPaths.get(original) ?? null;
  const known = new Set(input.knownSpecifiers.map(packageNameOf));
  for (const dependency of input.dependencies)
    if (dependency.kind === "package") known.add(dependency.name);
  // Every import the slice resolved, inside it or across a cut, by
  // importer and the specifier as written.
  const targetOf = new Map<string, string>();
  for (const edge of [
    ...input.manifest.cuts.outbound,
    ...input.manifest.internalImports,
  ])
    if (edge.specifier !== null)
      targetOf.set(`${edge.from}\n${edge.specifier}`, edge.to);

  // Copied source. Path aliases become relative imports.
  for (const source of input.sources) {
    let text = source.text;
    if (isScript(source.path))
      // Each specifier the syntax tree holds, and nothing a comment or a
      // string quotes: a misread here was a false blocker or an import
      // left for Node to fail on.
      text = rewriteSpecifiers(source.path, source.text, ({ specifier }) => {
        const relative =
          specifier.startsWith(".") || specifier.startsWith("/");
        if (
          specifier.startsWith("node:") ||
          (!relative && known.has(packageNameOf(specifier)))
        )
          return null;
        const target = targetOf.get(`${source.originalPath}\n${specifier}`);
        const projectTarget = target === undefined ? null : pathOf(target);
        if (projectTarget === null) {
          // A relative import the graph did not record is left as written
          // for the compiler to judge; a cut module without a stub is
          // already a `mock_unsupported` blocker.
          if (!relative)
            blockers.push({
              code: "import_unrewritable",
              file: source.originalPath,
              detail: `${specifier} is neither a package nor a module the slice resolved.`,
            });
          return null;
        }
        const to = relativeSpecifier(source.path, projectTarget);
        // A relative import is kept as written unless Node's resolution
        // needs it spelled out: an extensionless or directory import a
        // bundler resolved, or an asset whose path it names already.
        if (relative && projectTarget === target && isAssetPath(target))
          return null;
        if (to === specifier) return null;
        rewrites.push({ file: source.path, from: specifier, to });
        return to;
      });
    else if (/\.[cm]?jsx?$/.test(source.originalPath))
      blockers.push({
        code: "language_unsupported",
        file: source.originalPath,
        detail:
          "The project compiles TypeScript in place; a JavaScript source would be overwritten by its own output.",
      });
    add({ path: source.path, text, class: "source", public: true });
  }

  // Cut modules: declaration stubs beside generated runtimes.
  const mockedModules: string[] = [];
  const stubByModule = new Map(input.stubs.map((stub) => [stub.module, stub]));
  for (const module of input.contract.outbound) {
    const stub = stubByModule.get(module.module);
    if (stub === undefined) {
      blockers.push({
        code: "mock_unsupported",
        file: module.module,
        detail: "The slice produced no declaration stub for this module.",
      });
      continue;
    }
    mockedModules.push(stub.path);
    add({
      path: declarationPath(stub.path),
      text: stub.text,
      class: "stub",
      public: true,
    });
    add({
      path: runtimePath(stub.path),
      text: mockRuntimeFor(
        stub.path,
        module.module,
        module.symbols,
        blockers,
        stub.text,
      ),
      class: "mock",
      public: true,
    });
  }
  // Stubs the contract does not list as modules (types a stub imports).
  for (const stub of input.stubs)
    if (!input.contract.outbound.some((m) => m.module === stub.module)) {
      add({
        path: declarationPath(stub.path),
        text: stub.text,
        class: "stub",
        public: true,
      });
      add({
        path: runtimePath(stub.path),
        text: "export {};\n",
        class: "mock",
        public: true,
      });
    }

  // Packages: approved ones install; mocked ones are local packages.
  const namedImports = scanNamedImports(input.sources);
  const virtualModules: Record<string, string> = {};
  // A virtual module's folder is its name made a path; two that make one
  // (`@/api`, `#api`) each take a short hash of their own name too.
  const folderName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "module";
  const virtualNames = input.dependencies
    .filter((dependency) => dependency.kind === "package" && dependency.resolution === "runtime-mock" && !isPackageName(dependency.name))
    .map((dependency) => dependency.name);
  const taken = new Map<string, number>();
  for (const name of virtualNames) taken.set(folderName(name), (taken.get(folderName(name)) ?? 0) + 1);
  const virtualFolderOf = (name: string) =>
    (taken.get(folderName(name)) ?? 0) > 1
      ? `${folderName(name)}-${createHash("sha256").update(name).digest("hex").slice(0, 6)}`
      : folderName(name);
  const mockedPackages: string[] = [];
  const installedPackages: { name: string; version: string }[] = [];
  const dependencies: Record<string, string> = {};
  for (const dependency of [...input.dependencies].sort((a, b) =>
    compare(a.name, b.name),
  )) {
    if (dependency.kind !== "package") continue;
    if (
      dependency.resolution === "approved-package" &&
      dependency.version !== null
    ) {
      installedPackages.push({
        name: dependency.name,
        version: dependency.version,
      });
      dependencies[dependency.name] = dependency.version;
    } else if (dependency.resolution === "runtime-mock") {
      const name = dependency.name;
      // A module that is no package (`virtual:build-info`, an alias that
      // resolved nowhere) is mocked in the folder and found by its name:
      // TypeScript through `paths`, Node through the loader's map.
      const virtual = !isPackageName(name);
      const dir = virtual ? `${VIRTUAL_DIR}/${virtualFolderOf(name)}` : `${MOCKS_DIR}/${name}`;
      if (virtual) virtualModules[name] = dir;
      else {
        mockedPackages.push(name);
        dependencies[name] = `file:${dir}`;
      }
      const names = [...(namedImports.get(name) ?? [])].sort(compare);
      add({
        path: `${dir}/package.json`,
        text: `${JSON.stringify(
          {
            name,
            // At the version the importer pins, so an installed package's
            // peer range on the mocked one still resolves (E8b: npm 10
            // refused drizzle-orm's `postgres >=3` against a 0.0.0 mock).
            version: mockVersion(dependency.version),
            private: true,
            type: "module",
            main: "index.js",
            types: "index.d.ts",
          },
          null,
          2,
        )}\n`,
        class: "mock",
        public: true,
      });
      add({
        path: `${dir}/index.js`,
        text: `${[
          `// Mock of the ${name} package. Values are recording mocks.`,
          `import { createMock } from "${relativeSpecifier(`${dir}/index.js`, MOCK_RUNTIME_PATH)}";`,
          `const mock = createMock(${JSON.stringify(`package:${name}`)});`,
          "export default mock;",
          ...names.map(
            (name) => `export const ${name} = mock[${JSON.stringify(name)}];`,
          ),
        ].join("\n")}\n`,
        class: "mock",
        public: true,
      });
      add({
        path: `${dir}/index.d.ts`,
        text: `${[
          "declare const mock: any;",
          "export default mock;",
          ...names.map((name) => `export const ${name}: any;`),
        ].join("\n")}\n`,
        class: "mock",
        public: true,
      });
    }
  }

  // Harness.
  add({
    path: MOCK_RUNTIME_PATH,
    text: MOCK_RUNTIME,
    class: "harness",
    public: true,
  });
  add({
    path: ASSETS_LOADER_PATH,
    text: ASSETS_LOADER,
    class: "harness",
    public: true,
  });
  add({
    path: `${HARNESS_DIR}/mock.d.ts`,
    text: MOCK_RUNTIME_TYPES,
    class: "harness",
    public: true,
  });
  add({
    path: AMBIENT_PATH,
    text: ambientDeclarations(
      [
        ...installedPackages.map((p) => p.name),
        ...mockedPackages,
        // Node's modules by their bare names too (`fs`, `fs/promises`).
        ...(input.hasNodeTypes ? [] : input.knownSpecifiers)
          .filter((specifier) => !specifier.startsWith("node:"))
          .map(packageNameOf),
      ],
      input.packageModules,
      new Set(installedPackages.map((p) => p.name)),
      input.hasNodeTypes === true,
    ),
    class: "harness",
    public: true,
  });
  const entries = input.manifest.entryPoints
    .flatMap((entry) =>
      input.sources
        .filter(
          (source) =>
            source.originalPath === entry ||
            source.originalPath.startsWith(`${entry}/`),
        )
        .map((source) => source.path),
    )
    .filter((path, index, all) => isScript(path) && all.indexOf(path) === index)
    .sort(compare);
  add({
    path: RUN_PATH,
    text: runScript(entries),
    class: "harness",
    public: true,
  });

  // Tests: the interface test, then, when the cut brought them along, the
  // slice's own tests, each on the runner it imports.
  const tests = [`${TESTS_DIR}/interface.test.ts`];
  add({
    path: tests[0] ?? "",
    text: interfaceTests(input.contract.inbound, pathOf, entries),
    class: "test-public",
    public: true,
  });
  const vitestTests: string[] = [];
  // A mocked Vitest runs nothing; say so rather than fail the check on it.
  const vitestInstalled = input.dependencies.some(
    (dependency) =>
      dependency.name === "vitest" && dependency.resolution === "approved-package",
  );
  const vitestDeclared = input.dependencies.some((dependency) => dependency.name === "vitest");
  /** Tests on Vitest's globals: they import no runner (see `testRunnerResolver`). */
  let globals = false;
  if (input.manifest.params.tests)
    for (const source of input.sources) {
      if (!isScript(source.path) || !isTestPath(source.originalPath)) continue;
      const specifiers = moduleSpecifiers(source.path, source.text).map((item) => item.specifier);
      let runner: string | null = testRunnerOf(specifiers);
      if (runner === null && vitestDeclared && usesTestGlobals(source.text)) {
        runner = "vitest";
        globals = true;
      }
      if (runner === "vitest") vitestTests.push(source.path);
      else if (runner === null) continue;
      tests.push(source.path);
    }
  if (vitestTests.length > 0 && !vitestInstalled) {
    blockers.push({
      code: "test_runner_mocked",
      file: null,
      detail: `vitest is not installed, so ${vitestTests.length} Vitest test file(s) do not run; cut again with --install vitest.`,
    });
    vitestTests.length = 0;
  }
  for (const file of input.surface ?? [])
    add({ path: file.path, text: file.text, class: "harness", public: true });
  add({
    path: TEST_RUNNER_PATH,
    text: testRunnerScript(input.coverage, globals && vitestInstalled, input.keepsImplicitAny !== true ? (input.implicitAnyFiles ?? []) : []),
    class: "harness",
    public: true,
  });
  // When the stubs leave an implicit any where the repository's types give
  // one, the folder keeps noImplicitAny and its build does not count those
  // (`buildScript`): relaxed for the whole folder, every `[]` would type as
  // `never[]` under strictNullChecks, and code that pushes into one would
  // stop compiling (E5: touched-repos).
  const waived = input.keepsImplicitAny !== true ? [...(input.implicitAnyFiles ?? [])] : [];
  const scripts = {
    ...SANDBOX_SCRIPTS,
    ...(waived.length === 0 ? {} : { build: `node ${BUILD_SCRIPT_PATH}` }),
    test: `npm run build && node ${TEST_RUNNER_PATH}`,
  };
  if (waived.length > 0) add({ path: BUILD_SCRIPT_PATH, text: buildScript(waived), class: "harness", public: true });

  // Configuration.
  const liveEnvironment = new Set(input.liveEnvironment ?? []);
  const environment = input.manifest.externals.environment
    .map((item) => item.name)
    .filter((name) => !liveEnvironment.has(name));
  add({
    path: "package.json",
    text: `${JSON.stringify(
      {
        name: input.origin.name,
        version: "0.0.0",
        private: true,
        type: "module",
        engines: { node: toolchain.nodeRange },
        scripts,
        dependencies,
        devDependencies: { typescript: toolchain.typescript },
      },
      null,
      2,
    )}\n`,
    class: "config",
    public: true,
  });
  add({
    path: "tsconfig.json",
    text: tsconfigFor(
      {
        ...input.compilerOptions,
        ...(input.keepsImplicitAny === true ? {} : waived.length > 0 ? { noEmitOnError: false } : UNTYPED_PACKAGE_OPTIONS),
      },
      globals && vitestInstalled ? ["vitest/globals"] : [],
      [],
      // A module's subpaths (`virtual:pwa-register/react`) answer from its mock too.
      Object.fromEntries(
        Object.entries(virtualModules).flatMap(([name, dir]) => [
          [name, [`./${dir}/index.d.ts`]],
          [`${name}/*`, [`./${dir}/index.d.ts`]],
        ]),
      ),
    ),
    class: "config",
    public: true,
  });
  if (Object.keys(virtualModules).length > 0)
    add({ path: VIRTUAL_MAP_PATH, text: `${JSON.stringify(virtualModules, null, 2)}\n`, class: "harness", public: true });
  // Vitest resolves by Vite's rules, which know neither tsc's paths nor the
  // loader's map: the virtual modules go to it as aliases.
  if (vitestTests.length > 0 || (input.testRunner === "vitest" && vitestInstalled))
    add({
      path: "vitest.config.mjs",
      text: vitestConfigText(input.vitest ?? { setupFiles: [] }, undefined, virtualModules),
      class: "config",
      public: true,
    });

  add({
    path: ".nvmrc",
    text: `${toolchain.node}\n`,
    class: "config",
    public: true,
  });
  add({
    path: ".npmrc",
    text: "engine-strict=true\nignore-scripts=true\nfund=false\naudit=false\nupdate-notifier=false\n",
    class: "config",
    public: true,
  });
  add({
    path: ENV_FILE,
    text: `${[
      "# Placeholder values for the environment the slice reads. Safe to",
      "# commit; nothing here reaches a real service.",
      ...(liveEnvironment.size === 0
        ? []
        : [
            `# Read by the importers of the live packages, so left to the shell: ${[...liveEnvironment].sort(compare).join(", ")}.`,
          ]),
      ...environment.map(
        (name) =>
          `${name}=carveout-${name.toLowerCase().replace(/_/g, "-")}`,
      ),
    ].join("\n")}\n`,
    class: "config",
    public: true,
  });
  const emitted = [...files.values()]
    .filter((file) => isScript(file.path))
    .map((file) => runtimePath(file.path))
    .filter((path) => !files.has(path))
    .sort(compare);
  // The folder's own `.js` files, which `*.js` would hide from a git
  // clone of it: a stub's runtime mock beside its declaration, a source
  // the repository writes in JavaScript.
  const kept = [...files.values()]
    .filter((file) => /\.[cm]?js$/.test(file.path) && !file.path.startsWith(`${HARNESS_DIR}/`) && file.path !== "vitest.config.mjs")
    .map((file) => `!${file.path}`)
    .sort(compare);
  add({
    path: ".gitignore",
    // The build's output for any source, a new one's too, and the test
    // run's record: none of it goes back.
    text: `${["node_modules/", "*.js", "!carveout/**/*.js", "!vitest.config.mjs", ...kept, "*.tsbuildinfo", LAST_RUN_PATH, COUNTS_PATH, VITEST_REPORT_PATH, ".npm-cache/", ...emitted].join("\n")}\n`,
    class: "config",
    public: true,
  });
  const editable = input.sources.map((source) => source.path).sort(compare);
  add({
    path: "README.md",
    text: readme({
      origin: input.origin,
      toolchain,
      editable,
      mockedModules: mockedModules.sort(compare),
      mockedPackages,
      installedPackages,
      environment,
      live: input.live ?? [],
      liveEnvironment: [...liveEnvironment].sort(compare),
      rewrites,
      tests,
      coverage: input.coverage,
    }),
    class: "config",
    public: true,
  });
  // Nothing the project holds may carry a credential the source held.
  blockers.push(...secretBlockers(scanSecrets([...files.values()])));
  return {
    files: [...files.values()].sort((a, b) => compare(a.path, b.path)),
    importRewrites: rewrites.sort((a, b) =>
      compare(`${a.file}\n${a.from}`, `${b.file}\n${b.from}`),
    ),
    tests,
    blockers,
  };
}
