/**
 * The bounded walk that proposes a slice.
 *
 * Starting from the entry points, the walk follows what a file's own code
 * imports, breadth first, until the budget is spent: `maxDepth` imports
 * from the nearest entry point, `maxFiles` files in all. Everything reached
 * inside the budget is _included_; every link that leaves the included set
 * is a _cut_, outbound where the slice needs something outside and inbound
 * where outside code needs the slice.
 *
 * It follows names, not whole files. An import of `a` from a barrel
 * includes the barrel and, through its re-exports, only the module that
 * declares `a`, at the barrel's depth: a re-export is not an import of the
 * barrel's own code. An import of types only (`import type`, or names the
 * target declares as interfaces or type aliases) is erased at runtime, so
 * its module is cut and stubbed, never copied. A module named to a test
 * runner (`vi.mock`) is never followed either; a file read by path is.
 *
 * Pure and deterministic: states are visited in path order within a level,
 * so the same graph, entry points and budget give the same slice however
 * the graph ordered its arrays. The budget bounds the proposal; it does not
 * prove the slice closed. Imports the compiler could not resolve and
 * dynamic imports are reported as dependencies for the caller to turn into
 * blockers, never dropped.
 */

import type { SliceBudget } from "./analysis.js";
import { fileOf } from "./graph.js";
import type {
  SliceGraph,
  SliceGraphLink,
  SliceGraphNode,
  SliceRelation,
} from "./graph.js";

/** One link between two repository files. */
export interface CutEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: SliceRelation;
  readonly specifier: string | null;
  readonly location: string | null;
  /** Erased at runtime: the stub alone serves it. */
  readonly typeOnly: boolean;
}

/** An import from an included file that resolves to no repository file. */
export interface SliceDependency {
  readonly file: string;
  /** The import text; for a path read, the path from the repository's
   * root; null for a dynamic import of a computed name. */
  readonly specifier: string | null;
  /** `path`: a literal path read at runtime that names no file a slice
   * can copy (a folder, a file of another kind). */
  readonly status: "external" | "unresolved" | "dynamic" | "path";
  readonly location: string | null;
}

export interface ReachResult {
  /** Entry points resolved to files, sorted. */
  readonly entries: readonly string[];
  /** Entry points naming nothing in the graph, in the order given. */
  readonly unknownEntryPoints: readonly string[];
  /** Files inside the budget, sorted by path. */
  readonly included: readonly string[];
  /** Imports from the nearest entry point, per included file. */
  readonly depthOf: Readonly<Record<string, number>>;
  /**
   * Files the walk reached within the depth that did not fit the file
   * budget, sorted. They are cut like any module past the budget.
   */
  readonly dropped: readonly string[];
  readonly cuts: {
    readonly outbound: readonly CutEdge[];
    /** Imports of the slice from outside it; never a `references` or
     * `reads` link. */
    readonly inbound: readonly CutEdge[];
  };
  /**
   * Links between included files that carry the specifier the source
   * wrote, sorted. A generated project resolves its imports with these and
   * the outbound cuts, so a path alias or a moved file can be rewritten
   * without the source's compiler configuration.
   */
  readonly internal: readonly CutEdge[];
  readonly dependencies: readonly SliceDependency[];
  /** Of the included files, the tests brought along, sorted. */
  readonly tests: readonly string[];
  /**
   * Tests of the slice left behind because they run on neither `node:test`
   * nor Vitest, sorted.
   */
  readonly untestable: readonly string[];
}

export interface ReachOptions {
  /**
   * Also include each test file outside the slice that imports it and runs
   * on `node:test` or Vitest. Tests count against the file budget.
   */
  readonly tests?: boolean;
}

/** `x.test.ts`, `x.spec.tsx`, or anything under `__tests__/`. */
export function isTestPath(path: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)__tests__\//.test(path)
  );
}

