/**
 * `carveout login`, `whoami` and `logout` against the hosted platform
 * (`platform.ts`). Each takes its argv and the outside world as `deps`, so
 * test/platform.test.ts drives them against a fake platform with no real
 * waiting; `cli.ts` runs them before it reads any slice option.
 *
 * login is RFC 8628's device flow on the platform's Better Auth:
 *   POST /api/auth/device/code  {client_id}                          → device_code, user_code, verification_uri(_complete), expires_in, interval
 *   POST /api/auth/device/token {grant_type, device_code, client_id} → access_token (a session that may only mint this client's token)
 *   GET  /api/v1/me, GET /api/v1/me/orgs                               (with that session)
 *   POST /api/v1/orgs/:orgId/tokens/cli {client, label}               → { token, secret }: a 90-day lnx_ token; the session ends
 * The token is saved, never printed.
 */

import { spawn } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { credentialFor, credentialsPath, platformUrl, PlatformError, request, saveCredential, type RequestOptions } from "./platform.js";

const GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const ADMIN_ROLES = new Set(["owner", "admin"]);

export interface AccountDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly isTTY: boolean;
  readonly ask: (question: string) => Promise<string>;
  readonly sleep: (ms: number) => Promise<unknown>;
  readonly now: () => number;
  readonly fetchImpl: typeof fetch;
  readonly openUrl: (url: string) => void;
  readonly hostname: () => string;
}

export interface ClientId {
  readonly client: string;
  readonly version: string;
}

export type AccountCommand = "login" | "whoami" | "logout";

interface Org {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: string;
}

interface DeviceCode {
  readonly device_code?: string;
  readonly user_code?: string;
  readonly verification_uri?: string;
  readonly verification_uri_complete?: string;
  readonly expires_in?: number;
  readonly interval?: number;
}

interface User {
  readonly name: string;
  readonly email: string;
  readonly username?: string | null;
}

/** The process's own world; tests pass their own. */
export function defaultDeps(): AccountDeps {
  return {
    env: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    fetchImpl: fetch,
    openUrl,
    hostname: osHostname,
  };
}

/** The OS's browser opener, detached; a failure is only a missed convenience. */
function openUrl(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // The URL is printed either way.
  }
}

/** Whether a held role (Better Auth joins several with commas) may mint a token. */
const isAdmin = (role: string) =>
  String(role)
    .split(",")
    .some((one) => ADMIN_ROLES.has(one.trim()));
const describe = (org: Org) => `${org.slug} (${org.name}, ${org.role}) ${org.id}`;

type Spec = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

