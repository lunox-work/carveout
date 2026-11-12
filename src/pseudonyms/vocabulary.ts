/**
 * Workspace vocabulary: the names that say whose code a sandbox was cut
 * from (the organization, its repository, its package scope, its author)
 * and the check that none of them reaches a public file.
 *
 * Pseudonyms are what hide those names, but a table can be empty or miss
 * one, and a sliced version is the workspace's own code. So a build scans
 * what contributors would read, paths and text, for every name the
 * workspace goes by, and a name still there blocks the build until the
 * table renames it.
 *
 * A name is matched by its words, whatever joins them: `sandbox-factory`
 * is found as `sandboxFactory`, `SANDBOX_FACTORY` and `sandbox factory`.
 * A match must start and end on a word boundary, where a case change in an
 * identifier counts as one: `acme` is found in `acmeOrders`, `MyAcme` and
 * `ACMEOrders`, not in `acmes`. A name too short or too generic to say
 * whose code it is (`api`, `web`, `monorepo`) is not scanned for.
 *
 * An organization's names are scanned word by word as well: `Acme Corp`
 * writes its packages `@acme/ledger` and its code `acmeOrders`, never
 * `acme-corp`. Only its distinctive words, though: one of at least
 * `VOCABULARY_TERM_MIN` letters that is not a legal form or trade
 * (`ORGANIZATION_WORDS`) nor an everyday word (`COMMON_WORDS`), whatever its
 * length. `First Choice Logistics` is scanned whole, never as `first`, or
 * every `firstName` would block; `acme` and `payflow` are scanned alone.
 * Other names (a repository's, a package's) are matched only whole, since
 * `billing-service` names one product but `billing` is everyone's word. A
 * name or word without a letter (`12345`) names nothing and is dropped.
 *
 * A package the slice imports from the workspace itself or from a private
 * registry is mocked under its own name unless the table renames it, so its
 * scope is scanned as an organization's name (`@acme/ledger` gives `acme`)
 * and an unscoped one by its whole name (`payflow-sdk`). A package's own
 * one word (`ledger`, `logger`) is the code's vocabulary, not whose code it
 * is, and a public package mocked by default (`lodash`) names no one.
 */

import type { RequiredBuildInputs } from "../slice/manifest.js";
import type { ProjectBlocker } from "../project/project.js";

/** Shorter names, separators aside, match too much to block on. */
export const VOCABULARY_TERM_MIN = 4;
/** Files a leak's detail names before it counts the rest. */
const LEAK_FILES_SHOWN = 5;
const LETTER = /\p{L}/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const DIGIT = /\p{N}/u;
const is = (pattern: RegExp, char: string | undefined) =>
  char !== undefined && pattern.test(char);
/** Words any workspace might name itself with, which say nothing about whose. */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "admin",
  "android",
  "api",
  "app",
  "apps",
  "backend",
  "client",
  "code",
  "common",
  "company",
  "core",
  "corp",
  "dashboard",
  "demo",
  "docs",
  "example",
  "frontend",
  "internal",
  "ios",
  "lib",
  "libs",
  "local",
  "main",
  "mobile",
  "mono",
  "monorepo",
  "packages",
  "personal",
  "platform",
  "private",
  "project",
  "repo",
  "root",
  "server",
  "service",
  "services",
  "shared",
  "site",
  "src",
  "team",
  "test",
  "tests",
  "utils",
  "web",
  "website",
  "workspace",
  "www",
]);

/**
 * Words an organization's name is made of that say nothing about which
 * organization: its legal form, its trade and the words code uses anyway.
 * Matched whole, they are part of its name; alone, they are not scanned for.
 */
