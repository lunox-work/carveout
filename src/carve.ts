/**
 * The four things carveout does with a checkout: plan a slice, cut it into
 * a folder, check that the folder installs, builds and tests on its own,
 * and turn the edits made there back into a patch for the checkout.
 *
 * The plan and the cut read the checkout and never run its code. The cut
 * may fetch the published types of the packages the slice reads (install
 * scripts off, the public registry only) and resolves the folder's
 * lockfile with npm; `offline` skips both.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { command } from "./command.js";
import ts from "typescript";
import {
  BASELINE_PATH,
  HARNESS_DIR,
  LAST_RUN_PATH,
  ENV_FILE,
  ASSETS_LOADER_PATH,
  COUNTS_PATH,
  TOOL_DIRS,
  VITEST_REPORT_PATH,
  SLICE_BUDGET_DEFAULTS,
  coverageGateOf,
  testsGlobOf,
  declarationPath,
  detectExternals,
  purityRules,
  generateProject,
  isScript,
  isSecretPath,
  isTestPath,
  isPackageName,
  isRegistryVersion,
  packageNameOf,
  pathMatcher,
  renderBoundaryMarkdown,
  resolveScope,
  runtimePath,
  type BoundaryContract,
  type CoverageGate,
  type DependencyChoice,
  type GeneratedFile,
  type ImportRewrite,
  type ProjectBlocker,
  type ReachResult,
  type ResolvedDependency,
  type SliceBudget,
  type SliceManifest,
  type SliceParams,
  type SliceExternals,
  type SliceExposure,
  type SliceTestLeft,
  type SliceGraph,
  type TestRunner,
  exposureOf,
  renderTestsMarkdown,
  serviceOf,
  testRunnerOf,
  testsVerdict,
} from "./core.js";
import { analyseSlice } from "./cut.js";
import { catalogResolver } from "./project/catalog.js";
import { testRunnerResolver } from "./project/runner.js";
import {
  nearestCompilerOptions,
  workspacePackages,
} from "./extract/compiler-config.js";
import { packageModules, packageUses } from "./extract/fixture.js";
import { npmPackageTypes, typesPackageOf } from "./extract/package-types.js";
import { NODE_BUILTINS, isNodeBuiltin } from "./extract/typescript.js";
import { walkGraph, workspaceImportersOf } from "./graph.js";
import { ENVIRONMENT_PACKAGES, fileEnvironments, vitestSettings, type VitestSettings } from "./project/vitest-config.js";
import { packageRegistries } from "./extract/package-registry.js";
import {
  extensionStyles,
  packageFolder,
  restoreImports,
  specifiersOf,
  undoRewrites,
  type ImportContext,
} from "./imports.js";
import { moduleSpecifiers, parseSource } from "./specifiers.js";
import { scanSecrets, secretBlockers } from "./project/secrets.js";
import { checkRecordPaths, handoffPolicy, trustedRepo, type Refusal } from "./policy.js";
import { sandboxRun, type SandboxSpec } from "./sandbox.js";
import { configuredFolders, liveCandidates, type Readiness } from "./readiness.js";
import {
  exactToFolder,
  fromFolder,
  specifierPackages,
  toFolder,
  keptNames,
  looseLeaks,
  maskKept,
  pseudonymize,
  vocabularyBlockers,
  vocabularyLeaks,
  workspaceNames,
  ownedNames,
  workspaceVocabulary,
  type AliasRule,
  type FolderPseudonyms,
  type VocabularyLeak,
} from "./pseudonyms/index.js";
import {
  RECEIPT_SCHEMA_VERSION,
  folderRecordFor,
  folderView,
  newCutId,
  receiptPathFor,
  trustedBaseline,
  trustedCut,
  trustedCutWith,
  writeReceipt,
  type Receipt,
} from "./receipt.js";

export const CARVEOUT_VERSION = "0.4.1";
export const RECORD_PATH = "carveout.json";
export const RECORD_SCHEMA_VERSION = 1;
/** Blockers that stop a cut before it writes anything. */
const CREDENTIAL_BLOCKERS = new Set(["secret_file", "secret_found"]);
export const BOUNDARY_PATH = "BOUNDARY.md";
/** What a coding agent reads first in the folder, loaded without asking. */
export const SLICE_AGENTS_PATH = "AGENTS.md";
/** Claude Code's name for the same: it imports AGENTS.md. */
export const SLICE_CLAUDE_PATH = "CLAUDE.md";

/**
 * The folder's AGENTS.md: what an agent needs before its first command.
 * Agents in slices opened BOUNDARY.md and carveout/test.js in most runs,
 * and the README, which says this, in under half (E6c and E8 transcripts):
 * a file the agent's harness loads by itself saves those reads.
 */
export function renderSliceAgents(input: {
  readonly entryPoints: readonly string[];
  readonly testsInFolder: number;
  readonly testsLeft: number;
  /** Whether the folder carries a TASK.md: the work asked for, and when it is accepted. */
  readonly task?: boolean;
  /** Where the package's test script finds its tests, from the folder's root (`packages/core/test/*.test.ts`). */
  readonly testsAt?: string;
  /** The coverage the package's test script holds it to, which the folder's `npm test` holds added files to. */
  readonly coverage?: CoverageGate;
  /** The runner the package's own tests run on, by its test script. */
  readonly runner?: "vitest" | "node:test";
  /** The Prettier the repository formats with, at the version it locks, and the folder's copy of its settings, if any. */
  readonly prettier?: { readonly version: string; readonly config: string | null };
  /** Whether the package has a lint script, which the folder cannot run. */
  readonly lint?: boolean;
}): string {
  const tests =
    input.testsInFolder === 0
      ? "No test of this code came with the folder"
      : `${input.testsInFolder} test file(s) of this code run here, beside the folder's own interface test`;
  const left =
    input.testsLeft === 0
      ? "."
      : `; ${input.testsLeft} more stay in the repository (BOUNDARY.md names them), and a change only they would catch passes here.`;
  return `${[
    "# This folder is a slice",
    "",
    "A slice of a larger repository, cut by carveout. The source files are copied at their repository paths; every module they import from the rest of the repository is a `.d.ts` stub with a recording mock behind it.",
    "",
    `- Entry points: ${input.entryPoints.map((entry) => `\`${entry}\``).join(", ")}.`,
    "- `npm ci`, then `npm test`: it builds and runs the folder's tests. Nothing else needs setting up. npm keeps its cache in your home folder; to keep everything in this folder, run it with `--cache .npm-cache`, which the owner's patch leaves out.",
    "- Edit the copied source, and add files beside it in the same packages. The stubs, everything under `carveout/`, `package.json`, the lockfile and the root configuration are generated: edits to them do not go back.",
    "- A mock answers any call with another mock. To make one return something in a test, read the README's Mocks section; nothing else under `carveout/` needs reading.",
    "- If `carveout/baseline.json` is there, the tests it lists failed on the mocks before any edit and are not counted; with none, every test counts.",
    "- The build writes a `.js` beside each `.ts` (`.cjs` beside `.cts`, `.mjs` beside `.mts`), a new file's too: leave them. Only the source comes back, never what the build wrote from it. A type error fails the build, and so `npm test`.",
    `- ${tests}${left} A pass here is a pass against mocks.`,
    ...(input.runner === undefined
      ? []
      : [
          input.runner === "vitest"
            ? '- The package\'s tests run on Vitest: write new ones with it (`import { expect, test } from "vitest"`); `npm test` runs them as the repository does. A node:test test runs here but not in the repository.'
            : "- The package's tests run on node:test: write new ones with it (`import { test } from \"node:test\"`); `npm test` runs them as the repository does.",
        ]),
    ...(input.testsAt === undefined
      ? []
      : [
          `- New tests go where the repository's test script finds them: \`${input.testsAt}\`. A test elsewhere runs here but never in the repository, and covers nothing there.`,
        ]),
    ...(input.prettier === undefined
      ? []
      : [
          `- The repository formats with Prettier ${input.prettier.version}, ${input.prettier.config === null ? "at its defaults" : `with the settings in \`${input.prettier.config}\``}: check what you change with \`npx prettier@${input.prettier.version} --check <files>\`.${input.lint === true ? " Its lint script does not run here; the repository's CI runs it." : ""}`,
        ]),
    ...(input.coverage === undefined
      ? []
      : [
          `- The package's test script requires coverage (${coverageTerms(input.coverage)}). \`npm test\` holds each file you add under \`${input.coverage.folder}\` to it${input.coverage.allCovered === undefined ? "" : ", and fails on one no test loads"}; code you add to a file that came with the folder is not held to it here, and the repository measures it with its whole package: test it as you would a new file. \`CARVEOUT_COVERAGE=1 npm test\` prints node's coverage of every file.`,
        ]),
    "- When done, leave the edits in place: the repository's owner turns them into a patch with `carveout patch`.",
    "",
    "## What comes back, and what is held for the owner",
    "",
    "- Edits to the source files here, and new files beside them in the same packages, come back.",
    "- A test you were handed may only grow: a new test or a new assertion, a new import or a name added to one, a new helper of your own. Changing an assertion, the data or setup it rests on, or a helper or fixture you were handed; skipping or focusing a test; or mocking, spying on or rewriting the code under test is held for the owner to read.",
    "- New code may not reach what the slice does not: no new package (package.json is generated), no new disk, network, process or environment access, no code built from text (`eval`, `Function`), no module outside these packages.",
    "- If the work truly needs a package the folder does not have, say which, at which exact version, and why. Installing it here builds for you, but the owner's check runs on the cut's package.json, and the files that import it are held until the owner adds it to the repository.",
    "- No code that tells a test run from a real one, ends the run early, or rewrites the assertion library or a built-in; no new `@ts-ignore`, `eslint-disable` or coverage ignore; no edit to check or test-runner configuration.",
    "- Generated files (the stubs, everything under `carveout/`, `package.json`, the lockfile, the root configuration) do not come back: when the change needs one changed, say so.",
    ...(input.task === true ? ["", "The work asked for, and when it is accepted, is in `TASK.md`: read it first."] : []),
  ].join("\n")}\n`;
}

/** A coverage gate's thresholds, as `lines 90%, branches 90%`. */
function coverageTerms(coverage: CoverageGate): string {
  return (["lines", "branches", "functions"] as const)
    .flatMap((name) => (coverage[name] === undefined ? [] : [`${name} ${coverage[name]}%`]))
    .join(", ");
}

/**
 * The packages whose types a file's errors are about: of the packages
 * `candidate` accepts that the file imports, those whose imported names a
 * type names in the declaration around an error's line (`Pick<Stripe.
 * Customer, …>`), or anywhere in the file for an error with no line. A
 * service package imported beside one, for its values alone, is not:
 * installed, it would run against a service the folder has none of.
 */
export function packagesTypingLines(
  path: string,
  text: string,
  lines: readonly (number | null)[],
  candidate: (name: string) => boolean,
): Set<string> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, /\.[cm]?tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bindings = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (specifier.startsWith(".") || isNodeBuiltin(specifier)) continue;
    const name = packageNameOf(specifier);
    const clause = statement.importClause;
    if (!candidate(name) || clause === undefined) continue;
    if (clause.name !== undefined) bindings.set(clause.name.text, name);
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) bindings.set(named.name.text, name);
    else if (named !== undefined) for (const element of named.elements) bindings.set(element.name.text, name);
  }
  const found = new Set<string>();
  if (bindings.size === 0) return found;
  // The file's own type declarations, which a type may name in place of
  // the package's (`type Params = Anthropic.Beta.MessageCreateParams`).
  const locals = new Map<string, ts.Node>();
  for (const statement of source.statements)
    if (
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
    )
      locals.set(statement.name.text, statement);
  const followed = new Set<ts.Node>();
  /** The packages whose names a type within `node` names, through the file's own type declarations. */
  const typesIn = (node: ts.Node, inType: boolean): void => {
    const typed = inType || ts.isTypeNode(node);
    if (typed && ts.isIdentifier(node)) {
      const name = bindings.get(node.text);
      if (name !== undefined) found.add(name);
      const local = locals.get(node.text);
      if (local !== undefined && !followed.has(local)) {
        followed.add(local);
        typesIn(local, false);
      }
    }
    ts.forEachChild(node, (child) => typesIn(child, typed));
  };
  for (const line of lines) {
    if (line === null || line < 1 || line > source.getLineStarts().length) {
      typesIn(source, false);
      continue;
    }
    const at = source.getPositionOfLineAndCharacter(line - 1, 0);
    const end = source.getLineEndOfPosition(at);
    for (const statement of source.statements)
      if (statement.getStart(source) <= end && at < statement.getEnd()) typesIn(statement, false);
  }
  return found;
}

/**
 * The runner the entry points' package's tests run on, by its test script:
 * `vitest` (Vitest), `node --test` (node:test), or null when the script
 * says neither or there is none.
 */
export function packageTestRunner(repo: string, entryPoints: readonly string[]): "vitest" | "node:test" | null {
  const first = entryPoints[0];
  if (first === undefined) return null;
  const dir = packageFolder(resolve(repo))(`${first}/x`);
  try {
    const script = (JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts?.["test"];
    if (typeof script !== "string") return null;
    if (/(^|[\s;&|(])vitest(\s|$)/.test(script)) return "vitest";
    if (/(^|[\s;&|(])(node|tsx)\s+(--[\w-]+(=\S+)?\s+)*--test(\s|$)/.test(script)) return "node:test";
    return null;
  } catch {
    return null;
  }
}

/**
 * The checks a package's own scripts run (test, lint, typecheck), by the
 * scripts' names: what its CI holds a change to. Never their commands,
 * which may carry a credential (`DATABASE_URL=postgres://user:pass@…`) or
 * name the repository's tools and hosts.
 */
