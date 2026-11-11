/**
 * How every dependency of a cut is satisfied: the cut modules become
 * runtime mocks generated from their declarations, service packages and
 * packages no lockfile shows come from the public registry become mock
 * packages, and the rest install at the version the source pins.
 *
 * The slice manifest and boundary contract are the inputs; this module
 * reads them and never the source.
 */

import type { SliceManifest, BoundaryContract } from "../slice/manifest.js";

export const DEPENDENCY_RESOLUTIONS = [
  "included-code",
  "runtime-mock",
  "approved-package",
  "unresolved",
] as const;
export type DependencyResolution = (typeof DEPENDENCY_RESOLUTIONS)[number];

/**
 * A version or range the registry answers: semver, a range of them, or a
 * dist-tag. No protocol (`git+https:`, `file:`) and no path or
 * `owner/repo` shorthand, which is what a `:` or a `/` would make it.
 */
const REGISTRY_RANGE = /^[0-9A-Za-z.\-+^~<>=|* ]+$/;

/**
 * An alias to another package of the same registry, at a registry version:
 * `npm:typescript@5.9.3` installs `typescript` under the alias's name.
 */
const REGISTRY_ALIAS =
  /^npm:(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*@([^@]+)$/;

/** Whether the registry resolves a pin, directly or through an alias. */
export function isRegistryVersion(version: string): boolean {
  const alias = REGISTRY_ALIAS.exec(version);
  return REGISTRY_RANGE.test(alias === null ? version : (alias[1] ?? ""));
}

export interface ResolvedDependency {
  /** A package name, or a repository path for a cut module. */
  readonly name: string;
  readonly kind: "package" | "module";
  readonly version: string | null;
  readonly resolution: DependencyResolution;
  readonly detail: string;
}

/** What the owner may decide per dependency; the rest is derived. */
export type DependencyChoice = "runtime-mock" | "approved-package";

export interface ProvenanceBlocker {
  readonly code:
    | "slice_not_ready"
    | "dependency_unresolved"
    | "partial_signature_coverage"
    | "alias_rules_invalid"
    | "operation_unapproved";
  readonly detail: string;
}

/**
 * The classification a cut gives every path. Copied source keeps its
 * structure; generated files live apart from it and are never editable.
 */
export const PATH_CLASSES = [
  "source",
  "stub",
  "mock",
  "test-public",
  "config",
  "harness",
] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

export interface ScopeRecord {
  /** Repository paths a contribution may edit, sorted. */
  readonly editablePaths: readonly string[];
  /** Repository paths whose content is generated, sorted, never editable. */
  readonly generatedPaths: readonly string[];
  readonly permittedOperations: readonly (
    "edit" | "add" | "delete" | "rename"
  )[];
  readonly dependencies: readonly ResolvedDependency[];
  readonly blockers: readonly ProvenanceBlocker[];
}

export interface ScopeInput {
  readonly manifest: SliceManifest;
  readonly contract: BoundaryContract;
  /** Owner choices by package name; unspecified names take the default. */
  readonly choices?: Readonly<Record<string, DependencyChoice>>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Choices naming a package the slice does not require: a typo, never applied. */
export function unknownDependencyChoices(
  manifest: Pick<SliceManifest, "requiredBuildInputs">,
  choices: Readonly<Record<string, DependencyChoice>>,
): string[] {
  const required = new Set(
    manifest.requiredBuildInputs.packages.map((item) => item.name),
  );
  return Object.keys(choices)
    .filter((name) => !required.has(name))
    .sort();
}

/**
 * Resolves every dependency of the slice. Cut modules with full declaration
 * coverage become runtime mocks generated from their declarations; service
 * packages the externals pass named default to runtime mocks; a pinned
 * package the repository shows comes from the public registry is approved
 * for installation, and any other defaults to a runtime mock, since a
 * private registry's name is anyone's on the public one. An owner may
 * approve a package the repository says nothing of, never one it fetches
 * from another registry or its own workspace's. An unpinned package blocks
 * unless it is mocked, by default or by choice. Dynamic and unresolved
 * imports are blockers the slice already carries, and they stay blockers
 * here.
 */
export function resolveScope(input: ScopeInput): ScopeRecord {
  const { manifest, contract } = input;
  const choices = input.choices ?? {};
  const blockers: ProvenanceBlocker[] = [];
  if (!manifest.meta.ready)
    blockers.push({
      code: "slice_not_ready",
      detail: `The slice reports ${manifest.blockers.length} blocker(s) and ${manifest.meta.stubCoverage} coverage.`,
    });
  if (contract.stubCoverage !== "full")
    blockers.push({
      code: "partial_signature_coverage",
      detail: `Declaration coverage is ${contract.stubCoverage}; every cut symbol needs a declaration before it can be mocked.`,
    });
  const services = new Set(
    manifest.externals.packages.map((item) => packageNameOf(item.specifier)),
  );
  const dependencies: ResolvedDependency[] = [];
  for (const item of manifest.requiredBuildInputs.packages) {
    // The repository's own package is never fetched by its name: the
    // registry does not have it, or has someone else's under that name.
    if (item.workspace === true) {
      if (choices[item.name] === "approved-package") {
        dependencies.push({
          name: item.name,
          kind: "package",
          version: item.version,
          resolution: "unresolved",
          detail: "A package of this repository, not one the registry has.",
        });
        blockers.push({
          code: "dependency_unresolved",
          detail: `${item.name} is a package of this repository and cannot be installed; mock it.`,
        });
      } else
        dependencies.push({
          name: item.name,
          kind: "package",
          version: item.version,
          resolution: "runtime-mock",
          detail:
            "A package of this repository, replaced by a generated recording mock package.",
        });
      continue;
    }
    const registry = item.registry?.source ?? null;
    if (registry === "private" && choices[item.name] === "approved-package") {
      dependencies.push({
        name: item.name,
        kind: "package",
        version: item.version,
        resolution: "unresolved",
        detail: `Fetched from another registry (${item.registry?.evidence ?? ""}), not the public one.`,
      });
      blockers.push({
        code: "dependency_unresolved",
        detail: `${item.name} comes from another registry and cannot be installed by its name; mock it.`,
      });
      continue;
    }
    const resolution: DependencyResolution =
      choices[item.name] ??
      (services.has(item.name) || registry !== "public"
        ? "runtime-mock"
        : "approved-package");
    // A mock needs no version; only an install does.
    if (item.version === null && resolution === "approved-package") {
      dependencies.push({
        name: item.name,
        kind: "package",
        version: null,
        resolution: "unresolved",
        detail: "No package.json pins a version.",
      });
      blockers.push({
        code: "dependency_unresolved",
        detail: `${item.name} has no pinned version.`,
      });
      continue;
    }
    // Only what the registry resolves is installed. The version is the
    // repository's own text, and npm also takes a git URL, a tarball URL,
    // or `file:` or `link:` to a path outside the job, each fetched or
    // linked by the install. An alias is the registry's when its target is.
    if (
      item.version !== null &&
      resolution === "approved-package" &&
      !isRegistryVersion(item.version)
    ) {
      dependencies.push({
        name: item.name,
        kind: "package",
        version: item.version,
        resolution: "unresolved",
        detail: "Not a registry version: a URL or a path.",
      });
      blockers.push({
        code: "dependency_unresolved",
        detail: `${item.name} is pinned to ${item.version}, which is not a registry version.`,
      });
      continue;
    }
    dependencies.push({
      name: item.name,
      kind: "package",
      version: item.version,
      resolution,
      detail:
        resolution === "approved-package"
          ? `Installed at the version ${item.declaredIn ?? "the source"} pins.`
          : choices[item.name] !== undefined || services.has(item.name)
            ? "Replaced by a generated recording mock package."
            : registry === "private"
              ? `Fetched from another registry (${item.registry?.evidence ?? ""}), so replaced by a generated recording mock package.`
              : "No lockfile shows it comes from the public registry, so replaced by a generated recording mock package. Approve it if it does.",
    });
  }
  for (const module of contract.outbound) {
    const complete = module.symbols.every(
      (symbol) => symbol.declaration !== null,
    );
    dependencies.push({
      name: module.module,
      kind: "module",
      version: null,
      resolution: complete ? "runtime-mock" : "unresolved",
      detail: complete
        ? `Generated from its declaration stub${module.stubPath === null ? "" : ` (${module.stubPath})`}.`
        : "One or more symbols have no declaration.",
    });
    if (!complete)
      blockers.push({
        code: "dependency_unresolved",
        detail: `${module.module} cannot be mocked without declarations.`,
      });
  }
  for (const blocker of manifest.blockers)
    if (
      blocker.code === "dynamic_dependency" ||
      blocker.code === "unresolved_import"
    )
      blockers.push({
        code: "dependency_unresolved",
        detail: `${blocker.file ?? ""}: ${blocker.detail}`,
      });
  dependencies.sort((a, b) =>
    compare(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`),
  );
  return {
    editablePaths: manifest.included.map((file) => file.path).sort(compare),
    generatedPaths: manifest.synthetic.map((file) => file.path).sort(compare),
    permittedOperations: ["edit"],
    dependencies,
    blockers,
  };
}

/**
 * Whether a name is one npm installs a package by: `zod`, `@scope/name`.
 * A Vite virtual module (`virtual:build-info`), an alias that resolved
 * nowhere (`@/api`) or any other scheme is not; a slice mocks it as a
 * module of its own, never as a package.
 */
export function isPackageName(name: string): boolean {
  // npm's rule, but a leading `~`: `~/lib/errors` is the common alias for a
  // source folder, and `~icons/…` a bundler's virtual module, never a
  // package anyone installs.
  return name.length <= 214 && /^(@[a-z0-9-][a-z0-9._~-]*\/)?[a-z0-9-][a-z0-9._~-]*$/i.test(name);
}

export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") && parts.length > 1
    ? `${parts[0]}/${parts[1]}`
    : (parts[0] ?? specifier);
}