const ORGANIZATION_WORDS: ReadonlySet<string> = new Set([
  "academy",
  "agency",
  "airlines",
  "analytics",
  "bank",
  "bhd",
  "capital",
  "cloud",
  "co",
  "communications",
  "construction",
  "consulting",
  "corporation",
  "data",
  "design",
  "digital",
  "education",
  "email",
  "energy",
  "engineering",
  "enterprise",
  "enterprises",
  "finance",
  "financial",
  "foods",
  "foundation",
  "games",
  "global",
  "gmbh",
  "group",
  "health",
  "holding",
  "holdings",
  "inc",
  "incorporated",
  "industries",
  "info",
  "insurance",
  "interactive",
  "international",
  "labs",
  "limited",
  "llc",
  "llp",
  "logistics",
  "ltd",
  "mail",
  "manufacturing",
  "marketing",
  "media",
  "medical",
  "motors",
  "network",
  "networks",
  "official",
  "online",
  "open",
  "partners",
  "payments",
  "pharma",
  "plc",
  "properties",
  "pt",
  "pte",
  "pty",
  "realty",
  "retail",
  "sdn",
  "shop",
  "software",
  "solutions",
  "source",
  "store",
  "studio",
  "studios",
  "supply",
  "systems",
  "tbk",
  "tech",
  "technologies",
  "technology",
  "telecom",
  "trading",
  "transport",
  "ventures",
  "work",
  "works",
]);
/**
 * Everyday English words an organization's name is often made of (`First
 * Choice`, `Blue Harbor`, `Bright Path`) that code also uses for itself
 * (`firstName`, `blueButton`, `pathname`). Matched whole, they are part of
 * its name; alone, they are not scanned for. Brand-like words (`acme`,
 * `payflow`) are deliberately absent.
 */
const COMMON_WORDS: ReadonlySet<string> = new Set(
  (
    "able about above access account action active actual advance after " +
    "again agent alert align alpha amber anchor angle apex apple area " +
    "army arrow asset atlas atom audio auto avenue away back badge " +
    "balance band base basic beach beacon bear beat bell best beta better " +
    "beyond bird black blank blaze block blue board body bold bolt bond " +
    "book boost border boss bound brain branch brand brave bread break " +
    "bridge bright broad brown budget build bull button cache call camp " +
    "canvas card care cargo carbon case cash castle catch cedar cell " +
    "center central chain change channel charge chart chase check chef " +
    "cherry chief choice circle city civic class clean clear click climb " +
    "clock close cloud coast coin color comet command compass connect " +
    "contact content control coral count country county cove craft crane " +
    "create credit crest cross crown crystal cube current custom cycle " +
    "daily dash date dawn deal deep delta desk detail direct domain door " +
    "double dove draft dragon dream drive drop eagle early earth east " +
    "easy echo eden edge elite ember empire entry equal ever event every " +
    "exact expert express fair faith falcon family farm fast field fire " +
    "first fish flag flash fleet flex flight float flow focus force " +
    "forest form forward fountain free fresh front frost fuel full fund " +
    "fusion future galaxy game garden gate gear giant gold golden good " +
    "grand graph great green grid ground grove guard guide happy harbor " +
    "harbour harmony hawk head heart helix help hero high hill home honey " +
    "hope horizon host house human idea image impact index inner input " +
    "insight iron island item jade join journey jump just keep kind king " +
    "kite label land large laser last launch layer leader leaf legacy " +
    "level liberty life light lime line link lion list little live local " +
    "lock logic long loop lotus love lucky lunar magic main major maple " +
    "mark market master match matrix meadow mega member mercury merit " +
    "meta metro middle mind mint mission mode model modern moment monster " +
    "moon motion mountain move name nation national native nature navy " +
    "near nest next noble node north nova number oasis ocean office omega " +
    "orange orbit order origin output pacific page palm panda panel paper " +
    "park path peak pearl people phoenix photo pilot pine pink pixel " +
    "place plan planet plus pocket point polar portal post power premier " +
    "press prime profile progress pulse pure purple quality quantum quest " +
    "quick radar rain rainbow range rapid raven ready real record region " +
    "reliable result ridge right ring rise river road rock rocket rose " +
    "round royal ruby safe sage sail sales salt scale scope search secure " +
    "select sense series shape share shield shift signal silver simple " +
    "single smart snow social solar solid sound south space spark speed " +
    "sphere spirit spring square stack standard star start state status " +
    "steel step stone storm stream street strong summit sunrise super " +
    "swift table talent target task team terra thunder tide tiger time " +
    "title today token total touch tower track trade trail tree trend " +
    "tribe trinity true trust truth turbo twin union unique united unity " +
    "urban user valley value vector venture vertex view village vision " +
    "vista vital voice wave west white wild wind wing winter wise wolf " +
    "wood world year yellow young zero zone"
  ).split(" "),
);
/**
 * Mail providers anyone may have an address at: an author's address there
 * says who they are, not whom they work for.
 */
