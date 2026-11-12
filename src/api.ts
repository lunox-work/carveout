/**
 * The library entry, `carveout/api`: plan, cut and patch for a platform
 * that keeps the receipt itself, on the code paths the CLI runs
 * (`planSlice`, `cutSlice`, `patchProject` in `carve.ts`).
 *
 * What it holds to: it never starts Docker or any container, never runs
 * the folder's code (no install, build or test of it; `check` and `merge`
 * are not here), and never reads or writes `CARVEOUT_HOME` (`~/.carveout`):
 * the receipt goes out of `cut` and into `patch` as data. What it may run
 * is Git, read-only, on the repository (its commit and files) and, for a
 * patch with edits, in a scratch repository of its own; and, only for a
 * `cut` that is not `offline`, npm with scripts off to fetch package types
 * (into `typesCache`, else a temporary folder) and to resolve the folder's
 * lockfile. `test/api.test.ts` holds it to that with `child_process` made
 * to throw.
 *
 * `walk` returns the walk `plan` and `cut` make, whole, for a platform
 * that generates its own stubs and project from it. `analyse` goes on from
 * the walk to what `cut` writes the folder from (manifest, contract, stubs,
 * surface), and runs no process at all, Git included; `importGraph` builds
 * the graph once for many analyses.
 *
 * The extractor and the fixture compile are `carveout/extract`
 * (`extract.ts`); the alias table, the vocabulary scan, the draft, carry-back
 * and the mock runtime's text, pure, are `carveout/pseudonyms`
 * (`pseudonyms.ts`).
 *
 * Also exported: the policy's text checks (`integrityOf`,
 * `gainedIntegrity`, `weakenedTest`) and the slice and project modules
 * `core.ts` gathers, forked from sandbox-factory's core.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { ReachResult } from "./slice/reach.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cutSlice,
  patchProject,
  planBlockers,
  planSlice,
  sliceInputOf,
  type CarveoutRecord,
  type Patch,
  type PlanSurface,
} from "./carve.js";
import { CutError, analyseSlice, type CutErrorCode, type SliceAnalysis } from "./cut.js";
import type { PackageTypesFetcher } from "./extract/package-types.js";
import { buildGraph, listFiles, walkGraph } from "./graph.js";
import {
  SLICE_BUDGET_DEFAULTS,
  TEST_LEFT_REASON,
  testsVerdict,
  type CutEdge,
  type SliceExposure,
  type SliceExternals,
  type SliceOrigin,
  type SliceGraph,
  type SliceTestLeft,
  type TestRunner,
} from "./core.js";
import type { Readiness } from "./readiness.js";
import type { Receipt } from "./receipt.js";

export * from "./core.js";
export { gainedIntegrity, integrityOf, weakenedTest, type Refusal } from "./policy.js";
export type { CarveoutRecord, Patch, PlanSurface, Readiness, Receipt };
export type { ReachResult, PackageTypesFetcher };
export { CutError, type CutErrorCode };

/** The walk's bounds, as `carveout plan` and `cut` take them. */
export interface WalkOptions {
  /** The repository's checkout root. */
  readonly root: string;
  /** Files or folders, relative to the root. */
  readonly entries: readonly string[];
  /** Import depth from the entries (`--depth`, default 3). */
  readonly depth?: number;
  /** Most files the folder holds (`--max-files`, default 40). */
  readonly maxFiles?: number;
  /** Bring the tests outside the slice that import it (`--with-tests`). */
  readonly withTests?: boolean;
  /** Copy the pure code the slice runs rather than mock it (`--copy-pure`). */
  readonly copyPure?: boolean;
}

/** What a cut of the entries would hold; nothing is written. */
export interface PlanResult {
  readonly root: string;
  readonly entries: readonly string[];
  /** Entries that name no script file of the repository. */
  readonly unknownEntries: readonly string[];
  readonly budget: { readonly maxFiles: number; readonly maxDepth: number };
  /** The files the folder would copy, sorted, with why each is there and its depth. */
  readonly included: readonly string[];
  readonly originOf: Readonly<Record<string, SliceOrigin>>;
  readonly depthOf: Readonly<Record<string, number>>;
  /** Files the walk reached past the file budget: cut instead. */
  readonly dropped: readonly string[];
  /** Pure code copied rather than mocked (`copyPure`). */
  readonly pure: readonly string[];
  /** Cut modules (each a stub and a mock), those imported for types only, and every import that crosses out. */
  readonly cuts: {
    readonly modules: readonly string[];
    readonly typeOnly: readonly string[];
    readonly outbound: readonly CutEdge[];
  };
  /** The slice's modules code outside it imports: the names taken and the importers. */
  readonly surface: readonly PlanSurface[];
  /** Tests of the slice: carried, each with its runner; left in the repository, each with the reason. */
  readonly tests: {
    readonly verdict: string;
    readonly carried: readonly { readonly file: string; readonly runner: TestRunner }[];
    readonly helpers: readonly string[];
    readonly left: readonly (SliceTestLeft & { readonly why: string })[];
  };
  /** Bare packages the slice imports, and of those the repository's own workspaces. */
  readonly packages: readonly string[];
  readonly workspacePackages: readonly string[];
  /** Services and environment the slice reads. */
  readonly externals: SliceExternals;
  /** What the folder would show of the repository, by origin. */
  readonly exposure: SliceExposure;
  /** What stops the cut, one line each, as `carveout plan` prints them. */
  readonly blockers: readonly string[];
}

