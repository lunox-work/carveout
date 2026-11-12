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
  scannedNames,
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
      // Whole and by each distinctive word: a company's name, or a person's surname alone.
      if (who !== "") names.push({ name: who, kind: "organization" });
      if (mail !== undefined) names.push(...emailNames(mail));
    } else if (person !== null && typeof person === "object") {
      const record = person as Record<string, unknown>;
      if (typeof record["name"] === "string") names.push({ name: record["name"], kind: "organization" });
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

/** Hosts anyone's code is kept on: their names say nothing of whose it is. */
const PUBLIC_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|visualstudio\.com|npmjs\.(com|org)|codeberg\.org|sr\.ht|sourceforge\.net|googlesource\.com|vercel\.app|netlify\.app|pages\.dev)$/i;

/** The labels of a host that name its owner: `lunox` of `git.lunox.work`. */
function hostNames(host: string): VocabularyName[] {
  const clean = host.toLowerCase().replace(/:\d+$/, "");
  if (clean === "" || PUBLIC_HOSTS.test(clean) || /^\d+(\.\d+){3}$/.test(clean) || clean === "localhost") return [];
  const labels = clean.split(".").filter(Boolean);
  // The label before the public suffix (`co.uk` counts as one).
  const suffix = labels.length >= 3 && /^(co|com|org|net|ac|gov)$/.test(labels[labels.length - 2] ?? "") ? 2 : 1;
  const main = labels[labels.length - 1 - suffix];
  return main === undefined ? [] : [{ name: main, kind: "organization" }];
}

/**
 * The names a repository URL or a remote gives: its account and its
 * repository, in any of the forms Git and npm write (`git@host:acme/shop.git`,
 * `ssh://git@host:7999/acme/shop.git`, `https://host/acme/shop`, Azure's
 * `dev.azure.com/acme/project/_git/shop`, npm's `github:acme/shop` or
 * `acme/shop`), and a private host's own name.
 */
function hostedNames(url: string): VocabularyName[] {
  const value = url.trim();
  const names: VocabularyName[] = [];
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (shorthand !== null && !value.includes("://") && !value.includes("@")) {
    names.push({ name: shorthand[2] ?? "", kind: "organization" }, { name: shorthand[3] ?? "", kind: "name" });
    return names;
  }
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(value);
  let host = "";
  let path = "";
  if (scp !== null && !value.includes("://")) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    try {
      const parsed = new URL(value.replace(/^git\+/, ""));
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return names;
    }
  }
  names.push(...hostNames(host));
  // A page's path (`/support`, `/lunox-work/shop/issues` past the repo) names
  // nothing; a code host's or a remote's names the account and repository.
  const remote = scp !== null || /^(ssh|git)(\+\w+)?:/.test(value) || /\.git\/?$/.test(value);
  const codeHost = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|visualstudio\.com)$/i.test(host);
  if (!remote && !codeHost) return names;
  const raw = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((part) => part !== "");
  // Azure: org/project/_git/repo; Bitbucket Server: scm/project/repo.
  const azure = raw.indexOf("_git");
  const parts = raw.filter((part) => !/^v\d+$/.test(part) && !/^(scm|projects|repos|browse)$/i.test(part));
  const owner = parts[0];
  const repo = azure !== -1 ? raw[azure + 1] : parts[1];
  if (owner !== undefined) names.push({ name: owner, kind: "organization" });
  if (repo !== undefined && repo !== owner) names.push({ name: repo, kind: "name" });
  return names;
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
  const found: VocabularyName[] = [];
  const names = found;
  for (const dir of ["", ...packageDirs]) names.push(...manifestNames(join(repo, dir, "package.json")));
  const origin = gitValue(repo, ["remote", "get-url", "origin"]);
  if (origin !== null) names.push(...hostedNames(origin));
  names.push({ name: basename(repo), kind: "name" });
  // A person is named whole and by each distinctive word: a surname alone
  // in a comment says who wrote it as well.
  const person = gitValue(repo, ["config", "user.name"]);
  if (person !== null) names.push({ name: person, kind: "organization" });
  const mail = gitValue(repo, ["config", "user.email"]);
  if (mail !== null) names.push(...emailNames(mail));
  return scannedNames(found, owner);
}

/**
 * The names written after a name the repository goes by, the way its
 * owner's other repositories are (`lunox-work/sandbox-factory` in a default
 * list, a URL, a comment): each is the owner's too, and goes in the
 * vocabulary. Only a name of two words or more (`sandbox-factory`): one
 * word after a slash is as often a folder or a file (`lunox/README`), and
 * a common word renamed everywhere hides nothing.
 */