const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "163.com",
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "tutanota.com",
  "users.noreply.github.com",
  "yahoo.com",
  "yandex.com",
  "yandex.ru",
  "ymail.com",
  "zoho.com",
]);

/**
 * A name the workspace goes by. A bare string is `kind: "name"`: matched
 * only as a whole. An `organization` name (its name, its handle, the
 * account that owns its repositories, its mail domain) is matched whole and
 * by each of its distinctive words.
 */
export interface VocabularyName {
  readonly name: string;
  readonly kind: "organization" | "name";
}

/** Names that say who the organization is, to be scanned word by word too. */
export function organizationNames(names: readonly string[]): VocabularyName[] {
  return names.map((name) => ({ name, kind: "organization" }));
}

/**
 * The names the slice's privately hosted packages give (see the module
 * comment): one of the workspace's own, or one a lockfile or `.npmrc` says
 * comes from another registry. A package nothing says is public is mocked
 * too, but by default, so it is not one.
 */
export function privatePackageNames(
  packages: RequiredBuildInputs["packages"],
): VocabularyName[] {
  const names: VocabularyName[] = [];
  for (const item of packages) {
    if (item.workspace !== true && item.registry?.source !== "private")
      continue;
    const slash = item.name.indexOf("/");
    if (item.name.startsWith("@") && slash > 1)
      names.push({ name: item.name.slice(1, slash), kind: "organization" });
    else if (termWords(item.name).length > 1)
      names.push({ name: item.name, kind: "name" });
  }
  return names;
}

/** Shared and automated mailboxes: they name a function, not a person. */
const ROLE_MAILBOXES: ReadonlySet<string> = new Set([
  "abuse",
  "accounts",
  "admin",
  "billing",
  "bot",
  "careers",
  "ci",
  "contact",
  "dev",
  "developer",
  "developers",
  "devops",
  "engineering",
  "github",
  "hello",
  "help",
  "hi",
  "hostmaster",
  "hr",
  "info",
  "it",
  "jobs",
  "legal",
  "mail",
  "maintainers",
  "marketing",
  "noreply",
  "npm",
  "office",
  "ops",
  "opensource",
  "oss",
  "postmaster",
  "press",
  "privacy",
  "release",
  "releases",
  "root",
  "sales",
  "security",
  "support",
  "team",
  "tech",
  "webmaster",
]);

/**
 * The names a package author's address gives: its local part unless a role
 * mailbox's (`support@`) or without a letter, and its domain as the
 * organization's unless it is a public mail provider's. A GitHub noreply
 * address (`12345+octocat@users.noreply.github.com`) gives the login after
 * the `+`; any other drops its `+tag`.
 */
export function emailNames(email: string): VocabularyName[] {
  const at = email.lastIndexOf("@");
  if (at <= 0) return [];
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  const address = email.slice(0, at).trim();
  const plus = address.indexOf("+");
  const local =
    plus === -1
      ? address
      : domain === "users.noreply.github.com"
        ? address.slice(plus + 1)
        : address.slice(0, plus);
  const names: VocabularyName[] = [];
  if (/\p{L}/u.test(local) && !ROLE_MAILBOXES.has(termWords(local).join("")))
    names.push({ name: local, kind: "name" });
  if (domain !== "" && !PUBLIC_MAIL_DOMAINS.has(domain))
    names.push({ name: domain, kind: "organization" });
  return names;
}

/**
 * A name's words, lowercased: split at anything not a letter or digit, and
 * at each case change an identifier marks (`acmeOrders`, `XMLParser`).
 */
