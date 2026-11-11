/**
 * The four things carveout does with a checkout: plan a slice, cut it into
 * a folder, check that the folder installs, builds and tests on its own,
 * and turn the edits made there back into a patch for the checkout.
 *
 * The plan and the cut read the checkout and never run its code. The cut
 * may fetch the published types of the packages the slice reads (install
 * scripts off, the public registry only) and resolves the folder's
 * lockfile with npm; `offline` skips both.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { command } from "./command.js";
import ts from "typescript";
import {
  BASELINE_PATH,
  LAST_RUN_PATH,
  SLICE_BUDGET_DEFAULTS,
  coverageGateOf,
  declarationPath,
  detectExternals,
  purityRules,
  generateProject,
  isScript,
  isSecretPath,
  isTestPath,
  packageNameOf,
  pathMatcher,
  renderBoundaryMarkdown,
  resolveScope,
  runtimePath,
  type BoundaryContract,
  type CoverageGate,
  type DependencyChoice,
  type GeneratedFile,
  type ImportRewrite,
  type ProjectBlocker,
  type ReachResult,
  type ResolvedDependency,
  type SliceBudget,
  type SliceManifest,
  type SliceExternals,
  type SliceExposure,
  type SliceTestLeft,
  exposureOf,
  renderTestsMarkdown,
  testsVerdict,
} from "./core.js";
import { analyseSlice } from "./cut.js";
import { catalogResolver } from "./project/catalog.js";
import { testRunnerResolver } from "./project/runner.js";
import {
  nearestCompilerOptions,
  workspacePackages,
} from "./extract/compiler-config.js";
import { packageModules, packageUses } from "./extract/fixture.js";
import { npmPackageTypes, typesPackageOf } from "./extract/package-types.js";
import { NODE_BUILTINS, isNodeBuiltin } from "./extract/typescript.js";
import { walkGraph } from "./graph.js";
import {
  extensionStyles,
  packageFolder,
  restoreImports,
  specifiersOf,
  undoRewrites,
  type ImportContext,
} from "./imports.js";
import { moduleSpecifiers, parseSource } from "./specifiers.js";
import { scanSecrets, secretBlockers } from "./project/secrets.js";
import { checkRecordPaths, handoffPolicy, trustedRepo, type Refusal } from "./policy.js";

export const CARVEOUT_VERSION = "0.1.1";
export const RECORD_PATH = "carveout.json";
export const RECORD_SCHEMA_VERSION = 1;
/** Blockers that stop a cut before it writes anything. */
const CREDENTIAL_BLOCKERS = new Set(["secret_file", "secret_found"]);
export const BOUNDARY_PATH = "BOUNDARY.md";
/** What a coding agent reads first in the folder, loaded without asking. */
export const SLICE_AGENTS_PATH = "AGENTS.md";
/** Claude Code's name for the same: it imports AGENTS.md. */
export const SLICE_CLAUDE_PATH = "CLAUDE.md";

/**
 * The folder's AGENTS.md: what an agent needs before its first command.
 * Agents in slices opened BOUNDARY.md and carveout/test.js in most runs,
 * and the README, which says this, in under half (E6c and E8 transcripts):
 * a file the agent's harness loads by itself saves those reads.
 */
export function renderSliceAgents(input: {
  readonly entryPoints: readonly string[];
  readonly testsInFolder: number;
  readonly testsLeft: number;
}): string {
  const tests =
    input.testsInFolder === 0
      ? "No test of this code came with the folder"
      : `${input.testsInFolder} test(s) of this code run here`;
  const left =
    input.testsLeft === 0
      ? "."
      : `; ${input.testsLeft} more stay in the repository (BOUNDARY.md names them), and a change only they would catch passes here.`;
  return `${[
    "# This folder is a slice",
    "",
    "A slice of a larger repository, cut by carveout. The source files are copied at their repository paths; every module they import from the rest of the repository is a `.d.ts` stub with a recording mock behind it.",
    "",
    `- Entry points: ${input.entryPoints.map((entry) => `\`${entry}\``).join(", ")}.`,
    "- `npm ci`, then `npm test`: it builds and runs the folder's tests. Nothing else needs setting up.",
    "- Edit the copied source, and add files beside it in the same packages. The stubs, everything under `carveout/`, `package.json`, the lockfile and the root configuration are generated: edits to them do not go back.",
    "- A mock answers any call with another mock. To make one return something in a test, read the README's Mocks section; nothing else under `carveout/` needs reading.",
    "- Tests listed in `carveout/baseline.json` failed on the mocks before any edit and are not counted.",
    `- ${tests}${left} A pass here is a pass against mocks.`,
    "- When done, leave the edits in place: the repository's owner turns them into a patch with `carveout patch`.",
  ].join("\n")}\n`;
}
export const CONTRACT_PATH = "carveout/contract.json";
/** The repository owner's settings for every cut of it, at its root. */
export const CONFIG_PATH = "carveout.config.json";

/**
 * What a repository's owner sets once for every slice cut from it, in
 * `carveout.config.json` at the root: where the cut may follow and what it
 * must keep out. A flag on the command line overrides a boolean here; the
 * lists are joined. Nothing here is read from the slice folder.
 */
export interface RepoConfig {
  /** See `SliceRequest.wholePackage`. */
  readonly wholePackage?: boolean;
  /** See `SliceRequest.followWorkspaces`. */
  readonly followWorkspaces?: boolean;
  /** Paths or globs never copied; see `SliceRequest.private`. */
  readonly private?: readonly string[];
  /** Folders copied in whole beside the slice; see `CutRequest.copy`. */
  readonly copy?: readonly string[];
  /** Widen literal types in every stub; see `CutRequest.widenLiterals`. */
  readonly widenLiterals?: boolean;
  /** Every cut is for someone outside; see `CutRequest.public`. */
  readonly public?: boolean;
  /** Copy pure code rather than mock it; see `SliceRequest.copyPure`. */
  readonly copyPure?: boolean;
}

