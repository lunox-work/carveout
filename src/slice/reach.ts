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
 * Two options move the cut from the hop count to the package: with
 * `wholePackage`, every file of the entry points' package the walk reaches
 * comes along at any depth, so a sibling module is copied, never stubbed;
 * and a test brought along by `tests` brings its own helpers (the fakes and
 * builders it imports from its package, or from a test folder anywhere),
 * since a stub in a fake's place fails the test before any change is made
 * (E6c: 44% of the tests failing on a fresh cut reached such a stub). A
 * file the owner marks `private` is never entered, wherever it is reached:
 * it is cut and stubbed like a module past the budget.
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
   * Of the included files, the helpers the tests brought along: what a
   * test imports at runtime from its own package, or from a test folder,
   * that the slice did not already hold. Sorted.
   */
  readonly helpers: readonly string[];
  /** Files the walk reached and kept out as private, sorted; each is a cut. */
  readonly privateFiles: readonly string[];
  /** Of the included files, the pure code copied rather than mocked, sorted. */
  readonly pure: readonly string[];
  /**
   * Tests of the slice left behind, sorted: they run on neither `node:test`
   * nor Vitest, or make an import no slice can carry (a computed dynamic
   * import, one that resolves to nothing, a path read of no file).
   */
  readonly untestable: readonly string[];
  /**
   * Every test that runs the slice's code, directly or through a chain of
   * barrels, that the folder does not hold, with the reason; sorted. A
   * change these tests would catch passes in the folder unseen.
   */
  readonly testsLeft: readonly SliceTestLeft[];
  /** Of the tests, those on Vitest's globals, which import no runner. */
  readonly globalsTests: readonly string[];
  /** Barrels outside the slice that forward names from it, sorted. */
  readonly barrels: readonly string[];
  /** Why each included file is in the slice. */
  readonly originOf: Readonly<Record<string, SliceOrigin>>;
}

/**
 * Why a file is in the slice: an entry point, reached within the depth,
 * brought by `wholePackage`, a test, a barrel a test imports through, a
 * test's helper, code of the package the tests run (`wholePackage` after
 * the tests), or pure code copied rather than mocked.
 */
export type SliceOrigin =
  | "entry"
  | "walk"
  | "package"
  | "test"
  | "barrel"
  | "helper"
  | "test-code"
  | "pure";

/**
 * A test that runs the slice's code and is not in the folder: it was not
 * asked for (`tests` off), it tests another package, it runs on no runner
 * a slice runs (Jest, say), it reads what no slice carries, or the budget
 * ran out.
 */
export interface SliceTestLeft {
  readonly file: string;
  readonly reason: "not-asked" | "other-package" | "runner" | "unreadable" | "budget";
}

export interface ReachOptions {
  /**
   * Also include each test file outside the slice that imports it, directly
   * or through a barrel that re-exports from it, and runs on `node:test` or
   * Vitest. Such a barrel comes along too, its other re-exports cut. Tests
   * and barrels count against the file budget.
   */
  readonly tests?: boolean;
  /**
   * The package folder a file belongs to (`""` for the root), for
   * `wholePackage` and for a test's helpers. Every file is in one package
   * without it.
   */
  readonly packageOf?: (file: string) => string;
  /**
   * Follow the entry points' package past the depth: every file of it the
   * included files import at runtime (or read by path) comes along, tests
   * apart, while the file budget lasts. Imports into other packages still
   * stop at the depth.
   */
  readonly wholePackage?: boolean;
  /** Files never entered: cut and stubbed wherever the walk reaches them. */
  readonly isPrivate?: (file: string) => boolean;
  /**
   * The runner of a test file, from its path and the bare specifiers it
   * imports; `testRunnerOf` without it, which knows only a runner imported.
   */
  readonly runnerOf?: (file: string, specifiers: readonly string[]) => TestRunner | null;
  /**
   * Copy pure code rather than mock it: a module the slice imports at
   * runtime from outside comes along, past the depth, when every module
   * its runtime imports reach outside the slice is pure. A mock of a
   * validator, an error class or a formatter answers with more mocks, and
   * the slice's tests fail on it before any change (a red baseline); the
   * real code runs the same in the folder as in the repository.
   */
  readonly pure?: {
    /** A package a pure module may import: no service, no I/O. */
    readonly package: (specifier: string) => boolean;
    /** Whether the file's own code reads the environment, the disk or the network. */
    readonly sideEffects: (file: string) => boolean;
  };
}

