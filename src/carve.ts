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
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { command } from "./command.js";
import {
  SLICE_BUDGET_DEFAULTS,
  detectExternals,
  generateProject,
  isSecretPath,
  packageNameOf,
  reach,
  renderBoundaryMarkdown,
  resolveScope,
  type BoundaryContract,
  type DependencyChoice,
  type GeneratedFile,
  type ImportRewrite,
  type ProjectBlocker,
  type ReachResult,
  type ResolvedDependency,
  type SliceBudget,
  type SliceManifest,
  type SliceExternals,
} from "./core.js";
import { analyseSlice } from "./cut.js";
import {
  nearestCompilerOptions,
  workspacePackages,
} from "./extract/compiler-config.js";
import { packageModules, packageUses } from "./extract/fixture.js";
import { npmPackageTypes, typesPackageOf } from "./extract/package-types.js";
import { NODE_BUILTINS, isNodeBuiltin } from "./extract/typescript.js";
import { buildGraph } from "./graph.js";

export const CARVEOUT_VERSION = "0.1.0";
export const RECORD_PATH = "carveout.json";
export const RECORD_SCHEMA_VERSION = 1;
export const BOUNDARY_PATH = "BOUNDARY.md";
export const CONTRACT_PATH = "carveout/contract.json";

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
}

/** What a cut of the request would hold, from the import graph alone. */
export function planSlice(request: SliceRequest): Plan {
  const repo = resolve(request.repo);
  const budget = request.budget ?? SLICE_BUDGET_DEFAULTS;
  const entryPoints = entriesOf(request);
  const built = buildGraph(repo);
  const walk = reach(built.graph, entryPoints, budget);
  const externals = detectExternals(
    walk.included.map((path) => ({
      path,
      text: readFileSync(join(repo, path), "utf8"),
    })),
  );
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
  readonly log?: (line: string) => void;
}

/** What `carveout.json` holds: the cut, and how to undo its rewrites. */
export interface CarveoutRecord {
  readonly schemaVersion: typeof RECORD_SCHEMA_VERSION;
  readonly carveoutVersion: string;
  /** The checkout the slice was cut from, as given. */
  readonly repo: string;
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
  };
  /**
   * The repository's files the cut resolved with, beyond the slice: compiler
   * and package configuration, workspace manifests and lockfiles.
   */
  readonly inputs: readonly { path: string; sha256: string | null }[];
}

export interface CutResult {
  readonly out: string;
  readonly record: CarveoutRecord;
  readonly contract: BoundaryContract;
}

