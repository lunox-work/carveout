/**
 * What a folder handed to someone outside may bring back.
 *
 * A folder comes back from a contributor the repository does not trust, so
 * nothing in it is taken on its word: the paths its `carveout.json` names
 * must stay inside the folder and the repository, the repository is the one
 * the maintainer names (or the one the record names, checked to hold the
 * cut's commit), and the patch carries only what a change to the slice can
 * honestly need. New files outside the slice's packages, files that run on
 * someone's machine or in CI without a review of code (workflows, hooks,
 * manifests, lockfiles, environment), deleted tests and tests whose
 * assertions were removed, rewritten or skipped are left out and named,
 * unless the maintainer allows them by path or glob.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import ts from "typescript";
import { isTestPath, pathMatcher } from "./core.js";

/**
 * Paths a patch from a slice never carries unless allowed: they run in CI
 * with its secrets, on a maintainer's machine (hooks, editor tasks), at
 * install (manifests, lockfiles, registry configuration), or hold
 * configuration a change to code does not need.
 */
export const PROTECTED_PATHS: readonly string[] = [
  ".github",
  ".gitlab",
  ".gitlab-ci.yml",
  ".circleci",
  ".buildkite",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "Jenkinsfile",
  ".husky",
  ".githooks",
  ".devcontainer",
  ".vscode",
  "**/.gitattributes",
  "**/.gitmodules",
  "**/CODEOWNERS",
  "carveout.config.json",
  "**/package.json",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/pnpm-lock.yaml",
  "**/pnpm-workspace.yaml",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/Makefile",
  "**/*.sh",
];

/**
 * Throws unless `path` is a plain relative path that stays where it is
 * joined: `/`-separated, not absolute, no `.` or `..` segment, no `.git`.
 */
export function assertSafePath(path: unknown, what: string): asserts path is string {
  const fail = (why: string) => {
    throw new Error(
      `carveout.json is not one carveout wrote: ${what} ${JSON.stringify(path)} ${why}. Cut the folder again rather than trust it.`,
    );
  };
  if (typeof path !== "string" || path === "") return fail("is not a path");
  if (path.includes("\0") || path.includes("\\")) fail("holds a NUL or a backslash");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) fail("is absolute");
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    fail("leaves its folder");
  if (parts.some((part) => part.toLowerCase() === ".git")) fail("is inside .git");
  if (posix.normalize(path) !== path) fail("is not normalized");
}

/** What `checkRecordPaths` reads of a record. */
interface RecordPaths {
  readonly manifest: { readonly included: readonly { readonly path: unknown }[] };
  readonly generated: readonly { readonly path: unknown }[];
  readonly copied?: readonly { readonly path: unknown }[];
  readonly extras?: readonly { readonly path: unknown }[];
  readonly importRewrites: readonly { readonly file: unknown }[];
  readonly request: { readonly entryPoints: readonly unknown[] };
}

/** Every path a record makes carveout read, write or delete, checked. */
export function checkRecordPaths(record: RecordPaths): void {
  const list = (value: unknown, what: string) => {
    if (!Array.isArray(value)) throw new Error(`carveout.json: ${what} is not a list.`);
    return value as readonly Record<string, unknown>[];
  };
  for (const file of list(record.manifest?.included, "manifest.included"))
    assertSafePath(file["path"], "manifest.included");
  for (const file of list(record.generated, "generated"))
    assertSafePath(file["path"], "generated");
  for (const file of list(record.copied ?? [], "copied")) assertSafePath(file["path"], "copied");
  for (const file of list(record.extras ?? [], "extras")) assertSafePath(file["path"], "extras");
  for (const rewrite of list(record.importRewrites, "importRewrites"))
    assertSafePath(rewrite["file"], "importRewrites");
  const entries: readonly unknown[] = list(record.request?.entryPoints, "request.entryPoints");
  for (const entry of entries)
    if (entry !== ".") assertSafePath(entry, "request.entryPoints");
}

/**
 * The checkout to diff and apply against: the one the maintainer names, else
 * the record's. Either way it must be a folder that holds the cut's commit,
 * so a record cannot point carveout at another folder of the machine.
 */
export function trustedRepo(
  record: { readonly repo?: string | null; readonly manifest: { readonly sourceCommitSha: string | null } },
  given: string | undefined,
): string {
  const named = given ?? record.repo ?? undefined;
  if (named === undefined || named === "")
    throw new Error(
      "The folder does not name its repository (a --public cut). Run this from the repository's root, or pass --repo <checkout>.",
    );
  const repo = resolve(named);
  if (!existsSync(repo) || !statSync(repo).isDirectory())
    throw new Error(`${repo} is not a folder; pass --repo <checkout>.`);
  const commit = record.manifest.sourceCommitSha;
  if (commit !== null) {
    if (!/^[0-9a-f]{7,64}$/.test(commit))
      throw new Error(`carveout.json names ${JSON.stringify(commit)} as its commit, which is no commit id.`);
    try {
      execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
        cwd: repo,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      throw new Error(
        `${repo} does not hold the cut's commit ${commit.slice(0, 12)}; pass --repo <checkout> of the repository the folder was cut from.`,
      );
    }
  }
  return repo;
}

