/**
 * The cut: from the checkout's import graph and its files, the files a
 * slice needs and the shape of their boundary.
 *
 * Walks the graph with `reach`, reads the included files, extracts
 * signatures for the cut modules and the public surface (TypeScript and
 * JavaScript; other languages get names only), compiles the fixture with
 * the stubs in place, and assembles the manifest and the contract. A pure
 * function of the graph, the source bytes and the request, apart from the
 * package types it may fetch.
 */

import { constants, readFileSync, type Stats } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  BOUNDARY_CONTRACT_SCHEMA_VERSION,
  IMPLICIT_ANY_CODE,
  OPERATION_POLICY,
  SLICE_MANIFEST_SCHEMA_VERSION,
  SLICE_TOOL_VERSION,
  canonicalJson,
  detectExternals,
  isPackageName,
  isRegistryVersion,
  isSecretPath,
  pathMatcher,
  purityRules,
  reach,
  sliceReadiness,
} from "./core.js";
import { catalogResolver } from "./project/catalog.js";
import { testRunnerResolver } from "./project/runner.js";
import type {
  BoundaryContract,
  BoundaryModule,
  CompilationResult,
  CutEdge,
  PackageRegistry,
  ReachResult,
  IncludedFile,
  SliceBlocker,
  SliceExternals,
  SliceGraph,
  SliceManifest,
  SliceParams,
  StubCoverage,
  SyntheticFile,
} from "./core.js";
import {
  workspaceModuleResolver,
  workspacePackages,
} from "./extract/compiler-config.js";
import {
  lockIntegrities,
  packageRegistries,
  publicByIntegrity,
} from "./extract/package-registry.js";
import { workspaceImportersOf } from "./graph.js";
import { packageFolder } from "./imports.js";
import {
  DIAGNOSTICS_MAX,
  SHIM_PATH,
  compileFixture,
  packageShim,
  packageUses,
  UNTYPED_PACKAGE_CODES,
  UNTYPED_PACKAGE_OPTIONS,
} from "./extract/fixture.js";
import { gitBlobId, gitFileMode, sha256 } from "./extract/hash.js";
import {
  lockedSpec,
  typesPackageOf,
  type PackageTypes,
  type PackageTypesFetcher,
  type PackageTypesRequest,
} from "./extract/package-types.js";
import {
  declarationPathFor,
  extractTypeScriptBoundary,
  isNodeBuiltin,
  isDataPath,
  isScriptPath,
  packageNameOf,
} from "./extract/typescript.js";

/** Why a cut could not be made at all, as opposed to a blocker it reports. */
export class CutError extends Error {}

/** Bytes of included source one slice may copy. */
export const INCLUDED_BYTES_MAX = 64 * 1024 * 1024;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** "Cannot find module": what no package's types explain. */
const UNRESOLVED_MODULE_CODES: readonly string[] = ["TS2307", "TS2792"];

const edgeKey = (edge: CutEdge) =>
  `${edge.from}\n${edge.to}\n${edge.relation}\n${edge.specifier ?? ""}\n${edge.location ?? ""}`;

/** Edges in `reach`'s order, each once. */
function sortEdges(edges: readonly CutEdge[]): CutEdge[] {
  return [...new Map(edges.map((edge) => [edgeKey(edge), edge])).values()].sort(
    (a, b) => compare(edgeKey(a), edgeKey(b)),
  );
}

/** A repository file's text, or null when it is missing or outside. */
async function readSource(root: string, path: string): Promise<string | null> {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return readFile(absolute, "utf8").catch(() => null);
}

const catalogs = new Map<string, (name: string, version: string) => string>();
/** The repository's `catalog:` resolver, read once per root. */
function catalogOf(root: string): (name: string, version: string) => string {
  let resolver = catalogs.get(root);
  if (resolver === undefined) {
    resolver = catalogResolver(root);
    catalogs.set(root, resolver);
  }
  return resolver;
}

/**
 * The version a package.json nearest the importing file pins, if any; a
 * `catalog:` pin as the workspace's catalog gives it.
 */
