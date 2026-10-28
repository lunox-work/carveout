#!/usr/bin/env node
/**
 * carveout <command>: plan, cut, check and patch slices of a repository.
 * Exit codes: 0 done, 1 refused or failed, 2 written with blockers (cut)
 * or a step failed (check), 3 nothing to patch, 4 stale (status).
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CARVEOUT_VERSION,
  carveoutHome,
  checkProject,
  cutSlice,
  patchProject,
  planSlice,
  readRecord,
} from "./carve.js";
import { SLICE_BUDGET_DEFAULTS, type DependencyChoice } from "./core.js";
import { statusProject } from "./status.js";

const USAGE = `carveout ${CARVEOUT_VERSION}: carve a slice out of a TypeScript repository.

  carveout plan  <entry>... [--repo <dir>] [--max-files N] [--depth N]
                 [--with-tests] [--json]
      What a cut would hold, from the import graph alone. Writes nothing.

  carveout cut   <entry>... --out <dir> [--repo <dir>] [--max-files N] [--depth N]
                 [--with-tests] [--mock <package>]... [--install <package>]...
                 [--offline] [--widen-literals] [--json]
      Copies the slice to <dir> at its repository paths, with a .d.ts stub and a
      recording mock for every module it imports from outside, mock packages for
      what it does not install, package.json, tsconfig.json and a lockfile.

  carveout check <dir> [--in-place] [--json]
      npm ci, npm run build and npm test in a scratch copy of <dir>.

  carveout status <dir> [--json]
      Whether <dir> still matches the repository, and what changed if not.

  carveout patch <dir> [--output <file>]
      The edits made in <dir> as a patch for the repository (git apply).

  carveout where
      The folder fetched package types are cached in (CARVEOUT_HOME).

An entry point is a file or a directory, relative to --repo (default: the
current directory, which should be the repository's root). Defaults:
--max-files ${SLICE_BUDGET_DEFAULTS.maxFiles}, --depth ${SLICE_BUDGET_DEFAULTS.maxDepth}.
`;

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
    options: {
      repo: { type: "string" },
      out: { type: "string" },
      output: { type: "string" },
      "max-files": { type: "string" },
      depth: { type: "string" },
      mock: { type: "string", multiple: true },
      install: { type: "string", multiple: true },
      offline: { type: "boolean" },
      "widen-literals": { type: "boolean" },
      "with-tests": { type: "boolean" },
      "in-place": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
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
      });
      if (values.json === true) {
        print({
          repo: plan.repo,
          entryPoints: plan.entryPoints,
          unknownEntryPoints: plan.walk.unknownEntryPoints,
          budget: plan.budget,
          included: plan.walk.included,
          depthOf: plan.walk.depthOf,
          dropped: plan.walk.dropped,
          tests: plan.walk.tests,
          untestable: plan.walk.untestable,
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
          `${plan.walk.included.length} files from ${plan.entryPoints.join(", ")} (budget ${plan.budget.maxFiles} files, depth ${plan.budget.maxDepth}; ${plan.graphFiles} script files read)${atLimit ? ", at the file limit: raise --max-files or narrow the entry points" : ""}.`,
          "",
          "Included:",
          list(
            plan.walk.included.map(
              (path) => `${path}  (depth ${plan.walk.depthOf[path] ?? 0})`,
            ),
          ),
          "",
          ...(atLimit
            ? [
                "Left out by the file limit, cut instead:",
                list(plan.walk.dropped),
                "",
              ]
            : []),
          ...(plan.walk.tests.length + plan.walk.untestable.length === 0
            ? []
            : [
                "Tests brought along:",
                list(plan.walk.tests),
                ...(plan.walk.untestable.length === 0
                  ? []
                  : [
                      "",
                      "Tests left behind (they run on neither node:test nor Vitest):",
                      list(plan.walk.untestable),
                    ]),
                "",
              ]),
          "Cut, becomes a stub and a mock:",
          list(
            plan.cutModules.map((path) =>
              plan.typeOnlyCuts.includes(path) ? `${path} (types only)` : path,
            ),
          ),
          "",
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
      const result = await cutSlice({
        repo,
        out: values.out,
        entryPoints: positionals,
        budget,
        choices,
        ...(values["with-tests"] === true ? { tests: true } : {}),
        ...(values.offline === true ? { offline: true } : {}),
        ...(values["widen-literals"] === true ? { widenLiterals: true } : {}),
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
      const steps = await checkProject(dir, {
        ...(values["in-place"] === true ? { inPlace: true } : {}),
      });
      const ok = steps.length === 3 && steps.every((step) => step.ok);
      if (values.json === true) print({ ok, steps });
      else {
        for (const step of steps) {
          process.stdout.write(`${step.ok ? "ok  " : "FAIL"} ${step.command}\n`);
          if (!step.ok) process.stdout.write(`${step.output}\n`);
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
        process.stdout.write(
          ok
            ? "The slice installs, builds and tests on its own.\n"
            : "The slice does not stand on its own yet.\n",
        );
      }
      if (!ok) process.exitCode = 2;
      return;
    }

    case "status": {
      const [dir] = positionals;
      if (dir === undefined) fail("status needs the folder a cut wrote.");
      const status = await statusProject(dir, {
        ...(values.repo === undefined ? {} : { repo }),
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
      const patch = await patchProject(dir);
      const notes = [
        ...patch.generatedEdits.map(
          (path) => `${path} is generated; its edit is not in the patch.`,
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
      ];
      for (const note of notes) process.stderr.write(`carveout: ${note}\n`);
      if (patch.diff === "") {
        process.stderr.write("carveout: no edits to the slice.\n");
        process.exitCode = 3;
        return;
      }
      if (values.output !== undefined) {
        writeFileSync(values.output, patch.diff);
        process.stderr.write(
          `carveout: ${patch.changed.length} changed and ${patch.added.length} new files in ${values.output}; apply it at the repository's root with git apply.\n`,
        );
      } else process.stdout.write(patch.diff);
      return;
    }

    default:
      fail(`unknown command ${commandName}. Run carveout --help.`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) =>
  fail(error instanceof Error ? error.message : String(error)),
);
