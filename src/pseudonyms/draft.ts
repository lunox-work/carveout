/**
 * Pseudonyms drafted by rule: the name table a sliced version needs to keep
 * the workspace's vocabulary out of its public files, written without a
 * model wherever the vocabulary is where rules can find it.
 *
 * An import of one of the workspace's own packages (`@acme/db`) resolves to
 * a module the slice copies or stubs, so it becomes the relative path the
 * generator would give it, scoped to the files that import it: a renamed
 * package would no longer resolve. Every other occurrence of a vocabulary
 * term becomes a placeholder of the same case, one placeholder per term
 * that no input already uses: a path segment by a path rule, an identifier
 * that contains it renamed whole (`acmeOrders` becomes `globexOrders`), and
 * anything else as text, held in place by the characters around it. One
 * identifier rule covers each spelling up to case; a second spelling that
 * differs from it only by case (`LUNOX` beside `Lunox`) is text too, and
 * several casings may each get a text rule of their own, since a text rule
 * matches and inverts its exact characters.
 *
 * The draft is a candidate, not a guarantee: the caller checks it as the
 * build applies it, and one that does not hold is where the pseudonyms agent
 * starts. Only the vocabulary is covered; a name that says whose code it is
 * without being in it (a customer, a product's feature) is the agent's to
 * find.
 */

import type { AliasRule, AliasedFile } from "./aliases.js";
import { renameFile } from "./aliases.js";
import { relativeSpecifier } from "../project/project.js";
import { termMatches } from "./vocabulary.js";
import type { TermMatch } from "./vocabulary.js";

/** An import the slice resolved: from a file, as written, to a module. */
export interface PseudonymImport {
  readonly from: string;
  readonly specifier: string;
  readonly to: string;
}

/**
 * Placeholders, in the order tried: a term takes the first that no input
 * contains, in any case.
 */
export const PSEUDONYM_PLACEHOLDERS: readonly string[] = [
  // Made-up words first: a word the code or a contributor uses for what it
  // is (the ACME protocol, `acme-client`, an "Acme Corp" in test data) must
  // never be read back as a hidden name.
  "zorvex",
  "velmira",
  "quarnell",
  "brixdor",
  "tovlane",
  "munquist",
  "kelbrook",
  "drovane",
  "acme",
  "globex",
  "initech",
  "hooli",
  "vandelay",
  "contoso",
  "fabrikam",
  "northwind",
  "tailspin",
  "wingtip",
  "cyberdyne",
  "tyrell",
];

/**
 * Every placeholder in the order tried: the fictional companies first, then
 * made-up words any source is unlikely to hold, so a corpus that holds the
 * companies' names (a pseudonym tool of its own) still gets one per term.
 */
function* placeholderCandidates(): Generator<string> {
  yield* PSEUDONYM_PLACEHOLDERS;
  const onsets = ["zor", "vel", "quar", "brix", "tov", "mun", "kel", "dro", "fen", "sav"];
  const codas = ["vex", "lane", "dor", "mira", "tune", "quist", "brook", "nell"];
  for (const onset of onsets) for (const coda of codas) yield `${onset}${coda}`;
}

/** The generator's words as a list, for `find`. */
const placeholderList = [...placeholderCandidates()];

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
const IDENTIFIER_START = /^[A-Za-z_$]/;
const IDENTIFIER_RUN = /^[A-Za-z0-9_$]+$/;
const isIdentifierChar = (char: string | undefined) =>
  char !== undefined && IDENTIFIER_CHAR.test(char);

/** `word` in the case `surface` is written in: `ACME`, `Acme` or `acme`. */
function styled(word: string, surface: string): string {
  if (!/\p{Ll}/u.test(surface)) return word.toUpperCase();
  if (/^\P{L}*\p{Lu}/u.test(surface))
    return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  return word;
}

/**
 * The words a multi-word term's placeholder adds after its own: a term of
 * two words (`sandbox-factory`) becomes two (`contoso-labs`), so every
 * spelling of it (`sandboxFactory`, `SANDBOX_FACTORY`, `sandbox factory`)
 * has a spelling of its own, and maps back.
 */
