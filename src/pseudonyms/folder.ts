/**
 * A public folder in pseudonyms, and the way back.
 *
 * A public cut writes the slice for someone who must not learn whose code
 * it is. The names that say so (the organization, its handle and the
 * account that owns the repository, the repository's and the workspace's
 * package names, the maintainer's own name and address) are found by
 * `workspaceNames`, and every file the folder holds is written under a
 * table of renames that hides them: drafted by rule over the folder's own
 * text (`draftPseudonyms`), after any renames the owner wrote, and proved
 * to map back byte for byte (`applyAliases`). A name still in the folder
 * after the table is a `vocabulary_leaked` blocker.
 *
 * The table never leaves the maintainer: it is kept in the cut's receipt.
 * A folder that comes back is renamed back, path and text, into a scratch
 * copy at the repository's own paths (`unaliasFolder`), and the patch is
 * made from that copy as from any folder: the maintainer reads, and the
 * hand-off policy judges, the change in the repository's own names.
 *
 * A package the folder installs from the public registry keeps its name,
 * which npm needs: its occurrences are masked from the table both ways,
 * and named to the maintainer when they carry a term (`kept`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { applyAliases, invertAliasRules, renameFile, type AliasRule, type AliasedFile } from "./aliases.js";
import { draftPseudonyms, restyle } from "./draft.js";
import {
  emailNames,
  termMatches,
  termWords,
  vocabularyLeaks,
  type VocabularyLeak,
  type VocabularyName,
} from "./vocabulary.js";

/** What the receipt keeps of a public folder's pseudonyms. */
export interface FolderPseudonyms {
  /** The table, in the order it was applied: the owner's rules first. */
  readonly rules: readonly AliasRule[];
  /** Package names the folder installs and keeps, which carry a term. */
  readonly kept: readonly string[];
  /** The terms the folder was scanned for. */
  readonly vocabulary: readonly string[];
  /**
   * The placeholder each term was given. A placeholder occurs nowhere in
   * the repository's own text, so one the folder's holder wrote (a new
   * `AcmeDiscount`, a new `acme-totals.ts`) maps back to its term.
   */
  readonly words?: readonly { readonly term: string; readonly placeholder: string }[];
}

/** A package.json's fields that name its owner, or null when unreadable. */
function manifestNames(path: string): VocabularyName[] {
  if (!existsSync(path)) return [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const names: VocabularyName[] = [];
  const name = manifest["name"];
  if (typeof name === "string") {
    const slash = name.indexOf("/");
    if (name.startsWith("@") && slash > 1) names.push(ownerName(name.slice(1, slash)));
    else names.push({ name, kind: "name" });
  }
  const people = [manifest["author"], ...(Array.isArray(manifest["contributors"]) ? manifest["contributors"] : [])];
  for (const person of people) {
    if (typeof person === "string") {
      // "Name <mail@host> (url)"
      const mail = /<([^>]+)>/.exec(person)?.[1];
      const who = person.replace(/<[^>]*>|\([^)]*\)/g, "").trim();
      if (who !== "") names.push({ name: who, kind: "name" });
      if (mail !== undefined) names.push(...emailNames(mail));
    } else if (person !== null && typeof person === "object") {
      const record = person as Record<string, unknown>;
      if (typeof record["name"] === "string") names.push({ name: record["name"], kind: "name" });
      if (typeof record["email"] === "string") names.push(...emailNames(record["email"]));
    }
  }
  for (const field of ["repository", "homepage", "bugs"]) {
    const value = manifest[field];
    const url =
      typeof value === "string"
        ? value
        : value !== null && typeof value === "object" && typeof (value as Record<string, unknown>)["url"] === "string"
          ? ((value as Record<string, unknown>)["url"] as string)
          : null;
    if (url !== null) names.push(...hostedNames(url));
  }
  return names;
}

/**
 * A package scope: one word is scanned as an organization's (`acme`),
 * several as one name (`sandbox-factory`), since a scope is often named
 * after what the code is about, and those words (`sandbox`) are the code's.
 */
