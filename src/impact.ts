/**
 * `carveout impact`: what a change made in the repository reaches, for the
 * agent or person who made it, before the repository's CI says so.
 *
 * From the change (Git's base commit against the working tree, or the
 * files named) it finds:
 *
 * - every file that imports a changed module, directly or through others,
 *   by the same lazy, compiler-confirmed search the slice walk uses;
 * - the exports of each changed module whose type changed or that are
 *   gone, read by the TypeScript checker at the base and now, and which of
 *   those importers take each one (through barrels too);
 * - the tests among the importers, with their runner, and the commands
 *   that run just them, package by package.
 *
 * The search, the type comparison and the test selection run no code of
 * the repository; `runImpactTests` runs the commands, in the repository,
 * with the caller's environment, as its own test script would.
 *
 * A type is compared as the checker prints it, one level of members deep:
 * a change inside a named type another module declares shows on that
 * module's own exports when it changed too, not on this one.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import { isTestPath, testRunnerOf } from "./core.js";
import { loadConfig, type LoadedConfig } from "./extract/compiler-config.js";
import { baseCommitOf, changesSince, checkoutRoot, textAt, textNow, type ChangeKind } from "./gate.js";
import { changedExports, importersOf, type ImporterLink } from "./graph.js";
import { packageFolder } from "./imports.js";
import { usesTestGlobals } from "./project/runner.js";

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const TYPED = /\.(?:[cm]?tsx?)$/;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type ImpactRunner = "node" | "vitest" | "jest";

export interface ImpactExport {
  readonly file: string;
  readonly name: string;
  readonly change: "removed" | "changed";
  /** The type as the checker prints it, one level of members deep. */
  readonly before: string;
  readonly after: string | null;
  /** Files outside the change that take this export, sorted. */
  readonly usedBy: readonly string[];
}

export interface ImpactTest {
  readonly file: string;
  /** Hops from the nearest changed module; 0 for a test the change edits. */
  readonly depth: number;
  readonly package: string;
  /** Null: no runner carveout knows (mocha, ava, a custom script). */
  readonly runner: ImpactRunner | null;
}

export interface ImpactCommand {
  /** The package folder to run it in, from the checkout's root ("" the root). */
  readonly cwd: string;
  readonly runner: ImpactRunner | null;
  readonly argv: readonly string[];
  readonly tests: readonly string[];
  /** Runs the package's whole test script, not only these tests. */
  readonly whole: boolean;
}

export interface Impact {
  readonly repo: string;
  /** The base as given and its commit; null when files were named. */
  readonly base: string | null;
  readonly baseCommit: string | null;
  /** The script files the change touches, with how. */
  readonly changed: readonly { readonly path: string; readonly change: ChangeKind }[];
  /** Files that import a changed module, with their hops from it, sorted. */
  readonly importers: readonly { readonly file: string; readonly depth: number }[];
  readonly exports: readonly ImpactExport[];
  readonly tests: readonly ImpactTest[];
  readonly commands: readonly ImpactCommand[];
  /** Changed modules whose types could not be compared, with why. */
  readonly unchecked: readonly { readonly file: string; readonly reason: string }[];
  readonly timings: { readonly graphMs: number; readonly typesMs: number };
}

/** The dependencies and devDependencies a package.json declares, or null. */
function declared(root: string, folder: string): Set<string> | null {
  try {
    const manifest = JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies"]) {
      const section = manifest[key];
      if (section !== null && typeof section === "object")
        for (const name of Object.keys(section)) names.add(name);
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * A test file's runner: the one it imports (`node:test`, `vitest`,
 * `@jest/globals`), else the one its package (or the root) depends on
 * when the file calls a runner's globals.
 */
export function impactRunnerResolver(
  root: string,
  packageOf: (file: string) => string,
): (file: string, specifiers: readonly string[]) => ImpactRunner | null {
  const known = new Map<string, Set<string> | null>();
  const dependencies = (folder: string) => {
    if (!known.has(folder)) known.set(folder, declared(root, folder));
    return known.get(folder) ?? null;
  };
  return (file, specifiers) => {
    const explicit = testRunnerOf(specifiers);
    if (explicit !== null) return explicit;
    if (specifiers.some((specifier) => specifier === "@jest/globals")) return "jest";
    let text = "";
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      return null;
    }
    if (!usesTestGlobals(text)) return null;
    for (const folder of [packageOf(file), ""]) {
      const names = dependencies(folder);
      if (names === null) continue;
      if (names.has("vitest")) return "vitest";
      if (names.has("jest")) return "jest";
    }
    return null;
  };
}

