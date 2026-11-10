/**
 * The isolated compile that tells whether a slice closes.
 *
 * The included files and the generated stubs are type-checked together in
 * memory, at the paths they hold in the repository, with the source's own
 * compiler settings. Nothing else of the repository is visible, so an
 * import the stubs do not cover is an error here rather than a surprise in
 * the sandbox. Packages are declared as `any` for this check, since the
 * worker installs nothing; the sandbox phase installs the pinned versions.
 * Each name the slice reads of a package is declared as a type as well as
 * a value, so a package's types used in the slice do not fail the check:
 * only what the slice itself leaves unresolved does.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { NODE_GLOBAL_DECLARATIONS, packageNameOf } from "../core.js";
import type { CompilationResult } from "../core.js";
import {
  isScriptPath,
  NODE_BUILTINS,
  resolveModulesWith,
} from "./typescript.js";

export const DIAGNOSTICS_MAX = 100;
export const SHIM_PATH = "__slice__/packages.d.ts";

export interface FixtureInput {
  readonly root: string;
  /** Repository-relative path to text: included files, stubs and shims. */
  readonly files: ReadonlyMap<string, string>;
  readonly compilerOptions: ts.CompilerOptions;
  readonly shimmedPackages: readonly string[];
  /** Diagnostic codes not to report: see `UNTYPED_PACKAGE_CODES`. */
  readonly ignoredCodes?: readonly number[];
  /**
   * Bare specifiers of the repository's own packages, to the path in
   * `files` each stands for: no node_modules holds them here.
   */
  readonly modules?: ReadonlyMap<string, string>;
  /** Diagnostics reported at most; defaults to `DIAGNOSTICS_MAX`. */
  readonly limit?: number;
  /**
   * A directory whose node_modules holds fetched package types, read from
   * disk; a package that resolves there is typed, and its shim yields.
   */
  readonly packageTypes?: string | null;
}

/**
 * Settings for a compile whose packages are shimmed as `any`. A callback
 * passed to an untyped function has no parameter types to take, which
 * `noImplicitAny` reports though the package's own types would give them.
 */
export const UNTYPED_PACKAGE_OPTIONS: ts.CompilerOptions = {
  noImplicitAny: false,
};

/**
 * Errors only a shimmed package raises: TS2347, a type argument given to
 * an untyped call (`useState<string>()`).
 */
export const UNTYPED_PACKAGE_CODES: readonly number[] = [2347];

/**
 * Packages whose types declare a global namespace too, read without an
 * import: `React.ReactNode` in a file that never imports React.
 */
const PACKAGE_GLOBALS: ReadonlyMap<string, string> = new Map([
  ["React", "react"],
]);

/**
 * What the slice reads of one package specifier: the names it imports, and
 * under each the members it reads off it (`React.ComponentProps`,
 * `z.infer`), as deep as it reads them. A default import is `default`.
 */
export interface PackageUse {
  readonly members: Map<string, PackageUse>;
}

export interface PackageUses {
  /** By specifier, as imported. */
  readonly modules: ReadonlyMap<string, PackageUse>;
  /** By global name: `React`. */
  readonly globals: ReadonlyMap<string, PackageUse>;
}

const use = (): PackageUse => ({ members: new Map() });

function memberOf(parent: PackageUse, name: string): PackageUse {
  let member = parent.members.get(name);
  if (member === undefined) {
    member = use();
    parent.members.set(name, member);
  }
  return member;
}

/** `a.b.c`, as a type's qualified name or a property read, or null. */
function chainOf(node: ts.Node): string[] | null {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isQualifiedName(node)) {
    const left = chainOf(node.left);
    return left === null ? null : [...left, node.right.text];
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const left = chainOf(node.expression);
    return left === null ? null : [...left, node.name.text];
  }
  return null;
}

/**
 * What the files read of each specifier that `shimmed` says is a package,
 * and of the globals such a package declares (`PACKAGE_GLOBALS`),
 * by the packages' names (`react` covers `react/jsx-runtime`). Read from the
 * syntax alone: a name shadowed in a nested scope may be counted, which
 * only declares one more `any`.
 */
