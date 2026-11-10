/**
 * The test runner of a test file that imports none: Vitest with `globals`
 * (`describe`, `it`, `expect` as globals) in a package that depends on
 * Vitest and not on Jest. A test that imports `node:test` or `vitest` says
 * its runner itself (`testRunnerOf`). Without this, every test of a package
 * on Vitest's globals was left behind as running on no known runner (E8g:
 * all 11 tests of an n8n module).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testRunnerOf, type TestRunner } from "../slice/reach.js";

/** Calls a test file makes of a runner's globals. */
const GLOBAL_CALL = /(^|[^.\w$])(describe|it|test|suite)(\.(each|skip|only|todo|concurrent)\b[^(]*)?\s*\(/m;

/** The pattern's source, for the folder's own test runner to use. */
export const GLOBAL_CALL_SOURCE = GLOBAL_CALL.toString();

/** Whether a test file calls a runner's globals without importing one. */
export function usesTestGlobals(text: string): boolean {
  return GLOBAL_CALL.test(text);
}

/** `dependencies` and `devDependencies` of a package.json, or null. */
function declared(repo: string, folder: string): Set<string> | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(repo, folder, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies"]) {
      const section = manifest[key];
      if (section !== null && typeof section === "object")
        for (const name of Object.keys(section)) names.add(name);
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * The runner of each test file: its imports first, then a package on
 * Vitest's globals (the file's package, else the repository's root). Jest
 * is not run by a slice, so a package on Jest gives null.
 */
export function testRunnerResolver(
  repo: string,
  packageOf: (file: string) => string,
): (file: string, specifiers: readonly string[]) => TestRunner | null {
  const byPackage = new Map<string, Set<string> | null>();
  const dependencies = (folder: string) => {
    if (!byPackage.has(folder)) byPackage.set(folder, declared(repo, folder));
    return byPackage.get(folder) ?? null;
  };
  return (file, specifiers) => {
    const explicit = testRunnerOf(specifiers);
    if (explicit !== null) return explicit;
    if (specifiers.some((specifier) => specifier === "@jest/globals" || specifier === "jest")) return null;
    let text: string;
    try {
      text = readFileSync(join(repo, file), "utf8");
    } catch {
      return null;
    }
    if (!usesTestGlobals(text)) return null;
    for (const folder of [packageOf(file), ""]) {
      const names = dependencies(folder);
      if (names === null) continue;
      if (names.has("jest") && !names.has("vitest")) return null;
      if (names.has("vitest")) return "vitest-globals";
    }
    return null;
  };
}
