/**
 * Where a repository says the packages it imports are fetched from: the
 * URLs its lockfiles resolved them at, and the registries its npm, Yarn
 * and pnpm configuration send their scopes to. These are the facts
 * `resolveScope` in core decides by: a package is installed by its name
 * only when they show it comes from the public registry, since a private
 * registry's package name is anyone's to publish on the public one.
 *
 * Only the repository's own files are read, never a registry: the root
 * `package-lock.json` or `npm-shrinkwrap.json`, `yarn.lock` (classic and
 * Berry), `pnpm-lock.yaml`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, and the
 * `publishConfig` of the root and workspace manifests. Lockfiles in YAML
 * are read by line, as far as their entries' names and resolutions.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { PackageRegistry } from "../core.js";
import { workspacePackages } from "./compiler-config.js";

/** The public registry, and Yarn's alias of it that classic lockfiles name. */
const PUBLIC_REGISTRIES = [
  "https://registry.npmjs.org/",
  "https://registry.yarnpkg.com/",
];

/** Whether a registry or tarball URL is the public registry's. */
export function isPublicRegistry(url: string): boolean {
  const normalized = url.endsWith("/") ? url : `${url}/`;
  return PUBLIC_REGISTRIES.some((registry) => normalized.startsWith(registry));
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const readJson = (path: string): unknown => {
  const text = readText(path);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2");

/**
 * What one configuration file says: the registry for every package, and
 * per scope (`@acme`). Each file is kept apart, since each package manager
 * reads only its own: Berry ignores `.npmrc`, npm and pnpm ignore Yarn's.
 */
interface RegistryConfig {
  readonly file: string;
  default: string | null;
  readonly scopes: Map<string, string>;
}

const configOf = (file: string): RegistryConfig => ({
  file,
  default: null,
  scopes: new Map(),
});

/** Where a configuration sends `name`: its scope's registry, or every package's. */
function registryFor(config: RegistryConfig, name: string): string | null {
  const scope = name.startsWith("@") ? name.split("/")[0] : undefined;
  return (
    (scope === undefined ? undefined : config.scopes.get(scope)) ??
    config.default
  );
}

/** `@acme:registry=…` and `registry=…` lines of an `.npmrc`. */
function readNpmrc(text: string, config: RegistryConfig) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const at = line.indexOf("=");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const url = unquote(line.slice(at + 1));
    if (key === "registry") config.default = url;
    const scope = /^(@[^:]+):registry$/.exec(key)?.[1];
    if (scope !== undefined) config.scopes.set(scope, url);
  }
}

/** `registry "…"` and `"@acme:registry" "…"` lines of a classic `.yarnrc`. */
function readYarnrc(text: string, config: RegistryConfig) {
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*("?)([^\s"]+)\1\s+(.+)$/.exec(raw);
    if (match === null) continue;
    const key = match[2] ?? "";
    const url = unquote(match[3] ?? "");
    if (key === "registry") config.default = url;
    const scope = /^(@[^:]+):registry$/.exec(key)?.[1];
    if (scope !== undefined) config.scopes.set(scope, url);
  }
}