function packageChecks(repo: string, packageDir: string | null): string[] {
  if (packageDir === null) return [];
  try {
    const scripts =
      (JSON.parse(readFileSync(join(repo, packageDir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return Object.entries(scripts)
      .filter(([name, command]) => typeof command === "string" && /^(test|lint|typecheck|type-check|check|format:check|check-types)$/.test(name))
      .map(([name]) => name);
  } catch {
    return [];
  }
}

/** The folder's TASK.md: the work asked for, in the owner's words, and when it is accepted. */
export function renderTask(input: {
  readonly task: string;
  readonly testsInFolder: readonly string[];
  readonly surface: number;
  /** How many checks of them `npm test` makes, as its last line counts them. */
  readonly surfaceChecks?: number;
  /** The package's own check scripts, by name, for what CI checks. */
  readonly ci?: readonly string[];
  /** Where the package's test script finds its tests, from the folder's root. */
  readonly testsAt?: string;
  /** Whether the owner keeps acceptance tests of their own, which the folder does not hold. */
  readonly ownerTests?: boolean;
}): string {
  return `${[
    "# Task",
    "",
    input.task.trim(),
    "",
    "## Accepted when",
    "",
    "- `npm test` passes in this folder: the tests you write for the task, and the ones already here, but for any `carveout/baseline.json` names (they fail on the mocks before any edit).",
    ...(input.testsInFolder.length === 0
      ? []
      : [`- The ${input.testsInFolder.length} test file(s) that came with the folder still pass, and only grew.`]),
    ...(input.testsAt === undefined ? [] : [`- New tests are where the repository's test script runs them: \`${input.testsAt}\`.`]),
    ...(input.surface === 0
      ? []
      : [
          `- The ${input.surface} export(s) code outside this folder uses keep their names and types${
            input.surfaceChecks === undefined || input.surfaceChecks === 0
              ? ": `npm test` checks them, and its last line counts those checks"
              : ` (\`npm test\` makes ${input.surfaceChecks} checks of them, and its last line counts those that hold)`
          }. An addition old callers still accept (a new optional field, a new export) keeps a type.`,
        ]),
    "- The owner's \`carveout patch\` of the folder keeps nothing out (see AGENTS.md: what comes back, and what is held).",
    ...(input.ownerTests === true
      ? ["- The owner's own acceptance tests of the behaviour above, which this folder does not hold, pass on the folder that comes back."]
      : []),
    `- The repository's own CI passes once the change is merged: a pass here is a pass against mocks.${
      input.ci === undefined || input.ci.length === 0
        ? ""
        : ` For this package it runs its own ${input.ci.map((name) => `\`${name}\``).join(", ")} script${input.ci.length === 1 ? "" : "s"}; here \`npm test\` runs its tests and its build, and the rest run in the repository.`
    }`,
  ].join("\n")}\n`;
}
export const CONTRACT_PATH = "carveout/contract.json";
/** The repository owner's settings for every cut of it, at its root. */
export const CONFIG_PATH = "carveout.config.json";

/**
 * What a repository's owner sets once for every slice cut from it, in
 * `carveout.config.json` at the root: where the cut may follow and what it
 * must keep out. A flag on the command line overrides a boolean here; the
 * lists are joined. Nothing here is read from the slice folder.
 */
export interface RepoConfig {
  /** See `SliceRequest.wholePackage`. */
  readonly wholePackage?: boolean;
  /** See `SliceRequest.followWorkspaces`. */
  readonly followWorkspaces?: boolean;
  /** Paths or globs never copied; see `SliceRequest.private`. */
  readonly private?: readonly string[];
  /** Folders copied in whole beside the slice; see `CutRequest.copy`. */
  readonly copy?: readonly string[];
  /** Widen literal types in every stub; see `CutRequest.widenLiterals`. */
  readonly widenLiterals?: boolean;
  /** Every cut is for someone outside; see `CutRequest.public`. */
  readonly public?: boolean;
  /** Copy pure code rather than mock it; see `SliceRequest.copyPure`. */
  readonly copyPure?: boolean;
  /**
   * Names a public folder must not carry, beyond those carveout finds
   * (the organization's, its products', its customers'): scanned word by
   * word and given pseudonyms. See `pseudonyms/folder.ts`.
   */
  readonly names?: readonly string[];
  /**
   * Renames the owner chooses, applied to a public folder before the ones
   * carveout drafts: `{ "before": "Acme", "after": "Shop", "kind": "text" }`
   * (kind `identifier`, `text` or `path`).
   */
  readonly pseudonyms?: readonly AliasRule[];
  /** Names carveout finds that the owner lets a public folder carry (a word the code is about). */
  readonly keepNames?: readonly string[];
  /** The most lines a folder may show; see `SliceRequest.maxExposure`. */
  readonly maxExposureLines?: number;
  /** The most a folder may show, as a percent of the repository's TypeScript lines; see `SliceRequest.maxExposure`. */
  readonly maxExposurePercent?: number;
}

/** The owner's settings at the repository's root; empty when there are none. */
export function readRepoConfig(repo: string): RepoConfig {
  const path = join(repo, CONFIG_PATH);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${CONFIG_PATH} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${CONFIG_PATH} must hold an object.`);
  const record = parsed as Record<string, unknown>;
  const flag = (key: string): boolean | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean")
      throw new Error(`${CONFIG_PATH}: ${key} must be true or false.`);
    return value;
  };
  const paths = (key: string): readonly string[] | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === ""))
      throw new Error(`${CONFIG_PATH}: ${key} must be a list of paths.`);
    return value as string[];
  };
  const config: RepoConfig = {};
  const set = <K extends keyof RepoConfig>(key: K, value: RepoConfig[K]) => {
    if (value !== undefined) (config as Record<string, unknown>)[key] = value;
  };
  set("wholePackage", flag("wholePackage"));
  set("followWorkspaces", flag("followWorkspaces"));
  set("widenLiterals", flag("widenLiterals"));
  set("public", flag("public"));
  set("copyPure", flag("copyPure"));
  const positive = (key: string): number | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error(`${CONFIG_PATH}: ${key} must be a number above 0.`);
    return value;
  };
  set("maxExposureLines", positive("maxExposureLines"));
  set("maxExposurePercent", positive("maxExposurePercent"));
  set("private", paths("private"));
  set("copy", paths("copy"));
  set("names", paths("names"));
  set("keepNames", paths("keepNames"));
  const pseudonyms = record["pseudonyms"];
  if (pseudonyms !== undefined) {
    if (
      !Array.isArray(pseudonyms) ||
      pseudonyms.some(
        (rule) =>
          rule === null ||
          typeof rule !== "object" ||
          typeof (rule as Record<string, unknown>)["before"] !== "string" ||
          typeof (rule as Record<string, unknown>)["after"] !== "string" ||
          !["identifier", "text", "path"].includes(String((rule as Record<string, unknown>)["kind"] ?? "text")),
      )
    )
      throw new Error(`${CONFIG_PATH}: pseudonyms must be a list of { "before", "after", "kind" } with kind identifier, text or path.`);
    set(
      "pseudonyms",
      (pseudonyms as Record<string, unknown>[]).map((rule) => ({
        before: rule["before"] as string,
        after: rule["after"] as string,
        kind: (rule["kind"] ?? "text") as AliasRule["kind"],
        paths: [],
      })),
    );
  }
  return config;
}

/** Paths as the repository spells them, `/`-separated, unique and sorted. */
function normalizePaths(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths.map((path) =>
        path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, ""),
      ),
    ),
  ]
    .filter((path) => path !== "")
    .sort(compare);
}

/** The request with the owner's configuration applied where it says nothing. */
function settle<
  T extends SliceRequest & {
    readonly copy?: readonly string[];
    readonly widenLiterals?: boolean;
    readonly public?: boolean;
  },
>(
  request: T,
): T & {
  readonly wholePackage: boolean;
  readonly followWorkspaces: boolean;
  readonly copyPure: boolean;
  readonly private: readonly string[];
  readonly copy: readonly string[];
  readonly widenLiterals: boolean;
  readonly public: boolean;
  readonly maxExposure: { readonly lines?: number; readonly percent?: number };
} {
  const config = readRepoConfig(resolve(request.repo));
  const privatePaths = normalizePaths([...(config.private ?? []), ...(request.private ?? [])]);
  const outside = request.public ?? config.public ?? false;
  const copyPure = request.copyPure ?? config.copyPure ?? false;
  return {
    ...request,
    wholePackage: request.wholePackage ?? config.wholePackage ?? false,
    // Pure code in another package is reached through its source, so
    // copying it follows the workspaces unless told otherwise.
    followWorkspaces:
      request.followWorkspaces ?? config.followWorkspaces ?? copyPure,
    copyPure,
    private: privatePaths,
    copy: normalizePaths([...(config.copy ?? []), ...(request.copy ?? [])]),
    // A private module's constants are not for the folder: widened unless
    // the owner says otherwise.
    widenLiterals:
      request.widenLiterals ?? config.widenLiterals ?? (privatePaths.length > 0 || outside),
    public: outside,
    maxExposure: (() => {
      const lines = request.maxExposure?.lines ?? config.maxExposureLines;
      const percent = request.maxExposure?.percent ?? config.maxExposurePercent;
      return { ...(lines === undefined ? {} : { lines }), ...(percent === undefined ? {} : { percent }) };
    })(),
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

/**
 * Whether bytes are text a table may rename: no NUL in their first 8 KiB,
 * and valid UTF-8 throughout. A PDF or an archive in a copied folder is
 * not, whatever its name; decoded and written back it would be corrupted.
 */
export function isTextContent(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Assets that are not text: copied and compared as bytes. */
export function isBinaryPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav)$/i.test(
    path,
  );
}

/** `~/.carveout`, or `CARVEOUT_HOME`: where fetched package types are kept. */
export function carveoutHome(): string {
  return resolve(process.env["CARVEOUT_HOME"] ?? join(homedir(), ".carveout"));
}

export interface SliceRequest {
  /** The checkout's root: where its lockfile and workspace manifest are. */
  readonly repo: string;
  /** Files or directories, relative to the root. */
  readonly entryPoints: readonly string[];
  readonly budget?: SliceBudget;
  /** Also bring along the tests outside the slice that import it. */
  readonly tests?: boolean;
  /**
   * Include every file of the entry points' package the walk reaches, at
   * any depth, so the cut falls at package and service boundaries only.
   * Unset: as `carveout.config.json` says, else off.
   */
  readonly wholePackage?: boolean;
  /**
   * Follow an import of one of the repository's own packages into its
   * source rather than stubbing the package at the seam. Unset: as the
   * configuration says, else off.
   */
  readonly followWorkspaces?: boolean;
  /**
   * Copy the pure code the slice runs (a validator, an error class, a
   * formatter from another module or package) rather than mock it, so its
   * tests run against the real code and do not fail on the mocks before
   * any change. Follows the workspaces unless `followWorkspaces` is false.
   * The copied code is the contributor's to read. Unset: as the
   * configuration says, else off.
   */
  readonly copyPure?: boolean;
  /**
   * Paths or globs from the root that are never copied: cut and stubbed
   * wherever reached, their literal values widened. Joined with the
   * configuration's.
   */
  readonly private?: readonly string[];
  /**
   * Files the cut never reads, as if the checkout had none: the owner's
   * acceptance tests, which no folder may hold nor be shaped by (a test
   * that imports the slice would come along, or make what it imports part
   * of the public surface). Kept in the receipt for later cuts, never in
   * the folder's record.
   */
  readonly unseen?: readonly string[];
  /**
   * How much of the repository a folder may show: every line it copies
   * (entry points, tests and copied code alike, as `plan`'s "Shows" line
   * counts them), at most `lines`, and at most `percent` of the
   * repository's TypeScript lines (`.d.ts` and `node_modules` left out). A
   * cut past either is written with an `exposure_exceeded` blocker, so a
   * hand-off is not ready. Each unset: as the configuration says
   * (`maxExposureLines`, `maxExposurePercent`), else no bound.
   */
  readonly maxExposure?: { readonly lines?: number; readonly percent?: number };
}

/** A folder's lines against the owner's bound, with the repository's TypeScript lines when a percent is asked. */
export interface ExposureBudget {
  readonly lines?: number;
  readonly percent?: number;
  /** The repository's TypeScript lines, when `percent` is set. */
  readonly repositoryLines?: number;
  /** The folder's lines as a percent of them, when `percent` is set. */
  readonly shownPercent?: number;
  /** What is over, in words; null within the bound. */
  readonly over: string | null;
}

/** The repository's TypeScript source lines, as `experiments/hero-exposure.mjs` counts them: tracked `.ts`, `.tsx`, `.mts`, `.cts` files, `.d.ts` and `node_modules` left out. */
export function repositoryTypeScriptLines(repo: string): number {
  const listed = git(repo, ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"]);
  if (listed === null) return 0;
  let total = 0;
  for (const file of listed.split("\0")) {
    if (file === "" || file.endsWith(".d.ts") || file.includes("node_modules/")) continue;
    try {
      total += readFileSync(join(repo, file), "utf8").split("\n").length;
    } catch {
      // Listed but gone from the checkout.
    }
  }
  return total;
}

/** The folder's exposure against the bound the request settled on; null when there is none. */
export function exposureBudget(
  repo: string,
  exposure: SliceExposure,
  bound: { readonly lines?: number; readonly percent?: number },
): ExposureBudget | null {
  if (bound.lines === undefined && bound.percent === undefined) return null;
  const over: string[] = [];
  if (bound.lines !== undefined && exposure.lines > bound.lines)
    over.push(`it shows ${exposure.lines.toLocaleString("en-US")} lines, past the bound of ${bound.lines.toLocaleString("en-US")}`);
  let measured: { repositoryLines: number; shownPercent: number } | null = null;
  if (bound.percent !== undefined) {
    const repositoryLines = repositoryTypeScriptLines(repo);
    const shownPercent = repositoryLines === 0 ? 100 : Math.round((10_000 * exposure.lines) / repositoryLines) / 100;
    measured = { repositoryLines, shownPercent };
    if (shownPercent > bound.percent)
      over.push(`it shows ${shownPercent}% of the repository's ${repositoryLines.toLocaleString("en-US")} TypeScript lines, past the bound of ${bound.percent}%`);
  }
  return {
    ...(bound.lines === undefined ? {} : { lines: bound.lines }),
    ...(bound.percent === undefined ? {} : { percent: bound.percent }),
    ...(measured ?? {}),
    over:
      over.length === 0
        ? null
        : `${over.join(", and ")}: narrow the cut (a lower --depth, no --whole-package or --copy-pure, --private <path> for the folders plan lists), or raise maxExposureLines or maxExposurePercent in ${CONFIG_PATH}`,
  };
}

function git(repo: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString("utf8")
      .trim();
  } catch {
    return null;
  }
}

/** A file's bytes at a commit, untrimmed; null when Git has none. */
function gitShow(repo: string, commit: string, path: string): Buffer | null {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The request's entry points, `/`-separated, relative, sorted and unique. */
function entriesOf(request: SliceRequest): string[] {
  return [
    ...new Set(
      request.entryPoints.map((entry) =>
        entry
          .replaceAll("\\", "/")
          .replace(/^\.\//, "")
          .replace(/\/+$/, ""),
      ),
    ),
  ].sort(compare);
}

/**
 * The Vitest settings the entry points' package runs its tests under, when
 * the cut brings tests (`vitest-config.ts`), and the entries with its setup
 * files among them: a component's test that needs jsdom and the setup that
 * registers its matchers runs in the folder as in the repository.
 */
function withTestSetup(
  repo: string,
  entries: readonly string[],
  tests: boolean,
): { setup: string[]; settings: VitestSettings | null } {
  if (!tests) return { setup: [], settings: null };
  const packageOf = packageFolder(resolve(repo));
  const dirs = [...new Set(entries.map((entry) => packageOf(`${entry}/x`)))];
  const settings = dirs.map((dir) => vitestSettings(repo, dir)).find((found) => found !== null) ?? null;
  // Walked from, never entry points: the package, the project's name and
  // the interface test are the caller's entries' alone.
  const setup = [...(settings?.setupFiles ?? []), ...(settings?.projects ?? []).flatMap((project) => project.setupFiles)];
  return { setup: [...new Set(setup)].filter((file) => !entries.includes(file)).sort(compare), settings };
}

export interface Plan {
  readonly repo: string;
  readonly entryPoints: readonly string[];
  readonly budget: SliceBudget;
  readonly graphFiles: number;
  readonly walk: ReachResult;
  readonly externals: SliceExternals;
  /** Bare specifiers the slice imports, by package name, sorted. */
  readonly packages: readonly string[];
  /** Of those, the repository's own workspace packages, which are stubbed. */
  readonly workspacePackages: readonly string[];
  /** Files a slice never copies: credentials files it reached. */
  readonly secretFiles: readonly string[];
  /** Cut modules, sorted. */
  readonly cutModules: readonly string[];
  /** Of those, the ones the slice imports only types from. */
  readonly typeOnlyCuts: readonly string[];
  /** How the walk was bounded, after the configuration. */
  readonly wholePackage: boolean;
  readonly followWorkspaces: boolean;
  readonly copyPure: boolean;
  readonly private: readonly string[];
  /** The files and lines the cut would copy, by why each is there. */
  readonly exposure: SliceExposure;
  /** The exposure against the owner's bound; absent when none is set. */
  readonly exposureBudget?: ExposureBudget;
  /**
   * The slice's modules that code outside it imports, with the names it
   * takes (`"*"`: the whole module) and the importers, a workspace
   * package's importers by its name included: what a cut's surface check
   * holds to its types. Read from the import graph; the cut's
   * `carveout/contract.json` has the compiler's reading.
   */
  readonly surface: readonly PlanSurface[];
  /** The runner each test brought along runs on, by file. */
  readonly testRunners: Readonly<Record<string, TestRunner>>;
}

/** One module of a plan's public surface. */
export interface PlanSurface {
  readonly module: string;
  readonly names: readonly string[] | "*";
  readonly importers: readonly string[];
}

/** See `Plan.surface`. */
function surfaceOf(repo: string, walk: ReachResult, graph: SliceGraph, followWorkspaces: boolean): PlanSurface[] {
  const counted = followWorkspaces ? walk : workspaceImportersOf(repo)(walk, graph);
  const at = (from: string, specifier: string | null, location: string | null) => `${from}\n${specifier ?? ""}\n${location ?? ""}`;
  const links = new Map<string, (readonly string[] | null)[]>();
  for (const link of graph.links)
    if (link.source.startsWith("file:") && link.relation === "imports") {
      const key = at(link.source.slice("file:".length), link.specifier, link.location);
      links.set(key, [...(links.get(key) ?? []), link.names]);
    }
  const byModule = new Map<string, { names: Set<string> | "*"; importers: Set<string> }>();
  for (const edge of counted.cuts.inbound) {
    if (edge.relation !== "imports") continue;
    const entry = byModule.get(edge.to) ?? { names: new Set<string>(), importers: new Set<string>() };
    entry.importers.add(edge.from);
    const taken = links.get(at(edge.from, edge.specifier, edge.location)) ?? [null];
    for (const names of taken)
      if (names === null) entry.names = "*";
      else if (entry.names !== "*") for (const name of names) entry.names.add(name);
    byModule.set(edge.to, entry);
  }
  return [...byModule]
    .sort(([a], [b]) => compare(a, b))
    .map(([module, { names, importers }]) => ({
      module,
      names: names === "*" ? "*" : [...names].sort(compare),
      importers: [...importers].sort(compare),
    }));
}

/** The runner of each test the walk brought, as it chose it: the runner a test imports, else Vitest's globals. */
function testRunnersOf(walk: ReachResult, graph: SliceGraph): Record<string, TestRunner> {
  const specifiers = new Map<string, string[]>();
  for (const link of graph.links)
    if (link.source.startsWith("file:") && link.target.startsWith("dependency:") && link.specifier !== null) {
      const from = link.source.slice("file:".length);
      specifiers.set(from, [...(specifiers.get(from) ?? []), link.specifier]);
    }
  const globals = new Set(walk.globalsTests);
  const runners: Record<string, TestRunner> = {};
  for (const file of walk.tests) {
    const runner = globals.has(file) ? "vitest-globals" : testRunnerOf(specifiers.get(file) ?? []);
    if (runner !== null) runners[file] = runner;
  }
  return runners;
}

/** What stops a plan's cut, one line each: entry points that name nothing, imports no slice can carry, credentials files. */
export function planBlockers(plan: Plan): string[] {
  const broken = plan.walk.dependencies.filter((dependency) => dependency.status !== "external");
  const readsCut = plan.walk.cuts.outbound.filter((edge) => edge.relation === "reads");
  return [
    ...plan.walk.unknownEntryPoints.map((entry) => `${entry}: names no script file in the repository`),
    ...broken.map(
      (dependency) =>
        `${dependency.file}${dependency.location === null ? "" : `:${dependency.location.slice(1)}`}: ${dependency.status === "dynamic" ? "dynamic import of a computed name" : dependency.status === "path" ? `reads ${dependency.specifier ?? ""} by path, which a slice cannot copy` : `${dependency.specifier ?? ""} resolves to no file`}`,
    ),
    ...readsCut.map(
      (edge) => `${edge.from}${edge.location === null ? "" : `:${edge.location.slice(1)}`}: reads ${edge.to} by path, and it is outside the slice`,
    ),
    ...plan.secretFiles.map((path) => `${path}: a credentials file is never copied`),
  ];
}

/** The walk's options for a settled request. */
function walkOptions(
  request: {
    readonly tests?: boolean;
    readonly wholePackage: boolean;
    readonly followWorkspaces: boolean;
    readonly copyPure: boolean;
    readonly private: readonly string[];
  },
  repo: string,
) {
  return {
    tests: request.tests === true,
    runnerOf: testRunnerResolver(repo, packageFolder(resolve(repo))),
    ...(request.wholePackage ? { wholePackage: true } : {}),
    ...(request.followWorkspaces ? { followWorkspaces: true } : {}),
    ...(request.copyPure ? { pure: pureRulesFor(repo) } : {}),
    ...(request.private.length === 0 ? {} : { isPrivate: pathMatcher(request.private) }),
  };
}

/** `purityRules` over the repository's files. */
export function pureRulesFor(repo: string) {
  return purityRules((file) => {
    try {
      return readFileSync(join(repo, file), "utf8");
    } catch {
      return null;
    }
  }, isNodeBuiltin);
}

/** What a cut of the request would hold, from the import graph alone. */
export function planSlice(request: SliceRequest): Plan {
  const settled = settle(request);
  const repo = resolve(request.repo);
  const budget = request.budget ?? SLICE_BUDGET_DEFAULTS;
  const entryPoints = entriesOf(request);
  const { setup } = withTestSetup(repo, entryPoints, request.tests === true);
  const { built, walk } = walkGraph(repo, entryPoints, budget, {
    ...walkOptions(settled, repo),
    ...(setup.length === 0 ? {} : { roots: setup }),
    ...(request.unseen === undefined || request.unseen.length === 0 ? {} : { unseen: request.unseen }),
  });
  const texts = walk.included.map((path) => ({
    path,
    text: readFileSync(join(repo, path), "utf8"),
  }));
  const externals = detectExternals(texts);
  const textOf = new Map(texts.map(({ path, text }) => [path, text]));
  const workspaces = workspacePackages(repo);
  const packages = new Set<string>();
  for (const dependency of walk.dependencies)
    if (
      dependency.status === "external" &&
      dependency.specifier !== null &&
      !isNodeBuiltin(dependency.specifier)
    )
      packages.add(packageNameOf(dependency.specifier));
  const exposure = exposureOf(walk, (path) => textOf.get(path) ?? null);
  const budgetOf = exposureBudget(repo, exposure, settled.maxExposure);
  return {
    repo,
    entryPoints,
    budget,
    graphFiles: built.files.length,
    walk,
    externals,
    packages: [...packages].sort(compare),
    workspacePackages: [...packages]
      .filter((name) => workspaces.has(name))
      .sort(compare),
    secretFiles: walk.included.filter(isSecretPath),
    cutModules: [...new Set(walk.cuts.outbound.map((edge) => edge.to))].sort(
      compare,
    ),
    typeOnlyCuts: [
      ...new Set(walk.cuts.outbound.map((edge) => edge.to)),
    ]
      .filter((to) =>
        walk.cuts.outbound.every((edge) => edge.to !== to || edge.typeOnly),
      )
      .sort(compare),
    wholePackage: settled.wholePackage,
    followWorkspaces: settled.followWorkspaces,
    copyPure: settled.copyPure,
    private: settled.private,
    exposure,
    ...(budgetOf === null ? {} : { exposureBudget: budgetOf }),
    surface: surfaceOf(repo, walk, built.graph, settled.followWorkspaces),
    testRunners: testRunnersOf(walk, built.graph),
  };
}

export interface CutRequest extends SliceRequest {
  readonly out: string;
  /** Packages to install or to mock, overriding the default. */
  readonly choices?: Readonly<Record<string, DependencyChoice>>;
  /** No network: packages stay untyped and the folder has no lockfile. */
  readonly offline?: boolean;
  /**
   * Widen literal types in stubs (`"live"` to `string`), so no constant's
   * value from a cut module is written; for a folder handed to someone
   * outside. Off by default: the stubs then type-check as the source does.
   */
  readonly widenLiterals?: boolean;
  /**
   * Service packages kept real rather than mocked (`--live`): installed and
   * typed as the repository has them, and the environment the files that
   * import them read is left out of `carveout.env`, so the shell's values
   * or the code's own defaults apply. For a package whose tests need the
   * service itself: a database driver against a local server.
   */
  readonly live?: readonly string[];
  /**
   * Folders (or files) copied in whole beside the slice, as paths from the
   * root: what the code reads by a name the walk cannot follow, such as a
   * migrations folder. Their files are neither slice nor generated: the
   * patch carries an edit to one. Joined with the configuration's.
   */
  readonly copy?: readonly string[];
  /**
   * A folder for someone outside the repository: literals widened unless
   * asked otherwise, and the maintainer's paths left out of what is
   * written, the checkout's location and the files outside the slice that
   * import it (each named by its package folder only). Commands that need
   * the repository then take `--repo`.
   */
  readonly public?: boolean;
  /**
   * Where to write the maintainer's receipt (`receipt.ts`): a file path,
   * or false for none. By default `CARVEOUT_HOME/receipts/<cut id>.json`.
   * A public folder's own record keeps the repository's names out only
   * when there is a receipt to hold them.
   */
  readonly receipt?: string | false;
  /**
   * Keep the receipt as data only (`CutResult.receiptData`), written to no
   * file: the library's cut (`api.ts`), whose caller stores it.
   */
  readonly receiptInMemory?: boolean;
  /** Where fetched package types are kept; by default `CARVEOUT_HOME/types`. */
  readonly typesCache?: string;
  /**
   * More names a public folder must not carry (`--name`), joined with the
   * configuration's. See `pseudonyms/folder.ts`.
   */
  readonly names?: readonly string[];
  /**
   * False writes a public folder in the repository's own names (the leak
   * scan still runs). On by default for a public cut with a receipt.
   */
  readonly pseudonyms?: boolean;
  /**
   * The work asked for, in the owner's words: written to the folder's
   * TASK.md with when it is accepted (renamed with the folder in pseudonyms).
   */
  readonly task?: string;
  /**
   * An earlier cut's pseudonyms (`widen`): a term keeps the placeholder it
   * had where it still fits, so the contributor reads the same names.
   */
  readonly earlierPseudonyms?: FolderPseudonyms;
  readonly log?: (line: string) => void;
}

/** What `carveout.json` holds: the cut, and how to undo its rewrites. */
export interface CarveoutRecord {
  readonly schemaVersion: typeof RECORD_SCHEMA_VERSION;
  readonly carveoutVersion: string;
  /**
   * The cut's random id: the name of the maintainer's receipt
   * (`receipt.ts`), which holds this record as the cut made it. Absent in
   * records made before receipts.
   */
  readonly cutId?: string;
  /**
   * A public folder's record, less what names the repository beyond the
   * slice (`publicRecord`): commands that need it read the receipt.
   */
  readonly publicScrubbed?: boolean;
  /**
   * The checkout the slice was cut from, as given. Absent from a `public`
   * cut, which leaves the maintainer's paths out: commands that need the
   * repository then take `--repo`.
   */
  readonly repo?: string;
  readonly manifest: SliceManifest;
  readonly dependencies: readonly ResolvedDependency[];
  /**
   * Optional peers of the installed packages the repository installs and
   * the folder does not; `--install <name>` adds one.
   */
  readonly optionalPeers: readonly { name: string; version: string; of: string }[];
  readonly importRewrites: readonly ImportRewrite[];
  /** Files carveout wrote, by path, with their hashes; never the slice's. */
  readonly generated: readonly { path: string; sha256: string }[];
  /**
   * The slice's own files as written, imports rewritten, with their hashes:
   * what an edit since the cut is measured against (the coverage gate).
   */
  /**
   * What the folder holds of each slice file as the cut (or a later apply)
   * wrote it; `applied` marks a file a patch brought in, which no cut of
   * the repository wrote: the folder holding one is edited.
   */
  readonly copied?: readonly { path: string; sha256: string; applied?: true }[];
  /**
   * The commit a slice file's base is at, where refresh moved it on its
   * own and the record's commit stayed (an overlap elsewhere held it).
   */
  readonly bases?: Readonly<Record<string, string>>;
  readonly lockfile: boolean;
  readonly blockers: readonly {
    readonly code: string;
    readonly file: string | null;
    readonly detail: string;
  }[];
  readonly ready: boolean;
  /** What the cut was asked, so `status` can ask it again. */
  readonly request: {
    readonly entryPoints: readonly string[];
    readonly budget: SliceBudget;
    readonly choices: Readonly<Record<string, DependencyChoice>>;
    readonly offline: boolean;
    readonly widenLiterals: boolean;
    /** Absent in records made before tests could be brought along. */
    readonly tests?: boolean;
    /** Service packages kept real; absent when none. */
    readonly live?: readonly string[];
    /** The cut's bounds after the configuration; absent when off or none. */
    readonly wholePackage?: boolean;
    readonly followWorkspaces?: boolean;
    readonly copyPure?: boolean;
    readonly private?: readonly string[];
    readonly copy?: readonly string[];
    /** A folder for someone outside; see `CutRequest.public`. */
    readonly public?: boolean;
    /** The work asked for (`--task`), in the repository's names; the receipt's only. */
    readonly task?: string;
  };
  /**
   * Files copied in whole from the `copy` folders, with their hashes: not
   * the slice's, not generated, and in the patch when edited. Absent in
   * records made before folders could be copied.
   */
  readonly extras?: readonly { path: string; sha256: string }[];
  /**
   * The repository's files the cut resolved with, beyond the slice: compiler
   * and package configuration, workspace manifests and lockfiles.
   */
  readonly inputs: readonly { path: string; sha256: string | null }[];
  /**
   * The tests that run the slice's code: those in the folder, and those
   * left in the repository with the reason (a public cut names each by its
   * package). Absent in records made before the account.
   */
  readonly tests?: {
    readonly verdict: string;
    readonly carried: readonly string[];
    readonly left: readonly SliceTestLeft[];
  };
  /** What the folder shows of the repository; see `exposureOf`. */
  readonly exposure?: SliceExposure;
  /**
   * What would make the folder's tests run on real code (`readinessOf`).
   * Absent from a public cut, whose advice may name paths the folder does
   * not show, and from records made before it.
   */
  readonly readiness?: Readiness;
}

export interface CutResult {
  readonly out: string;
  readonly record: CarveoutRecord;
  readonly contract: BoundaryContract;
  /** What would make the folder's tests run on real code, public cut or not. */
  readonly readiness: Readiness;
  /** The receipt the cut wrote, or null when asked for none or kept in memory. */
  readonly receipt: string | null;
  /** The receipt as data, written or not; null when asked for none. */
  readonly receiptData: Receipt | null;
  /**
   * A public folder's pseudonyms, as the receipt keeps them (the table and
   * the kept package names); null for a cut in the repository's names.
   */
  readonly pseudonyms: FolderPseudonyms | null;
}

/**
 * What a cut could change so the folder's tests run on the repository's
 * code instead of mocks (see `readiness.ts`): the pure modules
 * `--copy-pure` would copy, read from a second walk with it on; the mocked
 * database, cache and queue clients `--live` could keep real; the folders
 * the slice's packages read by a configured name, for `--copy`. Only for a
 * cut that carries tests: a folder without them has nothing to turn green.
 */
export function readinessOf(
  request: SliceRequest & { readonly copy?: readonly string[]; readonly public?: boolean },
  record: Pick<CarveoutRecord, "manifest" | "dependencies" | "tests" | "request">,
): Readiness {
  const tests = record.tests?.carried.length ?? 0;
  if (tests === 0) return { tests, copyPure: null, live: [], copy: [] };
  const repo = resolve(request.repo);
  const included = new Set(record.manifest.included.map((file) => file.path));
  let copyPure: Readiness["copyPure"] = null;
  if (record.request.copyPure !== true) {
    const settled = settle({ ...request, copyPure: true });
    const { walk } = walkGraph(
      repo,
      entriesOf(request),
      request.budget ?? SLICE_BUDGET_DEFAULTS,
      walkOptions(settled, repo),
    );
    // What the walk with it holds and this one does not: pure code copied
    // past the depth, and the workspaces' source it follows to get there.
    // Its tests are not counted: they are a cut's `--with-tests` choice.
    const files = walk.included
      .filter((file) => !included.has(file) && !isTestPath(file) && !walk.helpers.includes(file))
      .sort(compare);
    let lines = 0;
    for (const file of files)
      try {
        lines += readFileSync(join(repo, file), "utf8").split("\n").length;
      } catch {
        // Gone since the walk: not counted.
      }
    // A budget the walk with it outgrows leaves pure code and tests out:
    // the advice says what budget holds them.
    copyPure =
      walk.dropped.length > 0
        ? { files, lines, needsMaxFiles: walk.included.length + walk.dropped.length }
        : { files, lines };
  }
  const packageOf = packageFolder(repo);
  const copied = record.request.copy ?? [];
  const held = (path: string) =>
    copied.some((dir) => path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`)) ||
    [...included].some((file) => file.startsWith(`${path}/`));
  return {
    tests,
    copyPure,
    live: liveCandidates(record.dependencies, (name) => serviceOf(name)),
    copy: configuredFolders(
      repo,
      [...included].map((file) => packageOf(file)),
      held,
    ),
  };
}

/** A name npm accepts for the folder's package. */
function projectName(repo: string | null, entries: readonly string[]): string {
  const words = [
    ...(repo === null ? [] : [basename(repo)]),
    // A public folder's name keeps each word of an entry's name apart
    // (`acme-cart`, not `acmecart`): a name the folder must not carry is
    // found, and renamed, only on its word's edges.
    ...entries.map((entry) =>
      repo === null
        ? basename(entry)
            .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1-$2")
            .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1-$2")
        : basename(entry),
    ),
  ]
    .join("-")
    .toLowerCase()
    .replace(/\.[cm]?[jt]sx?$/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${words.slice(0, 60).replace(/-$/, "") || "slice"}-carveout`;
}

export interface LockedPeer {
  readonly name: string;
  readonly version: string;
  /** The installed package whose install tree asks for it. */
  readonly of: string;
  readonly optional: boolean;
}

/** The version the repository's npm lockfile installs `name` at, at its root. */
export function lockedVersion(repo: string, name: string): string | null {
  try {
    const lock = JSON.parse(
      readFileSync(join(repo, "package-lock.json"), "utf8"),
    ) as { packages?: Record<string, { version?: unknown; link?: unknown }> };
    const entry = lock.packages?.[`node_modules/${name}`];
    return typeof entry?.version === "string" && entry.link !== true
      ? entry.version
      : null;
  } catch {
    return null;
  }
}

/**
 * A package-lock.json for the folder seeded from the repository's: every
 * package the repository installs, at the version it installs it, the
 * slice's workspaces' own installs over the root's (the first workspace
 * last, so it wins). npm keeps a seeded version that satisfies the range
 * and prunes the rest, so the folder runs what the repository runs rather
 * than what the registry has newest. Null without an npm lockfile.
 */
export function seededLockfile(
  repo: string,
  workspaces: readonly string[],
  root: Record<string, unknown>,
): Record<string, unknown> | null {
  let lock: { packages?: Record<string, Record<string, unknown>> };
  try {
    lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  } catch {
    return null;
  }
  const source = lock.packages ?? {};
  const packages: Record<string, Record<string, unknown>> = {};
  // A package resolved from a registry other than the public one keeps its
  // version, never its URL or hash: a private registry's host names whose
  // repository this is, and the folder's npm resolves from the public one.
  const publicRegistry = /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//;
  const take = (prefix: string) => {
    for (const [key, entry] of Object.entries(source)) {
      if (!key.startsWith(`${prefix}node_modules/`) || entry["link"] === true) continue;
      const resolved = entry["resolved"];
      packages[key.slice(prefix.length)] =
        typeof resolved === "string" && !publicRegistry.test(resolved)
          ? Object.fromEntries(Object.entries(entry).filter(([field]) => field !== "resolved" && field !== "integrity"))
          : entry;
    }
  };
  take("");
  for (const workspace of [...workspaces].reverse())
    if (workspace !== "") take(`${workspace}/`);
  return {
    name: root["name"],
    version: root["version"],
    lockfileVersion: 3,
    requires: true,
    packages: { "": root, ...packages },
  };
}

/**
 * Takes out of a resolved lock what npm left with nothing to install it
 * under: an entry nested under a package the lock no longer has
 * (`node_modules/vitest/node_modules/magic-string` once `vitest` went),
 * and one npm marked extraneous. npm's `--package-lock-only` marks such
 * entries rather than dropping them, and an npm other than the one that
 * resolved the lock may install them. How many it took out.
 */
export function pruneLock(lock: { packages?: Record<string, Record<string, unknown>> }): number {
  const packages = lock.packages ?? {};
  let removed = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of Object.keys(packages)) {
      if (key === "") continue;
      const at = key.lastIndexOf("/node_modules/");
      const parent = at === -1 ? null : key.slice(0, at);
      const orphan = parent !== null && parent.includes("node_modules/") && packages[parent] === undefined;
      if (orphan || packages[key]?.["extraneous"] === true) {
        delete packages[key];
        removed += 1;
        changed = true;
      }
    }
  }
  return removed;
}

/**
 * Peers of the installed packages, and of what they install, that the
 * repository's npm lockfile installs at its root for production: a
 * package the slice does not import but one it installs needs, at the
 * version the repository runs with. Optional peers are marked; the cut
 * installs only the others unless asked. Empty without a lockfile.
 */
export function lockedPeers(
  repo: string,
  installed: readonly string[],
): LockedPeer[] {
  let lock: { packages?: Record<string, Record<string, unknown>> };
  try {
    lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  } catch {
    return [];
  }
  const packages = lock.packages ?? {};
  const record = (value: unknown) =>
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  /** The lockfile key npm resolves `name` to from `from`. */
  const locate = (name: string, from: string): string | null => {
    for (let base = from; ; ) {
      const key = `${base === "" ? "" : `${base}/`}node_modules/${name}`;
      if (packages[key] !== undefined) return key;
      if (base === "") return null;
      const at = base.lastIndexOf("/node_modules/");
      base = at === -1 ? "" : base.slice(0, at);
    }
  };
  const taken = new Set(installed);
  const peers = new Map<
    string,
    { version: string; of: string; optional: boolean }
  >();
  const seen = new Set<string>();
  const queue = installed.flatMap((name) => {
    const key = locate(name, "");
    return key === null ? [] : [{ key, of: name }];
  });
  while (queue.length > 0) {
    const { key, of } = queue.shift() ?? { key: "", of: "" };
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = packages[key] ?? {};
    for (const name of Object.keys(record(entry["dependencies"]))) {
      const next = locate(name, key);
      if (next !== null) queue.push({ key: next, of });
    }
    const meta = record(entry["peerDependenciesMeta"]);
    for (const name of Object.keys(record(entry["peerDependencies"]))) {
      const optional = record(meta[name])["optional"] === true;
      const known = peers.get(name);
      if (taken.has(name) || (known !== undefined && !(known.optional && !optional)))
        continue;
      const root = packages[`node_modules/${name}`];
      const version = root?.["version"];
      if (
        typeof version !== "string" ||
        root?.["link"] === true ||
        root?.["dev"] === true
      )
        continue;
      peers.set(name, { version, of, optional });
      if (!optional) queue.push({ key: `node_modules/${name}`, of });
    }
  }
  return [...peers.entries()]
    .map(([name, peer]) => ({ name, ...peer }))
    .sort((a, b) => compare(a.name, b.name));
}

/**
 * The version the repository gives `name`: its npm lockfile's, else the
 * pin in the nearest package.json above one of `files`, else the root's.
 */
export function repositoryVersion(
  repo: string,
  name: string,
  files: readonly string[],
): string | null {
  const locked = lockedVersion(repo, name);
  if (locked !== null) return locked;
  const directories = new Set<string>([""]);
  for (const file of files)
    for (let dir = dirname(file); dir !== "." && dir !== ""; dir = dirname(dir))
      directories.add(dir);
  for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(repo, dir, "package.json"), "utf8"),
      ) as Record<string, Record<string, unknown> | undefined>;
      for (const key of ["devDependencies", "dependencies"]) {
        const version = manifest[key]?.[name];
        if (typeof version === "string") return catalogResolver(repo)(name, version);
      }
    } catch {
      // No package.json here.
    }
  }
  return null;
}

