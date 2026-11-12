/**
 * The hosted round trip, on the platform (sandbox-factory) a workspace
 * signed in to with `carveout login` (`platform.ts`):
 *
 *   handoff --platform --bounty <id>
 *     After the local cut and check, the folder, which must be ready,
 *     public and in pseudonyms, is uploaded with the owner's acceptance
 *     tests renamed into the folder's names by the receipt's table:
 *     POST /api/v1/orgs/:org/sandboxes/uploads, under an Idempotency-Key.
 *     The platform hosts it as a draft version of the bounty, its baseline
 *     run with every acceptance test failing, and grades contributors'
 *     submissions against it. What was uploaded is recorded in
 *     `CARVEOUT_HOME/platform/<cut id>.json`. Publishing the version is a
 *     person's act in the platform's web app.
 *
 *   patch --from <submission id>
 *     GET /api/v1/orgs/:org/sandboxes/submissions/:sid/files: a passing
 *     submission's changed files. They are laid over a scratch copy of the
 *     folder (cut again from the receipt at the cut's commit when the
 *     folder is gone or edited), and `patchProject` judges that copy with
 *     the local receipt exactly as `patch <dir>` judges a folder that came
 *     back by hand.
 *
 * What leaves this machine is the folder and the renamed acceptance tests:
 * never the receipt, its table, or a file outside the folder. The platform
 * refuses a folder that holds the workspace's names or a credential.
 * `carveout/api` never imports this module.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CARVEOUT_VERSION, RECORD_PATH, carveoutHome, cutSlice, isTextContent, patchProject, type Patch } from "./carve.js";
import { TOOL_DIRS } from "./core.js";
import { assertSafePath } from "./policy.js";
import { exactToFolder } from "./pseudonyms/index.js";
import { folderView, readReceipt, type Receipt } from "./receipt.js";
import { credentialFor, credentialsPath, platformUrl, PlatformError, request, type Credential } from "./platform.js";

const CLIENT = "carveout";
/** An upload is large and is checked before it is answered. */
export const UPLOAD_TIMEOUT_MS = 180_000;
export const PLATFORM_RECORD_SCHEMA_VERSION = 1;

/** The outside world the two commands use; tests pass their own. */
export interface HostedDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
}

/** What `handoff --platform` uploaded, kept beside the receipts: never sent. */
export interface PlatformRecord {
  readonly schemaVersion: typeof PLATFORM_RECORD_SCHEMA_VERSION;
  readonly base: string;
  readonly org: string;
  readonly bountyId: string;
  readonly sandboxId: string;
  readonly versionId: string;
  readonly runId: string;
  /** The receipt file, absolute. */
  readonly receipt: string;
  /** The folder uploaded, absolute. */
  readonly folder: string;
  /** The hash of the folder's carveout.json as uploaded: how a submission is matched to it. */
  readonly recordSha256: string;
  readonly cutId: string;
  readonly uploadedAt: string;
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** Where uploads are recorded: `CARVEOUT_HOME/platform`. */
export const platformRecordDir = () => join(carveoutHome(), "platform");

/** Writes a platform record where only its owner reads it, whole. */
function writePlatformRecord(record: PlatformRecord): string {
  const dir = platformRecordDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${record.cutId}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  return target;
}

/** The upload whose folder record hashes to `recordSha256`, or null. */
export function findPlatformRecord(recordSha256: string): PlatformRecord | null {
  const dir = platformRecordDir();
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<PlatformRecord>;
      if (record.schemaVersion === PLATFORM_RECORD_SCHEMA_VERSION && record.recordSha256 === recordSha256)
        return record as PlatformRecord;
    } catch {
      // Not one of ours; another is looked at.
    }
  }
  return null;
}

/**
 * Every file of a folder as text, at its folder path: none under
 * node_modules or .git, nor a tool's folder at the root (`TOOL_DIRS`). A
 * binary file or a link is refused, never sent as something else.
 */
export function folderFiles(folder: string): { path: string; text: string }[] {
  const root = resolve(folder);
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.name === "node_modules" || entry.name === ".git" || (dir === "" && TOOL_DIRS.includes(entry.name))) continue;
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) throw new PlatformError(`${path} is a link; a folder uploaded holds files only.`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const bytes = readFileSync(join(root, path));
        if (!isTextContent(bytes))
          throw new PlatformError(`${path} is not UTF-8 text; the platform takes a folder of text files only.`);
        files.push({ path, text: bytes.toString("utf8") });
      }
    }
  };
  walk("");
  return files;
}

/** This CLI's saved sign-in for `base`, or a PlatformError saying how to get one. */
function signedIn(base: string, env: NodeJS.ProcessEnv): Credential {
  const saved = credentialFor(credentialsPath(env), base, CLIENT);
  if (saved === undefined) throw new PlatformError(`Not signed in to ${base}. Run \`carveout login\`.`);
  return saved;
}

/**
 * Uploads a folder `handoff` cut and checked: refused unless it is public
 * and in pseudonyms, with at least one acceptance test, each of which maps
 * into the folder's names byte for byte. Answers what it recorded.
 */
