// Independent Codex sessions, kept outside the benchmark's private data.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HERE } from "../lib.mjs";

const q = (path) => JSON.stringify(path);

/** Permission profile applied to every agent tool command. */
export function profile(cwd, state) {
  const own = realpathSync(cwd);
  const siblings = readdirSync(dirname(own)).map((name) => join(dirname(own), name)).filter((path) => path !== own);
  const denied = [...new Set([homedir(), join(HERE, "..", "..", ".."), join(state, "codex"), ...siblings].map((path) => realpathSync(path)))];
  return [
    'default_permissions = "bench"', 'approval_policy = "never"',
    '[permissions.bench]', 'extends = ":read-only"',
    '[permissions.bench.filesystem]',
    ...denied.map((path) => `${q(path)} = "deny"`),
    `${q(own)} = "write"`,
    `${q(realpathSync(join(state, "home")))} = "write"`,
    `${q(realpathSync(join(state, "tmp")))} = "write"`,
    '[permissions.bench.network]', 'enabled = false',
  ].join("\n");
}

export function binary() {
  const found = spawnSync("which", ["codex"], { encoding: "utf8" });
  if (found.status !== 0) throw new Error("Codex CLI is not on PATH");
  return realpathSync(found.stdout.trim());
}

/** Run a session; Codex's own sandbox restricts generated commands. */
export async function codex({ cwd, text, transcript, model }) {
  if (process.platform !== "darwin") throw new Error("Codex benchmark isolation is implemented only for macOS");
  const bin = binary();
  const cliVersion = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
  const state = mkdtempSync(join(realpathSync(tmpdir()), "carveout-codex-state-"));
  const codexHome = join(state, "codex");
  const home = join(state, "home");
  const temp = join(state, "tmp");
  const started = Date.now();
  let running;
  const interrupt = () => { running?.kill("SIGTERM"); rmSync(state, { recursive: true, force: true }); process.exit(130); };
  process.once("SIGINT", interrupt);
  try {
    for (const dir of [codexHome, home, temp, dirname(transcript)]) mkdirSync(dir, { recursive: true });
    const auth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
    if (!existsSync(auth)) throw new Error("Codex login file is unavailable");
    cpSync(auth, join(codexHome, "auth.json"));
    writeFileSync(join(codexHome, "config.toml"), [
      'model_reasoning_effort = "high"', 'web_search = "disabled"', profile(cwd, state),
      "[features]", ...["apps", "plugins", "remote_plugin", "browser_use", "computer_use", "hooks", "multi_agent", "skill_search"].map((name) => `${name} = false`),
    ].join("\n") + "\n");
    const args = ["exec", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "--json", "--model", model, "-C", cwd, "-"];
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: temp, CODEX_HOME: codexHome, LANG: process.env.LANG ?? "en_US.UTF-8" };
    writeFileSync(transcript, "");
    const result = await new Promise((resolve) => {
      const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      running = child;
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.on("data", (chunk) => { stdout += chunk; appendFileSync(transcript, chunk); });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { stderr += String(error); });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 30 * 60_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
      child.stdin.end(text);
    });
    const events = result.stdout.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const completed = events.findLast((event) => event.type === "turn.completed");
    const failure = events.findLast((event) => event.type === "turn.failed" || event.type === "error");
    const usage = completed?.usage ?? {};
    const commands = events.filter((event) => event.type === "item.completed" && event.item?.type === "command_execution");
    const cached = usage.cached_input_tokens ?? 0;
    return {
      model, ok: result.code === 0 && completed !== undefined && !result.timedOut && !/exec_command failed/i.test(result.stderr),
      timedOut: result.timedOut, costUsd: null, turns: null,
      minutes: Math.round((Date.now() - started) / 600) / 100,
      usage: { input: (usage.input_tokens ?? 0) - cached, cacheWrite: usage.cache_write_input_tokens ?? 0, cacheRead: cached, totalInput: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 },
      tools: { calls: { Bash: commands.length }, resultBytes: commands.reduce((n, event) => n + Buffer.byteLength(event.item.aggregated_output ?? ""), 0) },
      apiError: /usage limit|rate.?limit|quota|out of credits/i.test(`${failure?.message ?? ""} ${result.stderr}`) ? "usage_limit_reached" : null,
      error: failure?.error?.message ?? failure?.message ?? null, stderr: result.stderr.slice(-2000), backend: "codex-cli", cliVersion,
    };
  } finally {
    process.removeListener("SIGINT", interrupt);
    rmSync(state, { recursive: true, force: true });
  }
}