export interface Refusal {
  readonly path: string;
  readonly reason: string;
}

/**
 * Configuration that decides what a check holds code to: compiler, linter
 * and test-runner settings. A change that loosens one makes every check
 * after it pass more, so `gate` names it for a review.
 */
export const CHECK_CONFIG_PATHS: readonly string[] = [
  "**/tsconfig*.json",
  "**/jsconfig*.json",
  "**/.eslintrc",
  "**/.eslintrc.*",
  "**/eslint.config.*",
  "**/biome.json",
  "**/biome.jsonc",
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/.c8rc",
  "**/.c8rc.json",
  "**/.nycrc",
  "**/.nycrc.json",
];

/** Comments that switch a check off for the code after them. */
const SUPPRESSION = /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|biome-ignore|istanbul ignore|c8 ignore|v8 ignore/g;

/** How many check suppressions a script's text holds. */
export function suppressionsOf(text: string): number {
  return text.match(SUPPRESSION)?.length ?? 0;
}

/**
 * Judges each path a patch would carry. `packages` are the repository's
 * package folders the slice holds files of ("" for the root package);
 * `allow` are the maintainer's paths and globs that pass whatever the rule.
 */
export function handoffPolicy(options: {
  /** Without it, a new file may go anywhere. */
  readonly packages?: ReadonlySet<string>;
  readonly packageOf?: (path: string) => string;
  readonly allow?: readonly string[];
  /**
   * Also refuse what loosens a check: an edit to compiler, linter or
   * test-runner configuration, and a script that gains suppressions
   * (`@ts-ignore`, `eslint-disable`, coverage ignores). `gate` turns it on.
   */
  readonly checks?: boolean;
  /** How a refusal names a test: "a test the slice was handed" by default. */
  readonly testNoun?: string;
}): (
  path: string,
  change: "added" | "changed" | "deleted",
  texts?: { readonly before: string | null; readonly after: string },
) => string | null {
  const allowed = pathMatcher(options.allow ?? []);
  const protectedPath = pathMatcher(PROTECTED_PATHS);
  const checkConfig = pathMatcher(options.checks === true ? CHECK_CONFIG_PATHS : []);
  const noun = options.testNoun ?? "a test the slice was handed";
  const { packages, packageOf } = options;
  return (path, change, texts) => {
    if (allowed(path)) return null;
    if (protectedPath(path))
      return "a protected path (CI, hooks, manifests, lockfiles, environment): review it and pass --allow to carry it";
    if (checkConfig(path) && change !== "added")
      return "changes what a check holds code to (compiler, linter or test-runner configuration): review it and pass --allow to carry it";
    if (
      change === "added" &&
      packages !== undefined &&
      packageOf !== undefined &&
      !packages.has(packageOf(path))
    )
      return "a new file outside the slice's packages";
    if (change === "deleted" && isTestPath(path)) return `deletes ${noun}`;
    if (change === "changed" && isTestPath(path) && texts !== undefined && texts.before !== null) {
      const weakened = weakenedTest(path, texts.before, texts.after, noun);
      if (weakened !== null) return `${weakened}: review it and pass --allow to carry it`;
    }
    if (options.checks === true && change !== "deleted" && texts !== undefined && /\.[cm]?[jt]sx?$/.test(path)) {
      const more = suppressionsOf(texts.after) - suppressionsOf(texts.before ?? "");
      if (more > 0)
        return `adds ${more} check suppression${more === 1 ? "" : "s"} (@ts-ignore, eslint-disable, coverage ignores): review it and pass --allow to carry it`;
    }
    return null;
  };
}

/**
 * Whether an expression is a constant the code can read without running
 * it: `true`, `false`, `0`, `1`, `""`, `null`, `undefined`, `!x` of one, or
 * one in parentheses. Null for anything else.
 */
function constantOf(node: ts.Expression): boolean | null {
  if (ts.isParenthesizedExpression(node)) return constantOf(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = constantOf(node.operand);
    return inner === null ? null : !inner;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(node) && node.text === "undefined") return false;
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
  if (ts.isStringLiteralLike(node)) return node.text !== "";
  return null;
}

/** Modules whose calls are assertions, by import specifier. */
const ASSERTION_MODULES = /^(node:)?assert(\/strict)?$|^(vitest|chai|expect|@jest\/globals)$/;

/**
 * The assertions of a test file, each as its whitespace-free text, and the
 * tests it skips. An assertion is a call rooted at `assert` or `expect`,
 * or at a name imported from an assertion module (`strictEqual` from
 * `node:assert`); a skip is `test.skip`, `it.todo`, `describe.skip`,
 * `xit`, `xdescribe`, or a `{ skip }` or `{ todo }` option; a focus is
 * `test.only`, `describe.only`, `fit` or `fdescribe`, which skips the rest.
 */