/** A name npm accepts for the folder's package. */
function projectName(repo: string, entries: readonly string[]): string {
  const words = [basename(repo), ...entries.map((entry) => basename(entry))]
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
        if (typeof version === "string") return version;
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
export async function computeCut(
  request: Omit<CutRequest, "out">,
): Promise<ComputedCut> {
  const repo = resolve(request.repo);
  const log = request.log ?? (() => {});
  const budget = request.budget ?? SLICE_BUDGET_DEFAULTS;
  const entryPoints = entriesOf(request);
  const built = buildGraph(repo);
  log(`Read the imports of ${built.files.length} files.`);
  const commitSha = git(repo, ["rev-parse", "HEAD"]);
  const signal = AbortSignal.timeout(15 * 60_000);
  const analysis = await analyseSlice({
    sourceDir: repo,
    graph: built.graph,
    params: { entryPoints, budget, includeInferred: false },
    source: {
      commitSha,
      isDirty: (paths) =>
        commitSha !== null &&
        (git(repo, ["status", "--porcelain", "--", ...paths]) ?? "") !== "",
    },
    signal,
    log,
    widenLiterals: request.widenLiterals === true,
    ...(request.offline === true
      ? {}
      : {
          packageTypes: npmPackageTypes({
            root: join(carveoutHome(), "types"),
          }),
        }),
  });
  const { manifest, contract, contractJson } = analysis;
  const scope = resolveScope({
    manifest,
    contract,
    ...(request.choices === undefined ? {} : { choices: request.choices }),
  });
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
  const uses = packageUses(
    new Map([...sources, ...stubs].map((file) => [file.path, file.text])),
    (specifier) =>
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      (packageNames.has(packageNameOf(specifier)) ||
        isNodeBuiltin(specifier)),
  );
  const first = manifest.included[0]?.path;
  const compilerOptions =
    first === undefined ? undefined : nearestCompilerOptions(repo, first);
  const project = generateProject({
    origin: {
      repository: basename(repo),
      name: projectName(repo, entryPoints),
    },
    manifest,
    contract,
    sources,
    stubs,
    dependencies: scope.dependencies,
    knownSpecifiers: NODE_BUILTINS,
    packageModules: packageModules(uses, (specifier) =>
      installed.has(packageNameOf(specifier)),
    ),
    ...(compilerOptions === undefined ? {} : { compilerOptions }),
  });
  // Peers the installed packages need, and packages asked for by name
  // that the slice does not import, as the repository installs them.
  const required = new Set(
    manifest.requiredBuildInputs.packages.map((item) => item.name),
  );
  const asked = Object.entries(request.choices ?? {})
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
  const includedPaths = manifest.included.map((file) => file.path);
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
  const sorted = (record: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(record).sort(([a], [b]) => compare(a, b)),
    );
  const projectFiles = project.files.map((file) => {
    if (
      file.path !== "package.json" ||
      peers.length + typesPackages.length === 0
    )
      return file;
    const manifestJson = JSON.parse(file.text) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
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
      path: BOUNDARY_PATH,
      text: renderBoundaryMarkdown(contract, manifest),
      class: "config",
      public: true,
    },
    {
      path: CONTRACT_PATH,
      text: `${JSON.stringify(withoutCommit(JSON.parse(contractJson)), null, 2)}\n`,
      class: "config",
      public: true,
    },
  ];
  const files = [...projectFiles, ...extra];
  const blockers: CarveoutRecord["blockers"] = [
    ...manifest.blockers.map(({ code, file, detail }) => ({
      code,
      file,
      detail,
    })),
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
    contract,
    record: {
      schemaVersion: RECORD_SCHEMA_VERSION,
      carveoutVersion: CARVEOUT_VERSION,
      repo,
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
        widenLiterals: request.widenLiterals === true,
      },
      inputs: resolutionInputs(repo, manifest.requiredBuildInputs.configs),
    },
  };
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
  const { files, binaries, record: computed, contract } = await computeCut(request);
  for (const file of files) {
    const path = join(out, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.text, "utf8");
  }
  for (const path of binaries) {
    await mkdir(dirname(join(out, path)), { recursive: true });
    await copyFile(join(repo, path), join(out, path));
  }
  log(`Wrote ${files.length + binaries.length} files to ${out}.`);
  let lockfile = false;
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
      log(
        `No lockfile: ${error instanceof Error ? error.message : String(error)}. \`npm install\` makes one.`,
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
  const record: CarveoutRecord = { ...computed, generated, lockfile };
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
  return record;
}

export interface CheckStep {
  readonly command: string;
  readonly ok: boolean;
  readonly output: string;
}

/**
 * Installs, builds and tests the folder, in a scratch copy so the folder
 * itself is left as it was; stops at the first step that fails.
 */
export async function checkProject(
  dir: string,
  options: { readonly inPlace?: boolean } = {},
): Promise<readonly CheckStep[]> {
  const record = readRecord(dir);
  const source = resolve(dir);
  let work = source;
  if (options.inPlace !== true) {
    work = join(mkdtempSync(join(tmpdir(), "carveout-check-")), "project");
    execFileSync("cp", ["-R", source, work]);
    await rm(join(work, "node_modules"), { recursive: true, force: true });
  }
  const steps: CheckStep[] = [];
  const run = [
    record.lockfile || existsSync(join(work, "package-lock.json"))
      ? ["npm", "ci", "--no-audit", "--no-fund"]
      : ["npm", "install", "--no-audit", "--no-fund"],
    ["npm", "run", "build"],
    ["npm", "test"],
  ];
  for (const argv of run) {
    const [executable = "npm", ...args] = argv;
    try {
      const output = await command(executable, args, {
        cwd: work,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      steps.push({ command: argv.join(" "), ok: true, output });
    } catch (error) {
      steps.push({
        command: argv.join(" "),
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  if (work !== source)
    await rm(dirname(work), { recursive: true, force: true });
  return steps;
}

/** `text` with the folder's import rewrites put back as the source wrote them. */
export function undoRewrites(
  text: string,
  rewrites: readonly ImportRewrite[],
): string {
  if (rewrites.length === 0) return text;
  const back = new Map(rewrites.map((rewrite) => [rewrite.to, rewrite.from]));
  return text.replace(
    /((?:\bimport|\bexport)\s+(?:type\s+)?(?:[^'";\s][^'";]*?\sfrom\s+)?|\brequire\(\s*|\bimport\(\s*)(['"])([^'"\n]+)\2/g,
    (whole, prefix: string, quote: string, specifier: string) => {
      const from = back.get(specifier);
      return from === undefined ? whole : `${prefix}${quote}${from}${quote}`;
    },
  );
}

export interface Patch {
  /** A unified diff `git apply` takes at the repository's root. */
  readonly diff: string;
  readonly changed: readonly string[];
  readonly added: readonly string[];
  /** Generated files that were edited, which the patch leaves out. */
  readonly generatedEdits: readonly string[];
  /** Whether the repository's copy moved since the cut. */
  readonly drifted: readonly string[];
  /**
   * Changed files whose base is no blob of the cut's commit (the cut read
   * uncommitted bytes), so `git apply --3way` cannot merge them.
   */
  readonly noThreeWay: readonly string[];
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

/**
 * The edits made in the folder as a patch for the repository: each slice
 * file that changed, with the import rewrites undone, and each new script
 * file outside `carveout/`. Built outputs, the generated files and the
 * lockfile are not part of it.
 */
export async function patchProject(dir: string): Promise<Patch> {
  const root = resolve(dir);
  const record = readRecord(root);
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
  const ignored = new Set(
    readFileSync(join(root, ".gitignore"), "utf8").split("\n").filter(Boolean),
  );
  const scratch = mkdtempSync(join(tmpdir(), "carveout-patch-"));
  const changed: string[] = [];
  const added: string[] = [];
  const generatedEdits: string[] = [];
  const drifted: string[] = [];
  const noThreeWay: string[] = [];
  try {
    for (const path of listTree(root).sort(compare)) {
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
        if (sha256(text) !== hash) generatedEdits.push(path);
        continue;
      }
      const original = included.get(path);
      if (original === undefined) {
        if (path.startsWith("carveout/")) continue;
        added.push(path);
        await mkdir(dirname(join(scratch, "b", path)), { recursive: true });
        await writeFile(join(scratch, "b", path), bytes);
        continue;
      }
      const restored = isBinaryPath(path)
        ? bytes
        : Buffer.from(undoRewrites(text, rewritesOf.get(path) ?? []));
      if (sha256(restored) === original) continue;
      changed.push(path);
      // The original is the bytes the cut read, from the commit when the
      // checkout still has them there, else the checkout's file if it has
      // not moved; otherwise the patch is against what the cut copied.
      const repoPath = join(record.repo, path);
      const current = existsSync(repoPath) ? readFileSync(repoPath) : null;
      if (current === null || sha256(current) !== original) drifted.push(path);
      const committed =
        record.manifest.sourceCommitSha === null
          ? null
          : gitShow(record.repo, record.manifest.sourceCommitSha, path);
      // `--3way` finds the base by its blob id, which only a committed
      // base has; nothing is ever written to the repository's objects.
      if (committed === null || sha256(committed) !== original)
        noThreeWay.push(path);
      const base =
        current !== null && sha256(current) === original ? current : committed;
      await mkdir(dirname(join(scratch, "a", path)), { recursive: true });
      await mkdir(dirname(join(scratch, "b", path)), { recursive: true });
      await writeFile(join(scratch, "a", path), base ?? "");
      await writeFile(join(scratch, "b", path), restored);
    }
    let diff = "";
    if (changed.length + added.length > 0) {
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
      for (const path of changed) {
        await mkdir(dirname(join(repoDir, path)), { recursive: true });
        await writeFile(join(repoDir, path), readFileSync(join(scratch, "a", path)));
      }
      run(["add", "-A"]);
      run(["commit", "-q", "--allow-empty", "-m", "base"]);
      for (const path of [...changed, ...added]) {
        await mkdir(dirname(join(repoDir, path)), { recursive: true });
        await writeFile(join(repoDir, path), readFileSync(join(scratch, "b", path)));
      }
      run(["add", "-A"]);
      // Full blob ids on the index lines: `git apply --3way` merges with
      // them against the commit the cut read when the file has moved.
      diff = run([
        "diff",
        "--cached",
        "--no-color",
        "--no-renames",
        "--binary",
        "--full-index",
      ]);
    }
    return { diff, changed, added, generatedEdits, drifted, noThreeWay };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