export function termWords(name: string): string[] {
  return name
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * The names worth scanning for, each as its words joined by `-`, in the
 * order first given; an organization's name is followed by each of its
 * distinctive words (see the module comment). Repeats, names under
 * `VOCABULARY_TERM_MIN`, names without a letter and names made only of
 * generic words are dropped.
 */
export function workspaceVocabulary(
  names: readonly (string | VocabularyName)[],
): string[] {
  const terms: string[] = [];
  const add = (term: string) => {
    if (!terms.includes(term)) terms.push(term);
  };
  for (const entry of names) {
    const { name, kind } =
      typeof entry === "string" ? { name: entry, kind: "name" } : entry;
    const words = termWords(name);
    if (words.join("").length < VOCABULARY_TERM_MIN) continue;
    if (!LETTER.test(name)) continue;
    if (words.every((word) => GENERIC_WORDS.has(word))) continue;
    add(words.join("-"));
    if (kind !== "organization") continue;
    for (const word of words)
      if (
        word.length >= VOCABULARY_TERM_MIN &&
        LETTER.test(word) &&
        !GENERIC_WORDS.has(word) &&
        !ORGANIZATION_WORDS.has(word) &&
        !COMMON_WORDS.has(word)
      )
        add(word);
  }
  return terms;
}

/**
 * Names a codebase calls its own things by: the platform's globals and
 * their members (`console`, `performance.mark`, `URLSearchParams`), and the
 * words APIs are made of. A one-word name of the workspace's that is one of
 * these (a repository called `search`, a mail address `mark@…`) would rename
 * the code's own calls, so it is not scanned for alone.
 */
const CODE_WORDS: ReadonlySet<string> = new Set(
  (
    "console document window navigator location history screen performance " +
    "process global globalthis crypto fetch request response headers event " +
    "error date math json string number object array promise symbol proxy " +
    "reflect intl buffer stream worker module require exports import " +
    "search mark measure query params status result value values items " +
    "node react vue next nuxt vite test tests spec mock mocks stub " +
    "user users admin login logout session token auth account settings " +
    "home index main page pages view views layout model models store " +
    "data info list item name title label text type types kind state " +
    "start stop open close read write send post update delete create"
  ).split(" "),
);

/**
 * Whether a one-word name is too common to scan for alone: generic, an
 * organization's trade or form, an everyday word, or a word code is made
 * of. A name of several words is scanned whole whatever its words.
 */
export function tooCommonAlone(name: string): boolean {
  const words = termWords(name);
  if (words.length !== 1) return false;
  const word = words[0] ?? "";
  return GENERIC_WORDS.has(word) || ORGANIZATION_WORDS.has(word) || COMMON_WORDS.has(word) || CODE_WORDS.has(word);
}

/** Affixes a handle wraps a name in: `lunoxhq`, `getlunox`, `lunoxapp`. */
const HANDLE_PREFIXES = ["get", "try", "use", "join", "go", "hello", "meet"];
const HANDLE_SUFFIXES = ["hq", "app", "apps", "inc", "io", "dev", "devs", "labs", "lab", "team", "co", "ai", "hub", "official", "corp", "tech", "studio", "group"];

/**
 * More spellings an organization's or a person's name goes by: the stem of
 * a handle (`lunox` of `lunoxhq`), its words split at a digit (`web3 labs`
 * of `web3labs`), and its letters without accents (`lunox` of `Lunöx`).
 */
export function nameSpellings(entry: VocabularyName): VocabularyName[] {
  const out: VocabularyName[] = [entry];
  const plain = entry.name.normalize("NFD").replace(/\p{M}/gu, "");
  if (plain !== entry.name) out.push({ ...entry, name: plain });
  // Matched whole: its words alone (`web3`) are everyone's.
  const split = plain.replace(/(\d)(\p{L})/gu, "$1 $2");
  if (split !== plain) out.push({ name: split, kind: "name" });
  if (entry.kind === "organization") {
    const word = plain.toLowerCase();
    // A stem of letters alone, and not one everyone's code uses (`web3`).
    const stem = (candidate: string) => {
      if (candidate.length >= 4 && /^\p{L}+$/u.test(candidate) && !tooCommonAlone(candidate))
        out.push({ name: candidate, kind: "organization" });
    };
    for (const prefix of HANDLE_PREFIXES) if (word.startsWith(prefix)) stem(word.slice(prefix.length));
    for (const suffix of HANDLE_SUFFIXES) if (word.endsWith(suffix)) stem(word.slice(0, -suffix.length));
  }
  return out;
}

/**
 * The names a public folder is scanned for, from the names a repository
 * goes by (`found`) and the owner's own (`owner`, always scanned, as an
 * organization's): a found name of one word too common to scan for alone
 * (`tooCommonAlone`) is dropped, and each name is joined by its other
 * spellings (`nameSpellings`). `workspaceVocabulary` turns them into terms.
 */
export function scannedNames(
  found: readonly (string | VocabularyName)[],
  owner: readonly string[] = [],
): VocabularyName[] {
  const named = found.map((entry): VocabularyName => (typeof entry === "string" ? { name: entry, kind: "name" } : entry));
  // A name found, of one word the code calls its own things by, is not
  // scanned for alone; the owner's own names always are.
  return [
    ...owner.map((name) => ({ name, kind: "organization" as const })),
    ...named.filter((entry) => !tooCommonAlone(entry.name)),
  ].flatMap(nameSpellings);
}

/**
 * carveout's vocabulary: the terms a public folder must not hold, as
 * `carveout cut --public` scans for them (`scannedNames`, then
 * `workspaceVocabulary`). `vocabularyLeaks` finds them in files.
 */
export function scanVocabulary(
  found: readonly (string | VocabularyName)[],
  owner: readonly string[] = [],
): string[] {
  return workspaceVocabulary(scannedNames(found, owner));
}

export interface VocabularyLeak {
  readonly term: string;
  readonly occurrences: number;
  /** The files it was found in, path or text, in the order given. */
  readonly files: readonly string[];
}

/** Where a term was found in a text: `text.slice(start, end)`. */
export interface TermMatch {
  readonly start: number;
  readonly end: number;
}

/**
 * Every match of `term` in `text` that starts and ends on a word boundary:
 * not a letter, or a case change an identifier marks (`myAcme`, `acmeOrders`,
 * and in a run of capitals the last one before a lowercase, `XMLAcme`,
 * `ACMEOrders`), or a capital after a digit (`web3Labs`). A term that starts
 * or ends on a digit (`web3`) needs a non-digit there too, so `web3` is not
 * found in `web30`.
 */
export function termMatches(text: string, term: string): TermMatch[] {
  // A term's words join across a space, `_`, `-` or `.`, never a `/`: two
  // folders that hold its words are two names, each renamed on its own.
  const pattern = new RegExp(term.split("-").join("[\\s_\\-.]*"), "giu");
  const matches: TermMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text[start - 1];
    const after = text[end];
    if (is(DIGIT, text[start]) && is(DIGIT, before)) continue;
    if (is(DIGIT, text[end - 1]) && is(DIGIT, after)) continue;
    const opens =
      !is(LETTER, before) ||
      (is(LOWER, before) && is(UPPER, text[start])) ||
      (is(UPPER, before) &&
        is(UPPER, text[start]) &&
        is(LOWER, text[start + 1]));
    const closes =
      !is(LETTER, after) ||
      (is(UPPER, after) &&
        (is(LOWER, text[end - 1]) || is(DIGIT, text[end - 1]))) ||
      (is(UPPER, after) &&
        is(UPPER, text[end - 1]) &&
        is(LOWER, text[end + 1]));
    if (opens && closes) matches.push({ start, end });
  }
  return matches;
}

