/**
 * What a slice run writes, and the rules that read it.
 *
 * `slice-manifest.json` is the immutable record of a proposed slice: the
 * source it was cut from, the copied files pinned by hash, the generated
 * files kept apart from them, the cut edges, the externals and whatever
 * blocks the slice from becoming a sandbox. `boundary-contract.json` is the
 * machine-readable shape of the boundary: the symbols the slice imports from
 * outside (stubs) and the symbols outside code imports from it (its public
 * surface), with their declarations. The markdown views are rendered from
 * the contract and never carry anything it does not.
 */

import type { SliceBudget, SliceParams } from "./analysis.js";
import type { ExternalPackage, SliceExternals } from "./externals.js";
import type { CutEdge } from "./reach.js";

export const SLICE_MANIFEST_SCHEMA_VERSION = 1;
export const BOUNDARY_CONTRACT_SCHEMA_VERSION = 1;

/**
 * How much of the boundary carries declarations. `full` means every cut
 * and public symbol has one and the fixture compiled; it says nothing about
 * runtime readiness. `partial` and `names-only` are diagnostic output.
 */
export type StubCoverage = "full" | "partial" | "names-only";

export const SLICE_BLOCKER_CODES = [
  "unknown_entry_point",
  "unresolved_import",
  "dynamic_dependency",
  "path_read",
  "missing_build_input",
  "no_extractor",
  "declaration_incomplete",
  "compile_error",
  "secret_file",
] as const;
export type SliceBlockerCode = (typeof SLICE_BLOCKER_CODES)[number];

/**
 * The blockers a contributor meets in the code itself: an import that
 * resolves to no file, a dynamic import of a computed name, a path read at
 * runtime the folder will not have. Every other
 * code is the slicer's own build falling short (a compile error in its
 * fixture, a configuration it could not read, a language it cannot
 * extract), which says how well the code was measured, not how hard the
 * work is, and one cause can raise dozens of them.
 */
export const WORK_BLOCKER_CODES: readonly SliceBlockerCode[] = [
  "unresolved_import",
  "dynamic_dependency",
  "path_read",
];

const WORK_BLOCKERS: ReadonlySet<SliceBlockerCode> = new Set(
  WORK_BLOCKER_CODES,
);

export const isWorkBlocker = (blocker: Pick<SliceBlocker, "code">): boolean =>
  WORK_BLOCKERS.has(blocker.code);

export interface SliceBlocker {
  readonly code: SliceBlockerCode;
  readonly file: string | null;
  readonly location: string | null;
  readonly detail: string;
}

export interface BoundarySymbol {
  readonly name: string;
  /** `function`, `class`, `interface`, `type`, `enum`, `variable`, `module`, `unknown`. */
  readonly kind: string;
  /** Declaration text, `.d.ts` style; null when the language has no extractor. */
  readonly declaration: string | null;
}

export interface BoundaryModule {
  /** Repository path of the module. */
  readonly module: string;
  readonly symbols: readonly BoundarySymbol[];
  /** Files on the other side of the cut that import it, sorted. */
  readonly importedBy: readonly string[];
  /** For an outbound module: the generated stub's artifact path. */
  readonly stubPath: string | null;
}

export interface CompilationResult {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly diagnostics: readonly {
    readonly file: string | null;
    readonly line: number | null;
    readonly code: string;
    readonly message: string;
  }[];
  /** Package specifiers declared `any` so the fixture could type-check. */
  readonly shimmedPackages: readonly string[];
  /**
   * Errors the source has too, checked the same way with its own code in
   * place of the stubs: what declaring its packages untyped costs, not
   * counted against the slice. Absent when nothing failed.
   */
  readonly untypedPackageErrors?: CompilationResult["diagnostics"];
  /**
   * Packages whose published types the check read, at the versions read,
   * rather than declaring them untyped. Absent when none were fetched.
   */
  readonly typedPackages?: readonly {
    readonly name: string;
    readonly version: string;
  }[];
}