function options(argv: readonly string[], spec: Spec, usage: string): Record<string, string | boolean | undefined> {
  try {
    return parseArgs({
      args: [...argv],
      options: { ...spec, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
    }).values as Record<string, string | boolean | undefined>;
  } catch (error) {
    throw new PlatformError(`${(error as Error).message}\n${usage}`);
  }
}

const text = (value: string | boolean | undefined) => (typeof value === "string" ? value : undefined);

/** Runs one of the three, printing a PlatformError as one line on stderr. Answers the exit code. */
export async function runAccount(
  command: AccountCommand,
  argv: readonly string[],
  id: ClientId,
  deps: AccountDeps = defaultDeps(),
): Promise<number> {
  try {
    return await { login, whoami, logout }[command](argv, id, deps);
  } catch (error) {
    if (!(error instanceof PlatformError)) throw error;
    deps.err(`${id.client} ${command}: ${error.message}\n`);
    return 1;
  }
}

/** Picks the workspace to mint in: --org, the only one an owner or admin holds, or a choice on a TTY. */
async function chooseOrg(orgs: readonly Org[], wanted: string | undefined, client: string, deps: AccountDeps): Promise<Org> {
  const eligible = orgs.filter((org) => isAdmin(org.role));
  const listing = (list: readonly Org[]) => list.map((org) => `  ${describe(org)}`).join("\n");
  const matches = (org: Org, key: string) => org.id === key || org.slug.toLowerCase() === key.replace(/^@/, "").toLowerCase();
  if (wanted !== undefined) {
    const found = orgs.find((org) => matches(org, wanted));
    if (found === undefined) throw new PlatformError(`No workspace ${wanted} for this account. It has:\n${listing(orgs)}`);
    if (!isAdmin(found.role)) {
      throw new PlatformError(`You are ${found.role} in ${found.slug}; only its owners and admins can give ${client} a token.`);
    }
    return found;
  }
  const [only] = eligible;
  if (eligible.length === 1 && only !== undefined) return only;
  if (eligible.length === 0) {
    throw new PlatformError(
      orgs.length === 0
        ? "This account has no workspace yet. Create one in the platform's web app, then run login again."
        : `You are not an owner or admin of any workspace, and only they can give ${client} a token. This account has:\n${listing(orgs)}`,
    );
  }
  if (!deps.isTTY) {
    throw new PlatformError(
      `This account can sign in to ${eligible.length} workspaces; name one with --org <handle|id>:\n${listing(eligible)}`,
    );
  }
  deps.out(`\nWorkspaces you can sign ${client} in to:\n${eligible.map((org, i) => `  ${i + 1}. ${describe(org)}`).join("\n")}\n`);
  for (let tries = 0; tries < 3; tries += 1) {
    const answer = (await deps.ask(`Workspace [1-${eligible.length}]: `)).trim();
    const index = Number(answer);
    const picked = Number.isInteger(index) && index >= 1 ? eligible[index - 1] : eligible.find((org) => matches(org, answer));
    if (picked !== undefined) return picked;
  }
  throw new PlatformError("No workspace chosen.");
}

/** Polls the token endpoint at the server's interval, five seconds slower after each `slow_down`, until approval, denial or expiry. */
async function pollForSession(base: string, code: DeviceCode, { client, version }: ClientId, deps: AccountDeps): Promise<string> {
  let interval = Math.max(1, Number(code.interval) || 5) * 1000;
  const deadline = deps.now() + Math.max(1, Number(code.expires_in) || 900) * 1000;
  for (;;) {
    await deps.sleep(interval);
    if (deps.now() >= deadline) throw new PlatformError("The code expired before it was approved. Run login again.");
    try {
      const granted = await request<{ access_token?: unknown }>({
        base,
        method: "POST",
        path: "/api/auth/device/token",
        body: { grant_type: GRANT, device_code: code.device_code, client_id: client },
        client,
        version,
        fetchImpl: deps.fetchImpl,
      });
      if (typeof granted.access_token !== "string") throw new PlatformError("The platform approved the sign-in but sent no session.");
      return granted.access_token;
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      if (error.code === "authorization_pending") continue;
      if (error.code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (error.code === "expired_token") throw new PlatformError("The code expired before it was approved. Run login again.");
      if (error.code === "access_denied") throw new PlatformError("The sign-in was denied in the browser. Nothing was saved.");
      if (error.code === "invalid_grant") throw new PlatformError("The code is no longer valid (already used, or unknown). Run login again.");
      throw error;
    }
  }
}

export async function login(argv: readonly string[], id: ClientId, deps: AccountDeps): Promise<number> {
  const { client, version } = id;
  const usage = `usage: ${client} login [--platform <url>] [--org <handle|id>] [--open]`;
  const values = options(argv, { platform: { type: "string" }, org: { type: "string" }, open: { type: "boolean" } }, usage);
  if (values["help"] === true) {
    deps.out(
      `${usage}\n\nSigns ${client} in to the Lunox platform (default ${platformUrl(undefined, {})}; LUNOX_PLATFORM_URL) with a code\n` +
        `you approve in the browser, and saves a workspace token in ${credentialsPath(deps.env)} (LUNOX_CREDENTIALS).\n` +
        `--org picks the workspace; --open opens the approval page.\n`,
    );
    return 0;
  }
  const base = platformUrl(text(values["platform"]), deps.env);
  const call = <T>(more: Omit<RequestOptions, "base" | "client" | "version">) =>
    request<T>({ base, client, version, fetchImpl: deps.fetchImpl, ...more });
  const code = await call<DeviceCode>({ method: "POST", path: "/api/auth/device/code", body: { client_id: client } });
  if (typeof code.device_code !== "string" || typeof code.user_code !== "string") {
    throw new PlatformError(`${base} answered the sign-in request without a code.`);
  }
  const page = code.verification_uri_complete ?? code.verification_uri ?? `${base}/device`;
  const minutes = Math.round((Number(code.expires_in) || 900) / 60);
  deps.out(
    `To sign ${client} in to ${base}, open this page and approve the code:\n\n  ${page}\n\n` +
      `  Code: ${code.user_code} (expires in ${minutes} minute${minutes === 1 ? "" : "s"})\n\n`,
  );
  if (values["open"] === true) deps.openUrl(page);
  deps.out("Waiting for approval...\n");
  const session = await pollForSession(base, code, id, deps);
  const asSession = <T>(more: Omit<RequestOptions, "base" | "client" | "version" | "token" | "session">) =>
    call<T>({ token: session, session: true, ...more });
  let minted: { secret?: unknown; token?: { createdAt?: string; expiresAt?: string | null } };
  let me: User | undefined;
  let org: Org;
  try {
    me = (await asSession<{ user?: User }>({ path: "/api/v1/me" })).user;
    const orgs = (await asSession<{ organizations?: Org[] }>({ path: "/api/v1/me/orgs" })).organizations ?? [];
    org = await chooseOrg(orgs, text(values["org"]), client, deps);
    const label = String(deps.hostname() ?? "")
      .trim()
      .slice(0, 60);
    minted = await asSession({
      method: "POST",
      path: `/api/v1/orgs/${encodeURIComponent(org.id)}/tokens/cli`,
      body: label === "" ? { client } : { client, label },
    });
  } catch (error) {
    // Minting ends the session; a sign-in that stopped short ends it here, best effort.
    await asSession({ method: "POST", path: "/api/auth/sign-out", body: {} }).catch(() => {});
    throw error;
  }
  if (typeof minted.secret !== "string" || !minted.secret.startsWith("lnx_")) {
    throw new PlatformError(`${base} answered without a workspace token.`);
  }
  const path = credentialsPath(deps.env);
  const expiresAt = minted.token?.expiresAt ?? null;
  saveCredential(path, base, client, {
    token: minted.secret,
    organizationId: org.id,
    organizationHandle: org.slug,
    client,
    createdAt: minted.token?.createdAt ?? new Date(deps.now()).toISOString(),
    expiresAt,
  });
  const who = me ? `${me.name} <${me.email}>` : "you";
  const expiry = expiresAt ? `; it expires ${expiresAt.slice(0, 10)}` : "";
  deps.out(`Signed in as ${who}, workspace ${org.name} (@${org.slug}) on ${base}.\nToken saved to ${path}${expiry}.\n`);
  return 0;
}

export async function whoami(argv: readonly string[], { client, version }: ClientId, deps: AccountDeps): Promise<number> {
  const usage = `usage: ${client} whoami [--platform <url>]`;
  const values = options(argv, { platform: { type: "string" } }, usage);
  if (values["help"] === true) {
    deps.out(`${usage}\n\nThe account, workspace and token expiry ${client} is signed in with.\n`);
    return 0;
  }
  const base = platformUrl(text(values["platform"]), deps.env);
  const saved = credentialFor(credentialsPath(deps.env), base, client);
  if (saved === undefined) throw new PlatformError(`Not signed in to ${base}. Run \`${client} login\`.`);
  const call = <T>(path: string) => request<T>({ base, token: saved.token, path, client, version, fetchImpl: deps.fetchImpl });
  const { user } = await call<{ user: User }>("/api/v1/me");
  const { organization, role } = await call<{ organization: { name: string; slug: string }; role: string }>(
    `/api/v1/orgs/${encodeURIComponent(saved.organizationId)}`,
  );
  const expires = saved.expiresAt ? `expires ${saved.expiresAt.slice(0, 10)}` : "does not expire";
  deps.out(
    [
      `user       ${user.name} <${user.email}>${user.username ? ` (@${user.username})` : ""}`,
      `workspace  ${organization.name} (@${organization.slug}), ${role}`,
      `platform   ${base}`,
      `token      ${client}, ${expires}`,
      "",
    ].join("\n"),
  );
  return 0;
}

export async function logout(argv: readonly string[], { client }: ClientId, deps: AccountDeps): Promise<number> {
  const usage = `usage: ${client} logout [--platform <url>]`;
  const values = options(argv, { platform: { type: "string" } }, usage);
  if (values["help"] === true) {
    deps.out(`${usage}\n\nDeletes ${client}'s saved token for the platform.\n`);
    return 0;
  }
  const base = platformUrl(text(values["platform"]), deps.env);
  const path = credentialsPath(deps.env);
  const saved = credentialFor(path, base, client);
  if (saved === undefined) {
    deps.out(`Not signed in to ${base}; nothing to do.\n`);
    return 0;
  }
  saveCredential(path, base, client, undefined);
  // The platform lets no API token revoke itself (token routes take a person's session), so this is local.
  const until = saved.expiresAt ? `until ${saved.expiresAt.slice(0, 10)}` : "until it is revoked";
  deps.out(
    `Signed out of ${base}: the token is deleted from ${path}.\n` +
      `The platform has no route for a token to revoke itself, so it stays valid ${until} unless an owner or\n` +
      `admin of @${saved.organizationHandle} revokes it in the platform's web app (the workspace's API tokens).\n`,
  );
  return 0;
}
