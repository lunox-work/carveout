/**
 * The Vitest settings a package's tests run under, read from its config's
 * syntax and never run: the environment (`jsdom` for a component's tests,
 * which otherwise fail on `document is not defined`), the setup files that
 * run before them, the test timeout and the globals. A slice that carries
 * the package's Vitest tests runs them under the same settings: the setup
 * files come along as entry points, the environment's package is installed
 * as the repository locks it, and the folder gets a `vitest.config.mjs`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

/** What a package's Vitest config sets for its tests, as far as the slice needs. */
export interface VitestSettings {
  /** `jsdom`, `happy-dom`, `node`, or another environment's name. */
  readonly environment?: string;
  /** Setup files, as paths from the repository's root. */
  readonly setupFiles: readonly string[];
  /**
   * Setup files named by a package's specifier
   * (`@testing-library/jest-dom/vitest`): installed, and run as named.
   */
  readonly setupPackages?: readonly string[];
  readonly testTimeout?: number;
  readonly globals?: boolean;
}

const CONFIG_NAMES = ["vitest.config", "vite.config"].flatMap((name) =>
  ["ts", "mts", "cts", "js", "mjs", "cjs"].map((ext) => `${name}.${ext}`),
);

/** The packages each environment runs on. */
export const ENVIRONMENT_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  jsdom: ["jsdom"],
  "happy-dom": ["happy-dom"],
  "edge-runtime": ["@edge-runtime/vm"],
};

/**
 * The environments a test file asks for itself, in a docblock comment
 * (`// @vitest-environment happy-dom`), which run whatever the config says.
 */
export function fileEnvironments(text: string): string[] {
  return [...new Set([...text.matchAll(/@vitest-environment\s+([\w-]+)/g)].map((match) => match[1] ?? ""))].filter(Boolean);
}

/** An expression with what only types it taken away: `(x)`, `x as T`, `x satisfies T`, `<T>x`. */
function bare(node: ts.Expression): ts.Expression {
  let at = node;
  for (;;) {
    if (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at))
      at = at.expression;
    else return at;
  }
}

/**
 * The object an expression of the config comes to, read and never run: an
 * object literal; a call's (`defineConfig({…})`, `mergeConfig(a, b)`, the
 * last that is one); a function's result (`defineConfig(() => ({…}))`, or
 * its block's last `return`); a name declared in the file with one.
 */
function objectOf(node: ts.Expression | undefined, source: ts.SourceFile, depth = 0): ts.ObjectLiteralExpression | null {
  if (node === undefined || depth > 8) return null;
  const at = bare(node);
  if (ts.isObjectLiteralExpression(at)) return at;
  if (ts.isCallExpression(at)) {
    for (const argument of [...at.arguments].reverse()) {
      const found = objectOf(argument, source, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) {
    if (!ts.isBlock(at.body)) return objectOf(at.body, source, depth + 1);
    const returns: ts.Expression[] = [];
    const visit = (child: ts.Node): void => {
      if (ts.isFunctionLike(child) && child !== at) return;
      if (ts.isReturnStatement(child) && child.expression !== undefined) returns.push(child.expression);
      ts.forEachChild(child, visit);
    };
    visit(at.body);
    return objectOf(returns.at(-1), source, depth + 1);
  }
  if (ts.isIdentifier(at)) {
    for (const statement of source.statements)
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text === at.text)
            return objectOf(declaration.initializer, source, depth + 1);
  }
  return null;
}

/** An object literal's property's value by its key: `key: value`, or `key` alone (shorthand). */
function propertyOf(object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const each of object.properties) {
    if (ts.isPropertyAssignment(each) && (ts.isIdentifier(each.name) || ts.isStringLiteral(each.name)) && each.name.text === key)
      return each.initializer;
    if (ts.isShorthandPropertyAssignment(each) && each.name.text === key) return each.name;
  }
  return undefined;
}

/**
 * The settings of the first Vitest config in `dir` (`vitest.config.*`,
 * then `vite.config.*`), else at the repository's root, or null when there
 * is none or it sets nothing the slice can carry. The `test` object is the
 * default export's (through `defineConfig`, a function, a name), else the
 * first `test: {…}` in the file. Only literal values are read: a computed
 * one is left to Vitest's default.
 */