export function packageUses(
  files: ReadonlyMap<string, string>,
  shimmed: (specifier: string) => boolean,
): PackageUses {
  const uses = new Map<string, PackageUse>();
  const globals = new Map<string, PackageUse>();
  const rootOf = (specifier: string) => {
    let root = uses.get(specifier);
    if (root === undefined) {
      root = use();
      uses.set(specifier, root);
    }
    return root;
  };
  for (const [path, text] of files) {
    if (!isScriptPath(path)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
    // Each local name an import binds, to what it stands for.
    const aliases = new Map<string, PackageUse>();
    const packageOf = (node: ts.Node | undefined) =>
      node !== undefined && ts.isStringLiteral(node) && shimmed(node.text)
        ? rootOf(node.text)
        : null;
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const root = packageOf(statement.moduleSpecifier);
        const clause = statement.importClause;
        if (root === null || clause === undefined) continue;
        if (clause.name !== undefined)
          aliases.set(clause.name.text, memberOf(root, "default"));
        const bindings = clause.namedBindings;
        if (bindings === undefined) continue;
        if (ts.isNamespaceImport(bindings))
          aliases.set(bindings.name.text, root);
        else
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            aliases.set(element.name.text, memberOf(root, imported));
          }
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference)
      ) {
        const root = packageOf(statement.moduleReference.expression);
        if (root !== null) aliases.set(statement.name.text, root);
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const root = packageOf(statement.moduleSpecifier);
        if (root !== null)
          for (const element of statement.exportClause.elements)
            memberOf(root, (element.propertyName ?? element.name).text);
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
        const initializer = node.initializer;
        const call = initializer && ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
        if (call && ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword && call.arguments[0]) {
          const root = packageOf(call.arguments[0]);
          if (root !== null)
            for (const element of node.name.elements) {
              const imported = element.propertyName ?? element.name;
              if (ts.isIdentifier(imported)) memberOf(root, imported.text);
            }
        }
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        node.qualifier !== undefined
      ) {
        const root = packageOf(node.argument.literal);
        const chain = chainOf(node.qualifier);
        if (root !== null && chain !== null)
          chain.reduce((parent, name) => memberOf(parent, name), root);
      } else if (
        ts.isQualifiedName(node) ||
        ts.isPropertyAccessExpression(node)
      ) {
        const [first, ...rest] = chainOf(node) ?? [];
        const global =
          first === undefined ? undefined : PACKAGE_GLOBALS.get(first);
        const alias =
          first === undefined
            ? undefined
            : (aliases.get(first) ??
              (global !== undefined && shimmed(global)
                ? memberOf({ members: globals }, first)
                : undefined));
        if (alias !== undefined)
          rest.reduce((parent, name) => memberOf(parent, name), alias);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { modules: uses, globals };
}

/** Enough parameters for any generic a package's type is read with. */
const ANY_PARAMETERS = Array.from({ length: 8 }, (_, i) => `T${i} = any`).join(
  ", ",
);

const isIdentifier = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);

const isReserved = (name: string) => {
  const token = ts.identifierToKeywordKind(ts.factory.createIdentifier(name));
  return (
    token !== undefined &&
    token >= ts.SyntaxKind.FirstReservedWord &&
    token <= ts.SyntaxKind.LastReservedWord
  );
};

/** A name a declaration can take: an identifier, and no reserved word. */
const isName = (name: string) => isIdentifier(name) && !isReserved(name);

/**
 * A name as a value, a generic type and a namespace of the members read
 * off it, all `any`. The namespace holds types only, so it merges with the
 * value; a value read off a value is `any` already.
 */
function declareMember(
  name: string,
  member: PackageUse,
  depth: string,
  value: boolean,
): string[] {
  const lines = [
    ...(value ? [`${depth}export const ${name}: any;`] : []),
    `${depth}export type ${name}<${ANY_PARAMETERS}> = any;`,
  ];
  const members = [...member.members.keys()].filter(isName).sort();
  if (members.length > 0) {
    lines.push(`${depth}export namespace ${name} {`);
    for (const child of members)
      lines.push(
        ...declareMember(
          child,
          member.members.get(child) ?? use(),
          `${depth}  `,
          false,
        ),
      );
    lines.push(`${depth}}`);
  }
  return lines;
}

/** A global namespace of the types read off it; none when none are. */
function declareGlobal(name: string, global: PackageUse): string[] {
  // Its namespace alone: a global's own name is not a type or a value.
  const [, open, ...members] = declareMember(name, global, "", false);
  return open === undefined
    ? []
    : [open.replace(/^export /, "declare "), ...members];
}

