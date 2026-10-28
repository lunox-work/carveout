/**
 * The bounded walk that proposes a slice.
 *
 * Starting from the entry points, files are reached over the dependency
 * relations graphify records, breadth first, until the budget is spent:
 * `maxDepth` edges from the nearest entry point, `maxFiles` files in all.
 * Everything reached inside the budget is _included_; every dependency
 * edge that leaves the included set is a _cut_, outbound where the slice
 * needs something outside and inbound where outside code needs the slice.
 *
 * Pure and deterministic: nodes are visited in path order within a level,
 * so the same graph, entry points and budget give the same slice however
 * the graph file ordered its arrays. The budget bounds the proposal; it
 * does not prove the slice closed. Imports the compiler could not resolve
 * and dynamic imports are reported as dependencies for the caller to turn
 * into blockers, never dropped.
 */

import type { SliceBudget } from "./analysis.js";
import { fileOf } from "./graph.js";
import type { SliceGraph, SliceGraphNode } from "./graph.js";

/** Relations the walk follows. `contains` (file → symbol) never is. */
export const TRAVERSED_RELATIONS: readonly string[] = [
  "imports",
  "imports_from",
  "calls",
  "inherits",
  "uses",
];

export function isTraversed(relation: string): boolean {
  return TRAVERSED_RELATIONS.includes(relation) || relation.startsWith("uses_");
}

/** One dependency edge between two repository files. */
export interface CutEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly specifier: string | null;
  readonly location: string | null;
  /** The target symbol's label when the edge ends on a symbol, else null. */
  readonly targetSymbol: string | null;
}

/** An import from an included file that resolves to no repository file. */
export interface SliceDependency {
  readonly file: string;
  /** The import text; null for a dynamic import of a computed name. */
  readonly specifier: string | null;
  readonly status: "external" | "unresolved" | "dynamic";
  readonly location: string | null;
}

export interface ReachResult {
  /** Entry points resolved to files, sorted. */
  readonly entries: readonly string[];
  /** Entry points naming nothing in the graph, in the order given. */
  readonly unknownEntryPoints: readonly string[];
  /** Files inside the budget, sorted by path. */
  readonly included: readonly string[];
  /** Edges from the nearest entry point, per included file. */
  readonly depthOf: Readonly<Record<string, number>>;
  readonly cuts: {
    readonly outbound: readonly CutEdge[];
    readonly inbound: readonly CutEdge[];
  };
  /**
   * Import edges between included files that carry the specifier the
   * source wrote, sorted. A generated project resolves its imports with
   * these and the outbound cuts, so a path alias or a moved file can be
   * rewritten without the source's compiler configuration.
   */
  readonly internal: readonly CutEdge[];
  readonly dependencies: readonly SliceDependency[];
  /** Communities of the included files and their symbols, sorted. */
  readonly communities: readonly number[];
}

