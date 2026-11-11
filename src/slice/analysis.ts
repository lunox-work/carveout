/**
 * The request a cut is made from, and the JSON form every record is
 * written in, so two cuts of the same bytes give the same files.
 */

export const SLICE_TOOL_VERSION = "carveout-slice@2";

export interface SliceBudget {
  /** Files inside the slice; the first file past it on any path is a cut. */
  readonly maxFiles: number;
  /** Edges from the nearest entry point; a file further away is a cut. */
  readonly maxDepth: number;
}

export const SLICE_BUDGET_DEFAULTS: SliceBudget = { maxFiles: 40, maxDepth: 3 };

export interface SliceParams {
  /** Repository-relative file or directory paths, sorted and unique. */
  readonly entryPoints: readonly string[];
  readonly budget: SliceBudget;
  /** Also bring along the tests outside the slice that import it. */
  readonly tests: boolean;
  /**
   * The setup files the package's Vitest tests run before them (its
   * config's `setupFiles`), walked from as the entry points are but no
   * entry point: an edit to one is held as a test-runner setting's is.
   */
  readonly setupFiles?: readonly string[];
  /**
   * The runner the package's own tests run on, when it is Vitest: the
   * folder installs it, pinned as the package pins it, for the tests the
   * contributor writes, whether or not a test of the slice came along.
   */
  readonly testRunner?: "vitest";
  /**
   * Service packages kept real rather than mocked: installed and typed as
   * the repository has them, with the environment their importers read
   * left to the shell. Absent when none.
   */
  readonly live?: readonly string[];
  /**
   * Include every file of the entry points' package the walk reaches, at
   * any depth: the cut falls at package and service boundaries only, so a
   * sibling module is copied rather than stubbed. Absent when off.
   */
  readonly wholePackage?: boolean;
  /**
   * Follow an import of one of the repository's own packages into its
   * source, as an import of a file is followed, rather than stubbing the
   * package at the seam. Absent when off.
   */
  readonly followWorkspaces?: boolean;
  /**
   * Copy pure code the slice runs (validators, error classes, formatters)
   * rather than mock it, past the depth; see `ReachOptions.pure`. Absent
   * when off.
   */
  readonly copyPure?: boolean;
  /**
   * Files never copied, as paths or globs from the repository's root:
   * wherever the walk reaches one it is cut and stubbed, with its literal
   * values widened. Absent when none.
   */
  readonly private?: readonly string[];
  /**
   * Folders (or files) copied in whole beside the slice, as paths from the
   * repository's root: what the code reads by a name the walk cannot
   * follow, such as a migrations folder. A path read into one is no
   * blocker. Absent when none.
   */
  readonly copy?: readonly string[];
}

/**
 * Whether a repository path matches one of `patterns`: the path itself,
 * anything under it as a folder, or a glob (`*` within one segment, `**`
 * across segments). Pure, so a slice's record can say what was kept out.
 */
export function pathMatcher(
  patterns: readonly string[],
): (path: string) => boolean {
  const expressions = patterns.map((pattern) => {
    const clean = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const source = clean
      .split(/(\*\*\/?|\*)/)
      .map((part) =>
        part === "**/"
          ? "(?:.*/)?"
          : // A trailing `**` (`pricing/**`) is everything under the folder.
            part === "**"
            ? ".*"
            : part === "*"
            ? "[^/]*"
            : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    return new RegExp(`^${source}(?:/.*)?$`);
  });
  return (path) => expressions.some((expression) => expression.test(path));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Records must be JSON values.");
  return json;
}
