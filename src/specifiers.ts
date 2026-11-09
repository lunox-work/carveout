/**
 * The module specifiers a source writes, read from its syntax tree rather
 * than by pattern: imports and re-exports, `require` and `import()`,
 * `import("x").T` in a type, `import x = require("y")`, and the calls that
 * name a module to a test runner or a resolver (`vi.mock`,
 * `jest.requireActual`, `require.resolve`, `import.meta.resolve`).
 *
 * A regex over the text (the former `IMPORT_LITERAL`) misread an import
 * quoted in a comment, a string that said `from`, or a clause spanning
 * lines, and each misreading was a false `import_unrewritable` blocker or
 * a specifier left unrewritten (E6c: 23 such blockers, 3 green templates
 * marked not ready). The tree has none of those: a specifier is a string
 * literal in one of the positions below, and nothing else is one.
 */

import ts from "typescript";

/** Where a specifier sits in the source. */
export interface SpecifierLiteral {
  /** The text between the quotes. */
  readonly specifier: string;
  /** Offsets of that text in the source. */
  readonly start: number;
  readonly end: number;
  /**
   * `import`: an import, re-export or `import()`; `require`: a `require`
   * call; `type`: `import("x")` in a type; `reference`: a call that names a
   * module without loading it (`vi.mock`, `require.resolve`).
   */
  readonly kind: "import" | "require" | "type" | "reference";
  /** Whether only types are imported (`import type`, `export type`). */
  readonly typeOnly: boolean;
}

/** Calls that name a module to a test runner or a resolver. */
export const MODULE_REFERENCE_CALLS: readonly string[] = [
  "vi.mock",
  "vi.doMock",
  "vi.unmock",
  "vi.doUnmock",
  "vi.importActual",
  "vi.importMock",
  "jest.mock",
  "jest.doMock",
  "jest.unmock",
  "jest.dontMock",
  "jest.requireActual",
  "jest.requireMock",
  "jest.createMockFromModule",
  "require.resolve",
  "import.meta.resolve",
];

const SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

/** The parse of `text` as the file at `path` would be parsed. */
export function parseSource(path: string, text: string): ts.SourceFile {
  const extension = /\.[cm]?[jt]sx?$/.exec(path)?.[0] ?? ".ts";
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    SCRIPT_KIND[extension] ?? ts.ScriptKind.TS,
  );
}

/** The dotted name of a call's callee, when it is one (`vi.mock`). */
function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isMetaProperty(expression)) return "import.meta";
  if (ts.isPropertyAccessExpression(expression)) {
    const object = calleeName(expression.expression);
    return object === null ? null : `${object}.${expression.name.text}`;
  }
  return null;
}

const isLiteral = (
  node: ts.Node | undefined,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  node !== undefined &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/**
 * Every module specifier in `text`, in source order. The same literal is
 * never reported twice.
 */
export function moduleSpecifiers(
  path: string,
  text: string,
  source: ts.SourceFile = parseSource(path, text),
): SpecifierLiteral[] {
  const found: SpecifierLiteral[] = [];
  const add = (
    literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
    kind: SpecifierLiteral["kind"],
    typeOnly = false,
  ) => {
    const start = literal.getStart(source) + 1;
    const end = literal.getEnd() - 1;
    if (end <= start) return;
    found.push({ specifier: text.slice(start, end), start, end, kind, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (isLiteral(node.moduleSpecifier))
        add(
          node.moduleSpecifier,
          "import",
          node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
        );
    } else if (ts.isExportDeclaration(node)) {
      if (isLiteral(node.moduleSpecifier))
        add(node.moduleSpecifier, "import", node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        isLiteral(node.moduleReference.expression)
      )
        add(node.moduleReference.expression, "require", node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && isLiteral(node.argument.literal))
        add(node.argument.literal, "type", true);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (isLiteral(first)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(first, "import");
        else {
          const callee = calleeName(node.expression);
          if (callee === "require") add(first, "require");
          else if (callee !== null && MODULE_REFERENCE_CALLS.includes(callee))
            add(first, "reference");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.sort((a, b) => a.start - b.start);
}

/** The distinct specifiers of `text`, in source order. */
export function specifiersIn(path: string, text: string): string[] {
  return [...new Set(moduleSpecifiers(path, text).map((item) => item.specifier))];
}

/**
 * `text` with each specifier replaced by what `replace` returns for it, or
 * left as written when it returns null. Positions come from one parse, so
 * a replacement never shifts another's.
 */
export function rewriteSpecifiers(
  path: string,
  text: string,
  replace: (literal: SpecifierLiteral) => string | null,
): string {
  // Asked in source order, so a caller keeping state (the originals of an
  // ambiguous rewrite, in the order the source had them) sees the file
  // as it reads; applied from the end, so no replacement shifts another.
  const edits = moduleSpecifiers(path, text).flatMap((literal) => {
    const to = replace(literal);
    return to === null || to === literal.specifier ? [] : [{ ...literal, to }];
  });
  let result = text;
  for (const edit of edits.reverse())
    result = `${result.slice(0, edit.start)}${edit.to}${result.slice(edit.end)}`;
  return result;
}
