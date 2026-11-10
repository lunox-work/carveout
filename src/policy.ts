/**
 * What a folder handed to someone outside may bring back.
 *
 * A folder comes back from a contributor the repository does not trust, so
 * nothing in it is taken on its word: the paths its `carveout.json` names
 * must stay inside the folder and the repository, the repository is the one
 * the maintainer names (or the one the record names, checked to hold the
 * cut's commit), and the patch carries only what a change to the slice can
 * honestly need. New files outside the slice's packages, files that run on
 * someone's machine or in CI without a review of code (workflows, hooks,
 * manifests, lockfiles, environment), and deleted tests are left out and
 * named, unless the maintainer allows them by path or glob.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import { isTestPath, pathMatcher } from "./core.js";

/**
 * Paths a patch from a slice never carries unless allowed: they run in CI
 * with its secrets, on a maintainer's machine (hooks, editor tasks), at
 * install (manifests, lockfiles, registry configuration), or hold
 * configuration a change to code does not need.
 */
export const PROTECTED_PATHS: readonly string[] = [
  ".github",
  ".gitlab",
  ".gitlab-ci.yml",
  ".circleci",
  ".buildkite",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "Jenkinsfile",
  ".husky",
  ".githooks",
  ".devcontainer",
  ".vscode",
  "**/.gitattributes",
  "**/.gitmodules",
  "**/CODEOWNERS",
  "carveout.config.json",
  "**/package.json",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/pnpm-lock.yaml",
  "**/pnpm-workspace.yaml",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/Makefile",
  "**/*.sh",
];

/**
 * Throws unless `path` is a plain relative path that stays where it is
 * joined: `/`-separated, not absolute, no `.` or `..` segment, no `.git`.
 */
export function assertSafePath(path: unknown, what: string): asserts path is string {
  const fail = (why: string) => {
    throw new Error(
      `carveout.json is not one carveout wrote: ${what} ${JSON.stringify(path)} ${why}. Cut the folder again rather than trust it.`,
    );
  };
  if (typeof path !== "string" || path === "") return fail("is not a path");
  if (path.includes("\0") || path.includes("\\")) fail("holds a NUL or a backslash");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) fail("is absolute");
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    fail("leaves its folder");
  if (parts.some((part) => part.toLowerCase() === ".git")) fail("is inside .git");
  if (posix.normalize(path) !== path) fail("is not normalized");
}

/** What `checkRecordPaths` reads of a record. */
interface RecordPaths {
  readonly manifest: { readonly included: readonly { readonly path: unknown }[] };
  readonly generated: readonly { readonly path: unknown }[];
  readonly copied?: readonly { readonly path: unknown }[];
  readonly extras?: readonly { readonly path: unknown }[];
  readonly importRewrites: readonly { readonly file: unknown }[];
  readonly request: { readonly entryPoints: readonly unknown[] };
}

/** Every path a record makes carveout read, write or delete, checked. */
export function checkRecordPaths(record: RecordPaths): void {
  const list = (value: unknown, what: string) => {
    if (!Array.isArray(value)) throw new Error(`carveout.json: ${what} is not a list.`);
    return value as readonly Record<string, unknown>[];
  };
  for (const file of list(record.manifest?.included, "manifest.included"))
    assertSafePath(file["path"], "manifest.included");
  for (const file of list(record.generated, "generated"))
    assertSafePath(file["path"], "generated");
  for (const file of list(record.copied ?? [], "copied")) assertSafePath(file["path"], "copied");
  for (const file of list(record.extras ?? [], "extras")) assertSafePath(file["path"], "extras");
  for (const rewrite of list(record.importRewrites, "importRewrites"))
    assertSafePath(rewrite["file"], "importRewrites");
  const entries: readonly unknown[] = list(record.request?.entryPoints, "request.entryPoints");
  for (const entry of entries)
    if (entry !== ".") assertSafePath(entry, "request.entryPoints");
}

/**
 * The checkout to diff and apply against: the one the maintainer names, else
 * the record's. Either way it must be a folder that holds the cut's commit,
 * so a record cannot point carveout at another folder of the machine.
 */
export function trustedRepo(
  record: { readonly repo?: string | null; readonly manifest: { readonly sourceCommitSha: string | null } },
  given: string | undefined,
): string {
  const named = given ?? record.repo ?? undefined;
  if (named === undefined || named === "")
    throw new Error(
      "The folder does not name its repository (a --public cut). Run this from the repository's root, or pass --repo <checkout>.",
    );
  const repo = resolve(named);
  if (!existsSync(repo) || !statSync(repo).isDirectory())
    throw new Error(`${repo} is not a folder; pass --repo <checkout>.`);
  const commit = record.manifest.sourceCommitSha;
  if (commit !== null) {
    if (!/^[0-9a-f]{7,64}$/.test(commit))
      throw new Error(`carveout.json names ${JSON.stringify(commit)} as its commit, which is no commit id.`);
    try {
      execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
        cwd: repo,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      throw new Error(
        `${repo} does not hold the cut's commit ${commit.slice(0, 12)}; pass --repo <checkout> of the repository the folder was cut from.`,
      );
    }
  }
  return repo;
}

export interface Refusal {
  readonly path: string;
  readonly reason: string;
}

/**
 * Judges each path a patch would carry. `packages` are the repository's
 * package folders the slice holds files of ("" for the root package);
 * `allow` are the maintainer's paths and globs that pass whatever the rule.
 */
export function handoffPolicy(options: {
  readonly packages: ReadonlySet<string>;
  readonly packageOf: (path: string) => string;
  readonly allow?: readonly string[];
}): (path: string, change: "added" | "changed" | "deleted") => string | null {
  const allowed = pathMatcher(options.allow ?? []);
  const protectedPath = pathMatcher(PROTECTED_PATHS);
  return (path, change) => {
    if (allowed(path)) return null;
    if (protectedPath(path))
      return "a protected path (CI, hooks, manifests, lockfiles, environment): review it and pass --allow to carry it";
    if (change === "added" && !options.packages.has(options.packageOf(path)))
      return "a new file outside the slice's packages";
    if (change === "deleted" && isTestPath(path))
      return "deletes a test the slice was handed";
    return null;
  };
}
