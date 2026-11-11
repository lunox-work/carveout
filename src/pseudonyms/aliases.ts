/**
 * Alias rules: the private, bidirectional name table a sandbox version
 * applies to copied source before it can leave the organization.
 *
 * A rule is an explicit pair with a kind and a scope. Rules are ordered,
 * and applied in that order; they are validated as a set before any text
 * is touched, because two rules that look harmless alone can interact (one
 * rule's output is another's input, two rules share a target, two
 * identifier or path names differ only by case). Application is
 * deterministic and textual, bounded to identifier or path tokens so a name
 * inside a longer identifier is never touched, and it is checked to be
 * reversible: applying the inverse table to the output must give the input
 * back byte for byte. A text rule matches its exact, case-sensitive
 * characters and is inverted the same way, so two text rules that differ
 * only by case are distinct and both hold. A
 * transformation that cannot be mapped back is refused, never silently
 * dropped. Redaction of implementation is not a rename and has no place
 * here.
 */

export const ALIAS_KINDS = ["identifier", "path", "text"] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

export interface AliasRule {
  readonly before: string;
  readonly after: string;
  readonly kind: AliasKind;
  /**
   * Repository paths the rule applies to: a file, or a directory prefix.
   * Empty means every file. Scoped rules let one name mean different
   * things in different modules without a symbol table.
   */
  readonly paths: readonly string[];
}

export const ALIAS_PROBLEM_CODES = [
  "empty",
  "identity",
  "invalid_identifier",
  "invalid_path",
  "duplicate_source",
  "duplicate_target",
  "chained",
  "casing_variant",
  "target_collision",
  "irreversible",
  "too_many",
  "unsupported_kind",
] as const;
export type AliasProblemCode = (typeof ALIAS_PROBLEM_CODES)[number];

export interface AliasProblem {
  readonly code: AliasProblemCode;
  /** Index into the rule list; null for a problem of the whole set. */
  readonly rule: number | null;
  readonly file: string | null;
  readonly detail: string;
}

export const ALIAS_RULES_MAX = 500;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PATH = /^[A-Za-z0-9_.\-/@]+$/;

export interface AliasValidation {
  readonly ok: boolean;
  readonly problems: readonly AliasProblem[];
}

/** Whether the set is well formed and free of interactions. */
export function validateAliasRules(
  rules: readonly AliasRule[],
): AliasValidation {
  const problems: AliasProblem[] = [];
  if (rules.length > ALIAS_RULES_MAX)
    problems.push({
      code: "too_many",
      rule: null,
      file: null,
      detail: `${rules.length} rules exceed the limit of ${ALIAS_RULES_MAX}.`,
    });
  const sources = new Map<string, number>();
  const targets = new Map<string, number>();
  const folded = new Map<string, number>();
  rules.forEach((rule, index) => {
    if (!ALIAS_KINDS.includes(rule.kind)) {
      problems.push({
        code: "unsupported_kind",
        rule: index,
        file: null,
        detail: `Kind ${String(rule.kind)} is not supported.`,
      });
      return;
    }
    if (rule.before === "" || rule.after === "") {
      problems.push({
        code: "empty",
        rule: index,
        file: null,
        detail: "Both sides of a rule must be non-empty.",
      });
      return;
    }
    if (rule.before === rule.after)
      problems.push({
        code: "identity",
        rule: index,
        file: null,
        detail: `${rule.before} maps to itself.`,
      });
    if (
      rule.kind === "identifier" &&
      (!IDENTIFIER.test(rule.before) || !IDENTIFIER.test(rule.after))
    )
      problems.push({
        code: "invalid_identifier",
        rule: index,
        file: null,
        detail: `${rule.before} → ${rule.after} is not an identifier pair.`,
      });
    if (
      rule.kind === "path" &&
      (!PATH.test(rule.before) ||
        !PATH.test(rule.after) ||
        rule.before.startsWith("/") ||
        rule.after.startsWith("/") ||
        rule.before.split("/").includes("..") ||
        rule.after.split("/").includes(".."))
    )
      problems.push({
        code: "invalid_path",
        rule: index,
        file: null,
        detail: `${rule.before} → ${rule.after} is not a repository path pair.`,
      });
    const scope =
      rule.paths.length === 0 ? "" : [...rule.paths].sort().join("\n");
    const sourceKey = `${rule.kind}\n${scope}\n${rule.before}`;
    const targetKey = `${rule.kind}\n${scope}\n${rule.after}`;
    const earlier = sources.get(sourceKey);
    if (earlier !== undefined)
      problems.push({
        code: "duplicate_source",
        rule: index,
        file: null,
        detail: `${rule.before} is already renamed by rule ${earlier}.`,
      });
    else sources.set(sourceKey, index);
    const shared = targets.get(targetKey);
    if (shared !== undefined)
      problems.push({
        code: "duplicate_target",
        rule: index,
        file: null,
        detail: `${rule.after} is already the target of rule ${shared}.`,
      });
    else targets.set(targetKey, index);
    // Identifier and path names that differ only by case are refused. Text
    // is exempt: a text rule is applied with an exact, case-sensitive
    // pattern and inverted exactly, so ` lunox ` → ` acme ` beside
    // ` LUNOX ` → ` ACME ` is unambiguous both ways, and it is how a
    // spelling no identifier rule can reach is covered.
    if (rule.kind === "text") return;
    for (const [name, side] of [
      [rule.before, "source"],
      [rule.after, "target"],
    ] as const) {
      const key = `${rule.kind}\n${name.toLowerCase()}`;
      const seen = folded.get(key);
      if (seen !== undefined && seen !== index) {
        const other = rules[seen];
        if (
          other !== undefined &&
          other.before !== name &&
          other.after !== name
        )
          problems.push({
            code: "casing_variant",
            rule: index,
            file: null,
            detail: `${name} (${side}) differs only by case from a name in rule ${seen}.`,
          });
      } else folded.set(key, index);
    }
  });
  // A target that is another rule's source would be renamed again by a
  // later rule, or would make the inverse table ambiguous.
  rules.forEach((rule, index) => {
    rules.forEach((other, otherIndex) => {
      if (
        index !== otherIndex &&
        rule.kind === other.kind &&
        rule.after === other.before &&
        scopesOverlap(rule.paths, other.paths)
      )
        problems.push({
          code: "chained",
          rule: index,
          file: null,
          detail: `${rule.after} is produced by rule ${index} and consumed by rule ${otherIndex}.`,
        });
    });
  });
  return { ok: problems.length === 0, problems: dedupe(problems) };
}