/** The owner's settings at the repository's root; empty when there are none. */
export function readRepoConfig(repo: string): RepoConfig {
  const path = join(repo, CONFIG_PATH);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${CONFIG_PATH} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${CONFIG_PATH} must hold an object.`);
  const record = parsed as Record<string, unknown>;
  const flag = (key: string): boolean | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean")
      throw new Error(`${CONFIG_PATH}: ${key} must be true or false.`);
    return value;
  };
  const paths = (key: string): readonly string[] | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === ""))
      throw new Error(`${CONFIG_PATH}: ${key} must be a list of paths.`);
    return value as string[];
  };
  const config: RepoConfig = {};
  const set = <K extends keyof RepoConfig>(key: K, value: RepoConfig[K]) => {
    if (value !== undefined) (config as Record<string, unknown>)[key] = value;
  };
  set("wholePackage", flag("wholePackage"));
  set("followWorkspaces", flag("followWorkspaces"));
  set("widenLiterals", flag("widenLiterals"));
  set("public", flag("public"));
  set("copyPure", flag("copyPure"));
  set("private", paths("private"));
  set("copy", paths("copy"));
  return config;
}

/** Paths as the repository spells them, `/`-separated, unique and sorted. */
function normalizePaths(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths.map((path) =>
        path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, ""),
      ),
    ),
  ]
    .filter((path) => path !== "")
    .sort(compare);
}

/** The request with the owner's configuration applied where it says nothing. */
function settle<
  T extends SliceRequest & {
    readonly copy?: readonly string[];
    readonly widenLiterals?: boolean;
    readonly public?: boolean;
  },
>(
  request: T,
): T & {
  readonly wholePackage: boolean;
  readonly followWorkspaces: boolean;
  readonly copyPure: boolean;
  readonly private: readonly string[];
  readonly copy: readonly string[];
  readonly widenLiterals: boolean;
  readonly public: boolean;
} {
  const config = readRepoConfig(resolve(request.repo));
  const privatePaths = normalizePaths([...(config.private ?? []), ...(request.private ?? [])]);
  const outside = request.public ?? config.public ?? false;
  const copyPure = request.copyPure ?? config.copyPure ?? false;
  return {
    ...request,
    wholePackage: request.wholePackage ?? config.wholePackage ?? false,
    // Pure code in another package is reached through its source, so
    // copying it follows the workspaces unless told otherwise.
    followWorkspaces:
      request.followWorkspaces ?? config.followWorkspaces ?? copyPure,
    copyPure,
    private: privatePaths,
    copy: normalizePaths([...(config.copy ?? []), ...(request.copy ?? [])]),
    // A private module's constants are not for the folder: widened unless
    // the owner says otherwise.
    widenLiterals:
      request.widenLiterals ?? config.widenLiterals ?? (privatePaths.length > 0 || outside),
    public: outside,
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

/** Assets that are not text: copied and compared as bytes. */
export function isBinaryPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav)$/i.test(
    path,
  );
}

/** `~/.carveout`, or `CARVEOUT_HOME`: where fetched package types are kept. */
export function carveoutHome(): string {
  return resolve(process.env["CARVEOUT_HOME"] ?? join(homedir(), ".carveout"));
}

export interface SliceRequest {
  /** The checkout's root: where its lockfile and workspace manifest are. */
  readonly repo: string;
  /** Files or directories, relative to the root. */
  readonly entryPoints: readonly string[];
  readonly budget?: SliceBudget;
  /** Also bring along the tests outside the slice that import it. */
  readonly tests?: boolean;
  /**
   * Include every file of the entry points' package the walk reaches, at
   * any depth, so the cut falls at package and service boundaries only.
   * Unset: as `carveout.config.json` says, else off.
   */
  readonly wholePackage?: boolean;
  /**
   * Follow an import of one of the repository's own packages into its
   * source rather than stubbing the package at the seam. Unset: as the
   * configuration says, else off.
   */
  readonly followWorkspaces?: boolean;
  /**
   * Copy the pure code the slice runs (a validator, an error class, a
   * formatter from another module or package) rather than mock it, so its
   * tests run against the real code and do not fail on the mocks before
   * any change. Follows the workspaces unless `followWorkspaces` is false.
   * The copied code is the contributor's to read. Unset: as the
   * configuration says, else off.
   */
  readonly copyPure?: boolean;
  /**
   * Paths or globs from the root that are never copied: cut and stubbed
   * wherever reached, their literal values widened. Joined with the
   * configuration's.
   */
  readonly private?: readonly string[];
}

function git(repo: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString("utf8")
      .trim();
  } catch {
    return null;
  }
}

/** A file's bytes at a commit, untrimmed; null when Git has none. */
function gitShow(repo: string, commit: string, path: string): Buffer | null {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The request's entry points, `/`-separated, relative, sorted and unique. */
function entriesOf(request: SliceRequest): string[] {
  return [
    ...new Set(
      request.entryPoints.map((entry) =>
        entry
          .replaceAll("\\", "/")
          .replace(/^\.\//, "")
          .replace(/\/+$/, ""),
      ),
    ),
  ].sort(compare);
}

export interface Plan {
  readonly repo: string;
  readonly entryPoints: readonly string[];
  readonly budget: SliceBudget;
  readonly graphFiles: number;
  readonly walk: ReachResult;
  readonly externals: SliceExternals;
  /** Bare specifiers the slice imports, by package name, sorted. */
  readonly packages: readonly string[];
  /** Of those, the repository's own workspace packages, which are stubbed. */
  readonly workspacePackages: readonly string[];
  /** Files a slice never copies: credentials files it reached. */
  readonly secretFiles: readonly string[];
  /** Cut modules, sorted. */
  readonly cutModules: readonly string[];
  /** Of those, the ones the slice imports only types from. */
  readonly typeOnlyCuts: readonly string[];
  /** How the walk was bounded, after the configuration. */
  readonly wholePackage: boolean;
  readonly followWorkspaces: boolean;
  readonly copyPure: boolean;
  readonly private: readonly string[];
  /** The files and lines the cut would copy, by why each is there. */
  readonly exposure: SliceExposure;
}

/** The walk's options for a settled request. */
function walkOptions(
  request: {
    readonly tests?: boolean;
    readonly wholePackage: boolean;
    readonly followWorkspaces: boolean;
    readonly copyPure: boolean;
    readonly private: readonly string[];
  },
  repo: string,
) {
  return {
    tests: request.tests === true,
    runnerOf: testRunnerResolver(repo, packageFolder(resolve(repo))),
    ...(request.wholePackage ? { wholePackage: true } : {}),
    ...(request.followWorkspaces ? { followWorkspaces: true } : {}),
    ...(request.copyPure ? { pure: pureRulesFor(repo) } : {}),
    ...(request.private.length === 0 ? {} : { isPrivate: pathMatcher(request.private) }),
  };
}

/** `purityRules` over the repository's files. */
export function pureRulesFor(repo: string) {
  return purityRules((file) => {
    try {
      return readFileSync(join(repo, file), "utf8");
    } catch {
      return null;
    }
  }, isNodeBuiltin);
}

/** What a cut of the request would hold, from the import graph alone. */
export function planSlice(request: SliceRequest): Plan {
  const settled = settle(request);
  const repo = resolve(request.repo);
  const budget = request.budget ?? SLICE_BUDGET_DEFAULTS;
  const entryPoints = entriesOf(request);
  const { built, walk } = walkGraph(repo, entryPoints, budget, walkOptions(settled, repo));
  const texts = walk.included.map((path) => ({
    path,
    text: readFileSync(join(repo, path), "utf8"),
  }));
  const externals = detectExternals(texts);
  const textOf = new Map(texts.map(({ path, text }) => [path, text]));
  const workspaces = workspacePackages(repo);
  const packages = new Set<string>();
  for (const dependency of walk.dependencies)
    if (
      dependency.status === "external" &&
      dependency.specifier !== null &&
      !isNodeBuiltin(dependency.specifier)
    )
      packages.add(packageNameOf(dependency.specifier));
  return {
    repo,
    entryPoints,
    budget,
    graphFiles: built.files.length,
    walk,
    externals,
    packages: [...packages].sort(compare),
    workspacePackages: [...packages]
      .filter((name) => workspaces.has(name))
      .sort(compare),
    secretFiles: walk.included.filter(isSecretPath),
    cutModules: [...new Set(walk.cuts.outbound.map((edge) => edge.to))].sort(
      compare,
    ),
    typeOnlyCuts: [
      ...new Set(walk.cuts.outbound.map((edge) => edge.to)),
    ]
      .filter((to) =>
        walk.cuts.outbound.every((edge) => edge.to !== to || edge.typeOnly),
      )
      .sort(compare),
    wholePackage: settled.wholePackage,
    followWorkspaces: settled.followWorkspaces,
    copyPure: settled.copyPure,
    private: settled.private,
    exposure: exposureOf(walk, (path) => textOf.get(path) ?? null),
  };
}

export interface CutRequest extends SliceRequest {
  readonly out: string;
  /** Packages to install or to mock, overriding the default. */
  readonly choices?: Readonly<Record<string, DependencyChoice>>;
  /** No network: packages stay untyped and the folder has no lockfile. */
  readonly offline?: boolean;
  /**
   * Widen literal types in stubs (`"live"` to `string`), so no constant's
   * value from a cut module is written; for a folder handed to someone
   * outside. Off by default: the stubs then type-check as the source does.
   */
  readonly widenLiterals?: boolean;
  /**
   * Service packages kept real rather than mocked (`--live`): installed and
   * typed as the repository has them, and the environment the files that
   * import them read is left out of `carveout.env`, so the shell's values
   * or the code's own defaults apply. For a package whose tests need the
   * service itself: a database driver against a local server.
   */
  readonly live?: readonly string[];
  /**
   * Folders (or files) copied in whole beside the slice, as paths from the
   * root: what the code reads by a name the walk cannot follow, such as a
   * migrations folder. Their files are neither slice nor generated: the
   * patch carries an edit to one. Joined with the configuration's.
   */
  readonly copy?: readonly string[];
  /**
   * A folder for someone outside the repository: literals widened unless
   * asked otherwise, and the maintainer's paths left out of what is
   * written, the checkout's location and the files outside the slice that
   * import it (each named by its package folder only). Commands that need
   * the repository then take `--repo`.
   */
  readonly public?: boolean;
  readonly log?: (line: string) => void;
}

/** What `carveout.json` holds: the cut, and how to undo its rewrites. */
export interface CarveoutRecord {
  readonly schemaVersion: typeof RECORD_SCHEMA_VERSION;
  readonly carveoutVersion: string;
  /**
   * The checkout the slice was cut from, as given. Absent from a `public`
   * cut, which leaves the maintainer's paths out: commands that need the
   * repository then take `--repo`.
   */
  readonly repo?: string;
  readonly manifest: SliceManifest;
  readonly dependencies: readonly ResolvedDependency[];
  /**
   * Optional peers of the installed packages the repository installs and
   * the folder does not; `--install <name>` adds one.
   */
  readonly optionalPeers: readonly { name: string; version: string; of: string }[];
  readonly importRewrites: readonly ImportRewrite[];
  /** Files carveout wrote, by path, with their hashes; never the slice's. */
  readonly generated: readonly { path: string; sha256: string }[];
  /**
   * The slice's own files as written, imports rewritten, with their hashes:
   * what an edit since the cut is measured against (the coverage gate).
   */
  readonly copied?: readonly { path: string; sha256: string }[];
  readonly lockfile: boolean;
  readonly blockers: readonly {
    readonly code: string;
    readonly file: string | null;
    readonly detail: string;
  }[];
  readonly ready: boolean;
  /** What the cut was asked, so `status` can ask it again. */
  readonly request: {
    readonly entryPoints: readonly string[];
    readonly budget: SliceBudget;
    readonly choices: Readonly<Record<string, DependencyChoice>>;
    readonly offline: boolean;
    readonly widenLiterals: boolean;
    /** Absent in records made before tests could be brought along. */
    readonly tests?: boolean;
    /** Service packages kept real; absent when none. */
    readonly live?: readonly string[];
    /** The cut's bounds after the configuration; absent when off or none. */
    readonly wholePackage?: boolean;
    readonly followWorkspaces?: boolean;
    readonly copyPure?: boolean;
    readonly private?: readonly string[];
    readonly copy?: readonly string[];
    /** A folder for someone outside; see `CutRequest.public`. */
    readonly public?: boolean;
  };
  /**
   * Files copied in whole from the `copy` folders, with their hashes: not
   * the slice's, not generated, and in the patch when edited. Absent in
   * records made before folders could be copied.
   */
  readonly extras?: readonly { path: string; sha256: string }[];
  /**
   * The repository's files the cut resolved with, beyond the slice: compiler
   * and package configuration, workspace manifests and lockfiles.
   */
  readonly inputs: readonly { path: string; sha256: string | null }[];
  /**
   * The tests that run the slice's code: those in the folder, and those
   * left in the repository with the reason (a public cut names each by its
   * package). Absent in records made before the account.
   */
  readonly tests?: {
    readonly verdict: string;
    readonly carried: readonly string[];
    readonly left: readonly SliceTestLeft[];
  };
  /** What the folder shows of the repository; see `exposureOf`. */
  readonly exposure?: SliceExposure;
}

export interface CutResult {
  readonly out: string;
  readonly record: CarveoutRecord;
  readonly contract: BoundaryContract;
}

/** A name npm accepts for the folder's package. */
function projectName(repo: string | null, entries: readonly string[]): string {
  const words = [
    ...(repo === null ? [] : [basename(repo)]),
    ...entries.map((entry) => basename(entry)),
  ]
    .join("-")
    .toLowerCase()
    .replace(/\.[cm]?[jt]sx?$/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${words.slice(0, 60).replace(/-$/, "") || "slice"}-carveout`;
}