export function ownedNames(texts: readonly { readonly text: string }[], vocabulary: readonly string[]): VocabularyName[] {
  const found = new Set<string>();
  const known = new Set(vocabulary);
  for (const term of vocabulary) {
    const spelled = term
      .split("-")
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s_\\-.]?");
    const pattern = new RegExp(`(?<![A-Za-z0-9])${spelled}\\/([a-z0-9]+(?:-[a-z0-9]+)+)(?![A-Za-z0-9._-]*\\.(?!git\\b)[a-z]{1,5}\\b)`, "giu");
    for (const { text } of texts)
      for (const match of text.matchAll(pattern)) {
        const name = (match[1] ?? "").toLowerCase();
        if (name !== "" && !known.has(name)) found.add(name);
      }
  }
  return [...found].sort().map((name) => ({ name, kind: "name" as const }));
}

/** Characters no source holds, around a kept name's index while the table runs. */
const MASK_OPEN = "";
const MASK_CLOSE = "";

/**
 * `text` with each kept name (longest first) behind a mask the table cannot
 * match, where it is written as a package: in quotes, alone or before a
 * subpath (`"@lunox/ui"`, `'@lunox/ui/button'`). Elsewhere it is a word
 * like any other, renamed and scanned.
 */
export function maskKept(text: string, kept: readonly string[]): string {
  if (kept.length === 0) return text;
  let out = text;
  [...kept]
    .map((name, index) => ({ name, index }))
    .sort((a, b) => b.name.length - a.name.length)
    .forEach(({ name, index }) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(["'\`]|node_modules/)${escaped}(?=["'\`/])`, "g"), `$1${MASK_OPEN}${index}${MASK_CLOSE}`);
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
  /** An earlier cut's pseudonyms, whose placeholders are kept where they fit. */
  readonly earlier?: FolderPseudonyms;
  /**
   * The files a patch will read back (the slice's own): each must come
   * back through `fromFolder` byte for byte, as `patch` reads it, or a
   * patch of a folder no one edited would carry a change.
   */
  readonly readBack?: (path: string) => boolean;
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
  const preferred = new Map((input.earlier?.words ?? []).map(({ term, placeholder }) => [term, placeholder.split("-")[0] ?? placeholder]));
  const drafted = draftPseudonyms({ files: settled, vocabulary: input.vocabulary, imports: [], placeholders: chosen, preferred });
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
  const table: FolderPseudonyms = {
    rules,
    kept: [...input.kept],
    vocabulary: [...input.vocabulary],
    words: [...chosen].map(([term, placeholder]) => ({ term, placeholder })).sort((a, b) => (a.term < b.term ? -1 : 1)),
  };
  if (input.readBack !== undefined) {
    // The folder's own mock packages, by their folder names, as patch finds them.
    const own = new Set(
      [...files.values()].flatMap((file) => {
        const match = /^carveout\/packages\/((?:@[^/]+\/)?[^/]+)\//.exec(file.path);
        return match?.[1] === undefined ? [] : [match[1]];
      }),
    );
    // The packages the slice's own files name as specifiers, which the
    // repository knows (patch reads them back the same way).
    const imported = new Set(input.files.flatMap((file) => specifierPackages(file.text)));
    const problems = input.files
      .filter((file) => input.readBack?.(file.path) === true)
      .flatMap((file) => {
        const folder = files.get(file.path);
        if (folder === undefined) return [];
        const back = fromFolder(table, folder.path, folder.text, (name) => own.has(name), (name) => imported.has(name));
        return back.path === file.path && back.text === file.text
          ? []
          : [`round_trip ${file.path}: read back from the folder's names, it would not be the repository's byte for byte`];
      });
    if (problems.length > 0) return { ok: false, problems };
  }
  return {
    ok: true,
    table,
    files,
    pathOf: (path) => renamed.get(path) ?? renameFile({ path, text: "" }, rules).path,
    leaks,
  };
}

/**
 * Each term found in the files by a looser reading than the table's: inside
 * a longer word (`getlunox`, `lunoxes`), whatever joins its words, in any
 * case, its accents stripped, and in binary files' bytes. The table renames
 * a name on its word's edges; a name it could not reach still says whose
 * code it is, and blocks the folder.
 */
export function looseLeaks(
  files: readonly { readonly path: string; readonly text: string }[],
  vocabulary: readonly string[],
  kept: readonly string[] = [],
): VocabularyLeak[] {
  const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");
  const leaks: VocabularyLeak[] = [];
  for (const term of vocabulary) {
    const pattern = new RegExp(term.split("-").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_\\-.]*"), "giu");
    let occurrences = 0;
    const found: string[] = [];
    for (const file of files) {
      const text = plain(maskKept(`${file.path}\n${file.text}`, kept));
      const count = [...text.matchAll(pattern)].length;
      if (count === 0) continue;
      occurrences += count;
      found.push(file.path);
    }
    if (occurrences > 0) leaks.push({ term, occurrences, files: found });
  }
  return leaks;
}

/**
 * Each term the table's rules left in a path or a text, given its
 * placeholder, spelled as the term was (`AcmeDiscount` → `ZorvexDiscount`,
 * `acme-cases-v2.ts` → `zorvex-cases-v2.ts`): what the cut never saw, as
 * `apply` writes it. The rules match what the cut found, file by file; a
 * file the repository added since, or a line it wrote, may spell a term
 * where no rule reaches. `fromFolder` puts each back by the same words. A
 * kept package's name stays as it is, and a term the cut gave no
 * placeholder (it found none) is left for the leak scan to name.
 */
export function wordsToFolder(table: FolderPseudonyms, text: string): string {
  let out = maskKept(text, table.kept);
  for (const { term, placeholder } of table.words ?? [])
    for (const match of [...termMatches(out, term)].reverse()) {
      const surface = out.slice(match.start, match.end);
      out = `${out.slice(0, match.start)}${restyle(placeholder.split("-"), surface)}${out.slice(match.end)}`;
    }
  return unmaskKept(out, table.kept);
}

/** The package names a text spells as module specifiers (`from "x"`, `import("x")`), relative ones aside. */
export function specifierPackages(text: string): string[] {
  return [...text.matchAll(SPECIFIER)].flatMap((match) => {
    const specifier = match[3] ?? "";
    if (specifier.startsWith(".") || specifier.startsWith("/")) return [];
    return [specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier)];
  });
}

/**
 * A path or a text in the folder's names that maps back byte for byte: the
 * table's rules with a placeholder for each term they left
 * (`wordsToFolder`) when `fromFolder` takes that back to what it was, else
 * the rules alone when those do; null when neither does (a mixed-case term
 * `restyle` cannot keep, a package name the restore shields, a placeholder
 * word the repository's own text holds). What `apply` writes, and only
 * that: a text that maps back wrong would have `patch` rewrite the
 * repository's.
 */
export function exactToFolder(
  table: FolderPseudonyms,
  path: string,
  text: string,
  ownPackage: (name: string) => boolean = () => false,
  repositoryPackage: (name: string) => boolean = () => false,
): { readonly path: string; readonly text: string } | null {
  const ruled = toFolder(table, path, text);
  const worded = { path: wordsToFolder(table, ruled.path), text: wordsToFolder(table, ruled.text) };
  const back = (folder: { path: string; text: string }) => fromFolder(table, folder.path, folder.text, ownPackage, repositoryPackage);
  const exact = (folder: { path: string; text: string }) => {
    const restored = back(folder);
    return restored.path === path && restored.text === text;
  };
  if (exact(worded)) return worded;
  if (exact(ruled)) return ruled;
  return null;
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

/** A module specifier as code writes one: after `from`, `import`, `import(` or `require(`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|\bexport\s+\*\s+from\s*)(["'])([^"'\n]+)\2/gm;
const SHIELD_OPEN = "\uE002";
const SHIELD_CLOSE = "\uE003";

/**
 * A path or text in the folder's names, put back in the repository's: the
 * table undone, then any placeholder still there (a name the folder's
 * holder made) put back as its term. A package the contributor imports by
 * its own name (`acme-client`) is shielded from both, unless it is one of
 * the folder's own mock packages (`ownPackage`), whose names are the
 * table's.
 */
export function fromFolder(
  table: FolderPseudonyms,
  path: string,
  text: string,
  ownPackage: (name: string) => boolean = () => false,
  /**
   * A package the repository knows (a workspace package, a dependency it
   * declares): a specifier the table's rules take back to one is the
   * repository's own name the cut renamed (in an import, in a test's
   * data), and goes back with the rest.
   */
  repositoryPackage: (name: string) => boolean = () => false,
): AliasedFile {
  const shielded: string[] = [];
  const inverted = invertAliasRules(table.rules);
  const masked = maskKept(text, table.kept).replace(SPECIFIER, (whole, lead: string, quote: string, specifier: string) => {
    if (specifier.startsWith(".") || specifier.startsWith("/")) return whole;
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier);
    if (ownPackage(name)) return whole;
    // A name the table's rules take back to a package the repository knows
    // is the repository's own, renamed by the cut: it goes back. Any other
    // (a package the holder imports by its own name, `zorvex-client`) is
    // kept from the table and the words alike.
    const quoted = `${quote}${specifier}${quote}`;
    const viaRules = renameFile({ path, text: quoted }, inverted).text;
    const restored = viaRules.startsWith(quote) && viaRules.endsWith(quote) ? viaRules.slice(1, -1) : specifier;
    const restoredName = restored.startsWith("@") ? restored.split("/").slice(0, 2).join("/") : (restored.split("/")[0] ?? restored);
    if (restored !== specifier && repositoryPackage(restoredName)) return whole;
    shielded.push(specifier);
    return `${lead}${quote}${SHIELD_OPEN}${shielded.length - 1}${SHIELD_CLOSE}${quote}`;
  });
  const out = renameFile({ path, text: masked }, inverted);
  const restored = restoreWords(out.text, table.words).replace(
    new RegExp(`${SHIELD_OPEN}(\\d+)${SHIELD_CLOSE}`, "g"),
    (whole, index: string) => shielded[Number(index)] ?? whole,
  );
  return { path: restoreWords(out.path, table.words), text: unmaskKept(restored, table.kept) };
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