async function pinnedVersion(
  root: string,
  from: string,
  name: string,
  cache: Map<string, Record<string, string> | null>,
): Promise<{ version: string | null; declaredIn: string | null }> {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    if (dir === "." || dir === "" || dir === "/") dir = "";
    const path = dir === "" ? "package.json" : `${dir}/package.json`;
    let declared = cache.get(path);
    if (declared === undefined) {
      declared = null;
      try {
        const parsed = JSON.parse(
          await readFile(join(root, path), "utf8"),
        ) as Record<string, unknown>;
        const merged: Record<string, string> = {};
        for (const key of [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ]) {
          const section = parsed[key];
          if (section !== null && typeof section === "object")
            for (const [dependency, version] of Object.entries(section))
              if (typeof version === "string") merged[dependency] ??= version;
        }
        declared = merged;
      } catch {
        declared = null;
      }
      cache.set(path, declared);
    }
    const version = declared?.[name];
    if (version !== undefined)
      return { version: catalogOf(root)(name, version), declaredIn: path };
    if (dir === "") return { version: null, declaredIn: null };
  }
}

/**
 * The fields of the `package.json` nearest each file that decide how the
 * file compiles: `type`, whether NodeNext reads it as an ES module, and
 * `imports`, where its `#` specifiers resolve. Keyed by the manifest's path.
 */
async function packageScopes(
  root: string,
  files: readonly string[],
): Promise<Map<string, string>> {
  const scopes = new Map<string, string>();
  const absent = new Set<string>();
  for (const file of files)
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      if (dir === "." || dir === "/") dir = "";
      const path = dir === "" ? "package.json" : `${dir}/package.json`;
      if (scopes.has(path)) break;
      if (!absent.has(path)) {
        const text = await readFile(join(root, path), "utf8").catch(() => null);
        if (text !== null) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          const own =
            parsed !== null && typeof parsed === "object"
              ? (parsed as Record<string, unknown>)
              : {};
          scopes.set(
            path,
            `${JSON.stringify({ type: own["type"], imports: own["imports"] })}\n`,
          );
          break;
        }
        absent.add(path);
      }
      if (dir === "") break;
    }
  return scopes;
}

async function readIncluded(
  sourceDir: string,
  files: readonly string[],
): Promise<Map<string, { bytes: Buffer; file: IncludedFile }>> {
  const result = new Map<string, { bytes: Buffer; file: IncludedFile }>();
  let total = 0;
  for (const path of files) {
    const absolute = resolve(sourceDir, path);
    const rel = relative(sourceDir, absolute);
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "")
      throw new CutError(`${path} is outside the repository.`);
    // One handle for the check and the read, so the file cannot be swapped
    // between them; a symlink fails to open, and a FIFO opens without
    // blocking and then fails the regular-file check.
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => null);
    if (handle === null)
      throw new CutError(`${path} cannot be read (a symbolic link is not copied).`);
    let stats: Stats;
    let bytes: Buffer;
    try {
      stats = await handle.stat();
      if (!stats.isFile()) throw new CutError(`${path} is not a regular file.`);
      total += stats.size;
      if (total > INCLUDED_BYTES_MAX)
        throw new CutError(
          `The slice holds more than ${INCLUDED_BYTES_MAX / 1024 / 1024} MB of source; narrow the entry points or the budget.`,
        );
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    result.set(path, {
      bytes,
      file: {
        path,
        blobId: gitBlobId(bytes),
        sha256: sha256(bytes),
        mode: gitFileMode(stats),
        sizeBytes: bytes.byteLength,
        operations: ["edit"],
      },
    });
  }
  return result;
}

function namesOnly(
  edges: readonly { to: string; from: string }[],
  side: "to" | "from",
): BoundaryModule[] {
  const modules = new Map<
    string,
    { symbols: Set<string>; importedBy: Set<string> }
  >();
  for (const edge of edges) {
    const module = side === "to" ? edge.to : edge.from;
    const by = side === "to" ? edge.from : edge.to;
    const entry = modules.get(module) ?? {
      symbols: new Set(),
      importedBy: new Set(),
    };
    entry.importedBy.add(by);
    modules.set(module, entry);
  }
  return [...modules.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([module, entry]) => ({
      module,
      symbols: [...entry.symbols].sort(compare).map((name) => ({
        name,
        kind: "unknown",
        declaration: null,
      })),
      importedBy: [...entry.importedBy].sort(compare),
      stubPath: null,
    }));
}