export interface BoundaryContract {
  readonly schemaVersion: typeof BOUNDARY_CONTRACT_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly extractorVersion: string | null;
  /** The commit the source was read at; null outside Git. */
  readonly sourceCommitSha: string | null;
  readonly language: "typescript" | "none";
  /** Slice → outside: what the slice needs, as stubs. */
  readonly outbound: readonly BoundaryModule[];
  /** Outside → slice: what the slice must keep offering. */
  readonly inbound: readonly BoundaryModule[];
  readonly stubCoverage: StubCoverage;
  readonly compilation: CompilationResult;
  readonly blockers: readonly SliceBlocker[];
}

export interface IncludedFile {
  readonly path: string;
  /** Git's blob id of the bytes read, so the sandbox can verify its copy. */
  readonly blobId: string;
  readonly sha256: string;
  /** `100644` or `100755`, as Git records it. */
  readonly mode: string;
  readonly sizeBytes: number;
  readonly operations: readonly "edit"[];
}

export interface SyntheticFile {
  readonly path: string;
  readonly kind: "stub" | "shim" | "config";
  readonly generator: string;
  readonly generatorVersion: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface RequiredBuildInputs {
  /** Compiler and package configuration the included files are read with. */
  readonly configs: readonly string[];
  /** Packages the included files import, with the version the source pins. */
  readonly packages: readonly {
    readonly name: string;
    readonly version: string | null;
    readonly declaredIn: string | null;
    /**
     * One of the repository's own workspace packages: its source lives
     * here, not on the registry, so it is mocked and never installed.
     */
    readonly workspace?: true;
    /**
     * Where the repository says it is fetched from; absent when nothing
     * it holds says. Only a package shown to come from the public
     * registry is installed by its name.
     */
    readonly registry?: PackageRegistry;
  }[];
}

/**
 * What a repository's lockfiles and npm configuration say of a package's
 * registry. `public` is a lockfile entry resolved from the public registry
 * with no configuration mapping its scope elsewhere; `private` is any
 * lockfile entry or configuration that names another registry.
 */
export interface PackageRegistry {
  readonly source: "public" | "private";
  /** The file that says so, such as `package-lock.json` or `.npmrc`. */
  readonly evidence: string;
}

/** Every operation a contribution may make on the slice has a stated rule. */
export interface OperationPolicy {
  readonly edit: "included-source-only";
  readonly add: "requires-approved-path-mapping";
  readonly delete: "requires-explicit-allowance";
  readonly rename: "requires-explicit-allowance";
  readonly synthetic: "rejected";
  readonly unknown: "refused";
}

export const OPERATION_POLICY: OperationPolicy = {
  edit: "included-source-only",
  add: "requires-approved-path-mapping",
  delete: "requires-explicit-allowance",
  rename: "requires-explicit-allowance",
  synthetic: "rejected",
  unknown: "refused",
};

export interface SliceMeta {
  readonly includedFiles: number;
  readonly includedBytes: number;
  readonly outboundCuts: number;
  readonly inboundCuts: number;
  readonly stubCoverage: StubCoverage;
  readonly externals: number;
  readonly blockers: number;
  readonly ready: boolean;
}

export interface SliceManifest {
  readonly schemaVersion: typeof SLICE_MANIFEST_SCHEMA_VERSION;
  readonly toolVersion: string;
  readonly extractorVersion: string | null;
  /** The commit the source was read at; null outside Git. */
  readonly sourceCommitSha: string | null;
  /** Whether any included file differed from that commit. */
  readonly sourceDirty: boolean;
  /** The import graph walked, as `canonicalJson` writes it. */
  readonly graphSha256: string;
  readonly params: SliceParams;
  readonly entryPoints: readonly string[];
  readonly budget: SliceBudget;
  readonly included: readonly IncludedFile[];
  readonly synthetic: readonly SyntheticFile[];
  readonly requiredBuildInputs: RequiredBuildInputs;
  readonly cuts: {
    readonly outbound: readonly CutEdge[];
    readonly inbound: readonly CutEdge[];
  };
  /** Import edges between included files, with their specifiers; see `reach`. */
  readonly internalImports: readonly CutEdge[];
  readonly externals: SliceExternals;
  readonly blockers: readonly SliceBlocker[];
  readonly policy: OperationPolicy;
  readonly boundaryContractSha256: string;
  readonly meta: SliceMeta;
}

/**
 * Whether a slice may advance past diagnosis. Only full declaration
 * coverage with no blockers may; the sandbox phase then proves the runtime.
 */
export function sliceReadiness(input: {
  readonly stubCoverage: StubCoverage;
  readonly blockers: readonly SliceBlocker[];
}): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.stubCoverage !== "full")
    reasons.push(`Declaration coverage is ${input.stubCoverage}.`);
  for (const blocker of input.blockers)
    reasons.push(
      `${blocker.code}${blocker.file === null ? "" : ` in ${blocker.file}`}: ${blocker.detail}`,
    );
  return { ready: reasons.length === 0, reasons };
}

