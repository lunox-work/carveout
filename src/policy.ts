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
import { ownSpecifier, scriptKindOf, weakenedTest } from "./test-integrity.js";
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
  // Task runners and hooks that run a command the file names.
  "**/project.json",
  "**/nx.json",
  "**/turbo.json",
  "**/.lintstagedrc*",
  "**/lint-staged.config.*",
  "**/lefthook.y*ml",
  "**/.pre-commit-config.yaml",
  "**/bunfig.toml",
  "**/deno.json",
  "**/deno.jsonc",
  "**/vercel.json",
  "**/netlify.toml",
  "**/Taskfile.y*ml",
  "**/justfile",
  "**/Justfile",
  "**/Procfile",
  "**/*.tf",
  "**/cdk.json",
  "**/serverless.y*ml",
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
  "**/vitest.setup.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/jest.setup.*",
  "**/setupTests.*",
  "**/test-setup.*",
  "**/.mocharc*",
  "**/ava.config.*",
  "**/playwright.config.*",
  "**/babel.config.*",
  "**/.babelrc*",
  "**/.swcrc",
  "**/.c8rc",
  "**/.c8rc.json",
  "**/.nycrc",
  "**/.nycrc.json",
];

/**
 * Of those, the files a runner or a build picks up by being there: added,
 * they change what a check holds code to as an edit does (a
 * `vitest.config.ts` that includes nothing, a setup file that skips every
 * test, a transform that rewrites the code). A new package's tsconfig or
 * linter configuration is not one.
 */
const PICKED_UP_CONFIG_PATHS: readonly string[] = CHECK_CONFIG_PATHS.filter(
  (pattern) => !/tsconfig|jsconfig/.test(pattern),
);

/** A test's helper by its name, wherever it is kept: `test-helpers.ts`, `cart.fixture.ts`. */
const HELPER_NAME = /(^|\/)[^/]*(test|spec)[-_.]?(helpers?|utils?|support|setup|fakes?|doubles?|builders?|factories)\.[cm]?[jt]sx?$|\.(fixtures?|mocks?|fakes?|stubs?)\.[cm]?[jt]sx?$/i;

/**
 * Data a test compares against: snapshots and screenshots, wherever they
 * are kept. Edited or deleted, the test is.
 */
const FIXTURE_PATH = /(^|\/)(__snapshots__|__screenshots__|__fixtures__|__image_snapshots__|[^/]*-snapshots)\/|\.snap(shot)?$/;

/** Code the policy cannot read: added or edited, it is held for a reader. */
const UNREAD_CODE = /\.(py|rb|go|rs|java|kt|kts|scala|php|cs|swift|lua|pl|vue|svelte|astro|mdx|node|wasm|so|dylib|dll|exe|bat|cmd|ps1)$/i;

/** Comments that switch a check off for the code after them. */
const SUPPRESSION = /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|biome-ignore|istanbul ignore|c8 ignore|v8 ignore/g;

/**
 * How many check suppressions a script's text holds. A test's
 * `@ts-expect-error` asserts that a call does not type-check, which is a
 * test of the types, not a suppression.
 */
