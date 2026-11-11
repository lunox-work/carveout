/**
 * Whether a folder is ready to hand to someone at a fixed scope: its tests
 * must pass before any edit, or "make the tests pass" is not a task anyone
 * can finish in it. A test fails at the folder's baseline when it reaches a
 * mock for something the repository runs for real: pure code past the cut
 * (a validator, a formatter), a database or queue client, or a folder the
 * code reads by a name no import spells (drizzle's `drizzle/` migrations,
 * Prisma's `prisma/`). The cut knows which of these the slice has, and
 * names the flag that brings each: `--copy-pure`, `--live`, `--copy`.
 *
 * The advice is the maintainer's: a public cut prints it and keeps it out
 * of the folder, since the paths it names may lie outside what the folder
 * shows.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

/** What a cut can change so the folder's tests run on real code. */
export interface Readiness {
  /** The tests that run the slice's code and came with the folder. */
  readonly tests: number;
  /**
   * Modules the slice mocks that `--copy-pure` would copy (pure code its
   * tests run), with their lines; null when the cut copies pure code
   * already or carries no test.
   */
  readonly copyPure: {
    readonly files: readonly string[];
    readonly lines: number;
    /** The file budget the cut with it needs, when this cut's would leave files out. */
    readonly needsMaxFiles?: number;
  } | null;
  /** Mocked packages of a database, cache or queue: `--live` keeps one real. */
  readonly live: readonly { readonly name: string; readonly service: string }[];
  /** Folders a slice package reads by a configured name: `--copy` brings one. */
  readonly copy: readonly { readonly path: string; readonly files: number; readonly why: string }[];
}

/** Services a maintainer can run beside the folder, and what each needs. */
const LIVE_SERVICES: Readonly<Record<string, string>> = {
  postgres: "a Postgres server",
  mysql: "a MySQL server",
  mongodb: "a MongoDB server",
  redis: "a Redis server",
  queue: "the queue's broker",
  orm: "the database the ORM talks to",
  sqlite: "nothing: SQLite is a file",
};

