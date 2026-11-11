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
import { isTestPath, isTestSupportPath, pathMatcher } from "./core.js";
import { isNodeBuiltin } from "./extract/typescript.js";
import { PURE_NODE_MODULES, serviceOf } from "./slice/externals.js";

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
  /**
   * Also refuse a script that gains a reach it did not have: the disk, the
   * network, the process or its environment, a service SDK, or code loaded
   * by a computed name (`reachOf`). A returned test or module runs beside
   * the whole repository, the closed part included, so `patch` turns it on.
   */
  readonly reach?: boolean;
  /**
   * Also refuse a script that gains a way to pass a test without the code
   * passing it (`integrityOf`): ending the test run early, swallowing its
   * failures, telling a test run from a real one, rewriting the assertion
   * library or a built-in. `patch` and `gate` turn it on.
   */
  readonly integrity?: boolean;
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
    const script = /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
    // A fake, a builder or a fixture decides what a test sees as much as
    // the test does: an edit to one is a test edit.
    const support = !isTestPath(path) && isTestSupportPath(path);
    if (change === "deleted" && isTestPath(path)) return `deletes ${noun}`;
    if (change === "deleted" && support)
      return "deletes a test's helper or fixture: review it and pass --allow to carry it";
    if (
      change === "changed" &&
      (isTestPath(path) || (support && script)) &&
      texts !== undefined &&
      texts.before !== null
    ) {
      const weakened = weakenedTest(path, texts.before, texts.after, support ? "a test's helper" : noun);
      if (weakened !== null) return `${weakened}: review it and pass --allow to carry it`;
    }
    if (change === "changed" && support && !script && texts !== undefined && texts.before !== texts.after)
      return "changes a test fixture (data a test reads): review it and pass --allow to carry it";
    if (options.integrity === true && change !== "deleted" && texts !== undefined) {
      const gained = gainedIntegrity(path, texts.before, texts.after);
      if (gained.length > 0)
        return `could pass a test without the code passing it (${gained.join(", ")}): review it and pass --allow to carry it`;
    }
    if (options.checks === true && change !== "deleted" && texts !== undefined && /\.[cm]?[jt]sx?$/.test(path)) {
      const more = suppressionsOf(texts.after) - suppressionsOf(texts.before ?? "");
      if (more > 0)
        return `adds ${more} check suppression${more === 1 ? "" : "s"} (@ts-ignore, eslint-disable, coverage ignores): review it and pass --allow to carry it`;
    }
    if (options.reach === true && change !== "deleted" && texts !== undefined) {
      const gained = gainedReach(path, texts.before, texts.after);
      if (gained.length > 0)
        return `reaches what it did not before (${gained.join(", ")}): it runs beside the whole repository, the closed part included; read it and pass --allow to carry it`;
    }
    return null;
  };
}

/**
 * Node's modules a returned script may import without a review: those pure
 * code may (`PURE_NODE_MODULES`), and the test runner, timers and streams,
 * which reach neither the disk, the network nor the process.
 */
const QUIET_NODE_MODULES: ReadonlySet<string> = new Set([
  ...PURE_NODE_MODULES,
  "async_hooks",
  "console",
  "diagnostics_channel",
  "perf_hooks",
  "punycode",
  "stream",
  "test",
  "timers",
  "zlib",
]);

/** Globals that reach the network, run text as code, or start a thread. */
const REACHING_GLOBALS: ReadonlySet<string> = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "eval",
  "Function",
  "WebAssembly",
  "Worker",
  "Deno",
  "Bun",
]);

/** A module specifier that loads code from somewhere other than a package or a file. */
const URL_SPECIFIER = /^(data|https?|file|blob):/i;

/** What a `process` member reaches: its environment, or native code. */
const REACHING_PROCESS: ReadonlySet<string> = new Set([
  "env",
  "binding",
  "dlopen",
  "mainModule",
  "getBuiltinModule",
]);