export function suppressionsOf(text: string, path = ""): number {
  const found = text.match(SUPPRESSION) ?? [];
  return isTestPath(path) ? found.filter((match) => match !== "@ts-expect-error").length : found.length;
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
  /** Packages the folder installs or mocks: a bare import of another is new reach. */
  readonly knownPackages?: ReadonlySet<string>;
  /** Whether a repository path is one the slice holds or stubs; see `ReachContext.holds`. */
  readonly holds?: (path: string) => boolean;
  /** Whether a path is a test's helper by what imports it (only tests do). */
  readonly testSupport?: (path: string) => boolean;
  /**
   * Whether a path is a setup file the test runner runs before every test
   * (Vitest's `setupFiles`): whatever its name, a change to it is a change
   * to what a check holds code to. A `vi.mock` there replaces the code
   * under test in every test of the package.
   */
  readonly testSetup?: (path: string) => boolean;
}): (
  path: string,
  change: "added" | "changed" | "deleted",
  texts?: { readonly before: string | null; readonly after: string },
) => string | null {
  const allowed = pathMatcher(options.allow ?? []);
  const protectedPath = pathMatcher(PROTECTED_PATHS);
  const checkConfig = pathMatcher(options.checks === true ? CHECK_CONFIG_PATHS : []);
  const pickedUp = pathMatcher(options.checks === true ? PICKED_UP_CONFIG_PATHS : []);
  const noun = options.testNoun ?? "a test the slice was handed";
  const { packages, packageOf } = options;
  return (path, change, texts) => {
    if (allowed(path)) return null;
    if (protectedPath(path))
      return "a protected path (CI, hooks, manifests, lockfiles, environment): review it and pass --allow to carry it";
    if ((checkConfig(path) || options.testSetup?.(path) === true) && (change !== "added" || pickedUp(path)))
      return `${change === "added" ? "adds" : change === "deleted" ? "deletes" : "changes"} what a check holds code to (compiler, linter, test-runner configuration or setup): review it and pass --allow to carry it`;
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
    const support =
      !isTestPath(path) &&
      (isTestSupportPath(path) || FIXTURE_PATH.test(path) || HELPER_NAME.test(path) || (options.testSupport?.(path) ?? false));
    // A module mock a runner picks up by being there (`__mocks__/pkg.ts`
    // replaces `pkg` in every Jest test).
    if (change === "added" && /(^|\/)__mocks__\//.test(path))
      return "adds a module mock (__mocks__) that the test runner picks up for every test: review it and pass --allow to carry it";
    if (change !== "deleted" && UNREAD_CODE.test(path))
      return "code in a language the policy does not read: review it and pass --allow to carry it";
    // A file with no extension, which Node loads as code by its bare name
    // (`./checkout`) and the policy cannot read as a script.
    if (change === "added" && !/\.[^/.]+$/.test(path.split("/").pop() ?? path))
      return "a file with no extension, which Node can load as code by its bare name: review it and pass --allow to carry it";
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
    if (change === "changed" && support && !script && (texts === undefined || texts.before !== texts.after))
      return "changes a test fixture (data a test reads): review it and pass --allow to carry it";
    if (options.integrity === true && change !== "deleted" && texts !== undefined) {
      const gained = gainedIntegrity(path, texts.before, texts.after);
      if (gained.length > 0)
        return `could pass a test without the code passing it (${gained.join(", ")}): review it and pass --allow to carry it`;
    }
    if (options.checks === true && change !== "deleted" && texts !== undefined && /\.[cm]?[jt]sx?$/.test(path)) {
      const more = suppressionsOf(texts.after, path) - suppressionsOf(texts.before ?? "", path);
      if (more > 0)
        return `adds ${more} check suppression${more === 1 ? "" : "s"} (@ts-ignore, eslint-disable, coverage ignores): review it and pass --allow to carry it`;
    }
    if (options.reach === true && change !== "deleted" && texts !== undefined) {
      const gained = gainedReach(path, texts.before, texts.after, {
        ...(options.knownPackages === undefined ? {} : { knownPackages: options.knownPackages }),
        ...(packages === undefined || packageOf === undefined ? {} : { packages, packageOf }),
        ...(options.holds === undefined ? {} : { holds: options.holds }),
      });
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

/** A specifier a bundler or Node reads as raw bytes or native code: `x?raw`, `addon.node`. */
const RAW_SPECIFIER = /\?|\.node$/;

/** What a `process` member reaches: its environment, a report of it, or native code. */
const REACHING_PROCESS: ReadonlySet<string> = new Set([
  "env",
  "binding",
  "dlopen",
  "mainModule",
  "getBuiltinModule",
  "report",
  "loadEnvFile",
]);

/** Names the global object goes by. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "global", "window", "self"]);

/**
 * Packages a slice installs that carry the disk or the environment inside:
 * typescript's `sys` (always installed), vite's `loadEnv`.
 */
const PACKAGE_REACH: readonly { readonly module: string; readonly member: string; readonly label: string }[] = [
  { module: "typescript", member: "sys", label: "typescript's sys (the disk and the environment)" },
  { module: "vite", member: "loadEnv", label: "vite's loadEnv (the environment)" },
];

/** The members of CommonJS's `module` that load code. */
const MODULE_LOADER: ReadonlySet<string> = new Set(["require", "constructor", "_load", "_resolveFilename", "_compile", "createRequire"]);

/** What a script is read against: the packages and package folders the slice has. */
export interface ReachContext {
  /** Packages the folder installs or mocks; a bare import of any other is new reach. */
  readonly knownPackages?: ReadonlySet<string>;
  /** The slice's package folders, and how a path maps to one. */
  readonly packages?: ReadonlySet<string>;
  readonly packageOf?: (path: string) => string;
  /** Whether a repository path is one the slice holds or stubs already: importing it reaches nothing new. */
  readonly holds?: (path: string) => boolean;
}

/** A label for each time a script reaches past its computation; the multiset `reachOf` reads. */
function reachCounts(path: string, text: string, context: ReachContext = {}): Map<string, number> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  const found = new Map<string, number>();
  const add = (label: string) => found.set(label, (found.get(label) ?? 0) + 1);
  const specifier = (name: string) => {
    if (URL_SPECIFIER.test(name)) add("a module loaded from a URL");
    else if (RAW_SPECIFIER.test(name)) add("a file loaded raw or as native code");
    else if (isNodeBuiltin(name)) {
      const root = (name.startsWith("node:") ? name.slice(5) : name).split("/")[0] ?? name;
      if (!QUIET_NODE_MODULES.has(root)) add(`node:${root}`);
    } else if (name.startsWith(".")) {
      // An installed package's files by path: no patch shows what is there,
      // and the folder's own copy is the contributor's to plant.
      if (/(^|\/)node_modules(\/|$)/.test(name)) add("a package's files by path (node_modules)");
      // A relative import that leaves the slice's packages reads closed code.
      const { packages, packageOf, holds } = context;
      if (packages !== undefined && packageOf !== undefined) {
        const target = posix.normalize(posix.join(posix.dirname(path), name));
        if (!target.startsWith("..") && !packages.has(packageOf(target)) && !(holds?.(target) ?? false))
          add("a module outside the slice's packages");
      }
    } else if (serviceOf(name) !== null) add(name);
    else if (!ownSpecifier(name) && context.knownPackages !== undefined) {
      const pkg = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : (name.split("/")[0] ?? name);
      if (!context.knownPackages.has(pkg)) add(`a package the slice does not have (${pkg})`);
    }
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
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
    return (parent as { name?: ts.Node }).name === node;
  };
  /** `process`, or `globalThis.process`. */
  const isProcess = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && node.text === "process") ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "process" &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text));
  // The names the file declares anywhere: a bare name it does not declare is a global.
  const declared = new Set<string>();
  const declare = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    )
      declared.add(node.name.text);
    ts.forEachChild(node, declare);
  };
  declare(source);
  // The names this file binds to a package that carries reach inside.
  const packageReach = new Map<string, { member: string; label: string; whole: boolean }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    for (const rule of PACKAGE_REACH) {
      if (statement.moduleSpecifier.text !== rule.module) continue;
      const clause = statement.importClause;
      if (clause?.name !== undefined) packageReach.set(clause.name.text, { ...rule, whole: true });
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) packageReach.set(bindings.name.text, { ...rule, whole: true });
      else if (bindings !== undefined)
        for (const element of bindings.elements)
          if ((element.propertyName ?? element.name).text === rule.member) add(rule.label);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const bound = packageReach.get(node.expression.text);
      if (bound !== undefined && node.name.text === bound.member) add(bound.label);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(node:)?test$/.test(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some((element) => (element.propertyName ?? element.name).text === "run")
    )
      add("a test run of its own (node:test run)");
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      const name = literal(node.moduleSpecifier);
      const typeOnly =
        (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) ||
        (ts.isExportDeclaration(node) && node.isTypeOnly);
      if (name !== null && !typeOnly) specifier(name);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const name = literal(node.moduleReference.expression);
      if (name === null) add(computed);
      else specifier(name);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const name = literal(node.arguments[0]);
      if (name === null) add(computed);
      else specifier(name);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const target = node.expression;
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : literal(node.argumentExpression);
      if (isProcess(target)) {
        if (key === null) add("a process member named by a computed value");
        else if (REACHING_PROCESS.has(key)) add(`process.${key}`);
      } else if (ts.isIdentifier(target) && GLOBAL_OBJECTS.has(target.text)) {
        if (key === null) add("a global named by a computed value");
        else if (REACHING_GLOBALS.has(key)) add(key);
        else if (key === "process") add("process");
      } else if (ts.isIdentifier(target) && target.text === "module" && key !== null && MODULE_LOADER.has(key)) {
        add("the module loader (module.require)");
      }
      // `x.constructor`, and `x.constructor.constructor`, are `Function` by
      // another name: only its `.name`, a comparison and `this.constructor`
      // in a class are not.
      if (key === "constructor" && target.kind !== ts.SyntaxKind.ThisKeyword) {
        const parent = node.parent;
        const harmless =
          (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "name") ||
          (ts.isBinaryExpression(parent) &&
            [
              ts.SyntaxKind.EqualsEqualsEqualsToken,
              ts.SyntaxKind.ExclamationEqualsEqualsToken,
              ts.SyntaxKind.EqualsEqualsToken,
              ts.SyntaxKind.ExclamationEqualsToken,
              ts.SyntaxKind.InstanceOfKeyword,
            ].includes(parent.operatorToken.kind));
        if (!harmless) add("a constructor reached through .constructor");
      }
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta") {
      // `import.meta.env`, also through a cast (`(import.meta as any).env`),
      // a computed key, a destructuring or an alias (`const m = import.meta`):
      // only a named member other than `env` (`url`, `dirname`, `glob`) is
      // no reach.
      let outer: ts.Node = node;
      while (
        ts.isParenthesizedExpression(outer.parent) ||
        ts.isAsExpression(outer.parent) ||
        ts.isNonNullExpression(outer.parent) ||
        ts.isSatisfiesExpression(outer.parent) ||
        ts.isTypeAssertionExpression(outer.parent)
      )
        outer = outer.parent;
      const parent = outer.parent;
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer) {
        const key = ts.isPropertyAccessExpression(parent) ? parent.name.text : literal(parent.argumentExpression);
        if (key === "env") add("import.meta.env");
        else if (key === null) add("import.meta named by a computed value");
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isObjectBindingPattern(parent.name)) {
        for (const element of parent.name.elements) {
          const key =
            element.dotDotDotToken !== undefined
              ? null
              : element.propertyName === undefined
                ? ts.isIdentifier(element.name)
                  ? element.name.text
                  : null
                : ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
                  ? element.propertyName.text
                  : null;
          if (key === "env") add("import.meta.env");
          else if (key === null) add("import.meta named by a computed value");
        }
      } else if (!ts.isTypeOfExpression(parent)) add("import.meta taken as a value");
    } else if (ts.isIdentifier(node) && REACHING_GLOBALS.has(node.text) && !named(node)) {
      add(node.text);
    } else if (ts.isIdentifier(node) && node.text === "require" && !named(node)) {
      // `require("x")` names its module and `require.resolve` loads nothing;
      // `const r = require` loads whatever `r` is later given.
      const parent = node.parent;
      const called = ts.isCallExpression(parent) && parent.expression === node;
      const resolves = ts.isPropertyAccessExpression(parent) && parent.name.text === "resolve";
      if (!called && !resolves) add("require taken as a value");
    } else if (
      ts.isIdentifier(node) &&
      (node.text === "globalThis" || node.text === "global" || node.text === "process" || ((node.text === "window" || node.text === "self") && !declared.has(node.text))) &&
      !named(node)
    ) {
      // `process.env` and `globalThis["fetch"]` are judged by name above;
      // `const p = process`, `const { env } = process` or `Reflect.get(process, …)`
      // hide every later access behind another name.
      const parent = node.parent;
      const accessed =
        ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) ||
        ts.isTypeOfExpression(parent) ||
        // `vi.spyOn(process, "exit")` replaces a member for a test.
        (ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          /^(vi\.spyOn|jest\.spyOn|mock\.method|t\.mock\.method|sinon\.stub)$/.test(parent.expression.getText(source)));
      if (!accessed) add(node.text === "process" ? "process taken as a value" : "the global object taken as a value");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * What a script reaches beyond its own computation, read from its syntax
 * and never run: Node modules with the disk, the network or the process
 * (`node:fs`), service SDKs, a package the slice does not have, a module
 * outside the slice's packages, network and code-running globals (`fetch`,
 * `eval`, `Function` by any route), the environment (`process.env`,
 * `import.meta.env`, `process.report`), the module loader, a file loaded
 * raw or as native code, and modules or globals named by a computed value
 * or hidden behind one (`const p = process`), which could be any of these.
 * Each as a short label, sorted. Text-level: a hold for a reader, not a
 * sandbox.
 */
