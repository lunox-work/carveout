/**
 * Running code that came back from outside in a container.
 *
 * A folder that came back holds the contributor's code, and its tests run
 * it. On the maintainer's machine that code would run as the maintainer,
 * with their files (the closed repository, the receipts that map the
 * folder's pseudonyms back to the repository's names, credentials) and
 * their network. Here each step is its own `docker run --rm` that mounts one
 * directory, the scratch copy, and nothing else: no HOME, no receipts, no
 * checkout beyond the copy. Only the install step has a network, and it runs
 * a package manager with lifecycle scripts off on the receipt's manifests,
 * so none of the folder's code runs while the network is there. Every other
 * step (the build, the tests, the owner's acceptance tests, a merge's
 * verify command) runs with `--network none`, all capabilities dropped, a
 * read-only root, and bounds on memory and processes.
 *
 * Docker by default; `CARVEOUT_CONTAINER` names another runtime that takes
 * the same arguments (podman), and `CARVEOUT_SANDBOX_IMAGE` the image (a
 * Node image at this process's major version unless given).
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { relative, resolve, sep } from "node:path";

export interface SandboxSpec {
  /** The container runtime's executable: `docker`, or one that takes its arguments. */
  readonly runtime: string;
  /** The image every step runs in: it needs `node`, `npm` and `sh`. */
  readonly image: string;
}

/** The runtime and image from the environment, or Docker and a Node image at this process's major version. */
export function defaultSandbox(image?: string): SandboxSpec {
  return {
    runtime: process.env["CARVEOUT_CONTAINER"] ?? "docker",
    image: image ?? process.env["CARVEOUT_SANDBOX_IMAGE"] ?? `node:${process.versions.node.split(".")[0] ?? "22"}`,
  };
}

/**
 * Why the sandbox cannot run, or null when it can: the runtime answers, its
 * daemon runs Linux containers, and the image is there or can be pulled.
 */
export function sandboxUnavailable(spec: SandboxSpec): string | null {
  try {
    const os = execFileSync(spec.runtime, ["info", "--format", "{{.OSType}}"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    })
      .toString("utf8")
      .trim();
    if (os !== "" && os !== "linux") return `${spec.runtime} runs ${os} containers; the sandbox needs Linux ones.`;
  } catch (error) {
    return `${spec.runtime} does not answer (${firstLine(error)}): start it, or set CARVEOUT_CONTAINER to a runtime that takes Docker's arguments.`;
  }
  try {
    execFileSync(spec.runtime, ["image", "inspect", spec.image], { stdio: "ignore", timeout: 20_000 });
  } catch {
    try {
      execFileSync(spec.runtime, ["pull", "--quiet", spec.image], { stdio: "ignore", timeout: 10 * 60_000 });
    } catch (error) {
      return `${spec.runtime} has no image ${spec.image} and could not pull it (${firstLine(error)}): pull it, or name another with --sandbox-image or CARVEOUT_SANDBOX_IMAGE.`;
    }
  }
  return null;
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? ((error as { stderr?: Buffer }).stderr?.toString("utf8") || error.message) : String(error)).trim().split("\n")[0] ?? "";

/** Where a directory under the mounted one is inside the container. */
export const MOUNT = "/work";

/**
 * Runs one command in a fresh container that mounts `root` at `/work` and
 * nothing else, in `cwd` (a directory under `root`). Host paths under
 * `root` in the arguments are rewritten to the container's, and this Node's
 * own path to `node`. Only the names in `env` are passed, with HOME and the
 * npm cache in the container's own /tmp. With `network` false the container
 * has none. At `limitMs` the container is killed.
 */
export function sandboxRun(
  spec: SandboxSpec,
  root: string,
  command: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly network: boolean;
    readonly limitMs?: number;
  },
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const base = resolve(root);
  const inside = (path: string) => {
    const at = relative(base, resolve(path));
    if (at === "") return MOUNT;
    if (at.startsWith("..") || at.startsWith(sep)) throw new Error(`${path} is outside the sandbox's folder ${base}.`);
    return `${MOUNT}/${at.split(sep).join("/")}`;
  };
  const mapArgument = (value: string) => {
    if (value === process.execPath) return "node";
    return value.split(base).join(MOUNT);
  };
  const [executable = "true", ...args] = command;
  const name = `carveout-${randomBytes(6).toString("hex")}`;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {}))
    if (key !== "PATH" && key !== "HOME" && key !== "SystemRoot" && !key.startsWith("npm_config_")) env[key] = value;
  const runArgs = [
    "run",
    "--rm",
    "--name",
    name,
    "--init",
    ...(options.network ? [] : ["--network", "none"]),
    ...(typeof process.getuid === "function" && typeof process.getgid === "function" ? ["--user", `${process.getuid()}:${process.getgid()}`] : []),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=2g",
    "--memory",
    process.env["CARVEOUT_SANDBOX_MEMORY"] ?? "4g",
    "--pids-limit",
    "2048",
    "--volume",
    `${base}:${MOUNT}`,
    "--workdir",
    inside(options.cwd ?? base),
    "--env",
    "HOME=/tmp",
    "--env",
    "npm_config_cache=/tmp/.npm",
    "--env",
    "npm_config_update_notifier=false",
    "--env",
    "CI=1",
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${mapArgument(value)}`]),
    spec.image,
    mapArgument(executable),
    ...args.map(mapArgument),
  ];
  return new Promise((resolvePromise) => {
    const child = spawn(spec.runtime, runArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      try {
        execFileSync(spec.runtime, ["kill", name], { stdio: "ignore", timeout: 30_000 });
      } catch {
        // Already gone.
      }
      child.kill("SIGKILL");
    }, options.limitMs ?? 10 * 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr: `${stderr}${error.message}`, status: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, status: code });
    });
  });
}