/** The test runner a test file imports, when carveout can run it. */
export function testRunnerOf(specifiers: readonly string[]): "node" | "vitest" | null {
  if (specifiers.some((specifier) => specifier === "node:test")) return "node";
  if (
    specifiers.some(
      (specifier) => specifier === "vitest" || specifier.startsWith("vitest/"),
    )
  )
    return "vitest";
  return null;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const edgeKey = (edge: CutEdge) =>
  `${edge.from}\n${edge.to}\n${edge.relation}\n${edge.specifier ?? ""}\n${edge.location ?? ""}`;
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

/** A link out of a file to another file of the checkout. */
interface Out {
  readonly link: SliceGraphLink;
  readonly edge: CutEdge;
}

/**
 * What the walk asks of a file: `*` all it exports, `#` its own code, or
 * one name it exports. Neither `*` nor `#` can be a name.
 */
type Demand = string;
const EVERYTHING = "*";
const OWN_CODE = "#";

export function reach(
  graph: SliceGraph,
  entryPoints: readonly string[],
  budget: SliceBudget,
  options: ReachOptions = {},
): ReachResult {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const files = new Set<string>();
  const exportsOf = new Map<string, SliceGraphNode["exports"]>();
  for (const node of graph.nodes) {
    const file = fileOf(node);
    if (file === null) continue;
    files.add(file);
    exportsOf.set(file, node.exports);
  }
  const outgoing = new Map<string, Out[]>();
  const incoming = new Map<string, CutEdge[]>();
  const dependencyEdges = new Map<string, SliceDependency[]>();
  /** Files with an `export *` of something not in the checkout. */
  const opaqueStars = new Set<string>();
  /** Bare specifiers each file imports, for its test runner. */
  const packagesOf = new Map<string, string[]>();
  for (const link of graph.links) {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    if (source === undefined || target === undefined) continue;
    const from = fileOf(source);
    if (from === null) continue;
    if (target.kind === "dependency") {
      if (link.forwards === "*") opaqueStars.add(from);
      if (link.specifier !== null) {
        const list = packagesOf.get(from) ?? [];
        list.push(link.specifier);
        packagesOf.set(from, list);
      }
      const list = dependencyEdges.get(from) ?? [];
      list.push({
        file: from,
        // A path read names its target, from the repository's root.
        specifier:
          target.dependencyStatus === "path" ? target.label : link.specifier,
        status:
          target.dependencyStatus === "path"
            ? "path"
            : link.specifier === null
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
      typeOnly: link.typeOnly,
    };
    const out = outgoing.get(from);
    if (out === undefined) outgoing.set(from, [{ link, edge }]);
    else out.push({ link, edge });
    // Outside code that mocks a slice module or reads it by path takes
    // nothing from it, so it adds nothing to the slice's public surface.
    if (link.relation !== "imports") continue;
    const into = incoming.get(to);
    if (into === undefined) incoming.set(to, [edge]);
    else into.push(edge);
  }
  for (const list of outgoing.values())
    list.sort((a, b) => compare(edgeKey(a.edge), edgeKey(b.edge)));

  // Every name a module exports, through its re-exports; `complete` is
  // false when an `export *` reaches something the graph cannot read.
  const exportedMemo = new Map<string, { names: Set<string>; complete: boolean }>();
  const exported = (file: string): { names: Set<string>; complete: boolean } => {
    const known = exportedMemo.get(file);
    if (known !== undefined) return known;
    const result = { names: new Set<string>(), complete: true };
    // Set first, so a cycle of `export *` reads what is known so far.
    exportedMemo.set(file, result);
    const own = exportsOf.get(file) ?? null;
    if (own === null) result.complete = false;
    else for (const name of [...own.values, ...own.types]) result.names.add(name);
    if (opaqueStars.has(file)) result.complete = false;
    for (const { link, edge } of outgoing.get(file) ?? []) {
      if (link.forwards === null) continue;
      if (link.forwards === EVERYTHING) {
        const inner = exported(edge.to);
        if (!inner.complete) result.complete = false;
        for (const name of inner.names)
          if (name !== "default") result.names.add(name);
      } else for (const [, as] of link.forwards) result.names.add(as);
    }
    return result;
  };

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
  // prototype under `in`.
  const depthOf = new Map<string, number>();
  const dropped = new Set<string>();
  const seen = new Set<string>();
  const byState = (a: [string, Demand], b: [string, Demand]) =>
    compare(a[0], b[0]) || compare(a[1], b[1]);
  let level: [string, Demand][] = [...entries].map((file) => [file, EVERYTHING]);
  let depth = 0;
  while (level.length > 0 && depth <= maxDepth && dropped.size === 0) {
    const work = level.sort(byState);
    const next: [string, Demand][] = [];
    /** Whether the file is in the slice, adding it while the budget lasts. */
    const enter = (file: string): boolean => {
      if (depthOf.has(file)) return true;
      if (depthOf.size >= maxFiles) {
        dropped.add(file);
        return false;
      }
      depthOf.set(file, depth);
      return true;
    };
    // A re-export forwards a name at the barrel's depth; an import of the
    // file's own code reaches the next depth. Depth 0 is the entry points
    // alone, so an entry barrel's modules are cut there.
    const forward = (link: SliceGraphLink, to: string, name: Demand) => {
      if (!link.typeOnly && maxDepth > 0) work.push([to, name]);
    };
    for (let index = 0; index < work.length; index++) {
      const [file, demand] = work[index] as [string, Demand];
      const key = `${file}\n${demand}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const outs = outgoing.get(file) ?? [];
      if (demand === EVERYTHING) {
        if (!enter(file)) continue;
        work.push([file, OWN_CODE]);
        for (const { link, edge } of outs)
          if (link.forwards === EVERYTHING) forward(link, edge.to, EVERYTHING);
          else if (link.forwards !== null)
            for (const [name] of link.forwards) forward(link, edge.to, name);
      } else if (demand === OWN_CODE) {
        if (!enter(file)) continue;
        for (const { link, edge } of outs) {
          if (link.relation === "references" || link.typeOnly) continue;
          if (link.names === null) next.push([edge.to, EVERYTHING]);
          else for (const name of link.names) next.push([edge.to, name]);
        }
      } else {
        const own = exportsOf.get(file) ?? null;
        if (own === null || own.values.includes(demand)) {
          work.push([file, own === null ? EVERYTHING : OWN_CODE]);
          continue;
        }
        const named = outs.filter(
          ({ link }) =>
            Array.isArray(link.forwards) &&
            link.forwards.some(([, as]) => as === demand),
        );
        if (named.length > 0) {
          if (!enter(file)) continue;
          for (const { link, edge } of named)
            for (const [name, as] of link.forwards as readonly (readonly [string, string])[])
              if (as === demand) forward(link, edge.to, name);
          continue;
        }
        // An interface or a type alias: erased, so nothing is loaded.
        if (own.types.includes(demand)) continue;
        const stars = outs.filter(({ link }) => link.forwards === EVERYTHING);
        const supplying = stars.filter(({ edge }) =>
          exported(edge.to).names.has(demand),
        );
        const unsure = stars.filter(({ edge }) => !exported(edge.to).complete);
        if (supplying.length > 0 || unsure.length > 0 || opaqueStars.has(file)) {
          if (!enter(file)) continue;
          for (const { link, edge } of supplying.length > 0 ? supplying : unsure)
            forward(link, edge.to, demand);
          continue;
        }
        // A name the file does not seem to export: take its own code
        // rather than guess.
        work.push([file, OWN_CODE]);
      }
    }
    level = next;
    depth++;
  }
  const tests: string[] = [];
  const untestable = new Set<string>();
  if (options.tests === true && dropped.size === 0) {
    const reached = [...depthOf.keys()];
    const candidates = new Set<string>();
    for (const file of reached)
      for (const edge of incoming.get(file) ?? [])
        if (!depthOf.has(edge.from) && isTestPath(edge.from))
          candidates.add(edge.from);
    for (const file of [...candidates].sort(compare)) {
      if (testRunnerOf(packagesOf.get(file) ?? []) === null) {
        untestable.add(file);
        continue;
      }
      if (depthOf.size >= maxFiles) {
        dropped.add(file);
        continue;
      }
      const nearest = Math.min(
        ...(outgoing.get(file) ?? [])
          .map(({ edge }) => depthOf.get(edge.to))
          .filter((value): value is number => value !== undefined),
      );
      depthOf.set(file, nearest + 1);
      tests.push(file);
    }
  }
  const included = [...depthOf.keys()].sort(compare);
  const inside = new Set(included);
  const outbound = new Map<string, CutEdge>();
  const inbound = new Map<string, CutEdge>();
  const internal = new Map<string, CutEdge>();
  for (const file of included) {
    for (const { edge } of outgoing.get(file) ?? [])
      if (!inside.has(edge.to)) outbound.set(edgeKey(edge), edge);
      else if (edge.specifier !== null) internal.set(edgeKey(edge), edge);
    for (const edge of incoming.get(file) ?? [])
      if (!inside.has(edge.from)) inbound.set(edgeKey(edge), edge);
  }
  const dependencies = new Map<string, SliceDependency>();
  for (const file of included)
    for (const dependency of dependencyEdges.get(file) ?? [])
      dependencies.set(dependencyKey(dependency), dependency);
  const sortEdges = (edges: Iterable<CutEdge>) =>
    [...edges].sort((a, b) => compare(edgeKey(a), edgeKey(b)));
  return {
    entries: [...entries].sort(compare),
    unknownEntryPoints,
    included,
    // `fromEntries` defines own properties, so even `__proto__` is a key.
    depthOf: Object.fromEntries(depthOf),
    dropped: [...dropped].sort(compare),
    cuts: {
      outbound: sortEdges(outbound.values()),
      inbound: sortEdges(inbound.values()),
    },
    internal: sortEdges(internal.values()),
    dependencies: [...dependencies.values()].sort((a, b) =>
      compare(dependencyKey(a), dependencyKey(b)),
    ),
    tests: tests.sort(compare),
    untestable: [...untestable].sort(compare),
  };
}