/** A module for one specifier, exporting what the slice reads of it. */
function declareModule(
  specifier: string,
  root: PackageUse,
  installed: boolean,
): string[] {
  // A pattern is consulted only when no file resolves the specifier.
  const lines = [
    `declare module ${JSON.stringify(installed ? `${specifier}*` : specifier)} {`,
  ];
  const fallback = root.members.get("default") ?? use();
  // Local, and exported as the default: only its own lines lose `export`.
  lines.push(
    ...declareMember("__default", fallback, "  ", true).map((line) =>
      line.replace(/^ {2}export /, "  "),
    ),
    "  export default __default;",
  );
  for (const name of [...root.members.keys()].sort()) {
    if (isName(name))
      lines.push(
        ...declareMember(name, root.members.get(name) ?? use(), "  ", true),
      );
    // `mod.delete`: a reserved word can be exported, though not declared.
    else if (isIdentifier(name) && name !== "default")
      lines.push(
        `  const __reserved_${name}: any;`,
        `  export { __reserved_${name} as ${name} };`,
      );
  }
  lines.push("}");
  return lines;
}

/**
 * JSX with any element and any props: what `@types/react` would give, as
 * loose as the packages it stands beside.
 */
const JSX_SHIM = [
  "declare namespace JSX {",
  "  type Element = any;",
  "  type ElementClass = any;",
  "  interface IntrinsicElements { [name: string]: any; }",
  "  interface IntrinsicAttributes { [name: string]: any; }",
  "}",
  // What a bundler adds to `import.meta` (`glob`, `env`, `hot`).
  "interface ImportMeta { [name: string]: any; }",
];

/**
 * Ambient declarations that make the listed packages resolve as `any`, with
 * Node's own modules and globals as the generated project declares them.
 * A specifier in `uses` gets a module of its own that exports each name the
 * slice reads as both a value and a type, so `import type { X }` and
 * `React.ComponentProps<"button">` check as they would with the package's
 * types; any other is untyped, which only works as a value. A global in
 * `uses` is a namespace of the types read off it. A `typed` package, whose
 * fetched types the compile reads, is declared by patterns that yield to
 * them.
 */
export function packageShim(
  packages: readonly string[],
  { modules: uses, globals }: PackageUses = {
    modules: new Map(),
    globals: new Map(),
  },
  typed: (name: string) => boolean = () => false,
): string {
  const lines = [...NODE_GLOBAL_DECLARATIONS, ...JSX_SHIM];
  // Node's modules by their bare names too: `import fs from "fs"`.
  for (const name of [...new Set([...NODE_BUILTINS, ...packages])].sort())
    if (typed(name)) {
      // A pattern, which the package's own types take precedence over.
      if (!uses.has(name)) lines.push(`declare module "${name}*";`);
    } else {
      if (!uses.has(name)) lines.push(`declare module "${name}";`);
      lines.push(`declare module "${name}/*";`);
    }
  return `${lines.join("\n")}\n${
    packageModules({ modules: uses, globals }, (specifier) =>
      typed(packageNameOf(specifier)),
    ).text
  }`;
}

/**
 * The part of `packageShim` that declares what the slice reads: a module
 * for each specifier in `uses` and a namespace for each global. A sliced
 * project declares its packages with these too, so it builds against what
 * the slice was checked against; one it `installed` by a pattern, which
 * yields to the package's own types.
 */
export function packageModules(
  { modules: uses, globals }: PackageUses,
  installed: (specifier: string) => boolean = () => false,
): {
  specifiers: string[];
  text: string;
} {
  const specifiers = [...uses.keys()].sort();
  const lines: string[] = [];
  for (const specifier of specifiers)
    lines.push(
      ...declareModule(
        specifier,
        uses.get(specifier) ?? use(),
        installed(specifier),
      ),
    );
  for (const name of [...globals.keys()].filter(isName).sort())
    lines.push(...declareGlobal(name, globals.get(name) ?? use()));
  return {
    specifiers,
    text: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
  };
}

/**
 * A compiler message with the checkout's path taken out. Messages name
 * files by absolute path (TS6059 names the project's `rootDir`), and they
 * are written into the folder's record, which may leave the machine: a
 * path under the repository becomes repository-relative, and one under the
 * fetched package types becomes `<package types>/...`.
 */
