/**
 * The declared types of the public packages a slice reads, for the
 * extractor and the fixture compile.
 *
 * A snapshot has no node_modules, so without these every package is
 * untyped: a value whose type the source infers from one (a zod schema)
 * becomes `any` in its stub, and the sandbox, which installs the package,
 * no longer compiles what the source does. Only packages the repository
 * shows come from the public registry are fetched, at the version its
 * lockfile installed (or the range its package.json pins), with install
 * scripts off; the compiler reads their declaration files and nothing of
 * them runs.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "../command.js";

export interface PackageTypesRequest {
  readonly name: string;
  /** What npm installs it by: a version, a range or an `npm:` alias. */
  readonly spec: string;
}

export interface PackageTypes {
  /** A directory whose `node_modules` holds the packages. */
  readonly directory: string;
  /** What was installed under each requested name. */
  readonly packages: readonly { name: string; version: string }[];
}

/** The types, or why there are none: the slice then goes on untyped. */
export type PackageTypesFetcher = (
  requests: readonly PackageTypesRequest[],
  signal: AbortSignal,
) => Promise<PackageTypes | { readonly failed: string }>;

export const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
/** How long one fetch may take before the slice goes on without types. */
export const PACKAGE_TYPES_TIMEOUT_MS = 120_000;
const COMPLETE = ".complete";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * What the repository's npm lockfile installed under `name` at its root,
 * as npm would install it again: `1.2.3`, or `npm:other@1.2.3` for an
 * alias. Null when no npm lockfile says.
 */
export function lockedSpec(root: string, name: string): string | null {
  for (const file of ["npm-shrinkwrap.json", "package-lock.json"]) {
    const lock = readJson(join(root, file));
    const packages = isRecord(lock) ? lock["packages"] : undefined;
    const entry = isRecord(packages)
      ? packages[`node_modules/${name}`]
      : undefined;
    if (!isRecord(entry)) continue;
    const version = entry["version"];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version))
      continue;
    const installed = entry["name"];
    return typeof installed === "string" && installed !== name
      ? `npm:${installed}@${version}`
      : version;
  }
  return null;
}

/** `@types/x` for `x`, `@types/scope__x` for `@scope/x`. */
export function typesPackageOf(name: string): string {
  return `@types/${name.replace(/^@([^/]+)\//, "$1__")}`;
}

/** The versions a finished directory installed, by requested name. */
function installedVersions(
  directory: string,
  requests: readonly PackageTypesRequest[],
): { name: string; version: string }[] {
  const versions: { name: string; version: string }[] = [];
  for (const { name } of requests) {
    const manifest = readJson(
      join(directory, "node_modules", name, "package.json"),
    );
    const version = isRecord(manifest) ? manifest["version"] : undefined;
    if (typeof version === "string") versions.push({ name, version });
  }
  return versions;
}

/**
 * Fetches with npm into `root`, one directory per set of requests, kept
 * for the next slice that reads the same packages. Nothing of the worker's
 * npm configuration applies: the registry is the public one, the user
 * config an empty file, and no credential is in the environment.
 */
export function npmPackageTypes(options: {
  readonly root: string;
  readonly timeoutMs?: number;
}): PackageTypesFetcher {
  return async (requests, signal) => {
    const sorted = [...requests].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    const key = createHash("sha256")
      .update(JSON.stringify(sorted))
      .digest("hex")
      .slice(0, 32);
    const directory = join(options.root, key);
    if (existsSync(join(directory, COMPLETE)))
      return { directory, packages: installedVersions(directory, sorted) };
    const staging = join(options.root, `${key}.${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true });
      await writeFile(
        join(staging, "package.json"),
        `${JSON.stringify({
          private: true,
          dependencies: Object.fromEntries(
            sorted.map(({ name, spec }) => [name, spec]),
          ),
        })}\n`,
      );
      await writeFile(join(staging, ".npmrc"), "");
      await command(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--omit=dev",
          "--legacy-peer-deps",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          "--loglevel=error",
          `--registry=${PUBLIC_REGISTRY}`,
          `--userconfig=${join(staging, ".npmrc")}`,
          `--cache=${join(options.root, ".npm")}`,
        ],
        {
          cwd: staging,
          env: { HOME: options.root },
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(options.timeoutMs ?? PACKAGE_TYPES_TIMEOUT_MS),
          ]),
        },
      );
      await writeFile(join(staging, COMPLETE), "");
      // Another slice may have finished the same set first; either is whole.
      await rename(staging, directory).catch(() =>
        rm(staging, { recursive: true, force: true }),
      );
      return { directory, packages: installedVersions(directory, sorted) };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      signal.throwIfAborted();
      return { failed: error instanceof Error ? error.message : String(error) };
    }
  };
}
