/**
 * Version catalogs: a pin of `catalog:` or `catalog:<name>` names a version
 * the workspace defines once, in pnpm's `pnpm-workspace.yaml` (`catalog:`
 * and `catalogs:`) or in the root `package.json` (Bun's and pnpm's
 * `workspaces.catalog(s)`, or top-level `catalog(s)`). npm knows no such
 * protocol, so a slice's `package.json` takes the version the catalog
 * gives, and its lockfile resolves (E8g: n8n's `catalog:typescript` stopped
 * the install).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

type Catalogs = Map<string, Map<string, string>>;

const DEFAULT = "default";

/** `'x'`, `"x"` or `x`, without a trailing comment. */
function scalar(text: string): string {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

/**
 * The `catalog:` and `catalogs:` maps of a `pnpm-workspace.yaml`: the
 * block-style YAML pnpm writes, read line by line by indentation. Flow
 * maps and anchors are not read; a catalog written so resolves nothing.
 */
export function parseWorkspaceCatalogs(text: string): Catalogs {
  const catalogs: Catalogs = new Map();
  let section: "catalog" | "catalogs" | null = null;
  let group: string | null = null;
  let groupIndent = -1;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const colon = line.search(/:(\s|$)/);
    if (colon === -1) continue;
    const key = scalar(line.slice(0, colon));
    const value = line.slice(colon + 1).trim();
    if (indent === 0) {
      section = key === "catalog" ? "catalog" : key === "catalogs" ? "catalogs" : null;
      group = section === "catalog" ? DEFAULT : null;
      groupIndent = -1;
      continue;
    }
    if (section === null) continue;
    if (section === "catalogs" && (group === null || indent <= groupIndent) && value === "") {
      group = key;
      groupIndent = indent;
      continue;
    }
    if (group === null || value === "") continue;
    const map = catalogs.get(group) ?? new Map<string, string>();
    map.set(key, scalar(value));
    catalogs.set(group, map);
  }
  return catalogs;
}

function fromJson(into: Catalogs, holder: unknown): void {
  if (holder === null || typeof holder !== "object") return;
  const record = holder as Record<string, unknown>;
  const add = (group: string, entries: unknown) => {
    if (entries === null || typeof entries !== "object") return;
    const map = into.get(group) ?? new Map<string, string>();
    for (const [name, version] of Object.entries(entries as Record<string, unknown>))
      if (typeof version === "string" && !map.has(name)) map.set(name, version);
    into.set(group, map);
  };
  add(DEFAULT, record["catalog"]);
  const named = record["catalogs"];
  if (named !== null && typeof named === "object")
    for (const [group, entries] of Object.entries(named as Record<string, unknown>)) add(group, entries);
}

/** The repository's catalogs, from every place a package manager keeps one. */
export function workspaceCatalogs(repo: string): Catalogs {
  const catalogs: Catalogs = new Map();
  try {
    for (const [group, map] of parseWorkspaceCatalogs(readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8")))
      catalogs.set(group, map);
  } catch {
    // No pnpm workspace file.
  }
  try {
    const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as Record<string, unknown>;
    fromJson(catalogs, manifest["workspaces"]);
    fromJson(catalogs, manifest["pnpm"]);
    fromJson(catalogs, manifest);
  } catch {
    // No readable root manifest.
  }
  return catalogs;
}

/**
 * Resolves a pin through the catalogs: `catalog:` is the default catalog,
 * `catalog:<name>` a named one. Any other pin, and a catalog entry that is
 * not there, comes back as given (and a non-registry pin stays a blocker).
 */
export function catalogResolver(repo: string): (name: string, version: string) => string {
  let catalogs: Catalogs | null = null;
  return (name, version) => {
    if (!version.startsWith("catalog:")) return version;
    catalogs ??= workspaceCatalogs(repo);
    const group = version.slice("catalog:".length).trim() || DEFAULT;
    return catalogs.get(group)?.get(name) ?? version;
  };
}