/** The bounded view of a boundary a console renders without the files. */
export interface SliceBoundarySummary {
  readonly schemaVersion: 1;
  readonly language: BoundaryContract["language"];
  readonly stubCoverage: StubCoverage;
  readonly ready: boolean;
  readonly counts: {
    readonly includedFiles: number;
    readonly includedBytes: number;
    readonly outboundModules: number;
    readonly inboundModules: number;
    readonly stubs: number;
    readonly publicSymbols: number;
    readonly externals: number;
    readonly blockers: number;
  };
  readonly included: readonly string[];
  readonly outbound: readonly SummaryModule[];
  readonly inbound: readonly SummaryModule[];
  readonly externals: {
    readonly packages: readonly { specifier: string; service: string }[];
    readonly environment: readonly string[];
  };
  readonly blockers: readonly SliceBlocker[];
  /** Whether any list above was cut short. */
  readonly truncated: boolean;
}

export interface SummaryModule {
  readonly module: string;
  readonly symbols: readonly string[];
  readonly importedBy: readonly string[];
  readonly truncated: boolean;
}

export const SUMMARY_LIMITS = {
  files: 200,
  modules: 100,
  symbols: 50,
  importers: 10,
  blockers: 50,
  externalPackages: 100,
  environment: 100,
} as const;

/**
 * The packages a summary lists: one for each service first, then the rest
 * by specifier, up to the limit, and sorted again by specifier. The pricing
 * profile counts services from this list, so a cut must not drop one.
 */
function summarizePackages(
  packages: readonly ExternalPackage[],
): { specifier: string; service: string }[] {
  const services = new Set<string>();
  const first: ExternalPackage[] = [];
  const rest: ExternalPackage[] = [];
  for (const entry of packages) {
    if (services.has(entry.service)) rest.push(entry);
    else {
      services.add(entry.service);
      first.push(entry);
    }
  }
  return [...first, ...rest]
    .slice(0, SUMMARY_LIMITS.externalPackages)
    .sort((a, b) =>
      a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0,
    )
    .map(({ specifier, service }) => ({ specifier, service }));
}

/**
 * The blockers a summary lists: the work's first, then the slicer's own,
 * each in the contract's order, up to the limit. The pricing profile counts
 * the work's blockers from this list, and the contract sorts by code, which
 * puts `unresolved_import` after every `compile_error` and
 * `missing_build_input`: a plain cut of a noisy build would drop exactly
 * the blockers that are scored.
 */
function summarizeBlockers(
  blockers: readonly SliceBlocker[],
): readonly SliceBlocker[] {
  if (blockers.length <= SUMMARY_LIMITS.blockers) return blockers;
  return [
    ...blockers.filter(isWorkBlocker),
    ...blockers.filter((blocker) => !isWorkBlocker(blocker)),
  ].slice(0, SUMMARY_LIMITS.blockers);
}