export function reachOf(path: string, text: string, context: ReachContext = {}): string[] {
  return [...reachCounts(path, text, context).keys()].sort();
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
  "npm_lifecycle_event",
]);

/** What, matched against `process.argv`, names a test run. */
const RUNNER_ARGUMENT = /\b(vitest|jest|mocha|ava)\b|--test(?![\w-])|\.(test|spec)\.|(?:^|[\\/._-])(?:tests?|spec)\.[cm]?[jt]sx?$|test[-_]runner|node:test/i;

/** What, searched for anywhere in `process.argv` (not one argument's place), names a test run too. */
const RUNNER_WORD = /(?<![\w-])(tests?|spec)(?![\w-])/i;

/** Methods that search `process.argv` as a whole, rather than read one argument. */
const SEARCHES: ReadonlySet<string> = new Set(["includes", "some", "find", "findIndex", "join", "filter", "indexOf", "toString", "every"]);

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

/** Built-in members a test may fake for itself: the clock and the dice. */
const TEST_FAKES: ReadonlySet<string> = new Set(["Date.now", "Math.random"]);

/** Built-in members any code may set: how much of a stack an error keeps. */
const BUILTIN_SETTINGS: ReadonlySet<string> = new Set(["Error.stackTraceLimit"]);

/** Modules a test takes its runner or its assertions from. */
const RUNNER_MODULES = /^(node:)?(assert(\/strict)?|test)$|^(vitest|chai|expect|@jest\/globals|mocha|bun:test)$/;