export function withoutRoots(
  message: string,
  root: string,
  types: string | null = null,
): string {
  const replacements: [string, string][] = [];
  const add = (base: string, label: string) => {
    for (const variant of new Set([base, safeRealpath(base)])) {
      replacements.push([`${variant}${sep}`, label === "" ? "" : `${label}/`]);
      replacements.push([variant, label === "" ? "." : label]);
    }
  };
  if (types !== null) add(resolve(types), "<package types>");
  add(resolve(root), "");
  // Longest first, so a path under another is replaced whole.
  replacements.sort((a, b) => b[0].length - a[0].length);
  let text = message;
  for (const [from, to] of replacements) text = text.split(from).join(to);
  return text;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function compileFixture(input: FixtureInput): CompilationResult {
  const root = resolve(input.root);
  const files = new Map<string, string>();
  for (const [path, text] of input.files) files.set(resolve(root, path), text);
  const options: ts.CompilerOptions = {
    ...input.compilerOptions,
    noEmit: true,
    // Off with everything that needs it, which the compiler otherwise
    // reports against the source's own config (TS5069).
    declaration: false,
    declarationMap: false,
    declarationDir: undefined,
    emitDeclarationOnly: false,
    isolatedDeclarations: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    // Where emitted files go, which a check that emits nothing has no use
    // for: a slice holds files from several packages, and the entry's
    // package's rootDir would reject the others (TS6059).
    rootDir: undefined,
    rootDirs: undefined,
    outDir: undefined,
    skipLibCheck: true,
    types: [],
    typeRoots: [],
    allowJs: true,
    noLib: false,
  };
  const libDir = dirname(ts.getDefaultLibFilePath(options));
  const within = (base: string, path: string) => {
    const rel = relative(base, resolve(path));
    return !isAbsolute(rel) && !rel.startsWith("..");
  };
  const types = input.packageTypes ?? null;
  // The compiler's libs and the fetched package types are read from disk.
  const inLib = (path: string) =>
    within(libDir, path) || (types !== null && within(types, path));
  const directories = new Set<string>([root]);
  for (const path of files.keys())
    for (let dir = dirname(path); dir.startsWith(root); dir = dirname(dir)) {
      if (directories.has(dir)) break;
      directories.add(dir);
    }
  const host: ts.CompilerHost = {
    fileExists: (path) =>
      files.has(resolve(path)) || (inLib(path) && ts.sys.fileExists(path)),
    readFile: (path) =>
      files.get(resolve(path)) ??
      (inLib(path) ? ts.sys.readFile(path) : undefined),
    directoryExists: (path) =>
      directories.has(resolve(path)) ||
      (inLib(path) && ts.sys.directoryExists(path)),
    getDirectories: (path) =>
      inLib(path)
        ? ts.sys.getDirectories(path)
        : [...directories]
            .filter(
              (dir) => dirname(dir) === resolve(path) && dir !== resolve(path),
            )
            .map((dir) => relative(resolve(path), dir)),
    getSourceFile: (fileName, languageVersion) => {
      const text = host.readFile(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: (compilerOptions) =>
      ts.getDefaultLibFilePath(compilerOptions),
    getDefaultLibLocation: () => libDir,
    writeFile: () => {},
    getCurrentDirectory: () => root,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    realpath: (path) => path,
  };
  const modules = input.modules ?? new Map<string, string>();
  if (modules.size > 0 || types !== null)
    resolveModulesWith(host, root, options, {
      workspaceModule: (specifier) => {
        const path = modules.get(specifier);
        return path !== undefined && files.has(resolve(root, path))
          ? path
          : null;
      },
      packageTypes: types,
    });
  const rootNames = [...files.keys()].filter(isScriptPath).sort();
  const program = ts.createProgram(rootNames, options, host);
  const ignored = new Set(input.ignoredCodes ?? []);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        diagnostic.category === ts.DiagnosticCategory.Error &&
        !ignored.has(diagnostic.code),
    )
    .map((diagnostic) => ({
      file:
        diagnostic.file === undefined
          ? null
          : relative(root, diagnostic.file.fileName).replaceAll("\\", "/"),
      line:
        diagnostic.file === undefined || diagnostic.start === undefined
          ? null
          : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
              .line + 1,
      code: `TS${diagnostic.code}`,
      message: withoutRoots(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        root,
        types,
      ),
    }))
    .sort((a, b) =>
      `${a.file ?? ""}:${a.line ?? 0}:${a.code}`.localeCompare(
        `${b.file ?? ""}:${b.line ?? 0}:${b.code}`,
      ),
    );
  return {
    attempted: true,
    ok: diagnostics.length === 0,
    diagnostics: diagnostics.slice(0, input.limit ?? DIAGNOSTICS_MAX),
    shimmedPackages: [...new Set(input.shimmedPackages)].sort(),
  };
}