/** Everything a slice of one request is, before anything is written. */
export interface SliceAnalysis {
  readonly manifest: SliceManifest;
  readonly contract: BoundaryContract;
  readonly contractJson: string;
  readonly stubs: readonly { path: string; module: string; text: string }[];
  /** The public surface's declarations and check; see `surfaceFiles`. */
  readonly surface: readonly { path: string; text: string }[];
  readonly ready: boolean;
  /**
   * Whether the slice compiles with the source's noImplicitAny, so the
   * folder can hold its code to it; false when the source has it off.
   */
  readonly keepsImplicitAny: boolean;
  /**
   * The files where the stubs leave an implicit any, when the source holds
   * its code to noImplicitAny: the folder relaxes it for them alone when
   * nothing else in the slice imports them.
   */
  readonly implicitAnyFiles: readonly string[];
  /** The walk the slice was cut from. */
  readonly walk: ReachResult;
}

/**
 * Slices one request: walks the graph, reads the included files, extracts
 * the boundary, compiles the fixture and assembles the manifest. A pure
 * function of the graph, the source bytes and the parameters; the slice
 * tool writes its result, and the scope agent checks its proposals with it.
 */
export async function analyseSlice(input: {
  readonly sourceDir: string;
  readonly graph: SliceGraph;
  readonly params: SliceParams;
  readonly source: {
    readonly commitSha: string | null;
    /** Whether an included file differs from that commit. */
    readonly isDirty: (paths: readonly string[]) => boolean;
  };
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  /**
   * The externals of the included files when an index already has them
   * all, as `detectExternals` would give them; null to read them here.
   */
  readonly externalsOf?: (included: readonly string[]) => SliceExternals | null;
  /**
   * Fetches the types of the public packages the slice reads; without it,
   * or when it fails, every package is untyped.
   */
  readonly packageTypes?: PackageTypesFetcher;
  /** See `extractTypeScriptBoundary`; true unless told otherwise. */
  readonly widenLiterals?: boolean;
}): Promise<SliceAnalysis> {
  const { params, graph } = input;
  input.signal.throwIfAborted();
  const isPrivate =
    params.private === undefined || params.private.length === 0
      ? null
      : pathMatcher(params.private);
  const reached = reach(graph, params.entryPoints, params.budget, {
    tests: params.tests,
    ...(params.setupFiles === undefined || params.setupFiles.length === 0 ? {} : { roots: params.setupFiles }),
    packageOf: packageFolder(input.sourceDir),
    runnerOf: testRunnerResolver(input.sourceDir, packageFolder(input.sourceDir)),
    ...(params.wholePackage === true ? { wholePackage: true } : {}),
    ...(isPrivate === null ? {} : { isPrivate }),
    ...(params.copyPure === true
      ? {
          pure: purityRules((file) => {
            try {
              return readFileSync(join(input.sourceDir, file), "utf8");
            } catch {
              return null;
            }
          }, isNodeBuiltin),
        }
      : {}),
  });
  // Followed, a workspace import is a link and already an inbound cut;
  // unfollowed, the files importing the slice by a package's name are
  // added, so the public surface counts the other workspaces.
  const walk =
    params.followWorkspaces === true
      ? reached
      : workspaceImportersOf(input.sourceDir)(reached, graph);
  // A folder copied in whole beside the slice (`copy`) is there to be read.
  const copied = pathMatcher(params.copy ?? []);
  input.log(
    `Slice reached ${walk.included.length} files with ${walk.cuts.outbound.length} outbound and ${walk.cuts.inbound.length} inbound cuts.`,
  );
  const blockers: SliceBlocker[] = walk.unknownEntryPoints.map((entry) => ({
    code: "unknown_entry_point",
    file: null,
    location: null,
    detail: `${entry} names no file in the graph.`,
  }));
  // A file that exists to hold credentials never leaves the repository,
  // whatever imports it.
  for (const path of walk.included)
    if (isSecretPath(path))
      blockers.push({
        code: "secret_file",
        file: path,
        location: null,
        detail: `${path} is a credentials file; a slice may not include it. Import fixture values instead.`,
      });
  if (walk.included.length === 0) {
    // Nothing to slice: say which entry points missed before failing.
    throw new CutError(
      blockers.length === 0
        ? "The entry points reach no file."
        : blockers.map((blocker) => blocker.detail).join(" "),
    );
  }
  const included = await readIncluded(input.sourceDir, walk.included);
  input.signal.throwIfAborted();
  const texts = new Map<string, string>();
  for (const [path, { bytes }] of included)
    texts.set(path, bytes.toString("utf8"));
  const externals =
    input.externalsOf?.(walk.included) ??
    detectExternals(
      [...texts.entries()].map(([path, text]) => ({ path, text })),
    );
  const packageFiles = new Map<string, Set<string>>();
  // The source is read without its node_modules, so the graph cannot
  // tell an installed package from a missing one: every bare specifier
  // is a package, pinned or not; a relative path that misses is broken.
  const isBare = (specifier: string | null): specifier is string =>
    specifier !== null &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/");
  // A JSON or stylesheet import does not make a TypeScript slice
  // untyped; code in another language does.
  const scripted =
    walk.included.some(isScriptPath) &&
    walk.included.every((path) => isScriptPath(path) || isDataPath(path));
  // The repository's own packages are not on the registry (or are someone
  // else's there). One whose source the slice can read is a cut module like
  // any other, stubbed from its declarations; the rest are mocked packages.
  const workspaces = workspacePackages(input.sourceDir);
  const workspaceModule = workspaceModuleResolver(
    input.sourceDir,
    () => workspaces,
  );
  // A test brought along may hold a computed import: what it names is the
  // baseline's business, not a blocker (see `reach`).
  const carriedTests = new Set(walk.tests);
  for (const dependency of walk.dependencies) {
    if (dependency.status === "path" && copied(dependency.specifier ?? "")) continue;
    if (dependency.status === "dynamic" && carriedTests.has(dependency.file)) continue;
    // A path read is a repository path, never a package, however it is
    // spelled (`apps/worker/python/extract.py` is no package named `apps`).
    if (dependency.status !== "dynamic" && dependency.status !== "path" && isBare(dependency.specifier)) {
      if (isNodeBuiltin(dependency.specifier)) continue;
      if (scripted && workspaceModule(dependency.specifier) !== null) continue;
      const files = packageFiles.get(dependency.specifier) ?? new Set();
      files.add(dependency.file);
      packageFiles.set(dependency.specifier, files);
    } else
      blockers.push({
        code:
          dependency.status === "dynamic"
            ? "dynamic_dependency"
            : dependency.status === "path"
              ? "path_read"
              : "unresolved_import",
        file: dependency.file,
        location: dependency.location,
        detail:
          dependency.status === "dynamic"
            ? "A dynamic import of a computed name cannot be resolved."
            : dependency.status === "path"
              ? `${dependency.specifier ?? ""} is read by path, and is a folder or a kind of file a slice does not copy: cut again with --copy ${dependency.specifier ?? "<path>"} to bring it.`
              : `${dependency.specifier ?? ""} does not resolve to a repository file.`,
      });
  }
  // A test on Vitest's globals imports no runner; the folder needs it all
  // the same, pinned as the test's package pins it.
  if (walk.globalsTests.length > 0) {
    const files = packageFiles.get("vitest") ?? new Set<string>();
    for (const test of walk.globalsTests) files.add(test);
    packageFiles.set("vitest", files);
  }
  // So does a package whose tests run on Vitest when no test of the slice
  // came along: the tests the contributor writes run on it, as the
  // repository's do. Pinned as the entry points' package pins it.
  if (params.tests && params.testRunner === "vitest") {
    const files = packageFiles.get("vitest") ?? new Set<string>();
    for (const entry of walk.entries) files.add(entry);
    packageFiles.set("vitest", files);
  }
  // A file read by path must be there itself; a stub at its path is not it.
  for (const edge of walk.cuts.outbound)
    if (edge.relation === "reads" && !copied(edge.to))
      blockers.push({
        code: "path_read",
        file: edge.from,
        location: edge.location,
        detail: `${edge.to} is read by path and is outside the slice; raise --depth or add it as an entry point.`,
      });
  let language: BoundaryContract["language"] = "none";
  let extractorVersion: string | null = null;
  let outbound: BoundaryModule[];
  let inbound: BoundaryModule[];
  let stubs: readonly { path: string; module: string; text: string }[] = [];
  let surface: readonly { path: string; text: string }[] = [];
  let configs: string[] = [];
  let keepsImplicitAny = false;
  let implicitAnyFiles: string[] = [];
  let compilation: CompilationResult = {
    attempted: false,
    ok: false,
    diagnostics: [],
    shimmedPackages: [],
  };
  const synthetic: SyntheticFile[] = [];
  let cuts = walk.cuts;
  let internalImports = walk.internal;
  const versions = new Map<string, Record<string, string> | null>();
  // And a package from another registry is not the public one of its name.
  const lockedRegistry = packageRegistries(input.sourceDir);
  // A pnpm lock entry with no URL vouches for nothing alone; its integrity,
  // matched against the public registry's for the same version, does. Only
  // online: an offline cut asks no registry anything.
  const integrities =
    input.packageTypes === undefined ? new Map<string, Map<string, string>>() : lockIntegrities(input.sourceDir);
  const verified = new Map<string, PackageRegistry | null>();
  /** Checks, once each, the packages nothing else shows the registry of. */
  const verify = async (names: Iterable<string>) => {
    const pending = [...new Set(names)].filter(
      (name) => !verified.has(name) && lockedRegistry(name) === null && integrities.has(name),
    );
    for (let at = 0; at < pending.length; at += 8)
      await Promise.all(
        pending.slice(at, at + 8).map(async (name) => {
          const ok = await publicByIntegrity(name, integrities.get(name) ?? new Map(), input.signal);
          verified.set(
            name,
            ok ? { source: "public", evidence: "pnpm-lock.yaml, its integrity the public registry's" } : null,
          );
        }),
      );
  };
  const registryOf = (name: string): PackageRegistry | null =>
    lockedRegistry(name) ?? verified.get(name) ?? null;
  /** The packages a set of imports names, with their `@types`. */
  const withTypes = (files: ReadonlyMap<string, ReadonlySet<string>>) =>
    namesOf(files).flatMap((name) => [name, typesPackageOf(name)]);
  const namesOf = (files: ReadonlyMap<string, ReadonlySet<string>>) =>
    [...new Set([...files.keys()].map(packageNameOf))].sort(compare);
  const importerOf = (
    files: ReadonlyMap<string, ReadonlySet<string>>,
    name: string,
  ) =>
    [...files.entries()]
      .filter(([specifier]) => packageNameOf(specifier) === name)
      .flatMap(([, importers]) => [...importers])
      .sort(compare)[0] ?? "";
  /**
   * What the sandbox must install to build the slice, pinned where the
   * importer's package.json pins it, and the blockers of what is not.
   */
  const requiredPackages = async (
    files: ReadonlyMap<string, ReadonlySet<string>>,
  ) => {
    const required: SliceManifest["requiredBuildInputs"]["packages"][number][] =
      [];
    const unpinned: SliceBlocker[] = [];
    for (const name of namesOf(files)) {
      const from = importerOf(files, name);
      const pinned = await pinnedVersion(input.sourceDir, from, name, versions);
      if (workspaces.has(name)) {
        required.push({ name, ...pinned, workspace: true });
        continue;
      }
      const registry = registryOf(name);
      required.push({
        name,
        ...pinned,
        ...(registry === null ? {} : { registry }),
      });
      // A module that is no package (`virtual:build-info`) is mocked by its
      // name and installed by none: no pin to look for.
      if (pinned.version === null && isPackageName(name))
        unpinned.push({
          code: "missing_build_input",
          file: from === "" ? null : from,
          location: null,
          detail: `${name} is imported but no package.json pins its version.`,
        });
    }
    return { required, unpinned };
  };
  /**
   * The public packages whose types the extractor and the fixture may
   * read: each the repository shows comes from the public registry, at a
   * registry version, with the `@types` package its importer pins beside it.
   */
  const typeRequests = async (
    files: ReadonlyMap<string, ReadonlySet<string>>,
  ) => {
    const requests: PackageTypesRequest[] = [];
    const request = async (name: string, from: string) => {
      const { version } = await pinnedVersion(
        input.sourceDir,
        from,
        name,
        versions,
      );
      if (
        version !== null &&
        isRegistryVersion(version) &&
        registryOf(name)?.source === "public"
      )
        requests.push({
          name,
          spec: lockedSpec(input.sourceDir, name) ?? version,
        });
    };
    // A service package the folder will mock is left untyped here too, so
    // the fixture is checked against the `any` the folder gives it: typed,
    // a callback passed to it would pass the implicit-any probe below and
    // fail the folder's build.
    const services = new Set(
      externals.packages.map((item) => packageNameOf(item.specifier)),
    );
    // A live service package is installed and typed as any other.
    for (const name of input.params.live ?? []) services.delete(name);
    for (const name of namesOf(files)) {
      if (workspaces.has(name) || services.has(name)) continue;
      const from = importerOf(files, name);
      await request(name, from);
      await request(typesPackageOf(name), from);
    }
    return requests;
  };
  if (scripted) {
    language = "typescript";
    const extract = (packageTypes: string | null) =>
      extractTypeScriptBoundary({
        root: input.sourceDir,
        included: walk.included,
        outbound: walk.cuts.outbound,
        inbound: walk.cuts.inbound,
        texts,
        workspaceModule,
        packageTypes,
        widenLiterals: input.widenLiterals ?? true,
      });
    const withPackages = (
      found: ReadonlyMap<string, ReadonlySet<string>>,
    ): Map<string, Set<string>> => {
      const merged = new Map<string, Set<string>>();
      for (const [specifier, files] of [...packageFiles, ...found])
        merged.set(
          specifier,
          new Set([...(merged.get(specifier) ?? []), ...files]),
        );
      return merged;
    };
    let boundary = extract(null);
    input.signal.throwIfAborted();
    // Untyped, the extractor finds which packages the slice reads; typed,
    // it emits the stubs again with what the source infers from them.
    let types: PackageTypes | null = null;
    const requests =
      input.packageTypes === undefined
        ? []
        : (await verify(withTypes(withPackages(boundary.packages))),
          await typeRequests(withPackages(boundary.packages)));
    if (input.packageTypes !== undefined && requests.length > 0) {
      const fetched = await input.packageTypes(requests, input.signal);
      if ("failed" in fetched)
        input.log(
          `Package types could not be fetched (${fetched.failed}); packages stay untyped.`,
        );
      else {
        types = fetched;
        input.log(
          `Read the types of ${fetched.packages.map(({ name, version }) => `${name}@${version}`).join(", ")}.`,
        );
        const known = new Set(namesOf(withPackages(boundary.packages)));
        const typed = extract(fetched.directory);
        input.signal.throwIfAborted();
        // A package only the types name is one of theirs, which they resolve.
        boundary = {
          ...typed,
          packages: new Map(
            [...typed.packages].filter(([specifier]) =>
              known.has(packageNameOf(specifier)),
            ),
          ),
        };
      }
    }
    extractorVersion = boundary.extractorVersion;
    outbound = [...boundary.outbound];
    inbound = [...boundary.inbound];
    stubs = boundary.stubs;
    surface = boundary.surface;
    configs = [...boundary.configs];
    blockers.push(...boundary.blockers);
    cuts = {
      outbound: sortEdges([...cuts.outbound, ...boundary.workspace.outbound]),
      inbound: cuts.inbound,
    };
    internalImports = sortEdges([
      ...internalImports,
      ...boundary.workspace.internal,
    ]);
    for (const [specifier, files] of boundary.packages) {
      const list = packageFiles.get(specifier) ?? new Set();
      for (const file of files) list.add(file);
      packageFiles.set(specifier, list);
    }
    const shimmed = [...new Set([...packageFiles.keys()].map(packageNameOf))];
    const typedNames = new Set(types?.packages.map(({ name }) => name) ?? []);
    const typed = (name: string) =>
      typedNames.has(name) || typedNames.has(typesPackageOf(name));
    const fixture = new Map<string, string>(texts);
    for (const [path, text] of await packageScopes(input.sourceDir, [
      ...walk.included,
      ...stubs.map((stub) => stub.module),
    ]))
      if (!fixture.has(path)) fixture.set(path, text);
    for (const stub of stubs)
      fixture.set(declarationPathFor(stub.module), stub.text);
    // A package of the repository resolves to its stub, or to its source
    // when the slice includes it.
    const stubbed = new Set(stubs.map((stub) => stub.module));
    const stubModules = new Map<string, string>();
    for (const [specifier, module] of boundary.workspace.modules)
      if (stubbed.has(module))
        stubModules.set(specifier, declarationPathFor(module));
      else if (texts.has(module)) stubModules.set(specifier, module);
    // What the slice and its stubs read of each package, so the names it
    // uses as types are declared as types.
    const packageNames = new Set(shimmed);
    const shim = packageShim(
      shimmed,
      packageUses(
        fixture,
        (specifier) =>
          isBare(specifier) &&
          (packageNames.has(packageNameOf(specifier)) ||
            isNodeBuiltin(specifier)),
      ),
      typed,
    );
    fixture.set(SHIM_PATH, shim);
    const compile = (
      files: ReadonlyMap<string, string>,
      modules: ReadonlyMap<string, string>,
      relaxed = true,
    ) =>
      compileFixture({
        root: input.sourceDir,
        files,
        compilerOptions: {
          ...boundary.compilerOptions,
          ...(relaxed ? UNTYPED_PACKAGE_OPTIONS : {}),
        },
        shimmedPackages: shimmed.filter((name) => !typed(name)),
        ignoredCodes: UNTYPED_PACKAGE_CODES,
        modules,
        limit: Infinity,
        packageTypes: types?.directory ?? null,
      });
    compilation = compile(fixture, stubModules);
    if (types !== null)
      compilation = {
        ...compilation,
        typedPackages: [...types.packages].sort((a, b) =>
          compare(a.name, b.name),
        ),
      };
    if (!compilation.ok) {
      // The same check with the source's own code in place of the stubs.
      // What fails there too is what declaring the packages untyped costs,
      // since the repository compiles against their real types; only what
      // the stubs add counts against the slice. The sandbox build checks
      // the rest against the packages it installs.
      const own = new Map(fixture);
      for (const stub of stubs) {
        own.delete(declarationPathFor(stub.module));
        const text = await readSource(input.sourceDir, stub.module);
        if (text !== null) own.set(stub.module, text);
      }
      const baseline = compile(own, boundary.workspace.modules);
      const key = (diagnostic: CompilationResult["diagnostics"][number]) =>
        `${diagnostic.file ?? ""}\n${diagnostic.line ?? ""}\n${diagnostic.code}\n${diagnostic.message}`;
      // An import that resolves nowhere is never the packages' types.
      const inherited = new Set(
        baseline.diagnostics
          .filter(({ code }) => !UNRESOLVED_MODULE_CODES.includes(code))
          .map(key),
      );
      const added = compilation.diagnostics.filter(
        (diagnostic) => !inherited.has(key(diagnostic)),
      );
      const untyped = compilation.diagnostics.filter((diagnostic) =>
        inherited.has(key(diagnostic)),
      );
      compilation = {
        ...compilation,
        ok: added.length === 0,
        diagnostics: added,
        untypedPackageErrors: untyped,
      };
    }
    // The folder keeps the source's noImplicitAny when the slice compiles
    // under it with its stubs and untyped packages; otherwise the folder
    // relaxes it, and the record says so.
    const options = boundary.compilerOptions as Record<string, unknown>;
    const sourceImplicitAny =
      options["noImplicitAny"] === true ||
      (options["noImplicitAny"] === undefined && options["strict"] === true);
    if (sourceImplicitAny && compilation.ok) {
      // The implicit-any family (TS7xxx but the checks that share it).
      const implicitCode = new RegExp(`^(TS)?${IMPLICIT_ANY_CODE}$`);
      const implicit = compile(fixture, stubModules, false).diagnostics.filter(({ code }) => implicitCode.test(String(code)));
      keepsImplicitAny = implicit.length === 0;
      implicitAnyFiles = [...new Set(implicit.flatMap((d) => (d.file === undefined || d.file === null ? [] : [String(d.file)])))].sort();
      if (!keepsImplicitAny)
        input.log(
          `The folder keeps noImplicitAny; its build does not count the ${implicit.length} implicit any(s) the stubs leave (${implicit
            .slice(0, 3)
            .map((d) => `${d.file ?? ""}:${d.line ?? ""} ${d.code}`)
            .join(", ")}).`,
        );
    }
    compilation = {
      ...compilation,
      diagnostics: compilation.diagnostics.slice(0, DIAGNOSTICS_MAX),
      ...(compilation.untypedPackageErrors === undefined
        ? {}
        : {
            untypedPackageErrors: compilation.untypedPackageErrors.slice(
              0,
              DIAGNOSTICS_MAX,
            ),
          }),
    };
    for (const diagnostic of compilation.diagnostics.slice(0, 20))
      blockers.push({
        code: "compile_error",
        file: diagnostic.file,
        location: diagnostic.line === null ? null : `L${diagnostic.line}`,
        detail: `${diagnostic.code}: ${diagnostic.message}`,
      });
    synthetic.push({
      path: SHIM_PATH,
      kind: "shim",
      generator: "slice",
      generatorVersion: SLICE_TOOL_VERSION,
      sha256: sha256(shim),
      sizeBytes: Buffer.byteLength(shim),
    });
    input.log(
      compilation.ok
        ? "Fixture compiled with stubs in place."
        : `Fixture compilation reported ${compilation.diagnostics.length} errors.`,
    );
    const untyped = compilation.untypedPackageErrors?.length ?? 0;
    if (untyped > 0)
      input.log(
        `${untyped} errors the source has too with its packages untyped were not counted.`,
      );
  } else {
    outbound = namesOnly(walk.cuts.outbound, "to");
    inbound = namesOnly(walk.cuts.inbound, "from");
    blockers.push({
      code: "no_extractor",
      file: null,
      location: null,
      detail: "Signature extraction exists for TypeScript and JavaScript only.",
    });
  }
  await verify(namesOf(packageFiles));
  const { required: packages, unpinned } = await requiredPackages(packageFiles);
  blockers.push(...unpinned);
  for (const path of versions.keys())
    if (versions.get(path) !== null) configs.push(path);
  configs = [...new Set(configs)].sort(compare);
  const complete = (modules: readonly BoundaryModule[]) =>
    modules.every((module) =>
      module.symbols.every((symbol) => symbol.declaration !== null),
    );
  const stubCoverage: StubCoverage =
    language === "none"
      ? "names-only"
      : complete(outbound) &&
          complete(inbound) &&
          compilation.ok &&
          !blockers.some((blocker) => blocker.code === "declaration_incomplete")
        ? "full"
        : "partial";
  // The graph and the extractor can report the same missing import.
  const blockerKey = (blocker: SliceBlocker) =>
    `${blocker.code}\n${blocker.file ?? ""}\n${blocker.location ?? ""}\n${blocker.detail}`;
  const sortedBlockers = [
    ...new Map(
      blockers.map((blocker) => [blockerKey(blocker), blocker]),
    ).values(),
  ].sort((a, b) => compare(blockerKey(a), blockerKey(b)));
  const contract: BoundaryContract = {
    schemaVersion: BOUNDARY_CONTRACT_SCHEMA_VERSION,
    toolVersion: SLICE_TOOL_VERSION,
    extractorVersion,
    sourceCommitSha: input.source.commitSha,
    language,
    outbound,
    inbound,
    stubCoverage,
    compilation,
    blockers: sortedBlockers,
  };
  const contractJson = canonicalJson(contract);
  for (const stub of stubs)
    synthetic.push({
      path: stub.path,
      kind: "stub",
      generator: "typescript-declaration-emit",
      generatorVersion: extractorVersion ?? SLICE_TOOL_VERSION,
      sha256: sha256(stub.text),
      sizeBytes: Buffer.byteLength(stub.text),
    });
  synthetic.sort((a, b) => compare(a.path, b.path));
  const includedFiles = [...included.values()].map(({ file }) => file);
  const includedBytes = includedFiles.reduce(
    (total, file) => total + file.sizeBytes,
    0,
  );
  const readiness = sliceReadiness({
    stubCoverage,
    blockers: sortedBlockers,
  });
  const manifest: SliceManifest = {
    schemaVersion: SLICE_MANIFEST_SCHEMA_VERSION,
    toolVersion: SLICE_TOOL_VERSION,
    extractorVersion,
    sourceCommitSha: input.source.commitSha,
    sourceDirty: input.source.isDirty(walk.included),
    graphSha256: sha256(
      canonicalJson({ nodes: graph.nodes, links: graph.links }),
    ),
    params,
    entryPoints: walk.entries,
    budget: params.budget,
    included: includedFiles,
    synthetic,
    requiredBuildInputs: { configs, packages },
    cuts,
    internalImports,
    externals,
    blockers: sortedBlockers,
    policy: OPERATION_POLICY,
    boundaryContractSha256: sha256(contractJson),
    meta: {
      includedFiles: includedFiles.length,
      includedBytes,
      outboundCuts: cuts.outbound.length,
      inboundCuts: cuts.inbound.length,
      stubCoverage,
      externals: externals.packages.length + externals.environment.length,
      blockers: sortedBlockers.length,
      ready: readiness.ready,
    },
  };
  return {
    manifest,
    contract,
    contractJson,
    stubs,
    surface,
    ready: readiness.ready,
    keepsImplicitAny,
    implicitAnyFiles,
    walk,
  };
}
