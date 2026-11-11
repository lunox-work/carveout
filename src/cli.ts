#!/usr/bin/env node
/**
 * carveout <command>: plan, cut, check and patch slices of a repository.
 * Exit codes: 0 done, 1 refused or failed, 2 written with blockers (cut)
 * or a step failed (check, merge), 3 nothing to patch, 4 stale (status),
 * 5 the edits reach past the slice (patch, merge), 6 the hand-off policy
 * kept files out of the patch (patch, merge) or held a change (gate), 7 the
 * folder's edits and an applied change overlap (apply).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CARVEOUT_VERSION,
  carveoutHome,
  checkProject,
  cutSlice,
  patchProject,
  planSlice,
  readRecord,
  readRepoConfig,
  type CarveoutRecord,
  type CheckStep,
  type TestCounts,
} from "./carve.js";
import {
  SLICE_BUDGET_DEFAULTS,
  TEST_LEFT_REASON,
  renderExposure,
  renderOutside,
  testsVerdict,
  type DependencyChoice,
} from "./core.js";
import { gateRepository } from "./gate.js";
import { impactOf, runImpactTests } from "./impact.js";
import { applyPatch, mergeProject, refreshProject, widenProject } from "./mergeback.js";
import { statusProject } from "./status.js";
import { hasAdvice, renderReadiness } from "./readiness.js";
import { trustedCut, writeReceipt } from "./receipt.js";

const USAGE = `carveout ${CARVEOUT_VERSION}: carve a slice out of a TypeScript repository.

  carveout handoff <entry>... --out <dir> [--task <file|text>] [--depth N] [--max-files N]
                 [--private <path>]... [--name <word>]... [--copy <dir>]... [--live <pkg>]...
                 [--accept <test>...] [--no-whole-package] [--no-copy-pure] [--receipt <file>] [--json]
      The hand-off in one step: a cut with the tests that run the code, its
      whole package and the pure code it runs, for someone outside (public,
      in pseudonyms), and its check. Prints whether the folder is ready (its
      tests pass before any edit), what it shows, the receipt to keep, and
      what to send. --task writes TASK.md: the work, and when it is accepted.
      Exits 0 only when the folder is ready to hand over.

  carveout plan  <entry>... [--repo <dir>] [--max-files N] [--depth N]
                 [--with-tests] [--whole-package] [--follow-workspaces]
                 [--copy-pure] [--private <path>]... [--json]
      What a cut would hold, from the import graph alone. Writes nothing.

  carveout cut   <entry>... --out <dir> [--repo <dir>] [--max-files N] [--depth N]
                 [--with-tests] [--whole-package] [--follow-workspaces]
                 [--copy-pure] [--private <path>]... [--copy <dir>]...
                 [--mock <package>]...
                 [--install <package>]... [--live <package>]... [--offline]
                 [--widen-literals] [--public] [--name <word>]... [--keep-names] [--task <file|text>]
                 [--receipt <file> | --no-receipt] [--json]
      Copies the slice to <dir> at its repository paths, with a .d.ts stub and a
      recording mock for every module it imports from outside, mock packages for
      what it does not install, package.json, tsconfig.json and a lockfile.
      Writes nothing when a file it would write holds a credential. --public
      makes a folder for someone outside: literals widened, and neither the
      checkout's path nor the files outside the slice that import it named.
      Writes the maintainer's receipt to ~/.carveout/receipts/<cut id>.json
      (or --receipt <file>): the record the folder that comes back is judged
      by, which a public folder's own record leaves the repository's names to.
      A public folder is written in pseudonyms: the names the repository goes
      by (its packages', its owner's, its remote's, --name and "names" in the
      configuration) renamed under a table the receipt keeps, and patch
      renames the folder back. --keep-names writes it in the repository's
      names; a name left in the folder is a blocker either way.

  carveout check <dir> [--in-place] [--isolated] [--accept <test>...] [--receipt <file>] [--json]
      npm ci, npm run build and npm test in a scratch copy of <dir>. --isolated,
      for a folder that came back from someone else: a scratch HOME and npm
      cache and no install scripts (not a sandbox).

  carveout status <dir> [--repo <checkout>] [--receipt <file>] [--json]
      Whether <dir> still matches the repository, and what changed if not.

  carveout patch <dir> [--repo <checkout>] [--allow <path>]... [--receipt <file>]
                 [--output <file>] [--json]
      The edits made in <dir> as a patch for the repository (git apply). Runs
      none of the folder's code. Keeps out, and names, new files outside the
      slice's packages, protected paths (CI, hooks, manifests, lockfiles,
      environment) and deleted tests; --allow <path|glob> lets one through.

  carveout apply <dir> <patch-file> [--repo <checkout>] [--stubs] [--receipt <file>] [--json]
      Brings a patch for the repository at the cut's commit into <dir>, with its
      imports rewritten as a cut writes them. --stubs also writes the stubs the
      change needs from the modules the slice cuts.

  carveout refresh <dir> [--resolved <path>...] [--repo <checkout>] [--receipt <file>] [--json]
      The repository's commits since the cut, brought into the folder: the
      change in the slice's packages and the modules it stubs, merged into
      the folder's own edits (an overlap is left, and named: exit 7).

  carveout widen <dir> --entry <path>... [--out <dir>] [--depth N] [--max-files N]
                 [--allow <path>]... [--receipt <file>] [--json]
      The folder cut again with more entry points, every other bound as it
      was, and the contributor's work so far carried into it: for a change
      that needs a module the slice cut. A public folder keeps its names.

  carveout merge <dir> --into <checkout> [--verify <command>] [--verify-env <name>]...
                 [--allow <path>]... [--receipt <file>] [--json]
      patch, then git apply --3way in <checkout>, then <command> at its root,
      with a scratch HOME and only the environment variables named. Applies
      nothing while the hand-off policy keeps a file out.

  carveout gate  [--repo <dir>] [--base <ref>] [--scope <path>]... [--allow <path>]...
                 [--hook] [--json]
      Judges the change from <ref> (default HEAD) to the working tree, made in
      the repository itself: protected paths, deleted or weakened tests (an
      assertion removed or rewritten, a test skipped or focused with .only),
      check configuration edited, suppressions added (@ts-ignore,
      eslint-disable), and with --scope, files outside it. Exits 6 on any.
      --hook: for a Claude Code Stop hook, exits 2 with the findings on stderr,
      once per stop.

  carveout impact [<file>...] [--repo <dir>] [--base <ref>] [--depth N] [--run] [--json]
      What the change from <ref> (default HEAD) to the working tree reaches, or
      the files named: every file that imports a changed module, directly or
      through others; each export whose type changed or that is gone, and who
      takes it; the tests among the importers, and the commands that run just
      them. --depth bounds the hops (default: all). --run runs those commands
      in the repository, one at a time, with your environment; exits 2 if one
      fails. Without --run nothing of the repository is run.

  carveout where
      The folder fetched package types are cached in (CARVEOUT_HOME).

An entry point is a file or a directory, relative to --repo (default: the
current directory, which should be the repository's root). Defaults:
--max-files ${SLICE_BUDGET_DEFAULTS.maxFiles}, --depth ${SLICE_BUDGET_DEFAULTS.maxDepth}.

--whole-package copies every file of the entry points' package the walk
reaches, at any depth, so the cut falls at package and service boundaries.
--follow-workspaces follows an import of the repository's own packages into
their source instead of stubbing the package. --copy-pure copies the pure code
the slice runs (validators, error classes, formatters, in any package)
instead of mocking it, so its tests run against the real code; it follows the
workspaces too. --private <path> keeps a file
or folder (or glob) out of every slice: stubbed wherever reached, literals
widened. --copy <dir> copies a folder the code reads by name (migrations).
A carveout.config.json at the repository's root sets the same for every cut.
`;

/**
 * A run's counts as a sentence: the folder's tests (node:test's and
 * Vitest's), then carveout's own checks of the public surface, which are
 * no test of the work's.
 */
