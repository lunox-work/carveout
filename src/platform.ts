/**
 * The hosted platform (sandbox-factory, platform.lunox.work) as this CLI
 * talks to it: the base URL, the shared credentials file, and one request
 * function on `fetch`, so carveout keeps `typescript` as its only
 * dependency. Nothing here runs unless a platform command (`login`,
 * `whoami`, `logout`, in `account.ts`; `handoff --platform` and
 * `patch --from`, in `hosted.ts`) is called; every other command stays
 * local, and `carveout/api` never imports it.
 *
 * Credentials: `~/.lunox/credentials` (LUNOX_CREDENTIALS moves it), JSON,
 * mode 600 in a 700 folder, written whole through a rename. duediligence
 * shares the file, so each CLI keeps its own entry under the platform's URL:
 *
 *   { "https://platform.lunox.work": {
 *       "carveout": { token, organizationId, organizationHandle, client, createdAt, expiresAt },
 *       "duediligence": { ... } } }
 *
 * A token is minted for one client with that client's scopes, so the two
 * CLIs never share one; writing an entry keeps every other.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PLATFORM = "https://platform.lunox.work";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface Credential {
  readonly token: string;
  readonly organizationId: string;
  readonly organizationHandle: string;
  readonly client: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

type CredentialsFile = Record<string, Record<string, unknown>>;

export class PlatformError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, details: { status?: number; code?: string | undefined } = {}) {
    super(message);
    this.name = "PlatformError";
    this.status = details.status;
    this.code = details.code;
  }
}

/** `--platform`, else LUNOX_PLATFORM_URL, else production; no trailing slash. HTTPS, or plain HTTP to this machine only. */
export function platformUrl(given: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const raw = given ?? env["LUNOX_PLATFORM_URL"] ?? DEFAULT_PLATFORM;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PlatformError(`${raw} is not a URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new PlatformError(`${raw}: the platform must be https:// (plain http only on localhost).`);
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["LUNOX_CREDENTIALS"] ?? join(homedir(), ".lunox", "credentials");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The whole file, `{}` when there is none. A file that is not a JSON object is refused, never overwritten. */
export function readCredentials(path: string): CredentialsFile {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PlatformError(`${path} is not valid JSON (${(error as Error).message}); fix or remove it.`);
  }
  if (!isObject(parsed)) throw new PlatformError(`${path} does not hold a JSON object; fix or remove it.`);
  return parsed as CredentialsFile;
}

/** Writes the file whole: a 600 temp file beside it, renamed over it. Removes it when nothing is left. */
export function writeCredentials(path: string, all: CredentialsFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  if (Object.keys(all).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const temp = join(dir, `.credentials-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** This client's entry for a platform, or undefined. */
export function credentialFor(path: string, base: string, client: string): Credential | undefined {
  const entry = readCredentials(path)[base]?.[client];
  return isObject(entry) && typeof entry["token"] === "string" ? (entry as unknown as Credential) : undefined;
}

/** Sets (or, with `entry` undefined, removes) this client's entry, keeping every other. */
export function saveCredential(path: string, base: string, client: string, entry: Credential | undefined): void {
  const all = readCredentials(path);
  const forBase: Record<string, unknown> = { ...(isObject(all[base]) ? all[base] : {}) };
  if (entry === undefined) delete forBase[client];
  else forBase[client] = entry;
  if (Object.keys(forBase).length === 0) delete all[base];
  else all[base] = forBase;
  writeCredentials(path, all);
}

/** The minimum version a 426 names, wherever the body puts it. */
function minimumOf(body: Record<string, unknown> | undefined): string | undefined {
  const named = body?.["minimumVersion"] ?? body?.["minimum_version"] ?? body?.["minimum"];
  if (typeof named === "string") return named;
  const said = body?.["error"];
  return typeof said === "string" ? /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(said)?.[0] : undefined;
}

export interface RequestOptions {
  readonly base: string;
  readonly path: string;
  readonly client: string;
  readonly version: string;
  readonly method?: string;
  readonly token?: string | undefined;
  /** The token is a device sign-in's session rather than a saved API token. */
  readonly session?: boolean;
  readonly body?: unknown;
  readonly fetchImpl?: typeof fetch;
  /** Sent as `Idempotency-Key`: a retried create gets its first answer back. */
  readonly idempotencyKey?: string;
  /** How long the call may take; 30 seconds unless given (an upload takes longer). */
  readonly timeoutMs?: number;
}

/**
 * One call to the platform's API. Sends the token as a bearer, the client
 * and its version as `User-Agent` and `Lunox-Client-Version`
 * (`<client>/<version>`), and JSON. Answers the parsed body; throws a
 * PlatformError whose message says what to do: 401 → sign in again, 426 →
 * upgrade, otherwise the API's own `{ error, code }`.
 */
export async function request<T = Record<string, unknown>>(options: RequestOptions): Promise<T> {
  const {
    base,
    path,
    client,
    version,
    method = "GET",
    token,
    session = false,
    body,
    fetchImpl = fetch,
    idempotencyKey,
    timeoutMs = 30_000,
  } = options;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `${client}/${version}`,
    "Lunox-Client-Version": `${client}/${version}`,
  };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
  let response: Response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    throw new PlatformError(`Could not reach ${base}: ${cause ?? (error as Error).message}`);
  }
  const text = await response.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = text === "" ? undefined : JSON.parse(text);
    parsed = isObject(value) ? value : undefined;
  } catch {
    parsed = undefined;
  }
  if (response.ok) return (parsed ?? {}) as T;
  const status = response.status;
  const error = parsed?.["error"];
  const code =
    typeof parsed?.["code"] === "string"
      ? parsed["code"]
      : typeof error === "string" && !error.includes(" ")
        ? error
        : undefined;
  if (status === 426) {
    const minimum = minimumOf(parsed);
    throw new PlatformError(
      `${base} needs a newer ${client}${minimum ? `: upgrade to at least ${minimum}` : ""} (this is ${version}). npm i -g ${client}@latest`,
      { status, code },
    );
  }
  if (status === 401 && token !== undefined) {
    const what = session ? "The browser sign-in" : "The saved sign-in";
    throw new PlatformError(`${what} for ${base} is no longer valid (expired or revoked). Run \`${client} login\` again.`, {
      status,
      code,
    });
  }
  const said = parsed?.["error_description"] ?? error ?? parsed?.["message"];
  throw new PlatformError(
    typeof said === "string" ? `${said}${code && code !== said ? ` (${code})` : ""}` : `${method} ${path}: HTTP ${status}`,
    { status, code },
  );
}