const budgetOf = (options: WalkOptions) => ({
  maxFiles: options.maxFiles ?? SLICE_BUDGET_DEFAULTS.maxFiles,
  maxDepth: options.depth ?? SLICE_BUDGET_DEFAULTS.maxDepth,
});

/** The walk's options as `SliceRequest` fields; unset ones are left to the repository's `carveout.config.json`. */
const requestOf = (options: WalkOptions) => ({
  repo: options.root,
  entryPoints: options.entries,
  budget: budgetOf(options),
  ...(options.withTests === undefined ? {} : { tests: options.withTests }),
  ...(options.copyPure === undefined ? {} : { copyPure: options.copyPure }),
});

/** `carveout plan`: the files, cuts, public surface and tests of a cut, from the import graph. Writes nothing. */
export function plan(options: WalkOptions): PlanResult {
  const planned = planSlice(requestOf(options));
  const { walk } = planned;
  return {
    root: planned.repo,
    entries: planned.entryPoints,
    unknownEntries: walk.unknownEntryPoints,
    budget: planned.budget,
    included: walk.included,
    originOf: walk.originOf,
    depthOf: walk.depthOf,
    dropped: walk.dropped,
    pure: walk.pure,
    cuts: { modules: planned.cutModules, typeOnly: planned.typeOnlyCuts, outbound: walk.cuts.outbound },
    surface: planned.surface,
    tests: {
      verdict: testsVerdict(walk),
      carried: walk.tests.flatMap((file) => {
        const runner = planned.testRunners[file];
        return runner === undefined ? [] : [{ file, runner }];
      }),
      helpers: walk.helpers,
      left: walk.testsLeft.map((left) => ({ ...left, why: TEST_LEFT_REASON[left.reason] })),
    },
    packages: planned.packages,
    workspacePackages: planned.workspacePackages,
    externals: planned.externals,
    exposure: planned.exposure,
    blockers: planBlockers(planned),
  };
}

/**
 * The walk itself, as `plan` and `cut` make it: the included files with
 * their depths, every edge that crosses the slice's edge in either
 * direction, the links inside it with the specifiers the source wrote,
 * the imports that resolve to no file, and the tests, helpers, private and
 * pure files it carried. For a platform that generates its own stubs and
 * project from the walk (sandbox-factory's slice tool). Writes nothing.
 */
export function walk(options: WalkOptions): ReachResult {
  return planSlice(requestOf(options)).walk;
}

export interface CutOptions extends WalkOptions {
  /** An empty or new folder, outside the repository. */
  readonly out: string;
  /**
   * No network: no package types fetched and no lockfile resolved, so
   * nothing but Git is run. Off: npm, scripts off, does both.
   */
  readonly offline?: boolean;
  /**
   * A folder for someone outside (`--public`): literals widened and the
   * repository's names in pseudonyms under the receipt's table. Off here
   * whatever `carveout.config.json` says, for a caller with its own names.
   */
  readonly public?: boolean;
  /** Where fetched package types are kept between cuts; a temporary folder, removed after, by default. */
  readonly typesCache?: string;
  /** The cut's progress lines. */
  readonly log?: (line: string) => void;
}

export interface CutOutput {
  /** The folder, absolute. */
  readonly out: string;
  /** What the folder's `carveout.json` holds. */
  readonly record: CarveoutRecord;
  /** Whether it is written without blockers. */
  readonly ready: boolean;
  readonly blockers: CarveoutRecord["blockers"];
  /** The maintainer's receipt, as data: keep it private, and give it to `patch`. Written nowhere. */
  readonly receipt: Receipt;
  /** What would make the folder's tests run on real code. */
  readonly readiness: Readiness;
}

/**
 * `carveout cut`: writes the folder and its `carveout.json` as the CLI
 * does, and returns the receipt as data instead of writing it under
 * `~/.carveout/receipts/`.
 */
