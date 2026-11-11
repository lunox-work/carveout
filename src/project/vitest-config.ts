/**
 * The Vitest settings a package's tests run under, read from its config's
 * syntax and never run: the environment (`jsdom` for a component's tests,
 * which otherwise fail on `document is not defined`), the setup files that
 * run before them, the test timeout and the globals. A slice that carries
 * the package's Vitest tests runs them under the same settings: the setup
 * files come along as entry points, the environment's package is installed
 * as the repository locks it, and the folder gets a `vitest.config.mjs`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

/** What a package's Vitest config sets for its tests, as far as the slice needs. */
export interface VitestSettings {
  /** `jsdom`, `happy-dom`, `node`, or another environment's name. */
  readonly environment?: string;
  /** Setup files, as paths from the repository's root. */
  readonly setupFiles: readonly string[];
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
};

/**
 * The settings of the first Vitest config in `dir` (`vitest.config.*`,
 * then `vite.config.*`), or null when there is none or it sets nothing the
 * slice can carry. Only literal values are read: a computed one is left to
 * Vitest's default.
 */
export function vitestSettings(repo: string, dir: string): VitestSettings | null {
  const name = CONFIG_NAMES.find((candidate) => existsSync(join(repo, dir, candidate)));
  if (name === undefined) return null;
  const text = readFileSync(join(repo, dir, name), "utf8");
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  let test: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (test !== null) return;
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === "test" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      test = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (test === null) return null;
  const found = test as ts.ObjectLiteralExpression;
  const property = (key: string): ts.Expression | undefined => {
    for (const each of found.properties)
      if (ts.isPropertyAssignment(each) && (ts.isIdentifier(each.name) || ts.isStringLiteral(each.name)) && each.name.text === key)
        return each.initializer;
    return undefined;
  };
  const environment = property("environment");
  const setup = property("setupFiles");
  const timeout = property("testTimeout");
  const globals = property("globals");
  const strings = (node: ts.Expression | undefined): string[] =>
    node === undefined
      ? []
      : ts.isStringLiteralLike(node)
        ? [node.text]
        : ts.isArrayLiteralExpression(node)
          ? node.elements.flatMap((element) => (ts.isStringLiteralLike(element) ? [element.text] : []))
          : [];
  const setupFiles = strings(setup)
    .map((file) => posix.normalize(posix.join(dir, file.replace(/^\.\//, ""))))
    .filter((file) => !file.startsWith("..") && existsSync(join(repo, file)));
  const timeoutText = timeout !== undefined ? timeout.getText(source).replace(/_/g, "") : "";
  const settings: VitestSettings = {
    ...(environment !== undefined && ts.isStringLiteralLike(environment) ? { environment: environment.text } : {}),
    setupFiles,
    ...(/^\d+$/.test(timeoutText) ? { testTimeout: Number(timeoutText) } : {}),
    ...(globals?.kind === ts.SyntaxKind.TrueKeyword ? { globals: true } : {}),
  };
  return settings.environment === undefined && settings.setupFiles.length === 0 && settings.testTimeout === undefined && settings.globals !== true
    ? null
    : settings;
}

/** The folder's `vitest.config.mjs`: the settings, with the setup files at their folder paths. */
export function vitestConfigText(settings: VitestSettings, folderPath: (path: string) => string = (path) => path): string {
  const test: Record<string, unknown> = {
    ...(settings.environment === undefined ? {} : { environment: settings.environment }),
    ...(settings.setupFiles.length === 0 ? {} : { setupFiles: settings.setupFiles.map((file) => `./${folderPath(file)}`) }),
    ...(settings.testTimeout === undefined ? {} : { testTimeout: settings.testTimeout }),
    ...(settings.globals === true ? { globals: true } : {}),
  };
  return `// The repository's Vitest settings for the tests this folder carries, as the cut read them.\nexport default ${JSON.stringify({ test }, null, 2)};\n`;
}
