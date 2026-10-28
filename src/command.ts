import { spawn } from "node:child_process";

/**
 * Runs a tool to completion and returns its stdout. `env` is added to a
 * minimal base, so nothing of the caller's environment but PATH and HOME
 * passes through; an abort kills the whole process group.
 */
export function command(
  executable: string,
  args: readonly string[],
  options: {
    signal: AbortSignal;
    cwd?: string;
    env?: Record<string, string>;
  },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"] ?? "",
        ...(process.env["HOME"] === undefined
          ? {}
          : { HOME: process.env["HOME"] }),
        ...(process.env["SystemRoot"] === undefined
          ? {}
          : { SystemRoot: process.env["SystemRoot"] }),
        ...options.env,
      },
    });
    let output = "";
    let errors = "";
    const abort = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString("utf8")).slice(-8_192);
    });
    options.signal.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", abort);
      if (options.signal.aborted) reject(options.signal.reason);
      else if (code === 0) resolve(output);
      else
        reject(
          new Error(
            `${[executable, ...args].join(" ")} exited ${code ?? "on a signal"}:\n${`${output.trim()}\n${errors.trim()}`.trim().split("\n").slice(-40).join("\n")}`,
          ),
        );
    });
  });
}