function summarizeModules(modules: readonly BoundaryModule[]): {
  modules: SummaryModule[];
  truncated: boolean;
} {
  let truncated = modules.length > SUMMARY_LIMITS.modules;
  const summarized = modules.slice(0, SUMMARY_LIMITS.modules).map((module) => {
    const cut =
      module.symbols.length > SUMMARY_LIMITS.symbols ||
      module.importedBy.length > SUMMARY_LIMITS.importers;
    truncated ||= cut;
    return {
      module: module.module,
      symbols: module.symbols
        .slice(0, SUMMARY_LIMITS.symbols)
        .map((symbol) => symbol.name),
      importedBy: module.importedBy.slice(0, SUMMARY_LIMITS.importers),
      truncated: cut,
    };
  });
  return { modules: summarized, truncated };
}

export function boundarySummary(
  contract: BoundaryContract,
  manifest: Pick<SliceManifest, "included" | "externals" | "meta">,
): SliceBoundarySummary {
  const outbound = summarizeModules(contract.outbound);
  const inbound = summarizeModules(contract.inbound);
  const count = (modules: readonly BoundaryModule[]) =>
    modules.reduce((total, module) => total + module.symbols.length, 0);
  return {
    schemaVersion: 1,
    language: contract.language,
    stubCoverage: contract.stubCoverage,
    ready: manifest.meta.ready,
    counts: {
      includedFiles: manifest.included.length,
      includedBytes: manifest.meta.includedBytes,
      outboundModules: contract.outbound.length,
      inboundModules: contract.inbound.length,
      stubs: count(contract.outbound),
      publicSymbols: count(contract.inbound),
      externals:
        manifest.externals.packages.length +
        manifest.externals.environment.length,
      blockers: contract.blockers.length,
    },
    included: manifest.included
      .slice(0, SUMMARY_LIMITS.files)
      .map((file) => file.path),
    outbound: outbound.modules,
    inbound: inbound.modules,
    externals: {
      packages: summarizePackages(manifest.externals.packages),
      environment: manifest.externals.environment
        .slice(0, SUMMARY_LIMITS.environment)
        .map(({ name }) => name),
    },
    blockers: summarizeBlockers(contract.blockers),
    truncated:
      outbound.truncated ||
      inbound.truncated ||
      manifest.included.length > SUMMARY_LIMITS.files ||
      contract.blockers.length > SUMMARY_LIMITS.blockers ||
      manifest.externals.packages.length > SUMMARY_LIMITS.externalPackages ||
      manifest.externals.environment.length > SUMMARY_LIMITS.environment,
  };
}

/**
 * One line per module: its path, its stub, and the names taken from it.
 * The declarations themselves are in the stub, where the compiler reads
 * them; repeating them here cost a session an eighth of everything it read
 * (E6c: BOUNDARY.md opened in 60 of 60 slice runs).
 */
function renderModules(modules: readonly BoundaryModule[], empty: string) {
  if (modules.length === 0) return [empty];
  return modules.map((module) => {
    const names = module.symbols.map((symbol) => symbol.name);
    const shown = names.slice(0, 12).map((name) => `\`${name}\``).join(", ");
    const more = names.length > 12 ? `, +${names.length - 12} more` : "";
    // The folder writes each stub beside the module's path, not where the
    // contract files it.
    const stub =
      module.stubPath === null
        ? ""
        : ` → \`${module.module.replace(/\.d\.[cm]?ts$|\.([cm]?)[jt]sx?$/, (whole, m: string | undefined) => (whole.startsWith(".d.") ? whole : `.d.${m ?? ""}ts`))}\``;
    const importers =
      module.importedBy.length === 0
        ? ""
        : ` (${module.importedBy.length} importer${module.importedBy.length === 1 ? "" : "s"})`;
    return `- \`${module.module}\`${stub}: ${shown}${more}${importers}`;
  });
}