export function vitestSettings(repo: string, dir: string): VitestSettings | null {
  const at = [dir, ...(dir === "" ? [] : [""])].flatMap((folder) =>
    CONFIG_NAMES.filter((candidate) => existsSync(join(repo, folder, candidate))).map((name) => ({ folder, name })),
  )[0];
  if (at === undefined) return null;
  const { folder, name } = at;
  const text = readFileSync(join(repo, folder, name), "utf8");
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  let test: ts.ObjectLiteralExpression | null = null;
  for (const statement of source.statements)
    if (ts.isExportAssignment(statement)) {
      const config = objectOf(statement.expression, source);
      const value = config === null ? undefined : propertyOf(config, "test");
      test = objectOf(value, source);
    }
  if (test === null) {
    const visit = (node: ts.Node): void => {
      if (test !== null) return;
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "test") {
        const found = objectOf(node.initializer, source);
        if (found !== null) {
          test = found;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (test === null) return null;
  const found = test as ts.ObjectLiteralExpression;
  const property = (key: string): ts.Expression | undefined => {
    const value = propertyOf(found, key);
    return value === undefined ? undefined : bare(value);
  };
  const environment = property("environment");
  const setup = property("setupFiles");
  const timeout = property("testTimeout");
  const globals = property("globals");
  const root = property("root");
  const strings = (node: ts.Expression | undefined): string[] =>
    node === undefined
      ? []
      : ts.isStringLiteralLike(node)
        ? [node.text]
        : ts.isArrayLiteralExpression(node)
          ? node.elements.flatMap((element) => (ts.isStringLiteralLike(element) ? [element.text] : []))
          : [];
  // Relative to the config's folder, or to the `root` it sets.
  const base = root !== undefined && ts.isStringLiteralLike(root) ? posix.normalize(posix.join(folder, root.text)) : folder;
  const named = strings(setup);
  const setupFiles = named
    .filter((file) => file.startsWith(".") || file.startsWith("/") === false && /\.[cm]?[jt]sx?$/.test(file) && !isBareSpecifier(file))
    .map((file) => posix.normalize(posix.join(base, file.replace(/^\.\//, ""))))
    // As Vitest finds one: as written, or with a script's extension.
    .flatMap((file) => ["", ".ts", ".tsx", ".mts", ".js", ".mjs"].map((ext) => `${file}${ext}`).find((path) => existsSync(join(repo, path)) && statSync(join(repo, path)).isFile()) ?? [])
    .filter((file) => !file.startsWith(".."));
  const setupPackages = named.filter(isBareSpecifier);
  const timeoutText = timeout !== undefined ? timeout.getText(source).replace(/_/g, "") : "";
  const settings: VitestSettings = {
    ...(environment !== undefined && ts.isStringLiteralLike(environment) ? { environment: environment.text } : {}),
    setupFiles,
    ...(setupPackages.length === 0 ? {} : { setupPackages }),
    ...(/^\d+$/.test(timeoutText) ? { testTimeout: Number(timeoutText) } : {}),
    ...(globals?.kind === ts.SyntaxKind.TrueKeyword ? { globals: true } : {}),
  };
  return settings.environment === undefined &&
    settings.setupFiles.length === 0 &&
    setupPackages.length === 0 &&
    settings.testTimeout === undefined &&
    settings.globals !== true
    ? null
    : settings;
}

/** A specifier that names a package (`@testing-library/jest-dom/vitest`, `vitest-canvas-mock`), not a file. */
function isBareSpecifier(name: string): boolean {
  return !name.startsWith(".") && !name.startsWith("/") && !/^[A-Za-z]:/.test(name) && /^(@[\w.-]+\/)?[\w.-]+(\/[\w./-]*)?$/.test(name) && !/\.[cm]?[jt]sx?$/.test(name.split("/").pop() ?? "");
}

/**
 * The folder's `vitest.config.mjs`: the settings, with the setup files at
 * their folder paths; an alias for each module that is no package
 * (`virtual:build-info`, and its subpaths) to its mock under `carveout/`;
 * and a resolver that reads the source beside a built `.js`. The folder's
 * build writes a `.js` beside each `.ts` for node:test, and a relative
 * `./x.js` would otherwise be that file to Vitest: `vitest` run on its own
 * after an edit tested the code as it was at the last build, where the
 * repository's Vitest reads the source.
 */
export function vitestConfigText(
  settings: VitestSettings,
  folderPath: (path: string) => string = (path) => path,
  /** Module name → the folder of its mock, from the folder's root. */
  virtualModules: Readonly<Record<string, string>> = {},
): string {
  const test: Record<string, unknown> = {
    ...(settings.environment === undefined ? {} : { environment: settings.environment }),
    ...(settings.setupFiles.length === 0 && (settings.setupPackages ?? []).length === 0
      ? {}
      : { setupFiles: [...(settings.setupPackages ?? []), ...settings.setupFiles.map((file) => `./${folderPath(file)}`)] }),
    ...(settings.testTimeout === undefined ? {} : { testTimeout: settings.testTimeout }),
    ...(settings.globals === true ? { globals: true } : {}),
  };
  const aliases = Object.entries(virtualModules).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return [
    "// The repository's Vitest settings for the tests this folder carries, as the cut read them,",
    "// the modules that are no package found at their mocks, and the source read beside a built .js.",
    'import { existsSync } from "node:fs";',
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    "const SOURCES = { js: [\".ts\", \".tsx\"], mjs: [\".mts\"], cjs: [\".cts\"] };",
    "/** `./x.js` from the folder's own code is `./x.ts` when that is there, as in the repository. */",
    "const sourceFirst = {",
    '  name: "carveout-source-first",',
    '  enforce: "pre",',
    "  resolveId(source, importer) {",
    '    if (importer === undefined || importer.includes("/node_modules/") || !/^\\.{1,2}\\//.test(source)) return null;',
    "    const match = /^(.*)\\.([cm]?js)$/.exec(source);",
    "    if (match === null) return null;",
    '    const stem = resolve(dirname(importer.split("?")[0]), match[1]);',
    "    for (const ext of SOURCES[match[2]]) if (existsSync(stem + ext)) return stem + ext;",
    "    return null;",
    "  },",
    "};",
    "",
    "export default {",
    "  plugins: [sourceFirst],",
    `  test: ${JSON.stringify(test, null, 2).replace(/\n/g, "\n  ")},`,
    ...(aliases.length === 0
      ? []
      : [
          "  resolve: {",
          "    alias: [",
          ...aliases.map(
            ([name, dir]) =>
              `      { find: /^${escape(name)}(?:\\/.*)?$/, replacement: fileURLToPath(new URL(${JSON.stringify(`./${dir}/index.js`)}, import.meta.url)) },`,
          ),
          "    ],",
          "  },",
        ]),
    "};",
    "",
  ].join("\n");
}