export interface ReachOptions {
  readonly includeInferred?: boolean;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const edgeKey = (edge: CutEdge) =>
  `${edge.from}\n${edge.to}\n${edge.relation}\n${edge.specifier ?? ""}\n${edge.location ?? ""}\n${edge.targetSymbol ?? ""}`;
const dependencyKey = (dependency: SliceDependency) =>
  `${dependency.file}\n${dependency.specifier ?? ""}\n${dependency.status}\n${dependency.location ?? ""}`;

/**
 * Resolves one entry point: a node id, a file path, or a directory whose
 * files all become entries. Unknown entries are reported, not guessed.
 */
function resolveEntry(
  entry: string,
  byId: ReadonlyMap<string, SliceGraphNode>,
  files: ReadonlySet<string>,
): string[] {
  const node = byId.get(entry);
  if (node !== undefined) {
    const file = fileOf(node);
    return file === null ? [] : [file];
  }
  // Scans rather than /^\/+|\/+$/, which backtracks quadratically on a long
  // run of slashes that does not end the string.
  let start = 0;
  let end = entry.length;
  while (start < end && entry[start] === "/") start += 1;
  while (end > start && entry[end - 1] === "/") end -= 1;
  const path = entry.slice(start, end);
  if (path === "") return [];
  if (files.has(path)) return [path];
  const prefix = `${path}/`;
  return [...files].filter((file) => file.startsWith(prefix)).sort(compare);
}

export function reach(
  graph: SliceGraph,
  entryPoints: readonly string[],
  budget: SliceBudget,
  options: ReachOptions = {},
): ReachResult {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const files = new Set<string>();
  for (const node of graph.nodes) {
    const file = fileOf(node);
    if (file !== null) files.add(file);
  }
  const outgoing = new Map<string, CutEdge[]>();
  const incoming = new Map<string, CutEdge[]>();
  const dependencyEdges = new Map<string, SliceDependency[]>();
  for (const link of graph.links) {
    if (!isTraversed(link.relation)) continue;
    if (link.confidence !== "EXTRACTED" && options.includeInferred !== true)
      continue;
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    if (source === undefined || target === undefined) continue;
    const from = fileOf(source);
    if (from === null) continue;
    if (target.kind === "dependency") {
      const list = dependencyEdges.get(from) ?? [];
      list.push({
        file: from,
        specifier: link.specifier,
        status:
          link.specifier === null
            ? "dynamic"
            : target.dependencyStatus === "external"
              ? "external"
              : "unresolved",
        location: link.location,
      });
      dependencyEdges.set(from, list);
      continue;
    }
    const to = fileOf(target);
    if (to === null || to === from) continue;
    const edge: CutEdge = {
      from,
      to,
      relation: link.relation,
      specifier: link.specifier,
      location: link.location,
      targetSymbol: target.kind === "symbol" ? target.label : null,
    };
    const out = outgoing.get(from);
    if (out === undefined) outgoing.set(from, [edge]);
    else out.push(edge);
    const into = incoming.get(to);
    if (into === undefined) incoming.set(to, [edge]);
    else into.push(edge);
  }
  const entries = new Set<string>();
  const unknownEntryPoints: string[] = [];
  for (const entry of entryPoints) {
    const resolved = resolveEntry(entry, byId, files);
    if (resolved.length === 0) unknownEntryPoints.push(entry);
    for (const file of resolved) entries.add(file);
  }
  const maxFiles = Math.max(0, Math.floor(budget.maxFiles));
  const maxDepth = Math.max(0, Math.floor(budget.maxDepth));
  // A Map, not an object: paths are repository data, and a file named
  // `constructor` or `__proto__` would read as already reached through the
  // prototype under `in`. The size is kept by the Map rather than recounted
  // per file.
  const depthOf = new Map<string, number>();
  let level = [...entries].sort(compare);
  let depth = 0;
  while (level.length > 0 && depth <= maxDepth) {
    const next = new Set<string>();
    for (const file of level) {
      if (depthOf.has(file)) continue;
      if (depthOf.size >= maxFiles) break;
      depthOf.set(file, depth);
      for (const edge of outgoing.get(file) ?? [])
        if (!depthOf.has(edge.to)) next.add(edge.to);
    }
    level = [...next].filter((file) => !depthOf.has(file)).sort(compare);
    depth++;
  }
  const included = [...depthOf.keys()].sort(compare);
  const inside = new Set(included);
  const outbound = new Map<string, CutEdge>();
  const inbound = new Map<string, CutEdge>();
  const internal = new Map<string, CutEdge>();
  for (const file of included) {
    for (const edge of outgoing.get(file) ?? [])
      if (!inside.has(edge.to)) outbound.set(edgeKey(edge), edge);
      else if (edge.specifier !== null) internal.set(edgeKey(edge), edge);
    for (const edge of incoming.get(file) ?? [])
      if (!inside.has(edge.from)) inbound.set(edgeKey(edge), edge);
  }
  const dependencies = new Map<string, SliceDependency>();
  for (const file of included)
    for (const dependency of dependencyEdges.get(file) ?? [])
      dependencies.set(dependencyKey(dependency), dependency);
  const communities = new Set<number>();
  for (const node of graph.nodes) {
    const file = fileOf(node);
    if (file !== null && inside.has(file) && node.community !== null)
      communities.add(node.community);
  }
  const sortEdges = (edges: Iterable<CutEdge>) =>
    [...edges].sort((a, b) => compare(edgeKey(a), edgeKey(b)));
  return {
    entries: [...entries].sort(compare),
    unknownEntryPoints,
    included,
    // `fromEntries` defines own properties, so even `__proto__` is a key.
    depthOf: Object.fromEntries(depthOf),
    cuts: {
      outbound: sortEdges(outbound.values()),
      inbound: sortEdges(inbound.values()),
    },
    internal: sortEdges(internal.values()),
    dependencies: [...dependencies.values()].sort((a, b) =>
      compare(dependencyKey(a), dependencyKey(b)),
    ),
    communities: [...communities].sort((a, b) => a - b),
  };
}