/** Matchers a runner has, which `expect.extend` must not replace. */
const BUILTIN_MATCHERS = /^(to[A-Z]\w*|resolves|rejects|not)$/;

/** Functions that run their callback right after the module loads. */
const SOON = /^(queueMicrotask|setTimeout|setImmediate|setInterval|process\.nextTick)$/;

/** A label for each way a script could pass a test without the code; the multiset `integrityOf` reads. */
function integrityCounts(path: string, text: string): Map<string, number> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  const testCode = isTestPath(path) || isTestSupportPath(path);
  const found = new Map<string, number>();
  const add = (label: string) => found.set(label, (found.get(label) ?? 0) + 1);
  const literal = (node: ts.Node | undefined): string | null =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
  /** The identifier a member chain starts at, through casts: `assert` for `(assert as any).equal`. */
  const rootOf = (node: ts.Expression): ts.Identifier | null => {
    let current: ts.Expression = node;
    for (;;) {
      if (ts.isIdentifier(current)) return current;
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
      else if (
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isTypeAssertionExpression(current)
      )
        current = current.expression;
      else return null;
    }
  };
  // The names this file binds to its runner and assertion modules, the
  // runner's globals, `process`, the built-ins, and what aliases them.
  const runnerBindings = new Set<string>(["assert", "expect", "vi", "jest", "chai"]);
  const processNames = new Set<string>(["process"]);
  const builtins = new Set<string>(BUILTIN_OBJECTS);
  const bindName = (into: Set<string>, name: ts.BindingName) => {
    if (ts.isIdentifier(name)) into.add(name.text);
  };
  const scan = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && RUNNER_MODULES.test(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name !== undefined) runnerBindings.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) runnerBindings.add(bindings.name.text);
      else if (bindings !== undefined) for (const element of bindings.elements) runnerBindings.add(element.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const init = node.initializer;
      // `const assert = require("node:assert")`
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && RUNNER_MODULES.test(literal(init.arguments[0]) ?? ""))
        bindName(runnerBindings, node.name);
      // `const a = assert`, `const O = Object`, `const p = process`
      const root = rootOf(init);
      if (root !== null && root === init) {
        if (runnerBindings.has(root.text)) bindName(runnerBindings, node.name);
        if (builtins.has(root.text)) bindName(builtins, node.name);
        if (processNames.has(root.text)) bindName(processNames, node.name);
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(source);
  const declaredNames = new Set<string>();
  const declare = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    )
      declaredNames.add(node.name.text);
    ts.forEachChild(node, declare);
  };
  declare(source);
  const isProcess = (node: ts.Expression): boolean => {
    const root = rootOf(node);
    return (
      (root !== null && root === node && processNames.has(root.text)) ||
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === "process" &&
        ts.isIdentifier(node.expression) &&
        GLOBAL_OBJECTS.has(node.expression.text))
    );
  };
  /** `x.name` or `x["name"]`: the member's name when it is written out. */
  const memberName = (node: ts.Node): string | null =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node)
        ? literal(node.argumentExpression)
        : null;
  /** Whether a member chain, or a name, is the runner's or the assertion library's. */
  const onRunner = (node: ts.Expression): boolean => {
    const root = rootOf(node);
    return root !== null && runnerBindings.has(root.text);
  };
  /** `Array.prototype.x`, `Math.x`, or `Object` itself: the built-in and the members named, casts left out. */
  const builtinTarget = (node: ts.Expression): string | null => {
    const root = rootOf(node);
    if (root === null || !builtins.has(root.text)) return null;
    const members: string[] = [];
    let current: ts.Expression = node;
    while (current !== root) {
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        members.unshift(memberName(current) ?? "[…]");
        current = current.expression;
      } else if (
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isTypeAssertionExpression(current)
      )
        current = current.expression;
      else break;
    }
    return [BUILTIN_OBJECTS.has(root.text) ? root.text : "a built-in", ...members].join(".");
  };
  /** Whether a node sits in a listener for a signal (`process.on("SIGTERM", …)`), which runs only when one comes. */
  const onSignal = (node: ts.Node): boolean => {
    for (let current = node.parent; current !== undefined; current = current.parent)
      if (
        ts.isFunctionLike(current) &&
        current.parent !== undefined &&
        ts.isCallExpression(current.parent) &&
        /^SIG[A-Z]+$/.test(literal(current.parent.arguments[0]) ?? "")
      )
        return true;
    return false;
  };
  /**
   * Whether a node runs when the module loads: at its top level, in an
   * immediately called function, or in a callback a timer or a microtask
   * runs right after; not inside a function something else must call.
   */
  const runsOnLoad = (node: ts.Node): boolean => {
    for (let current = node.parent; current !== undefined; current = current.parent) {
      if (!ts.isFunctionLike(current)) continue;
      let call: ts.Node | undefined = current.parent;
      while (call !== undefined && ts.isParenthesizedExpression(call)) call = call.parent;
      const immediately =
        call !== undefined &&
        ts.isCallExpression(call) &&
        (call.expression === current ||
          (ts.isParenthesizedExpression(call.expression) && call.expression.expression === current) ||
          (call.arguments.some((argument) => argument === current) && SOON.test(call.expression.getText(source))));
      if (!immediately) return false;
    }
    return true;
  };
  const isTestEnv = (node: ts.Node): string | null => {
    if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return null;
    const name = memberName(node);
    const target = node.expression;
    if (name === null || !((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && memberName(target) === "env" && isProcess(target.expression)))
      return null;
    return TEST_RUNNER_ENV.has(name) ? `process.env.${name}` : name === "NODE_ENV" ? "NODE_ENV" : null;
  };
  const visit = (node: ts.Node): void => {
    // Ending the run: `process.exit(0)`, `process.exitCode = 0`, `process.kill(process.pid)`.
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isProcess(node.expression)) {
      const name = memberName(node);
      const parent = node.parent;
      const called = ts.isCallExpression(parent) && parent.expression === node ? parent : null;
      const assigned =
        ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? parent : null;
      // A literal non-zero code fails the run: it fakes no pass.
      const code = called?.arguments[0] ?? assigned?.right;
      const failing = code !== undefined && ts.isNumericLiteral(code) && Number(code.text) !== 0;
      const killsItself =
        name !== "kill" ||
        (called !== null && /^(globalThis\.)?process\.p?pid$/.test(called.arguments[0]?.getText(source).replace(/\s+/g, "") ?? ""));
      // Anywhere, not only when the module loads: a function of the code
      // under test that exits 0 when a test calls it ends the test file
      // there, and node:test reports the file as passing, the failing
      // assertion after it and the tests below never run.
      if (name !== null && ENDING_PROCESS.has(name) && killsItself && !failing && !onSignal(node))
        add(`process.${name}`);
      if (!testCode && (name === "argv" || name === "execArgv")) {
        // Read from the code under test and matched against a runner's name.
        let statement: ts.Node = node;
        while (statement.parent !== undefined && !ts.isStatement(statement)) statement = statement.parent;
        const said: string[] = [];
        const strings = (child: ts.Node): void => {
          if (ts.isStringLiteralLike(child)) said.push(child.text);
          if (ts.isRegularExpressionLiteral(child)) said.push(child.text);
          ts.forEachChild(child, strings);
        };
        strings(statement);
        const parent = node.parent;
        const searched =
          (ts.isPropertyAccessExpression(parent) && parent.expression === node && SEARCHES.has(parent.name.text)) ||
          ts.isTemplateSpan(parent) ||
          (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === node));
        if (said.some((value) => RUNNER_ARGUMENT.test(value) || (searched && RUNNER_WORD.test(value))))
          add(`process.${name} matched against a test runner`);
      }
    }
    // Swallowing a failure: `process.on("uncaughtException", () => {})`.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const method = memberName(callee);
      const event = literal(node.arguments[0]);
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        isProcess(callee.expression) &&
        method !== null &&
        ["on", "once", "addListener", "prependListener", "prependOnceListener"].includes(method) &&
        event !== null &&
        FAILURE_EVENTS.has(event) &&
        (testCode || runsOnLoad(node))
      )
        add(`process.${method}("${event}")`);
      // `expect.extend({ toBe })` replaces a matcher; `addEqualityTesters`
      // decides what equal means.
      if (ts.isPropertyAccessExpression(callee) && onRunner(callee.expression)) {
        if (callee.name.text === "addEqualityTesters") add("rewrites the test runner or the assertion library");
        if (callee.name.text === "extend") {
          const matchers = node.arguments[0];
          const replaces =
            matchers === undefined ||
            !ts.isObjectLiteralExpression(matchers) ||
            matchers.properties.some((property) => {
              const key = property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? property.name.text : null;
              return key === null || BUILTIN_MATCHERS.test(key);
            });
          if (replaces) add("rewrites the test runner or the assertion library");
        }
        if (/^(overwrite|add)(Method|Property|ChainableMethod)$/.test(callee.name.text)) add("rewrites the test runner or the assertion library");
      }
    }
    // Rewriting the runner, the assertions, or a built-in.
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
      if (onRunner(target)) add("rewrites the test runner or the assertion library");
      else {
        const member = builtinTarget(target);
        if (member !== null && !BUILTIN_SETTINGS.has(member) && !(testCode && TEST_FAKES.has(member))) add(`rewrites ${member}`);
      }
    }
    if (!testCode) {
      // Telling a test run from a real one.
      if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression) && TEST_RUNNER_GLOBALS.has(node.expression.text))
        add(`typeof ${node.expression.text}`);
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        GLOBAL_OBJECTS.has(node.expression.text)
      ) {
        const name = memberName(node);
        if (name !== null && TEST_RUNNER_GLOBALS.has(name)) add(`${node.expression.text}.${name}`);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "vitest" &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      )
        add("import.meta.vitest");
      if (ts.isIdentifier(node) && (node.text === "__vitest_worker__" || node.text === "__vitest_environment__")) add(node.text);
      // `if (it)`, `typeof expect`: a runner's global, read where nothing declares it.
      if (
        ts.isIdentifier(node) &&
        TEST_RUNNER_GLOBALS.has(node.text) &&
        !node.text.startsWith("__") &&
        !declaredNames.has(node.text) &&
        !ts.isTypeOfExpression(node.parent) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
        !ts.isTypeReferenceNode(node.parent) &&
        !ts.isQualifiedName(node.parent) &&
        !((node.parent as { name?: ts.Node }).name === node)
      )
        add(`${node.text} read as a global`);
      const env = isTestEnv(node);
      if (env !== null && env !== "NODE_ENV") add(env);
      // `process.env.NODE_ENV === "test"`, either way round, or as a `case`.
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
        if (sides.some((side) => isTestEnv(side) === "NODE_ENV") && sides.some((side) => /^test(ing)?$/i.test(literal(side) ?? "")))
          add('NODE_ENV === "test"');
      }
      if (ts.isSwitchStatement(node) && isTestEnv(node.expression) === "NODE_ENV" &&
        node.caseBlock.clauses.some((clause) => ts.isCaseClause(clause) && /^test(ing)?$/i.test(literal(clause.expression) ?? "")))
        add('NODE_ENV === "test"');
      // Reading the stack for the runner's frames.
      if (ts.isPropertyAccessExpression(node) && node.name.text === "stack") {
        let statement: ts.Node = node;
        while (statement.parent !== undefined && !ts.isStatement(statement)) statement = statement.parent;
        if (/test_runner|vitest|jest|node:test/.test(statement.getText(source))) add("the stack read for a test runner");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * How a script could make a test pass without the code under test passing
 * it, read from its syntax and never run. In any script: ending the
 * process early with no failing code (`process.exit(0)` before the tests
 * run reports success; in the code under test, when it loads), listening
 * for the failures it would otherwise die of (`process.on("uncaughtException",
 * …)`), rewriting the assertion library or the runner (`assert.equal = …`,
 * an alias of it, `expect.extend` over a built-in matcher,
 * `addEqualityTesters`), and rewriting a built-in (`Object.is = …`), which
 * a test may do only for the clock and the dice (`Date.now`,
 * `Math.random`). In code that is not a test nor a test's helper: telling
 * a test run from a real one (`typeof describe`, `import.meta.vitest`,
 * `process.env.VITEST`, `NODE_ENV === "test"`, `process.argv` matched
 * against a runner, the stack read for one). `process` and the built-ins
 * are followed through aliases and casts. Each as a short label, sorted.
 * Text-level, like `reachOf`: a hold for a reader, not a sandbox.
 */
export function integrityOf(path: string, text: string): string[] {
  return [...integrityCounts(path, text).keys()].sort();
}

/** The labels whose count grew from one text to the other. */
function grown(before: Map<string, number> | null, after: Map<string, number>): string[] {
  return [...after.entries()]
    .filter(([label, count]) => count > (before?.get(label) ?? 0))
    .map(([label]) => label)
    .sort();
}

const isScriptPath = (path: string) => /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path);

/**
 * The ways to pass a test without the code that a script's new text has
 * more of than its old text (`integrityOf`), or nothing when it is no script.
 */
export function gainedIntegrity(path: string, before: string | null, after: string): string[] {
  if (!isScriptPath(path)) return [];
  return grown(before === null ? null : integrityCounts(path, before), integrityCounts(path, after));
}

/**
 * The reach a script's new text has more of than its old text did
 * (`reachOf`), or nothing when it is no script. A file that already read
 * the disk may keep doing so: only what the change adds is a question.
 */
export function gainedReach(path: string, before: string | null, after: string, context: ReachContext = {}): string[] {
  if (!isScriptPath(path)) return [];
  return grown(before === null ? null : reachCounts(path, before, context), reachCounts(path, after, context));
}

export { weakenedTest };