export interface LockedPeer {
  readonly name: string;
  readonly version: string;
  /** The installed package whose install tree asks for it. */
  readonly of: string;
  readonly optional: boolean;
}

/** The version the repository's npm lockfile installs `name` at, at its root. */
export function lockedVersion(repo: string, name: string): string | null {
  try {
    const lock = JSON.parse(
      readFileSync(join(repo, "package-lock.json"), "utf8"),
    ) as { packages?: Record<string, { version?: unknown; link?: unknown }> };
    const entry = lock.packages?.[`node_modules/${name}`];
    return typeof entry?.version === "string" && entry.link !== true
      ? entry.version
      : null;
  } catch {
    return null;
  }
}

/**
 * A package-lock.json for the folder seeded from the repository's: every
 * package the repository installs, at the version it installs it, the
 * slice's workspaces' own installs over the root's (the first workspace
 * last, so it wins). npm keeps a seeded version that satisfies the range
 * and prunes the rest, so the folder runs what the repository runs rather
 * than what the registry has newest. Null without an npm lockfile.
 */
export function seededLockfile(
  repo: string,
  workspaces: readonly string[],
  root: Record<string, unknown>,
): Record<string, unknown> | null {
  let lock: { packages?: Record<string, Record<string, unknown>> };
  try {
    lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  } catch {
    return null;
  }
  const source = lock.packages ?? {};
  const packages: Record<string, Record<string, unknown>> = {};
  const take = (prefix: string) => {
    for (const [key, entry] of Object.entries(source)) {
      if (!key.startsWith(`${prefix}node_modules/`) || entry["link"] === true) continue;
      packages[key.slice(prefix.length)] = entry;
    }
  };
  take("");
  for (const workspace of [...workspaces].reverse())
    if (workspace !== "") take(`${workspace}/`);
  return {
    name: root["name"],
    version: root["version"],
    lockfileVersion: 3,
    requires: true,
    packages: { "": root, ...packages },
  };
}

/**
 * Peers of the installed packages, and of what they install, that the
 * repository's npm lockfile installs at its root for production: a
 * package the slice does not import but one it installs needs, at the
 * version the repository runs with. Optional peers are marked; the cut
 * installs only the others unless asked. Empty without a lockfile.
 */
export function lockedPeers(
  repo: string,
  installed: readonly string[],
): LockedPeer[] {
  let lock: { packages?: Record<string, Record<string, unknown>> };
  try {
    lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  } catch {
    return [];
  }
  const packages = lock.packages ?? {};
  const record = (value: unknown) =>
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  /** The lockfile key npm resolves `name` to from `from`. */
  const locate = (name: string, from: string): string | null => {
    for (let base = from; ; ) {
      const key = `${base === "" ? "" : `${base}/`}node_modules/${name}`;
      if (packages[key] !== undefined) return key;
      if (base === "") return null;
      const at = base.lastIndexOf("/node_modules/");
      base = at === -1 ? "" : base.slice(0, at);
    }
  };
  const taken = new Set(installed);
  const peers = new Map<
    string,
    { version: string; of: string; optional: boolean }
  >();
  const seen = new Set<string>();
  const queue = installed.flatMap((name) => {
    const key = locate(name, "");
    return key === null ? [] : [{ key, of: name }];
  });
  while (queue.length > 0) {
    const { key, of } = queue.shift() ?? { key: "", of: "" };
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = packages[key] ?? {};
    for (const name of Object.keys(record(entry["dependencies"]))) {
      const next = locate(name, key);
      if (next !== null) queue.push({ key: next, of });
    }
    const meta = record(entry["peerDependenciesMeta"]);
    for (const name of Object.keys(record(entry["peerDependencies"]))) {
      const optional = record(meta[name])["optional"] === true;
      const known = peers.get(name);
      if (taken.has(name) || (known !== undefined && !(known.optional && !optional)))
        continue;
      const root = packages[`node_modules/${name}`];
      const version = root?.["version"];
      if (
        typeof version !== "string" ||
        root?.["link"] === true ||
        root?.["dev"] === true
      )
        continue;
      peers.set(name, { version, of, optional });
      if (!optional) queue.push({ key: `node_modules/${name}`, of });
    }
  }
  return [...peers.entries()]
    .map(([name, peer]) => ({ name, ...peer }))
    .sort((a, b) => compare(a.name, b.name));
}

/**
 * The version the repository gives `name`: its npm lockfile's, else the
 * pin in the nearest package.json above one of `files`, else the root's.
 */
export function repositoryVersion(
  repo: string,
  name: string,
  files: readonly string[],
): string | null {
  const locked = lockedVersion(repo, name);
  if (locked !== null) return locked;
  const directories = new Set<string>([""]);
  for (const file of files)
    for (let dir = dirname(file); dir !== "." && dir !== ""; dir = dirname(dir))
      directories.add(dir);
  for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(repo, dir, "package.json"), "utf8"),
      ) as Record<string, Record<string, unknown> | undefined>;
      for (const key of ["devDependencies", "dependencies"]) {
        const version = manifest[key]?.[name];
        if (typeof version === "string") return catalogResolver(repo)(name, version);
      }
    } catch {
      // No package.json here.
    }
  }
  return null;
}

/** A cut held in memory: every file it writes, and its record but the lockfile. */
export interface ComputedCut {
  readonly files: readonly GeneratedFile[];
  /** Included files copied as bytes. */
  readonly binaries: readonly string[];
  /** The `copy` folders' files, copied as bytes; see `CarveoutRecord.extras`. */
  readonly extras: readonly string[];
  readonly record: Omit<CarveoutRecord, "generated" | "lockfile">;
  readonly contract: BoundaryContract;
}

/** The repository files a cut resolved with, by path, hashed; see `inputs`. */
function resolutionInputs(
  repo: string,
  configs: readonly string[],
): { path: string; sha256: string | null }[] {
  const paths = new Set<string>(configs);
  for (const name of [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    ".npmrc",
    CONFIG_PATH,
  ])
    paths.add(name);
  for (const directory of workspacePackages(repo).values()) {
    const rel = relative(repo, directory).replaceAll("\\", "/");
    paths.add(rel === "" ? "package.json" : `${rel}/package.json`);
  }
  return [...paths].sort(compare).map((path) => {
    const absolute = join(repo, path);
    return {
      path,
      sha256: existsSync(absolute) ? sha256(readFileSync(absolute)) : null,
    };
  });
}

/** Everything a cut writes, without writing it or resolving a lockfile. */
/** A contract whose inbound importers are named by their package only. */
function withoutOutsideImporters(
  contract: Record<string, unknown>,
  outsideName: (path: string) => string,
): Record<string, unknown> {
  const inbound = contract["inbound"];
  if (!Array.isArray(inbound)) return contract;
  return {
    ...contract,
    inbound: inbound.map((module: Record<string, unknown>) => ({
      ...module,
      importedBy: Array.isArray(module["importedBy"])
        ? [...new Set((module["importedBy"] as string[]).map(outsideName))].sort(compare)
        : module["importedBy"],
    })),
  };
}