/** A cut held in memory: every file it writes, and its record but the lockfile. */
export interface ComputedCut {
  readonly files: readonly GeneratedFile[];
  /** Included files copied as bytes. */
  readonly binaries: readonly string[];
  /** The `copy` folders' files, copied as bytes; see `CarveoutRecord.extras`. */
  readonly extras: readonly string[];
  readonly record: Omit<CarveoutRecord, "generated" | "lockfile">;
  readonly contract: BoundaryContract;
}

/** The repository files a cut resolved with, by path, hashed; see `inputs`. */
function resolutionInputs(
  repo: string,
  configs: readonly string[],
): { path: string; sha256: string | null }[] {
  const paths = new Set<string>(configs);
  for (const name of [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    ".npmrc",
    CONFIG_PATH,
  ])
    paths.add(name);
  for (const directory of workspacePackages(repo).values()) {
    const rel = relative(repo, directory).replaceAll("\\", "/");
    paths.add(rel === "" ? "package.json" : `${rel}/package.json`);
  }
  return [...paths].sort(compare).map((path) => {
    const absolute = join(repo, path);
    return {
      path,
      sha256: existsSync(absolute) ? sha256(readFileSync(absolute)) : null,
    };
  });
}

/** Everything a cut writes, without writing it or resolving a lockfile. */
/** A contract whose inbound importers are named by their package only. */
function withoutOutsideImporters(
  contract: Record<string, unknown>,
  outsideName: (path: string) => string,
): Record<string, unknown> {
  const inbound = contract["inbound"];
  if (!Array.isArray(inbound)) return contract;
  return {
    ...contract,
    inbound: inbound.map((module: Record<string, unknown>) => ({
      ...module,
      importedBy: Array.isArray(module["importedBy"])
        ? [...new Set((module["importedBy"] as string[]).map(outsideName))].sort(compare)
        : module["importedBy"],
    })),
  };
}

/**
 * What a request asks of `analyseSlice`, after the owner's configuration
 * (`settle`): the walk's options, the test setup and the slice's params.
 * `computeCut` and the library's `analyse` (`api.ts`) share it, so both
 * cut the same slice of the same request.
 */
export function sliceInputOf(
  request: SliceRequest & {
    readonly copy?: readonly string[];
    readonly widenLiterals?: boolean;
    readonly public?: boolean;
    readonly live?: readonly string[];
  },
) {
  const settled = settle(request);
  const repo = resolve(request.repo);
  const budget = request.budget ?? SLICE_BUDGET_DEFAULTS;
  const entryPoints = entriesOf(request);
  const { setup, settings: vitest } = withTestSetup(repo, entryPoints, request.tests === true);
  const testRunner = request.tests === true ? packageTestRunner(repo, entryPoints) : null;
  const live = [...new Set(request.live ?? [])].sort(compare);
  const walk = {
    ...walkOptions(settled, repo),
    ...(setup.length === 0 ? {} : { roots: setup }),
    ...(request.unseen === undefined || request.unseen.length === 0 ? {} : { unseen: request.unseen }),
  };
  const params: SliceParams = {
    entryPoints,
    budget,
    tests: request.tests === true,
    ...(setup.length === 0 ? {} : { setupFiles: setup }),
    ...(testRunner === "vitest" ? { testRunner } : {}),
    ...(live.length === 0 ? {} : { live }),
    ...(settled.wholePackage ? { wholePackage: true } : {}),
    ...(settled.followWorkspaces ? { followWorkspaces: true } : {}),
    ...(settled.copyPure ? { copyPure: true } : {}),
    ...(settled.private.length === 0 ? {} : { private: settled.private }),
    ...(settled.copy.length === 0 ? {} : { copy: settled.copy }),
  };
  return { settled, repo, budget, entryPoints, setup, vitest, testRunner, live, walk, params };
}

