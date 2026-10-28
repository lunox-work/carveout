/**
 * The request a cut is made from, and the JSON form every record is
 * written in, so two cuts of the same bytes give the same files.
 */

export const SLICE_TOOL_VERSION = "carveout-slice@1";

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
  /** Kept for the manifest's shape; the import graph has no inferred edges. */
  readonly includeInferred: boolean;
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
