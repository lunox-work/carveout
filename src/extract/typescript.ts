import {
  declarationPath as declarationPathFor,
  isAssetPath,
  relativeSpecifier,
} from "../core.js";
import { loadConfig, type LoadedConfig } from "./compiler-config.js";
export {
  declarationPath as declarationPathFor,
  packageNameOf,
} from "../core.js";
export { loadConfig } from "./compiler-config.js";
/**
 * Signature extraction for TypeScript and JavaScript, with the compiler API.
 *
 * For every module the slice imports from outside (a cut), the exported
 * declarations it needs are emitted as `.d.ts` text with the compiler's own
 * declaration emitter, then narrowed to the requested names and whatever
 * they reference, so the stub is a compilable declaration file with no
 * bodies. Types the stub imports from further modules are pulled in the
 * same way until the set is closed. The same emitter and filter describe
 * the public surface: what outside files import from the slice.
 *
 * Nothing here executes repository code. The compiler host is bounded to
 * the source directory and the compiler's own library files.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BoundaryModule, CutEdge, SliceBlocker } from "../core.js";
import ts from "typescript";

export const TYPESCRIPT_EXTRACTOR_VERSION = `typescript@${ts.version}`;
export const ALL = "*";
export type RequestedNames = ReadonlySet<string> | typeof ALL;
export const STUB_CLOSURE_MAX = 500;
/**
 * Repository files one extraction may parse. The compiler runs on the
 * event loop; a program the size of a monorepo would hold it past the
 * heartbeat and lose the lease, so the slice stops with a blocker instead.
 */
export const PROGRAM_FILES_MAX = 2000;
class ProgramTooLarge extends Error {}

/** Modules Node provides; never a package the sandbox must install. */
export const NODE_BUILTINS: readonly string[] = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

export function isScriptPath(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path);
}
/**
 * Files a script imports as data (`import data from "./data.json"`) or
 * reads by path (a query, a schema, a template). They ride along in a
 * TypeScript slice; code in any other language does not.
 */
export function isDataPath(path: string): boolean {
  return (
    /\.(json|jsonc|ya?ml|toml|csv|xml|sql|graphql|gql|prisma)$/.test(path) ||
    isAssetPath(path)
  );
}
export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  const root = specifier.split("/")[0] ?? specifier;
  return NODE_BUILTINS.includes(root);
}
/** The stub's artifact path for a module: `stubs/<path>.d.ts`. */
export function stubPathFor(module: string): string {
  return `stubs/${declarationPathFor(module)}`;
}
export interface ImportFact {
  readonly specifier: string;
  readonly names: RequestedNames;
  readonly line: number;
}

/**
 * The names read off a namespace binding (`ns.a`, `ns.T` in a type), or
 * `ALL` once it escapes: passed or returned as a value, re-exported, read
 * with a computed key, taken as `typeof ns`, or shadowed by another
 * binding of the same name. Only a namespace that never escapes can be
 * stubbed with less than the whole module.
 */
export function namespaceUses(
  nodes: readonly ts.Node[],
  name: string,
  binding: ts.Node,
): RequestedNames {
  const used = new Set<string>();
  let escaped = false;
  const isKey = (parent: ts.Node, node: ts.Node) =>
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxAttribute(parent)) &&
    parent.name === node;
  const visit = (node: ts.Node) => {
    if (escaped) return;
    if (ts.isIdentifier(node) && node.text === name && node !== binding) {
      const parent = node.parent;
      if (
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node) ||
        isKey(parent, node)
      ) {
        /* `x.ns` or a member key: another thing sharing the name. */
      } else if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        ts.isIdentifier(parent.name)
      )
        used.add(parent.name.text);
      else if (ts.isQualifiedName(parent) && parent.left === node)
        used.add(parent.right.text);
      else escaped = true;
    }
    ts.forEachChild(node, visit);
  };
  for (const node of nodes) visit(node);
  return escaped ? ALL : used;
}