export async function computeCut(
  request: Omit<CutRequest, "out">,
): Promise<ComputedCut> {
  const { settled, repo, budget, entryPoints, vitest, testRunner, live, walk, params } = sliceInputOf(request);
  const log = request.log ?? (() => {});
  const { built } = walkGraph(repo, entryPoints, budget, walk);
  log(`Read the imports of ${built.files.length} files.`);
  const commitSha = git(repo, ["rev-parse", "HEAD"]);
  const signal = AbortSignal.timeout(15 * 60_000);
  const workspaces = workspacePackages(repo);
  const analysis = await analyseSlice({
    sourceDir: repo,
    graph: built.graph,
    params,
    source: {
      commitSha,
      isDirty: (paths) =>
        commitSha !== null &&
        (git(repo, ["status", "--porcelain", "--", ...paths]) ?? "") !== "",
    },
    signal,
    log,
    widenLiterals: settled.widenLiterals,
    ...(request.offline === true
      ? {}
      : {
          packageTypes: npmPackageTypes({
            root: request.typesCache ?? join(carveoutHome(), "types"),
          }),
        }),
  });
  const { contract, contractJson } = analysis;
  // What the folder copies that the commit does not hold as it is: the
  // owner's work in progress, which goes out as the working tree has it.
  if (analysis.manifest.sourceDirty) {
    const paths = analysis.manifest.included.map((file) => file.path);
    const uncommitted = (git(repo, ["status", "--porcelain", "--", ...paths]) ?? "")
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((path) => path !== "");
    if (uncommitted.length > 0)
      log(
        `Copies ${uncommitted.length} file(s) the commit does not hold as they are (the working tree's, uncommitted): ${uncommitted.slice(0, 8).join(", ")}${uncommitted.length > 8 ? `, and ${uncommitted.length - 8} more` : ""}. Commit them, or keep one out with --private, before the folder goes out.`,
      );
  }
  // A public folder names a file outside the slice only by its package.
  const outsideName = (() => {
    const packageOf = packageFolder(repo);
    return (path: string) => {
      const pkg = packageOf(path);
      return `${pkg === "" ? "" : `${pkg}/`}(outside the slice)`;
    };
  })();
  // The tests left in the repository, named as the folder may name them.
  const testsLeft = analysis.walk.testsLeft.map(({ file, reason, imports }) => ({
    file: settled.public ? outsideName(file) : file,
    reason,
    // The slice's own files it imports, which the folder shows anyway.
    ...(imports === undefined ? {} : { imports }),
  }));
  const manifest: SliceManifest = settled.public
    ? {
        ...analysis.manifest,
        cuts: {
          ...analysis.manifest.cuts,
          inbound: analysis.manifest.cuts.inbound.map((edge) => ({
            ...edge,
            from: outsideName(edge.from),
          })),
        },
      }
    : analysis.manifest;
  // A live package is installed, whatever the default for its service.
  const choices: Record<string, DependencyChoice> = {
    ...request.choices,
    ...Object.fromEntries(live.map((name) => [name, "approved-package" as const])),
  };
  // The environment the package's Vitest tests run in, installed as the
  // repository locks it (`jsdom` for a component's tests).
  // So is the one a carried test asks for itself (`// @vitest-environment
  // happy-dom`), and a package the config's setupFiles name by specifier
  // (`@testing-library/jest-dom/vitest`).
  const environments = new Set([
    ...(vitest?.environment === undefined ? [] : [vitest.environment]),
    ...(vitest?.projects ?? []).flatMap((project) => (project.environment === undefined ? [] : [project.environment])),
    ...analysis.walk.tests.flatMap((test) => {
      try {
        return fileEnvironments(readFileSync(join(repo, test), "utf8"));
      } catch {
        return [];
      }
    }),
  ]);
  for (const environment of [...environments].sort(compare))
    for (const name of ENVIRONMENT_PACKAGES[environment] ?? [])
      if (choices[name] === undefined && lockedVersion(repo, name) !== null) {
        choices[name] = "approved-package";
        log(`Installs ${name}: the package's Vitest tests run in the ${environment} environment.`);
      }
  for (const specifier of [...(vitest?.setupPackages ?? []), ...(vitest?.projects ?? []).flatMap((project) => project.setupPackages ?? [])]) {
    const name = packageNameOf(specifier);
    if (choices[name] === undefined && lockedVersion(repo, name) !== null) {
      choices[name] = "approved-package";
      log(`Installs ${name}: the package's Vitest setup runs ${specifier}.`);
    }
  }
  // So is a package whose class a carried test patches by its prototype
  // (`S3Client.prototype.send = ...`): a mock has no prototype to patch, so
  // the test fails on the mock before any change (E6c: 30 such tests).
  // The test never reaches the service; it replaces the call that would.
  // The packages of its scope the slice imports beside it come too: they
  // work on the real client (`@aws-sdk/s3-request-presigner` signs with
  // the client's own middleware), and a mock of one answers with a mock.
  if (request.tests === true) {
    const imported = new Set(
      manifest.requiredBuildInputs.packages
        .filter((item) => item.workspace !== true)
        .map((item) => item.name),
    );
    for (const [name, cls] of prototypePatchedPackages(
      manifest.included
        .filter((file) => isTestPath(file.path) && isScript(file.path))
        .map((file) => ({ path: file.path, text: readFileSync(join(repo, file.path), "utf8") })),
      new Set(workspaces.keys()),
    )) {
      const scope = name.startsWith("@") ? `${name.split("/")[0] ?? ""}/` : null;
      const together = [
        name,
        ...(scope === null
          ? []
          : [...imported].filter((other) => other !== name && other.startsWith(scope)).sort(compare)),
      ];
      for (const each of together)
        if (choices[each] === undefined) {
          choices[each] = "approved-package";
          log(
            each === name
              ? `Installs ${name}: a test patches ${cls}.prototype, which a mock does not have.`
              : `Installs ${each} with it: a package of the same scope, for the real ${cls}.`,
          );
        }
    }
  }
  // And a package whose class the slice's code tests with `instanceof`
  // (`error instanceof Anthropic.APIError`): a mock is typed `any`, so the
  // test narrows nothing, the code reading the narrowed value does not
  // compile, and the folder's build fails where the cut said ready. The
  // real class narrows, and is never called.
  for (const [name, cls] of instanceofPackages(
    manifest.included
      .filter((file) => isScript(file.path))
      .map((file) => ({ path: file.path, text: readFileSync(join(repo, file.path), "utf8") })),
    new Set(workspaces.keys()),
  ))
    if (choices[name] === undefined) {
      choices[name] = "approved-package";
      log(`Installs ${name}: the code tests a value with instanceof ${cls}, which a mock cannot narrow.`);
    }
  // And a service package the code's own types are built from: the check
  // with the packages untyped failed in a file that imports it (a
  // `Pick<Params, …>` of an SDK's type demands what the real type leaves
  // optional). The cut counted that error as the untyped packages' cost,
  // which installing them pays; mocked, the package would stay untyped and
  // the folder's build would fail where the cut said ready.
  const untypedLines = new Map<string, (number | null)[]>();
  for (const diagnostic of contract.compilation.untypedPackageErrors ?? [])
    if (diagnostic.file !== undefined && diagnostic.file !== null)
      untypedLines.set(String(diagnostic.file), [...(untypedLines.get(String(diagnostic.file)) ?? []), diagnostic.line]);
  const typedBy = new Map<string, string>();
  for (const file of manifest.included) {
    const lines = untypedLines.get(file.path);
    if (lines === undefined || !isScript(file.path)) continue;
    const candidate = (name: string) => serviceOf(name) !== null && !workspaces.has(name) && isPackageName(name);
    for (const name of packagesTypingLines(file.path, readFileSync(join(repo, file.path), "utf8"), lines, candidate))
      if (!typedBy.has(name)) typedBy.set(name, file.path);
  }
  // Never one from a private registry: installing it is what the cut
  // refuses (the folder's npm reads the public one), so it stays mocked.
  const registry = packageRegistries(repo);
  for (const [name, file] of [...typedBy].sort(([a], [b]) => compare(a, b)))
    if (choices[name] === undefined && registry(name)?.source !== "private" && repositoryVersion(repo, name, [file]) !== null) {
      choices[name] = "approved-package";
      log(`Installs ${name}: ${file} does not compile with it mocked; its types are the code's.`);
    }
  const scope = resolveScope({
    manifest,
    contract,
    ...(Object.keys(choices).length === 0 ? {} : { choices }),
  });
  // The environment the live packages' importers read stays the shell's.
  const liveFiles = new Set(
    manifest.externals.packages
      .filter((item) => live.includes(packageNameOf(item.specifier)))
      .flatMap((item) => item.files),
  );
  const liveEnvironment = manifest.externals.environment
    .filter((item) => item.files.some((file) => liveFiles.has(file)))
    .map((item) => item.name);
  // Images, fonts and media are copied byte for byte, beside the sources.
  const binaries = manifest.included
    .map((file) => file.path)
    .filter(isBinaryPath);
  const sources = manifest.included
    .filter((file) => !isBinaryPath(file.path))
    .map((file) => ({
      originalPath: file.path,
      path: file.path,
      text: readFileSync(join(repo, file.path), "utf8"),
    }));
  const stubs = analysis.stubs.map((stub) => ({
    module: stub.module,
    path: stub.module,
    text: stub.text,
  }));
  const packageNames = new Set(
    scope.dependencies
      .filter((dependency) => dependency.kind === "package")
      .map((dependency) => dependency.name),
  );
  const installed = new Set(
    scope.dependencies
      .filter(
        (dependency) =>
          dependency.kind === "package" &&
          dependency.resolution === "approved-package",
      )
      .map((dependency) => dependency.name),
  );
  const includedPaths = manifest.included.map((file) => file.path);
  const nodeTypes = sources.some((source) =>
    moduleSpecifiers(source.path, source.text).some((literal) =>
      isNodeBuiltin(literal.specifier),
    ),
  ) ? repositoryVersion(repo, "@types/node", includedPaths) : null;
  const uses = packageUses(
    new Map([...sources, ...stubs].map((file) => [file.path, file.text])),
    (specifier) =>
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      (packageNames.has(packageNameOf(specifier)) ||
        (nodeTypes === null && isNodeBuiltin(specifier))),
  );
  const first = manifest.included[0]?.path;
  const compilerOptions =
    first === undefined ? undefined : nearestCompilerOptions(repo, first);
  // The coverage the entry points' package test requires, carried into the
  // folder's `npm test`.
  const packageDir =
    entryPoints[0] === undefined ? null : packageFolder(repo)(`${entryPoints[0]}/`);
  let coverage: CoverageGate | null = null;
  // Where the package's test script finds its tests, when it names them.
  let testsAt: string | undefined;
  if (packageDir !== null)
    try {
      const script = (
        JSON.parse(readFileSync(join(repo, packageDir, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts?.["test"];
      if (typeof script === "string") {
        coverage = coverageGateOf(packageDir, script);
        // node:test's glob says where its tests go; a package whose tests
        // run on Vitest takes Vitest's include (another runner's glob in
        // the same script, `node --test scripts/*.cjs`, is not theirs).
        const glob = testsGlobOf(script);
        if (testRunner === "vitest") {
          const include = vitest?.include?.[0];
          if (include !== undefined) testsAt = include;
        } else if (glob !== undefined) testsAt = posix.join(packageDir, glob);
      }
    } catch {
      // No readable package.json: no gate.
    }
  const project = generateProject({
    // A public folder names neither the checkout's path nor its folder.
    origin: settled.public
      ? { repository: null, name: projectName(null, entryPoints) }
      : { repository: basename(repo), name: projectName(repo, entryPoints) },
    manifest,
    contract,
    sources,
    stubs,
    surface: analysis.surface,
    dependencies: scope.dependencies,
    knownSpecifiers: NODE_BUILTINS,
    packageModules: packageModules(uses, (specifier) =>
      installed.has(packageNameOf(specifier)),
    ),
    ...(compilerOptions === undefined ? {} : { compilerOptions }),
    ...(coverage === null ? {} : { coverage }),
    ...(live.length === 0 ? {} : { live, liveEnvironment }),
    keepsImplicitAny: analysis.keepsImplicitAny,
    implicitAnyFiles: analysis.implicitAnyFiles,
    ...(vitest === null ? {} : { vitest }),
    ...(testRunner === "vitest" ? { testRunner } : {}),
    hasNodeTypes: nodeTypes !== null,
  });
  // Peers the installed packages need, and packages asked for by name
  // that the slice does not import, as the repository installs them.
  const required = new Set(
    manifest.requiredBuildInputs.packages.map((item) => item.name),
  );
  const asked = Object.entries(choices)
    .filter(
      ([name, choice]) => choice === "approved-package" && !required.has(name),
    )
    .map(([name]) => {
      const version = lockedVersion(repo, name);
      if (version === null)
        throw new Error(
          `--install ${name}: the slice does not import it and the repository's package-lock.json does not install it.`,
        );
      return { name, version, of: "", optional: false };
    });
  // The automatic JSX runtime imports its package without the source
  // naming it: `react/jsx-runtime` under `"jsx": "react-jsx"`.
  const jsx = String(compilerOptions?.["jsx"] ?? "").toLowerCase();
  const jsxSource =
    (jsx === "react-jsx" || jsx === "react-jsxdev") &&
    manifest.included.some((file) => /\.[jt]sx$/.test(file.path))
      ? String(compilerOptions?.["jsxImportSource"] ?? "react")
      : null;
  if (
    jsxSource !== null &&
    !installed.has(jsxSource) &&
    !asked.some((item) => item.name === jsxSource)
  ) {
    const version = repositoryVersion(
      repo,
      jsxSource,
      manifest.included.map((file) => file.path),
    );
    if (version !== null)
      asked.push({ name: jsxSource, version, of: "", optional: false });
  }
  const allPeers = lockedPeers(repo, [
    ...installed,
    ...asked.map((item) => item.name),
  ]);
  const optionalPeers = allPeers.filter(
    (peer) => peer.optional && !asked.some((item) => item.name === peer.name),
  );
  const peers = [
    ...allPeers.filter((peer) => !peer.optional),
    ...asked,
  ].sort((a, b) => compare(a.name, b.name));
  const dependencies: ResolvedDependency[] = [
    ...scope.dependencies,
    ...peers.map((peer) => ({
      name: peer.name,
      kind: "package" as const,
      version: peer.version,
      resolution: "approved-package" as const,
      detail:
        peer.of === ""
          ? "Installed at the version the repository's lockfile installs, as asked."
          : `Installed as the repository installs it: a peer of what ${peer.of} installs.`,
    })),
  ].sort((a, b) => compare(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`));
  // The types of what the folder installs, where the repository pins
  // them, so it compiles against what the repository compiles against.
  const typesPackages = [
    ...new Set(
      dependencies
        .filter(
          (dependency) =>
            dependency.kind === "package" &&
            dependency.resolution === "approved-package" &&
            !dependency.name.startsWith("@types/"),
        )
        .map((dependency) => typesPackageOf(dependency.name)),
    ),
  ]
    .filter((name) => !dependencies.some((dependency) => dependency.name === name))
    .flatMap((name) => {
      const version = repositoryVersion(repo, name, includedPaths);
      return version === null ? [] : [{ name, version }];
    })
    .sort((a, b) => compare(a.name, b.name));
  // Node's own types, at the repository's version, when the slice's
  // sources import a Node built-in: untyped, `assert.ok` narrows nothing
  // and `import.meta.url` is unknown, so the folder would not type-check
  // as the repository does.
  if (
    nodeTypes !== null &&
    !typesPackages.some((types) => types.name === "@types/node")
  )
    typesPackages.push({ name: "@types/node", version: nodeTypes });
  // The compiler the repository builds with, so the folder's build passes
  // and fails as the repository's does; the tool's own without one.
  const compiler = repositoryVersion(repo, "typescript", includedPaths);
  if (compiler !== null) log(`Compiles with typescript@${compiler}, as the repository does.`);
  const sorted = (record: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(record).sort(([a], [b]) => compare(a, b)),
    );
  // A repository on pnpm or Yarn installs a peer range that does not
  // match as a warning; npm refuses the whole tree. The folder resolves as
  // the repository's own manager does (E8g: n8n's vitest-mock-extended asks
  // TypeScript 6 of a repository on 7). An npm repository stays strict.
  const peerLenient =
    !existsSync(join(repo, "package-lock.json")) &&
    !existsSync(join(repo, "npm-shrinkwrap.json")) &&
    (existsSync(join(repo, "pnpm-lock.yaml")) || existsSync(join(repo, "yarn.lock")));
  const projectFiles = project.files.map((file) => {
    if (file.path === ".npmrc" && peerLenient)
      return { ...file, text: `${file.text}legacy-peer-deps=true\n` };
    if (file.path === "tsconfig.json" && nodeTypes !== null) {
      const config = JSON.parse(file.text) as {
        compilerOptions: Record<string, unknown>;
      };
      const types = config.compilerOptions["types"];
      config.compilerOptions["types"] = [
        ...new Set(["node", ...(Array.isArray(types) ? (types as string[]) : [])]),
      ];
      return { ...file, text: `${JSON.stringify(config, null, 2)}\n` };
    }
    if (
      file.path !== "package.json" ||
      (peers.length + typesPackages.length === 0 && compiler === null)
    )
      return file;
    const manifestJson = JSON.parse(file.text) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    if (compiler !== null) manifestJson.devDependencies["typescript"] = compiler;
    for (const peer of peers)
      manifestJson.dependencies[peer.name] ??= peer.version;
    for (const types of typesPackages)
      manifestJson.devDependencies[types.name] ??= types.version;
    manifestJson.dependencies = sorted(manifestJson.dependencies);
    manifestJson.devDependencies = sorted(manifestJson.devDependencies);
    return { ...file, text: `${JSON.stringify(manifestJson, null, 2)}\n` };
  });
  if (typesPackages.length > 0)
    log(`Types installed: ${typesPackages.map((types) => types.name).join(", ")}.`);
  if (peers.length > 0)
    log(`Also installed: ${peers.map((peer) => peer.name).join(", ")}.`);
  // The formatter the repository's code is held to, when it is Prettier
  // with settings a file states (not a script, which may load plugins).
  const prettierVersion = lockedVersion(repo, "prettier");
  // Only its formatting options, as JSON: plugins and overrides name other
  // parts of the repository, and a config that is no JSON is left behind.
  const PRETTIER_OPTIONS = new Set([
    "printWidth", "tabWidth", "useTabs", "semi", "singleQuote", "quoteProps", "jsxSingleQuote", "trailingComma",
    "bracketSpacing", "bracketSameLine", "objectWrap", "arrowParens", "endOfLine", "proseWrap",
    "htmlWhitespaceSensitivity", "singleAttributePerLine", "experimentalTernaries", "experimentalOperatorPosition",
  ]);
  const prettierConfig = (() => {
    if (prettierVersion === null) return null;
    for (const dir of [...new Set([packageDir ?? "", ""])])
      for (const name of [".prettierrc", ".prettierrc.json"]) {
        const at = join(repo, dir, name);
        if (!existsSync(at) || !statSync(at).isFile()) continue;
        try {
          const parsed = JSON.parse(readFileSync(at, "utf8")) as Record<string, unknown>;
          const kept = Object.fromEntries(
            Object.entries(parsed).filter(([key, value]) => PRETTIER_OPTIONS.has(key) && ["string", "number", "boolean"].includes(typeof value)),
          );
          return { name: ".prettierrc.json", text: `${JSON.stringify(kept, null, 2)}\n` };
        } catch {
          return null;
        }
      }
    return null;
  })();
  const extra: GeneratedFile[] = [
    ...(prettierConfig === null ? [] : [{ path: prettierConfig.name, text: prettierConfig.text, class: "config" as const, public: true }]),
    {
      path: SLICE_AGENTS_PATH,
      text: renderSliceAgents({
        entryPoints: manifest.entryPoints,
        testsInFolder: analysis.walk.tests.length,
        testsLeft: testsLeft.length,
        ...(request.task === undefined || request.task.trim() === "" ? {} : { task: true }),
        ...(testsAt === undefined ? {} : { testsAt }),
        ...(coverage === null ? {} : { coverage }),
        ...(testRunner === null ? {} : { runner: testRunner }),
        ...(prettierVersion === null ? {} : { prettier: { version: prettierVersion, config: prettierConfig?.name ?? null } }),
        ...(packageChecks(repo, packageDir).includes("lint") ? { lint: true } : {}),
      }),
      class: "config",
      public: true,
    },
    ...(request.task === undefined || request.task.trim() === ""
      ? []
      : [
          {
            path: "TASK.md",
            text: renderTask({
              task: request.task,
              testsInFolder: analysis.walk.tests,
              surface: contract.inbound.reduce((sum, module) => sum + module.symbols.length, 0),
              // As npm test's last line will count them: one per export
              // whose type is held, and one per module it imports.
              surfaceChecks:
                (project.files.find((file) => file.path === "carveout/surface/check.ts")?.text.match(/ \/\/ .+ \| .+ \| (value|type)$/gm)?.length ?? 0) +
                (project.files.find((file) => file.path === "carveout/tests/interface.test.ts")?.text.match(/^test\(/gm)?.length ?? 0),
              ci: packageChecks(repo, packageDir),
              ...(testsAt === undefined ? {} : { testsAt }),
              ...(request.unseen === undefined || request.unseen.length === 0 ? {} : { ownerTests: true }),
            }),
            class: "config" as const,
            public: true,
          },
        ]),
    { path: SLICE_CLAUDE_PATH, text: "@AGENTS.md\n", class: "config", public: true },
    {
      path: BOUNDARY_PATH,
      // What the folder's tests can say comes before what it stubs: a pass
      // here is worth what the tests in it run.
      text: renderBoundaryMarkdown(contract, manifest).replace(
        "## Stubbed modules",
        `${renderTestsMarkdown({ tests: analysis.walk.tests, testsLeft }, (path) => path).join("\n")}\n## Stubbed modules`,
      ),
      class: "config",
      public: true,
    },
    {
      path: CONTRACT_PATH,
      text: `${JSON.stringify(
        settled.public
          ? withoutOutsideImporters(withoutCommit(JSON.parse(contractJson)), outsideName)
          : withoutCommit(JSON.parse(contractJson)),
        null,
        2,
      )}\n`,
      class: "config",
      public: true,
    },
  ];
  const files = [...projectFiles, ...extra];
  // The folder's own documents leave the repository too, the owner's task
  // text among them: scanned as everything else the cut writes is.
  const documentBlockers = secretBlockers(scanSecrets(extra)).map(({ code, file, detail }) => ({ code, file: file ?? null, detail }));
  // The `copy` folders, file by file, less what the slice already holds
  // and any credentials file, which stays behind and blocks the cut.
  const held = new Set([
    ...files.map((file) => file.path),
    ...binaries,
  ]);
  const extras: string[] = [];
  const extraBlockers: { code: string; file: string | null; detail: string }[] = [];
  for (const dir of settled.copy) {
    const absolute = join(repo, dir);
    if (!existsSync(absolute))
      throw new Error(`copy ${dir}: the repository has no such file or folder.`);
    const paths = statSync(absolute).isDirectory()
      ? listTree(absolute).map((path) => `${dir}/${path}`)
      : [dir];
    for (const path of paths.sort(compare)) {
      if (held.has(path)) continue;
      if (isSecretPath(path)) {
        extraBlockers.push({
          code: "secret_file",
          file: path,
          detail: `${path} is a credentials file; it is not copied with ${dir}.`,
        });
        continue;
      }
      held.add(path);
      extras.push(path);
    }
  }
  if (extras.length > 0)
    log(`Copies ${extras.length} file(s) from ${settled.copy.join(", ")} beside the slice.`);
  // A copied folder leaves the repository as it is: scan it like
  // everything else the cut writes.
  extraBlockers.push(
    ...secretBlockers(
      scanSecrets(
        extras
          .filter((path) => !isBinaryPath(path))
          .map((path) => ({ path, text: readFileSync(join(repo, path), "utf8") })),
      ),
    ).map(({ code, file, detail }) => ({ code, file: file ?? null, detail })),
  );
  const exposure = exposureOf(analysis.walk, (path) => {
    try {
      return readFileSync(join(repo, path), "utf8");
    } catch {
      return null;
    }
  });
  // Past the owner's bound on what a folder may show: written, never ready.
  const overExposed = exposureBudget(repo, exposure, settled.maxExposure)?.over ?? null;
  const blockers: CarveoutRecord["blockers"] = [
    ...(overExposed === null ? [] : [{ code: "exposure_exceeded", file: null, detail: `The folder shows more of the repository than the owner allows: ${overExposed}.` }]),
    ...manifest.blockers.map(({ code, file, detail }) => ({
      code,
      file,
      detail,
    })),
    ...extraBlockers,
    ...documentBlockers,
    ...scope.blockers
      .filter((blocker) => blocker.code === "dependency_unresolved")
      .map(({ code, detail }) => ({ code, file: null, detail })),
    ...project.blockers.map(({ code, file, detail }: ProjectBlocker) => ({
      code,
      file,
      detail,
    })),
  ];
  return {
    files,
    binaries,
    extras,
    contract,
    record: {
      schemaVersion: RECORD_SCHEMA_VERSION,
      carveoutVersion: CARVEOUT_VERSION,
      ...(settled.public ? {} : { repo }),
      manifest,
      dependencies: [
        ...dependencies,
        ...typesPackages.map((types) => ({
          name: types.name,
          kind: "package" as const,
          version: types.version,
          resolution: "approved-package" as const,
          detail: "The types of an installed package, at the version the repository pins.",
        })),
      ].sort((a, b) => compare(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`)),
      optionalPeers: optionalPeers.map(({ name, version, of }) => ({
        name,
        version,
        of,
      })),
      importRewrites: project.importRewrites,
      blockers,
      ready: analysis.ready && blockers.length === 0,
      request: {
        entryPoints,
        budget,
        choices: request.choices ?? {},
        offline: request.offline === true,
        widenLiterals: settled.widenLiterals,
        tests: request.tests === true,
        ...(live.length === 0 ? {} : { live }),
        ...(settled.wholePackage ? { wholePackage: true } : {}),
        ...(settled.followWorkspaces ? { followWorkspaces: true } : {}),
        ...(settled.copyPure ? { copyPure: true } : {}),
        ...(settled.private.length === 0 ? {} : { private: settled.private }),
        ...(settled.copy.length === 0 ? {} : { copy: settled.copy }),
        ...(settled.public ? { public: true } : {}),
        ...(request.task === undefined || request.task.trim() === "" ? {} : { task: request.task }),
      },
      inputs: resolutionInputs(repo, manifest.requiredBuildInputs.configs),
      tests: {
        verdict: testsVerdict(analysis.walk),
        carried: analysis.walk.tests,
        left: testsLeft,
      },
      exposure,
    },
  };
}

/**
 * The packages whose classes the tests patch by prototype, by package name
 * with one such class: `import { S3Client } from "@aws-sdk/client-s3"` and
 * `S3Client.prototype` in the same file. The repository's own packages are
 * not among them; a type import is not either.
 */
function prototypePatchedPackages(
  sources: readonly { path: string; text: string }[],
  workspaces: ReadonlySet<string>,
): Map<string, string> {
  const found = new Map<string, string>();
  for (const source of sources) {
    if (!/\.prototype\b/.test(source.text)) continue;
    const parsed = parseSource(source.path, source.text);
    for (const statement of parsed.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        isNodeBuiltin(specifier)
      )
        continue;
      const clause = statement.importClause;
      if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword)
        continue;
      const names: string[] = [];
      if (clause.name !== undefined) names.push(clause.name.text);
      if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          if (!element.isTypeOnly) names.push(element.name.text);
      const name = packageNameOf(specifier);
      if (workspaces.has(name) || found.has(name) || !isPackageName(name)) continue;
      for (const binding of names)
        if (new RegExp(`\\b${binding.replace(/\$/g, "\\$")}\\.prototype\\b`).test(source.text)) {
          found.set(name, binding);
          break;
        }
    }
  }
  return found;
}

/**
 * The packages whose classes the code tests with `instanceof`, by package
 * name with the class as written: `import Anthropic from
 * "@anthropic-ai/sdk"` and `instanceof Anthropic.APIError` in the same
 * file, or a named or namespace import on the right of one. The
 * repository's own packages and Node's are not among them.
 */
export function instanceofPackages(
  sources: readonly { path: string; text: string }[],
  workspaces: ReadonlySet<string>,
): Map<string, string> {
  const found = new Map<string, string>();
  for (const source of sources) {
    if (!/\binstanceof\b/.test(source.text)) continue;
    const parsed = parseSource(source.path, source.text);
    const bindings = new Map<string, string>();
    for (const statement of parsed.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        isNodeBuiltin(specifier)
      )
        continue;
      const name = packageNameOf(specifier);
      if (workspaces.has(name) || !isPackageName(name)) continue;
      const clause = statement.importClause;
      if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword)
        continue;
      if (clause.name !== undefined) bindings.set(clause.name.text, name);
      const named = clause.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named))
        bindings.set(named.name.text, name);
      else if (named !== undefined)
        for (const element of named.elements)
          if (!element.isTypeOnly) bindings.set(element.name.text, name);
    }
    if (bindings.size === 0) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      ) {
        let root: ts.Expression = node.right;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        const name = ts.isIdentifier(root) ? bindings.get(root.text) : undefined;
        if (name !== undefined && !found.has(name))
          found.set(name, node.right.getText(parsed));
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return found;
}

/** The contract as the folder holds it: its commit is in carveout.json. */
function withoutCommit(contract: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...contract };
  delete copy["sourceCommitSha"];
  return copy;
}

export async function cutSlice(request: CutRequest): Promise<CutResult> {
  const repo = resolve(request.repo);
  const out = resolve(request.out);
  const log = request.log ?? (() => {});
  if (existsSync(out) && readdirSync(out).length > 0)
    throw new Error(`${out} is not empty; give an empty or new folder.`);
  if (out === repo)
    throw new Error("The output folder cannot be the repository itself.");
  const { files, binaries, extras, record: computed, contract } = await computeCut(request);
  // A credential never leaves the repository: with one found, nothing is
  // written, not even a folder with blockers.
  const credentials = computed.blockers.filter((blocker) =>
    CREDENTIAL_BLOCKERS.has(blocker.code),
  );
  if (credentials.length > 0)
    throw new Error(
      `Nothing written: the cut would carry a credential.\n${credentials
        .map((blocker) => `  ${blocker.code}${blocker.file === null ? "" : ` ${blocker.file}`}: ${blocker.detail}`)
        .join("\n")}\nOr keep a file out of the slice: ${[
        ...new Set(credentials.flatMap((blocker) => (blocker.file === null ? [] : [`--private ${blocker.file}`]))),
      ].join(" ")}`,
    );
  const fresh = !existsSync(out);
  const cutId = newCutId();
  // Whether the cut keeps a receipt, and the file it goes to (none in memory).
  const keepsReceipt = request.receipt !== false;
  const receipt = !keepsReceipt || request.receiptInMemory === true ? null : resolve(request.receipt ?? receiptPathFor(cutId));
  // The receipt holds what the folder must not: never inside it, nor in
  // the checkout, where a commit could carry it.
  if (receipt !== null && [out, repo].some((dir) => receipt === dir || receipt.startsWith(`${dir}${sep}`)))
    throw new Error(`--receipt ${receipt}: the receipt cannot be kept in the folder or the repository; name a file elsewhere.`);
  // A public folder is written in pseudonyms (pseudonyms/folder.ts): the
  // names the repository goes by, hidden under a table only the receipt
  // keeps. Without a receipt there is nowhere to keep it: the names stay,
  // and the scan says where.
  const config = readRepoConfig(repo);
  const publicCut = computed.request.public === true;
  const textExtras = extras.filter((path) => !isBinaryPath(path) && isTextContent(readFileSync(join(repo, path))));
  const binaryPaths = [...binaries, ...extras.filter((path) => !textExtras.includes(path))];
  const extraText = new Map(textExtras.map((path) => [path, readFileSync(join(repo, path), "utf8")]));
  let table: FolderPseudonyms | null = null;
  let pathOf = (path: string) => path;
  let folderText = (_path: string, text: string) => text;
  let leaks: VocabularyLeak[] = [];
  let leakScan: { vocabulary: string[]; kept: string[] } | null = null;
  if (publicCut) {
    const packageOf = packageFolder(repo);
    const kept = new Set((config.keepNames ?? []).map((name) => workspaceVocabulary([name])[0] ?? name.toLowerCase()));
    const names = workspaceNames(
      repo,
      [...new Set(computed.manifest.included.map((file) => packageOf(file.path)))],
      [...(config.names ?? []), ...(request.names ?? [])],
    );
    for (const name of [...(config.names ?? []), ...(request.names ?? [])])
      if (workspaceVocabulary([name]).length === 0)
        log(`--name ${name}: too short to rename safely (fewer than four letters), so not renamed: the folder may hold it.`);
    // The owner's other repositories, by what the folder's text writes
    // after the owner's name.
    const owned = ownedNames(
      [...files.map((file) => ({ text: file.text })), ...textExtras.map((path) => ({ text: extraText.get(path) ?? "" }))],
      workspaceVocabulary(names),
    );
    const vocabulary = workspaceVocabulary([...names, ...owned]).filter((term) => !kept.has(term));
    // What the folder installs from the registry keeps its name: npm needs it.
    const manifestJson = JSON.parse(files.find((file) => file.path === "package.json")?.text ?? "{}") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = Object.entries({ ...manifestJson.dependencies, ...manifestJson.devDependencies })
      .filter(([, version]) => !version.startsWith("file:"))
      .map(([name]) => name);
    const keptPackages = keptNames(installed, vocabulary);
    const texts = [
      ...files.map((file) => ({ path: file.path, text: file.text })),
      ...textExtras.map((path) => ({ path, text: extraText.get(path) ?? "" })),
    ];
    if (keepsReceipt && request.pseudonyms !== false && vocabulary.length > 0) {
      const sliceFiles = new Set([...computed.manifest.included.map((file) => file.path), ...extras]);
      const result = pseudonymize({
        files: texts,
        binaries: binaryPaths,
        vocabulary,
        owner: config.pseudonyms ?? [],
        kept: keptPackages,
        readBack: (path) => sliceFiles.has(path),
        ...(request.earlierPseudonyms === undefined ? {} : { earlier: request.earlierPseudonyms }),
      });
      if (!result.ok)
        throw new Error(
          `Nothing written: the public folder's pseudonyms would not map back byte for byte.\n${result.problems
            .map((problem) => `  ${problem}`)
            .join("\n")}\nSet pseudonyms in ${CONFIG_PATH} for the names it could not rename, or cut with --keep-names.`,
        );
      table = result.table;
      pathOf = result.pathOf;
      const renamedFiles = result.files;
      folderText = (path, text) => renamedFiles.get(path)?.text ?? text;
      leaks = [...result.leaks];
      if (table.rules.length > 0)
        log(`Pseudonyms: ${table.rules.length} rename(s) hide ${vocabulary.length} name(s) the repository goes by; the receipt keeps the table.`);
      if (keptPackages.length > 0)
        log(`Kept as the registry names them (npm installs them so), though they carry a hidden name: ${keptPackages.join(", ")}. --mock one to rename it.`);
    } else
      leaks = vocabularyLeaks(
        texts.map((file) => ({ path: file.path, text: maskKept(file.text, keptPackages) })),
        vocabulary,
      );
    leakScan = { vocabulary, kept: keptPackages };
  }
  // The generated files' text as the folder holds them, which the receipt
  // keeps; and the test side's (tests, their helpers, setup files).
  const generatedText: Record<string, string> = {};
  const testText: Record<string, string> = {};
  const testSide = (() => {
    const importersOf = new Map<string, string[]>();
    for (const edge of computed.manifest.internalImports) importersOf.set(edge.to, [...(importersOf.get(edge.to) ?? []), edge.from]);
    const setup = new Set(computed.manifest.params.setupFiles ?? []);
    const side = new Set([...(computed.tests?.carried ?? []), ...setup]);
    // The code is never test side: an entry point, or what code outside imports.
    const code = new Set([...computed.request.entryPoints, ...computed.manifest.cuts.inbound.map((edge) => edge.to)]);
    for (const file of computed.manifest.included) {
      if (code.has(file.path)) continue;
      if (isTestPath(file.path)) side.add(file.path);
      const importers = importersOf.get(file.path) ?? [];
      if (importers.length > 0 && importers.every((from) => isTestPath(from) || setup.has(from))) side.add(file.path);
    }
    return side;
  })();
  for (const file of files) {
    const path = pathOf(file.path);
    const text = folderText(file.path, file.text);
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), text, "utf8");
    if (file.class !== "source") generatedText[path] = text;
    else if (testSide.has(file.path)) testText[path] = text;
  }
  for (const path of [...binaryPaths, ...textExtras]) {
    const target = pathOf(path);
    await mkdir(dirname(join(out, target)), { recursive: true });
    if (table !== null && extraText.has(path)) {
      const text = folderText(path, extraText.get(path) ?? "");
      await writeFile(join(out, target), text, "utf8");
    } else {
      await copyFile(join(repo, path), join(out, target));
    }
  }
  log(`Wrote ${files.length + binaries.length + extras.length} files to ${out}.`);
  let lockfile = false;
  if (request.offline !== true) {
    // The entry points' workspace first, then the others the slice holds.
    const packageOf = packageFolder(repo);
    const workspaces = [
      ...new Set([
        ...computed.request.entryPoints.map((entry) => packageOf(`${entry}/`)),
        ...computed.manifest.included.map((file) => packageOf(file.path)),
      ]),
    ];
    const seeded = seededLockfile(
      repo,
      workspaces,
      JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as Record<string, unknown>,
    );
    if (seeded !== null)
      await writeFile(join(out, "package-lock.json"), `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
  }
  if (request.offline !== true)
    try {
      const resolveLock = async () => {
        await command(
          "npm",
          ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
          { cwd: out, signal: AbortSignal.timeout(5 * 60_000) },
        );
        const path = join(out, "package-lock.json");
        if (!existsSync(path)) return;
        const lock = JSON.parse(readFileSync(path, "utf8")) as { packages?: Record<string, Record<string, unknown>> };
        if (pruneLock(lock) > 0) await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      };
      /** Whether `npm ci` would take the lock: it refuses one out of step with package.json. */
      const lockHolds = async () => {
        try {
          await command("npm", ["ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], {
            cwd: out,
            signal: AbortSignal.timeout(5 * 60_000),
          });
          return true;
        } catch {
          return false;
        }
      };
      await resolveLock();
      // npm 11 can leave a seeded lock short of entries (vite's and
      // vitest's own dependencies), which npm ci then refuses: a second
      // pass fills them and keeps the repository's versions; failing
      // that, a lock resolved from the registry alone.
      if (existsSync(join(out, "package-lock.json")) && !(await lockHolds())) {
        await resolveLock();
        if (!(await lockHolds())) {
          await rm(join(out, "package-lock.json"), { force: true });
          await resolveLock();
          if (!(await lockHolds())) {
            await rm(join(out, "package-lock.json"), { force: true });
            throw new Error("npm ci would not take the lock npm resolved");
          }
          log("Resolved package-lock.json from the registry: the repository's own did not resolve into one npm ci takes.");
        }
      }
      lockfile = existsSync(join(out, "package-lock.json"));
      log("Resolved package-lock.json.");
    } catch (error) {
      // The seed is not a resolved lockfile. Do not leave it behind for
      // `check` to mistake for a lock suitable for npm ci.
      await rm(join(out, "package-lock.json"), { force: true });
      log(
        `No lockfile: ${error instanceof Error ? error.message : String(error)}. \`npm install\` makes one.`,
      );
    }
  // The lock is seeded from the repository's, whose resolved URLs can carry
  // a private registry's token. The folder was empty or new: remove it all.
  const lockFindings = lockfile
    ? scanSecrets([
        { path: "package-lock.json", text: readFileSync(join(out, "package-lock.json"), "utf8") },
      ])
    : [];
  if (lockFindings.length > 0) {
    await rm(out, { recursive: true, force: true });
    if (!fresh) await mkdir(out, { recursive: true });
    throw new Error(
      `Nothing kept: the resolved lockfile carries a credential. ${secretBlockers(lockFindings)
        .map((blocker) => blocker.detail)
        .join(" ")}`,
    );
  }
  const lockText = lockfile ? readFileSync(join(out, "package-lock.json"), "utf8") : null;
  if (lockText !== null) {
    generatedText["package-lock.json"] = lockText;
  }
  const generated = [
    ...files.filter((file) => file.class !== "source"),
    ...(lockText === null ? [] : [{ path: "package-lock.json", text: lockText }]),
  ]
    .map((file) => ({ path: file.path, sha256: sha256(file.text) }))
    .sort((a, b) => compare(a.path, b.path));
  const copied = files
    .filter((file) => file.class === "source")
    .map((file) => ({ path: file.path, sha256: sha256(file.text) }))
    .sort((a, b) => compare(a.path, b.path));
  const readiness = readinessOf(request, computed);
  // A name the table left is a blocker, named in full to the maintainer;
  // so is one a looser reading finds in anything the folder holds, its
  // binary files and its resolved lock included.
  if (leakScan !== null) {
    const held = listTree(out).map((path) => {
      const bytes = readFileSync(join(out, path));
      return { path, text: isTextContent(bytes) ? bytes.toString("utf8") : bytes.toString("latin1") };
    });
    const strict = new Set(leaks.map((leak) => leak.term));
    for (const leak of looseLeaks(held, leakScan.vocabulary, leakScan.kept))
      if (!strict.has(leak.term)) leaks.push(leak);
  }
  const leakBlockers = vocabularyBlockers(leaks).map(({ code, file, detail }) => ({ code, file, detail }));
  const record: CarveoutRecord = {
    ...computed,
    cutId,
    ...(computed.request.public === true ? {} : { readiness }),
    generated,
    copied,
    ...(extras.length === 0
      ? {}
      : {
          extras: extras
            .map((path) => ({ path, sha256: sha256(readFileSync(join(repo, path))) }))
            .sort((a, b) => compare(a.path, b.path)),
        }),
    lockfile,
    blockers: [...computed.blockers, ...leakBlockers],
    ready: computed.ready && leakBlockers.length === 0,
  };
  // The folder's own record: a public one leaves out what names the
  // repository beyond the slice, and one in pseudonyms holds its files by
  // the paths and hashes the folder has. A leak's blocker there does not
  // say the name it is about.
  const folderRecord: CarveoutRecord =
    keepsReceipt && publicCut ? folderRecordFor(record, table ?? undefined, out) : record;
  // The maintainer's copy, outside the folder: what a folder that comes
  // back is judged by, with the pseudonyms' table.
  const receiptData: Receipt | null = !keepsReceipt
    ? null
    : {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      cutId,
      createdAt: new Date().toISOString(),
      repo,
      out,
      record,
      ...(folderRecord === record ? {} : { folderRecord }),
      ...(table === null ? {} : { pseudonyms: table }),
      // The advice a public folder keeps out of its own record.
      readiness,
      generatedText,
      ...(Object.keys(testText).length === 0 ? {} : { testText }),
      ...(request.unseen === undefined || request.unseen.length === 0 ? {} : { unseen: [...request.unseen] }),
    };
  if (receipt !== null && receiptData !== null) writeReceipt(receipt, receiptData);
  await writeFile(join(out, RECORD_PATH), `${JSON.stringify(folderRecord, null, 2)}\n`, "utf8");
  return { out, record, contract, readiness, receipt, receiptData, pseudonyms: table };
}

export function readRecord(dir: string): CarveoutRecord {
  const path = join(resolve(dir), RECORD_PATH);
  if (!existsSync(path))
    throw new Error(`${dir} has no ${RECORD_PATH}; it was not cut by carveout.`);
  const record = JSON.parse(readFileSync(path, "utf8")) as CarveoutRecord;
  if (record.schemaVersion !== RECORD_SCHEMA_VERSION)
    throw new Error(
      `${RECORD_PATH} is schema ${String(record.schemaVersion)}; this carveout reads ${RECORD_SCHEMA_VERSION}.`,
    );
  // A folder can come back from someone else: no path it names may lead
  // carveout outside the folder or the repository.
  checkRecordPaths(record);
  return record;
}

/**
 * Throws unless every file the record says the slice holds is one of the
 * repository's, at the bytes the cut read: its hash must be the blob's at
 * the cut's commit, or the checkout's file's (a cut of uncommitted bytes).
 * The record comes back with the folder, and its `included` list decides
 * which files a patch may edit or delete and which packages may gain a new
 * file: an entry added there for a cut module, with any hash, would carry
 * an edit or a deletion of that module past the hand-off policy. Forging
 * one now takes the file's exact bytes, which a slice never shows.
 */
export function checkRecordFiles(record: CarveoutRecord, repo: string): void {
  const commit = record.manifest.sourceCommitSha;
  for (const file of [...record.manifest.included, ...(record.extras ?? [])]) {
    const at = record.bases?.[file.path] ?? commit;
    const committed = at === null ? null : gitShow(repo, at, file.path);
    if (committed !== null && sha256(committed) === file.sha256) continue;
    const current = join(repo, file.path);
    if (
      existsSync(current) &&
      statSync(current).isFile() &&
      sha256(readFileSync(current)) === file.sha256
    )
      continue;
    throw new Error(
      `carveout.json is not one carveout wrote: it lists ${JSON.stringify(file.path)} as a slice file, which the repository does not hold at those bytes. Cut the folder again rather than trust it.`,
    );
  }
}

export interface CheckStep {
  readonly command: string;
  readonly ok: boolean;
  readonly output: string;
  /** Tests that failed in an unedited folder, recorded as its baseline. */
  readonly baseline?: readonly string[];
  /**
   * The `npm test` step's counts of the folder's tests, read from its TAP:
   * node:test's and Vitest's together, then each runner's, with carveout's
   * own checks of the public surface (exports and types kept) apart.
   */
  readonly counts?: TestCounts;
  /**
   * Tests the folder's `carveout/baseline.json` names and the receipt's
   * does not: added since the check that recorded it, by whoever had the
   * folder. They were counted.
   */
  readonly baselineEdited?: readonly string[];
  /** Whether the folder holds an edit since the cut (a folder that came back). */
  readonly edited?: boolean;
  /** The tests `npm test` did not count: the baseline in effect for the run. */
  readonly baselineInEffect?: readonly string[];
  /** Generated files the folder changed, put back from the receipt for the run. */
  readonly restored?: readonly string[];
  /** Packages the folder's package.json added, which the run did not install. */
  readonly addedPackages?: readonly string[];
  /** Whether a receipt vouched for the record and baseline the run read. */
  readonly receiptRead?: boolean;
}

/** How many of a folder's tests pass, as `npm test` counted them. */
export interface TestCounts {
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  /** Each runner's: `node:test`, `vitest`. */
  readonly runners?: Readonly<Record<string, { readonly tests: number; readonly pass: number; readonly fail: number }>>;
  /** carveout's own checks that the public surface keeps its exports and their types. */
  readonly surface?: { readonly checks: number; readonly fail: number };
}

/** The counts the runner wrote as JSON (`COUNTS_PATH`), or undefined when they do not read. */
export function countsFromJson(text: string): TestCounts | undefined {
  try {
    const parsed = JSON.parse(text) as {
      counted?: { runner?: unknown; tests?: unknown; pass?: unknown; fail?: unknown }[];
      surface?: { checks?: unknown; fail?: unknown };
    };
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const runners: Record<string, { tests: number; pass: number; fail: number }> = {};
    for (const each of parsed.counted ?? []) {
      const name = String(each.runner ?? "");
      const sum = runners[name] ?? { tests: 0, pass: 0, fail: 0 };
      runners[name] = { tests: sum.tests + number(each.tests), pass: sum.pass + number(each.pass), fail: sum.fail + number(each.fail) };
    }
    const all = Object.values(runners);
    const checks = number(parsed.surface?.checks);
    return {
      tests: all.reduce((sum, each) => sum + each.tests, 0),
      pass: all.reduce((sum, each) => sum + each.pass, 0),
      fail: all.reduce((sum, each) => sum + each.fail, 0),
      runners,
      ...(checks > 0 ? { surface: { checks, fail: number(parsed.surface?.fail) } } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The counts in a run's TAP: the runner's `# carveout` lines, or, from a
 * folder cut before they were written, node:test's own summary (which
 * counts the interface test's checks among the tests).
 */
export function countsOf(tap: string): TestCounts | undefined {
  const runners: Record<string, { tests: number; pass: number; fail: number }> = {};
  for (const [, runner = "", tests, pass, fail] of tap.matchAll(/^# carveout (\S+) tests (\d+) pass (\d+) fail (\d+)$/gm)) {
    const sum = runners[runner] ?? { tests: 0, pass: 0, fail: 0 };
    runners[runner] = { tests: sum.tests + Number(tests), pass: sum.pass + Number(pass), fail: sum.fail + Number(fail) };
  }
  let surface: { checks: number; fail: number } | undefined;
  for (const [, checks, fail] of tap.matchAll(/^# carveout surface checks (\d+) fail (\d+)$/gm))
    surface = { checks: (surface?.checks ?? 0) + Number(checks), fail: (surface?.fail ?? 0) + Number(fail) };
  const each = Object.values(runners);
  if (each.length > 0 || surface !== undefined)
    return {
      tests: each.reduce((sum, { tests }) => sum + tests, 0),
      pass: each.reduce((sum, { pass }) => sum + pass, 0),
      fail: each.reduce((sum, { fail }) => sum + fail, 0),
      runners,
      ...(surface === undefined ? {} : { surface }),
    };
  const count = (key: string) => Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(tap)?.[1] ?? Number.NaN);
  return Number.isNaN(count("tests")) ? undefined : { tests: count("tests"), pass: count("pass"), fail: count("fail") };
}

/**
 * Whether a path is what the folder's build or test run writes beside a
 * source (`cart.js` and `cart.js.map` beside `cart.ts`), or the run's own
 * records: neither is an edit.
 */
function buildOutput(path: string, present: ReadonlySet<string>): boolean {
  if (path === BASELINE_PATH || path === LAST_RUN_PATH || path === COUNTS_PATH || path === VITEST_REPORT_PATH || path.endsWith(".tsbuildinfo"))
    return true;
  return tscOutput(path.replace(/\.map$/, ""), present);
}

/**
 * Whether tsc writes `path` from a source beside it: a `.js` (or `.d.ts`)
 * from a `.ts` or `.tsx`, a `.mjs` from a `.mts`, a `.cjs` from a `.cts`.
 * Nothing else: a `.mjs` beside a `.ts` is no build's, and is judged.
 */
function tscOutput(path: string, present: ReadonlySet<string>): boolean {
  const pairs: [RegExp, readonly string[]][] = [
    [/\.d\.ts$/, [".ts", ".tsx"]],
    [/\.d\.mts$/, [".mts"]],
    [/\.d\.cts$/, [".cts"]],
    [/\.js$/, [".ts", ".tsx"]],
    [/\.mjs$/, [".mts"]],
    [/\.cjs$/, [".cts"]],
  ];
  for (const [suffix, sources] of pairs)
    if (suffix.test(path)) {
      const stem = path.replace(suffix, "");
      return sources.some((ext) => present.has(`${stem}${ext}`));
    }
  return false;
}

/**
 * Whether the folder holds an edit since the cut: a slice file whose bytes
 * differ from what the cut wrote, one gone, a generated file changed, or
 * any new file but what a build or a test run writes. Read against the
 * record as the folder holds it (the receipt's, when there is one); the
 * folder's own `.gitignore` hides nothing.
 */
function folderEdited(dir: string, record: CarveoutRecord): boolean {
  const root = resolve(dir);
  // A file a patch brought in is no cut's: its tests' failures are no
  // baseline's (a failing test apply added would be recorded as one).
  if ((record.copied ?? []).some((file) => file.applied === true)) return true;
  const written = new Map([
    ...(record.copied ?? []).map((file) => [file.path, file.sha256] as const),
    ...(record.extras ?? []).map((file) => [file.path, file.sha256] as const),
  ]);
  const generated = new Map(record.generated.map((file) => [file.path, file.sha256] as const));
  const tree = listTree(root, "", [], toolDirsIn(root, record));
  const present = new Set(tree);
  for (const [path, hash] of written) {
    if (!present.has(path)) return true;
    if (sha256(readFileSync(join(root, path))) !== hash) return true;
  }
  for (const [path, hash] of generated)
    if (path !== "package-lock.json" && present.has(path) && sha256(readFileSync(join(root, path))) !== hash) return true;
  return tree.some(
    (path) => !written.has(path) && !generated.has(path) && path !== RECORD_PATH && path !== "package-lock.json" && !buildOutput(path, present),
  );
}

/**
 * Whether a folder holds someone else's work: edited since the cut, by the
 * receipt's hashes. With no receipt it is taken as edited: the folder's own
 * record came back with it and cannot vouch that it is not.
 */
export function folderCameBack(dir: string, options: { readonly receipt?: string; readonly noReceipt?: boolean } = {}): boolean {
  const trusted = trustedCut(dir, options.receipt, { optional: true, ...(options.noReceipt === true ? { noReceipt: true } : {}) });
  if (trusted.receipt === null) return true;
  const record = folderView(trusted.receipt);
  // A record from before the cut's own files were hashed: no telling.
  if (record.copied === undefined) return true;
  return folderEdited(resolve(dir), record);
}

/** The package names the slice's files spell as specifiers, at the cut's commit (or as the checkout holds them). */
export function sliceSpecifierPackages(record: CarveoutRecord, repo: string | null | undefined): string[] {
  if (repo === null || repo === undefined || !existsSync(repo)) return [];
  const commit = record.manifest.sourceCommitSha;
  return [...record.manifest.included, ...(record.extras ?? [])].flatMap((file) => {
    if (!isScript(file.path)) return [];
    const bytes = (commit === null ? null : gitShow(repo, commit, file.path)) ?? (existsSync(join(repo, file.path)) ? readFileSync(join(repo, file.path)) : null);
    return bytes === null ? [] : specifierPackages(bytes.toString("utf8"));
  });
}

/** The node_modules folders under a folder, below its root. */
function nodeModulesIn(root: string, dir = "", into: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.name === "node_modules") {
      if (dir !== "") into.push(path);
      continue;
    }
    nodeModulesIn(root, path, into);
  }
  return into;
}

/** The paths under a folder that are symbolic links, outside node_modules. */
function symlinksIn(root: string, dir = "", into: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) into.push(path);
    else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") symlinksIn(root, path, into);
  }
  return into;
}

/**
 * The first check of a folder: the tests that fail before any edit fail
 * on the mocks, and are written to its baseline. Only when nothing else
 * failed (the build, the coverage gate) and the folder has no edits nor a
 * baseline yet; null otherwise.
 */
async function recordBaseline(
  source: string,
  work: string,
  record: CarveoutRecord,
  baselineKnown: boolean,
): Promise<string[] | null> {
  if (baselineKnown || existsSync(join(source, BASELINE_PATH))) return null;
  const tap = existsSync(join(work, LAST_RUN_PATH))
    ? readFileSync(join(work, LAST_RUN_PATH), "utf8")
    : "";
  const failing = [
    ...new Set(
      [...tap.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].sort(compare);
  if (failing.length === 0 || /coverage does not meet threshold/.test(tap))
    return null;
  // Records from before `copied` was kept are judged by a patch, as before.
  const edited =
    record.copied === undefined
      ? (await patchProject(source, { noReceipt: true })).diff !== ""
      : folderEdited(source, record);
  if (edited) return null;
  // Written as a new file: never through a link the folder put there.
  await rm(join(source, BASELINE_PATH), { force: true });
  await writeFile(join(source, BASELINE_PATH), `${JSON.stringify({ failing }, null, 2)}\n`, { flag: "wx" });
  return failing;
}

/**
 * Installs, builds and tests the folder, in a scratch copy so the folder
 * itself is left as it was; stops at the first step that fails.
 *
 * A folder that came back is run as the receipt's cut made it: its
 * generated files (the test runner, the harness, the manifests and the
 * stubs) are put back from the receipt, a file the folder added under
 * `carveout/` is taken out, the baseline read is the receipt's, and a
 * folder with a symbolic link is not run at all. Its code runs, as the
 * caller, with the caller's network: the receipt is put back if the run
 * changed it, and the check fails.
 */
export async function checkProject(
  dir: string,
  options: {
    readonly inPlace?: boolean;
    /**
     * For a folder that came back from someone else: a scratch HOME and npm
     * cache, so the folder's code cannot read the caller's credentials
     * through them, and no install scripts. Not a sandbox: the folder's
     * tests still run with the caller's user, filesystem and network.
     */
    readonly isolated?: boolean;
    /** The cut's receipt file; else the one `CARVEOUT_HOME` keeps for its id. */
    readonly receipt?: string;
    /** No receipt: the folder's own record and baseline are all there is. */
    readonly noReceipt?: boolean;
    /**
     * The owner's acceptance tests, never sent: each at its repository
     * path, in the repository's names. Put in the check's copy in the
     * folder's names and run with the folder's tests; never recorded in a
     * baseline, and never in the folder itself.
     */
    readonly accept?: readonly { readonly path: string; readonly text: string }[];
    /**
     * With `accept`: the slice files patch keeps out, by repository path.
     * The acceptance run puts back the test side's as the cut wrote them
     * and takes out the ones the folder added, so it runs on what patch
     * would carry.
     */
    readonly held?: readonly string[];
    /**
     * With `held`: when a file patch keeps out would run as the folder
     * holds it (neither a test-side file put back nor an added file taken
     * out), run nothing and say which.
     */
    readonly refuseHeld?: boolean;
    /**
     * Run every step in a container (`sandbox.ts`): only the scratch copy
     * mounted, the network only for an install with scripts off. For a
     * folder that came back.
     */
    readonly sandbox?: SandboxSpec;
  } = {},
): Promise<readonly CheckStep[]> {
  // The receipt's record and baseline when there is one: a folder that
  // came back may have edited its own, to look unedited or to leave a
  // failing test uncounted.
  const trusted = trustedCut(dir, options.receipt, { optional: true, ...(options.noReceipt === true ? { noReceipt: true } : {}) });
  // What the folder's files are measured against: the record as the folder
  // holds it (a public folder in pseudonyms has its own paths and hashes),
  // as the receipt keeps it.
  const record = trusted.receipt === null ? trusted.record : folderView(trusted.receipt);
  const source = resolve(dir);
  const links = symlinksIn(source);
  if (links.length > 0)
    return [
      {
        command: "copy",
        ok: false,
        output: `The folder holds symbolic links, which a slice never has; nothing was run:\n${links.map((path) => `  ${path}`).join("\n")}`,
      },
    ];
  let work = source;
  const scratch =
    options.inPlace !== true || options.isolated === true
      ? mkdtempSync(join(tmpdir(), "carveout-check-"))
      : null;
  if (options.inPlace !== true && scratch !== null) {
    work = join(scratch, "project");
    execFileSync("cp", ["-R", source, work]);
    await rm(join(work, "node_modules"), { recursive: true, force: true });
    // Nor a node_modules folder anywhere in it: no patch reads one, so what
    // the folder holds there never runs (npm ci writes the root's anew).
    for (const nested of nodeModulesIn(work)) await rm(join(work, nested), { recursive: true, force: true });
    // A tool's folder is no part of a change, and a patch never judges what
    // it holds: none of it runs (a test there could write the baseline).
    for (const tool of toolDirsIn(work, record)) await rm(join(work, tool), { recursive: true, force: true });
    // Nor what the build writes from a source: the build writes it anew,
    // and patch never shows the folder's copy of it.
    {
      const tree = listTree(work);
      const present = new Set(tree);
      const generatedPaths = new Set(record.generated.map((file) => file.path));
      for (const path of tree)
        if (!generatedPaths.has(path) && tscOutput(path.replace(/\.map$/, ""), present)) await rm(join(work, path), { force: true });
    }
  }
  const steps: CheckStep[] = [];
  // The generated files the folder changed, put back from the receipt; the
  // files it added under carveout/, taken out. In place, nothing is
  // changed: a folder that does not match is not run.
  const restored: string[] = [];
  const addedPackages: string[] = [];
  const texts = trusted.receipt?.generatedText;
  if (texts !== undefined) {
    const tree = listTree(work);
    const extra = tree.filter(
      (path) =>
        path.startsWith(`${HARNESS_DIR}/`) &&
        texts[path] === undefined &&
        path !== BASELINE_PATH &&
        path !== LAST_RUN_PATH &&
        path !== COUNTS_PATH &&
        path !== VITEST_REPORT_PATH,
    );
    const changed = Object.entries(texts).filter(([path, text]) => {
      const at = join(work, path);
      return !existsSync(at) || readFileSync(at, "utf8") !== text;
    });
    if (options.inPlace === true && options.isolated !== true && (extra.length > 0 || changed.length > 0)) {
      if (scratch !== null) await rm(scratch, { recursive: true, force: true });
      return [
        {
          command: "compare",
          ok: false,
          output: `The folder's generated files are not the cut's (${[...changed.map(([path]) => path), ...extra].join(", ")}); check it without --in-place, which puts them back.`,
        },
      ];
    }
    for (const path of extra) await rm(join(work, path), { force: true });
    // A package the folder installed for itself: named, since the run that
    // judges the slice installs what the cut wrote, as the repository does.
    if (changed.some(([path]) => path === "package.json") && existsSync(join(work, "package.json"))) addedPackages.push(...packagesAdded(readFileSync(join(work, "package.json"), "utf8"), texts["package.json"] ?? ""));
    for (const [path, text] of changed) {
      await mkdir(dirname(join(work, path)), { recursive: true });
      await rm(join(work, path), { force: true });
      await writeFile(join(work, path), text);
      restored.push(path);
    }
    restored.push(...extra.map((path) => `${path} (taken out)`));
  }
  const env: Record<string, string> = {};
  if (options.isolated === true && scratch !== null) {
    await mkdir(join(scratch, "home"), { recursive: true });
    env["HOME"] = join(scratch, "home");
    env["npm_config_cache"] = join(scratch, "npm-cache");
    env["npm_config_userconfig"] = join(scratch, "home", ".npmrc");
  }
  const installFlags = [
    "--no-audit",
    "--no-fund",
    ...(options.isolated === true || options.sandbox !== undefined ? ["--ignore-scripts"] : []),
  ];
  // The one step with a network: npm reads a project .npmrc, which could
  // point it elsewhere or set its options; the cut writes none.
  if (options.sandbox !== undefined && work !== source && !record.generated.some((file) => file.path === ".npmrc"))
    await rm(join(work, ".npmrc"), { force: true });
  const run = [
    record.lockfile || existsSync(join(work, "package-lock.json"))
      ? ["npm", "ci", ...installFlags]
      : ["npm", "install", ...installFlags],
    ["npm", "run", "build"],
    ["npm", "test"],
  ];
  await rm(join(work, LAST_RUN_PATH), { force: true });
  await rm(join(work, VITEST_REPORT_PATH), { force: true });
  await rm(join(work, COUNTS_PATH), { force: true });
  // The baseline the receipt holds is the one `npm test` reads; a folder's
  // own that the receipt does not know is not read at all.
  const folderBaseline = existsSync(join(source, BASELINE_PATH))
    ? (() => {
        try {
          const failing = (JSON.parse(readFileSync(join(source, BASELINE_PATH), "utf8")) as { failing?: unknown }).failing;
          return Array.isArray(failing) ? failing.filter((name): name is string => typeof name === "string") : [];
        } catch {
          return [];
        }
      })()
    : null;
  // With no receipt, the folder's own baseline is read only when the
  // caller says there is none to be had (`--no-receipt`).
  const chosen =
    trusted.receipt === null && options.noReceipt !== true
      ? { use: null, edited: folderBaseline ?? [] }
      : trustedBaseline(trusted.receipt, folderBaseline);
  const baselineEdited = chosen.edited.length > 0 ? chosen.edited : undefined;
  // The owner's acceptance tests, in the check's copy only.
  const acceptedAt: string[] = [];
  const table = trusted.receipt?.pseudonyms;
  // What patch keeps out does not run: a test, a helper or a setup file the
  // folder edited is put back as the cut wrote it, a file it added is taken
  // out. Any other (a slice file that gained reach, say) would run as the
  // folder holds it: with `refuseHeld`, nothing runs at all.
  if (options.held !== undefined && options.held.length > 0) {
    if (work === source)
      return [{ command: "policy", ok: false, output: "What patch keeps out is put back in a copy of the folder, never in it: check without --in-place." }];
    const cutPaths = new Set([...record.manifest.included.map((file) => file.path), ...record.generated.map((file) => file.path)]);
    const asHeld: string[] = [];
    for (const path of options.held) {
      const folderPath = table === undefined ? path : (exactToFolder(table, path, "")?.path ?? toFolder(table, path, "").path);
      const original = trusted.receipt?.testText?.[folderPath];
      if (original !== undefined) {
        await mkdir(dirname(join(work, folderPath)), { recursive: true });
        await writeFile(join(work, folderPath), original);
      } else if (!cutPaths.has(folderPath)) await rm(join(work, folderPath), { force: true });
      else if (existsSync(join(work, folderPath))) asHeld.push(path);
    }
    if (asHeld.length > 0 && options.refuseHeld === true) {
      if (scratch !== null) await rm(scratch, { recursive: true, force: true });
      return [
        {
          command: "policy",
          ok: false,
          output: `patch keeps out ${asHeld.length} file(s) that would run as the folder holds them, so nothing of the folder ran:\n${asHeld
            .map((path) => `  ${path}`)
            .join("\n")}\nRead them (carveout patch names why), then check again with --allow <path> for each you accept.`,
        },
      ];
    }
  }
  if (options.accept !== undefined && options.accept.length > 0) {
    if (work === source)
      return [{ command: "accept", ok: false, output: "Acceptance tests run in a copy of the folder, never in it: check without --in-place." }];
    for (const test of options.accept) {
      const folder = table === undefined ? { path: test.path, text: test.text } : exactToFolder(table, test.path, test.text);
      if (folder === null)
        return [
          {
            command: "accept",
            ok: false,
            output: `${test.path} would not map into the folder's names byte for byte; rename what it names, or check a folder cut with --keep-names.`,
          },
        ];
      await mkdir(dirname(join(work, folder.path)), { recursive: true });
      // A test the folder added at the same path moves aside, as patch
      // carries it (`contributedPath`): it runs with the folder's tests,
      // never in the owner's test's place.
      if (existsSync(join(work, folder.path))) {
        const aside = contributedPath(folder.path, (candidate) => existsSync(join(work, candidate)));
        await rename(join(work, folder.path), join(work, aside));
      }
      await writeFile(join(work, folder.path), folder.text);
      // A file planted to stand in for it (a twin the walk takes instead,
      // or one tsc would compile over it) is taken out.
      const stem = folder.path.replace(/\.[cm]?[jt]sx?$/, "");
      for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"])
        if (`${stem}${ext}` !== folder.path) await rm(join(work, `${stem}${ext}`), { force: true });
      acceptedAt.push(folder.path);
    }
  }
  if (chosen.use === null) await rm(join(work, BASELINE_PATH), { force: true });
  else if (chosen.use !== "folder") {
    await mkdir(dirname(join(work, BASELINE_PATH)), { recursive: true });
    await rm(join(work, BASELINE_PATH), { force: true });
    await writeFile(join(work, BASELINE_PATH), `${JSON.stringify({ failing: chosen.use }, null, 2)}\n`, { flag: "wx" });
  }
  const inEffect = chosen.use === "folder" ? (folderBaseline ?? []) : (chosen.use ?? []);
  // The receipt as it was before any of the folder's code ran.
  const receiptBefore =
    trusted.receiptPath !== null && existsSync(trusted.receiptPath) ? readFileSync(trusted.receiptPath) : null;
  let receiptNow = receiptBefore;
  let recorded: readonly string[] | null = null;
  // The owner's acceptance tests, each on its own runner with no baseline:
  // each must report a test, and every one must pass. Run on its own, so
  // no file pattern, twin or name the baseline holds can pass it unseen;
  // and on the build, before the folder's own tests run any of its code in
  // the copy, so nothing it writes there stands in for them.
  /** Runs a command of the folder's in its copy: in the container with no network when sandboxed, else here. */
  const runFolder = (argv: readonly string[], runEnv: Record<string, string>) => {
    const [executable = "true", ...args] = argv;
    return options.sandbox === undefined
      ? runGroup(executable, args, work, runEnv)
      : sandboxRun(options.sandbox, work, argv, { cwd: work, env: env, network: false });
  };
  const accept = async () => {
    // A child's environment is the one given, whole: PATH finds node for
    // a runner's `#!/usr/bin/env node`, as every other step has it.
    const acceptEnv: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      ...(process.env["HOME"] === undefined ? {} : { HOME: process.env["HOME"] }),
      ...(process.env["SystemRoot"] === undefined ? {} : { SystemRoot: process.env["SystemRoot"] }),
      ...env,
    };
    const lines: string[] = [];
    let passed = true;
    for (const path of acceptedAt) {
      const text = readFileSync(join(work, path), "utf8");
      const vitestFile = /['"]vitest(\/[^'"]*)?['"]/.test(text);
      let tests = 0;
      let failures = 0;
      let output = "";
      if (vitestFile) {
        const report = join(work, HARNESS_DIR, ".accept.json");
        await rm(report, { force: true });
        const bin = join(work, "node_modules", ".bin", "vitest");
        if (!existsSync(bin)) {
          passed = false;
          lines.push(`FAIL ${path}: it runs on Vitest, which the folder does not install (cut again with --install vitest)`);
          continue;
        }
        const result = await runFolder([bin, "run", "--config", "vitest.config.mjs", "--reporter=json", `--outputFile.json=${report}`, path], acceptEnv);
        output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        try {
          const json = JSON.parse(readFileSync(report, "utf8")) as { testResults?: { assertionResults?: { status?: string }[]; status?: string }[] };
          for (const file of json.testResults ?? []) {
            const cases = file.assertionResults ?? [];
            tests += cases.length;
            // Only a test that ran and passed counts: a skipped, todo or
            // pending one passes nothing.
            failures += cases.filter((each) => each.status !== "passed").length + (cases.length === 0 && file.status === "failed" ? 1 : 0);
          }
        } catch {
          failures += 1;
        }
      } else {
        const compiled = path.replace(/\.tsx?$/, ".js").replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs");
        const result = await runFolder(
          [process.execPath, `--env-file=${ENV_FILE}`, `--import=./${ASSETS_LOADER_PATH}`, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", compiled],
          acceptEnv,
        );
        output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        // The tests it holds: a file with none is reported as one test named
        // for the file, which is no test of the work.
        const entries = [...(result.stdout ?? "").matchAll(/^\s*(not )?ok \d+ - (.+?)(?: # .*)?$/gm)].filter(
          (match) => !(match[2] ?? "").endsWith(compiled),
        );
        tests = entries.length;
        failures = entries.filter((match) => match[1] !== undefined).length + (result.status !== 0 && entries.every((match) => match[1] === undefined) ? 1 : 0);
      }
      const ok = tests > 0 && failures === 0;
      if (!ok) passed = false;
      lines.push(
        ok
          ? `ok   ${path}: ${tests} test(s) pass`
          : tests === 0
            ? `FAIL ${path}: no test of it ran (it must name its runner and hold a test)\n${output.trim().slice(-2000)}`
            : `FAIL ${path}: ${failures} of ${tests} test(s) fail\n${output.trim().slice(-4000)}`,
      );
    }
    steps.push({ command: "accept", ok: passed, output: lines.join("\n") });
  };
  for (const argv of run) {
    const [executable = "npm", ...args] = argv;
    try {
      const output =
        options.sandbox === undefined
          ? await command(executable, args, {
              cwd: work,
              signal: AbortSignal.timeout(10 * 60_000),
              env,
            })
          : await sandboxRun(options.sandbox, work, argv, {
              cwd: work,
              env,
              // Only the install reaches the registry, with scripts off.
              network: argv[1] === "ci" || argv[1] === "install",
            }).then((result) => {
              if (result.status === 0) return result.stdout;
              throw new Error(
                `${argv.join(" ")} exited ${result.status ?? "on a signal"} in the sandbox:\n${`${result.stdout.trim()}\n${result.stderr.trim()}`.trim().split("\n").slice(-40).join("\n")}`,
              );
            });
      steps.push({ command: argv.join(" "), ok: true, output });
      if (argv[1] === "run" && argv[2] === "build" && acceptedAt.length > 0)
        // Its own failure, never the build's.
        await accept().catch((error: unknown) => {
          steps.push({ command: "accept", ok: false, output: error instanceof Error ? error.message : String(error) });
        });
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      const baseline =
        argv[1] === "test" && (options.accept ?? []).length === 0
          ? await recordBaseline(
              source,
              work,
              record,
              trusted.receipt !== null && (trusted.receipt.baseline !== undefined || folderBaseline !== null),
            )
          : null;
      if (baseline !== null && trusted.receipt !== null && trusted.receiptPath !== null) {
        writeReceipt(trusted.receiptPath, { ...trusted.receipt, baseline });
        receiptNow = readFileSync(trusted.receiptPath);
        recorded = baseline;
      }
      steps.push(
        baseline === null
          ? { command: argv.join(" "), ok: false, output }
          : {
              command: argv.join(" "),
              ok: true,
              output: `${baseline.length} test(s) fail with nothing changed: they fail on the mocks. Recorded in ${BASELINE_PATH}, which npm test reads so they are not counted:\n${baseline.map((name) => `  ${name}`).join("\n")}`,
              baseline,
            },
      );
      if (baseline === null) break;
    }
  }
  // The folder's code ran as the caller: if it changed the receipt, the
  // receipt is put back and the check fails.
  if (trusted.receiptPath !== null && receiptNow !== null) {
    const after = existsSync(trusted.receiptPath) ? readFileSync(trusted.receiptPath) : null;
    if (after === null || !after.equals(receiptNow)) {
      await rm(trusted.receiptPath, { force: true });
      writeReceipt(trusted.receiptPath, JSON.parse(receiptNow.toString("utf8")) as Parameters<typeof writeReceipt>[1]);
      steps.push({
        command: "receipt",
        ok: false,
        output: `The folder's code changed the maintainer's receipt (${trusted.receiptPath}) while it ran; it was put back. Do not merge this folder: read its tests and scripts first.`,
      });
    }
  }
  // The run's counts, for the verdict: how many tests the folder runs and
  // how many pass before any edit.
  const tapPath = join(work, LAST_RUN_PATH);
  const tap = existsSync(tapPath) ? readFileSync(tapPath, "utf8") : "";
  // The runner's counts as it wrote them after every test ran; from a folder
  // cut before, the TAP's.
  const countsPath = join(work, COUNTS_PATH);
  const counts = existsSync(countsPath) ? (countsFromJson(readFileSync(countsPath, "utf8")) ?? countsOf(tap)) : countsOf(tap);
  const testStep = steps.findIndex((step) => step.command === "npm test");
  const edited = record.copied === undefined ? undefined : folderEdited(source, record);
  if (testStep !== -1) {
    const step = steps[testStep] as CheckStep;
    steps[testStep] = {
      ...step,
      ...(edited === undefined ? {} : { edited }),
      ...(counts === undefined ? {} : { counts }),
      ...(baselineEdited === undefined ? {} : { baselineEdited }),
      baselineInEffect: recorded ?? inEffect,
      ...(restored.length === 0 ? {} : { restored }),
      ...(addedPackages.length === 0 ? {} : { addedPackages }),
      receiptRead: trusted.receipt !== null,
    };
  } else if (steps.length > 0 && restored.length > 0) {
    // The run stopped before the tests (a build the restored package.json
    // cannot satisfy): the step that failed says what was put back.
    const last = steps.length - 1;
    steps[last] = {
      ...(steps[last] as CheckStep),
      restored,
      ...(addedPackages.length === 0 ? {} : { addedPackages }),
    };
  }
  if (scratch !== null) await rm(scratch, { recursive: true, force: true });
  return steps;
}

/**
 * Runs a command in its own process group and gathers what it prints: at
 * the time limit the whole group is killed, workers and anything the
 * folder's code started included, not only the first process.
 */
function runGroup(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  limitMs = 10 * 60_000,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolvePromise) => {
    const group = process.platform !== "win32";
    const child = spawn(executable, [...args], { cwd, env, detached: group, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, limitMs);
    const done = (status: number | null) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, status });
    };
    child.on("error", (error) => {
      stderr += error.message;
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

/** The dependencies one package.json text pins that another does not. */
function dependenciesAdded(folder: string, cut: string): { name: string; version: string }[] {
  const entries = (text: string) => {
    try {
      const manifest = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
      return [...Object.entries(manifest["dependencies"] ?? {}), ...Object.entries(manifest["devDependencies"] ?? {})];
    } catch {
      return [];
    }
  };
  const known = new Set(entries(cut).map(([name]) => name));
  return entries(folder)
    .filter(([name]) => !known.has(name))
    .map(([name, version]) => ({ name, version: typeof version === "string" ? version : JSON.stringify(version) }))
    .sort((a, b) => compare(a.name, b.name));
}

/**
 * A dependency as the owner reads it: quoted, so a name or pin carrying a
 * newline or an escape prints as text, and a pin the registry does not
 * resolve (a URL, a path, an alias) said to be one.
 */
function dependencyText(item: { name: string; version: string }): string {
  return `${JSON.stringify(item.name)}: ${JSON.stringify(item.version)}${isRegistryVersion(item.version) ? "" : " (not a registry version: a URL, a path or an alias; read it first)"}`;
}

/** The dependencies one package.json text pins that another does not, as the owner reads them. */
export function packagesAdded(folder: string, cut: string): string[] {
  return dependenciesAdded(folder, cut).map(dependencyText);
}


export { undoRewrites } from "./imports.js";

/** An edit the patch cannot carry: the change reaches past the slice. */
export interface BoundaryEdit {
  readonly path: string;
  /**
   * `stub`: a cut module's declarations or its mock; `dependency`: the
   * folder's package.json; `config`: its compiler or runtime
   * configuration; `mock`: the mock runtime or a mock package.
   */
  readonly kind: "stub" | "dependency" | "config" | "mock";
  readonly detail: string;
  /** For `dependency`: the packages the folder added, at the versions it pins. */
  readonly added?: readonly { readonly name: string; readonly version: string }[];
}

export interface Patch {
  /** A unified diff `git apply` takes at the repository's root. */
  readonly diff: string;
  readonly changed: readonly string[];
  readonly added: readonly string[];
  /** Slice files the folder no longer holds, deleted by the patch. */
  readonly deleted: readonly string[];
  /** Generated files that were edited, which the patch leaves out. */
  readonly generatedEdits: readonly string[];
  /** Of those, the edits that mean the change needs more than the slice. */
  readonly boundary: readonly BoundaryEdit[];
  /**
   * New or changed files that import the folder's harness (`carveout/`),
   * which the repository does not have; the patch leaves them out.
   */
  readonly sliceOnly: readonly string[];
  /** New imports restored as relative paths across packages: no importer names the target. */
  readonly crossPackage: readonly { file: string; specifier: string }[];
  /** Whether the repository's copy moved since the cut. */
  readonly drifted: readonly string[];
  /**
   * Changed files whose base is no blob of the cut's commit (the cut read
   * uncommitted bytes), so `git apply --3way` cannot merge them.
   */
  readonly noThreeWay: readonly string[];
  /**
   * What the hand-off policy keeps out of the patch: new files outside the
   * slice's packages, protected paths, deleted tests. `allow` lets them in.
   */
  readonly refused: readonly Refusal[];
  /**
   * Where the record the patch was judged by came from: the maintainer's
   * receipt, or the folder's own (no receipt found), checked against the
   * repository.
   */
  readonly recordFrom: "receipt" | "folder";
  /**
   * New files the patch leaves out without judging them: under `carveout/`
   * (the folder's harness, which never goes back) or hidden by the
   * folder's `.gitignore`. Named, since the folder's own tests run them.
   */
  readonly skipped: readonly string[];
  /**
   * New test files the folder added at a path the repository already holds
   * outside the slice (the owner's acceptance test, kept out of the cut),
   * carried at a free path beside it instead (`contributedPath`), so the
   * patch applies without a conflict and both tests run.
   */
  readonly renamed?: readonly { readonly from: string; readonly to: string }[];
}

/**
 * A free path beside `path` for a contributor's new file that would land on
 * one the repository already holds (the owner's acceptance test, kept out of
 * the cut): `-contributed` before the test suffix, or before the extension
 * (`quote.test.ts` becomes `quote-contributed.test.ts`), numbered past any
 * name `taken` says is in use. Same folder, so its relative imports hold,
 * and the same suffix, so the test script still runs it.
 */
export function contributedPath(path: string, taken: (candidate: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const at = /\.(test|spec)\.[^/]+$/.exec(name)?.index ?? /\.[^./]+$/.exec(name)?.index ?? name.length;
  for (let n = 1; ; n += 1) {
    const candidate = `${dir}${name.slice(0, at)}-contributed${n === 1 ? "" : `-${n}`}${name.slice(at)}`;
    if (!taken(candidate)) return candidate;
  }
}

export interface PatchOptions {
  /** The repository's checkout; else the one the record names. */
  readonly repo?: string;
  /** Paths and globs the hand-off policy lets through. */
  readonly allow?: readonly string[];
  /** The cut's receipt file; else the one `CARVEOUT_HOME` keeps for its id. */
  readonly receipt?: string;
  /**
   * The cut's receipt as data (`CutResult.receiptData`), in place of a
   * file: no receipt is looked for under `CARVEOUT_HOME` (`api.ts`).
   */
  readonly receiptData?: Receipt;
  /** No receipt: judge the folder by its own record, checked against the repository. */
  readonly noReceipt?: boolean;
  /** Internal: the folder is a copy already put back in the repository's names. */
  readonly unaliased?: boolean;
}

/**
 * A folder in pseudonyms, renamed back into the repository's names, path
 * and text, in a scratch copy with the receipt's record: what a patch is
 * made from, as from a folder cut in those names. Two files that would
 * land on one path are refused, never merged.
 */
async function unaliasFolder(
  root: string,
  table: FolderPseudonyms,
  record: CarveoutRecord,
  /** A package the repository knows: a renamed specifier that names one goes back. */
  repositoryPackage: (name: string) => boolean = () => false,
): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "carveout-names-"));
  const folder = join(scratch, "folder");
  const from = new Map<string, string>();
  // The folder's own mock packages go by the table's names; any other
  // package a file imports keeps the name it has.
  const own = new Set<string>();
  const mocks = join(root, HARNESS_DIR, "packages");
  if (existsSync(mocks))
    for (const entry of readdirSync(mocks, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@"))
        for (const inner of readdirSync(join(mocks, entry.name), { withFileTypes: true }))
          if (inner.isDirectory()) own.add(`${entry.name}/${inner.name}`);
      else own.add(entry.name);
    }
  for (const path of listTree(root, "", [], toolDirsIn(root, record))) {
    if (path === RECORD_PATH) continue;
    const bytes = readFileSync(join(root, path));
    const binary = isBinaryPath(path) || !isTextContent(bytes);
    const back = fromFolder(table, path, binary ? "" : bytes.toString("utf8"), (name) => own.has(name), repositoryPackage);
    const earlier = from.get(back.path);
    if (earlier !== undefined) {
      await rm(scratch, { recursive: true, force: true });
      throw new Error(
        `${earlier} and ${path} both map back to one file of the repository; rename one of them in the folder.`,
      );
    }
    from.set(back.path, path);
    await mkdir(dirname(join(folder, back.path)), { recursive: true });
    await writeFile(join(folder, back.path), binary ? bytes : back.text);
  }
  await writeFile(join(folder, RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`);
  return folder;
}

function listTree(root: string, dir = "", into: string[] = [], skip: ReadonlySet<string> = new Set()): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git" && !(dir === "" && skip.has(entry.name)))
        listTree(root, path, into, skip);
    } else if (entry.isFile()) into.push(path);
  }
  return into;
}


/**
 * The tool folders at a returned folder's root that hold none of the
 * slice's files: left out of what `patch` and `check` read, and named.
 */
function toolDirsIn(root: string, record: CarveoutRecord): Set<string> {
  const held = [
    ...record.manifest.included.map((file) => file.path),
    ...(record.copied ?? []).map((file) => file.path),
    ...(record.extras ?? []).map((file) => file.path),
    ...record.generated.map((file) => file.path),
  ];
  return new Set(
    TOOL_DIRS.filter(
      (dir) => existsSync(join(root, dir)) && statSync(join(root, dir)).isDirectory() && !held.some((path) => path.startsWith(`${dir}/`)),
    ),
  );
}

/** The folder files a cut writes beside its stubs that only the folder runs. */
const HARNESS_FILES = new Set([
  "carveout/mock.js",
  "carveout/mock.d.ts",
  "carveout/assets.js",
  "carveout/ambient.d.ts",
]);
const CONFIG_FILES = new Set([
  "tsconfig.json",
  ".npmrc",
  ".nvmrc",
  "carveout.env",
]);

/** What an edit to a generated file means for the patch, if anything. */
function boundaryEdit(
  root: string,
  path: string,
  record: CarveoutRecord,
  stubFiles: ReadonlyMap<string, string>,
  /** The package.json the cut wrote, from the receipt: what was there before the folder's edits. */
  cutPackageJson?: string,
): BoundaryEdit | null {
  const module = stubFiles.get(path);
  if (module !== undefined)
    return {
      path,
      kind: "stub",
      detail: `${module} is cut: the edit to its stub stays in the folder, and the patch does not change ${module}.`,
    };
  if (path === "package.json") {
    // Against the cut's own package.json (its type and peer packages
    // included) when the receipt has it; else the record's dependencies.
    const cut =
      cutPackageJson ??
      JSON.stringify({ dependencies: Object.fromEntries(["typescript", ...record.dependencies.map((dependency) => dependency.name)].map((name) => [name, ""])) });
    const added = existsSync(join(root, path)) ? dependenciesAdded(readFileSync(join(root, path), "utf8"), cut) : [];
    return {
      path,
      kind: "dependency",
      detail:
        added.length === 0
          ? "package.json was edited; the repository's package files are not patched."
          : `adds ${added.map(dependencyText).join(", ")}, which the repository's package files do not get.`,
      ...(added.length === 0 ? {} : { added }),
    };
  }
  if (CONFIG_FILES.has(path))
    return {
      path,
      kind: "config",
      detail: `${path} is the folder's own; the repository's configuration is not patched.`,
    };
  if (HARNESS_FILES.has(path) || path.startsWith("carveout/packages/"))
    return {
      path,
      kind: "mock",
      detail: `${path} is a mock; what it stands in for is outside the slice.`,
    };
  return null;
}

/**
 * The edits made in the folder as a patch for the repository: each slice
 * file that changed or is gone, and each new file outside `carveout/`, with
 * their imports as the repository writes them (`restoreImports`). Built
 * outputs, the generated files and the lockfile are not part of it; edits
 * to generated files that the change needed are reported as `boundary`.
 */
export async function patchProject(
  dir: string,
  options: PatchOptions = {},
): Promise<Patch> {
  const root = resolve(dir);
  // The receipt's record when there is one: the folder's own came back
  // with the folder, and is checked against the repository instead.
  const trusted =
    options.receiptData !== undefined
      ? trustedCutWith(root, options.receiptData)
      : trustedCut(root, options.receipt, options.noReceipt === true ? { noReceipt: true } : {});
  // A folder in pseudonyms is renamed back first; the patch is made from
  // that copy, in the repository's names.
  const table = trusted.receipt?.pseudonyms;
  if (table !== undefined && options.unaliased !== true) {
    const named = trusted.receipt?.record ?? trusted.record;
    // The packages the repository knows: its workspaces', and those the
    // cut found the slice depends on.
    let workspaceNames: string[] = [];
    try {
      workspaceNames = [...workspacePackages(trustedRepo({ ...named, repo: named.repo ?? trusted.receipt?.repo ?? null }, options.repo)).keys()];
    } catch {
      // No checkout to read: the record's own names alone.
    }
    const known = new Set([
      ...workspaceNames,
      ...named.dependencies.map((dependency) => dependency.name),
      ...named.manifest.requiredBuildInputs.packages.map((item) => item.name),
      // And the names the slice's own files spell as specifiers at the
      // cut's commit, as the cut read them back.
      ...sliceSpecifierPackages(named, trusted.receipt?.repo ?? named.repo ?? options.repo),
    ]);
    const folder = await unaliasFolder(root, table, named, (name) => known.has(name));
    try {
      return await patchProject(folder, {
        ...options,
        ...(trusted.receiptPath === null ? {} : { receipt: trusted.receiptPath }),
        unaliased: true,
      });
    } finally {
      await rm(dirname(folder), { recursive: true, force: true });
    }
  }
  const record = trusted.record;
  const repo = trustedRepo(record, options.repo);
  checkRecordFiles(record, repo);
  const rewritesOf = new Map<string, ImportRewrite[]>();
  for (const rewrite of record.importRewrites)
    rewritesOf.set(rewrite.file, [
      ...(rewritesOf.get(rewrite.file) ?? []),
      rewrite,
    ]);
  const generated = new Map(record.generated.map((g) => [g.path, g.sha256]));
  const included = new Map(
    record.manifest.included.map((file) => [file.path, file.sha256]),
  );
  // A copied folder's files are the repository's too: edited, they are
  // in the patch against the repository's copy.
  for (const extra of record.extras ?? []) included.set(extra.path, extra.sha256);
  // The .gitignore the cut wrote (the receipt's), not the folder's own: a
  // file the folder's holder lists there would be left unjudged, and check
  // runs the cut's.
  const gitignoreText =
    trusted.receipt?.generatedText?.[".gitignore"] ??
    (existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8") : "");
  const ignored = new Set(gitignoreText.split("\n").filter(Boolean));
  const stubModules = new Set([
    ...record.manifest.cuts.outbound.map((edge) => edge.to),
    ...record.dependencies
      .filter((dependency) => dependency.kind === "module")
      .map((dependency) => dependency.name),
  ]);
  // Stubs `apply --stubs` wrote for modules the change needs.
  for (const file of record.generated)
    if (/\.d\.ts$/.test(file.path) && !file.path.startsWith("carveout/"))
      stubModules.add(file.path.replace(/\.d\.ts$/, ".ts"));
  const stubFiles = new Map<string, string>();
  for (const module of stubModules) {
    stubFiles.set(declarationPath(module), module);
    stubFiles.set(runtimePath(module), module);
  }
  const tools = toolDirsIn(root, record);
  const tree = listTree(root, "", [], tools).sort(compare);
  const present = new Set(tree);
  const sources = new Set(
    tree.filter(
      (path) =>
        !generated.has(path) &&
        !path.startsWith("carveout/") &&
        path !== RECORD_PATH,
    ),
  );
  const packageOf = packageFolder(repo);
  // The packages the slice holds files of: where a new file may go.
  const packages = new Set(
    [...included.keys()].map((path) => packageOf(path)),
  );
  // The packages the folder has, its own workspaces' and those it stubs
  // included: a bare import of any other reaches past it. And the modules
  // it holds or stubs, which an import may name by path.
  const cutModules = record.manifest.cuts.outbound.map((edge) => edge.to);
  const touched = new Set([...packages, ...cutModules.map((path) => packageOf(path))]);
  const knownPackages = new Set([
    ...record.dependencies.filter((dependency) => dependency.kind === "package").map((dependency) => dependency.name),
    ...record.manifest.requiredBuildInputs.packages.map((item) => item.name),
    ...[...workspacePackages(repo)]
      .filter(([, directory]) => touched.has(packageOf(`${relative(repo, directory).split("\\").join("/")}/package.json`)))
      .map(([name]) => name),
  ]);
  const bare = (path: string) => path.replace(/\.(d\.)?[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
  const heldModules = new Set([...included.keys(), ...cutModules].map(bare));
  const holds = (path: string) => heldModules.has(bare(path));
  // A slice file only tests import is a test's helper: an edit to it is a
  // test edit, wherever it is kept and whatever it is named. Not an entry
  // file the cut was asked for by name, which is the task's code even when
  // only its own test imports it. A folder given as an entry names no file:
  // a file under it that only tests import is a helper like any other
  // (else every helper there escapes the rule). A file code imports has an
  // importer that is no test, so it is no helper either.
  // The setup files the package's Vitest tests run before them: held as
  // the runner's configuration is. A cut from before they were recorded
  // apart named them among its entry points, even among the entries asked
  // for: the package's Vitest config, read again, names them then.
  const configured = (() => {
    try {
      const dirs = [...new Set(record.request.entryPoints.map((entry) => packageOf(`${entry}/x`)))];
      return dirs.flatMap((dir) => vitestSettings(repo, dir)?.setupFiles ?? []);
    } catch {
      return [];
    }
  })();
  const setupFiles = new Set([
    ...(record.manifest.params.setupFiles ??
      record.manifest.params.entryPoints.filter((entry) => !record.request.entryPoints.includes(entry) && !isTestPath(entry))),
    ...configured.filter((path) => included.has(path)),
  ]);
  const code = new Set(
    record.request.entryPoints.filter((entry) => included.has(entry) && !isTestPath(entry) && !setupFiles.has(entry)),
  );
  const importersOf = new Map<string, string[]>();
  for (const edge of [...record.manifest.internalImports, ...record.manifest.cuts.inbound])
    importersOf.set(edge.to, [...(importersOf.get(edge.to) ?? []), edge.from]);
  // A setup file runs before every test: what only it and tests import is
  // a test's helper too (a `vi.mock` in a module the setup file loads
  // replaces the code under test everywhere). A module only its own test
  // imports (`rounding.ts`, `rounding.test.ts`) is the code that test is
  // of, whatever folder was asked for.
  const stem = (path: string) => (path.split("/").pop() ?? path).replace(/\.(test|spec)(?=\.)/, "").replace(/\.[cm]?[jt]sx?$/, "");
  // The module's own test alone imports it: one importer, a test of the
  // same name beside it (or in the `__tests__` folder beside it). A helper
  // a test of its name shares with other tests stays a helper.
  const ownTestOnly = (path: string, importers: readonly string[]) => {
    const [only] = importers;
    if (importers.length !== 1 || only === undefined || !isTestPath(only) || stem(only) !== stem(path)) return false;
    const dir = posix.dirname(path);
    const testDir = posix.dirname(only);
    return testDir === dir || testDir === posix.join(dir, "__tests__");
  };
  const testOnly = new Set(
    [...included.keys()].filter((path) => {
      const importers = importersOf.get(path) ?? [];
      return (
        !isTestPath(path) &&
        !code.has(path) &&
        !setupFiles.has(path) &&
        importers.length > 0 &&
        importers.every((from) => isTestPath(from) || setupFiles.has(from)) &&
        !ownTestOnly(path, importers)
      );
    }),
  );
  const judge = handoffPolicy({
    packages,
    packageOf,
    knownPackages,
    holds,
    testSupport: (path: string) => testOnly.has(path),
    testSetup: (path: string) => setupFiles.has(path),
    reach: true,
    integrity: true,
    checks: true,
    ...(options.allow === undefined ? {} : { allow: options.allow }),
  });
  const refused: Refusal[] = [];
  /** Whether the policy lets `path` into the patch; a refusal is named. */
  /** Bare packages each edited script imports, for a dependency it adds. */
  const importedBy = new Map<string, Set<string>>();
  const admits = (
    path: string,
    change: "added" | "changed" | "deleted",
    texts?: { readonly before: string | null; readonly after: string },
  ) => {
    if (texts !== undefined && isScript(path))
      for (const specifier of specifiersOf(texts.after, path))
        if (isPackageName(packageNameOf(specifier))) {
          const name = packageNameOf(specifier);
          const files = importedBy.get(name) ?? new Set<string>();
          files.add(path);
          importedBy.set(name, files);
        }
    const reason = judge(path, change, texts);
    if (reason !== null) refused.push({ path, reason });
    return reason === null;
  };
  const edges = [
    ...record.manifest.internalImports,
    ...record.manifest.cuts.outbound,
    ...record.manifest.cuts.inbound,
  ].flatMap((edge) =>
    edge.specifier === null
      ? []
      : [{ from: edge.from, to: edge.to, specifier: edge.specifier }],
  );
  const context: ImportContext = {
    edges,
    files: sources,
    stubs: stubModules,
    packageOf,
    extensionStyle: extensionStyles(edges, packageOf),
  };
  // What `npm run build` wrote for a source the folder's edits added.
  const emitted = (path: string) => /\.[cm]?js$/.test(path) && tscOutput(path, present);
  /** Imports a restored text still makes of the folder's harness. */
  const harnessImport = (path: string, text: string) =>
    [...specifiersOf(text, path)].some(
      (specifier) =>
        specifier.startsWith(".") &&
        posix
          .normalize(posix.join(posix.dirname(path), specifier))
          .startsWith("carveout/"),
    );
  const scratch = mkdtempSync(join(tmpdir(), "carveout-patch-"));
  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const generatedEdits: string[] = [];
  const boundary: BoundaryEdit[] = [];
  const sliceOnly: string[] = [];
  const crossPackage: { file: string; specifier: string }[] = [];
  const drifted: string[] = [];
  const noThreeWay: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  /** Whether the repository holds `path`, in the checkout or at the cut's commit. */
  const repositoryHolds = (path: string) =>
    existsSync(join(repo, path)) ||
    (record.manifest.sourceCommitSha !== null && gitShow(repo, record.manifest.sourceCommitSha, path) !== null);
  // A tool's folder (npm's cache, a coverage report) is named, not listed.
  const skipped: string[] = [...tools].map((dir) => `${dir}/`);
  /**
   * The bytes the cut read for an included file, from the commit when the
   * checkout still has them there, else the checkout's file if it has not
   * moved; otherwise null, and the patch is against what the cut copied.
   */
  const readBase = (path: string, original: string) => {
    const repoPath = join(repo, path);
    const current = existsSync(repoPath) ? readFileSync(repoPath) : null;
    // At the file's own base, where refresh moved it alone.
    const baseCommit = record.bases?.[path] ?? record.manifest.sourceCommitSha;
    const committed = baseCommit === null ? null : gitShow(repo, baseCommit, path);
    const moved = current === null || sha256(current) !== original;
    return {
      moved,
      // `--3way` finds the base by its blob id, which only a committed
      // base has; nothing is ever written to the repository's objects.
      threeWay: committed !== null && sha256(committed) === original,
      bytes: moved ? committed : current,
    };
  };
  const baseOf = (path: string, original: string) => {
    const base = readBase(path, original);
    if (base.moved) drifted.push(path);
    if (!base.threeWay) noThreeWay.push(path);
    return base.bytes;
  };
  /** Whether two of the file's specifiers were rewritten to one. */
  const ambiguous = (rewrites: readonly ImportRewrite[]) =>
    new Set(rewrites.map((rewrite) => rewrite.to)).size <
    new Set(rewrites.map((rewrite) => `${rewrite.to}\n${rewrite.from}`)).size;
  try {
    for (const path of tree) {
      if (
        path === RECORD_PATH ||
        path === "package-lock.json" ||
        // The folder's .gitignore is the contributor's to edit: it hides
        // build output, never a slice file's or a generated file's edit.
        (ignored.has(path) && !included.has(path) && !generated.has(path) && (emitted(path) || buildOutput(path, present) || (skipped.push(path), true)))
      )
        continue;
      const bytes = await readFile(join(root, path));
      const text = bytes.toString("utf8");
      const hash = generated.get(path);
      if (hash !== undefined) {
        if (sha256(text) !== hash) {
          generatedEdits.push(path);
          const edit = boundaryEdit(root, path, record, stubFiles, trusted.receipt?.generatedText?.["package.json"]);
          if (edit !== null) boundary.push(edit);
        }
        continue;
      }
      const original = included.get(path);
      if (original === undefined) {
        if (path.startsWith("carveout/")) {
          if (!buildOutput(path, present) && !emitted(path)) skipped.push(path);
          continue;
        }
        if (emitted(path)) continue;
        let content: Buffer = bytes;
        if (isScript(path)) {
          const restored = restoreImports(path, text, null, [], context);
          if (harnessImport(path, restored.text)) {
            sliceOnly.push(path);
            continue;
          }
          for (const specifier of restored.crossPackage)
            crossPackage.push({ file: path, specifier });
          content = Buffer.from(restored.text);
        }
        // A new script's reach is judged on its text: new code runs beside
        // the whole repository once the patch is applied.
        if (!admits(path, "added", isBinaryPath(path) ? undefined : { before: null, after: content.toString("utf8") }))
          continue;
        // A new file where the repository already holds one the slice did
        // not (the owner's acceptance test, kept out of every cut): as a new
        // file, `git apply --3way` stops on it. A test goes in beside it under
        // a free name; any other file is held for the owner to place.
        let target = path;
        if (repositoryHolds(path)) {
          if (!isTestPath(path)) {
            refused.push({
              path,
              reason:
                "the repository already holds a file at this path that the slice did not (one of the owner's, kept out of the cut); the folder's new file would overwrite it: rename it, or read both and pass --allow",
            });
            continue;
          }
          target = contributedPath(path, (candidate) => present.has(candidate) || added.includes(candidate) || repositoryHolds(candidate));
          renamed.push({ from: path, to: target });
        }
        added.push(target);
        await mkdir(dirname(join(scratch, "b", target)), { recursive: true });
        await writeFile(join(scratch, "b", target), content);
        continue;
      }
      const rewrites = rewritesOf.get(path) ?? [];
      if (isBinaryPath(path)) {
        if (sha256(bytes) === original) continue;
      } else if (
        sha256(
          undoRewrites(
            text,
            rewrites,
            ambiguous(rewrites)
              ? (readBase(path, original).bytes?.toString("utf8") ?? null)
              : null,
            path,
          ),
        ) === original
      )
        continue;
      const base = baseOf(path, original);
      let restored: Buffer = bytes;
      if (!isBinaryPath(path) && isScript(path)) {
        const result = restoreImports(
          path,
          text,
          base === null ? null : base.toString("utf8"),
          rewrites,
          context,
        );
        if (sha256(result.text) === original) continue;
        if (harnessImport(path, result.text)) {
          sliceOnly.push(path);
          continue;
        }
        for (const specifier of result.crossPackage)
          crossPackage.push({ file: path, specifier });
        restored = Buffer.from(result.text);
      }
      if (
        !admits(
          path,
          "changed",
          isBinaryPath(path)
            ? undefined
            : { before: base === null ? null : base.toString("utf8"), after: restored.toString("utf8") },
        )
      )
        continue;
      changed.push(path);
      await mkdir(dirname(join(scratch, "a", path)), { recursive: true });
      await mkdir(dirname(join(scratch, "b", path)), { recursive: true });
      await writeFile(join(scratch, "a", path), base ?? "");
      await writeFile(join(scratch, "b", path), restored);
    }
    for (const [path, original] of [...included.entries()].sort(([a], [b]) =>
      compare(a, b),
    )) {
      if (present.has(path)) continue;
      if (!admits(path, "deleted")) continue;
      deleted.push(path);
      const base = baseOf(path, original);
      await mkdir(dirname(join(scratch, "a", path)), { recursive: true });
      await writeFile(join(scratch, "a", path), base ?? "");
    }
    // A package the folder added goes into the repository's package file by
    // hand: name the file, from where the edits import it, so the patch
    // applies onto a repository that installs it.
    for (const [index, edit] of boundary.entries()) {
      if (edit.added === undefined) continue;
      const where = edit.added.map((item) => {
        const dirs = [...new Set([...(importedBy.get(item.name) ?? [])].map((path) => packageOf(path)))].sort(compare);
        const files = dirs.map((dir) => (dir === "" ? "package.json" : `${dir}/package.json`));
        return `${dependencyText(item)} ${files.length === 0 ? "to the package that needs it" : `to ${files.join(" and ")}`}`;
      });
      boundary[index] = {
        ...edit,
        detail: `${edit.detail} Add ${where.join("; ")} before applying, then pass --allow for the files that import it.`,
      };
    }
    let diff = "";
    if (changed.length + added.length + deleted.length > 0) {
      // A scratch repository holding the bases, with the edits staged on
      // top: its diff names every path as the repository does.
      const repoDir = join(scratch, "repo");
      const run = (args: readonly string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=carveout",
            "-c",
            "user.email=carveout@localhost",
            "-c",
            "core.autocrlf=false",
            ...args,
          ],
          {
            cwd: repoDir,
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 256 * 1024 * 1024,
          },
        ).toString("utf8");
      await mkdir(repoDir, { recursive: true });
      run(["init", "-q"]);
      // A file that is not UTF-8 goes as a binary patch: as text, the diff
      // would carry its bytes through a string and lose them.
      const opaque = [...changed, ...added, ...deleted].filter((path) => {
        for (const side of ["a", "b"]) {
          const at = join(scratch, side, path);
          if (existsSync(at) && !isTextContent(readFileSync(at))) return true;
        }
        return false;
      });
      if (opaque.length > 0)
        await writeFile(join(repoDir, ".git", "info", "attributes"), `${opaque.map((path) => `/${path.replace(/ /g, "[[:space:]]")} binary`).join("\n")}\n`);
      for (const path of [...changed, ...deleted]) {
        await mkdir(dirname(join(repoDir, path)), { recursive: true });
        await writeFile(join(repoDir, path), readFileSync(join(scratch, "a", path)));
      }
      run(["add", "-A"]);
      run(["commit", "-q", "--allow-empty", "-m", "base"]);
      for (const path of [...changed, ...added]) {
        await mkdir(dirname(join(repoDir, path)), { recursive: true });
        await writeFile(join(repoDir, path), readFileSync(join(scratch, "b", path)));
      }
      for (const path of deleted) await rm(join(repoDir, path));
      run(["add", "-A"]);
      // Full blob ids on the index lines: `git apply --3way` merges with
      // them against the commit the cut read when the file has moved. A
      // rename is a deletion and an addition, which `--3way` takes.
      diff = run([
        "diff",
        "--cached",
        "--no-color",
        "--no-renames",
        "--binary",
        "--full-index",
      ]);
    }
    return {
      diff,
      changed,
      added,
      deleted,
      generatedEdits,
      boundary,
      sliceOnly,
      crossPackage,
      drifted,
      noThreeWay,
      refused,
      recordFrom: trusted.receipt === null ? "folder" : "receipt",
      skipped,
      ...(renamed.length === 0 ? {} : { renamed }),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
