/**
 * `carveout gate`: the hand-off policy on a change made in the repository
 * itself, by an agent or anyone else, rather than on a folder that came
 * back from outside.
 *
 * It reads the change from Git (the base commit against the working tree,
 * untracked files included) and names what a change to code should not
 * slip in unread: protected paths (CI, hooks, manifests, lockfiles,
 * environment), deleted tests, tests whose assertions were removed or
 * rewritten or that were skipped or focused with `.only`, edits to the
 * configuration a check reads (tsconfig, linter, test runner), and new
 * check suppressions (`@ts-ignore`, `eslint-disable`, coverage ignores).
 * With `scope`, a file outside the paths the change was meant to touch is
 * named too. A refusal is a question for a reviewer, not a verdict: a
 * change asked to alter a behaviour rewrites the assertion that held it.
 *
 * Reads only: it runs no code of the repository.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathMatcher } from "./core.js";
import { handoffPolicy, type Refusal } from "./policy.js";

export type ChangeKind = "added" | "changed" | "deleted";

export interface RepositoryChange {
  readonly path: string;
  readonly change: ChangeKind;
}

export interface Gate {
  /** The checkout's root; every path is relative to it. */
  readonly repo: string;
  /** The base as given, and the commit it names. */
  readonly base: string;
  readonly baseCommit: string;
  readonly changes: readonly RepositoryChange[];
  readonly refused: readonly Refusal[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const git = (cwd: string, args: readonly string[]) =>
  execFileSync("git", [...args], {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The root of the Git checkout holding `dir`. */
export function checkoutRoot(dir: string): string {
  try {
    return git(resolve(dir), ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  } catch {
    throw new Error(`${resolve(dir)} is not inside a Git checkout; pass --repo <checkout>.`);
  }
}

/** The commit `base` names in `root`, or an error that says so. */
export function baseCommitOf(root: string, base: string): string {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).toString("utf8").trim();
  } catch {
    throw new Error(`${base} names no commit in ${root}; pass --base <commit, branch or tag>.`);
  }
}

/**
 * What changed from `baseCommit` to the working tree: tracked files by
 * `git diff` (a rename is a deletion and an addition), and untracked files
 * Git does not ignore as added. Sorted by path.
 */
export function changesSince(root: string, baseCommit: string): RepositoryChange[] {
  const changes = new Map<string, ChangeKind>();
  const fields = git(root, ["diff", "--name-status", "--no-renames", "-z", baseCommit, "--"])
    .toString("utf8")
    .split("\0");
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const status = fields[at] ?? "";
    const path = fields[at + 1] ?? "";
    if (path === "") continue;
    changes.set(path, status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "changed");
  }
  for (const path of git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8")
    .split("\0"))
    if (path !== "") changes.set(path, "added");
  return [...changes]
    .map(([path, change]) => ({ path, change }))
    .sort((a, b) => compare(a.path, b.path));
}

/** A file's text at `commit`, or null when it has none there. */
export function textAt(root: string, commit: string, path: string): string | null {
  try {
    return git(root, ["show", `${commit}:${path}`]).toString("utf8");
  } catch {
    return null;
  }
}

/** A file's text in the working tree, or null when it is not a file. */
export function textNow(root: string, path: string): string | null {
  const absolute = join(root, path);
  try {
    return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : null;
  } catch {
    return null;
  }
}

/** Judges the change from `base` (default `HEAD`) to the working tree. */
export function gateRepository(options: {
  readonly repo: string;
  readonly base?: string;
  readonly allow?: readonly string[];
  /** Paths or globs the change was meant to stay within. */
  readonly scope?: readonly string[];
}): Gate {
  const root = checkoutRoot(options.repo);
  const base = options.base ?? "HEAD";
  const baseCommit = baseCommitOf(root, base);
  const changes = changesSince(root, baseCommit);
  const judge = handoffPolicy({
    checks: true,
    testNoun: "a test",
    ...(options.allow === undefined ? {} : { allow: options.allow }),
  });
  const allowed = pathMatcher(options.allow ?? []);
  const inScope =
    options.scope === undefined || options.scope.length === 0 ? null : pathMatcher(options.scope);
  const refused: Refusal[] = [];
  for (const { path, change } of changes) {
    if (inScope !== null && !inScope(path) && !allowed(path)) {
      refused.push({ path, reason: "outside the scope given (--scope): review it and pass --allow to carry it" });
      continue;
    }
    const after = change === "deleted" ? null : textNow(root, path);
    const before = change === "added" ? null : textAt(root, baseCommit, path);
    const reason = judge(path, change, after === null ? undefined : { before, after });
    if (reason !== null) refused.push({ path, reason });
  }
  return { repo: root, base, baseCommit, changes, refused };
}