const PLACEHOLDER_TAILS: readonly string[] = ["labs", "group", "works", "systems", "partners", "ventures"];

/** A term's placeholder as words: its base, and a tail word for each word more the term has. */
export function placeholderWords(term: string, base: string): string[] {
  const count = term.split("-").filter(Boolean).length;
  return [base, ...PLACEHOLDER_TAILS.slice(0, Math.max(0, count - 1))];
}

/**
 * `words` spelled as `surface` spells its own: each word in the case of the
 * surface's word in its place, joined as they are (`contosoLabs` for
 * `sandboxFactory`, `CONTOSO_LABS` for `SANDBOX_FACTORY`, `contoso-labs`
 * for `sandbox-factory`). A surface whose words run together with no mark
 * between them (`sandboxfactory`) gets the words run together too.
 */
export function restyle(words: readonly string[], surface: string): string {
  if (words.length <= 1) return styled(words[0] ?? "", surface);
  const segments: string[] = [];
  const joins: string[] = [];
  surface.split(/([\s_\-./]+)/).forEach((part, index) => {
    if (index % 2 === 1) {
      joins.push(part);
      return;
    }
    const pieces = part
      .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1\u0000$2")
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1\u0000$2")
      .split("\u0000")
      .filter(Boolean);
    pieces.forEach((piece, at) => {
      if (at > 0) joins.push("");
      segments.push(piece);
    });
  });
  if (segments.length === words.length)
    return words.map((word, index) => `${index === 0 ? "" : (joins[index - 1] ?? "")}${styled(word, segments[index] ?? surface)}`).join("");
  const upper = !/\p{Ll}/u.test(surface);
  return words.map((word, index) => (index === 0 ? styled(word, surface) : upper ? word.toUpperCase() : word)).join("");
}

/** A pseudo-file's leaves (`base#pointer`) have no path to rename. */
const isRealPath = (path: string) => !path.includes("#");