/** Names the global object goes by. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "global", "window", "self"]);

/**
 * What a script reaches beyond its own computation, read from its syntax
 * and never run: Node modules with the disk, the network or the process
 * (`node:fs`), service SDKs, network and code-running globals (`fetch`,
 * `eval`), the environment (`process.env`, `import.meta.env`), and modules
 * or globals named by a computed value, which could be any of these. Each
 * as a short label, sorted. Text-level: a hold for a reader, not a sandbox.
 */
export function reachOf(path: string, text: string): string[] {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const found = new Set<string>();
  const specifier = (name: string) => {
    if (URL_SPECIFIER.test(name)) found.add("a module loaded from a URL");
    else if (isNodeBuiltin(name)) {
      const root = (name.startsWith("node:") ? name.slice(5) : name).split("/")[0] ?? name;
      if (!QUIET_NODE_MODULES.has(root)) found.add(`node:${root}`);
    } else if (serviceOf(name) !== null) found.add(name);
  };
  const computed = "a module named by a computed value";
  const literal = (node: ts.Node | undefined): string | null =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
  /** Whether an identifier is a binding's name or a member's, not a read. */
  const named = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (parent === undefined) return false;
    // `x.fetch` is a member, but `globalThis.fetch` is the global.
    if (ts.isPropertyAccessExpression(parent))
      return parent.name === node && !(ts.isIdentifier(parent.expression) && GLOBAL_OBJECTS.has(parent.expression.text));
    // A type erases: `x: Function`, `typeof fetch`.
    if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent)) return true;
    // `{ fetch }` reads it; `{ fetch: 1 }`, `const fetch`, `f(fetch)` name or read.
    if (ts.isShorthandPropertyAssignment(parent)) return false;
    return (parent as { name?: ts.Node }).name === node;
  };
  /** `process`, or `globalThis.process`. */
  const isProcess = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && node.text === "process") ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "process" &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text));
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      const name = literal(node.moduleSpecifier);
      if (name !== null && !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true)) specifier(name);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const name = literal(node.moduleReference.expression);
      if (name === null) found.add(computed);
      else specifier(name);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      if (
        ts.isCallExpression(node) &&
        (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require"))
      ) {
        const name = literal(node.arguments?.[0]);
        if (name === null) found.add(computed);
        else specifier(name);
      }
      // `({}).constructor.constructor("…")` is `Function`, by another name.
      if (
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "constructor") ||
        (ts.isElementAccessExpression(callee) && literal(callee.argumentExpression) === "constructor")
      )
        found.add("a constructor called through .constructor");
    } else if (ts.isPropertyAccessExpression(node)) {
      if (isProcess(node.expression) && REACHING_PROCESS.has(node.name.text)) found.add(`process.${node.name.text}`);
      if (
        node.name.text === "env" &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      )
        found.add("import.meta.env");
    } else if (ts.isElementAccessExpression(node)) {
      const target = node.expression;
      const key = literal(node.argumentExpression);
      if (isProcess(target)) {
        if (key === null) found.add("a process member named by a computed value");
        else if (REACHING_PROCESS.has(key)) found.add(`process.${key}`);
      } else if (ts.isIdentifier(target) && GLOBAL_OBJECTS.has(target.text)) {
        if (key === null) found.add("a global named by a computed value");
        else if (REACHING_GLOBALS.has(key)) found.add(key);
        else if (key === "process") found.add("process");
      }
    } else if (ts.isIdentifier(node) && REACHING_GLOBALS.has(node.text) && !named(node)) {
      found.add(node.text);
    } else if (ts.isIdentifier(node) && node.text === "require" && !named(node)) {
      // `require("x")` names its module and `require.resolve` loads nothing;
      // `const r = require` loads whatever `r` is later given.
      const parent = node.parent;
      const called = ts.isCallExpression(parent) && parent.expression === node;
      const resolves = ts.isPropertyAccessExpression(parent) && parent.name.text === "resolve";
      if (!called && !resolves) found.add("require taken as a value");
    } else if (ts.isIdentifier(node) && (node.text === "globalThis" || node.text === "global") && !named(node)) {
      // `globalThis.fetch` and `globalThis["fetch"]` are judged by name above;
      // `const g = globalThis` hides every later access behind `g`.
      const parent = node.parent;
      const accessed =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
      if (!accessed) found.add("the global object taken as a value");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

/** Test runners' globals: read from code that is not a test, they tell a test run from a real one. */
const TEST_RUNNER_GLOBALS: ReadonlySet<string> = new Set([
  "describe",
  "it",
  "test",
  "expect",
  "vi",
  "jest",
  "suite",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "__vitest_worker__",
  "__vitest_environment__",
]);

/** Environment variables a test runner sets in the processes it starts. */
const TEST_RUNNER_ENV: ReadonlySet<string> = new Set([
  "VITEST",
  "VITEST_WORKER_ID",
  "VITEST_POOL_ID",
  "VITEST_MODE",
  "JEST_WORKER_ID",
  "NODE_TEST_CONTEXT",
  "MOCHA_WORKER_ID",
]);

/** `process` members that end the run, or set the code it ends with. */
const ENDING_PROCESS: ReadonlySet<string> = new Set(["exit", "exitCode", "abort", "reallyExit", "kill"]);

/** Process events a listener can use to swallow a test's failure, or rewrite its exit. */
const FAILURE_EVENTS: ReadonlySet<string> = new Set([
  "uncaughtException",
  "uncaughtExceptionMonitor",
  "unhandledRejection",
  "exit",
  "beforeExit",
]);

/** Built-ins whose members code under test calls: rewritten, they change every test's answer. */
const BUILTIN_OBJECTS: ReadonlySet<string> = new Set([
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Promise",
  "JSON",
  "Math",
  "Date",
  "Function",
  "RegExp",
  "Error",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Reflect",
  "Intl",
]);

/** Modules a test takes its runner or its assertions from. */
const RUNNER_MODULES = /^(node:)?(assert(\/strict)?|test)$|^(vitest|chai|expect|@jest\/globals|mocha)$/;

/**
 * How a script could make a test pass without the code under test passing
 * it, read from its syntax and never run. In any script: ending the
 * process early (`process.exit(0)` before the tests run reports success),
 * listening for the failures it would otherwise die of
 * (`process.on("uncaughtException", …)`), and rewriting the assertion
 * library or the runner (`assert.equal = () => {}`). In code that is not a
 * test nor a test's helper: telling a test run from a real one
 * (`typeof describe`, `import.meta.vitest`, `process.env.VITEST`,
 * `NODE_ENV === "test"`, `process.argv` matched against "test"), and
 * rewriting a built-in (`Array.prototype.includes = …`). A test's own code
 * may mock `Date.now`; the code under test may not. Each as a short label,
 * sorted. Text-level, like `reachOf`: a hold for a reader, not a sandbox.
 */
export function integrityOf(path: string, text: string): string[] {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const testCode = isTestPath(path) || isTestSupportPath(path);
  const found = new Set<string>();
  // The names this file binds to its runner and assertion modules.
  const runnerBindings = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!RUNNER_MODULES.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name !== undefined) runnerBindings.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) runnerBindings.add(bindings.name.text);
    else if (bindings !== undefined)
      for (const element of bindings.elements) runnerBindings.add(element.name.text);
  }
  const literal = (node: ts.Node | undefined): string | null =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
  const isProcess = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && node.text === "process") ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "process" &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text));
  /** `x.name` or `x["name"]`: the member's name when it is written out. */
  const memberName = (node: ts.Node): string | null =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node)
        ? literal(node.argumentExpression)
        : null;
  /** The identifier a member chain starts at: `assert` for `assert.strict.equal`. */
  const rootOf = (node: ts.Expression): ts.Identifier | null => {
    let current: ts.Expression = node;
    for (;;) {
      if (ts.isIdentifier(current)) return current;
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
      else if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
      else return null;
    }
  };
  /** Whether a member chain is rooted at the runner or the assertion library. */
  const onRunner = (node: ts.Expression): boolean => {
    const root = rootOf(node);
    return root !== null && root !== node && runnerBindings.has(root.text);
  };
  /** `Array.prototype.x` or `Math.x`: a built-in's member, written out. */
  const builtinMember = (node: ts.Expression): string | null => {
    if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return null;
    const root = rootOf(node);
    if (root === null || !BUILTIN_OBJECTS.has(root.text)) return null;
    return node.getText(source).replace(/\s+/g, "");
  };
  /** Whether a node sits in a function body, not at the module's top level. */
  const inFunction = (node: ts.Node): boolean => {
    for (let current = node.parent; current !== undefined; current = current.parent)
      if (ts.isFunctionLike(current)) return true;
    return false;
  };
  const isTestEnv = (node: ts.Node): string | null => {
    // `process.env.VITEST`, `process.env["JEST_WORKER_ID"]`
    if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return null;
    const name = memberName(node);
    const target = node.expression;
    if (name === null || !(ts.isPropertyAccessExpression(target) && target.name.text === "env" && isProcess(target.expression)))
      return null;
    return TEST_RUNNER_ENV.has(name) ? `process.env.${name}` : name === "NODE_ENV" ? "NODE_ENV" : null;
  };
  const visit = (node: ts.Node): void => {
    // Ending the run: `process.exit(0)`, `process.exitCode = 0`, `process.kill(process.pid)`.
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isProcess(node.expression)) {
      const name = memberName(node);
      // `process.kill(child.pid)` stops a server a test started; only the
      // run's own pid ends the run.
      const killsItself =
        name !== "kill" ||
        (ts.isCallExpression(node.parent) &&
          node.parent.expression === node &&
          /^(globalThis\.)?process\.p?pid$/.test(node.parent.arguments[0]?.getText(source).replace(/\s+/g, "") ?? ""));
      if (name !== null && ENDING_PROCESS.has(name) && killsItself && (testCode || !inFunction(node)))
        found.add(`process.${name}`);
      if (!testCode && (name === "argv" || name === "execArgv")) {
        // Read from the code under test and matched against a runner's name.
        let statement: ts.Node = node;
        while (statement.parent !== undefined && !ts.isStatement(statement)) statement = statement.parent;
        const said: string[] = [];
        const strings = (child: ts.Node): void => {
          if (ts.isStringLiteralLike(child)) said.push(child.text);
          ts.forEachChild(child, strings);
        };
        strings(statement);
        if (said.some((value) => /\b(test|tests|spec|vitest|jest|mocha)\b/i.test(value)))
          found.add(`process.${name} matched against a test runner`);
      }
    }
    // Swallowing a failure: `process.on("uncaughtException", () => {})`.
    if (ts.isCallExpression(node) && testCode) {
      const callee = node.expression;
      const method = memberName(callee);
      const event = literal(node.arguments[0]);
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        isProcess(callee.expression) &&
        method !== null &&
        ["on", "once", "addListener", "prependListener", "prependOnceListener"].includes(method) &&
        event !== null &&
        FAILURE_EVENTS.has(event)
      )
        found.add(`process.${method}("${event}")`);
    }
    // Rewriting the runner, the assertions, or (from the code under test) a built-in.
    const written: ts.Expression[] = [];
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      written.push(node.left);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const target = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : null;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const first = node.arguments[0];
      if (
        first !== undefined &&
        ((target === "Object" && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(method ?? "")) ||
          (target === "Reflect" && ["set", "defineProperty", "setPrototypeOf", "deleteProperty"].includes(method ?? "")))
      )
        written.push(first);
    }
    for (const target of written) {
      if (onRunner(target) || (ts.isIdentifier(target) && runnerBindings.has(target.text)))
        found.add("rewrites the test runner or the assertion library");
      else if (!testCode) {
        const member = builtinMember(target);
        if (member !== null) found.add(`rewrites ${member}`);
      }
    }
    if (!testCode) {
      // Telling a test run from a real one.
      if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression) && TEST_RUNNER_GLOBALS.has(node.expression.text))
        found.add(`typeof ${node.expression.text}`);
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        GLOBAL_OBJECTS.has(node.expression.text)
      ) {
        const name = memberName(node);
        if (name !== null && TEST_RUNNER_GLOBALS.has(name)) found.add(`${node.expression.text}.${name}`);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "vitest" &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      )
        found.add("import.meta.vitest");
      if (ts.isIdentifier(node) && (node.text === "__vitest_worker__" || node.text === "__vitest_environment__"))
        found.add(node.text);
      const env = isTestEnv(node);
      if (env !== null && env !== "NODE_ENV") found.add(env);
      // `process.env.NODE_ENV === "test"`, either way round.
      if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(node.operatorToken.kind)
      ) {
        const sides = [node.left, node.right];
        if (
          sides.some((side) => isTestEnv(side) === "NODE_ENV") &&
          sides.some((side) => /^test(ing)?$/i.test(literal(side) ?? ""))
        )
          found.add('NODE_ENV === "test"');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

/**
 * The ways to pass a test without the code that a script's new text has
 * and its old text did not (`integrityOf`), or nothing when it is no script.
 */
export function gainedIntegrity(path: string, before: string | null, after: string): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(path) || /\.d\.[cm]?ts$/.test(path)) return [];
  const had = new Set(before === null ? [] : integrityOf(path, before));
  return integrityOf(path, after).filter((label) => !had.has(label));
}

