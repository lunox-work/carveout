/**
 * Where the agents' session logs are, and which of them touched this
 * repository. Claude Code keeps one folder per working directory under
 * `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`); Codex keeps
 * rollouts by date under `$CODEX_HOME/sessions` (default `~/.codex`). A
 * session started in another folder still counts when its log names a
 * path in the repository (a worktree's, or one given with `--was`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { parseClaudeSession, type ParsedSession } from "./claude.js";
import { parseCodexSession } from "./codex.js";
import type { ParseContext } from "./shell.js";

export type AgentName = "claude" | "codex";

export interface LogHomes {
  /** Claude Code's configuration folder, which holds `projects/`. */
  readonly claude: string;
  /** Codex's home, which holds `sessions/`. */
  readonly codex: string;
}

/** The agents' log folders, as the agents themselves name them. */
export function logHomes(env: NodeJS.ProcessEnv = process.env): LogHomes {
  return {
    claude: env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"),
    codex: env["CODEX_HOME"] ?? join(homedir(), ".codex"),
  };
}

/** A folder as Claude Code names its project folder: every character but a letter or digit a dash. */
export const claudeProjectName = (folder: string) => folder.replace(/[^A-Za-z0-9]/g, "-");

/** The checkout's other paths: its realpath, its Git worktrees, and those given. */
export function repoRoots(root: string, was: readonly string[] = []): string[] {
  const roots = new Set<string>([resolve(root)]);
  try {
    roots.add(realpathSync(root));
  } catch {
    // Not there: the path as given.
  }
  try {
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
    for (const line of listed.split("\n")) if (line.startsWith("worktree ")) roots.add(line.slice(9).trim());
  } catch {
    // Not a Git checkout.
  }
  for (const path of was) roots.add(resolve(path));
  return [...roots].filter(Boolean).sort((a, b) => b.length - a.length);
}

function walkFiles(dir: string, match: (name: string) => boolean, into: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return into;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return into;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, match, into, depth + 1);
    else if (entry.isFile() && match(entry.name)) into.push(path);
  }
  return into;
}

export interface FoundLogs {
  readonly sessions: ParsedSession[];
  /** The folders looked in, for a run that found nothing. */
  readonly looked: readonly string[];
  /** Log files read. */
  readonly read: number;
}

export interface FindOptions {
  readonly roots: readonly string[];
  readonly agents: readonly AgentName[];
  /** Leave out logs last written before this time. */
  readonly since?: number;
  readonly homes?: LogHomes;
  readonly ctx: ParseContext;
}

/** Every session of the agents asked for whose log names a path in the repository, parsed. */
export function findSessions(options: FindOptions): FoundLogs {
  const homes = options.homes ?? logHomes();
  const looked: string[] = [];
  const sessions: ParsedSession[] = [];
  let read = 0;
  const fresh = (path: string) => options.since === undefined || statSync(path).mtimeMs >= options.since;
  const names = options.roots.flatMap((root) => [root, JSON.stringify(root).slice(1, -1)]);
  const mentions = (text: string) => names.some((name) => text.includes(name));
  if (options.agents.includes("claude")) {
    const projects = join(homes.claude, "projects");
    looked.push(projects);
    const owned = options.roots.map(claudeProjectName);
    let dirs: string[] = [];
    try {
      dirs = readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      const folder = join(projects, dir);
      const own = owned.some((name) => dir === name || dir.startsWith(`${name}-`));
      let entries: string[] = [];
      try {
        entries = readdirSync(folder).filter((name) => name.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const name of entries) {
        const file = join(folder, name);
        if (!fresh(file)) continue;
        const id = basename(name, ".jsonl");
        const subagents = walkFiles(join(folder, id, "subagents"), (each) => each.endsWith(".jsonl"));
        const logs = [file, ...subagents].map((path) => ({ file: path, text: readFileSync(path, "utf8") }));
        read += logs.length;
        if (!own && !logs.some((log) => mentions(log.text))) continue;
        const session = parseClaudeSession(id, logs, options.ctx);
        if (session.events.length > 0 || own) sessions.push(session);
      }
    }
  }
  if (options.agents.includes("codex")) {
    for (const folder of ["sessions", "archived_sessions"]) {
      const dir = join(homes.codex, folder);
      if (folder === "sessions" || existsSync(dir)) looked.push(dir);
      for (const file of walkFiles(dir, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))) {
        if (!fresh(file)) continue;
        const text = readFileSync(file, "utf8");
        read++;
        if (!mentions(text)) continue;
        const session = parseCodexSession(file, text, options.ctx);
        const ownCwd = session.cwd !== null && options.roots.some((root) => session.cwd === root || session.cwd?.startsWith(`${root}/`));
        if (session.events.length > 0 || ownCwd) sessions.push(session);
      }
    }
  }
  return { sessions, looked, read };
}

/** A parse context over the repository's files: paths under any of its roots, lines read once and kept. */
export function repoContext(root: string, roots: readonly string[], files: ReadonlySet<string>): ParseContext & { readonly cache: Map<string, readonly string[] | null> } {
  const cache = new Map<string, readonly string[] | null>();
  return {
    cache,
    relative(absolute: string) {
      const path = posix.normalize(absolute.replaceAll("\\", "/"));
      for (const base of roots) {
        if (path === base) return null;
        if (path.startsWith(`${base}/`)) {
          const relative = path.slice(base.length + 1);
          return relative === "" || relative.startsWith("../") ? null : relative;
        }
      }
      return null;
    },
    lines(path: string) {
      if (!files.has(path)) return null;
      const known = cache.get(path);
      if (known !== undefined) return known;
      let lines: readonly string[] | null = null;
      try {
        const text = readFileSync(join(root, path), "utf8");
        const split = text.split("\n");
        if (split.length > 0 && split[split.length - 1] === "") split.pop();
        lines = split;
      } catch {
        lines = null;
      }
      cache.set(path, lines);
      return lines;
    },
  };
}