function assertionsOf(
  path: string,
  text: string,
): { assertions: string[]; skips: number; focused: number } {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const roots = new Set(["assert", "expect"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!ASSERTION_MODULES.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name !== undefined) roots.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) roots.add(bindings.name.text);
    else if (bindings !== undefined) for (const element of bindings.elements) roots.add(element.name.text);
  }
  const rootOf = (node: ts.Expression): string | null => {
    let current: ts.Expression = node;
    for (;;) {
      if (ts.isIdentifier(current)) return current.text;
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
        current = current.expression;
      else if (ts.isCallExpression(current)) current = current.expression;
      else if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current))
        current = current.expression;
      else return null;
    }
  };
  const assertions: string[] = [];
  let skips = 0;
  let focused = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const base = rootOf(callee);
      if (
        (name === "skip" || name === "todo") &&
        base !== null &&
        ["test", "it", "describe", "suite"].includes(base)
      )
        skips += 1;
      if (name === "only" && base !== null && ["test", "it", "describe", "suite"].includes(base))
        focused += 1;
      if (ts.isIdentifier(callee) && (callee.text === "fit" || callee.text === "fdescribe"))
        focused += 1;
      if (ts.isIdentifier(callee) && (callee.text === "xit" || callee.text === "xdescribe" || callee.text === "xtest"))
        skips += 1;
      if (base !== null && ["test", "it", "describe", "suite"].includes(base))
        for (const argument of node.arguments)
          if (ts.isObjectLiteralExpression(argument))
            for (const property of argument.properties)
              if (
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name) &&
                (property.name.text === "skip" || property.name.text === "todo") &&
                property.initializer.kind !== ts.SyntaxKind.FalseKeyword
              )
                skips += 1;
      if (base !== null && roots.has(base)) {
        // The outermost call of a chain is the assertion: `expect(x).toBe(y)`.
        // Formatting is not a change: whitespace and trailing commas go.
        assertions.push(node.getText(source).replace(/\s+/g, "").replace(/,(?=[)\]}])/g, ""));
        return;
      }
    }
    // Code that never runs holds no assertion: what follows a `return`,
    // `throw`, `break` or `continue` in its block, and the branch of an
    // `if` (or the body of a loop) on a constant that never takes it. A
    // test emptied by `return;` at its top keeps every assertion's text.
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node) || ts.isModuleBlock(node)) {
      for (const statement of node.statements) {
        visit(statement);
        if (
          ts.isReturnStatement(statement) ||
          ts.isThrowStatement(statement) ||
          ts.isBreakStatement(statement) ||
          ts.isContinueStatement(statement)
        )
          return;
      }
      return;
    }
    if (ts.isIfStatement(node)) {
      const known = constantOf(node.expression);
      visit(node.expression);
      if (known !== false) visit(node.thenStatement);
      if (known !== true && node.elseStatement !== undefined) visit(node.elseStatement);
      return;
    }
    const loopCondition = ts.isWhileStatement(node)
      ? node.expression
      : ts.isForStatement(node)
        ? node.condition
        : undefined;
    if (loopCondition !== undefined && constantOf(loopCondition) === false) return;
    if (ts.isBinaryExpression(node) && constantOf(node.left) !== null) {
      const known = constantOf(node.left);
      visit(node.left);
      const operator = node.operatorToken.kind;
      if (
        (operator === ts.SyntaxKind.AmpersandAmpersandToken && known === true) ||
        (operator === ts.SyntaxKind.BarBarToken && known === false) ||
        (operator !== ts.SyntaxKind.AmpersandAmpersandToken && operator !== ts.SyntaxKind.BarBarToken)
      )
        visit(node.right);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { assertions, skips, focused };
}

/**
 * Why a change to a test the slice was handed weakens it, or null: an
 * assertion removed or rewritten (an expected value changed), a test
 * skipped, or one focused with `.only`. Assertions only added pass. A
 * rewritten assertion may be the change itself (a behaviour the
 * contributor was asked to change), so it is refused for a maintainer to
 * read, not judged wrong.
 */
export function weakenedTest(
  path: string,
  before: string,
  after: string,
  noun = "a test the slice was handed",
): string | null {
  const old = assertionsOf(path, before);
  const now = assertionsOf(path, after);
  const left = new Map<string, number>();
  for (const assertion of now.assertions) left.set(assertion, (left.get(assertion) ?? 0) + 1);
  let removed = 0;
  for (const assertion of old.assertions) {
    const count = left.get(assertion) ?? 0;
    if (count > 0) left.set(assertion, count - 1);
    else removed += 1;
  }
  const reasons: string[] = [];
  if (removed > 0)
    reasons.push(`removes or rewrites ${removed} assertion${removed === 1 ? "" : "s"} of ${noun}`);
  if (now.skips > old.skips)
    reasons.push(`skips ${now.skips - old.skips} more test${now.skips - old.skips === 1 ? "" : "s"}`);
  if (now.focused > old.focused)
    reasons.push(
      `focuses ${now.focused - old.focused} more test${now.focused - old.focused === 1 ? "" : "s"} with .only, which skips the rest of the file`,
    );
  return reasons.length === 0 ? null : reasons.join(", and ");
}