function countsSentence(counts: TestCounts | undefined, edited: boolean): string {
  if (counts === undefined) return "";
  // A runner with no test of the folder's (node:test's only file the interface test) is left out.
  const runners = Object.entries(counts.runners ?? {}).filter(([, each]) => each.tests > 0);
  const label = (runner: string) => (runner === "vitest" ? "Vitest" : runner);
  const by =
    runners.length > 1
      ? ` (${runners.map(([runner, each]) => `${label(runner)} ${each.pass} of ${each.tests}`).join(", ")})`
      : runners.length === 1
        ? ` (${label(runners[0]?.[0] ?? "")})`
        : "";
  const tests =
    counts.tests === 0 && counts.surface !== undefined
      ? ""
      : ` ${counts.pass} of ${counts.tests} test(s) pass${edited ? "" : " before any edit"}${by}.`;
  const surface =
    counts.surface === undefined
      ? ""
      : ` ${counts.surface.checks - counts.surface.fail} of ${counts.surface.checks} check(s) that the public surface keeps its exports and types hold.`;
  return `${tests}${surface}`;
}

/** What a check says of a folder as a hand-off: whether "make the tests pass" is a task someone can finish there. */
function verdictOf(
  steps: readonly CheckStep[],
  record: CarveoutRecord,
): {
  readonly ok: boolean;
  readonly handoff: "blocked" | "ready" | "red-baseline" | "no-tests" | "failed";
  readonly counts?: TestCounts;
  readonly baseline?: readonly string[];
  readonly carried: number;
} {
  const own = steps.filter((step) => step.command !== "accept");
  const ok = own.length === 3 && own.every((step) => step.ok);
  const testStep = steps.find((step) => step.command === "npm test");
  const baseline = testStep?.baselineInEffect !== undefined && testStep.baselineInEffect.length > 0 ? testStep.baselineInEffect : undefined;
  const counts = testStep?.counts;
  const carried = record.tests?.carried.length ?? 0;
  return {
    ok,
    // A cut with blockers (a name left in the folder, a stub it could not
    // write) is not ready whatever its tests say.
    handoff: !record.ready ? "blocked" : !ok ? "failed" : baseline !== undefined ? "red-baseline" : carried === 0 ? "no-tests" : "ready",
    ...(counts === undefined ? {} : { counts }),
    ...(baseline === undefined ? {} : { baseline }),
    carried,
  };
}

/** The owner's acceptance tests, by their paths in the repository (`--accept`). */
function acceptOption(files: readonly string[] | undefined, repo: string | undefined): { path: string; text: string }[] {
  const root = resolve(repo ?? ".");
  return (files ?? []).map((file) => {
    const at = resolve(file);
    const path = relative(root, at).split("\\").join("/");
    if (path.startsWith("..") || !existsSync(at))
      fail(`--accept ${file}: give a test file inside the repository (run from its root, or pass --repo), at the path it would have there.`);
    return { path, text: readFileSync(at, "utf8") };
  });
}

/** What a command wrote into a folder in pseudonyms that still names the repository: for the maintainer, in full. */
function leaksText(leaks: readonly { readonly term: string; readonly files: readonly string[] }[]): string {
  return `The folder now holds names the repository goes by; do not send it as it is (rename them, or cut again):\n${list(
    leaks.map(({ term, files }) => `${term}: ${files.join(", ")}`),
  )}\n`;
}

/** Slice files a command left unwritten: in the folder's names they would not map back. */
function unmappedText(paths: readonly string[]): string {
  return `Not written, left as the folder had them: in the folder's names their text would not map back to the repository's byte for byte (a mixed-case name, a placeholder word the repository's text holds), so a patch would rewrite it. Cut again to take them:\n${list(paths)}\n`;
}

function fail(message: string): never {
  process.stderr.write(`carveout: ${message}\n`);
  process.exit(1);
}

function integer(value: string | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    fail(`--${name} takes a whole number, not ${value}.`);
  return parsed;
}

const list = (items: readonly string[], empty = "  (none)") =>
  items.length === 0 ? empty : items.map((item) => `  ${item}`).join("\n");