/** `x.test.ts`, `x.spec.tsx`, or anything under `__tests__/`. */
export const TEST_PATH_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERN.test(path);
}

/** A file in a folder of test support: fakes, fixtures, builders. */
export const TEST_SUPPORT_PATH_PATTERN =
  /(^|\/)(test|tests|__tests__|__mocks__|testing|fixtures|test-utils|test_utils|testutils)\//;

export function isTestSupportPath(path: string): boolean {
  return TEST_SUPPORT_PATH_PATTERN.test(path);
}

/**
 * A runner a slice runs tests on: `node:test`, Vitest imported, or Vitest
 * with its globals (`describe`, `it`, `expect` unimported).
 */
export type TestRunner = "node" | "vitest" | "vitest-globals";

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
  const packageOf = options.packageOf ?? (() => "");
  const isPrivate = options.isPrivate ?? (() => false);
  const privateFiles = new Set<string>();
  /** Whether the file is kept out as private, noting that it was reached. */
  const keptOut = (file: string) => {
    if (!isPrivate(file)) return false;
    privateFiles.add(file);
    return true;
  };
  // A Map, not an object: paths are repository data, and a file named
  // `constructor` or `__proto__` would read as already reached through the
  // prototype under `in`.
  const depthOf = new Map<string, number>();
  const originOf = new Map<string, SliceOrigin>();
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
      if (keptOut(file)) return false;
      if (depthOf.size >= maxFiles) {
        dropped.add(file);
        return false;
      }
      depthOf.set(file, depth);
      originOf.set(file, entries.has(file) ? "entry" : "walk");
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
  // The entry points' package in whole: from every included file, each
  // import or path read into that package is followed, at any depth, until
  // the package is exhausted or the budget is. A test comes only with
  // `tests`; another package's file only within the depth. Run again once
  // the tests are in, for the barrel a test imports through and the files
  // the tests reach.
  const packages = new Set([...entries].map(packageOf));
  /** Why each file is in the slice, for `plan`'s account of what it shows. */
  const place = (file: string, at: number, origin: SliceOrigin) => {
    depthOf.set(file, at);
    originOf.set(file, origin);
  };
  /**
   * The names the slice asks of each included file: everything of an entry
   * point or of a module imported whole, else the names its included
   * importers take and the names an included barrel forwards from it. Only
   * a file's re-exports are judged by it: a re-export that supplies none of
   * those names is not followed, so a barrel in the slice does not bring
   * every module it re-exports (its own imports are always followed).
   */
  const demands = (): Map<string, Set<string> | typeof EVERYTHING> => {
    const demand = new Map<string, Set<string> | typeof EVERYTHING>();
    const add = (file: string, names: Iterable<string> | typeof EVERYTHING): boolean => {
      const known = demand.get(file);
      if (known === EVERYTHING) return false;
      if (names === EVERYTHING) {
        demand.set(file, EVERYTHING);
        return true;
      }
      const set = known ?? new Set<string>();
      let grew = known === undefined;
      for (const name of names) {
        if (name === EVERYTHING) {
          demand.set(file, EVERYTHING);
          return true;
        }
        if (!set.has(name)) {
          set.add(name);
          grew = true;
        }
      }
      demand.set(file, set);
      return grew;
    };
    for (const file of entries) if (depthOf.has(file)) add(file, EVERYTHING);
    for (let changed = true; changed; ) {
      changed = false;
      for (const file of depthOf.keys()) {
        const mine = demand.get(file);
        for (const { link, edge } of outgoing.get(file) ?? []) {
          if (link.relation !== "imports" || link.typeOnly || !depthOf.has(edge.to)) continue;
          if (link.forwards === null || (link.names !== null && link.names.length > 0)) {
            if (add(edge.to, link.names ?? EVERYTHING)) changed = true;
          }
          if (link.forwards === null || mine === undefined) continue;
          const passed =
            link.forwards === EVERYTHING
              ? mine
              : link.forwards
                  .filter(([, as]) => mine === EVERYTHING || mine.has(as))
                  .map(([name]) => name);
          if (passed !== EVERYTHING && [...passed].length === 0) continue;
          if (add(edge.to, passed)) changed = true;
        }
      }
    }
    return demand;
  };
  /**
   * The names a link carries into its target for the slice: the link's own
   * names for an import, those of the importer's demand a re-export
   * supplies, or false when a re-export supplies none of them. A file with
   * no demand (reached by path, say) forwards everything, as before.
   */
  const carried = (
    demand: ReadonlyMap<string, Set<string> | typeof EVERYTHING>,
    file: string,
    link: SliceGraphLink,
    to: string,
  ): readonly string[] | null | false => {
    if (link.forwards === null) return link.names;
    if (link.names !== null && link.names.length > 0) return link.names;
    const mine = demand.get(file);
    if (mine === undefined || mine === EVERYTHING)
      return link.forwards === EVERYTHING ? null : link.forwards.map(([name]) => name);
    if (link.forwards === EVERYTHING) {
      const inner = exported(to);
      if (!inner.complete) return null;
      const names = [...mine].filter((name) => inner.names.has(name)).sort(compare);
      return names.length === 0 ? false : names;
    }
    const names = link.forwards.filter(([, as]) => mine.has(as)).map(([name]) => name);
    if (names.includes(EVERYTHING)) return null;
    return names.length === 0 ? false : names.sort(compare);
  };
  // The entry points' package in whole: from every included file, each
  // import or path read into that package is followed, at any depth, until
  // the package is exhausted or the budget is; a re-export only when it
  // supplies a name the slice asks of the barrel. A test comes only with
  // `tests`; another package's file only within the depth. Run again once
  // the tests are in, for the barrel a test imports through and the files
  // the tests reach.
  const closePackage = (origin: SliceOrigin) => {
    if (options.wholePackage !== true || dropped.size > 0) return;
    for (;;) {
      const demand = demands();
      const added: string[] = [];
      for (const file of [...depthOf.keys()].sort(compare)) {
        const at = depthOf.get(file) ?? 0;
        for (const { link, edge } of outgoing.get(file) ?? []) {
          if (link.relation === "references") continue;
          if (depthOf.has(edge.to) || isTestPath(edge.to) || keptOut(edge.to)) continue;
          if (!packages.has(packageOf(edge.to))) continue;
          if (carried(demand, file, link, edge.to) === false) continue;
          if (depthOf.size >= maxFiles) {
            dropped.add(edge.to);
            continue;
          }
          place(edge.to, at + 1, origin);
          added.push(edge.to);
        }
      }
      if (added.length === 0 || dropped.size > 0) return;
    }
  };
  closePackage("package");
  /** The code the tests are chosen for: what the walk and the package gave. */
  const code = new Set(depthOf.keys());
  const codePackages = new Set([...code].map(packageOf));
  /**
   * Barrels outside the slice that forward names from inside it, directly
   * or through another such barrel (`src/index.ts` re-exporting
   * `pricing/index.ts` re-exporting `pricing/weight.ts`), with the names
   * they forward from the slice, the depth of the nearest, the packages of
   * the slice files behind them and the barrels they forward through. A
   * barrel of a barrel is looked for in the slice's own packages: that is
   * where the tests of the slice are, and where the lazy graph looks.
   */
  const barrels = new Map<
    string,
    { depth: number; names: Set<string>; packages: Set<string>; inner: Set<string> }
  >();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [file, outs] of outgoing) {
      if (code.has(file) || isTestPath(file) || isPrivate(file)) continue;
      for (const { link, edge } of outs) {
        if (link.forwards === null || link.typeOnly) continue;
        const direct = code.has(edge.to) ? (depthOf.get(edge.to) ?? 0) : undefined;
        const via = direct === undefined ? barrels.get(edge.to) : undefined;
        if (direct === undefined && via === undefined) continue;
        if (via !== undefined && !codePackages.has(packageOf(file))) continue;
        let names: string[];
        if (direct !== undefined)
          names =
            link.forwards === EVERYTHING
              ? [...exported(edge.to).names]
              : link.forwards.map(([, as]) => as);
        else if (link.forwards === EVERYTHING)
          names = [...(via?.names ?? [])].filter((name) => name !== "default");
        else
          names = link.forwards
            .filter(([name]) => name === EVERYTHING || via?.names.has(name) === true)
            .map(([, as]) => as);
        if (names.length === 0) continue;
        let entry = barrels.get(file);
        if (entry === undefined) {
          entry = { depth: Number.POSITIVE_INFINITY, names: new Set(), packages: new Set(), inner: new Set() };
          barrels.set(file, entry);
          changed = true;
        }
        const before = entry.names.size + entry.packages.size + entry.inner.size;
        const at = direct ?? via?.depth ?? 0;
        if (at < entry.depth) {
          entry.depth = at;
          changed = true;
        }
        for (const name of names) entry.names.add(name);
        if (direct !== undefined) entry.packages.add(packageOf(edge.to));
        else {
          for (const each of via?.packages ?? []) entry.packages.add(each);
          entry.inner.add(edge.to);
        }
        if (entry.names.size + entry.packages.size + entry.inner.size !== before) changed = true;
      }
    }
  }
  /** A barrel and every barrel it forwards the slice's names through. */
  const chainOf = (start: Iterable<string>): string[] => {
    const found = new Set<string>();
    const queue = [...start];
    while (queue.length > 0) {
      const barrel = queue.pop() as string;
      if (found.has(barrel)) continue;
      found.add(barrel);
      queue.push(...(barrels.get(barrel)?.inner ?? []));
    }
    return [...found].sort(compare);
  };
  /**
   * Every test that runs the slice's code: one importing a file of it at
   * runtime, or one of the slice's packages importing a barrel above it
   * for a name the barrel forwards from it. `own` is whether it tests the
   * slice's package rather than another's.
   */
  const exercising = new Map<string, { through: Set<string>; own: boolean }>();
  /** Tests that also reach a file the slice holds neither way. */
  const strays = new Set<string>();
  /**
   * Whether a test's runtime import of a file the slice does not hold is
   * one the test brings along: a file of its own package, or of a test
   * folder anywhere, that is not itself a test and not private.
   */
  const helperOf = (test: string, file: string) =>
    !isTestPath(file) &&
    !keptOut(file) &&
    (packageOf(file) === packageOf(test) || isTestSupportPath(file));
  for (const file of files) {
    if (code.has(file) || !isTestPath(file) || isPrivate(file)) continue;
    const mine = packageOf(file);
    for (const { link, edge } of outgoing.get(file) ?? []) {
      if (
        !code.has(edge.to) &&
        !barrels.has(edge.to) &&
        (link.typeOnly || !helperOf(file, edge.to))
      )
        strays.add(file);
      if (link.relation !== "imports" || link.typeOnly) continue;
      const through = barrels.get(edge.to);
      const entry = exercising.get(file) ?? { through: new Set<string>(), own: false };
      if (code.has(edge.to)) {
        if (packageOf(edge.to) === mine) entry.own = true;
        exercising.set(file, entry);
      } else if (
        through !== undefined &&
        codePackages.has(mine) &&
        (link.names === null || link.names.some((name) => through.names.has(name)))
      ) {
        if (through.packages.has(mine)) {
          entry.own = true;
          entry.through.add(edge.to);
        }
        exercising.set(file, entry);
      }
    }
  }
  const tests: string[] = [];
  const helpers: string[] = [];
  const untestable = new Set<string>();
  const globalsTests: string[] = [];
  /** Tests left on a runner a slice cannot run, not on what they read. */
  const noRunner = new Set<string>();
  const runnerOf =
    options.runnerOf ?? ((_file: string, specifiers: readonly string[]) => testRunnerOf(specifiers));
  if (options.tests === true && dropped.size === 0) {
    for (const [file, { through, own }] of [...exercising].sort(([a], [b]) => compare(a, b))) {
      // A test of the slice is one of its own package: another package's
      // test that imports the slice (through a followed workspace package,
      // say) tests that package, and would bring that package's files
      // along as its helpers.
      if (!own) continue;
      // A test is left behind when it runs on neither runner, or reads a
      // path or an unresolved module no slice can carry. A computed import
      // is not such a read when the slice holds everything else the test
      // reaches: what it names is often a file the test writes itself, and
      // one that does not resolve fails at the baseline, which the verdict
      // discounts (Phase 7, E6c: dropping such a test hid the one check
      // that caught every wrong change). A computed import beside an
      // import of a file outside the slice (a `typeof import` of a root
      // script, say) still leaves the test behind: that file is not cut.
      const reads = dependencyEdges.get(file) ?? [];
      const runner = runnerOf(file, packagesOf.get(file) ?? []);
      if (runner === null) {
        untestable.add(file);
        noRunner.add(file);
        continue;
      }
      if (
        reads.some(
          (dependency) =>
            dependency.status !== "external" && dependency.status !== "dynamic",
        ) ||
        (strays.has(file) && reads.some((dependency) => dependency.status === "dynamic"))
      ) {
        untestable.add(file);
        continue;
      }
      const entering = chainOf(through).filter((barrel) => !depthOf.has(barrel));
      if (depthOf.size + entering.length >= maxFiles) {
        dropped.add(file);
        continue;
      }
      for (const barrel of entering) place(barrel, barrels.get(barrel)?.depth ?? 0, "barrel");
      const nearest = Math.min(
        ...(outgoing.get(file) ?? [])
          .map(({ edge }) => depthOf.get(edge.to))
          .filter((value): value is number => value !== undefined),
      );
      place(file, nearest + 1, "test");
      tests.push(file);
      if (runner === "vitest-globals") globalsTests.push(file);
      // The test's own helpers, and theirs, while the budget lasts: a fake
      // the test imports is copied, not stubbed, or the test fails on the
      // stub before any change is made.
      let frontier = [file];
      let at = nearest + 1;
      while (frontier.length > 0) {
        at += 1;
        const next: string[] = [];
        for (const from of frontier)
          for (const { link, edge } of outgoing.get(from) ?? []) {
            if (link.relation === "references" || link.typeOnly) continue;
            if (depthOf.has(edge.to) || !helperOf(file, edge.to)) continue;
            if (depthOf.size >= maxFiles) {
              dropped.add(edge.to);
              continue;
            }
            place(edge.to, at, "helper");
            helpers.push(edge.to);
            next.push(edge.to);
          }
        frontier = next.sort(compare);
      }
    }
    closePackage("test-code");
  }
  /** The tests of the slice's code the folder does not carry, and why. */
  const testsLeft: SliceTestLeft[] = [];
  for (const [file, { own }] of [...exercising].sort(([a], [b]) => compare(a, b))) {
    if (depthOf.has(file)) continue;
    testsLeft.push({
      file,
      reason: !own
        ? "other-package"
        : options.tests !== true
          ? "not-asked"
          : noRunner.has(file)
            ? "runner"
            : untestable.has(file)
              ? "unreadable"
              : "budget",
    });
  }
  // Pure code the slice runs, copied rather than mocked, while the budget
  // lasts. A module comes with its runtime closure outside the slice, or
  // not at all: one impure module in it (a driver, an environment read, a
  // private file) leaves the whole of it a stub, as before. A barrel in the
  // slice brings only the modules that supply the names asked of it.
  const pure: string[] = [];
  const pureOptions = options.pure;
  if (pureOptions !== undefined && dropped.size === 0) {
    const verdicts = new Map<string, boolean>();
    const own = (file: string): boolean => {
      const known = verdicts.get(file);
      if (known !== undefined) return known;
      const verdict =
        /\.[cm]?tsx?$/.test(file) &&
        !/\.d\.[cm]?ts$/.test(file) &&
        !isTestPath(file) &&
        !isPrivate(file) &&
        !pureOptions.sideEffects(file) &&
        (dependencyEdges.get(file) ?? []).every(
          (dependency) =>
            dependency.status === "external" &&
            dependency.specifier !== null &&
            pureOptions.package(dependency.specifier),
        ) &&
        (outgoing.get(file) ?? []).every(({ link }) => link.relation !== "reads");
      verdicts.set(file, verdict);
      return verdict;
    };
    /**
     * What copying the names a link takes from `start` brings along: the
     * module, when the slice needs its own code, with everything its code
     * imports; for a barrel, only the re-exports that supply the names, its
     * others left cut as the walk leaves them. Null when any of it is
     * impure. `names` null is the whole module.
     */
    const closureOf = (start: string, names: readonly string[] | null): string[] | null => {
      const found = new Set<string>();
      const visited = new Set<string>();
      const queue: [string, readonly string[] | null][] = [[start, names]];
      while (queue.length > 0) {
        const [file, wanted] = queue.pop() as [string, readonly string[] | null];
        if (depthOf.has(file)) continue;
        const key = `${file}\n${wanted === null ? "*" : [...wanted].sort(compare).join(",")}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (!own(file)) return null;
        found.add(file);
        const declared = exportsOf.get(file) ?? null;
        const ownCode =
          wanted === null ||
          declared === null ||
          wanted.some((name) => declared.values.includes(name) || name === "default");
        for (const { link, edge } of outgoing.get(file) ?? []) {
          if (link.relation !== "imports" || link.typeOnly) continue;
          if (link.forwards === null) {
            if (ownCode) queue.push([edge.to, link.names]);
          } else if (link.forwards === EVERYTHING) {
            const supplied =
              wanted === null
                ? null
                : wanted.filter((name) => exported(edge.to).names.has(name));
            if (supplied === null || supplied.length > 0) queue.push([edge.to, supplied]);
          } else
            for (const [name, as] of link.forwards)
              if (wanted === null || wanted.includes(as)) queue.push([edge.to, [name]]);
        }
      }
      return [...found].sort(compare);
    };
    let frontier = [...depthOf.keys()].sort(compare);
    while (frontier.length > 0) {
      const demand = demands();
      const next: string[] = [];
      for (const file of frontier) {
        const at = (depthOf.get(file) ?? 0) + 1;
        for (const { link, edge } of outgoing.get(file) ?? []) {
          if (link.relation !== "imports" || link.typeOnly) continue;
          if (depthOf.has(edge.to) || isTestPath(edge.to) || isPrivate(edge.to)) continue;
          const names = carried(demand, file, link, edge.to);
          if (names === false) continue;
          const closure = closureOf(edge.to, names);
          // Past the budget the module stays a stub: nothing is dropped
          // for code the walk did not need.
          if (closure === null || depthOf.size + closure.length > maxFiles) continue;
          for (const each of closure) {
            place(each, at, "pure");
            pure.push(each);
            next.push(each);
          }
        }
      }
      frontier = next.sort(compare);
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
    helpers: helpers.sort(compare),
    privateFiles: [...privateFiles].sort(compare),
    pure: pure.sort(compare),
    untestable: [...untestable].sort(compare),
    testsLeft,
    globalsTests: globalsTests.sort(compare),
    barrels: [...barrels.keys()].sort(compare),
    originOf: Object.fromEntries(
      included.map((file) => [file, originOf.get(file) ?? "walk"] as const),
    ),
  };
}