/** `npmRegistryServer` and `npmScopes.<scope>.npmRegistryServer` in `.yarnrc.yml`. */
function readYarnrcYml(text: string, config: RegistryConfig) {
  let inScopes = false;
  let scope: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const indent = /^\s*/.exec(raw)?.[0].length ?? 0;
    const match = /^\s*([^:#]+?)\s*:\s*(.*?)\s*$/.exec(raw);
    if (match === null) continue;
    const key = unquote(match[1] ?? "");
    const value = unquote(match[2] ?? "");
    if (indent === 0) {
      inScopes = key === "npmScopes";
      scope = null;
      if (key === "npmRegistryServer") config.default = value;
    } else if (inScopes && value === "") scope = `@${key.replace(/^@/, "")}`;
    else if (inScopes && scope !== null && key === "npmRegistryServer")
      config.scopes.set(scope, value);
  }
}

/**
 * A manifest's `publishConfig`: where the organization publishes the
 * package's scope (`registry`) or a named one (`@acme:registry`).
 */
function readPublishConfig(manifest: unknown, config: RegistryConfig) {
  if (!isRecord(manifest) || !isRecord(manifest["publishConfig"])) return;
  const name = manifest["name"];
  for (const [key, value] of Object.entries(manifest["publishConfig"])) {
    if (typeof value !== "string") continue;
    const named = /^(@[^:]+):registry$/.exec(key)?.[1];
    const own =
      key === "registry" && typeof name === "string" && name.startsWith("@")
        ? name.split("/")[0]
        : undefined;
    const scope = named ?? own;
    if (scope !== undefined && !config.scopes.has(scope))
      config.scopes.set(scope, value);
  }
}

/** What one lockfile says of each package it holds. */
interface LockEvidence {
  readonly file: string;
  /** Resolved URLs, by package name. */
  readonly resolved: Map<string, string[]>;
  /** Packages pinned from the configured registry without its URL. */
  readonly configured: Set<string>;
  /** The configuration that names that registry to the lockfile's manager. */
  readonly config: RegistryConfig;
}

function addResolved(evidence: LockEvidence, name: string, url: string) {
  const urls = evidence.resolved.get(name) ?? [];
  urls.push(url);
  evidence.resolved.set(name, urls);
}

/**
 * `name` from `name@range`, `@scope/name@npm:range` or a pnpm key. The
 * name ends at the first `@` or `/` after its scope: pnpm 5 keys put the
 * version after a slash (`/name/1.2.3`), and their peer suffix can hold
 * an `@` of its own (`/name/1.2.3_react@18.0.0`).
 */
function descriptorName(descriptor: string): string {
  const bare = descriptor.replace(/^\//, "").replace(/\(.*$/, "");
  const start = bare.startsWith("@") ? Math.max(bare.indexOf("/") + 1, 1) : 0;
  const end = bare.slice(start).search(/[@/]/);
  return end === -1 ? bare : bare.slice(0, start + end);
}

/** `package-lock.json` or `npm-shrinkwrap.json`, versions 1 to 3. */
function readPackageLock(lock: unknown, evidence: LockEvidence) {
  if (!isRecord(lock)) return;
  const packages = lock["packages"];
  if (isRecord(packages))
    for (const [key, entry] of Object.entries(packages)) {
      const at = key.lastIndexOf("node_modules/");
      if (at === -1 || !isRecord(entry) || entry["link"] === true) continue;
      const resolved = entry["resolved"];
      if (typeof resolved === "string")
        addResolved(evidence, key.slice(at + "node_modules/".length), resolved);
    }
  const walk = (dependencies: unknown) => {
    if (!isRecord(dependencies)) return;
    for (const [name, entry] of Object.entries(dependencies)) {
      if (!isRecord(entry)) continue;
      const resolved = entry["resolved"];
      if (typeof resolved === "string") addResolved(evidence, name, resolved);
      walk(entry["dependencies"]);
    }
  };
  walk(lock["dependencies"]);
}

/** `yarn.lock`: a classic entry's `resolved`, a Berry entry's npm `resolution`. */
function readYarnLock(text: string, evidence: LockEvidence) {
  let names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#") || line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      names = line.endsWith(":")
        ? line
            .slice(0, -1)
            .replaceAll('"', "")
            .split(",")
            .map((descriptor) => descriptorName(descriptor.trim()))
            .filter((name) => name !== "" && name !== "__metadata")
        : [];
      continue;
    }
    const resolved = /^\s+resolved:?\s+"?([^"\s#]+)/.exec(line)?.[1];
    if (resolved !== undefined)
      for (const name of names) addResolved(evidence, name, resolved);
    const resolution = /^\s+resolution:\s+"?([^"]+)"?\s*$/.exec(line)?.[1];
    if (resolution?.includes("@npm:") === true)
      for (const name of names) evidence.configured.add(name);
  }
}

/** `pnpm-lock.yaml`: each `packages` entry's `resolution`. */
function readPnpmLock(text: string, evidence: LockEvidence) {
  let inPackages = false;
  let name: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      name = null;
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}(\S.*):\s*$/.exec(line)?.[1];
    if (key !== undefined) {
      name = descriptorName(unquote(key));
      continue;
    }
    if (name === null) continue;
    const tarball = /\btarball:\s*([^,}\s]+)/.exec(line)?.[1];
    if (tarball !== undefined) addResolved(evidence, name, unquote(tarball));
    else if (/^\s+resolution:\s*\{.*\bintegrity:/.test(line))
      evidence.configured.add(name);
  }
}

/**
 * What the repository at `root` says of each package's registry, as a
 * function of its name: `private` when any of its configuration sends the
 * package's scope, or every package, to another registry, or a lockfile
 * resolved it elsewhere; `public` when a lockfile resolved it from the
 * public registry, or pinned it from a registry that the configuration
 * its own package manager reads names as the public one; null when
 * nothing says.
 *
 * One file naming another registry is enough, whichever manager reads it:
 * Berry ignores `.npmrc` and npm ignores `.yarnrc.yml`, so a public
 * registry in one never outweighs a private one in another.
 */