async function main(argv: readonly string[]) {
  const [commandName, ...rest] = argv;
  if (
    commandName === undefined ||
    commandName === "help" ||
    commandName === "--help" ||
    commandName === "-h"
  ) {
    process.stdout.write(USAGE);
    return;
  }
  if (commandName === "--version" || commandName === "version") {
    process.stdout.write(`${CARVEOUT_VERSION}\n`);
    return;
  }
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    // `--no-whole-package`, `--no-copy-pure`, `--no-public`: handoff's
    // defaults turned off by name.
    allowNegative: true,
    options: {
      repo: { type: "string" },
      out: { type: "string" },
      output: { type: "string" },
      "max-files": { type: "string" },
      depth: { type: "string" },
      mock: { type: "string", multiple: true },
      install: { type: "string", multiple: true },
      live: { type: "string", multiple: true },
      offline: { type: "boolean" },
      "widen-literals": { type: "boolean" },
      "with-tests": { type: "boolean" },
      "whole-package": { type: "boolean" },
      "follow-workspaces": { type: "boolean" },
      "copy-pure": { type: "boolean" },
      private: { type: "string", multiple: true },
      copy: { type: "string", multiple: true },
      "in-place": { type: "boolean" },
      accept: { type: "string", multiple: true },
      resolved: { type: "string", multiple: true },
      stubs: { type: "boolean" },
      into: { type: "string" },
      verify: { type: "string" },
      "verify-env": { type: "string", multiple: true },
      allow: { type: "string", multiple: true },
      public: { type: "boolean" },
      isolated: { type: "boolean" },
      base: { type: "string" },
      scope: { type: "string", multiple: true },
      hook: { type: "boolean" },
      run: { type: "boolean" },
      json: { type: "boolean" },
      receipt: { type: "string" },
      "no-receipt": { type: "boolean" },
      name: { type: "string", multiple: true },
      "keep-names": { type: "boolean" },
      task: { type: "string" },
      entry: { type: "string", multiple: true },
    },
  });
  // With negated flags read, `--no-receipt` comes back as `receipt: false`
  // rather than as its own flag: the same thing, said one way.
  {
    const parsed = values as Record<string, unknown>;
    if (parsed["receipt"] === false) {
      delete parsed["receipt"];
      parsed["no-receipt"] = true;
    }
  }
  const budget = {
    maxFiles: integer(
      values["max-files"],
      "max-files",
      SLICE_BUDGET_DEFAULTS.maxFiles,
    ),
    maxDepth: integer(values.depth, "depth", SLICE_BUDGET_DEFAULTS.maxDepth),
  };
  const repo = resolve(values.repo ?? ".");
  const print = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  // Only a flag given overrides the repository's configuration.
  /**
   * The checkout a folder's command works against: `--repo` when given;
   * else the record's, or the current directory when the record names none
   * (a public cut). The library checks it holds the cut's commit.
   */
  const repoFor = (dir: string): string | undefined => {
    if (values.repo !== undefined) return repo;
    let named: string | undefined;
    try {
      named = trustedCut(dir, values.receipt, { optional: true }).record.repo;
    } catch {
      named = readRecord(dir).repo;
    }
    return named === undefined ? repo : undefined;
  };
  /** `--mock`, `--install` and `--live` as the cut's dependency choices, refused when they clash. */
  const dependencyChoices = (): Record<string, DependencyChoice> => {
    const choices: Record<string, DependencyChoice> = {};
    for (const name of values.mock ?? []) choices[name] = "runtime-mock";
    for (const name of values.install ?? []) {
      if (choices[name] !== undefined) fail(`${name} is given to both --mock and --install.`);
      choices[name] = "approved-package";
    }
    for (const name of values.live ?? [])
      if (choices[name] === "runtime-mock") fail(`${name} is given to both --mock and --live.`);
    return choices;
  };
  /** `--task`: a file's text, or the text given. */
  const taskOption = () =>
    values.task === undefined
      ? {}
      : { task: existsSync(values.task) && statSync(values.task).isFile() ? readFileSync(values.task, "utf8") : values.task };
  /** The receipt a folder's command was given, as an option; or none, by `--no-receipt`. */
  const receiptOption = {
    ...(values.receipt === undefined ? {} : { receipt: values.receipt }),
    ...(values["no-receipt"] === true ? { noReceipt: true } : {}),
  };
  const bounds = {
    ...(values["whole-package"] === true ? { wholePackage: true } : {}),
    ...(values["follow-workspaces"] === true ? { followWorkspaces: true } : {}),
    ...(values["copy-pure"] === true ? { copyPure: true } : {}),
    ...(values.private === undefined ? {} : { private: values.private }),
  };

  switch (commandName) {
    case "where":
      process.stdout.write(`${carveoutHome()}\n`);
      return;

    case "plan": {
      if (positionals.length === 0) fail("plan needs at least one entry point.");
      const plan = planSlice({
        repo,
        entryPoints: positionals,
        budget,
        tests: values["with-tests"] === true,
        ...bounds,
      });
      if (values.json === true) {
        print({
          repo: plan.repo,
          entryPoints: plan.entryPoints,
          unknownEntryPoints: plan.walk.unknownEntryPoints,
          budget: plan.budget,
          wholePackage: plan.wholePackage,
          followWorkspaces: plan.followWorkspaces,
          copyPure: plan.copyPure,
          private: plan.private,
          included: plan.walk.included,
          depthOf: plan.walk.depthOf,
          dropped: plan.walk.dropped,
          privateFiles: plan.walk.privateFiles,
          pure: plan.walk.pure,
          tests: plan.walk.tests,
          helpers: plan.walk.helpers,
          untestable: plan.walk.untestable,
          testsLeft: plan.walk.testsLeft,
          testsVerdict: testsVerdict(plan.walk),
          originOf: plan.walk.originOf,
          exposure: plan.exposure,
          cutModules: plan.cutModules,
          typeOnlyCuts: plan.typeOnlyCuts,
          inbound: [...new Set(plan.walk.cuts.inbound.map((e) => e.from))].sort(),
          packages: plan.packages,
          workspacePackages: plan.workspacePackages,
          externals: plan.externals,
          dependencies: plan.walk.dependencies.filter(
            (dependency) => dependency.status !== "external",
          ),
          secretFiles: plan.secretFiles,
        });
        return;
      }
      const atLimit = plan.walk.dropped.length > 0;
      const importers = [
        ...new Set(plan.walk.cuts.inbound.map((edge) => edge.from)),
      ].sort();
      const broken = plan.walk.dependencies.filter(
        (dependency) => dependency.status !== "external",
      );
      const readsCut = plan.walk.cuts.outbound.filter(
        (edge) => edge.relation === "reads",
      );
      process.stdout.write(
        [
          `${plan.walk.included.length} files from ${plan.entryPoints.join(", ")} (budget ${plan.budget.maxFiles} files, depth ${plan.budget.maxDepth}${plan.wholePackage ? ", the whole package" : ""}${plan.followWorkspaces ? ", workspace packages followed" : ""}${plan.copyPure ? ", pure code copied" : ""}; ${plan.graphFiles} script files read)${atLimit ? ", at the file limit: raise --max-files or narrow the entry points" : ""}.`,
          "",
          `Shows ${renderExposure(plan.exposure)}`,
          "",
          ...(renderOutside(plan.exposure).length === 0 ? [] : [...renderOutside(plan.exposure), ""]),
          "Included:",
          list(
            plan.walk.included.map(
              (path) => `${path}  (depth ${plan.walk.depthOf[path] ?? 0})`,
            ),
          ),
          "",
          ...(plan.walk.pure.length === 0
            ? []
            : [
                "Pure code copied rather than mocked (the contributor reads it):",
                list(plan.walk.pure),
                "",
              ]),
          ...(atLimit
            ? [
                "Left out by the file limit, cut instead:",
                list(plan.walk.dropped),
                "",
              ]
            : []),
          "Tests:",
          `  ${testsVerdict(plan.walk)}`,
          `  Counted: tests that import the slice, directly or through barrels. Tests that reach it through other code are not: carveout impact ${plan.entryPoints.join(" ")} lists those too.`,
          ...(plan.walk.tests.length === 0
            ? []
            : [
                "",
                "Tests brought along:",
                list(plan.walk.tests),
                ...(plan.walk.helpers.length === 0
                  ? []
                  : ["", "Their helpers, copied with them:", list(plan.walk.helpers)]),
              ]),
          ...(plan.walk.testsLeft.length === 0
            ? []
            : [
                "",
                "Tests that run this code and stay in the repository:",
                list(
                  plan.walk.testsLeft.map(
                    ({ file, reason }) => `${file}  (${TEST_LEFT_REASON[reason]})`,
                  ),
                ),
              ]),
          "",
          "Cut, becomes a stub and a mock:",
          list(
            plan.cutModules.map((path) =>
              plan.typeOnlyCuts.includes(path) ? `${path} (types only)` : path,
            ),
          ),
          "",
          ...(plan.walk.privateFiles.length === 0
            ? []
            : ["Of those, kept private (never copied):", list(plan.walk.privateFiles), ""]),
          "Imported by code outside the slice:",
          list(importers),
          "",
          "Packages:",
          list(
            plan.packages.map((name) =>
              plan.workspacePackages.includes(name)
                ? `${name} (this repository's own: stubbed from its source)`
                : name,
            ),
          ),
          "",
          "Services and environment:",
          list([
            ...plan.externals.packages.map(
              (item) => `${item.specifier} (${item.service})`,
            ),
            ...plan.externals.environment.map((item) => `$${item.name}`),
          ]),
          ...(plan.walk.unknownEntryPoints.length +
            broken.length +
            readsCut.length +
            plan.secretFiles.length ===
          0
            ? []
            : [
                "",
                "Blockers:",
                list([
                  ...plan.walk.unknownEntryPoints.map(
                    (entry) => `${entry}: names no script file in the repository`,
                  ),
                  ...broken.map(
                    (dependency) =>
                      `${dependency.file}${dependency.location === null ? "" : `:${dependency.location.slice(1)}`}: ${dependency.status === "dynamic" ? "dynamic import of a computed name" : dependency.status === "path" ? `reads ${dependency.specifier ?? ""} by path, which a slice cannot copy` : `${dependency.specifier ?? ""} resolves to no file`}`,
                  ),
                  ...readsCut.map(
                    (edge) =>
                      `${edge.from}${edge.location === null ? "" : `:${edge.location.slice(1)}`}: reads ${edge.to} by path, and it is outside the slice`,
                  ),
                  ...plan.secretFiles.map(
                    (path) => `${path}: a credentials file is never copied`,
                  ),
                ]),
              ]),
          "",
        ].join("\n"),
      );
      return;
    }

    case "handoff": {
      if (positionals.length === 0) fail("handoff needs at least one entry point.");
      if (values.out === undefined) fail("handoff needs --out <dir>.");
      // The hand-off's own defaults, unless a flag or the owner's
      // configuration says otherwise: the tests that run the code, its
      // whole package, the pure code it runs, and a folder for someone
      // outside, in pseudonyms.
      const config = readRepoConfig(repo);
      // The owner's acceptance tests are never sent: a test that imports the
      // slice would otherwise come with --with-tests, from the working tree.
      const accepted = acceptOption(values.accept, values.repo);
      const result = await cutSlice({
        repo,
        out: values.out,
        entryPoints: positionals,
        budget,
        choices: dependencyChoices(),
        ...(values.live === undefined ? {} : { live: values.live }),
        tests: values["with-tests"] ?? true,
        wholePackage: values["whole-package"] ?? config.wholePackage ?? true,
        copyPure: values["copy-pure"] ?? config.copyPure ?? true,
        ...(values["follow-workspaces"] === true ? { followWorkspaces: true } : {}),
        ...(values.private === undefined ? {} : { private: values.private }),
        ...(accepted.length === 0 ? {} : { unseen: accepted.map((test) => test.path) }),
        public: values.public ?? config.public ?? true,
        ...(values.offline === true ? { offline: true } : {}),
        ...(values.copy === undefined ? {} : { copy: values.copy }),
        ...(values["no-receipt"] === true ? { receipt: false as const } : values.receipt === undefined ? {} : { receipt: values.receipt }),
        ...(values.name === undefined ? {} : { names: values.name }),
        ...(values["keep-names"] === true ? { pseudonyms: false } : {}),
        ...taskOption(),
        log: (line) => {
          if (values.json !== true) process.stderr.write(`${line}\n`);
        },
      });
      const steps = await checkProject(result.out, {
        ...(result.receipt === null ? { noReceipt: true } : { receipt: result.receipt }),
      });
      // The owner's acceptance tests on the folder as it goes out: they
      // should not pass before the work, or they test nothing of it.
      const preSteps =
        accepted.length === 0 || steps.some((step) => !step.ok)
          ? null
          : await checkProject(result.out, {
              ...(result.receipt === null ? { noReceipt: true } : { receipt: result.receipt }),
              accept: accepted,
            });
      // The acceptance tests' own verdict: the folder's tests are judged apart.
      const vacuous = preSteps === null ? null : preSteps.find((step) => step.command === "accept")?.ok === true;
      // A build that fails on an acceptance test itself (an import it makes
      // that the folder lacks) is no failure of the work's.
      const unbuilt =
        preSteps === null || preSteps.some((step) => step.command === "accept")
          ? undefined
          : preSteps
              .find((step) => !step.ok)
              ?.output.split("\n")
              // A module it imports that is not there (TS2307), not a name
              // the work is yet to add (TS2305, TS2339: failing as it should).
              .find((line) => /TS2307/.test(line) && accepted.some((test) => line.includes(test.path)));
      const verdict = verdictOf(steps, result.record);
      const record = result.record;
      // The step that failed, and what it printed last: what to fix first.
      const failedStep = steps.find((step) => !step.ok);
      if (values.json === true)
        print({
          out: result.out,
          ready: verdict.handoff === "ready",
          handoff: verdict.handoff,
          counts: verdict.counts ?? null,
          baseline: verdict.baseline ?? [],
          blockers: record.blockers,
          exposure: record.exposure ?? null,
          pseudonyms: result.pseudonyms === null ? null : { renames: result.pseudonyms.rules.length, kept: result.pseudonyms.kept },
          readiness: result.readiness,
          receipt: result.receipt,
          // The owner's acceptance tests on the folder as it goes out.
          acceptance: vacuous === null ? null : vacuous ? "pass-before-the-work" : "fail-before-the-work",
          steps,
        });
      else {
        const lines = [
          `Hand-off folder: ${result.out}`,
          `  Verdict: ${
            !record.ready
              ? "not ready: the cut has blockers (below)"
              : verdict.handoff === "ready"
                ? "ready: it installs, builds, and its tests pass before any edit"
                : verdict.handoff === "red-baseline"
                  ? `its tests run, but ${verdict.baseline?.length ?? 0} fail on the mocks before any edit (not counted)`
                  : verdict.handoff === "no-tests"
                    ? "it builds, but no test of this code came with it: write the tests the work must pass"
                    : `it does not ${failedStep === undefined ? "install, build or test" : failedStep.command} on its own (below)`
          }`,
          ...(verdict.counts === undefined
            ? []
            : [`  ${verdict.counts.tests === 0 && verdict.counts.surface !== undefined ? "Checks" : "Tests"}:${countsSentence(verdict.counts, false)}`]),
          ...(record.exposure === undefined ? [] : [`  Shows ${renderExposure(record.exposure)}`]),
          `  Names: ${
            result.pseudonyms === null
              ? record.request.public === true
                ? "in the repository's own (--keep-names or no receipt)"
                : "in the repository's own (not public)"
              : result.pseudonyms.rules.length === 0
                ? "none of the repository's is in the folder"
                : `${result.pseudonyms.rules.length} rename(s) hide the repository's; the receipt keeps the table`
          }.`,
          ...(record.blockers.length === 0
            ? []
            : ["", "Blockers:", list(record.blockers.map((b) => `${b.code}${b.file === null ? "" : ` ${b.file}`}: ${b.detail}`))]),
          ...(verdict.handoff === "red-baseline" && hasAdvice(result.readiness)
            ? ["", "To run those on real code, cut again with:", ...renderReadiness(result.readiness)]
            : []),
          ...(failedStep === undefined
            ? []
            : ["", `${failedStep.command} failed; its last lines:`, ...failedStep.output.trim().split("\n").slice(-25).map((line) => `  ${line}`)]),
          ...(vacuous === null
            ? []
            : [
                "",
                vacuous
                  ? `The owner's ${accepted.length} acceptance test file(s) already pass on the folder as it goes out: they test nothing of the work (or it is done). Make them fail before it.`
                  : unbuilt !== undefined
                    ? `The owner's acceptance tests do not build in the folder, whatever the work does: ${unbuilt.trim()}. Import what they test by a relative path the folder holds, and run handoff again.`
                    : `The owner's ${accepted.length} acceptance test file(s) fail on the folder as it goes out, as they should before the work; keep them, and run them on the folder that comes back with carveout check --accept.`,
              ]),
          "",
          result.receipt === null
            ? "No receipt: the folder that comes back will be judged by its own record (--no-receipt on patch)."
            : `Receipt: ${result.receipt}\n  Keep it, and never send it: the folder that comes back is judged by it.`,
          `Send the folder without node_modules: (cd ${dirname(result.out)} && zip -qr ${basename(result.out)}.zip ${basename(result.out)} -x '*/node_modules/*')`,
          "When it comes back, from the repository's root: carveout patch <returned folder> --output change.patch; read all of it; then git apply --3way change.patch on a branch, and let CI decide.",
          "",
        ];
        process.stdout.write(lines.join("\n"));
      }
      // Acceptance tests that pass before the work would accept anything.
      if (!record.ready || verdict.handoff !== "ready" || vacuous === true) process.exitCode = 2;
      return;
    }

    case "cut": {
      if (positionals.length === 0) fail("cut needs at least one entry point.");
      if (values.out === undefined) fail("cut needs --out <dir>.");
      const choices: Record<string, DependencyChoice> = {};
      for (const name of values.mock ?? []) choices[name] = "runtime-mock";
      for (const name of values.install ?? []) {
        if (choices[name] !== undefined)
          fail(`${name} is given to both --mock and --install.`);
        choices[name] = "approved-package";
      }
      for (const name of values.live ?? [])
        if (choices[name] === "runtime-mock")
          fail(`${name} is given to both --mock and --live.`);
      const result = await cutSlice({
        repo,
        out: values.out,
        entryPoints: positionals,
        budget,
        choices,
        ...(values.live === undefined ? {} : { live: values.live }),
        ...(values["with-tests"] === true ? { tests: true } : {}),
        ...(values.offline === true ? { offline: true } : {}),
        ...(values["widen-literals"] === true ? { widenLiterals: true } : {}),
        ...(values.public === true ? { public: true } : {}),
        ...bounds,
        ...(values.copy === undefined ? {} : { copy: values.copy }),
        ...(values["no-receipt"] === true ? { receipt: false as const } : values.receipt === undefined ? {} : { receipt: values.receipt }),
        ...(values.name === undefined ? {} : { names: values.name }),
        ...(values["keep-names"] === true ? { pseudonyms: false } : {}),
        ...taskOption(),
        log: (line) => {
          if (values.json !== true) process.stderr.write(`${line}\n`);
        },
      });
      const { record } = result;
      if (values.json === true)
        print({
          out: result.out,
          ready: record.ready,
          meta: record.manifest.meta,
          blockers: record.blockers,
          dependencies: record.dependencies,
          optionalPeers: record.optionalPeers,
          importRewrites: record.importRewrites,
          tests: record.tests,
          readiness: result.readiness,
          receipt: result.receipt,
          pseudonyms:
            result.pseudonyms === null
              ? null
              : { renames: result.pseudonyms.rules.length, kept: result.pseudonyms.kept },
        });
      else {
        const mocked = record.dependencies
          .filter((d) => d.resolution === "runtime-mock")
          .map((d) => `${d.name}${d.kind === "package" ? " (package)" : ""}`);
        const installed = record.dependencies
          .filter((d) => d.resolution === "approved-package")
          .map((d) => `${d.name}@${d.version ?? ""}`);
        process.stdout.write(
          [
            `${record.ready ? "Ready" : "Written with blockers"}: ${result.out}`,
            `${record.manifest.meta.includedFiles} files copied, ${record.manifest.meta.outboundCuts} cut imports, stub coverage ${record.manifest.meta.stubCoverage}${record.lockfile ? "" : ", no lockfile"}.`,
            ...(record.exposure === undefined ? [] : [`Shows ${renderExposure(record.exposure)}`]),
            ...(record.tests === undefined ? [] : [`Tests: ${record.tests.verdict}`]),
            ...(record.exposure === undefined || renderOutside(record.exposure).length === 0
              ? []
              : ["", ...renderOutside(record.exposure)]),
            "",
            "Mocked:",
            list(mocked),
            "",
            "Installed:",
            list(installed),
            ...(record.optionalPeers.length === 0
              ? []
              : [
                  "",
                  "Optional peers the repository installs and the folder does not (add with --install <name> if the code needs one at runtime):",
                  list(
                    record.optionalPeers.map(
                      (peer) => `${peer.name}@${peer.version} (of ${peer.of})`,
                    ),
                  ),
                ]),
            ...(record.blockers.length === 0
              ? []
              : [
                  "",
                  "Blockers:",
                  list(
                    record.blockers.map(
                      (b) => `${b.code}${b.file === null ? "" : ` ${b.file}`}: ${b.detail}`,
                    ),
                  ),
                ]),
            ...(result.pseudonyms === null
              ? []
              : [
                  "",
                  result.pseudonyms.rules.length === 0
                    ? `Pseudonyms: none of the ${result.pseudonyms.vocabulary.length} name(s) the repository goes by is in the folder; nothing was renamed.`
                    : `Pseudonyms: the folder holds the slice under ${result.pseudonyms.rules.length} rename(s) that hide the names the repository goes by (the receipt keeps the table; patch renames the folder back).${result.pseudonyms.kept.length === 0 ? "" : ` Kept, as npm installs them: ${result.pseudonyms.kept.join(", ")}.`}`,
                ]),
            ...(result.readiness.tests === 0
              ? [
                  "",
                  "No test of this code is in the folder: a pass means it installs, builds and keeps its exports. Cut with --with-tests, or write the tests the work must pass before handing it over.",
                ]
              : hasAdvice(result.readiness)
                ? [
                    "",
                    "If check finds tests that fail on the mocks before any edit, these turn them toward real code:",
                    ...renderReadiness(result.readiness),
                  ]
                : []),
            "",
            result.receipt === null
              ? "No receipt: patch, status and apply will judge the folder by its own record, checked against the repository."
              : `Receipt: ${result.receipt}\n  Keep it, and do not send it: patch, status, apply and merge judge the folder that comes back by it${record.request.public === true ? ", and the folder's own record leaves the repository's names to it" : ""}.`,
            "",
            `Next: carveout check ${values.out}`,
            "",
          ].join("\n"),
        );
      }
      if (!record.ready) process.exitCode = 2;
      return;
    }

    case "check": {
      const [dir] = positionals;
      if (dir === undefined) fail("check needs the folder a cut wrote.");
      readRecord(dir);
      const accept = acceptOption(values.accept, values.repo);
      // Every later cut of the folder (widen, apply, refresh) reads them as
      // absent, as handoff --accept records them.
      if (accept.length > 0) {
        const held = trustedCut(dir, values.receipt, { optional: true });
        if (held.receipt !== null && held.receiptPath !== null) {
          const unseen = [...new Set([...(held.receipt.unseen ?? []), ...accept.map((test) => test.path)])].sort();
          if (unseen.length !== (held.receipt.unseen ?? []).length) writeReceipt(held.receiptPath, { ...held.receipt, unseen });
        }
      }
      // What patch keeps out never reaches the acceptance run (a weakened
      // helper the acceptance tests import, say): read first, without
      // running anything of the folder's.
      const heldBack =
        accept.length === 0
          ? []
          : await patchProject(dir, { ...(values.repo === undefined ? {} : { repo: resolve(values.repo) }), ...receiptOption })
              .then((patch) => patch.refused.map((refusal) => refusal.path))
              // Unread, nothing would be held back: the folder's own
              // helpers would run under the owner's tests.
              .catch((error: unknown) =>
                fail(
                  `check --accept first reads what the folder's patch holds back, and could not: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
      const steps = await checkProject(dir, {
        ...(values["in-place"] === true ? { inPlace: true } : {}),
        ...(values.isolated === true ? { isolated: true } : {}),
        ...(accept.length === 0 ? {} : { accept, held: heldBack }),
        ...receiptOption,
      });
      const own = steps.filter((step) => step.command !== "accept");
      const ok = own.length === 3 && own.every((step) => step.ok);
      const acceptStep = steps.find((step) => step.command === "accept");
      const checked = trustedCut(dir, values.receipt, { optional: true }).record;
      const testStep = steps.find((step) => step.command === "npm test");
      const restoredStep = steps.find((step) => step.restored !== undefined);
      const baselineOf = testStep?.baselineInEffect !== undefined && testStep.baselineInEffect.length > 0 ? testStep.baselineInEffect : undefined;
      const baselineEdited = steps.find((step) => step.baselineEdited !== undefined)?.baselineEdited;
      const counts = steps.find((step) => step.counts !== undefined)?.counts;
      const carried = checked.tests?.carried.length ?? 0;
      // Whether "make the tests pass" is a task someone can finish here; a
      // cut with blockers (a name left in a public folder) is not, whatever
      // its tests say.
      const handoff: "blocked" | "ready" | "red-baseline" | "no-tests" | "failed" = !checked.ready
        ? "blocked"
        : !ok
          ? "failed"
          : baselineOf !== undefined
          ? "red-baseline"
          : carried === 0
            ? "no-tests"
            : "ready";
      if (values.json === true)
        print({
          ok,
          handoff,
          counts: counts ?? null,
          baseline: baselineOf ?? [],
          baselineEdited: baselineEdited ?? [],
          restored: restoredStep?.restored ?? [],
          addedPackages: restoredStep?.addedPackages ?? [],
          receipt: testStep?.receiptRead ?? false,
          steps,
        });
      else {
        if (restoredStep?.restored !== undefined)
          process.stdout.write(
            `The folder's generated files were not the cut's; the check ran on the receipt's:\n${list(restoredStep.restored)}\n`,
          );
        if (restoredStep?.addedPackages !== undefined)
          process.stdout.write(
            `The folder's package.json adds packages the repository does not install, so the check did not either:\n${list(restoredStep.addedPackages)}\nThe repository's package files are not patched: \`carveout patch\` names the file each one goes into, for the owner to add, or take them out.\n`,
          );
        if (testStep !== undefined && testStep.receiptRead === false && values["no-receipt"] !== true)
          process.stdout.write("No receipt for this folder: its own carveout/baseline.json was not read, so every failing test counts.\n");
        if (baselineEdited !== undefined)
          process.stdout.write(
            `The folder's carveout/baseline.json names ${baselineEdited.length} test(s) the receipt's baseline does not; they were counted:\n${list(baselineEdited)}\n`,
          );
        for (const step of steps) {
          process.stdout.write(`${step.ok ? "ok  " : "FAIL"} ${step.command}\n`);
          if (!step.ok || step.baseline !== undefined)
            process.stdout.write(`${step.output}\n`);
        }
        const record = readRecord(dir);
        const missing = new Set(
          steps.flatMap((step) =>
            step.ok
              ? []
              : [...step.output.matchAll(/Cannot find package '([^']+)'/g)].map(
                  (match) => match[1] ?? "",
                ),
          ),
        );
        for (const name of missing)
          process.stdout.write(
            record.optionalPeers.some((peer) => peer.name === name)
              ? `${name} is an optional peer the repository installs: cut again with --install ${name}.\n`
              : `${name} is not installed: cut again with --install ${name} if the repository installs it, or --mock ${name}.\n`,
          );
        const edited = steps.some((step) => step.edited === true);
        const passing = countsSentence(counts, edited);
        const readiness = checked.readiness ?? trustedCut(dir, values.receipt, { optional: true }).receipt?.readiness;
        const advice =
          readiness !== undefined && hasAdvice(readiness)
            ? ["To run them on real code instead, cut again with:", ...renderReadiness(readiness)]
            : readiness !== undefined
              ? [
                  "Nothing a cut's flags change runs them on real code: they test what the slice cuts. Leave them out of the task, or widen the cut (more entries, or --depth) to hold what they test.",
                ]
              : ["Cut again, on this machine, to see what would run them on real code (--copy-pure, --live, --copy)."];
        process.stdout.write(
          `${[
            handoff === "blocked"
              ? `Not ready to hand over: the cut has blockers (${checked.blockers.map((blocker) => blocker.code).join(", ")}); carveout status names them.${passing}`
              : handoff === "failed"
              ? edited && steps.some((step) => step.command === "npm test" && !step.ok)
                ? "npm test fails on the folder's edits (above): what it lists failed after the edits and not before them, on the same mocks."
                : "The slice does not stand on its own yet."
              : handoff === "red-baseline"
                ? edited
                  ? `The edited folder installs, builds and passes its tests, but for the ${baselineOf?.length ?? 0} test(s) that failed on the mocks before any edit (not counted). A pass here is a pass against mocks: the repository's CI decides.${passing}`
                  : `The slice installs, builds and tests on its own, but ${baselineOf?.length ?? 0} test(s) fail on the mocks before any edit (carveout/baseline.json): a contributor cannot make those pass here, so a fixed task should not rest on them.${passing}`
                : handoff === "no-tests"
                  ? `The slice installs, builds and tests on its own, but no test of this code came with it: a pass means it builds and keeps its exports. Cut with --with-tests, or write the tests the work must pass before handing it over.${passing}`
                  : edited
                    ? `The edited folder installs, builds and passes its tests (${carried} test file(s) from the repository among them). A pass here is a pass against mocks: the repository's CI decides.${passing}`
                    : `Ready to hand over: the slice installs, builds, and its tests pass before any edit (${carried} test file(s) from the repository).${passing}`,
            ...(handoff === "red-baseline" ? advice : []),
            ...(accept.length === 0
              ? []
              : [
                  acceptStep === undefined
                    ? `The owner's ${accept.length} acceptance test file(s) did not run: the folder did not install or build (above).`
                    : acceptStep.ok
                      ? `The owner's ${accept.length} acceptance test file(s) ran on their own, in the check's copy, and pass.${heldBack.length === 0 ? "" : ` patch keeps ${heldBack.length} file(s) out (${heldBack.join(", ")}): the run had the tests, helpers and setup files among them as the cut wrote them and none the folder added; any other ran as the folder holds it.`}`
                      : `The owner's acceptance tests do not pass on the folder that came back:\n${acceptStep.output}`,
                ]),
          ].join("\n")}\n`,
        );
      }
      if (!ok || (accept.length > 0 && acceptStep?.ok !== true)) process.exitCode = 2;
      return;
    }

    case "status": {
      const [dir] = positionals;
      if (dir === undefined) fail("status needs the folder a cut wrote.");
      const given = repoFor(dir);
      const status = await statusProject(dir, {
        ...(given === undefined ? {} : { repo: given }),
        ...receiptOption,
      });
      if (values.json === true) print(status);
      else {
        process.stdout.write(
          status.current
            ? `current: a cut now would write the same files.\n`
            : `stale: a cut now would differ in ${status.stale.length} place${status.stale.length === 1 ? "" : "s"}.\n${list(
                status.stale.map(
                  (item) => `${item.cause}${item.path === null ? "" : ` ${item.path}`}: ${item.detail}`,
                ),
              )}\n`,
        );
        if (status.importers.added.length + status.importers.removed.length > 0)
          process.stdout.write(
            `Importers of the slice: ${[
              ...status.importers.added.map((path) => `+${path}`),
              ...status.importers.removed.map((path) => `-${path}`),
            ].join(", ")}\n`,
          );
        if (status.inputsChanged.length > 0)
          process.stdout.write(
            `Changed since the cut, read by it: ${status.inputsChanged.join(", ")}\n`,
          );
      }
      if (!status.current) process.exitCode = 4;
      return;
    }

    case "patch": {
      const [dir] = positionals;
      if (dir === undefined) fail("patch needs the folder a cut wrote.");
      const given = repoFor(dir);
      const patch = await patchProject(dir, {
        ...(given === undefined ? {} : { repo: given }),
        ...(values.allow === undefined ? {} : { allow: values.allow }),
        ...receiptOption,
      });
      const boundary = new Set(patch.boundary.map((edit) => edit.path));
      const notes = [
        ...(patch.recordFrom === "folder"
          ? ["no receipt for this folder: it was judged by its own carveout.json, checked against the repository (pass --receipt <file> if the cut wrote one elsewhere)."]
          : []),
        ...patch.generatedEdits
          .filter((path) => !boundary.has(path))
          .map((path) => `${path} is generated; its edit is not in the patch.`),
        ...patch.boundary.map((edit) => `boundary: ${edit.detail}`),
        ...patch.sliceOnly.map(
          (path) =>
            `${path} imports the folder's carveout/ harness, which the repository does not have; it is not in the patch.`,
        ),
        ...patch.crossPackage.map(
          ({ file, specifier }) =>
            `${file} imports ${specifier} across packages, and nothing in the slice names that module another way; check the import after applying.`,
        ),
        ...patch.drifted.map(
          (path) =>
            `${path} changed in the repository since the cut; the patch is against the commit it was cut at.`,
        ),
        ...(patch.drifted.length === 0
          ? []
          : [
              "apply it with git apply --3way, which merges the moved files against the cut's commit.",
            ]),
        ...patch.noThreeWay.map(
          (path) =>
            `${path} was cut from uncommitted changes, so --3way cannot merge it; apply it by hand if git apply refuses.`,
        ),
        ...patch.deleted.map((path) => `deletes ${path}.`),
        ...(patch.skipped.length === 0
          ? []
          : [
              `not in the patch, and not judged (the folder's own tests may run them): ${patch.skipped.join(", ")}.`,
            ]),
        ...patch.refused.map(
          ({ path, reason }) => `kept out: ${path}, ${reason}.`,
        ),
        ...(patch.sliceOnly.length === 0
          ? []
          : [
              `${patch.sliceOnly.length} file(s) stay in the folder: the change comes back without the tests that ran on the mocks.`,
            ]),
      ];
      // Kept out by the policy first; then the change needs more than the
      // slice: the patch alone is short of it.
      const code =
        patch.refused.length > 0
          ? 6
          : patch.boundary.length > 0
            ? 5
            : patch.diff === ""
              ? 3
              : 0;
      if (values.json === true) {
        if (values.output !== undefined) writeFileSync(values.output, patch.diff);
        print(patch);
        process.exitCode = code;
        return;
      }
      for (const note of notes) process.stderr.write(`carveout: ${note}\n`);
      process.exitCode = code;
      if (patch.diff === "") {
        process.stderr.write("carveout: no edits to the slice.\n");
        return;
      }
      if (values.output !== undefined) {
        writeFileSync(values.output, patch.diff);
        process.stderr.write(
          `carveout: ${patch.changed.length} changed, ${patch.added.length} new and ${patch.deleted.length} deleted files in ${values.output}; apply it at the repository's root with git apply.\n`,
        );
      } else process.stdout.write(patch.diff);
      return;
    }

    case "apply": {
      const [dir, file] = positionals;
      if (dir === undefined || file === undefined)
        fail("apply needs the folder a cut wrote and a patch file.");
      const given = repoFor(dir);
      const applied = await applyPatch(dir, readFileSync(file, "utf8"), {
        ...(values.stubs === true ? { stubs: true } : {}),
        ...(given === undefined ? {} : { repo: given }),
        ...receiptOption,
      });
      if (values.json === true) print(applied);
      else {
        process.stdout.write(
          `${applied.changed.length} changed, ${applied.added.length} new and ${applied.deleted.length} deleted slice files.\n`,
        );
        if (applied.outside.length > 0)
          process.stdout.write(`Outside the slice, not applied:\n${list(applied.outside)}\n`);
        if (applied.merged.length > 0)
          process.stdout.write(`Merged into the folder's own edits:\n${list(applied.merged)}\n`);
        if (applied.conflicts.length > 0)
          process.stdout.write(
            `The folder's edits and the change overlap here; left as the folder had them, to merge by hand:\n${list(applied.conflicts)}\n`,
          );
        if (applied.stubs.length > 0)
          process.stdout.write(
            `${applied.stubs.some((stub) => stub.written) ? "Stubs written" : "Stubs the change needs (apply with --stubs to write them)"}:\n${list(
              applied.stubs.map((stub) => `${stub.path}: ${stub.detail}`),
            )}\n`,
          );
        if (applied.leaks.length > 0) process.stdout.write(leaksText(applied.leaks));
        if (applied.unmapped.length > 0) process.stdout.write(unmappedText(applied.unmapped));
      }
      if (applied.stubs.some((stub) => !stub.written)) process.exitCode = 5;
      if (applied.leaks.length > 0 || applied.unmapped.length > 0) process.exitCode = 2;
      if (applied.conflicts.length > 0) process.exitCode = 7;
      return;
    }

    case "refresh": {
      const [dir] = positionals;
      if (dir === undefined) fail("refresh needs the folder a cut wrote.");
      const given = repoFor(dir);
      const refreshed = await refreshProject(dir, {
        ...(given === undefined ? {} : { repo: given }),
        ...(values.resolved === undefined ? {} : { resolved: values.resolved }),
        ...receiptOption,
        log: (line) => {
          if (values.json !== true) process.stderr.write(`${line}\n`);
        },
      });
      if (values.json === true) print(refreshed);
      else if (refreshed === null) process.stdout.write("Nothing the slice reads has moved since the cut.\n");
      else {
        const { applied } = refreshed;
        process.stdout.write(
          [
            `Brought ${refreshed.from.slice(0, 8)}..${refreshed.to.slice(0, 8)} into the folder: ${applied.changed.length} changed, ${applied.added.length} new, ${applied.deleted.length} deleted.`,
            ...(applied.merged.length === 0 ? [] : [`Merged into the folder's own edits:\n${list(applied.merged)}`]),
            ...(applied.conflicts.length === 0
              ? []
              : [
                  `The folder's edits and the change overlap here; left as the folder had them, to merge by hand:\n${list(applied.conflicts)}\nMerge each by hand, then: carveout refresh ${dir} --resolved <path> (each), which takes the folder's text as resolved.`,
                ]),
            ...(applied.stubs.length === 0 ? [] : [`Stubs written:\n${list(applied.stubs.map((stub) => `${stub.path}: ${stub.detail}`))}`]),
            "",
          ].join("\n"),
        );
        if (applied.leaks.length > 0) process.stdout.write(leaksText(applied.leaks));
        if (applied.unmapped.length > 0) process.stdout.write(unmappedText(applied.unmapped));
        if (refreshed.copiedTaken !== undefined)
          process.stdout.write(`Copied files the folder had not edited, taken as the repository has them:\n${list(refreshed.copiedTaken)}\n`);
        if (refreshed.copiedLeft !== undefined)
          process.stdout.write(
            `Changed in the repository, in a folder the cut copied, and edited in the folder: not written over its copy. Bring each change by hand, then: carveout refresh ${dir} --resolved <path>:\n${list(refreshed.copiedLeft)}\n`,
          );
        if (refreshed.overlapResolved !== undefined)
          process.stdout.write(
            `Taken as resolved where the repository changed the same lines: check the folder's text keeps what it needs of that change (the next patch reverts what it leaves out):\n${list(refreshed.overlapResolved)}\n`,
          );
        if (refreshed.droppedUpstream !== undefined)
          process.stdout.write(
            `Taken as resolved, though the folder's text leaves out some of the repository's change to it (the next patch reverts those lines; merge them in if that is not meant):\n${list(refreshed.droppedUpstream)}\n`,
          );
      }
      if (refreshed !== null && (refreshed.applied.leaks.length > 0 || refreshed.applied.unmapped.length > 0)) process.exitCode = 2;
      // An edited copy the repository changed is an overlap too: merged by hand.
      if (refreshed !== null && (refreshed.applied.conflicts.length > 0 || refreshed.copiedLeft !== undefined)) process.exitCode = 7;
      return;
    }

    case "widen": {
      const [dir] = positionals;
      if (dir === undefined || values.entry === undefined || values.entry.length === 0)
        fail("widen needs the folder and at least one --entry <path> to add.");
      const widened = await widenProject(dir, {
        entries: values.entry,
        ...(values.out === undefined ? {} : { out: values.out }),
        ...(values.depth === undefined ? {} : { maxDepth: integer(values.depth, "depth", 0) }),
        ...(values["max-files"] === undefined ? {} : { maxFiles: integer(values["max-files"], "max-files", 0) }),
        ...(values.repo === undefined ? {} : { repo }),
        ...(values.allow === undefined ? {} : { allow: values.allow }),
        ...receiptOption,
        log: (line) => {
          if (values.json !== true) process.stderr.write(`${line}\n`);
        },
      });
      if (values.json === true)
        print({
          out: widened.out,
          ready: widened.cut.record.ready,
          receipt: widened.cut.receipt,
          carried: widened.applied === null ? [] : [...widened.applied.changed, ...widened.applied.added],
          outside: widened.applied?.outside ?? [],
          blockers: widened.cut.record.blockers,
        });
      else
        process.stdout.write(
          [
            `Widened: ${widened.out}`,
            `  Entries: ${widened.cut.record.request.entryPoints.join(", ")}.`,
            widened.applied === null
              ? "  The folder held no work to carry."
              : `  The work carried into it: ${[...widened.applied.changed, ...widened.applied.added].length} file(s)${widened.applied.outside.length === 0 ? "" : `; outside it still: ${widened.applied.outside.join(", ")}`}.`,
            ...(widened.cut.receipt === null ? [] : [`Receipt: ${widened.cut.receipt}`]),
            `Next: carveout check ${widened.out}, then hand it over in place of the old one.`,
            "",
          ].join("\n"),
        );
      if (!widened.cut.record.ready) process.exitCode = 2;
      return;
    }

    case "merge": {
      const [dir] = positionals;
      if (dir === undefined) fail("merge needs the folder a cut wrote.");
      if (values.into === undefined)
        fail("merge needs --into <checkout>: the checkout to apply the edits in.");
      const merge = await mergeProject(dir, {
        into: values.into,
        ...(values.verify === undefined ? {} : { verify: values.verify }),
        ...(values.repo === undefined ? {} : { repo }),
        ...(values.allow === undefined ? {} : { allow: values.allow }),
        ...(values["verify-env"] === undefined ? {} : { verifyEnv: values["verify-env"] }),
        ...receiptOption,
      });
      if (values.json === true) print(merge);
      else {
        for (const edit of merge.patch.boundary)
          process.stderr.write(`carveout: boundary: ${edit.detail}\n`);
        for (const step of merge.steps) {
          process.stdout.write(`${step.ok ? "ok  " : "FAIL"} ${step.step}: ${step.ok && step.step === "verify" ? "" : step.output}\n`);
        }
      }
      process.exitCode =
        merge.patch.refused.length > 0
          ? 6
          : !merge.ok
            ? 2
            : merge.patch.boundary.length > 0
              ? 5
              : 0;
      return;
    }

    case "impact": {
      const impact = impactOf({
        repo,
        ...(values.base === undefined ? {} : { base: values.base }),
        ...(positionals.length === 0 ? {} : { files: positionals }),
        ...(values.depth === undefined ? {} : { maxDepth: integer(values.depth, "depth", 0) }),
      });
      const runs =
        values.run === true
          ? runImpactTests(impact.repo, impact.commands, {
              log: (line) => {
                if (values.json !== true) process.stderr.write(`${line}\n`);
              },
            })
          : [];
      if (values.json === true) print(values.run === true ? { ...impact, runs } : impact);
      else {
        const shown = (items: readonly string[], limit = 25) =>
          list(items.length <= limit ? items : [...items.slice(0, limit), `... ${items.length - limit} more (--json lists all)`]);
        const since = impact.base === null ? "named" : `changed since ${impact.base}`;
        process.stdout.write(
          [
            `${impact.changed.length} script file(s) ${since}; ${impact.importers.length} file(s) import them, ${impact.tests.length} test(s) among them and the change (graph ${impact.timings.graphMs} ms, types ${impact.timings.typesMs} ms).`,
            "",
            "Exports whose type changed or that are gone:",
            impact.exports.length === 0
              ? "  (none)"
              : impact.exports
                  .map((item) =>
                    [
                      `  ${item.file} ${item.name}: ${item.change}`,
                      `    was: ${item.before.replaceAll("\n", "; ")}`,
                      ...(item.after === null ? [] : [`    now: ${item.after.replaceAll("\n", "; ")}`]),
                      `    taken by: ${item.usedBy.length === 0 ? "no file outside the change" : item.usedBy.join(", ")}`,
                    ].join("\n"),
                  )
                  .join("\n"),
            ...(impact.unchecked.length === 0
              ? []
              : ["", "Types not compared:", list(impact.unchecked.map(({ file, reason }) => `${file}: ${reason}`))]),
            "",
            "Importers, nearest first:",
            shown(impact.importers.map(({ file, depth }) => `${file}  (${depth} hop${depth === 1 ? "" : "s"})`)),
            "",
            "Tests that run the changed code:",
            shown(
              impact.tests.map(
                ({ file, depth, runner }) =>
                  `${file}  (${runner ?? "runner unknown"}, ${depth === 0 ? "changed" : `${depth} hop${depth === 1 ? "" : "s"}`})`,
              ),
            ),
            "",
            "Run them:",
            list(
              impact.commands.map(
                (command) =>
                  `(cd ${command.cwd || "."} && ${command.argv.join(" ")})${command.whole ? "  # the package's whole suite: no runner known" : ""}`,
              ),
            ),
            ...(runs.length === 0
              ? []
              : [
                  "",
                  ...runs.map(
                    (run) =>
                      `${run.ok ? "ok  " : "FAIL"} (cd ${run.command.cwd || "."} && ${run.command.argv.join(" ")})${run.ok ? "" : `\n${run.output}`}`,
                  ),
                ]),
            "",
          ].join("\n"),
        );
      }
      if (runs.some((run) => !run.ok)) process.exitCode = 2;
      return;
    }

    case "gate": {
      if (positionals.length > 0) fail("gate takes no positional arguments; pass --base <ref>.");
      // A Stop hook that blocked once lets the next stop through: a change
      // that is meant to rewrite an assertion would otherwise never end.
      if (values.hook === true && !process.stdin.isTTY) {
        try {
          const event = JSON.parse(readFileSync(0, "utf8") || "{}") as { stop_hook_active?: unknown };
          if (event.stop_hook_active === true) return;
        } catch {
          // No event on stdin: judge as usual.
        }
      }
      const gate = gateRepository({
        repo,
        ...(values.base === undefined ? {} : { base: values.base }),
        ...(values.allow === undefined ? {} : { allow: values.allow }),
        ...(values.scope === undefined ? {} : { scope: values.scope }),
      });
      if (values.json === true) print(gate);
      else if (values.hook === true) {
        if (gate.refused.length > 0)
          process.stderr.write(
            [
              `carveout gate: ${gate.refused.length} file(s) in this change need a reviewer's eye:`,
              list(gate.refused.map(({ path, reason }) => `${path}: ${reason}`)),
              "",
              "Undo any of these the task did not ask for. If one is the change itself (the task changes that behaviour), keep it and say so plainly in your reply, naming the file, so the person can check it.",
              "",
            ].join("\n"),
          );
      } else
        process.stdout.write(
          gate.refused.length === 0
            ? `${gate.changes.length} changed file(s) since ${gate.base}; nothing for the gate to hold.\n`
            : `${gate.changes.length} changed file(s) since ${gate.base}; ${gate.refused.length} held for review:\n${list(
                gate.refused.map(({ path, reason }) => `${path}: ${reason}`),
              )}\n`,
        );
      if (gate.refused.length > 0) process.exitCode = values.hook === true ? 2 : 6;
      return;
    }

    default:
      fail(`unknown command ${commandName}. Run carveout --help.`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) =>
  fail(error instanceof Error ? error.message : String(error)),
);