function ownerName(name: string): VocabularyName {
  return termWords(name).length > 1 ? { name, kind: "name" } : { name, kind: "organization" };
}

/** The account and repository a hosted URL names: `github.com/acme/shop`. */
function hostedNames(url: string): VocabularyName[] {
  const match = /(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?]|$)/i.exec(url);
  if (match === null) return [];
  // The account is the organization itself: its distinctive words are its
  // own (`lunox` of `lunox-work`), whatever the code is about.
  return [
    { name: match[1] ?? "", kind: "organization" },
    { name: match[2] ?? "", kind: "name" },
  ];
}

/** A Git setting of the checkout, or null. */
function gitValue(repo: string, args: readonly string[]): string | null {
  try {
    const value = execFileSync("git", [...args], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * The names a repository goes by, for a public folder to hide: the owner's
 * (`names` in the configuration, `--name`), the root's and the slice's
 * packages' names, scopes, authors and repository URLs, the account and
 * repository its `origin` remote names, the checkout's folder name, and the
 * maintainer's own Git name and address. `workspaceVocabulary` drops what
 * is too short or too generic to say whose code it is.
 */
export function workspaceNames(
  repo: string,
  packageDirs: readonly string[],
  owner: readonly string[] = [],
): VocabularyName[] {
  const names: VocabularyName[] = owner.map((name) => ({ name, kind: "organization" as const }));
  for (const dir of ["", ...packageDirs]) names.push(...manifestNames(join(repo, dir, "package.json")));
  const origin = gitValue(repo, ["remote", "get-url", "origin"]);
  if (origin !== null) names.push(...hostedNames(origin));
  names.push({ name: basename(repo), kind: "name" });
  const person = gitValue(repo, ["config", "user.name"]);
  if (person !== null) names.push({ name: person, kind: "name" });
  const mail = gitValue(repo, ["config", "user.email"]);
  if (mail !== null) names.push(...emailNames(mail));
  return names;
}

/** Characters no source holds, around a kept name's index while the table runs. */
const MASK_OPEN = "";
const MASK_CLOSE = "";

/** `text` with each kept name (longest first) behind a mask the table cannot match. */
export function maskKept(text: string, kept: readonly string[]): string {
  if (kept.length === 0) return text;
  let out = text;
  [...kept]
    .map((name, index) => ({ name, index }))
    .sort((a, b) => b.name.length - a.name.length)
    .forEach(({ name, index }) => {
      out = out.split(name).join(`${MASK_OPEN}${index}${MASK_CLOSE}`);
    });
  return out;
}

/** `maskKept` undone. */
export function unmaskKept(text: string, kept: readonly string[]): string {
  if (kept.length === 0 || !text.includes(MASK_OPEN)) return text;
  return text.replace(new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g"), (whole, index: string) => kept[Number(index)] ?? whole);
}

/** The kept names among the packages: those that carry one of the terms. */
export function keptNames(packages: readonly string[], vocabulary: readonly string[]): string[] {
  return [...new Set(packages)]
    .filter((name) => vocabulary.some((term) => termMatches(name, term).length > 0))
    .sort();
}

/** A folder's files in pseudonyms, or why the table could not be made. */
export type Pseudonymized =
  | {
      readonly ok: true;
      readonly table: FolderPseudonyms;
      /** The text files as the folder holds them, by repository path. */
      readonly files: ReadonlyMap<string, AliasedFile>;
      /** Each repository path's path in the folder, binaries included. */
      readonly pathOf: (path: string) => string;
      /** What the table left: a term still in a path or a text. */
      readonly leaks: readonly VocabularyLeak[];
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The folder's files under a table that hides `vocabulary`: the owner's
 * rules, then rules drafted over what they leave. `files` are the text
 * files at their repository paths, `binaries` the paths of the rest (only
 * their paths are renamed). Fails, writing nothing, when the table does
 * not map back byte for byte.
 */
export function pseudonymize(input: {
  readonly files: readonly AliasedFile[];
  readonly binaries: readonly string[];
  readonly vocabulary: readonly string[];
  readonly owner: readonly AliasRule[];
  readonly kept: readonly string[];
}): Pseudonymized {
  const masked: AliasedFile[] = [
    ...input.files.map((file) => ({ path: file.path, text: maskKept(file.text, input.kept) })),
    ...input.binaries.map((path) => ({ path, text: "" })),
  ];
  // Owner rules apply everywhere: a scope would need the original path,
  // which a file added in the folder does not have on the way back.
  const owner = input.owner.map((rule) => ({ ...rule, paths: [] }));
  const settled = masked.map((file) => renameFile(file, owner));
  const chosen = new Map<string, string>();
  const drafted = draftPseudonyms({ files: settled, vocabulary: input.vocabulary, imports: [], placeholders: chosen });
  const rules = [...owner, ...drafted];
  const applied = applyAliases(masked, rules);
  if (!applied.ok)
    return {
      ok: false,
      problems: applied.problems.map(
        (problem) => `${problem.code}${problem.file === null ? "" : ` ${problem.file}`}: ${problem.detail}`,
      ),
    };
  const renamed = new Map<string, string>();
  const files = new Map<string, AliasedFile>();
  masked.forEach((file, index) => {
    const out = applied.files[index];
    if (out === undefined) return;
    renamed.set(file.path, out.path);
    if (index < input.files.length) files.set(file.path, { path: out.path, text: unmaskKept(out.text, input.kept) });
  });
  const leaks = vocabularyLeaks(
    [...files.values()].map((file) => ({ path: file.path, text: maskKept(file.text, input.kept) })),
    input.vocabulary,
  );
  return {
    ok: true,
    table: {
      rules,
      kept: [...input.kept],
      vocabulary: [...input.vocabulary],
      words: [...chosen].map(([term, placeholder]) => ({ term, placeholder })).sort((a, b) => (a.term < b.term ? -1 : 1)),
    },
    files,
    pathOf: (path) => renamed.get(path) ?? renameFile({ path, text: "" }, rules).path,
    leaks,
  };
}

/** A path or text in the repository's names, put in the folder's. */
export function toFolder(table: FolderPseudonyms, path: string, text: string): AliasedFile {
  const out = renameFile({ path, text: maskKept(text, table.kept) }, table.rules);
  return { path: out.path, text: unmaskKept(out.text, table.kept) };
}

/** `text` with each placeholder still in it put back as its term, spelled as the placeholder was. */
function restoreWords(text: string, words: FolderPseudonyms["words"]): string {
  let out = text;
  for (const { term, placeholder } of words ?? []) {
    for (const match of [...termMatches(out, placeholder)].reverse()) {
      const surface = out.slice(match.start, match.end);
      out = `${out.slice(0, match.start)}${restyle(term.split("-"), surface)}${out.slice(match.end)}`;
    }
  }
  return out;
}

/**
 * A path or text in the folder's names, put back in the repository's: the
 * table undone, then any placeholder still there (a name the folder's
 * holder made) put back as its term.
 */
export function fromFolder(table: FolderPseudonyms, path: string, text: string): AliasedFile {
  const out = renameFile({ path, text: maskKept(text, table.kept) }, invertAliasRules(table.rules));
  return {
    path: restoreWords(out.path, table.words),
    text: unmaskKept(restoreWords(out.text, table.words), table.kept),
  };
}

/** Record fields that hold hashes or ids: never renamed, whatever they spell. */
const OPAQUE_KEYS: ReadonlySet<string> = new Set(["sha256", "blobId", "cutId", "graphSha256", "boundaryContractSha256"]);

/**
 * A record's string leaves in the folder's names, its hashes and ids left
 * as they are (a term made of hex letters could match inside one): the
 * folder's own `carveout.json`, which its own commands read.
 */
export function recordToFolder<T>(table: FolderPseudonyms, value: T): T {
  const walk = (node: unknown, key: string | null): unknown => {
    if (typeof node === "string")
      return key !== null && OPAQUE_KEYS.has(key) ? node : toFolder(table, "carveout.json", node).text;
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node !== null && typeof node === "object")
      return Object.fromEntries(Object.entries(node).map(([name, item]) => [name, walk(item, name)]));
    return node;
  };
  return walk(value, null) as T;
}