export function packageRegistries(
  root: string,
): (name: string) => PackageRegistry | null {
  const read = (
    file: string,
    parse: (text: string, config: RegistryConfig) => void,
  ) => {
    const config = configOf(file);
    const text = readText(join(root, file));
    if (text !== null) parse(text, config);
    return config;
  };
  const npmrc = read(".npmrc", readNpmrc);
  const yarnrcYml = read(".yarnrc.yml", readYarnrcYml);
  const configs = [npmrc, read(".yarnrc", readYarnrc), yarnrcYml];
  const manifest = (directory: string, file: string) => {
    const config = configOf(file);
    readPublishConfig(readJson(join(directory, "package.json")), config);
    configs.push(config);
  };
  manifest(root, "package.json");
  for (const directory of workspacePackages(root).values())
    manifest(directory, `${relative(root, directory)}/package.json`);

  const locks: LockEvidence[] = [];
  const lockOf = (file: string, config: RegistryConfig) => {
    const evidence: LockEvidence = {
      file,
      resolved: new Map(),
      configured: new Set(),
      config,
    };
    locks.push(evidence);
    return evidence;
  };
  for (const file of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const lock = readJson(join(root, file));
    if (lock !== undefined) readPackageLock(lock, lockOf(file, npmrc));
  }
  // Only Berry's entries lack a URL, and Berry reads `.yarnrc.yml` alone.
  const yarnLock = readText(join(root, "yarn.lock"));
  if (yarnLock !== null) readYarnLock(yarnLock, lockOf("yarn.lock", yarnrcYml));
  const pnpmLock = readText(join(root, "pnpm-lock.yaml"));
  if (pnpmLock !== null)
    readPnpmLock(pnpmLock, lockOf("pnpm-lock.yaml", npmrc));

  return (name) => {
    for (const config of configs) {
      const url = registryFor(config, name);
      if (url !== null && !isPublicRegistry(url))
        return { source: "private", evidence: config.file };
    }
    let shown: string | null = null;
    for (const lock of locks) {
      const urls = lock.resolved.get(name) ?? [];
      // A lockfile entry with no URL came from the configured registry,
      // which says nothing unless the configuration its manager reads
      // names the public one. Without it, Berry's default would be Yarn's
      // public alias, but a developer's own configuration can replace it.
      const fromConfigured =
        lock.configured.has(name) && registryFor(lock.config, name) !== null;
      if (urls.some((url) => !isPublicRegistry(url)))
        return { source: "private", evidence: lock.file };
      if (urls.length > 0 || fromConfigured) shown ??= lock.file;
    }
    return shown === null ? null : { source: "public", evidence: shown };
  };
}

/**
 * The integrity each `pnpm-lock.yaml` entry with no tarball URL records,
 * by package name and version. Such an entry came from whatever registry
 * the developer's configuration named, so on its own it shows nothing;
 * its `sha512-` integrity, equal to the one the public registry publishes
 * for the same version, shows it is the public package byte for byte (see
 * `publicByIntegrity`).
 */
export function lockIntegrities(root: string): Map<string, Map<string, string>> {
  const found = new Map<string, Map<string, string>>();
  const text = readText(join(root, "pnpm-lock.yaml"));
  if (text === null) return found;
  let inPackages = false;
  let key: { name: string; version: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const descriptor = /^ {2}(\S.*):\s*$/.exec(line)?.[1];
    if (descriptor !== undefined) {
      const bare = unquote(descriptor).replace(/^\//, "").replace(/\(.*$/, "").replace(/_.*$/, "");
      const name = descriptorName(bare);
      const version = bare.slice(name.length + 1);
      key = version === "" ? null : { name, version };
      continue;
    }
    if (key === null || /\btarball:/.test(line)) continue;
    const integrity = /^\s+resolution:\s*\{.*\bintegrity:\s*([^,}\s]+)/.exec(line)?.[1];
    if (integrity === undefined) continue;
    const versions = found.get(key.name) ?? new Map<string, string>();
    versions.set(key.version, unquote(integrity));
    found.set(key.name, versions);
  }
  return found;
}

/**
 * Whether every version of `name` the lockfile records has the integrity
 * the public registry publishes for it: then the repository installs the
 * public package, whatever registry served it. One mismatch, or a version
 * the registry does not have, and it shows nothing.
 */
export async function publicByIntegrity(
  name: string,
  versions: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<boolean> {
  if (versions.size === 0) return false;
  const path = name.startsWith("@") ? name.replace("/", "%2f") : encodeURIComponent(name);
  for (const [version, integrity] of versions) {
    try {
      const response = await fetch(`https://registry.npmjs.org/${path}/${encodeURIComponent(version)}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: { accept: "application/json" },
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { dist?: { integrity?: unknown } };
      if (body.dist?.integrity !== integrity) return false;
    } catch {
      return false;
    }
  }
  return true;
}