const countTerm = (text: string, term: string) =>
  termMatches(text, term).length;

/** Each term found in the files' paths or text, in the vocabulary's order. */
export function vocabularyLeaks(
  files: readonly { readonly path: string; readonly text: string }[],
  vocabulary: readonly string[],
): VocabularyLeak[] {
  const leaks: VocabularyLeak[] = [];
  for (const term of vocabulary) {
    let occurrences = 0;
    const found: string[] = [];
    for (const file of files) {
      const count = countTerm(file.path, term) + countTerm(file.text, term);
      if (count === 0) continue;
      occurrences += count;
      found.push(file.path);
    }
    if (occurrences > 0) leaks.push({ term, occurrences, files: found });
  }
  return leaks;
}

/** A blocker for each leak, naming where it was found and what clears it. */
export function vocabularyBlockers(
  leaks: readonly VocabularyLeak[],
): ProjectBlocker[] {
  return leaks.map((leak) => {
    const shown = leak.files.slice(0, LEAK_FILES_SHOWN).join(", ");
    const rest = leak.files.length - LEAK_FILES_SHOWN;
    return {
      code: "vocabulary_leaked",
      file: leak.files[0] ?? null,
      detail: `"${leak.term}" names the workspace and appears ${leak.occurrences} time${leak.occurrences === 1 ? "" : "s"} in ${leak.files.length} public file${leak.files.length === 1 ? "" : "s"}: ${shown}${rest > 0 ? `, and ${rest} more` : ""}. Give it a pseudonym.`,
    };
  });
}