/**
 * `BOUNDARY.md`: an index of the boundary, rendered from the contract. What
 * the slice holds is in the README and `carveout.json`; what each stub
 * declares is in the stub.
 */
export function renderBoundaryMarkdown(
  contract: BoundaryContract,
  manifest: Pick<
    SliceManifest,
    "included" | "entryPoints" | "budget" | "externals" | "meta"
  >,
): string {
  const readiness = sliceReadiness(contract);
  const lines: string[] = [
    "# Slice boundary",
    "",
    `Entry points: ${manifest.entryPoints.map((entry) => `\`${entry}\``).join(", ")}. Budget: ${manifest.budget.maxFiles} files, depth ${manifest.budget.maxDepth}. ${manifest.included.length} files in the slice. Declaration coverage: **${contract.stubCoverage}**. ${readiness.ready ? "No blockers." : "It has blockers: the project may not build or run until they are fixed."}`,
    "",
  ];
  if (!readiness.ready) {
    lines.push("## Blockers", "");
    for (const reason of readiness.reasons) lines.push(`- ${reason}`);
    lines.push("");
  }
  lines.push(
    "## Stubbed modules",
    "",
    "What the slice imports from outside, with the names it takes. Each stub's `.d.ts` declares them; the `.js` beside it is a recording mock.",
    "",
    ...renderModules(
      contract.outbound,
      "The slice imports nothing outside itself.",
    ),
    "",
    "## Public surface",
    "",
    "What outside code imports from the slice; a change must keep these exports to fit back.",
    "",
    ...renderModules(contract.inbound, "Nothing outside the slice imports it."),
    "",
    "## Externals to mock",
    "",
  );
  if (
    manifest.externals.packages.length === 0 &&
    manifest.externals.environment.length === 0
  )
    lines.push("No service SDKs or environment reads were detected.");
  for (const item of manifest.externals.packages)
    lines.push(
      `- \`${item.specifier}\` (${item.service}) in ${item.files.map((file) => `\`${file}\``).join(", ")}`,
    );
  for (const item of manifest.externals.environment)
    lines.push(
      `- \`${item.name}\` read in ${item.files.map((file) => `\`${file}\``).join(", ")}`,
    );
  lines.push("", "## Compilation", "");
  if (!contract.compilation.attempted)
    lines.push("No compilation was attempted for this language.");
  else if (contract.compilation.ok)
    lines.push(
      `The included files and stubs type-check together${contract.compilation.shimmedPackages.length === 0 ? "." : `, with ${contract.compilation.shimmedPackages.map((name) => `\`${name}\``).join(", ")} declared as untyped packages.`}`,
    );
  else
    for (const diagnostic of contract.compilation.diagnostics)
      lines.push(
        `- ${diagnostic.file === null ? "" : `\`${diagnostic.file}\`${diagnostic.line === null ? "" : `:${diagnostic.line}`} `}${diagnostic.code}: ${diagnostic.message}`,
      );
  const typed = contract.compilation.typedPackages ?? [];
  if (typed.length > 0)
    lines.push(
      "",
      `Checked against the published types of ${typed.map(({ name, version }) => `\`${name}@${version}\``).join(", ")}.`,
    );
  const untyped = contract.compilation.untypedPackageErrors?.length ?? 0;
  if (untyped > 0)
    lines.push(
      "",
      `${untyped} more error${untyped === 1 ? "" : "s"} the source has too, with its packages untyped, ${untyped === 1 ? "is" : "are"} not counted; \`carveout check\` builds against the packages the project installs.`,
    );
  lines.push("");
  return lines.join("\n");
}

/** `public-surface.md`: only what a contribution must keep. */
export function renderPublicSurfaceMarkdown(
  contract: BoundaryContract,
): string {
  return [
    "# Public surface",
    "",
    `Symbols outside code imports from the slice. A change that keeps the names but not these types will not fit back into the repository.`,
    "",
    ...renderModules(contract.inbound, "Nothing outside the slice imports it."),
  ].join("\n");
}