export async function computeCut(
  request: Omit<CutRequest, "out">,
): Promise<ComputedCut> {
  const settled = settle(request);
  const repo = resolve(request.repo);
  const log = request.log ?? (() => {});
  const budget = request.budget ?? SLICE_BUDGET_DEFAULTS;
  const entryPoints = entriesOf(request);
  const { built } = walkGraph(repo, entryPoints, budget, walkOptions(settled, repo));
  log(`Read the imports of ${built.files.length} files.`);
  const commitSha = git(repo, ["rev-parse", "HEAD"]);
  const signal = AbortSignal.timeout(15 * 60_000);
  const live = [...new Set(request.live ?? [])].sort(compare);
  const workspaces = workspacePackages(repo);
  const analysis = await analyseSlice({
    sourceDir: repo,
    graph: built.graph,
    params: {
      entryPoints,
      budget,
      tests: request.tests === true,
      ...(live.length === 0 ? {} : { live }),
      ...(settled.wholePackage ? { wholePackage: true } : {}),
      ...(settled.followWorkspaces ? { followWorkspaces: true } : {}),
      ...(settled.copyPure ? { copyPure: true } : {}),
      ...(settled.private.length === 0 ? {} : { private: settled.private }),
      ...(settled.copy.length === 0 ? {} : { copy: settled.copy }),
    },
    source: {
      commitSha,
      isDirty: (paths) =>
        commitSha !== null &&
        (git(repo, ["status", "--porcelain", "--", ...paths]) ?? "") !== "",
    },
    signal,
    log,
    widenLiterals: settled.widenLiterals,
    ...(request.offline === true
      ? {}
      : {
          packageTypes: npmPackageTypes({
            root: join(carveoutHome(), "types"),
          }),
        }),
  });
  const { contract, contractJson } = analysis;
  // A public folder names a file outside the slice only by its package.
  const outsideName = (() => {
    const packageOf = packageFolder(repo);
    return (path: string) => {
      const pkg = packageOf(path);
      return `${pkg === "" ? "" : `${pkg}/`}(outside the slice)`;
    };
  })();
  // The tests left in the repository, named as the folder may name them.
  const testsLeft = analysis.walk.testsLeft.map(({ file, reason }) => ({
    file: settled.public ? outsideName(file) : file,
    reason,
  }));
  const manifest: SliceManifest = settled.public
    ? {
        ...analysis.manifest,
        cuts: {
          ...analysis.manifest.cuts,
          inbound: analysis.manifest.cuts.inbound.map((edge) => ({
            ...edge,
            from: outsideName(edge.from),
          })),
        },
      }
    : analysis.manifest;
  // A live package is installed, whatever the default for its service.
  const choices: Record<string, DependencyChoice> = {
    ...request.choices,
    ...Object.fromEntries(live.map((name) => [name, "approved-package" as const])),
  };
  // So is a package whose class a carried test patches by its prototype
  // (`S3Client.prototype.send = ...`): a mock has no prototype to patch, so
  // the test fails on the mock before any change (E6c: 30 such tests).
  // The test never reaches the service; it replaces the call that would.
  // The packages of its scope the slice imports beside it come too: they
  // work on the real client (`@aws-sdk/s3-request-presigner` signs with
  // the client's own middleware), and a mock of one answers with a mock.
  if (request.tests === true) {
    const imported = new Set(
      manifest.requiredBuildInputs.packages
        .filter((item) => item.workspace !== true)
        .map((item) => item.name),
    );
    for (const [name, cls] of prototypePatchedPackages(
      manifest.included
        .filter((file) => isTestPath(file.path) && isScript(file.path))
        .map((file) => ({ path: file.path, text: readFileSync(join(repo, file.path), "utf8") })),
      new Set(workspaces.keys()),
    )) {
      const scope = name.startsWith("@") ? `${name.split("/")[0] ?? ""}/` : null;
      const together = [
        name,
        ...(scope === null
          ? []
          : [...imported].filter((other) => other !== name && other.startsWith(scope)).sort(compare)),
      ];
      for (const each of together)
        if (choices[each] === undefined) {
          choices[each] = "approved-package";
          log(
            each === name
              ? `Installs ${name}: a test patches ${cls}.prototype, which a mock does not have.`
              : `Installs ${each} with it: a package of the same scope, for the real ${cls}.`,
          );
        }
    }
  }
  // And a package whose class the slice's code tests with `instanceof`
  // (`error instanceof Anthropic.APIError`): a mock is typed `any`, so the
  // test narrows nothing, the code reading the narrowed value does not
  // compile, and the folder's build fails where the cut said ready. The
  // real class narrows, and is never called.
  for (const [name, cls] of instanceofPackages(
    manifest.included
      .filter((file) => isScript(file.path))
      .map((file) => ({ path: file.path, text: readFileSync(join(repo, file.path), "utf8") })),
    new Set(workspaces.keys()),
  ))
    if (choices[name] === undefined) {
      choices[name] = "approved-package";
      log(`Installs ${name}: the code tests a value with instanceof ${cls}, which a mock cannot narrow.`);
    }
  const scope = resolveScope({
    manifest,
    contract,
    ...(Object.keys(choices).length === 0 ? {} : { choices }),
  });
  // The environment the live packages' importers read stays the shell's.
  const liveFiles = new Set(
    manifest.externals.packages
      .filter((item) => live.includes(packageNameOf(item.specifier)))
      .flatMap((item) => item.files),
  );
  const liveEnvironment = manifest.externals.environment
    .filter((item) => item.files.some((file) => liveFiles.has(file)))
    .map((item) => item.name);
  // Images, fonts and media are copied byte for byte, beside the sources.
  const binaries = manifest.included
    .map((file) => file.path)
    .filter(isBinaryPath);
  const sources = manifest.included
    .filter((file) => !isBinaryPath(file.path))
    .map((file) => ({
      originalPath: file.path,
      path: file.path,
      text: readFileSync(join(repo, file.path), "utf8"),
    }));
  const stubs = analysis.stubs.map((stub) => ({
    module: stub.module,
    path: stub.module,
    text: stub.text,
  }));
  const packageNames = new Set(
    scope.dependencies
      .filter((dependency) => dependency.kind === "package")
      .map((dependency) => dependency.name),
  );
  const installed = new Set(
    scope.dependencies
      .filter(
        (dependency) =>
          dependency.kind === "package" &&
          dependency.resolution === "approved-package",
      )
      .map((dependency) => dependency.name),
  );
  const includedPaths = manifest.included.map((file) => file.path);
  const nodeTypes = sources.some((source) =>
    moduleSpecifiers(source.path, source.text).some((literal) =>
      isNodeBuiltin(literal.specifier),
    ),
  ) ? repositoryVersion(repo, "@types/node", includedPaths) : null;
  const uses = packageUses(
    new Map([...sources, ...stubs].map((file) => [file.path, file.text])),
    (specifier) =>
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      (packageNames.has(packageNameOf(specifier)) ||
        (nodeTypes === null && isNodeBuiltin(specifier))),
  );
  const first = manifest.included[0]?.path;
  const compilerOptions =
    first === undefined ? undefined : nearestCompilerOptions(repo, first);
  // The coverage the entry points' package test requires, carried into the
  // folder's `npm test`.
  const packageDir =
    entryPoints[0] === undefined ? null : packageFolder(repo)(`${entryPoints[0]}/`);
  let coverage: CoverageGate | null = null;
  if (packageDir !== null)
    try {
      const script = (
        JSON.parse(readFileSync(join(repo, packageDir, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts?.["test"];
      if (typeof script === "string") coverage = coverageGateOf(packageDir, script);
    } catch {
      // No readable package.json: no gate.
    }
  const project = generateProject({
    // A public folder names neither the checkout's path nor its folder.
    origin: settled.public
      ? { repository: null, name: projectName(null, entryPoints) }
      : { repository: basename(repo), name: projectName(repo, entryPoints) },
    manifest,
    contract,
    sources,
    stubs,
    surface: analysis.surface,
    dependencies: scope.dependencies,
    knownSpecifiers: NODE_BUILTINS,
    packageModules: packageModules(uses, (specifier) =>
      installed.has(packageNameOf(specifier)),
    ),
    ...(compilerOptions === undefined ? {} : { compilerOptions }),
    ...(coverage === null ? {} : { coverage }),
    ...(live.length === 0 ? {} : { live, liveEnvironment }),
    keepsImplicitAny: analysis.keepsImplicitAny,
    hasNodeTypes: nodeTypes !== null,
  });
  // Peers the installed packages need, and packages asked for by name
  // that the slice does not import, as the repository installs them.
  const required = new Set(
    manifest.requiredBuildInputs.packages.map((item) => item.name),
  );
  const asked = Object.entries(choices)
    .filter(
      ([name, choice]) => choice === "approved-package" && !required.has(name),
    )
    .map(([name]) => {
      const version = lockedVersion(repo, name);
      if (version === null)
        throw new Error(
          `--install ${name}: the slice does not import it and the repository's package-lock.json does not install it.`,
        );
      return { name, version, of: "", optional: false };
    });
  // The automatic JSX runtime imports its package without the source
  // naming it: `react/jsx-runtime` under `"jsx": "react-jsx"`.
  const jsx = String(compilerOptions?.["jsx"] ?? "").toLowerCase();
  const jsxSource =
    (jsx === "react-jsx" || jsx === "react-jsxdev") &&
    manifest.included.some((file) => /\.[jt]sx$/.test(file.path))
      ? String(compilerOptions?.["jsxImportSource"] ?? "react")
      : null;
  if (
    jsxSource !== null &&
    !installed.has(jsxSource) &&
    !asked.some((item) => item.name === jsxSource)
  ) {
    const version = repositoryVersion(
      repo,
      jsxSource,
      manifest.included.map((file) => file.path),
    );
    if (version !== null)
      asked.push({ name: jsxSource, version, of: "", optional: false });
  }
  const allPeers = lockedPeers(repo, [
    ...installed,
    ...asked.map((item) => item.name),
  ]);
  const optionalPeers = allPeers.filter(
    (peer) => peer.optional && !asked.some((item) => item.name === peer.name),
  );
  const peers = [
    ...allPeers.filter((peer) => !peer.optional),
    ...asked,
  ].sort((a, b) => compare(a.name, b.name));
  const dependencies: ResolvedDependency[] = [
    ...scope.dependencies,
    ...peers.map((peer) => ({
      name: peer.name,
      kind: "package" as const,
      version: peer.version,
      resolution: "approved-package" as const,
      detail:
        peer.of === ""
          ? "Installed at the version the repository's lockfile installs, as asked."
          : `Installed as the repository installs it: a peer of what ${peer.of} installs.`,
    })),
  ].sort((a, b) => compare(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`));
  // The types of what the folder installs, where the repository pins
  // them, so it compiles against what the repository compiles against.
  const typesPackages = [
    ...new Set(
      dependencies
        .filter(
          (dependency) =>
            dependency.kind === "package" &&
            dependency.resolution === "approved-package" &&
            !dependency.name.startsWith("@types/"),
        )
        .map((dependency) => typesPackageOf(dependency.name)),
    ),
  ]
    .filter((name) => !dependencies.some((dependency) => dependency.name === name))
    .flatMap((name) => {
      const version = repositoryVersion(repo, name, includedPaths);
      return version === null ? [] : [{ name, version }];
    })
    .sort((a, b) => compare(a.name, b.name));
  // Node's own types, at the repository's version, when the slice's
  // sources import a Node built-in: untyped, `assert.ok` narrows nothing
  // and `import.meta.url` is unknown, so the folder would not type-check
  // as the repository does.
  if (
    nodeTypes !== null &&
    !typesPackages.some((types) => types.name === "@types/node")
  )
    typesPackages.push({ name: "@types/node", version: nodeTypes });
  // The compiler the repository builds with, so the folder's build passes
  // and fails as the repository's does; the tool's own without one.
  const compiler = repositoryVersion(repo, "typescript", includedPaths);
  if (compiler !== null) log(`Compiles with typescript@${compiler}, as the repository does.`);
  const sorted = (record: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(record).sort(([a], [b]) => compare(a, b)),
    );
  // A repository on pnpm or Yarn installs a peer range that does not
  // match as a warning; npm refuses the whole tree. The folder resolves as
  // the repository's own manager does (E8g: n8n's vitest-mock-extended asks
  // TypeScript 6 of a repository on 7). An npm repository stays strict.
  const peerLenient =
    !existsSync(join(repo, "package-lock.json")) &&
    !existsSync(join(repo, "npm-shrinkwrap.json")) &&
    (existsSync(join(repo, "pnpm-lock.yaml")) || existsSync(join(repo, "yarn.lock")));
  const projectFiles = project.files.map((file) => {
    if (file.path === ".npmrc" && peerLenient)
      return { ...file, text: `${file.text}legacy-peer-deps=true\n` };
    if (file.path === "tsconfig.json" && nodeTypes !== null) {
      const config = JSON.parse(file.text) as {
        compilerOptions: Record<string, unknown>;
      };
      const types = config.compilerOptions["types"];
      config.compilerOptions["types"] = [
        ...new Set(["node", ...(Array.isArray(types) ? (types as string[]) : [])]),
      ];
      return { ...file, text: `${JSON.stringify(config, null, 2)}\n` };
    }
    if (
      file.path !== "package.json" ||
      (peers.length + typesPackages.length === 0 && compiler === null)
    )
      return file;
    const manifestJson = JSON.parse(file.text) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    if (compiler !== null) manifestJson.devDependencies["typescript"] = compiler;
    for (const peer of peers)
      manifestJson.dependencies[peer.name] ??= peer.version;
    for (const types of typesPackages)
      manifestJson.devDependencies[types.name] ??= types.version;
    manifestJson.dependencies = sorted(manifestJson.dependencies);
    manifestJson.devDependencies = sorted(manifestJson.devDependencies);
    return { ...file, text: `${JSON.stringify(manifestJson, null, 2)}\n` };
  });
  if (typesPackages.length > 0)
    log(`Types installed: ${typesPackages.map((types) => types.name).join(", ")}.`);
  if (peers.length > 0)
    log(`Also installed: ${peers.map((peer) => peer.name).join(", ")}.`);
  const extra: GeneratedFile[] = [
    {
      path: SLICE_AGENTS_PATH,
      text: renderSliceAgents({
        entryPoints: manifest.entryPoints,
        testsInFolder: analysis.walk.tests.length,
        testsLeft: testsLeft.length,
      }),
      class: "config",
      public: true,
    },
    { path: SLICE_CLAUDE_PATH, text: "@AGENTS.md\n", class: "config", public: true },
    {
      path: BOUNDARY_PATH,
      // What the folder's tests can say comes before what it stubs: a pass
      // here is worth what the tests in it run.
      text: renderBoundaryMarkdown(contract, manifest).replace(
        "## Stubbed modules",
        `${renderTestsMarkdown({ tests: analysis.walk.tests, testsLeft }, (path) => path).join("\n")}\n## Stubbed modules`,
      ),
      class: "config",
      public: true,
    },
    {
      path: CONTRACT_PATH,
      text: `${JSON.stringify(
        settled.public
          ? withoutOutsideImporters(withoutCommit(JSON.parse(contractJson)), outsideName)
          : withoutCommit(JSON.parse(contractJson)),
        null,
        2,
      )}\n`,
      class: "config",
      public: true,
    },
  ];
  const files = [...projectFiles, ...extra];
  // The `copy` folders, file by file, less what the slice already holds
  // and any credentials file, which stays behind and blocks the cut.
  const held = new Set([
    ...files.map((file) => file.path),
    ...binaries,
  ]);
  const extras: string[] = [];
  const extraBlockers: { code: string; file: string | null; detail: string }[] = [];
  for (const dir of settled.copy) {
    const absolute = join(repo, dir);
    if (!existsSync(absolute))
      throw new Error(`copy ${dir}: the repository has no such file or folder.`);
    const paths = statSync(absolute).isDirectory()
      ? listTree(absolute).map((path) => `${dir}/${path}`)
      : [dir];
    for (const path of paths.sort(compare)) {
      if (held.has(path)) continue;
      if (isSecretPath(path)) {
        extraBlockers.push({
          code: "secret_file",
          file: path,
          detail: `${path} is a credentials file; it is not copied with ${dir}.`,
        });
        continue;
      }
      held.add(path);
      extras.push(path);
    }
  }
  if (extras.length > 0)
    log(`Copies ${extras.length} file(s) from ${settled.copy.join(", ")} beside the slice.`);
  // A copied folder leaves the repository as it is: scan it like
  // everything else the cut writes.
  extraBlockers.push(
    ...secretBlockers(
      scanSecrets(
        extras
          .filter((path) => !isBinaryPath(path))
          .map((path) => ({ path, text: readFileSync(join(repo, path), "utf8") })),
      ),
    ).map(({ code, file, detail }) => ({ code, file: file ?? null, detail })),
  );
  const blockers: CarveoutRecord["blockers"] = [
    ...manifest.blockers.map(({ code, file, detail }) => ({
      code,
      file,
      detail,
    })),
    ...extraBlockers,
    ...scope.blockers
      .filter((blocker) => blocker.code === "dependency_unresolved")
      .map(({ code, detail }) => ({ code, file: null, detail })),
    ...project.blockers.map(({ code, file, detail }: ProjectBlocker) => ({
      code,
      file,
      detail,
    })),
  ];
  return {
    files,
    binaries,
    extras,
    contract,
    record: {
      schemaVersion: RECORD_SCHEMA_VERSION,
      carveoutVersion: CARVEOUT_VERSION,
      ...(settled.public ? {} : { repo }),
      manifest,
      dependencies: [
        ...dependencies,
        ...typesPackages.map((types) => ({
          name: types.name,
          kind: "package" as const,
          version: types.version,
          resolution: "approved-package" as const,
          detail: "The types of an installed package, at the version the repository pins.",
        })),
      ].sort((a, b) => compare(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`)),
      optionalPeers: optionalPeers.map(({ name, version, of }) => ({
        name,
        version,
        of,
      })),
      importRewrites: project.importRewrites,
      blockers,
      ready: analysis.ready && blockers.length === 0,
      request: {
        entryPoints,
        budget,
        choices: request.choices ?? {},
        offline: request.offline === true,
        widenLiterals: settled.widenLiterals,
        tests: request.tests === true,
        ...(live.length === 0 ? {} : { live }),
        ...(settled.wholePackage ? { wholePackage: true } : {}),
        ...(settled.followWorkspaces ? { followWorkspaces: true } : {}),
        ...(settled.copyPure ? { copyPure: true } : {}),
        ...(settled.private.length === 0 ? {} : { private: settled.private }),
        ...(settled.copy.length === 0 ? {} : { copy: settled.copy }),
        ...(settled.public ? { public: true } : {}),
      },
      inputs: resolutionInputs(repo, manifest.requiredBuildInputs.configs),
      tests: {
        verdict: testsVerdict(analysis.walk),
        carried: analysis.walk.tests,
        left: testsLeft,
      },
      exposure: exposureOf(analysis.walk, (path) => {
        try {
          return readFileSync(join(repo, path), "utf8");
        } catch {
          return null;
        }
      }),
    },
  };
}

/**
 * The packages whose classes the tests patch by prototype, by package name
 * with one such class: `import { S3Client } from "@aws-sdk/client-s3"` and
 * `S3Client.prototype` in the same file. The repository's own packages are
 * not among them; a type import is not either.
 */
function prototypePatchedPackages(
  sources: readonly { path: string; text: string }[],
  workspaces: ReadonlySet<string>,
): Map<string, string> {
  const found = new Map<string, string>();
  for (const source of sources) {
    if (!/\.prototype\b/.test(source.text)) continue;
    const parsed = parseSource(source.path, source.text);
    for (const statement of parsed.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        isNodeBuiltin(specifier)
      )
        continue;
      const clause = statement.importClause;
      if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword)
        continue;
      const names: string[] = [];
      if (clause.name !== undefined) names.push(clause.name.text);
      if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          if (!element.isTypeOnly) names.push(element.name.text);
      const name = packageNameOf(specifier);
      if (workspaces.has(name) || found.has(name)) continue;
      for (const binding of names)
        if (new RegExp(`\\b${binding.replace(/\$/g, "\\$")}\\.prototype\\b`).test(source.text)) {
          found.set(name, binding);
          break;
        }
    }
  }
  return found;
}

/**
 * The packages whose classes the code tests with `instanceof`, by package
 * name with the class as written: `import Anthropic from
 * "@anthropic-ai/sdk"` and `instanceof Anthropic.APIError` in the same
 * file, or a named or namespace import on the right of one. The
 * repository's own packages and Node's are not among them.
 */
export function instanceofPackages(
  sources: readonly { path: string; text: string }[],
  workspaces: ReadonlySet<string>,
): Map<string, string> {
  const found = new Map<string, string>();
  for (const source of sources) {
    if (!/\binstanceof\b/.test(source.text)) continue;
    const parsed = parseSource(source.path, source.text);
    const bindings = new Map<string, string>();
    for (const statement of parsed.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        isNodeBuiltin(specifier)
      )
        continue;
      const name = packageNameOf(specifier);
      if (workspaces.has(name)) continue;
      const clause = statement.importClause;
      if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword)
        continue;
      if (clause.name !== undefined) bindings.set(clause.name.text, name);
      const named = clause.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named))
        bindings.set(named.name.text, name);
      else if (named !== undefined)
        for (const element of named.elements)
          if (!element.isTypeOnly) bindings.set(element.name.text, name);
    }
    if (bindings.size === 0) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      ) {
        let root: ts.Expression = node.right;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        const name = ts.isIdentifier(root) ? bindings.get(root.text) : undefined;
        if (name !== undefined && !found.has(name))
          found.set(name, node.right.getText(parsed));
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return found;
}

/** The contract as the folder holds it: its commit is in carveout.json. */
function withoutCommit(contract: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...contract };
  delete copy["sourceCommitSha"];
  return copy;
}

export async function cutSlice(request: CutRequest): Promise<CutResult> {
  const repo = resolve(request.repo);
  const out = resolve(request.out);
  const log = request.log ?? (() => {});
  if (existsSync(out) && readdirSync(out).length > 0)
    throw new Error(`${out} is not empty; give an empty or new folder.`);
  if (out === repo)
    throw new Error("The output folder cannot be the repository itself.");
  const { files, binaries, extras, record: computed, contract } = await computeCut(request);
  // A credential never leaves the repository: with one found, nothing is
  // written, not even a folder with blockers.
  const credentials = computed.blockers.filter((blocker) =>
    CREDENTIAL_BLOCKERS.has(blocker.code),
  );
  if (credentials.length > 0)
    throw new Error(
      `Nothing written: the cut would carry a credential.\n${credentials
        .map((blocker) => `  ${blocker.code}${blocker.file === null ? "" : ` ${blocker.file}`}: ${blocker.detail}`)
        .join("\n")}`,
    );
  const fresh = !existsSync(out);
  for (const file of files) {
    const path = join(out, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.text, "utf8");
  }
  for (const path of [...binaries, ...extras]) {
    await mkdir(dirname(join(out, path)), { recursive: true });
    await copyFile(join(repo, path), join(out, path));
  }
  log(`Wrote ${files.length + binaries.length + extras.length} files to ${out}.`);
  let lockfile = false;
  if (request.offline !== true) {
    // The entry points' workspace first, then the others the slice holds.
    const packageOf = packageFolder(repo);
    const workspaces = [
      ...new Set([
        ...computed.request.entryPoints.map((entry) => packageOf(`${entry}/`)),
        ...computed.manifest.included.map((file) => packageOf(file.path)),
      ]),
    ];
    const seeded = seededLockfile(
      repo,
      workspaces,
      JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as Record<string, unknown>,
    );
    if (seeded !== null)
      await writeFile(join(out, "package-lock.json"), `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
  }
  if (request.offline !== true)
    try {
      await command(
        "npm",
        [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
        ],
        { cwd: out, signal: AbortSignal.timeout(5 * 60_000) },
      );
      lockfile = existsSync(join(out, "package-lock.json"));
      log("Resolved package-lock.json.");
    } catch (error) {
      // The seed is not a resolved lockfile. Do not leave it behind for
      // `check` to mistake for a lock suitable for npm ci.
      await rm(join(out, "package-lock.json"), { force: true });
      log(
        `No lockfile: ${error instanceof Error ? error.message : String(error)}. \`npm install\` makes one.`,
      );
    }
  // The lock is seeded from the repository's, whose resolved URLs can carry
  // a private registry's token. The folder was empty or new: remove it all.
  const lockFindings = lockfile
    ? scanSecrets([
        { path: "package-lock.json", text: readFileSync(join(out, "package-lock.json"), "utf8") },
      ])
    : [];
  if (lockFindings.length > 0) {
    await rm(out, { recursive: true, force: true });
    if (!fresh) await mkdir(out, { recursive: true });
    throw new Error(
      `Nothing kept: the resolved lockfile carries a credential. ${secretBlockers(lockFindings)
        .map((blocker) => blocker.detail)
        .join(" ")}`,
    );
  }
  const generated = [
    ...files.filter((file) => file.class !== "source"),
    ...(lockfile
      ? [
          {
            path: "package-lock.json",
            text: readFileSync(join(out, "package-lock.json"), "utf8"),
          },
        ]
      : []),
  ]
    .map((file) => ({ path: file.path, sha256: sha256(file.text) }))
    .sort((a, b) => compare(a.path, b.path));
  const copied = files
    .filter((file) => file.class === "source")
    .map((file) => ({ path: file.path, sha256: sha256(file.text) }))
    .sort((a, b) => compare(a.path, b.path));
  const record: CarveoutRecord = {
    ...computed,
    generated,
    copied,
    ...(extras.length === 0
      ? {}
      : {
          extras: extras
            .map((path) => ({ path, sha256: sha256(readFileSync(join(out, path))) }))
            .sort((a, b) => compare(a.path, b.path)),
        }),
    lockfile,
  };
  await writeFile(
    join(out, RECORD_PATH),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return { out, record, contract };
}

export function readRecord(dir: string): CarveoutRecord {
  const path = join(resolve(dir), RECORD_PATH);
  if (!existsSync(path))
    throw new Error(`${dir} has no ${RECORD_PATH}; it was not cut by carveout.`);
  const record = JSON.parse(readFileSync(path, "utf8")) as CarveoutRecord;
  if (record.schemaVersion !== RECORD_SCHEMA_VERSION)
    throw new Error(
      `${RECORD_PATH} is schema ${String(record.schemaVersion)}; this carveout reads ${RECORD_SCHEMA_VERSION}.`,
    );
  // A folder can come back from someone else: no path it names may lead
  // carveout outside the folder or the repository.
  checkRecordPaths(record);
  return record;
}

/**
 * Throws unless every file the record says the slice holds is one of the
 * repository's, at the bytes the cut read: its hash must be the blob's at
 * the cut's commit, or the checkout's file's (a cut of uncommitted bytes).
 * The record comes back with the folder, and its `included` list decides
 * which files a patch may edit or delete and which packages may gain a new
 * file: an entry added there for a cut module, with any hash, would carry
 * an edit or a deletion of that module past the hand-off policy. Forging
 * one now takes the file's exact bytes, which a slice never shows.
 */
export function checkRecordFiles(record: CarveoutRecord, repo: string): void {
  const commit = record.manifest.sourceCommitSha;
  for (const file of [...record.manifest.included, ...(record.extras ?? [])]) {
    const committed = commit === null ? null : gitShow(repo, commit, file.path);
    if (committed !== null && sha256(committed) === file.sha256) continue;
    const current = join(repo, file.path);
    if (
      existsSync(current) &&
      statSync(current).isFile() &&
      sha256(readFileSync(current)) === file.sha256
    )
      continue;
    throw new Error(
      `carveout.json is not one carveout wrote: it lists ${JSON.stringify(file.path)} as a slice file, which the repository does not hold at those bytes. Cut the folder again rather than trust it.`,
    );
  }
}

export interface CheckStep {
  readonly command: string;
  readonly ok: boolean;
  readonly output: string;
  /** Tests that failed in an unedited folder, recorded as its baseline. */
  readonly baseline?: readonly string[];
}

/**
 * Whether the folder holds an edit since the cut, read from the folder
 * alone (a public folder names no repository): a slice file whose bytes
 * differ from what the cut wrote, one gone, or a new source file beside
 * them. What a build emits and what the harness writes do not count.
 */
function folderEdited(dir: string): boolean {
  const root = resolve(dir);
  const record = readRecord(root);
  const written = new Map([
    ...(record.copied ?? []).map((file) => [file.path, file.sha256] as const),
    ...(record.extras ?? []).map((file) => [file.path, file.sha256] as const),
  ]);
  const generated = new Set(record.generated.map((file) => file.path));
  const ignored = new Set(
    existsSync(join(root, ".gitignore"))
      ? readFileSync(join(root, ".gitignore"), "utf8").split("\n").filter(Boolean)
      : [],
  );
  const tree = listTree(root);
  const present = new Set(tree);
  for (const [path, hash] of written) {
    if (!present.has(path)) return true;
    if (sha256(readFileSync(join(root, path))) !== hash) return true;
  }
  return tree.some(
    (path) =>
      !written.has(path) &&
      !generated.has(path) &&
      !ignored.has(path) &&
      path !== RECORD_PATH &&
      path !== "package-lock.json" &&
      !path.startsWith("carveout/") &&
      !(
        /\.[cm]?js$/.test(path) &&
        ["ts", "tsx", "mts", "cts"].some((ext) =>
          present.has(path.replace(/\.[cm]?js$/, `.${ext}`)),
        )
      ),
  );
}

/**
 * The first check of a folder: the tests that fail before any edit fail
 * on the mocks, and are written to its baseline. Only when nothing else
 * failed (the build, the coverage gate) and the folder has no edits nor a
 * baseline yet; null otherwise.
 */
async function recordBaseline(
  source: string,
  work: string,
): Promise<string[] | null> {
  if (existsSync(join(source, BASELINE_PATH))) return null;
  const tap = existsSync(join(work, LAST_RUN_PATH))
    ? readFileSync(join(work, LAST_RUN_PATH), "utf8")
    : "";
  const failing = [
    ...new Set(
      [...tap.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].sort(compare);
  if (failing.length === 0 || /coverage does not meet threshold/.test(tap))
    return null;
  // Records from before `copied` was kept are judged by a patch, as before.
  const edited =
    readRecord(source).copied === undefined
      ? (await patchProject(source)).diff !== ""
      : folderEdited(source);
  if (edited) return null;
  await writeFile(
    join(source, BASELINE_PATH),
    `${JSON.stringify({ failing }, null, 2)}\n`,
  );
  return failing;
}

/**
 * Installs, builds and tests the folder, in a scratch copy so the folder
 * itself is left as it was; stops at the first step that fails.
 */
export async function checkProject(
  dir: string,
  options: {
    readonly inPlace?: boolean;
    /**
     * For a folder that came back from someone else: a scratch HOME and npm
     * cache, so the folder's code cannot read the caller's credentials
     * through them, and no install scripts. Not a sandbox: the folder's
     * tests still run with the caller's user, filesystem and network.
     */
    readonly isolated?: boolean;
  } = {},
): Promise<readonly CheckStep[]> {
  const record = readRecord(dir);
  const source = resolve(dir);
  let work = source;
  const scratch =
    options.inPlace !== true || options.isolated === true
      ? mkdtempSync(join(tmpdir(), "carveout-check-"))
      : null;
  if (options.inPlace !== true && scratch !== null) {
    work = join(scratch, "project");
    execFileSync("cp", ["-R", source, work]);
    await rm(join(work, "node_modules"), { recursive: true, force: true });
  }
  const env: Record<string, string> = {};
  if (options.isolated === true && scratch !== null) {
    await mkdir(join(scratch, "home"), { recursive: true });
    env["HOME"] = join(scratch, "home");
    env["npm_config_cache"] = join(scratch, "npm-cache");
    env["npm_config_userconfig"] = join(scratch, "home", ".npmrc");
  }
  const installFlags = [
    "--no-audit",
    "--no-fund",
    ...(options.isolated === true ? ["--ignore-scripts"] : []),
  ];
  const steps: CheckStep[] = [];
  const run = [
    record.lockfile || existsSync(join(work, "package-lock.json"))
      ? ["npm", "ci", ...installFlags]
      : ["npm", "install", ...installFlags],
    ["npm", "run", "build"],
    ["npm", "test"],
  ];
  await rm(join(work, LAST_RUN_PATH), { force: true });
  for (const argv of run) {
    const [executable = "npm", ...args] = argv;
    try {
      const output = await command(executable, args, {
        cwd: work,
        signal: AbortSignal.timeout(10 * 60_000),
        env,
      });
      steps.push({ command: argv.join(" "), ok: true, output });
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      const baseline =
        argv[1] === "test" ? await recordBaseline(source, work) : null;
      steps.push(
        baseline === null
          ? { command: argv.join(" "), ok: false, output }
          : {
              command: argv.join(" "),
              ok: true,
              output: `${baseline.length} test(s) fail with nothing changed: they fail on the mocks. Recorded in ${BASELINE_PATH}, which npm test reads so they are not counted:\n${baseline.map((name) => `  ${name}`).join("\n")}`,
              baseline,
            },
      );
      if (baseline === null) break;
    }
  }
  if (scratch !== null) await rm(scratch, { recursive: true, force: true });
  return steps;
}


export { undoRewrites } from "./imports.js";

/** An edit the patch cannot carry: the change reaches past the slice. */
export interface BoundaryEdit {
  readonly path: string;
  /**
   * `stub`: a cut module's declarations or its mock; `dependency`: the
   * folder's package.json; `config`: its compiler or runtime
   * configuration; `mock`: the mock runtime or a mock package.
   */
  readonly kind: "stub" | "dependency" | "config" | "mock";
  readonly detail: string;
}

export interface Patch {
  /** A unified diff `git apply` takes at the repository's root. */
  readonly diff: string;
  readonly changed: readonly string[];
  readonly added: readonly string[];
  /** Slice files the folder no longer holds, deleted by the patch. */
  readonly deleted: readonly string[];
  /** Generated files that were edited, which the patch leaves out. */
  readonly generatedEdits: readonly string[];
  /** Of those, the edits that mean the change needs more than the slice. */
  readonly boundary: readonly BoundaryEdit[];
  /**
   * New or changed files that import the folder's harness (`carveout/`),
   * which the repository does not have; the patch leaves them out.
   */
  readonly sliceOnly: readonly string[];
  /** New imports restored as relative paths across packages: no importer names the target. */
  readonly crossPackage: readonly { file: string; specifier: string }[];
  /** Whether the repository's copy moved since the cut. */
  readonly drifted: readonly string[];
  /**
   * Changed files whose base is no blob of the cut's commit (the cut read
   * uncommitted bytes), so `git apply --3way` cannot merge them.
   */
  readonly noThreeWay: readonly string[];
  /**
   * What the hand-off policy keeps out of the patch: new files outside the
   * slice's packages, protected paths, deleted tests. `allow` lets them in.
   */
  readonly refused: readonly Refusal[];
}

export interface PatchOptions {
  /** The repository's checkout; else the one the record names. */
  readonly repo?: string;
  /** Paths and globs the hand-off policy lets through. */
  readonly allow?: readonly string[];
}

function listTree(root: string, dir = "", into: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git")
        listTree(root, path, into);
    } else if (entry.isFile()) into.push(path);
  }
  return into;
}

/** The folder files a cut writes beside its stubs that only the folder runs. */
const HARNESS_FILES = new Set([
  "carveout/mock.js",
  "carveout/mock.d.ts",
  "carveout/assets.js",
  "carveout/ambient.d.ts",
]);
const CONFIG_FILES = new Set([
  "tsconfig.json",
  ".npmrc",
  ".nvmrc",
  "carveout.env",
]);

/** What an edit to a generated file means for the patch, if anything. */
function boundaryEdit(
  root: string,
  path: string,
  record: CarveoutRecord,
  stubFiles: ReadonlyMap<string, string>,
): BoundaryEdit | null {
  const module = stubFiles.get(path);
  if (module !== undefined)
    return {
      path,
      kind: "stub",
      detail: `${module} is cut: the edit to its stub stays in the folder, and the patch does not change ${module}.`,
    };
  if (path === "package.json") {
    let names: string[] = [];
    try {
      const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as Record<
        string,
        Record<string, unknown> | undefined
      >;
      const known = new Set([
        "typescript",
        ...record.dependencies.map((dependency) => dependency.name),
      ]);
      names = [
        ...Object.keys(manifest["dependencies"] ?? {}),
        ...Object.keys(manifest["devDependencies"] ?? {}),
      ]
        .filter((name) => !known.has(name))
        .sort(compare);
    } catch {
      // Not JSON any more: reported as edited.
    }
    return {
      path,
      kind: "dependency",
      detail:
        names.length === 0
          ? "package.json was edited; the repository's package files are not patched."
          : `adds ${names.join(", ")}, which the repository's package files do not get.`,
    };
  }
  if (CONFIG_FILES.has(path))
    return {
      path,
      kind: "config",
      detail: `${path} is the folder's own; the repository's configuration is not patched.`,
    };
  if (HARNESS_FILES.has(path) || path.startsWith("carveout/packages/"))
    return {
      path,
      kind: "mock",
      detail: `${path} is a mock; what it stands in for is outside the slice.`,
    };
  return null;
}

/**
 * The edits made in the folder as a patch for the repository: each slice
 * file that changed or is gone, and each new file outside `carveout/`, with
 * their imports as the repository writes them (`restoreImports`). Built
 * outputs, the generated files and the lockfile are not part of it; edits
 * to generated files that the change needed are reported as `boundary`.
 */
export async function patchProject(
  dir: string,
  options: PatchOptions = {},
): Promise<Patch> {
  const root = resolve(dir);
  const record = readRecord(root);
  const repo = trustedRepo(record, options.repo);
  checkRecordFiles(record, repo);
  const rewritesOf = new Map<string, ImportRewrite[]>();
  for (const rewrite of record.importRewrites)
    rewritesOf.set(rewrite.file, [
      ...(rewritesOf.get(rewrite.file) ?? []),
      rewrite,
    ]);
  const generated = new Map(record.generated.map((g) => [g.path, g.sha256]));
  const included = new Map(
    record.manifest.included.map((file) => [file.path, file.sha256]),
  );
  // A copied folder's files are the repository's too: edited, they are
  // in the patch against the repository's copy.
  for (const extra of record.extras ?? []) included.set(extra.path, extra.sha256);
  const ignored = new Set(
    readFileSync(join(root, ".gitignore"), "utf8").split("\n").filter(Boolean),
  );
  const stubModules = new Set([
    ...record.manifest.cuts.outbound.map((edge) => edge.to),
    ...record.dependencies
      .filter((dependency) => dependency.kind === "module")
      .map((dependency) => dependency.name),
  ]);
  // Stubs `apply --stubs` wrote for modules the change needs.
  for (const file of record.generated)
    if (/\.d\.ts$/.test(file.path) && !file.path.startsWith("carveout/"))
      stubModules.add(file.path.replace(/\.d\.ts$/, ".ts"));
  const stubFiles = new Map<string, string>();
  for (const module of stubModules) {
    stubFiles.set(declarationPath(module), module);
    stubFiles.set(runtimePath(module), module);
  }
  const tree = listTree(root).sort(compare);
  const present = new Set(tree);
  const sources = new Set(
    tree.filter(
      (path) =>
        !generated.has(path) &&
        !path.startsWith("carveout/") &&
        path !== RECORD_PATH,
    ),
  );
  const packageOf = packageFolder(repo);
  // The packages the slice holds files of: where a new file may go.
  const packages = new Set(
    [...included.keys()].map((path) => packageOf(path)),
  );
  const judge = handoffPolicy({
    packages,
    packageOf,
    reach: true,
    integrity: true,
    checks: true,
    ...(options.allow === undefined ? {} : { allow: options.allow }),
  });
  const refused: Refusal[] = [];
  /** Whether the policy lets `path` into the patch; a refusal is named. */
  const admits = (
    path: string,
    change: "added" | "changed" | "deleted",
    texts?: { readonly before: string | null; readonly after: string },
  ) => {
    const reason = judge(path, change, texts);
    if (reason !== null) refused.push({ path, reason });
    return reason === null;
  };
  const edges = [
    ...record.manifest.internalImports,
    ...record.manifest.cuts.outbound,
    ...record.manifest.cuts.inbound,
  ].flatMap((edge) =>
    edge.specifier === null
      ? []
      : [{ from: edge.from, to: edge.to, specifier: edge.specifier }],
  );
  const context: ImportContext = {
    edges,
    files: sources,
    stubs: stubModules,
    packageOf,
    extensionStyle: extensionStyles(edges, packageOf),
  };
  // What `npm run build` wrote for a source the folder's edits added.
  const emitted = (path: string) =>
    /\.[cm]?js$/.test(path) &&
    ["ts", "tsx", "mts", "cts"].some((ext) =>
      present.has(path.replace(/\.[cm]?js$/, `.${ext}`)),
    );
  /** Imports a restored text still makes of the folder's harness. */
  const harnessImport = (path: string, text: string) =>
    [...specifiersOf(text, path)].some(
      (specifier) =>
        specifier.startsWith(".") &&
        posix
          .normalize(posix.join(posix.dirname(path), specifier))
          .startsWith("carveout/"),
    );
  const scratch = mkdtempSync(join(tmpdir(), "carveout-patch-"));
  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const generatedEdits: string[] = [];
  const boundary: BoundaryEdit[] = [];
  const sliceOnly: string[] = [];
  const crossPackage: { file: string; specifier: string }[] = [];
  const drifted: string[] = [];
  const noThreeWay: string[] = [];
  /**
   * The bytes the cut read for an included file, from the commit when the
   * checkout still has them there, else the checkout's file if it has not
   * moved; otherwise null, and the patch is against what the cut copied.
   */
  const readBase = (path: string, original: string) => {
    const repoPath = join(repo, path);
    const current = existsSync(repoPath) ? readFileSync(repoPath) : null;
    const committed =
      record.manifest.sourceCommitSha === null
        ? null
        : gitShow(repo, record.manifest.sourceCommitSha, path);
    const moved = current === null || sha256(current) !== original;
    return {
      moved,
      // `--3way` finds the base by its blob id, which only a committed
      // base has; nothing is ever written to the repository's objects.
      threeWay: committed !== null && sha256(committed) === original,
      bytes: moved ? committed : current,
    };
  };
  const baseOf = (path: string, original: string) => {
    const base = readBase(path, original);
    if (base.moved) drifted.push(path);
    if (!base.threeWay) noThreeWay.push(path);
    return base.bytes;
  };
  /** Whether two of the file's specifiers were rewritten to one. */
  const ambiguous = (rewrites: readonly ImportRewrite[]) =>
    new Set(rewrites.map((rewrite) => rewrite.to)).size <
    new Set(rewrites.map((rewrite) => `${rewrite.to}\n${rewrite.from}`)).size;
  try {
    for (const path of tree) {
      if (
        path === RECORD_PATH ||
        path === "package-lock.json" ||
        ignored.has(path)
      )
        continue;
      const bytes = await readFile(join(root, path));
      const text = bytes.toString("utf8");
      const hash = generated.get(path);
      if (hash !== undefined) {
        if (sha256(text) !== hash) {
          generatedEdits.push(path);
          const edit = boundaryEdit(root, path, record, stubFiles);
          if (edit !== null) boundary.push(edit);
        }
        continue;
      }
      const original = included.get(path);
      if (original === undefined) {
        if (path.startsWith("carveout/") || emitted(path)) continue;
        let content: Buffer = bytes;
        if (isScript(path)) {
          const restored = restoreImports(path, text, null, [], context);
          if (harnessImport(path, restored.text)) {
            sliceOnly.push(path);
            continue;
          }
          for (const specifier of restored.crossPackage)
            crossPackage.push({ file: path, specifier });
          content = Buffer.from(restored.text);
        }
        // A new script's reach is judged on its text: new code runs beside
        // the whole repository once the patch is applied.
        if (!admits(path, "added", isBinaryPath(path) ? undefined : { before: null, after: content.toString("utf8") }))
          continue;
        added.push(path);
        await mkdir(dirname(join(scratch, "b", path)), { recursive: true });
        await writeFile(join(scratch, "b", path), content);
        continue;
      }
      const rewrites = rewritesOf.get(path) ?? [];
      if (isBinaryPath(path)) {
        if (sha256(bytes) === original) continue;
      } else if (
        sha256(
          undoRewrites(
            text,
            rewrites,
            ambiguous(rewrites)
              ? (readBase(path, original).bytes?.toString("utf8") ?? null)
              : null,
            path,
          ),
        ) === original
      )
        continue;
      const base = baseOf(path, original);
      let restored: Buffer = bytes;
      if (!isBinaryPath(path) && isScript(path)) {
        const result = restoreImports(
          path,
          text,
          base === null ? null : base.toString("utf8"),
          rewrites,
          context,
        );
        if (sha256(result.text) === original) continue;
        if (harnessImport(path, result.text)) {
          sliceOnly.push(path);
          continue;
        }
        for (const specifier of result.crossPackage)
          crossPackage.push({ file: path, specifier });
        restored = Buffer.from(result.text);
      }
      if (
        !admits(
          path,
          "changed",
          isBinaryPath(path)
            ? undefined
            : { before: base === null ? null : base.toString("utf8"), after: restored.toString("utf8") },
        )
      )
        continue;
      changed.push(path);
      await mkdir(dirname(join(scratch, "a", path)), { recursive: true });
      await mkdir(dirname(join(scratch, "b", path)), { recursive: true });
      await writeFile(join(scratch, "a", path), base ?? "");
      await writeFile(join(scratch, "b", path), restored);
    }
    for (const [path, original] of [...included.entries()].sort(([a], [b]) =>
      compare(a, b),
    )) {
      if (present.has(path)) continue;
      if (!admits(path, "deleted")) continue;
      deleted.push(path);
      const base = baseOf(path, original);
      await mkdir(dirname(join(scratch, "a", path)), { recursive: true });
      await writeFile(join(scratch, "a", path), base ?? "");
    }
    let diff = "";
    if (changed.length + added.length + deleted.length > 0) {
      // A scratch repository holding the bases, with the edits staged on
      // top: its diff names every path as the repository does.
      const repoDir = join(scratch, "repo");
      const run = (args: readonly string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=carveout",
            "-c",
            "user.email=carveout@localhost",
            "-c",
            "core.autocrlf=false",
            ...args,
          ],
          {
            cwd: repoDir,
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 256 * 1024 * 1024,
          },
        ).toString("utf8");
      await mkdir(repoDir, { recursive: true });
      run(["init", "-q"]);
      for (const path of [...changed, ...deleted]) {
        await mkdir(dirname(join(repoDir, path)), { recursive: true });
        await writeFile(join(repoDir, path), readFileSync(join(scratch, "a", path)));
      }
      run(["add", "-A"]);
      run(["commit", "-q", "--allow-empty", "-m", "base"]);
      for (const path of [...changed, ...added]) {
        await mkdir(dirname(join(repoDir, path)), { recursive: true });
        await writeFile(join(repoDir, path), readFileSync(join(scratch, "b", path)));
      }
      for (const path of deleted) await rm(join(repoDir, path));
      run(["add", "-A"]);
      // Full blob ids on the index lines: `git apply --3way` merges with
      // them against the commit the cut read when the file has moved. A
      // rename is a deletion and an addition, which `--3way` takes.
      diff = run([
        "diff",
        "--cached",
        "--no-color",
        "--no-renames",
        "--binary",
        "--full-index",
      ]);
    }
    return {
      diff,
      changed,
      added,
      deleted,
      generatedEdits,
      boundary,
      sliceOnly,
      crossPackage,
      drifted,
      noThreeWay,
      refused,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
