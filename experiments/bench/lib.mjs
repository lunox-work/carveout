// One blind `claude -p` session, as duediligence/experiments/bin/lib.mjs
// starts them, with what the benchmark measures added: token usage by kind
// and the tools the agent used.
//
// Blindness is enforced, not trusted. Every session runs in its own
// workdir under WORK_ROOT (outside this repository) with:
// - the OS sandbox on for Bash: reads of the whole workspace (its clones
//   hold the commits being replayed, duediligence the hidden suites), the
//   source repositories, WORK_ROOT and the session transcripts are denied, except the session's own workdir; no
//   network; no unsandboxed fallback;
// - the same paths denied to the file tools by permission rules;
// - no CLAUDE.md, skills, plugins, hooks or MCP servers (`--safe-mode`,
//   `--strict-mcp-config`).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HERE, REPOS } from "../lib.mjs";

export const TRANSCRIPTS = join(homedir(), ".claude", "projects");
mkdirSync(join(realpathSync(tmpdir()), "carveout-bench-work"), { recursive: true });
export const WORK_ROOT = realpathSync(join(realpathSync(tmpdir()), "carveout-bench-work"));
// The whole workspace: this repository, the replayed repositories and
// duediligence, where the hidden suites came from.
const DENIED = [...new Set([realpathSync(join(HERE, "..", "..", "..")), ...Object.values(REPOS).filter(existsSync).map((path) => realpathSync(path))])];

export const SESSION_MINUTES = 30;
export const SESSION_BUDGET_USD = 10;
export const TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];
export const DEFAULT_MODEL = "claude-haiku-5-5";

/** Every `claude -p` at most MAX_SESSIONS at once, and none below MIN_FREE % memory free. */
const MAX_SESSIONS = Number(process.env.CARVEOUT_BENCH_MAX_SESSIONS ?? 2);
const MIN_FREE = Number(process.env.CARVEOUT_BENCH_MIN_FREE ?? 30);
const SLOTS = join(WORK_ROOT, "slots");

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const which = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim() !== "") return which.stdout.trim();
  const extensions = join(homedir(), ".vscode", "extensions");
  const bundled = existsSync(extensions)
    ? readdirSync(extensions)
        .filter((name) => name.startsWith("anthropic.claude-code-"))
        .sort()
        .map((name) => join(extensions, name, "resources", "native-binary", "claude"))
        .filter(existsSync)
    : [];
  if (bundled.length === 0)
    throw new Error("No claude CLI: set CLAUDE_BIN, put claude on PATH, or install the VS Code extension.");
  return bundled.at(-1);
}

const rulePath = (path) => `/${path}/**`;
const siblings = (own) =>
  readdirSync(WORK_ROOT)
    .map((name) => join(WORK_ROOT, name))
    .filter((path) => path !== own && path !== SLOTS);

function sessionSettings(cwd) {
  const denied = [...DENIED, TRANSCRIPTS, ...siblings(cwd)];
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [...DENIED, TRANSCRIPTS, WORK_ROOT], allowRead: [cwd] },
    },
    permissions: {
      deny: [
        "WebFetch",
        "WebSearch",
        ...denied.flatMap((path) => ["Read", "Edit", "Write", "Glob", "Grep"].map((tool) => `${tool}(${rulePath(path)})`)),
      ],
    },
  };
}

export function freeMemoryPercent() {
  const out = spawnSync("memory_pressure", [], { encoding: "utf8" }).stdout ?? "";
  const match = /free percentage:\s*(\d+)%/.exec(out);
  return match === null ? 100 : Number(match[1]);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function takeSlot() {
  mkdirSync(SLOTS, { recursive: true });
  for (;;) {
    if (freeMemoryPercent() >= MIN_FREE)
      for (let i = 0; i < MAX_SESSIONS; i += 1) {
        const path = join(SLOTS, `slot-${i}`);
        try {
          writeFileSync(path, String(process.pid), { flag: "wx" });
          return path;
        } catch {
          const owner = Number(existsSync(path) ? readFileSync(path, "utf8") : 0);
          if (owner > 0 && !alive(owner)) rmSync(path, { force: true });
        }
      }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/** Token usage of a session, from its result line, by kind. */
function usageOf(result) {
  const usage = result?.usage ?? {};
  const fresh = usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    input: fresh,
    cacheWrite,
    cacheRead,
    totalInput: fresh + cacheWrite + cacheRead,
    output: usage.output_tokens ?? 0,
    byModel: result?.modelUsage ?? null,
  };
}

/** The tools a transcript called, by name, and the bytes their results gave back. */
export function toolStats(lines) {
  const calls = {};
  let resultBytes = 0;
  for (const line of lines) {
    for (const block of line.message?.content ?? []) {
      if (block.type === "tool_use") calls[block.name] = (calls[block.name] ?? 0) + 1;
      if (block.type === "tool_result")
        resultBytes += Buffer.byteLength(typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""));
    }
  }
  return { calls, resultBytes };
}

/**
 * One session in `cwd`, its stream-json transcript written to `transcript`.
 * Resolves with what the result line says; never rejects on the session's
 * own failure.
 */
export async function claude({ cwd, text, transcript, model }) {
  const argv = [
    "-p",
    text,
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-chrome",
    "--disable-slash-commands",
    "--tools",
    TOOLS.join(","),
    "--permission-mode",
    "bypassPermissions",
    "--max-budget-usd",
    String(SESSION_BUDGET_USD),
    "--settings",
    JSON.stringify(sessionSettings(cwd)),
    "--model",
    model ?? DEFAULT_MODEL,
  ];
  mkdirSync(dirname(transcript), { recursive: true });
  const slot = await takeSlot();
  const started = Date.now();
  return new Promise((resolve) => {
    // Sessions bill the signed-in subscription: an API key in the
    // environment would take precedence, so none is passed.
    const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env;
    const child = spawn(claudeBin(), argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, SESSION_MINUTES * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(slot, { force: true });
      const out = Buffer.concat(chunks).toString("utf8");
      writeFileSync(transcript, out);
      const lines = out
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const result = lines.findLast((line) => line.type === "result") ?? null;
      const init = lines.find((line) => line.type === "system" && line.subtype === "init");
      resolve({
        model: init?.model ?? null,
        ok: code === 0 && result !== null && result.is_error !== true && !timedOut,
        timedOut,
        costUsd: result?.total_cost_usd ?? null,
        turns: result?.num_turns ?? null,
        minutes: Math.round((Date.now() - started) / 600) / 100,
        usage: usageOf(result),
        tools: toolStats(lines),
        apiError: result?.api_error ?? null,
        error: result?.is_error === true ? String(result.result ?? result.terminal_reason ?? "model session failed").slice(0, 1000) : null,
        stderr: stderr.slice(-2000),
      });
    });
  });
}

/** Tool calls that reached for anything denied: a sign the blindness leaked, or was tried. */
export function peeks(transcript, own) {
  if (!existsSync(transcript)) return [];
  const found = [];
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      const input = JSON.stringify(block.input ?? {});
      const hit = [...DENIED, ".claude/projects"].find((pattern) => input.includes(pattern));
      const outside = input
        .split(WORK_ROOT)
        .slice(1)
        .some((tail) => tail.startsWith("/") && !`${WORK_ROOT}${tail}`.startsWith(own));
      if (hit !== undefined || outside) found.push({ tool: block.name, match: hit ?? "another workdir", input: input.slice(0, 300) });
    }
  }
  return found;
}

/** Removes a workdir under WORK_ROOT. */
export function discard(dir) {
  if (!dir.startsWith(`${WORK_ROOT}/`)) throw new Error(`Not a workdir: ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}