function dedupe(problems: readonly AliasProblem[]): AliasProblem[] {
  const seen = new Set<string>();
  const result: AliasProblem[] = [];
  for (const problem of problems) {
    const key = `${problem.code}\n${problem.rule ?? ""}\n${problem.file ?? ""}\n${problem.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(problem);
  }
  return result;
}

function inScope(path: string, scopes: readonly string[]): boolean {
  if (scopes.length === 0) return true;
  return scopes.some(
    (scope) =>
      path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`),
  );
}

function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((x) => b.some((y) => inScope(x, [y]) || inScope(y, [x])));
}

export interface AliasedFile {
  readonly path: string;
  readonly text: string;
}

export interface AliasApplication {
  readonly ok: boolean;
  readonly files: readonly AliasedFile[];
  /** Original path to aliased path, for every file whose path changed. */
  readonly renames: readonly { readonly from: string; readonly to: string }[];
  readonly problems: readonly AliasProblem[];
  /** Rule index to the number of replacements it made, for the record. */
  readonly applied: readonly number[];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const identifierPattern = (name: string) =>
  new RegExp(`(?<![A-Za-z0-9_$])${escape(name)}(?![A-Za-z0-9_$])`, "g");
const pathPattern = (name: string) =>
  new RegExp(`(?<![A-Za-z0-9_.\\-/@])${escape(name)}(?![A-Za-z0-9_\\-@])`, "g");
const textPattern = (name: string) => new RegExp(escape(name), "g");
const patternFor = (rule: AliasRule, name: string) =>
  rule.kind === "identifier"
    ? identifierPattern(name)
    : rule.kind === "path"
      ? pathPattern(name)
      : textPattern(name);

/**
 * A path renamed by the table, renamed back: the path rules undone in
 * reverse order, each scoped by the original path as the forward pass was.
 */
function invertPath(
  path: string,
  original: string,
  reversed: readonly AliasRule[],
): string {
  let back = path;
  for (const rule of reversed)
    if (rule.kind === "path" && inScope(original, rule.paths))
      back = back.replace(patternFor(rule, rule.after), rule.before);
  return back;
}

function rewrite(
  files: readonly AliasedFile[],
  rules: readonly AliasRule[],
  direction: "forward" | "inverse",
  counts: number[] | null,
  problems: AliasProblem[] | null,
): { files: AliasedFile[]; renames: { from: string; to: string }[] } {
  const renames: { from: string; to: string }[] = [];
  const result = files.map((file) => {
    let text = file.text;
    let path = file.path;
    rules.forEach((rule, index) => {
      if (!inScope(file.path, rule.paths)) return;
      const from = direction === "forward" ? rule.before : rule.after;
      const to = direction === "forward" ? rule.after : rule.before;
      if (problems !== null) {
        // The target must not already occur in the file as it was, or the
        // inverse table could not tell a renamed occurrence from a natural
        // one. An occurrence an earlier rule made is not natural: two rules
        // that give one term the same placeholder (a path and an
        // identifier) make it on purpose, and the round trip below proves
        // the table maps back.
        const existing = file.text.match(patternFor(rule, to));
        if (existing !== null && existing.length > 0)
          problems.push({
            code: "target_collision",
            rule: index,
            file: file.path,
            detail: `${to} already occurs ${existing.length} time(s) in ${file.path}.`,
          });
      }
      const pattern = patternFor(rule, from);
      let made = 0;
      text = text.replace(pattern, () => {
        made += 1;
        return to;
      });
      if (counts !== null) counts[index] = (counts[index] ?? 0) + made;
      if (rule.kind === "path") {
        const renamed = path.replace(patternFor(rule, from), to);
        if (renamed !== path) {
          path = renamed;
          if (counts !== null) counts[index] = (counts[index] ?? 0) + 1;
        }
      }
    });
    if (path !== file.path) renames.push({ from: file.path, to: path });
    return { path, text };
  });
  return { files: result, renames };
}

/**
 * Applies the rules to the files and proves the result maps back. Problems
 * refuse the whole application: a partially aliased candidate is worse
 * than none, because it looks finished.
 */
export function applyAliases(
  files: readonly AliasedFile[],
  rules: readonly AliasRule[],
): AliasApplication {
  const validation = validateAliasRules(rules);
  if (!validation.ok)
    return {
      ok: false,
      files: [],
      renames: [],
      problems: validation.problems,
      applied: [],
    };
  const problems: AliasProblem[] = [];
  const counts: number[] = rules.map(() => 0);
  const forward = rewrite(files, rules, "forward", counts, problems);
  // The inverse walks the rules backwards, undoing the last rename first.
  const reversed = [...rules].reverse();
  const inverse = rewrite(
    forward.files.map((file, index) => ({
      // Scope checks use the original path: the inverse must see what the
      // forward pass saw.
      path: files[index]?.path ?? file.path,
      text: file.text,
    })),
    reversed,
    "inverse",
    null,
    null,
  );
  files.forEach((file, index) => {
    const back = inverse.files[index];
    if (back === undefined || back.text !== file.text)
      problems.push({
        code: "irreversible",
        rule: null,
        file: file.path,
        detail: `Applying the inverse table to ${file.path} does not give the original back.`,
      });
    // Paths too: with `src → lib` beside a `lib/` the repository already
    // has, `lib/x.ts` would map back to `src/x.ts`, and the table alone
    // could not say where a public file came from.
    const aliased = forward.files[index]?.path ?? file.path;
    if (invertPath(aliased, file.path, reversed) !== file.path)
      problems.push({
        code: "irreversible",
        rule: null,
        file: file.path,
        detail: `${aliased} does not map back to ${file.path}.`,
      });
  });
  const renamedPaths = new Set(forward.files.map((file) => file.path));
  if (renamedPaths.size !== files.length)
    problems.push({
      code: "target_collision",
      rule: null,
      file: null,
      detail: "Two files would share one aliased path.",
    });
  const unique = dedupe(problems);
  return unique.length > 0
    ? { ok: false, files: [], renames: [], problems: unique, applied: counts }
    : {
        ok: true,
        files: forward.files,
        renames: forward.renames,
        problems: [],
        applied: counts,
      };
}

/**
 * A JSON value's string leaves, each as a file of its own, for aliasing a
 * structure without touching its shape.
 *
 * Aliasing a serialized object as one text renames its keys too: a quote is
 * a word boundary, so a rule `name → label` turned `"name":` into
 * `"label":` and the object lost the field. Leaves alone keep every key,
 * number and boolean as they were. Each is named `base#pointer`, and
 * `withJsonLeaves` puts them back in the same order.
 */
export function jsonLeaves(base: string, value: unknown): AliasedFile[] {
  const leaves: AliasedFile[] = [];
  const walk = (node: unknown, pointer: string) => {
    if (typeof node === "string") {
      leaves.push({ path: `${base}#${pointer}`, text: node });
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${pointer}/${index}`));
    } else if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node))
        walk(
          item,
          `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        );
    }
  };
  walk(value, "");
  return leaves;
}