/**
 * The reach a script's new text has that its old text did not (`reachOf`),
 * or nothing when it is no script. A file that already read the disk may
 * keep doing so: only what the change adds is a question.
 */
export function gainedReach(path: string, before: string | null, after: string): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(path) || /\.d\.[cm]?ts$/.test(path)) return [];
  const had = new Set(before === null ? [] : reachOf(path, before));
  return reachOf(path, after).filter((label) => !had.has(label));
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
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  const roots = assertionRoots(source);
  const rootOf = chainRoot;
  const flat = (node: ts.Node) =>
    node.getText(source).replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
  /**
   * What an assertion runs under: the conditions, loops and callbacks
   * between it and its test, outermost first. Part of its identity, so an
   * assertion moved under `if (result)` or into a callback nothing may
   * call counts as rewritten; a condition that always holds adds nothing.
   */
  const guardsOf = (node: ts.Node): string => {
    const guards: string[] = [];
    let child: ts.Node = node;
    for (let current = node.parent; current !== undefined && !ts.isSourceFile(current); current = current.parent) {
      if (ts.isIfStatement(current)) {
        const known = constantOf(current.expression);
        if (child === current.thenStatement && known !== true) guards.push(`if(${flat(current.expression)})`);
        if (child === current.elseStatement && known !== false) guards.push(`else(${flat(current.expression)})`);
      } else if (ts.isConditionalExpression(current)) {
        if (child === current.whenTrue) guards.push(`?(${flat(current.condition)})`);
        if (child === current.whenFalse) guards.push(`:(${flat(current.condition)})`);
      } else if (ts.isBinaryExpression(current) && child === current.right) {
        const operator = current.operatorToken.kind;
        const known = constantOf(current.left);
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken && known !== true) guards.push(`&&(${flat(current.left)})`);
        if (operator === ts.SyntaxKind.BarBarToken && known !== false) guards.push(`||(${flat(current.left)})`);
        if (operator === ts.SyntaxKind.QuestionQuestionToken) guards.push(`??(${flat(current.left)})`);
      } else if (ts.isForOfStatement(current) || ts.isForInStatement(current)) {
        if (child === current.statement) guards.push(`for(${flat(current.expression)})`);
      } else if (ts.isForStatement(current) || ts.isWhileStatement(current)) {
        if (child === current.statement)
          guards.push(`loop(${ts.isForStatement(current) ? (current.condition === undefined ? "" : flat(current.condition)) : flat(current.expression)})`);
      } else if (ts.isCaseClause(current)) {
        guards.push(`case(${flat(current.expression)})`);
      } else if (ts.isFunctionLike(current)) {
        // A test's or a hook's own body adds nothing; any other function
        // runs only when something calls it.
        const call = current.parent;
        const structural =
          call !== undefined &&
          ts.isCallExpression(call) &&
          call.arguments.some((argument) => argument === current) &&
          TEST_STRUCTURE.has(chainRoot(call.expression) ?? "");
        if (!structural)
          guards.push(
            `fn(${call !== undefined && ts.isCallExpression(call) ? flat(call.expression) : ts.isFunctionDeclaration(current) ? (current.name?.text ?? "") : current.kind})`,
          );
      }
      child = current;
    }
    return guards.reverse().join(">");
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
        const guards = guardsOf(node);
        assertions.push(guards === "" ? flat(node) : `${guards}>${flat(node)}`);
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
    // An assertion in a `try` whose `catch` does not throw again fails
    // into the catch and passes: `try { assert(...) } catch {}`.
    if (ts.isTryStatement(node) && node.catchClause !== undefined) {
      let rethrows = false;
      const find = (child: ts.Node): void => {
        if (ts.isThrowStatement(child)) rethrows = true;
        else if (!ts.isFunctionLike(child)) ts.forEachChild(child, find);
      };
      find(node.catchClause.block);
      if (rethrows) visit(node.tryBlock);
      visit(node.catchClause.block);
      if (node.finallyBlock !== undefined) visit(node.finallyBlock);
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

/** Calls whose function arguments hold a test or its hooks. */
const TEST_STRUCTURE: ReadonlySet<string> = new Set([
  "describe",
  "suite",
  "context",
  "it",
  "test",
  "specify",
  "bench",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "before",
  "after",
]);

/** The script kind TypeScript should parse a path as. */
const scriptKindOf = (path: string) =>
  /\.[cm]?tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/**
 * The names a test file's calls to its assertion modules go by: `assert`
 * and `expect`, and every name imported from an assertion module.
 */
function assertionRoots(source: ts.SourceFile): Set<string> {
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
  return roots;
}

/** The identifier a call or member chain starts at, or null. */
function chainRoot(node: ts.Expression): string | null {
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
}

/**
 * The statements of a test file that a change may add to but not alter,
 * each as its whitespace-free text: the code a test's verdict rests on
 * besides its assertions (its data, its setup, its mocks, its helpers).
 * The walk descends into the bodies of `describe`, `it`, `test` and the
 * hooks, so a test added inside a `describe` leaves the others' statements
 * as they were, and into class bodies, so a method added to a fake leaves
 * the others. Imports count by the names they bind, so an import that
 * gains a name keeps its old ones. Assertions are judged by
 * `assertionsOf`, and left out here.
 */
function statementsOf(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  const roots = assertionRoots(source);
  const flat = (node: ts.Node) =>
    node.getText(source).replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
  const out: string[] = [];
  const statement = (node: ts.Statement): void => {
    if (ts.isImportDeclaration(node)) {
      const from = flat(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause === undefined) {
        out.push(`import${from}`);
        return;
      }
      if (clause.name !== undefined) out.push(`import${clause.name.text}from${from}`);
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) out.push(`import*as${bindings.name.text}from${from}`);
      else if (bindings !== undefined) for (const element of bindings.elements) out.push(`import{${flat(element)}}from${from}`);
      return;
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const root = chainRoot(call.expression);
      if (root !== null && roots.has(root)) return;
      if (root !== null && TEST_STRUCTURE.has(root)) {
        const bodies = call.arguments.filter(
          (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
            ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
        );
        out.push(
          `${flat(call.expression)}(${call.arguments
            .filter((argument) => !ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))
            .map(flat)
            .join(",")})`,
        );
        for (const body of bodies) {
          if (ts.isBlock(body.body)) for (const inner of body.body.statements) statement(inner);
          else out.push(flat(body.body));
        }
        return;
      }
    }
    if (ts.isClassDeclaration(node)) {
      out.push(source.text.slice(node.getStart(source), node.members.pos).replace(/\s+/g, ""));
      for (const member of node.members) out.push(flat(member));
      return;
    }
    out.push(flat(node));
  };
  for (const node of source.statements) statement(node);
  return out;
}

/**
 * The modules a test file mocks by module specifier (`vi.mock("./cart")`,
 * `jest.mock`, `mock.module` from `node:test`) that are the code's own:
 * relative or absolute paths, and any named by a computed value. A mock of
 * a package (`vi.mock("stripe")`) stands in for a service, not for the code.
 */
function ownModuleMocks(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  const mocked: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const method = callee.name.text;
      const target = callee.expression;
      const runner =
        (["mock", "doMock", "unstable_mockModule"].includes(method) &&
          ts.isIdentifier(target) &&
          (target.text === "vi" || target.text === "jest")) ||
        (method === "module" &&
          ((ts.isIdentifier(target) && target.text === "mock") ||
            (ts.isPropertyAccessExpression(target) && target.name.text === "mock")));
      if (runner) {
        const first = node.arguments[0];
        const name = first !== undefined && ts.isStringLiteralLike(first) ? first.text : null;
        if (name === null) mocked.push("a module named by a computed value");
        else if (name.startsWith(".") || name.startsWith("/")) mocked.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return mocked;
}

/** What `before` holds that `after` does not, counted as multisets. */
function removedFrom(before: readonly string[], after: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const item of after) left.set(item, (left.get(item) ?? 0) + 1);
  const removed: string[] = [];
  for (const item of before) {
    const count = left.get(item) ?? 0;
    if (count > 0) left.set(item, count - 1);
    else removed.push(item);
  }
  return removed;
}

/**
 * Why a change to a test the slice was handed weakens it, or null: an
 * assertion removed or rewritten (an expected value changed), a test
 * skipped, or one focused with `.only`; a statement the assertions rest
 * on rewritten or removed (the data a test passes in, the value it
 * compares with, its setup or helpers); and a mock added of the code's own
 * module, which can stand in for the code under test. Assertions, tests
 * and statements only added pass. A rewritten assertion may be the change
 * itself (a behaviour the contributor was asked to change), so it is
 * refused for a maintainer to read, not judged wrong.
 */
export function weakenedTest(
  path: string,
  before: string,
  after: string,
  noun = "a test the slice was handed",
): string | null {
  const old = assertionsOf(path, before);
  const now = assertionsOf(path, after);
  const rewritten = removedFrom(statementsOf(path, before), statementsOf(path, after)).length;
  const mocks = [...new Set(removedFrom(ownModuleMocks(path, after), ownModuleMocks(path, before)))].sort();
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
  if (rewritten > 0)
    reasons.push(
      `rewrites or removes ${rewritten} other statement${rewritten === 1 ? "" : "s"} of ${noun} (the data, setup, mocks or helpers its assertions rest on)`,
    );
  if (mocks.length > 0)
    reasons.push(
      `mocks ${mocks.length} more of the code's own modules (${mocks.join(", ")}), which can stand in for the code under test`,
    );
  return reasons.length === 0 ? null : reasons.join(", and ");
}