export async function handoffPlatform(input: {
  /** `--platform`'s value; else LUNOX_PLATFORM_URL, else production. */
  readonly platform?: string | undefined;
  readonly bountyId: string;
  readonly folder: string;
  readonly receiptPath: string;
  /** The owner's acceptance tests, at their repository paths. */
  readonly accepted: readonly { readonly path: string; readonly text: string }[];
  readonly title?: string | undefined;
  readonly deps: HostedDeps;
}): Promise<PlatformRecord & { readonly recordPath: string; readonly files: number }> {
  const base = platformUrl(input.platform, input.deps.env);
  const saved = signedIn(base, input.deps.env);
  const receipt: Receipt = readReceipt(input.receiptPath);
  const table = receipt.pseudonyms;
  const view = folderView(receipt);
  if (table === undefined || view.publicScrubbed !== true || view.request.public !== true)
    throw new PlatformError(
      "Only a public folder in pseudonyms is uploaded: hand off without --keep-names or --no-public, so the platform never has the repository's names.",
    );
  if (input.accepted.length === 0)
    throw new PlatformError(
      "The platform grades a submission by the owner's acceptance tests: hand off with --accept <test>..., tests that fail before the work.",
    );
  const acceptanceTests = input.accepted.map((test) => {
    const folder = exactToFolder(table, test.path, test.text);
    if (folder === null)
      throw new PlatformError(
        `${test.path} would not map into the folder's names byte for byte; rename what it names, and hand off again.`,
      );
    return { path: folder.path, text: folder.text, expectedBaseline: "fail" as const };
  });
  const files = folderFiles(input.folder);
  const recordText = files.find((file) => file.path === RECORD_PATH)?.text;
  if (recordText === undefined) throw new PlatformError(`${input.folder} has no ${RECORD_PATH}; it was not cut by carveout.`);
  const own = JSON.parse(recordText) as { cutId?: unknown };
  if (own.cutId !== receipt.cutId)
    throw new PlatformError(`${input.folder} is not the folder of cut ${receipt.cutId.slice(0, 8)}, whose receipt was given.`);
  const recordSha256 = sha256(recordText);
  const answer = await request<{ sandbox?: { id?: unknown }; version?: { id?: unknown }; run?: { id?: unknown } }>({
    base,
    method: "POST",
    path: `/api/v1/orgs/${encodeURIComponent(saved.organizationId)}/sandboxes/uploads`,
    token: saved.token,
    client: CLIENT,
    version: CARVEOUT_VERSION,
    fetchImpl: input.deps.fetchImpl,
    idempotencyKey: randomUUID(),
    timeoutMs: UPLOAD_TIMEOUT_MS,
    body: {
      bountyId: input.bountyId,
      carveout: { version: CARVEOUT_VERSION, recordSha256 },
      files,
      acceptanceTests,
      ...(input.title === undefined ? {} : { title: input.title }),
    },
  });
  const id = (value: { id?: unknown } | undefined) => (typeof value?.id === "string" ? value.id : null);
  const [sandboxId, versionId, runId] = [id(answer.sandbox), id(answer.version), id(answer.run)];
  if (sandboxId === null || versionId === null || runId === null)
    throw new PlatformError(`${base} took the upload but answered without its sandbox, version and run.`);
  const record: PlatformRecord = {
    schemaVersion: PLATFORM_RECORD_SCHEMA_VERSION,
    base,
    org: saved.organizationId,
    bountyId: input.bountyId,
    sandboxId,
    versionId,
    runId,
    receipt: resolve(input.receiptPath),
    folder: resolve(input.folder),
    recordSha256,
    cutId: receipt.cutId,
    uploadedAt: new Date(input.deps.now()).toISOString(),
  };
  return { ...record, recordPath: writePlatformRecord(record), files: files.length };
}

/** Whether the folder on disk is the one uploaded, every file the cut wrote unchanged. */
function folderIntact(folder: string, receipt: Receipt, recordSha256: string): boolean {
  const at = (path: string) => join(folder, path);
  if (!existsSync(at(RECORD_PATH)) || sha256(readFileSync(at(RECORD_PATH))) !== recordSha256) return false;
  const view = folderView(receipt);
  return [...(view.copied ?? []), ...view.generated].every(
    (file) => existsSync(at(file.path)) && sha256(readFileSync(at(file.path))) === file.sha256,
  );
}

/** The files of a folder, copied to `to`, without what `folderFiles` leaves out. */
function copyFolder(from: string, to: string): void {
  const root = resolve(from);
  cpSync(root, to, {
    recursive: true,
    filter: (source) => {
      const rel = source === root ? "" : source.slice(root.length + 1).split("\\").join("/");
      const parts = rel.split("/");
      return !parts.includes("node_modules") && !parts.includes(".git") && !(parts.length >= 1 && TOOL_DIRS.includes(parts[0] ?? ""));
    },
  });
}

/**
 * The folder cut again from the receipt, at the cut's commit, in a clone
 * of the repository: the copied files as the cut wrote them, the generated
 * ones and the record as the receipt keeps them. Refused unless every file
 * is the one uploaded.
 */