export function draftPseudonyms(input: {
  /** Everything the table is applied to, as `applyAliases` is given it. */
  readonly files: readonly AliasedFile[];
  readonly vocabulary: readonly string[];
  /** The slice's resolved imports, inside it and across its cuts. */
  readonly imports: readonly PseudonymImport[];
  /**
   * Filled with the placeholder each term was given: how a name the
   * folder's holder writes in the placeholder's spelling maps back.
   */
  readonly placeholders?: Map<string, string>;
}): AliasRule[] {
  // Longer terms first, so `lunox-work` is renamed whole before `lunox`.
  const terms = [...input.vocabulary].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  if (terms.length === 0) return [];
  const matchesIn = (text: string): (TermMatch & { term: string })[] => {
    const found: (TermMatch & { term: string })[] = [];
    for (const term of terms)
      for (const match of termMatches(text, term))
        if (
          !found.some(
            (other) => match.start < other.end && other.start < match.end,
          )
        )
          found.push({ ...match, term });
    return found.sort((a, b) => a.start - b.start);
  };
  // One placeholder per term, found in no input.
  const corpus = input.files
    .map((file) => `${file.path}\n${file.text}`)
    .join("\n")
    .toLowerCase();
  const placeholders = new Map<string, string>();
  const placeholderOf = (term: string): string | null => {
    const chosen = placeholders.get(term);
    if (chosen !== undefined) return chosen;
    const taken = new Set(placeholders.values());
    const word = placeholderList.find(
      (candidate) =>
        !taken.has(candidate) &&
        !corpus.includes(candidate) &&
        matchesIn(candidate).length === 0,
    );
    if (word !== undefined) placeholders.set(term, word);
    return word ?? null;
  };
  /** `text` with each term in it replaced, or null when one has no placeholder. */
  const replaced = (text: string): string | null => {
    let out = "";
    let at = 0;
    for (const match of matchesIn(text)) {
      const word = placeholderOf(match.term);
      if (word === null) return null;
      out += text.slice(at, match.start);
      out += restyle(placeholderWords(match.term, word), text.slice(match.start, match.end));
      at = match.end;
    }
    return out + text.slice(at);
  };

  // Paths: each segment that carries a term, renamed from the root down.
  const pathRules: AliasRule[] = [];
  for (const file of input.files) {
    if (!isRealPath(file.path)) continue;
    const segments = renameFile(
      { path: file.path, text: "" },
      pathRules,
    ).path.split("/");
    for (const [index, segment] of segments.entries()) {
      const after = replaced(segment);
      if (after === null || after === segment) continue;
      const before = segments.slice(0, index + 1).join("/");
      segments[index] = after;
      if (!pathRules.some((rule) => rule.before === before))
        pathRules.push({
          before,
          after: segments.slice(0, index + 1).join("/"),
          kind: "path",
          paths: [],
        });
    }
  }
  const aliasedPath = (path: string) =>
    renameFile({ path, text: "" }, pathRules).path;

  // Imports of the workspace's packages, as the relative path to the module:
  // one rule per literal and path, scoped to the files that import it so.
  const importers = new Map<
    string,
    { before: string; after: string; paths: Set<string> }
  >();
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  for (const edge of input.imports) {
    if (edge.specifier.startsWith(".") || edge.specifier.startsWith("/"))
      continue;
    if (matchesIn(edge.specifier).length === 0) continue;
    const text = byPath.get(edge.from)?.text;
    if (text === undefined) continue;
    const to = relativeSpecifier(aliasedPath(edge.from), aliasedPath(edge.to));
    for (const quote of ['"', "'"]) {
      const before = `${quote}${edge.specifier}${quote}`;
      if (!text.includes(before)) continue;
      const after = `${quote}${to}${quote}`;
      const key = `${before}\n${after}`;
      const entry = importers.get(key) ?? { before, after, paths: new Set() };
      entry.paths.add(edge.from);
      importers.set(key, entry);
    }
  }
  const importRules: AliasRule[] = [...importers.values()].map((entry) => ({
    before: entry.before,
    after: entry.after,
    kind: "text",
    paths: [...entry.paths].sort(),
  }));

  // What is left: each occurrence, as the identifier it is in or as text.
  const settled = [...importRules, ...pathRules];
  const identifiers = new Map<string, AliasRule>();
  const texts = new Map<string, AliasRule>();
  const foldedIdentifiers = new Set<string>();
  for (const file of input.files) {
    const { text } = renameFile(file, settled);
    for (const match of matchesIn(text)) {
      const surface = text.slice(match.start, match.end);
      let start = match.start;
      let end = match.end;
      if (IDENTIFIER_RUN.test(surface)) {
        while (isIdentifierChar(text[start - 1])) start -= 1;
        while (isIdentifierChar(text[end])) end += 1;
        const token = text.slice(start, end);
        const after = replaced(token);
        if (after === null || after === token) continue;
        if (identifiers.has(token)) continue;
        if (
          IDENTIFIER_START.test(token) &&
          !foldedIdentifiers.has(token.toLowerCase())
        ) {
          foldedIdentifiers.add(token.toLowerCase());
          identifiers.set(token, {
            before: token,
            after,
            kind: "identifier",
            paths: [],
          });
          continue;
        }
      }
      // Text, held in place by the characters around it, so it renames
      // neither another spelling nor the inside of an identifier.
      const from = Math.max(0, start - 1);
      const to = Math.min(text.length, end + 1);
      const before = `${isIdentifierChar(text[from]) ? "" : text.slice(from, start)}${text.slice(start, end)}${isIdentifierChar(text[end]) ? "" : text.slice(end, to)}`;
      const after = replaced(before);
      if (after === null || after === before || texts.has(before)) continue;
      texts.set(before, { before, after, kind: "text", paths: [] });
    }
  }
  for (const [term, word] of placeholders) input.placeholders?.set(term, placeholderWords(term, word).join("-"));
  return [...settled, ...identifiers.values(), ...texts.values()];
}