/** The mocked service packages `--live` could keep real, by name. */
export function liveCandidates(
  dependencies: readonly {
    readonly name: string;
    readonly kind: string;
    readonly resolution: string;
  }[],
  serviceOf: (name: string) => string | null,
): { name: string; service: string }[] {
  return dependencies
    .filter((dependency) => dependency.kind === "package" && dependency.resolution === "runtime-mock")
    .flatMap((dependency) => {
      const service = serviceOf(dependency.name);
      return service !== null && LIVE_SERVICES[service] !== undefined
        ? [{ name: dependency.name, service }]
        : [];
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The files under a folder, as a count; 0 when it is not one. */
function fileCount(absolute: string): number {
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return 0;
  let count = 0;
  for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) count += 1;
  return count;
}

/** The text of the first of `names` under `dir` that exists, with its name. */
function firstText(repo: string, dir: string, names: readonly string[]): { name: string; text: string } | null {
  for (const name of names) {
    const path = join(repo, dir, name);
    if (existsSync(path) && statSync(path).isFile()) return { name, text: readFileSync(path, "utf8") };
  }
  return null;
}

/** A relative folder named in a config file, under the package, normalized. */
function underPackage(dir: string, named: string): string | null {
  const joined = posix.normalize(posix.join(dir, named.replace(/^\.\//, ""))).replace(/\/+$/, "");
  // The package itself (`out: "./"`) is no folder to copy beside the slice.
  if (joined.startsWith("..") || posix.isAbsolute(joined) || joined === "." || joined === posix.normalize(dir || ".")) return null;
  return joined;
}

/**
 * The folders the slice's packages read by a name their tools default to
 * or their configuration spells, which the walk cannot follow: drizzle's
 * migrations (`out` in `drizzle.config.*`, else `drizzle/` with its
 * journal), Prisma's schema and migrations (`prisma/`), knex's
 * (`directory` in a knexfile, else `migrations/`), and a package's own
 * `migrations/` folder. Folders the cut copies already, or holds files of,
 * are left out.
 */
export function configuredFolders(
  repo: string,
  packageDirs: readonly string[],
  held: (path: string) => boolean,
): { path: string; files: number; why: string }[] {
  const found = new Map<string, { path: string; files: number; why: string }>();
  const add = (path: string | null, why: string) => {
    if (path === null || found.has(path) || held(path)) return;
    const files = fileCount(join(repo, path));
    if (files > 0) found.set(path, { path, files, why });
  };
  for (const dir of [...new Set(packageDirs)].sort()) {
    const drizzle = firstText(repo, dir, [
      "drizzle.config.ts",
      "drizzle.config.mts",
      "drizzle.config.js",
      "drizzle.config.mjs",
      "drizzle.config.cjs",
      "drizzle.config.json",
    ]);
    const out = drizzle === null ? null : /["']?\bout["']?\s*:\s*["'`]([^"'`]+)["'`]/.exec(drizzle.text)?.[1];
    if (out !== undefined && out !== null) add(underPackage(dir, out), `drizzle's migrations (out in ${drizzle?.name})`);
    else if (existsSync(join(repo, dir, "drizzle", "meta", "_journal.json")))
      add(underPackage(dir, "drizzle"), "drizzle's migrations, which migrate() reads by its default name");
    if (existsSync(join(repo, dir, "prisma", "schema.prisma")))
      add(underPackage(dir, "prisma"), "Prisma's schema and migrations");
    const knex = firstText(repo, dir, ["knexfile.ts", "knexfile.js", "knexfile.mjs", "knexfile.cjs"]);
    // The migrations' directory, not the seeds': inside `migrations: { … }`.
    const directory =
      knex === null ? undefined : /\bmigrations\s*:\s*\{[^}]*?\bdirectory\s*:\s*["'`]([^"'`]+)["'`]/s.exec(knex.text)?.[1];
    if (directory !== undefined) add(underPackage(dir, directory), `knex's migrations (directory in ${knex?.name})`);
    add(underPackage(dir, "migrations"), "a migrations folder the code reads by name");
  }
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Whether the readiness names anything the maintainer could do. */
export function hasAdvice(readiness: Readiness): boolean {
  return (
    (readiness.copyPure !== null && readiness.copyPure.files.length > 0) ||
    readiness.live.length > 0 ||
    readiness.copy.length > 0
  );
}

/**
 * The advice as lines for a terminal: each flag with what it brings and
 * what it costs (more of the repository shown, or a service to run).
 */
export function renderReadiness(readiness: Readiness): string[] {
  const lines: string[] = [];
  if (readiness.copyPure !== null && readiness.copyPure.files.length > 0) {
    const shown = readiness.copyPure.files.slice(0, 5).join(", ");
    const more = readiness.copyPure.files.length > 5 ? `, and ${readiness.copyPure.files.length - 5} more` : "";
    lines.push(
      `  --copy-pure${readiness.copyPure.needsMaxFiles === undefined ? "" : ` --max-files ${readiness.copyPure.needsMaxFiles}`}: copies ${readiness.copyPure.files.length} module(s) the slice mocks now (${readiness.copyPure.lines} lines: ${shown}${more}): the pure code its tests run, and the workspace source on the way; the contributor reads them.${readiness.copyPure.needsMaxFiles === undefined ? "" : ` The current file budget would leave some out, and the tests with them.`}`,
    );
  }
  for (const { name, service } of readiness.live)
    lines.push(`  --live ${name}: keeps the ${service} client real; the folder's tests then need ${LIVE_SERVICES[service] ?? "the service"}.`);
  for (const { path, files, why } of readiness.copy)
    lines.push(`  --copy ${path}: ${why}, ${files} file(s); the contributor reads them.`);
  return lines;
}