async function cutAgain(receipt: Receipt, scratch: string, out: string, recordSha256: string): Promise<void> {
  const record = receipt.record;
  const commit = record.manifest.sourceCommitSha;
  if (commit === null || !existsSync(receipt.repo))
    throw new PlatformError(
      `The folder ${receipt.out} is gone or edited, and the cut cannot be made again (${commit === null ? "it was not cut at a commit" : `${receipt.repo} is gone`}): restore the folder as it was uploaded.`,
    );
  const repo = join(scratch, "repo");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  git(scratch, ["clone", "-q", "--shared", "--no-checkout", receipt.repo, repo]);
  git(repo, ["checkout", "-q", "--detach", commit]);
  const request = record.request;
  await cutSlice({
    repo,
    out,
    entryPoints: request.entryPoints,
    budget: request.budget,
    choices: request.choices,
    offline: true,
    widenLiterals: request.widenLiterals,
    tests: request.tests === true,
    ...(request.live === undefined ? {} : { live: request.live }),
    wholePackage: request.wholePackage === true,
    followWorkspaces: request.followWorkspaces === true,
    copyPure: request.copyPure === true,
    private: request.private ?? [],
    copy: request.copy ?? [],
    public: true,
    ...(request.task === undefined ? {} : { task: request.task }),
    ...(receipt.pseudonyms === undefined ? {} : { earlierPseudonyms: receipt.pseudonyms, names: receipt.pseudonyms.vocabulary }),
    ...(receipt.unseen === undefined ? {} : { unseen: receipt.unseen }),
    receipt: join(scratch, "receipt.json"),
    log: () => {},
  });
  // What the cut generated, and its record, as the folder held them.
  for (const [path, text] of Object.entries(receipt.generatedText ?? {})) {
    assertSafePath(path, "a generated file");
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
  }
  writeFileSync(join(out, RECORD_PATH), `${JSON.stringify(folderView(receipt), null, 2)}\n`);
  if (!folderIntact(out, receipt, recordSha256))
    throw new PlatformError(
      `The folder ${receipt.out} is gone or edited, and cut again from the receipt it is not the folder uploaded: restore the folder as it was uploaded.`,
    );
}

/**
 * `patch --from`: a passing submission's files, from the platform, laid
 * over a copy of the folder that was uploaded and judged by the local
 * receipt (`patchProject`). The copy is removed after.
 */
export async function patchFrom(input: {
  readonly platform?: string | undefined;
  readonly submissionId: string;
  readonly repo?: string | undefined;
  readonly allow?: readonly string[] | undefined;
  readonly deps: HostedDeps;
}): Promise<{ readonly patch: Patch; readonly record: PlatformRecord; readonly files: number; readonly cutAgain: boolean }> {
  const base = platformUrl(input.platform, input.deps.env);
  const saved = signedIn(base, input.deps.env);
  const answer = await request<{
    upload?: { recordSha256?: unknown };
    files?: unknown;
  }>({
    base,
    path: `/api/v1/orgs/${encodeURIComponent(saved.organizationId)}/sandboxes/submissions/${encodeURIComponent(input.submissionId)}/files`,
    token: saved.token,
    client: CLIENT,
    version: CARVEOUT_VERSION,
    fetchImpl: input.deps.fetchImpl,
  });
  const recordSha256 = answer.upload?.recordSha256;
  const files = answer.files;
  if (
    typeof recordSha256 !== "string" ||
    !Array.isArray(files) ||
    !files.every((file: unknown) => typeof (file as { path?: unknown }).path === "string" && typeof (file as { text?: unknown }).text === "string")
  )
    throw new PlatformError(`${base} answered submission ${input.submissionId} without its files.`);
  const record = findPlatformRecord(recordSha256);
  if (record === null)
    throw new PlatformError(
      `Submission ${input.submissionId} is on a folder this machine did not upload (no record under ${platformRecordDir()}): run patch --from where handoff --platform ran.`,
    );
  if (!existsSync(record.receipt)) throw new PlatformError(`${record.receipt}: the receipt of that hand-off is gone.`);
  const receipt = readReceipt(record.receipt);
  const scratch = mkdtempSync(join(tmpdir(), "carveout-from-"));
  try {
    const dir = join(scratch, "folder");
    const intact = folderIntact(record.folder, receipt, recordSha256);
    if (intact) copyFolder(record.folder, dir);
    else await cutAgain(receipt, scratch, dir, recordSha256);
    for (const file of files as { path: string; text: string }[]) {
      try {
        assertSafePath(file.path, "a submitted file");
      } catch {
        throw new PlatformError(`${base} answered a file at ${JSON.stringify(file.path)}, which is not a plain path in the folder.`);
      }
      mkdirSync(dirname(join(dir, file.path)), { recursive: true });
      writeFileSync(join(dir, file.path), file.text);
    }
    const patch = await patchProject(dir, {
      receipt: record.receipt,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.allow === undefined ? {} : { allow: input.allow }),
    });
    return { patch, record, files: files.length, cutAgain: !intact };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