/**
 * `value` with its string leaves replaced by `texts`, in `jsonLeaves`'s
 * order; a leaf with no text left keeps its own. A fresh value: the one
 * given is not changed.
 */
export function withJsonLeaves<T>(value: T, texts: readonly string[]): T {
  let at = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return texts[at++] ?? node;
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object")
      return Object.fromEntries(
        Object.entries(node).map(([key, item]) => [key, walk(item)]),
      );
    return node;
  };
  return walk(value) as T;
}

/**
 * The name a build gives its alias table among the private files it writes:
 * `private/pseudonym.lunox`, beside the hidden tests.
 */
export const PSEUDONYMS_FILE = "pseudonym.lunox";
export const PSEUDONYMS_SCHEMA_VERSION = 1;

/** `pseudonym.lunox`: the table a version's public files were renamed by. */
export interface PseudonymTable {
  readonly schemaVersion: typeof PSEUDONYMS_SCHEMA_VERSION;
  readonly rules: readonly AliasRule[];
}

/**
 * One file renamed by the rules, without the checks `applyAliases` makes:
 * for reading back a file already proved to map back, such as a public
 * file in its private names under the inverse table. `file.path` is its
 * repository path, which scoped rules are matched against.
 */
export function renameFile(
  file: AliasedFile,
  rules: readonly AliasRule[],
): AliasedFile {
  return rewrite([file], rules, "forward", null, null).files[0] ?? file;
}

/** The inverse table, as a contribution's import applies it. */
export function invertAliasRules(rules: readonly AliasRule[]): AliasRule[] {
  return [...rules]
    .reverse()
    .map((rule) => ({ ...rule, before: rule.after, after: rule.before }));
}