/** Every import a file makes, with the names it takes, from the syntax. */
export function importsOf(source: ts.SourceFile): ImportFact[] {
  const facts: ImportFact[] = [];
  const line = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = (node: ts.Expression | undefined) =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = literal(statement.moduleSpecifier);
      if (specifier === null) continue;
      const clause = statement.importClause;
      const names = new Set<string>();
      let all = false;
      if (clause === undefined) {
        /* A side-effect import needs the module to exist, nothing from it. */
      } else {
        if (clause.name !== undefined) names.add("default");
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          const used = namespaceUses(
            source.statements,
            bindings.name.text,
            bindings.name,
          );
          if (used === ALL) all = true;
          else for (const name of used) names.add(name);
        } else if (bindings !== undefined)
          for (const element of bindings.elements)
            names.add((element.propertyName ?? element.name).text);
      }
      facts.push({
        specifier,
        names: all ? ALL : names,
        line: line(statement),
      });
    } else if (ts.isExportDeclaration(statement)) {
      const specifier = literal(statement.moduleSpecifier);
      if (specifier === null) continue;
      const clause = statement.exportClause;
      const names =
        clause === undefined || ts.isNamespaceExport(clause)
          ? ALL
          : new Set(
              clause.elements.map(
                (element) => (element.propertyName ?? element.name).text,
              ),
            );
      facts.push({ specifier, names, line: line(statement) });
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const specifier = literal(statement.moduleReference.expression);
      if (specifier !== null)
        facts.push({ specifier, names: ALL, line: line(statement) });
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = literal(node.arguments[0]);
      if (specifier !== null)
        facts.push({ specifier, names: ALL, line: line(node) });
    } else if (ts.isImportTypeNode(node)) {
      const specifier =
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
          ? node.argument.literal.text
          : null;
      if (specifier !== null) {
        let qualifier = node.qualifier;
        while (qualifier !== undefined && ts.isQualifiedName(qualifier))
          qualifier = qualifier.left;
        facts.push({
          specifier,
          names: qualifier === undefined ? ALL : new Set([qualifier.text]),
          line: line(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

const EXTENSIONS: readonly ts.Extension[] = [
  ts.Extension.Dmts,
  ts.Extension.Dcts,
  ts.Extension.Dts,
  ts.Extension.Mts,
  ts.Extension.Cts,
  ts.Extension.Tsx,
  ts.Extension.Ts,
  ts.Extension.Mjs,
  ts.Extension.Cjs,
  ts.Extension.Jsx,
  ts.Extension.Js,
  ts.Extension.Json,
];

/** Where a snapshot's bare specifiers resolve, having no node_modules. */
export interface ModuleFallbacks {
  /** The repository path of one of its own packages; see `workspaceModuleResolver`. */
  readonly workspaceModule?: (specifier: string) => string | null;
  /** A directory whose node_modules holds fetched package types. */
  readonly packageTypes?: string | null;
}

/**
 * Resolves imports as the compiler does, then a bare specifier it cannot
 * resolve as one of the repository's own packages, then from the fetched
 * package types, as if imported beside their node_modules.
 */
export function resolveModulesWith(
  host: ts.CompilerHost,
  root: string,
  options: ts.CompilerOptions,
  fallbacks: ModuleFallbacks,
): void {
  const cache = ts.createModuleResolutionCache(root, (name) => name, options);
  const typesCache =
    fallbacks.packageTypes == null
      ? undefined
      : ts.createModuleResolutionCache(
          fallbacks.packageTypes,
          (name) => name,
          options,
        );
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    redirected,
    compilerOptions,
    containingSourceFile,
  ) =>
    literals.map((literal) => {
      const mode = ts.getModeForUsageLocation(
        containingSourceFile,
        literal,
        compilerOptions,
      );
      const resolved = ts.resolveModuleName(
        literal.text,
        containingFile,
        compilerOptions,
        host,
        cache,
        redirected,
        mode,
      );
      if (resolved.resolvedModule !== undefined) return resolved;
      if (literal.text.startsWith(".") || literal.text.startsWith("/"))
        return resolved;
      const module = fallbacks.workspaceModule?.(literal.text) ?? null;
      if (module !== null) {
        const resolvedFileName = resolve(root, module);
        return {
          resolvedModule: {
            resolvedFileName,
            extension:
              EXTENSIONS.find((extension) =>
                resolvedFileName.endsWith(extension),
              ) ?? ts.Extension.Ts,
            isExternalLibraryImport: false,
          },
        };
      }
      if (fallbacks.packageTypes == null) return resolved;
      const typed = ts.resolveModuleName(
        literal.text,
        join(fallbacks.packageTypes, "index.ts"),
        compilerOptions,
        host,
        typesCache,
        undefined,
        mode,
      );
      return typed.resolvedModule === undefined ? resolved : typed;
    });
}

/**
 * A declaration file with the module specifiers `to` maps replaced, in
 * imports, re-exports and `import("...")` types; the rest is left as is.
 */
export function rewriteModuleSpecifiers(
  text: string,
  to: (specifier: string) => string | null,
): string {
  const source = ts.createSourceFile(
    "m.d.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const edits: { start: number; end: number; text: string }[] = [];
  const replace = (literal: ts.Node | undefined) => {
    if (literal === undefined || !ts.isStringLiteralLike(literal)) return;
    const next = to(literal.text);
    if (next !== null && next !== literal.text)
      edits.push({
        start: literal.getStart(source),
        end: literal.getEnd(),
        text: JSON.stringify(next),
      });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      replace(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      replace(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      replace(node.argument.literal);
    ts.forEachChild(node, visit);
  };
  visit(source);
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  return result;
}

/**
 * A compiler host that reads only the source tree, the compiler's libs
 * and the fetched package types.
 */
export function boundedHost(
  root: string,
  options: ts.CompilerOptions,
  fallbacks: ModuleFallbacks = {},
) {
  const libDir = dirname(ts.getDefaultLibFilePath(options));
  const inside = (base: string, path: string) => {
    const rel = relative(base, resolve(path));
    return rel === "" || (!isAbsolute(rel) && !rel.startsWith(".."));
  };
  const types = fallbacks.packageTypes ?? null;
  // A checkout's own node_modules is not read: a workspace package would
  // resolve to its build output there, not to its source, and packages are
  // read from the fetched types, at the versions the lockfile pins.
  const allowed = (path: string) =>
    (inside(root, path) &&
      !relative(root, resolve(path)).split(/[\\/]/).includes("node_modules")) ||
    inside(libDir, path) ||
    (types !== null && inside(types, path));
  const host = ts.createCompilerHost(options, true);
  const base = { ...host };
  host.fileExists = (path) => allowed(path) && base.fileExists(path);
  host.readFile = (path) => (allowed(path) ? base.readFile(path) : undefined);
  host.directoryExists = (path) =>
    allowed(path) && (base.directoryExists?.(path) ?? existsSync(path));
  host.getDirectories = (path) =>
    allowed(path) ? (base.getDirectories?.(path) ?? []) : [];
  host.realpath = (path) => path;
  host.getCurrentDirectory = () => root;
  host.writeFile = () => {};
  if (fallbacks.workspaceModule !== undefined || types !== null)
    resolveModulesWith(host, root, options, fallbacks);
  return host;
}

/** Options for declaration emit: the source's, with output settings forced. */
export function extractionOptions(
  base: ts.CompilerOptions,
): ts.CompilerOptions {
  return {
    ...base,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    noEmitOnError: false,
    skipLibCheck: true,
    sourceMap: false,
    declarationMap: false,
    inlineSourceMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    outDir: undefined,
    outFile: undefined,
    rootDir: undefined,
    declarationDir: undefined,
    types: [],
    typeRoots: [],
    noLib: false,
    isolatedDeclarations: false,
    stripInternal: false,
  };
}

/**
 * Options for a stub's declaration emit. A stub leaves the repository, so
 * it carries no comments; the context builders, which stay private, keep
 * them through `extractionOptions`. `@internal` declarations are emitted
 * like any other, without their comments: the compiler's `stripInternal`
 * would drop one the slice's code imports or a kept declaration names
 * across the cut, and the stub would not declare what that code compiles
 * against. `filterDeclaration` keeps only what is asked for and what that
 * needs, so one nothing reaches is left out all the same.
 */
export function stubExtractionOptions(
  base: ts.CompilerOptions,
): ts.CompilerOptions {
  return { ...extractionOptions(base), removeComments: true };
}

/**
 * A string literal that names something rather than holds a value: a
 * provider, a status, a kind (`"github"`, `"in-progress"`). Such literals
 * are a type's members when code reads the constant as a type, and the
 * slice's own code spells them anyway. A URL, a key, a sentence or a
 * number is a value, and widens.
 */
const NAME_LIKE = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;

/** The type a literal widens to, or null for anything else. */
function widened(literal: ts.Expression, keepNames = false): ts.TypeNode | null {
  const keyword = (kind: ts.KeywordTypeSyntaxKind) =>
    ts.factory.createKeywordTypeNode(kind);
  const value = ts.isPrefixUnaryExpression(literal) ? literal.operand : literal;
  if (ts.isStringLiteralLike(value))
    return keepNames && NAME_LIKE.test(value.text)
      ? null
      : keyword(ts.SyntaxKind.StringKeyword);
  if (ts.isNumericLiteral(value)) return keyword(ts.SyntaxKind.NumberKeyword);
  if (ts.isBigIntLiteral(value)) return keyword(ts.SyntaxKind.BigIntKeyword);
  if (
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword
  )
    return keyword(ts.SyntaxKind.BooleanKeyword);
  return null;
}

/**
 * A value's declared type with the literals in it widened: what an `as
 * const` object, a tuple or a literal annotation (`const T: "secret"`)
 * writes of the value. Only the shapes a value's type is spelled with are
 * followed (object type members, tuples, unions, arrays, `readonly`); a
 * function type, a type reference and its arguments are an API's types,
 * not a value, and are kept. `null` stays.
 */
function widenType(node: ts.TypeNode, keepNames = false): ts.TypeNode {
  const { factory } = ts;
  const again = (type: ts.TypeNode) => widenType(type, keepNames);
  if (ts.isLiteralTypeNode(node)) return widened(node.literal, keepNames) ?? node;
  if (ts.isTemplateLiteralTypeNode(node))
    return factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
  if (ts.isParenthesizedTypeNode(node))
    return factory.updateParenthesizedType(node, again(node.type));
  if (ts.isUnionTypeNode(node))
    return factory.updateUnionTypeNode(
      node,
      factory.createNodeArray(node.types.map(again)),
    );
  if (ts.isIntersectionTypeNode(node))
    return factory.updateIntersectionTypeNode(
      node,
      factory.createNodeArray(node.types.map(again)),
    );
  if (ts.isArrayTypeNode(node))
    return factory.updateArrayTypeNode(node, again(node.elementType));
  if (ts.isTypeOperatorNode(node))
    return factory.updateTypeOperatorNode(node, again(node.type));
  if (ts.isTupleTypeNode(node))
    return factory.updateTupleTypeNode(
      node,
      factory.createNodeArray(
        node.elements.map((element) =>
          ts.isNamedTupleMember(element)
            ? factory.updateNamedTupleMember(
                element,
                element.dotDotDotToken,
                element.name,
                element.questionToken,
                again(element.type),
              )
            : ts.isOptionalTypeNode(element)
              ? factory.updateOptionalTypeNode(element, again(element.type))
              : ts.isRestTypeNode(element)
                ? factory.updateRestTypeNode(element, again(element.type))
                : again(element),
        ),
      ),
    );
  if (ts.isTypeLiteralNode(node))
    return factory.updateTypeLiteralNode(
      node,
      factory.createNodeArray(
        node.members.map((member) =>
          ts.isPropertySignature(member) && member.type !== undefined
            ? factory.updatePropertySignature(
                member,
                member.modifiers,
                member.name,
                member.questionToken,
                again(member.type),
              )
            : member,
        ),
      ),
    );
  return node;
}

/** A value's type: its literal initializer's, widened, or its own, widened. */
function valueType(
  type: ts.TypeNode | undefined,
  initializer: ts.Expression | undefined,
  keepNames = false,
): { readonly type: ts.TypeNode | undefined; readonly cleared: boolean } {
  const fromInitializer =
    initializer === undefined ? null : widened(initializer, keepNames);
  if (fromInitializer !== null) return { type: fromInitializer, cleared: true };
  return {
    type: type === undefined ? undefined : widenType(type, keepNames),
    cleared: false,
  };
}

/**
 * The constants a declaration file reads as types (`(typeof KINDS)[number]`,
 * `kind: typeof KIND`). Their name-like literals are the members of those
 * types: widened, the type is `string`, and the slice no longer checks
 * the code that relies on it.
 */
function constantsReadAsTypes(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeQueryNode(node)) {
      let name: ts.EntityName = node.exprName;
      while (ts.isQualifiedName(name)) name = name.left;
      names.add(name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

const isPrivateMember = (member: ts.ClassElement) =>
  !ts.isConstructorDeclaration(member) &&
  ((member.name !== undefined && ts.isPrivateIdentifier(member.name)) ||
    (ts.canHaveModifiers(member) &&
      (ts.getModifiers(member) ?? []).some(
        (m) => m.kind === ts.SyntaxKind.PrivateKeyword,
      )));

/**
 * An emitted declaration file as a stub may show it. The emitter writes a
 * literal constant's value (`declare const KEY = "sk_live_..."`, `static
 * readonly KEY = "..."`), the literal types an `as const` value or an
 * annotation spells it with, every comment it was not told to drop and
 * each private member's name. A stub keeps each value's type with its
 * literals widened to `string`, `number`, `bigint` or `boolean`, no
 * comments, and private members only as one nameless brand, since no code
 * outside the class can use them.
 *
 * A constant the file reads as a type (`(typeof PROVIDERS)[number]`, `kind:
 * typeof KIND`) keeps its name-like string literals (`"github"`, `"draft"`):
 * they are that type's members, and widened, the type would be `string` and
 * the slice would stop checking the code that relies on it (a guard taken
 * out compiles). Its other literals (numbers, URLs, keys, sentences) widen
 * as any value's do.
 *
 * A string enum member's value becomes its own name: it stays a string
 * enum, each member its own type, without the text it stood for. Numeric
 * members keep their values, which an ambient enum needs for its members
 * to be constant, and a number names nothing.
 */
export function sanitizeDeclaration(
  text: string,
  options: { readonly widenLiterals?: boolean } = {},
): string {
  const widen = options.widenLiterals ?? true;
  const source = ts.createSourceFile(
    "m.d.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const { factory } = ts;
  const readAsTypes = constantsReadAsTypes(source);
  const result = ts.transform(source, [
    (context) => {
      const visit = (node: ts.Node): ts.Node => {
        if (ts.isVariableDeclaration(node) && widen) {
          const value = valueType(
            node.type,
            node.initializer,
            ts.isIdentifier(node.name) && readAsTypes.has(node.name.text),
          );
          return factory.updateVariableDeclaration(
            node,
            node.name,
            node.exclamationToken,
            value.type,
            value.cleared ? undefined : node.initializer,
          );
        }
        if (ts.isPropertyDeclaration(node) && widen) {
          const value = valueType(node.type, node.initializer);
          return factory.updatePropertyDeclaration(
            node,
            node.modifiers,
            node.name,
            node.questionToken ?? node.exclamationToken,
            value.type,
            value.cleared ? undefined : node.initializer,
          );
        }
        if (
          widen &&
          ts.isEnumMember(node) &&
          node.initializer !== undefined &&
          ts.isStringLiteralLike(node.initializer) &&
          (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        )
          return factory.updateEnumMember(
            node,
            node.name,
            factory.createStringLiteral(node.name.text),
          );
        if (ts.isClassDeclaration(node)) {
          // One `#private` brand, as the emitter writes for `#` members,
          // keeps the class nominal without naming what it hides.
          const members = node.members.filter((m) => !isPrivateMember(m));
          const brand =
            members.length < node.members.length
              ? [
                  factory.createPropertyDeclaration(
                    undefined,
                    factory.createPrivateIdentifier("#private"),
                    undefined,
                    undefined,
                    undefined,
                  ),
                ]
              : [];
          return ts.visitEachChild(
            factory.updateClassDeclaration(
              node,
              node.modifiers,
              node.name,
              node.typeParameters,
              node.heritageClauses,
              [...brand, ...members],
            ),
            visit,
            context,
          );
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (root) => ts.visitEachChild(root, visit, context);
    },
  ]);
  const printed = ts
    .createPrinter({ removeComments: true })
    .printFile(result.transformed[0] ?? source);
  result.dispose();
  return printed;
}

interface Declared {
  readonly statement: ts.Statement;
  /** Names this statement makes visible to importers. */
  readonly exported: ReadonlySet<string>;
  /** Names it binds locally (the same as exported, for direct exports). */
  readonly local: ReadonlySet<string>;
  /** Identifiers it refers to, over-approximated. */
  readonly references: ReadonlySet<string>;
  readonly kind: string;
  readonly reexportAll: string | null;
  readonly importFrom: { specifier: string; names: RequestedNames } | null;
}

const kindOf = (statement: ts.Statement): string =>
  ts.isFunctionDeclaration(statement)
    ? "function"
    : ts.isClassDeclaration(statement)
      ? "class"
      : ts.isInterfaceDeclaration(statement)
        ? "interface"
        : ts.isTypeAliasDeclaration(statement)
          ? "type"
          : ts.isEnumDeclaration(statement)
            ? "enum"
            : ts.isVariableStatement(statement)
              ? "variable"
              : ts.isModuleDeclaration(statement)
                ? "namespace"
                : ts.isExportAssignment(statement)
                  ? "default"
                  : "unknown";

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text);
  else
    for (const element of name.elements)
      if (ts.isBindingElement(element)) bindingNames(element.name, into);
}

/** The elements of `export { ... }` (with or without `from`), else null. */
function namedExportElements(
  statement: ts.Statement,
): readonly ts.ExportSpecifier[] | null {
  if (!ts.isExportDeclaration(statement)) return null;
  const clause = statement.exportClause;
  return clause !== undefined && ts.isNamedExports(clause) ? clause.elements : null;
}

function describe(statement: ts.Statement): Declared {
  const exported = new Set<string>();
  const local = new Set<string>();
  const references = new Set<string>();
  let reexportAll: string | null = null;
  let importFrom: Declared["importFrom"] = null;
  const modifiers = ts.canHaveModifiers(statement)
    ? (ts.getModifiers(statement) ?? [])
    : [];
  const isExport = modifiers.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
  const isDefault = modifiers.some(
    (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
  );
  const declare = (name: string | undefined) => {
    if (name === undefined) return;
    local.add(name);
    if (isExport) exported.add(name);
  };
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    declare(
      statement.name !== undefined && ts.isIdentifier(statement.name)
        ? statement.name.text
        : undefined,
    );
    if (isExport && isDefault) exported.add("default");
  } else if (ts.isVariableStatement(statement)) {
    const names = new Set<string>();
    for (const declaration of statement.declarationList.declarations)
      bindingNames(declaration.name, names);
    for (const name of names) declare(name);
  } else if (ts.isExportAssignment(statement)) {
    exported.add(statement.isExportEquals ? "export=" : "default");
  } else if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    const specifier =
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
    if (clause === undefined) reexportAll = specifier;
    else if (ts.isNamespaceExport(clause)) {
      exported.add(clause.name.text);
      if (specifier !== null) importFrom = { specifier, names: ALL };
    } else {
      const taken = new Set<string>();
      for (const element of clause.elements) {
        exported.add(element.name.text);
        const origin = (element.propertyName ?? element.name).text;
        if (specifier === null) references.add(origin);
        else taken.add(origin);
      }
      if (specifier !== null) importFrom = { specifier, names: taken };
    }
  } else if (ts.isImportDeclaration(statement)) {
    const specifier = ts.isStringLiteralLike(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    const clause = statement.importClause;
    const taken = new Set<string>();
    let all = false;
    if (clause?.name !== undefined) {
      local.add(clause.name.text);
      taken.add("default");
    }
    if (clause?.namedBindings !== undefined) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        local.add(clause.namedBindings.name.text);
        all = true;
      } else
        for (const element of clause.namedBindings.elements) {
          local.add(element.name.text);
          taken.add((element.propertyName ?? element.name).text);
        }
    }
    if (specifier !== null)
      importFrom = { specifier, names: all ? ALL : taken };
  } else if (ts.isImportEqualsDeclaration(statement)) {
    local.add(statement.name.text);
    if (isExport) exported.add(statement.name.text);
    if (ts.isExternalModuleReference(statement.moduleReference)) {
      const expression = statement.moduleReference.expression;
      if (ts.isStringLiteralLike(expression))
        importFrom = { specifier: expression.text, names: ALL };
    } else references.add(leftmost(statement.moduleReference));
  }
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !local.has(node.text))
      references.add(node.text);
    ts.forEachChild(node, visit);
  };
  if (!ts.isImportDeclaration(statement)) visit(statement);
  return {
    statement,
    exported,
    local,
    references,
    kind: kindOf(statement),
    reexportAll,
    importFrom,
  };
}

function leftmost(name: ts.EntityName): string {
  return ts.isQualifiedName(name) ? leftmost(name.left) : name.text;
}

export interface FilteredDeclaration {
  readonly text: string;
  /** Requested names that no kept statement exports and no `export *` could. */
  readonly missing: readonly string[];
  /** Names forwarded to `export *` targets because nothing local declared them. */
  readonly forwarded: readonly { specifier: string; names: RequestedNames }[];
  /** Modules the kept declarations import from, with the names taken. */
  readonly imports: readonly { specifier: string; names: RequestedNames }[];
  readonly symbols: readonly {
    name: string;
    kind: string;
    declaration: string;
  }[];
}

/**
 * Narrows an emitted declaration file to the requested exports and what
 * they need. `ALL` keeps the file whole.
 */
export function filterDeclaration(
  text: string,
  requested: RequestedNames,
): FilteredDeclaration {
  const source = ts.createSourceFile(
    "m.d.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const described = source.statements.map(describe);
  const kept = new Set<Declared>();
  const needed = new Set<string>();
  // `export { a, b, c } from "./m"` is one statement: keeping it whole for
  // `a` would declare `b` and `c` too, with their literal values, and ask
  // `./m` for them. Such a statement keeps only the names asked of it.
  const narrowed = new Map<Declared, Set<string>>();
  const exportedBy = (name: string) =>
    described.filter((d) => d.exported.has(name) && d.reexportAll === null);
  if (requested === ALL) {
    for (const d of described) kept.add(d);
  } else {
    for (const name of requested)
      for (const d of exportedBy(name)) {
        kept.add(d);
        const elements = namedExportElements(d.statement);
        if (elements === null) {
          for (const reference of d.references) needed.add(reference);
          continue;
        }
        narrowed.set(d, (narrowed.get(d) ?? new Set()).add(name));
        const element = elements.find((e) => e.name.text === name);
        const local = ts.isExportDeclaration(d.statement) && d.statement.moduleSpecifier === undefined;
        if (element !== undefined && local)
          needed.add((element.propertyName ?? element.name).text);
      }
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of described) {
        if (kept.has(d)) continue;
        const binds = [...d.local].some((name) => needed.has(name));
        if (!binds) continue;
        kept.add(d);
        grew = true;
        for (const reference of d.references) needed.add(reference);
      }
    }
  }
  const imports: { specifier: string; names: RequestedNames }[] = [];
  // A namespace import asks its module for what the kept statements read
  // off it, not the whole module, unless the namespace escapes.
  /** What a statement asks of its module, narrowed with it. */
  const importOf = (d: Declared): Declared["importFrom"] => {
    const names = narrowed.get(d);
    if (d.importFrom === null || names === undefined) return d.importFrom;
    const elements = namedExportElements(d.statement) ?? [];
    return {
      specifier: d.importFrom.specifier,
      names: new Set(
        elements
          .filter((e) => names.has(e.name.text))
          .map((e) => (e.propertyName ?? e.name).text),
      ),
    };
  };
  for (const d of kept) {
    const importFrom = importOf(d);
    if (importFrom === null) continue;
    const clause = ts.isImportDeclaration(d.statement)
      ? d.statement.importClause
      : undefined;
    const bindings = clause?.namedBindings;
    if (bindings === undefined || !ts.isNamespaceImport(bindings)) {
      imports.push(importFrom);
      continue;
    }
    const used = namespaceUses(
      [...kept].filter((other) => other !== d).map((other) => other.statement),
      bindings.name.text,
      bindings.name,
    );
    imports.push({
      specifier: importFrom.specifier,
      names:
        used === ALL
          ? ALL
          : new Set([
              ...used,
              ...(clause?.name === undefined ? [] : ["default"]),
            ]),
    });
  }
  const visitImportTypes = (node: ts.Node) => {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      let qualifier = node.qualifier;
      while (qualifier !== undefined && ts.isQualifiedName(qualifier))
        qualifier = qualifier.left;
      imports.push({
        specifier: node.argument.literal.text,
        names: qualifier === undefined ? ALL : new Set([qualifier.text]),
      });
    }
    ts.forEachChild(node, visitImportTypes);
  };
  for (const d of kept) visitImportTypes(d.statement);
  const missing: string[] = [];
  const forwarded: { specifier: string; names: RequestedNames }[] = [];
  const stars = described.filter((d) => d.reexportAll !== null);
  if (requested === ALL) {
    for (const star of stars) {
      kept.add(star);
      forwarded.push({ specifier: star.reexportAll ?? "", names: ALL });
    }
  } else {
    const unfound = [...requested].filter(
      (name) => exportedBy(name).length === 0,
    );
    if (unfound.length > 0 && stars.length > 0)
      for (const star of stars) {
        kept.add(star);
        forwarded.push({
          specifier: star.reexportAll ?? "",
          names: new Set(unfound),
        });
      }
    else missing.push(...unfound);
  }
  const ordered = described.filter((d) => kept.has(d));
  const symbols: { name: string; kind: string; declaration: string }[] = [];
  const wanted = (name: string) => requested === ALL || requested.has(name);
  /** `export { a as X }`: the local name `X` is bound to, here `a`. */
  const localOf = (statement: ts.Statement, exported: string) => {
    if (!ts.isExportDeclaration(statement)) return undefined;
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return undefined;
    const element = clause.elements.find((e) => e.name.text === exported);
    return element === undefined
      ? undefined
      : (element.propertyName ?? element.name).text;
  };
  for (const d of ordered)
    for (const name of [...d.exported].sort())
      if (wanted(name)) {
        const local =
          d.kind === "unknown" ? localOf(d.statement, name) : undefined;
        const origin =
          local === undefined
            ? undefined
            : described.find((other) => other !== d && other.local.has(local));
        symbols.push({
          name,
          kind: origin?.kind ?? d.kind,
          declaration: (origin ?? d).statement.getText(source).trim(),
        });
      }
  const printer = ts.createPrinter({ removeComments: true });
  /** The statement as kept: a narrowed export lists only its kept names. */
  const textOf = (d: Declared): string => {
    const names = narrowed.get(d);
    const statement = d.statement;
    if (names === undefined || !ts.isExportDeclaration(statement))
      return statement.getText(source).trim();
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause))
      return statement.getText(source).trim();
    const elements = clause.elements.filter((e) => names.has(e.name.text));
    if (elements.length === clause.elements.length)
      return statement.getText(source).trim();
    return printer
      .printNode(
        ts.EmitHint.Unspecified,
        ts.factory.updateExportDeclaration(
          statement,
          statement.modifiers,
          statement.isTypeOnly,
          ts.factory.updateNamedExports(clause, elements),
          statement.moduleSpecifier,
          statement.attributes,
        ),
        source,
      )
      .trim();
  };
  let body = ordered.map(textOf).join("\n");
  if (!ordered.some((d) => d.exported.size > 0 || d.reexportAll !== null))
    body = `${body}${body === "" ? "" : "\n"}export {};`;
  return { text: `${body}\n`, missing, forwarded, imports, symbols };
}

export interface TypeScriptBoundary {
  readonly extractorVersion: string;
  readonly outbound: readonly BoundaryModule[];
  readonly inbound: readonly BoundaryModule[];
  /** Declaration files standing in for cut modules, by artifact path. */
  readonly stubs: readonly { path: string; module: string; text: string }[];
  readonly blockers: readonly SliceBlocker[];
  /** Configuration files the included files are read with, sorted. */
  readonly configs: readonly string[];
  /** Package specifiers imported by included files or kept stubs, with the files. */
  readonly packages: ReadonlyMap<string, ReadonlySet<string>>;
  /** The options the fixture compiles with. */
  readonly compilerOptions: ts.CompilerOptions;
  /**
   * Imports of the repository's own packages, which resolve to their
   * source: the cuts and internal imports they add, with specifiers, and
   * each specifier's module.
   */
  readonly workspace: {
    readonly outbound: readonly CutEdge[];
    readonly internal: readonly CutEdge[];
    readonly modules: ReadonlyMap<string, string>;
  };
}

export interface TypeScriptBoundaryInput {
  readonly root: string;
  readonly included: readonly string[];
  readonly outbound: readonly CutEdge[];
  readonly inbound: readonly CutEdge[];
  readonly texts: ReadonlyMap<string, string>;
  /** Defaults to `PROGRAM_FILES_MAX`. */
  readonly maxProgramFiles?: number;
  /** The source of a repository package's specifier; see `workspaceModuleResolver`. */
  readonly workspaceModule?: (specifier: string) => string | null;
  /** A directory whose node_modules holds fetched package types. */
  readonly packageTypes?: string | null;
  /**
   * Whether stubs widen literal values to their types, so no constant's
   * value leaves the repository. Defaults to true.
   */
  readonly widenLiterals?: boolean;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function extractTypeScriptBoundary(
  input: TypeScriptBoundaryInput,
): TypeScriptBoundary {
  const root = resolve(input.root);
  const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
  const abs = (path: string) => resolve(root, path);
  const blockers: SliceBlocker[] = [];
  const configs = new Set<string>();
  const packages = new Map<string, Set<string>>();
  const scripts = input.included.filter(isScriptPath);
  const first = scripts[0] ?? input.included[0] ?? "";
  // Files in one directory share their nearest tsconfig; read each once.
  const loaded = new Map<string, LoadedConfig>();
  const configOf = (file: string) => {
    const key = dirname(file);
    const hit = loaded.get(key);
    if (hit !== undefined) return hit;
    const config = loadConfig(root, file);
    loaded.set(key, config);
    return config;
  };
  // The program compiles with the first script's options. A slice across
  // several tsconfigs records them all; if their options disagree, the
  // fixture compile reports it as a compile error.
  const config = configOf(first);
  const reported = new Set<string | null>();
  for (const file of input.included) {
    const own = configOf(file);
    if (own.path !== null) configs.add(own.path);
    if (reported.has(own.path)) continue;
    reported.add(own.path);
    for (const error of own.errors)
      blockers.push({
        code: "missing_build_input",
        file: own.path,
        location: null,
        detail: error,
      });
  }
  const options = stubExtractionOptions(config.options);
  const workspaceModule = input.workspaceModule ?? (() => null);
  const host = boundedHost(root, options, {
    workspaceModule,
    packageTypes: input.packageTypes ?? null,
  });
  const workspaceModules = new Map<string, string>();
  const workspaceEdges = {
    outbound: [] as CutEdge[],
    internal: [] as CutEdge[],
  };
  const maxFiles = input.maxProgramFiles ?? PROGRAM_FILES_MAX;
  let parsed = 0;
  const parse = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, ...rest) => {
    const path = rel(resolve(fileName));
    if (!path.startsWith("..") && !isAbsolute(path) && ++parsed > maxFiles)
      throw new ProgramTooLarge();
    return parse(fileName, ...rest);
  };
  const outside = new Set<string>();
  for (const edge of input.outbound) outside.add(edge.to);
  for (const edge of input.inbound) outside.add(edge.from);
  const rootNames = [...new Set([...scripts, ...outside])]
    .filter(isScriptPath)
    .map(abs);
  let program: ts.Program;
  try {
    program = ts.createProgram(rootNames, options, host);
  } catch (error) {
    if (!(error instanceof ProgramTooLarge)) throw error;
    return {
      extractorVersion: TYPESCRIPT_EXTRACTOR_VERSION,
      outbound: [],
      inbound: [],
      stubs: [],
      blockers: [
        ...blockers,
        {
          code: "declaration_incomplete",
          file: null,
          location: null,
          detail: `The slice's imports reach more than ${maxFiles} repository files; choose narrower entry points.`,
        },
      ],
      configs: [...configs].sort(compare),
      packages: new Map(),
      compilerOptions: config.options,
      workspace: { outbound: [], internal: [], modules: new Map() },
    };
  }
  const isRelativeSpecifier = (specifier: string) =>
    specifier.startsWith(".") || specifier.startsWith("/");
  const resolveSpecifier = (specifier: string, from: string) => {
    const resolved = ts.resolveModuleName(
      specifier,
      abs(from),
      options,
      host,
    ).resolvedModule;
    if (resolved === undefined) {
      // One of the repository's own packages, read from its source.
      const module = isRelativeSpecifier(specifier)
        ? null
        : workspaceModule(specifier);
      if (module !== null) workspaceModules.set(specifier, module);
      return module;
    }
    if (resolved.isExternalLibraryImport === true) return null;
    const path = rel(resolved.resolvedFileName);
    return path.startsWith("..") || isAbsolute(path) ? null : path;
  };
  const recordPackage = (specifier: string, file: string) => {
    if (isNodeBuiltin(specifier)) return;
    const list = packages.get(specifier) ?? new Set<string>();
    list.add(file);
    packages.set(specifier, list);
  };
  type Target =
    | { readonly module: string }
    | { readonly unresolved: true }
    | { readonly asset: true }
    | { readonly package: true };
  const classify = (specifier: string, from: string): Target => {
    const module = resolveSpecifier(specifier, from);
    if (module !== null) return { module };
    // A stylesheet or image the slice copies is no module to stub.
    if (
      isRelativeSpecifier(specifier) &&
      isAssetPath(specifier) &&
      existsSync(resolve(root, dirname(from), specifier.split(/[?#]/)[0] ?? ""))
    )
      return { asset: true };
    if (isRelativeSpecifier(specifier)) return { unresolved: true };
    // A bare specifier the root tree does not resolve is a package, which
    // the sandbox installs; a path alias that misses is a config problem.
    return { package: true };
  };
  const merge = (
    into: Map<
      string,
      { names: Set<string> | typeof ALL; importedBy: Set<string> }
    >,
    module: string,
    names: RequestedNames,
    by: string,
  ): boolean => {
    const entry = into.get(module) ?? {
      names: new Set<string>(),
      importedBy: new Set<string>(),
    };
    const before = entry.names === ALL ? -1 : entry.names.size;
    if (names === ALL) entry.names = ALL;
    else if (entry.names !== ALL)
      for (const name of names) entry.names.add(name);
    entry.importedBy.add(by);
    const grew =
      !into.has(module) ||
      (entry.names === ALL ? before !== -1 : entry.names.size !== before);
    into.set(module, entry);
    return grew;
  };
  const included = new Set(input.included);
  const requests = new Map<
    string,
    { names: Set<string> | typeof ALL; importedBy: Set<string> }
  >();
  // What an import asks of each module, apart from what a barrel's
  // `export *` forwards to it on the chance it has it.
  const direct = new Map<
    string,
    { names: Set<string> | typeof ALL; importedBy: Set<string> }
  >();
  /** An import's request; true when it asks `module` for more than before. */
  const asks = (module: string, names: RequestedNames, by: string) => {
    merge(direct, module, names, by);
    return merge(requests, module, names, by);
  };
  const surface = new Map<
    string,
    { names: Set<string> | typeof ALL; importedBy: Set<string> }
  >();
  // Imports of included files decide what the stubs must declare.
  for (const file of scripts) {
    const source = program.getSourceFile(abs(file));
    if (source === undefined) continue;
    for (const fact of importsOf(source)) {
      const target = classify(fact.specifier, file);
      if ("module" in target) {
        if (!included.has(target.module)) asks(target.module, fact.names, file);
        // A package of the repository is imported by its name, which the
        // generated project rewrites to the module like any path alias.
        if (workspaceModules.get(fact.specifier) === target.module)
          (included.has(target.module)
            ? workspaceEdges.internal
            : workspaceEdges.outbound
          ).push({
            from: file,
            to: target.module,
            relation: "imports",
            specifier: fact.specifier,
            location: `L${fact.line}`,
            typeOnly: false,
          });
      } else if ("package" in target) recordPackage(fact.specifier, file);
      else if ("unresolved" in target)
        blockers.push({
          code: "unresolved_import",
          file,
          location: `L${fact.line}`,
          detail: `${fact.specifier} does not resolve to a repository file.`,
        });
    }
  }
  // A graph link without a matching import (a module named to `vi.mock`,
  // a file read by path) still names a module the slice touches, whole.
  for (const edge of input.outbound)
    if (!requests.has(edge.to) && isScriptPath(edge.to))
      asks(edge.to, ALL, edge.from);
  // Imports from outside files decide the public surface.
  for (const by of new Set(input.inbound.map((edge) => edge.from))) {
    if (!isScriptPath(by)) continue;
    const source = program.getSourceFile(abs(by));
    if (source === undefined) continue;
    for (const fact of importsOf(source)) {
      const target = classify(fact.specifier, by);
      if ("module" in target && included.has(target.module))
        merge(surface, target.module, fact.names, by);
    }
  }
  for (const edge of input.inbound)
    if (!surface.has(edge.to) && isScriptPath(edge.to))
      merge(surface, edge.to, ALL, edge.from);
  const emitted = new Map<string, string | null>();
  const emit = (module: string): string | null => {
    const cached = emitted.get(module);
    if (cached !== undefined) return cached;
    const source = program.getSourceFile(abs(module));
    let text: string | null = null;
    if (source !== undefined) {
      const diagnostics = program.getDeclarationDiagnostics(source);
      for (const diagnostic of diagnostics.slice(0, 20))
        blockers.push({
          code: "declaration_incomplete",
          file: module,
          location:
            diagnostic.start === undefined
              ? null
              : `L${source.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`,
          detail: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        });
      program.emit(
        source,
        (fileName, content) => {
          if (/\.d\.[cm]?ts$/.test(fileName))
            text = sanitizeDeclaration(content, {
              widenLiterals: input.widenLiterals ?? true,
            });
        },
        undefined,
        true,
      );
    }
    emitted.set(module, text);
    return text;
  };
  const stubs = new Map<string, { module: string; text: string }>();
  const outbound = new Map<string, BoundaryModule>();
  // Names each module declares itself, and where its `export *` lead: null
  // for a package or an included file, which may have any name.
  const declares = new Map<string, ReadonlySet<string>>();
  const stars = new Map<string, readonly (string | null)[]>();
  const forwards = new Map<string, ReadonlySet<string>>();
  const queue = [...requests.keys()].sort(compare);
  const done = new Set<string>();
  while (queue.length > 0) {
    const module = queue.shift();
    if (module === undefined) break;
    if (done.has(module)) continue;
    done.add(module);
    if (done.size > STUB_CLOSURE_MAX) {
      blockers.push({
        code: "declaration_incomplete",
        file: null,
        location: null,
        detail: `More than ${STUB_CLOSURE_MAX} modules would need stubs.`,
      });
      break;
    }
    const request = requests.get(module);
    if (request === undefined) continue;
    const text = emit(module);
    if (text === null) {
      blockers.push({
        code: "declaration_incomplete",
        file: module,
        location: null,
        detail: "No declaration could be emitted for this module.",
      });
      outbound.set(module, {
        module,
        symbols:
          request.names === ALL
            ? []
            : [...request.names]
                .sort()
                .map((name) => ({ name, kind: "unknown", declaration: null })),
        importedBy: [...request.importedBy].sort(compare),
        stubPath: null,
      });
      continue;
    }
    const filtered = filterDeclaration(text, request.names);
    // A name only a barrel forwarded is judged at the barrel, below.
    const wanted = direct.get(module)?.names;
    for (const name of filtered.missing)
      if (wanted === ALL || wanted?.has(name) === true)
        blockers.push({
          code: "declaration_incomplete",
          file: module,
          location: null,
          detail: `${name} is not exported by this module.`,
        });
    declares.set(module, new Set(filtered.symbols.map(({ name }) => name)));
    forwards.set(
      module,
      new Set(
        filtered.forwarded.flatMap(({ names }) =>
          names === ALL ? [] : [...names],
        ),
      ),
    );
    const leads: (string | null)[] = [];
    // A stub names a module by a relative path, as the generated project
    // has neither the repository's packages nor its path aliases.
    const relocated = new Map<string, string>();
    for (const next of [...filtered.imports, ...filtered.forwarded]) {
      const star = filtered.forwarded.includes(next);
      const target = classify(next.specifier, module);
      if ("module" in target) {
        if (!isRelativeSpecifier(next.specifier))
          relocated.set(
            next.specifier,
            relativeSpecifier(module, target.module),
          );
        if (star)
          leads.push(included.has(target.module) ? null : target.module);
        if (included.has(target.module)) continue;
        // Asked for more than its stub has, a module is stubbed again.
        const grew = star
          ? merge(requests, target.module, next.names, module)
          : asks(target.module, next.names, module);
        if (grew) {
          done.delete(target.module);
          queue.push(target.module);
        }
      } else if ("package" in target) {
        if (star) leads.push(null);
        recordPackage(next.specifier, module);
      } else if ("unresolved" in target)
        blockers.push({
          code: "unresolved_import",
          file: module,
          location: null,
          detail: `${next.specifier} does not resolve to a repository file.`,
        });
    }
    stars.set(module, leads);
    queue.sort(compare);
    const path = stubPathFor(module);
    stubs.set(path, {
      module,
      text:
        relocated.size === 0
          ? filtered.text
          : rewriteModuleSpecifiers(
              filtered.text,
              (specifier) => relocated.get(specifier) ?? null,
            ),
    });
    outbound.set(module, {
      module,
      symbols: filtered.symbols.map((symbol) => ({ ...symbol })),
      importedBy: [...request.importedBy].sort(compare),
      stubPath: path,
    });
  }
  // A name a barrel forwards is missing only when no module its `export *`
  // lead to, however deep, declares it.
  const provides = (module: string, name: string, seen: Set<string>) => {
    if (declares.get(module)?.has(name) === true) return true;
    if (seen.has(module)) return false;
    seen.add(module);
    return (stars.get(module) ?? []).some(
      (lead): boolean => lead === null || provides(lead, name, seen),
    );
  };
  for (const [module, names] of forwards) {
    const wanted = direct.get(module)?.names;
    for (const name of names)
      if (
        (wanted === ALL || wanted?.has(name) === true) &&
        !provides(module, name, new Set())
      )
        blockers.push({
          code: "declaration_incomplete",
          file: module,
          location: null,
          detail: `${name} is not exported by this module.`,
        });
  }
  const inbound: BoundaryModule[] = [];
  for (const [module, request] of [...surface.entries()].sort(([a], [b]) =>
    compare(a, b),
  )) {
    const text = emit(module);
    if (text === null) {
      blockers.push({
        code: "declaration_incomplete",
        file: module,
        location: null,
        detail: "No declaration could be emitted for this module.",
      });
      inbound.push({
        module,
        symbols:
          request.names === ALL
            ? []
            : [...request.names]
                .sort()
                .map((name) => ({ name, kind: "unknown", declaration: null })),
        importedBy: [...request.importedBy].sort(compare),
        stubPath: null,
      });
      continue;
    }
    const filtered = filterDeclaration(text, request.names);
    for (const name of filtered.missing)
      blockers.push({
        code: "declaration_incomplete",
        file: module,
        location: null,
        detail: `${name} is imported from outside but not exported.`,
      });
    inbound.push({
      module,
      symbols: filtered.symbols.map((symbol) => ({ ...symbol })),
      importedBy: [...request.importedBy].sort(compare),
      stubPath: null,
    });
  }
  const dedupe = (list: SliceBlocker[]) => {
    const seen = new Set<string>();
    return list.filter((blocker) => {
      const key = JSON.stringify(blocker);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    extractorVersion: TYPESCRIPT_EXTRACTOR_VERSION,
    outbound: [...outbound.values()].sort((a, b) =>
      compare(a.module, b.module),
    ),
    inbound,
    stubs: [...stubs.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([path, stub]) => ({ path, ...stub })),
    blockers: dedupe(blockers),
    configs: [...configs].sort(compare),
    packages,
    compilerOptions: config.options,
    workspace: {
      outbound: workspaceEdges.outbound,
      internal: workspaceEdges.internal,
      modules: workspaceModules,
    },
  };
}