export async function cut(options: CutOptions): Promise<CutOutput> {
  const offline = options.offline === true;
  const types = offline || options.typesCache !== undefined ? null : mkdtempSync(join(tmpdir(), "carveout-types-"));
  try {
    const result = await cutSlice({
      ...requestOf(options),
      out: options.out,
      offline,
      public: options.public ?? false,
      receiptInMemory: true,
      ...(options.typesCache !== undefined ? { typesCache: options.typesCache } : types === null ? {} : { typesCache: types }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    const receipt = result.receiptData;
    if (receipt === null) throw new Error("The cut kept no receipt.");
    return {
      out: result.out,
      record: receipt.folderRecord ?? receipt.record,
      ready: result.record.ready,
      blockers: result.record.blockers,
      receipt,
      readiness: result.readiness,
    };
  } finally {
    if (types !== null) rmSync(types, { recursive: true, force: true });
  }
}

export interface PatchInput {
  /** The receipt `cut` returned for this folder. */
  readonly receipt: Receipt;
  /** The folder as it came back. */
  readonly folder: string;
  /** The repository's checkout; by default the one the receipt names. It must hold the cut's commit. */
  readonly repo?: string;
  /** Paths and globs the hand-off policy lets through (`--allow`). */
  readonly allow?: readonly string[];
}

/**
 * `carveout patch`: the folder's edits as a patch for the repository, its
 * imports and names put back, with what the hand-off policy keeps out in
 * `refused` (the CLI's exit 6) and what reaches past the slice in
 * `boundary` (exit 5). Judged by the receipt given, never by the folder's
 * own record; runs nothing from the folder.
 */
export function patch(input: PatchInput): Promise<Patch> {
  return patchProject(input.folder, {
    receiptData: input.receipt,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.allow === undefined ? {} : { allow: input.allow }),
  });
}

/**
 * The import graph of a whole checkout, read once, for many `analyse`
 * calls on it (`AnalyseOptions.graph`). It does not depend on the entries;
 * it does on whether imports of the repository's own packages are followed
 * into their source, which `copyPure` and the repository's
 * `carveout.config.json` decide, as they do for the analyses: build it with
 * the same `copyPure` they take. Runs no process: the files are every file
 * under the root outside the folders a graph ignores, or `files`.
 */
export function importGraph(
  root: string,
  options: { readonly copyPure?: boolean; readonly files?: readonly string[] } = {},
): SliceGraph {
  const { repo, settled } = sliceInputOf({
    repo: root,
    entryPoints: [],
    ...(options.copyPure === undefined ? {} : { copyPure: options.copyPure }),
  });
  return buildGraph(repo, options.files ?? listFiles(repo, { git: false }), {
    followWorkspaces: settled.followWorkspaces,
  }).graph;
}

export interface AnalyseOptions extends WalkOptions {
  /** The commit the root is a checkout of, stamped into the manifest and the contract; Git is not asked. */
  readonly commitSha: string | null;
  /** Whether an included file differs from that commit; by default none does. */
  readonly isDirty?: (paths: readonly string[]) => boolean;
  /**
   * Fetches the types of the public packages the slice reads (`npmPackageTypes`
   * from `carveout/extract`, or the caller's own). Absent: every package is
   * untyped and nothing is fetched or run.
   */
  readonly packageTypes?: PackageTypesFetcher;
  /** Widen literal values in the stubs to their types; default true (the CLI's default is off but for `--public`). */
  readonly widenLiterals?: boolean;
  /** `omit`: a file read by path blocks nothing (see `analyseSlice`); default `block`, as the CLI. */
  readonly pathReads?: "block" | "omit";
  /** The externals of the included files when the caller has them all; null to read them here. */
  readonly externalsOf?: (included: readonly string[]) => SliceExternals | null;
  /** The checkout's files; by default every file under the root outside the folders a graph ignores. */
  readonly files?: readonly string[];
  /**
   * A graph from `importGraph`, reused across analyses. Without it the graph
   * is read lazily, as `cut` reads it, from the entries outward; the walk is
   * the same, but the manifest's `graphSha256` is of the graph used.
   */
  readonly graph?: SliceGraph;
  readonly signal?: AbortSignal;
  /** The analysis's progress lines. */
  readonly log?: (line: string) => void;
}

/**
 * What `cut` writes a folder from: the manifest, the boundary contract (and
 * its canonical JSON), the stubs, the public surface's check, whether it is
 * ready, how it stands with noImplicitAny, and the walk.
 */
export type Analysis = SliceAnalysis;

/**
 * The analysis `cut` makes before it writes anything, on the same code
 * path and with the same request after `carveout.config.json`, for a
 * platform that writes its own folder: on the same checkout, its manifest
 * and contract are the cut's, but for the commit and dirty fields, which
 * are the caller's here. It runs no process (no Git, no npm unless the
 * `packageTypes` given does) and writes nothing. Throws a `CutError` when
 * no slice can be made at all.
 */
export function analyse(options: AnalyseOptions): Promise<Analysis> {
  const { repo, entryPoints, budget, walk: walkOptions, params } = sliceInputOf(requestOf(options));
  const graph =
    options.graph ??
    walkGraph(repo, entryPoints, budget, {
      ...walkOptions,
      files: options.files ?? listFiles(repo, { git: false }),
    }).built.graph;
  return analyseSlice({
    sourceDir: repo,
    graph,
    params,
    source: { commitSha: options.commitSha, isDirty: options.isDirty ?? (() => false) },
    signal: options.signal ?? new AbortController().signal,
    log: options.log ?? (() => {}),
    widenLiterals: options.widenLiterals ?? true,
    ...(options.packageTypes === undefined ? {} : { packageTypes: options.packageTypes }),
    ...(options.pathReads === undefined ? {} : { pathReads: options.pathReads }),
    ...(options.externalsOf === undefined ? {} : { externalsOf: options.externalsOf }),
  });
}