/** The commands that run `tests`, one per package and runner. */
export function impactCommands(tests: readonly ImpactTest[]): ImpactCommand[] {
  const groups = new Map<string, ImpactTest[]>();
  for (const test of tests) {
    const key = `${test.package}\n${test.runner ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), test]);
  }
  const commands: ImpactCommand[] = [];
  for (const [key, group] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const [cwd = "", runner = ""] = key.split("\n");
    const local = group
      .map((test) => (cwd === "" ? test.file : posix.relative(cwd, test.file)))
      .sort(compare);
    const files = group.map((test) => test.file).sort(compare);
    if (runner === "vitest")
      commands.push({ cwd, runner, argv: ["npx", "--no", "vitest", "run", ...local], tests: files, whole: false });
    else if (runner === "jest")
      commands.push({
        cwd,
        runner,
        argv: ["npx", "--no", "jest", "--runTestsByPath", ...local],
        tests: files,
        whole: false,
      });
    else if (runner === "node")
      commands.push({
        cwd,
        runner,
        argv: [
          "node",
          ...(local.some((file) => TYPED.test(file)) ? ["--experimental-strip-types"] : []),
          "--test",
          ...local,
        ],
        tests: files,
        whole: false,
      });
    else commands.push({ cwd, runner: null, argv: ["npm", "test"], tests: files, whole: true });
  }
  return commands;
}

/** The names a file takes from `specifier`: every import of it, types too. */
function namesTaken(text: string, path: string, specifier: string): Set<string> | "*" {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const statement of source.statements) {
    const from =
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
    if (from !== specifier) continue;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause === undefined) continue;
      if (clause.name !== undefined) names.add("default");
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) return "*";
      if (bindings !== undefined)
        for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text);
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) return "*";
      for (const element of clause.elements) names.add((element.propertyName ?? element.name).text);
    }
  }
  // A `require`, `import()` or `import("x").T` the statements do not show.
  return names.size === 0 ? "*" : names;
}

/**
 * Files that take `name` from `file`: importers that name it (or take the
 * whole module), and through a barrel that forwards it, the barrel's
 * importers of the name it forwards it as.
 */
function usersOf(
  root: string,
  file: string,
  name: string,
  into: ReadonlyMap<string, readonly ImporterLink[]>,
): string[] {
  const users = new Set<string>();
  const seen = new Set<string>();
  const queue: [string, string][] = [[file, name]];
  const texts = new Map<string, string>();
  const textOf = (path: string) => {
    let text = texts.get(path);
    if (text === undefined) {
      try {
        text = readFileSync(join(root, path), "utf8");
      } catch {
        text = "";
      }
      texts.set(path, text);
    }
    return text;
  };
  while (queue.length > 0) {
    const [module, wanted] = queue.pop() as [string, string];
    if (seen.has(`${module}\n${wanted}`)) continue;
    seen.add(`${module}\n${wanted}`);
    for (const link of into.get(module) ?? []) {
      if (link.relation === "references") {
        users.add(link.from);
        continue;
      }
      if (link.forwards !== null) {
        const forwards = link.forwards === "*" ? [[wanted, wanted] as const] : link.forwards;
        for (const [inner, outer] of forwards)
          if (inner === wanted) queue.push([link.from, outer]);
          else if (inner === "*") users.add(link.from);
        continue;
      }
      if (link.specifier === null) {
        users.add(link.from);
        continue;
      }
      const taken = namesTaken(textOf(link.from), link.from, link.specifier);
      if (taken === "*" || taken.has(wanted)) users.add(link.from);
    }
  }
  return [...users].sort(compare);
}

const PRINT =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrowStyleSignature;

/**
 * A type as the checker prints it, with the members of an object the
 * repository declares one level deep. A library's type (an array, a tuple,
 * a Promise, a Map) is printed by name and arguments: its members say
 * nothing the arguments do not.
 */
function shapeOf(program: ts.Program, type: ts.Type): string {
  const checker = program.getTypeChecker();
  const printed = () => checker.typeToString(type, undefined, PRINT);
  if ((type.flags & ts.TypeFlags.Object) === 0) return printed();
  const object = type as ts.ObjectType;
  const reference = (object.objectFlags & ts.ObjectFlags.Reference) !== 0 ? (type as ts.TypeReference) : null;
  if (reference !== null && (reference.target.objectFlags & ts.ObjectFlags.Tuple) !== 0) return printed();
  const declarations = (type.aliasSymbol ?? type.symbol)?.declarations ?? [];
  if (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      const file = declaration.getSourceFile();
      return program.isSourceFileDefaultLibrary(file) || program.isSourceFileFromExternalLibrary(file) || /[\\/]node_modules[\\/]/.test(file.fileName);
    })
  )
    return printed();
  const parts: string[] = [];
  for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call))
    parts.push(`call ${checker.signatureToString(signature, undefined, PRINT)}`);
  for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Construct))
    parts.push(`new ${checker.signatureToString(signature, undefined, PRINT)}`);
  for (const info of checker.getIndexInfosOfType(type))
    parts.push(
      `[${checker.typeToString(info.keyType, undefined, PRINT)}]: ${checker.typeToString(info.type, undefined, PRINT)}`,
    );
  const properties = checker
    .getPropertiesOfType(type)
    .filter(
      (property) =>
        !property.name.startsWith("#") &&
        !(property.declarations ?? []).some(
          (declaration) =>
            ts.canHaveModifiers(declaration) &&
            (ts.getModifiers(declaration) ?? []).some(
              (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
            ),
        ),
    )
    .sort((a, b) => compare(a.name, b.name));
  for (const property of properties) {
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const readonly =
      declaration !== undefined &&
      ts.canHaveModifiers(declaration) &&
      (ts.getModifiers(declaration) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
        ? "readonly "
        : "";
    parts.push(
      `${readonly}${property.name}${optional}: ${checker.typeToString(checker.getTypeOfSymbol(property), undefined, PRINT)}`,
    );
  }
  if (parts.length === 1 && parts[0]?.startsWith("call ") === true) return parts[0].slice("call ".length);
  return parts.length === 0 ? printed() : `{ ${parts.join("; ")} }`;
}

/** Each export of a module, by name, as its shape. */
function exportShapes(program: ts.Program, absolute: string): Map<string, string> | null {
  const source = program.getSourceFile(absolute);
  if (source === undefined) return null;
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(source);
  const shapes = new Map<string, string>();
  if (module === undefined) return shapes;
  for (const exported of checker.getExportsOfModule(module)) {
    const symbol =
      (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
    const parts: string[] = [];
    if ((symbol.flags & ts.SymbolFlags.Value) !== 0)
      parts.push(`value ${shapeOf(program, checker.getTypeOfSymbol(symbol))}`);
    if ((symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) !== 0) {
      const declared = checker.getDeclaredTypeOfSymbol(symbol);
      const parameters = (symbol.declarations ?? []).flatMap((declaration) =>
        ts.isInterfaceDeclaration(declaration) ||
        ts.isTypeAliasDeclaration(declaration) ||
        ts.isClassDeclaration(declaration)
          ? (declaration.typeParameters ?? []).map((parameter) => parameter.getText())
          : [],
      );
      parts.push(
        `type${parameters.length === 0 ? "" : `<${[...new Set(parameters)].join(", ")}>`} ${shapeOf(program, declared)}`,
      );
    }
    shapes.set(exported.name, parts.join("\n"));
  }
  return shapes;
}

/**
 * The exports of `files` at `baseCommit` and now, compared: each removed
 * or changed one. One pair of programs per compiler configuration; files
 * the programs share are parsed once.
 */
function compareExports(
  root: string,
  baseCommit: string | null,
  files: readonly { readonly path: string; readonly change: ChangeKind }[],
): {
  changes: { file: string; name: string; change: "removed" | "changed"; before: string; after: string | null }[];
  unchecked: { file: string; reason: string }[];
} {
  const changes: {
    file: string;
    name: string;
    change: "removed" | "changed";
    before: string;
    after: string | null;
  }[] = [];
  const unchecked: { file: string; reason: string }[] = [];
  if (baseCommit === null) {
    for (const file of files) unchecked.push({ file: file.path, reason: "no base to compare with (files were named)" });
    return { changes, unchecked };
  }
  const groups = new Map<string, { options: ts.CompilerOptions; files: { path: string; change: ChangeKind }[] }>();
  const loaded = new Map<string, LoadedConfig>();
  // The base program sees every changed file as it was: an added one absent.
  const before = new Map<string, string | null>();
  for (const file of files)
    if (SCRIPT.test(file.path))
      before.set(join(root, file.path), file.change === "added" ? null : textAt(root, baseCommit, file.path));
  for (const file of files) {
    if (!SCRIPT.test(file.path) || file.change === "added") continue;
    const config = loadConfig(root, join(root, file.path), { loaded });
    const key = config.path ?? "";
    const group = groups.get(key) ?? {
      options: {
        allowJs: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        ...(config.path === null ? {} : config.options),
        noEmit: true,
        skipLibCheck: true,
        incremental: false,
        composite: false,
      },
      files: [],
    };
    group.files.push({ path: file.path, change: file.change });
    groups.set(key, group);
  }
  const cache = new Map<string, ts.SourceFile | undefined>();
  for (const { options, files: group } of groups.values()) {
    const hostFor = (overrides: ReadonlyMap<string, string | null> | null): ts.CompilerHost => {
      const host = ts.createCompilerHost(options, true);
      const original = host.getSourceFile.bind(host);
      const readFile = host.readFile.bind(host);
      const fileExists = host.fileExists.bind(host);
      host.fileExists = (path) => (overrides?.has(path) === true ? overrides.get(path) !== null : fileExists(path));
      host.readFile = (path) => (overrides?.has(path) === true ? (overrides.get(path) ?? undefined) : readFile(path));
      host.getSourceFile = (path, language, onError) => {
        if (overrides?.has(path) === true) {
          const text = overrides.get(path);
          return text === null || text === undefined ? undefined : ts.createSourceFile(path, text, language, true);
        }
        const key =
          typeof language === "object"
            ? `${language.languageVersion}\n${String(language.impliedNodeFormat)}\n${path}`
            : `${language}\n${path}`;
        if (!cache.has(key)) cache.set(key, original(path, language, onError));
        return cache.get(key);
      };
      return host;
    };
    const roots = group.map((file) => join(root, file.path));
    const now = ts.createProgram(
      roots.filter((path) => existsSync(path)),
      options,
      hostFor(null),
    );
    const then = ts.createProgram(
      roots.filter((path) => before.get(path) !== null),
      options,
      hostFor(before),
    );
    for (const file of group) {
      const absolute = join(root, file.path);
      if (before.get(absolute) === null) continue;
      const old = exportShapes(then, absolute);
      if (old === null) {
        unchecked.push({ file: file.path, reason: "its base version did not load" });
        continue;
      }
      const current = file.change === "deleted" ? new Map<string, string>() : exportShapes(now, absolute);
      if (current === null) {
        unchecked.push({ file: file.path, reason: "it did not load" });
        continue;
      }
      for (const [name, shape] of [...old].sort(([a], [b]) => compare(a, b))) {
        const after = current.get(name);
        if (after === undefined) changes.push({ file: file.path, name, change: "removed", before: shape, after: null });
        else if (after !== shape) changes.push({ file: file.path, name, change: "changed", before: shape, after });
      }
    }
  }
  return { changes, unchecked };
}

/** What the change from `base` (or the files named) reaches. */
export function impactOf(options: {
  readonly repo: string;
  readonly base?: string;
  /** Files to start from instead of the change since `base`. */
  readonly files?: readonly string[];
  /** Hops of importers to follow; unbounded by default. */
  readonly maxDepth?: number;
}): Impact {
  const root = checkoutRoot(options.repo);
  const named = options.files !== undefined && options.files.length > 0;
  const base = named ? null : (options.base ?? "HEAD");
  const baseCommit = base === null ? null : baseCommitOf(root, base);
  const changed = (
    named
      ? (options.files ?? []).map((path) => ({
          path: posix.normalize(path.replaceAll("\\", "/").replace(/^\.\//, "")),
          change: "changed" as const,
        }))
      : changesSince(root, baseCommit as string)
  );
  const scripts = changed.filter((file) => SCRIPT.test(file.path));
  // Only the exports a change to a module reaches carry it on; a named
  // file, with no base to compare with, carries all of its exports.
  const seeds = new Map<string, ReadonlySet<string> | "*">();
  if (baseCommit !== null)
    for (const file of scripts)
      seeds.set(
        file.path,
        changedExports(
          file.path,
          file.change === "added" ? null : textAt(root, baseCommit, file.path),
          file.change === "deleted" ? null : textNow(root, file.path),
        ),
      );
  const graphStarted = performance.now();
  const reached = importersOf(root, scripts.map((file) => file.path), {
    seeds,
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  });
  const graphMs = Math.round(performance.now() - graphStarted);
  const changedSet = new Set(scripts.map((file) => file.path));
  const importers = [...reached.depthOf]
    .filter(([file]) => !changedSet.has(file))
    .map(([file, depth]) => ({ file, depth }))
    .sort((a, b) => a.depth - b.depth || compare(a.file, b.file));
  const into = new Map<string, ImporterLink[]>();
  for (const link of reached.links) into.set(link.to, [...(into.get(link.to) ?? []), link]);
  const typesStarted = performance.now();
  const compared = compareExports(root, baseCommit, scripts);
  const typesMs = Math.round(performance.now() - typesStarted);
  const exports: ImpactExport[] = compared.changes.map((change) => ({
    ...change,
    usedBy: usersOf(root, change.file, change.name, into).filter((file) => !changedSet.has(file)),
  }));
  const packageOf = packageFolder(root);
  const runnerOf = impactRunnerResolver(root, packageOf);
  const bareOf = new Map<string, string[]>();
  for (const link of reached.built.graph.links)
    if (link.target.startsWith("dependency:") && link.specifier !== null && !link.specifier.startsWith(".")) {
      const from = link.source.slice("file:".length);
      bareOf.set(from, [...(bareOf.get(from) ?? []), link.specifier]);
    }
  const tests: ImpactTest[] = [...reached.depthOf]
    .filter(([file]) => isTestPath(file) && existsSync(join(root, file)))
    .map(([file, depth]) => ({
      file,
      depth,
      package: packageOf(file),
      runner: runnerOf(file, bareOf.get(file) ?? []),
    }))
    .sort((a, b) => a.depth - b.depth || compare(a.file, b.file));
  return {
    repo: root,
    base,
    baseCommit,
    changed: scripts,
    importers,
    exports,
    tests,
    commands: impactCommands(tests),
    unchecked: compared.unchecked,
    timings: { graphMs, typesMs },
  };
}

export interface ImpactRun {
  readonly command: ImpactCommand;
  readonly ok: boolean;
  readonly exitCode: number | null;
  /** The last lines of what it printed. */
  readonly output: string;
}

/**
 * Runs each command at its package's folder, one at a time, with the
 * caller's environment: these are the repository's own tests, run where
 * its test script would run them. `timeoutMs` bounds each.
 */
export function runImpactTests(
  root: string,
  commands: readonly ImpactCommand[],
  options: { readonly timeoutMs?: number; readonly log?: (line: string) => void } = {},
): ImpactRun[] {
  const runs: ImpactRun[] = [];
  for (const command of commands) {
    const [executable = "npm", ...args] = command.argv;
    options.log?.(`$ (cd ${command.cwd || "."} && ${command.argv.join(" ")})`);
    const result = spawnSync(executable, args, {
      cwd: join(root, command.cwd),
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: options.timeoutMs ?? 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: (() => {
        // A `node --test` started under another reports to that parent and
        // exits 0 whatever its tests did.
        const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
        return { ...env, CI: process.env["CI"] ?? "1" };
      })(),
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n").slice(-60).join("\n");
    runs.push({
      command,
      ok: result.status === 0,
      exitCode: result.status,
      output: result.error === undefined ? output : `${result.error.message}\n${output}`.trim(),
    });
  }
  return runs;
}
