/**
 * Whether an edit to a test weakens it: read from the syntax of the test
 * as it was and as it is, never run.
 *
 * A test may grow. Its assertions, the statements they rest on (the data
 * passed in, the value compared with, the setup, a fake's method), and
 * the tests it skips or focuses are what it held the code to, and an edit
 * that removes, rewrites, guards or outruns one of them is held for the
 * maintainer: an expected value changed may be the change that was asked
 * for, or a test bent to pass. Statements are compared as TypeScript prints
 * them, so formatting is no change and a string's own characters are.
 */

import ts from "typescript";

/** Calls whose function arguments hold a test or its hooks. */
export const TEST_STRUCTURE: ReadonlySet<string> = new Set([
  "describe",
  "suite",
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

/** Of those, the hooks: code that runs before or after every test of its scope. */
const HOOKS: ReadonlySet<string> = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll", "before", "after"]);

/** Of those, the groups: a plain one only names its tests, and wrapping tests in one changes none. */
const GROUPS: ReadonlySet<string> = new Set(["describe", "suite"]);

/** Whether a structural call is a plain group (`describe("x", …)`), adding nothing to what its tests run. */
const plainGroup = (call: ts.CallExpression) => ts.isIdentifier(call.expression) && GROUPS.has(call.expression.text);

/** Test calls that run their body only sometimes, or expect it to fail. */
const CONDITIONAL_TESTS: ReadonlySet<string> = new Set(["skipIf", "runIf", "fails", "failing", "todoIf"]);

/** Modules whose every export asserts: `node:assert`'s `equal`, the `expect` package. */
const ASSERT_EVERY = /^(node:)?assert(\/strict)?$|^expect$/;
/** Modules a test takes its runner from, with only these names asserting. */
const ASSERT_NAMED = /^(vitest|@jest\/globals|chai|bun:test|node:test|test)$/;
const ASSERTING_NAMES: ReadonlySet<string> = new Set(["expect", "expectTypeOf", "assertType", "assert", "should"]);

/** The script kind TypeScript should parse a path as. */
export const scriptKindOf = (path: string) =>
  /\.[cm]?tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/**
 * A node as TypeScript prints it, its strings in one quoting: the same
 * code, however it is laid out, quoted or semicoloned, prints the same,
 * and a string's own characters are kept. A trailing comma is layout.
 */
export function canonical(node: ts.Node, source: ts.SourceFile): string {
  const result = ts.transform(node, [
    (context) => (root) => {
      const visit = (child: ts.Node): ts.Node =>
        ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)
          ? ts.factory.createStringLiteral(child.text)
          : ts.visitEachChild(child, visit, context);
      return ts.visitNode(root, visit) as ts.Node;
    },
  ]);
  try {
    const printed = printer.printNode(ts.EmitHint.Unspecified, result.transformed[0] ?? node, source);
    return printed.replace(/,(\s*[)\]}])/g, "$1");
  } finally {
    result.dispose();
  }
}

/**
 * The names a test file's assertions go by: `assert` and `expect`, every
 * name imported from an assertion module (`strictEqual` from `node:assert`),
 * and from a runner's module only its asserting names (`expect` from
 * `vitest`, never `describe`), whether imported or required.
 */
export function assertionRoots(source: ts.SourceFile): Set<string> {
  const roots = new Set(["assert", "expect"]);
  const take = (module: string, names: readonly string[]) => {
    if (ASSERT_EVERY.test(module)) for (const name of names) roots.add(name);
    else if (ASSERT_NAMED.test(module)) for (const name of names) if (ASSERTING_NAMES.has(name)) roots.add(name);
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const names: string[] = [];
      if (clause?.name !== undefined) names.push(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
      else if (bindings !== undefined)
        for (const element of bindings.elements)
          // `import { expect as check }`: the local name asserts if the exported one does.
          names.push(ASSERT_EVERY.test(statement.moduleSpecifier.text) || ASSERTING_NAMES.has((element.propertyName ?? element.name).text) ? element.name.text : "");
      take(statement.moduleSpecifier.text, names.filter(Boolean));
    }
    // `const assert = require("node:assert")`, `const { expect } = require("chai")`
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          init === undefined ||
          !ts.isCallExpression(init) ||
          !ts.isIdentifier(init.expression) ||
          init.expression.text !== "require" ||
          init.arguments[0] === undefined ||
          !ts.isStringLiteral(init.arguments[0])
        )
          continue;
        const module = init.arguments[0].text;
        if (ts.isIdentifier(declaration.name)) take(module, [ASSERT_EVERY.test(module) ? declaration.name.text : ""]);
        else if (ts.isObjectBindingPattern(declaration.name))
          take(
            module,
            declaration.name.elements.map((element) => (ts.isIdentifier(element.name) ? element.name.text : "")),
          );
      }
  }
  roots.delete("");
  return roots;
}

/** The identifier a call or member chain starts at, or null. */
export function chainRoot(node: ts.Expression): string | null {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
    else if (ts.isCallExpression(current)) current = current.expression;
    else if (
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    )
      current = current.expression;
    else return null;
  }
}

/**
 * Whether an expression is a constant the code can read without running
 * it: `true`, `false`, `0`, `1`, `""`, `null`, `undefined`, `!x` of one, or
 * one in parentheses. Null for anything else.
 */
export function constantOf(node: ts.Expression): boolean | null {
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

/**
 * Whether a node holds a `return`, `break` or `continue` outside any
 * function inside it: a way to leave before what follows runs. A `throw`
 * fails the test instead, which weakens nothing.
 */
function exits(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isReturnStatement(child) || ts.isBreakStatement(child) || ts.isContinueStatement(child)) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Whether a call is a test or a hook: its callee's chain starts at one of their names. */
function structural(call: ts.CallExpression): boolean {
  return TEST_STRUCTURE.has(chainRoot(call.expression) ?? "");
}

/** A test call's header: its callee and its arguments other than functions, printed. */
function headerOf(call: ts.CallExpression, source: ts.SourceFile): string {
  return `${canonical(call.expression, source)}(${call.arguments
    .filter((argument) => !ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))
    .map((argument) => canonical(argument, source))
    .join(",")})`;
}

/**
 * The assertions of a test file, each as what it runs under and its
 * printed text, and the tests it skips or focuses. An assertion is a call
 * rooted at an assertion name (`assertionRoots`); what it runs under is
 * every condition, loop, early exit, callback and test between it and the
 * file (`guardsOf`), so an assertion moved under `if (result)`, after an
 * `if (x) return;`, into a callback nothing calls or into another test
 * counts as rewritten. Code that never runs holds no assertion. A skip is
 * `test.skip`, `it.todo`, `xit`, a `{ skip }` or `{ todo }` option (any
 * key spelling, or options not written out), `.skip()` or `.todo()` on a
 * test's context, a conditional test (`it.skipIf`, `it.fails`) or an
 * empty table (`it.each([])`); a focus is `.only`, `fit` or `fdescribe`.
 */
function assertionsOf(path: string, text: string): { assertions: string[]; skips: number; focused: number } {
  const source = parse(path, text);
  const roots = assertionRoots(source);
  /** The test contexts in scope: the first parameter of each test's function, by name. */
  const guardsOf = (node: ts.Node): string => {
    const guards: string[] = [];
    let child: ts.Node = node;
    for (let current = node.parent; current !== undefined; current = current.parent) {
      // An earlier statement of the same block that may leave it.
      if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isCaseClause(current) || ts.isDefaultClause(current) || ts.isModuleBlock(current)) {
        const statements: readonly ts.Statement[] = current.statements;
        const at = statements.indexOf(child as ts.Statement);
        for (const earlier of statements.slice(0, Math.max(0, at)))
          if (exits(earlier)) guards.push(`after(${canonical(earlier, source)})`);
      }
      if (ts.isSourceFile(current)) break;
      if (ts.isIfStatement(current)) {
        const known = constantOf(current.expression);
        if (child === current.thenStatement && known !== true) guards.push(`if(${canonical(current.expression, source)})`);
        if (child === current.elseStatement && known !== false) guards.push(`else(${canonical(current.expression, source)})`);
      } else if (ts.isConditionalExpression(current)) {
        if (child === current.whenTrue) guards.push(`?(${canonical(current.condition, source)})`);
        if (child === current.whenFalse) guards.push(`:(${canonical(current.condition, source)})`);
      } else if (ts.isBinaryExpression(current) && child === current.right) {
        const operator = current.operatorToken.kind;
        const known = constantOf(current.left);
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken && known !== true) guards.push(`&&(${canonical(current.left, source)})`);
        if (operator === ts.SyntaxKind.BarBarToken && known !== false) guards.push(`||(${canonical(current.left, source)})`);
        if (operator === ts.SyntaxKind.QuestionQuestionToken) guards.push(`??(${canonical(current.left, source)})`);
      } else if (ts.isForOfStatement(current) || ts.isForInStatement(current)) {
        if (child === current.statement) guards.push(`for(${canonical(current.expression, source)})`);
      } else if (ts.isForStatement(current) || ts.isWhileStatement(current)) {
        if (child === current.statement)
          guards.push(
            `loop(${ts.isForStatement(current) ? (current.condition === undefined ? "" : canonical(current.condition, source)) : canonical(current.expression, source)})`,
          );
      } else if (ts.isCaseClause(current)) {
        guards.push(`case(${canonical(current.expression, source)})`);
      } else if (ts.isDefaultClause(current)) {
        guards.push("default");
      } else if (ts.isLabeledStatement(current)) {
        guards.push(`label(${current.label.text})`);
      } else if (ts.isCatchClause(current)) {
        // Runs only when the block before it failed. (A `try` whose catch
        // swallows the failure is `assertionsOf`'s; one that throws again,
        // and a `finally`, run as the code around them.)
        guards.push("catch");
      } else if (ts.isFunctionLike(current)) {
        // A test's or a hook's own function adds its header; any other
        // function runs only when something calls it.
        const call = current.parent;
        if (call !== undefined && ts.isCallExpression(call) && call.arguments.some((argument) => argument === current) && structural(call)) {
          if (!plainGroup(call)) guards.push(headerOf(call, source));
        } else
          guards.push(
            `fn(${call !== undefined && ts.isCallExpression(call) ? canonical(call.expression, source) : ts.isFunctionDeclaration(current) ? (current.name?.text ?? "") : String(current.kind)})`,
          );
      }
      child = current;
    }
    return guards.reverse().join(">");
  };
  /** The names a test's context goes by in the functions around a node. */
  const contextNames = (node: ts.Node): Set<string> => {
    const names = new Set<string>();
    for (let current = node.parent; current !== undefined; current = current.parent)
      if (ts.isFunctionLike(current) && current.parent !== undefined && ts.isCallExpression(current.parent) && structural(current.parent)) {
        const first = current.parameters[0];
        if (first !== undefined && ts.isIdentifier(first.name)) names.add(first.name.text);
        if (first !== undefined && ts.isObjectBindingPattern(first.name))
          for (const element of first.name.elements)
            if (ts.isIdentifier(element.name)) names.add(`{${(element.propertyName ?? element.name).getText(source)}}${element.name.text}`);
      }
    return names;
  };
  const assertions: string[] = [];
  let skips = 0;
  let focused = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const base = chainRoot(callee);
      const testCall = base !== null && ["test", "it", "describe", "suite", "specify"].includes(base);
      if ((name === "skip" || name === "todo") && testCall) skips += 1;
      if (name !== null && CONDITIONAL_TESTS.has(name) && testCall) skips += 1;
      // `it.each([])`: a table with no rows runs nothing.
      if (
        name === "each" &&
        testCall &&
        node.arguments.length === 1 &&
        ts.isArrayLiteralExpression(node.arguments[0] as ts.Expression) &&
        (node.arguments[0] as ts.ArrayLiteralExpression).elements.length === 0
      )
        skips += 1;
      if (name === "only" && testCall) focused += 1;
      if (ts.isIdentifier(callee) && (callee.text === "fit" || callee.text === "fdescribe")) focused += 1;
      if (ts.isIdentifier(callee) && ["xit", "xdescribe", "xtest", "xspecify"].includes(callee.text)) skips += 1;
      // `t.skip()`, `ctx.todo()`, or `skip()` taken from a test's context.
      if (
        (name === "skip" || name === "todo") &&
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        contextNames(node).has(callee.expression.text)
      )
        skips += 1;
      if (
        ts.isIdentifier(callee) &&
        [...contextNames(node)].some((entry) => entry === `{skip}${callee.text}` || entry === `{todo}${callee.text}`)
      )
        skips += 1;
      if (testCall)
        for (const argument of node.arguments) {
          if (ts.isObjectLiteralExpression(argument))
            for (const property of argument.properties) {
              const key =
                ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
                  ? ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
                    ? property.name.text
                    : null
                  : null;
              // A spread or a computed key could be either.
              if (key === null) skips += 1;
              else if (
                (key === "skip" || key === "todo") &&
                !(ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword)
              )
                skips += 1;
            }
          // Options not written out (`test("x", opts, fn)`): they could skip it.
          else if (
            !ts.isStringLiteralLike(argument) &&
            !ts.isTemplateExpression(argument) &&
            !ts.isArrowFunction(argument) &&
            !ts.isFunctionExpression(argument) &&
            !ts.isNumericLiteral(argument) &&
            !(ts.isIdentifier(argument) && argument === node.arguments[node.arguments.length - 1]) &&
            argument !== node.arguments[0]
          )
            skips += 1;
        }
      if (base !== null && roots.has(base)) {
        // The outermost call of a chain is the assertion: `expect(x).toBe(y)`.
        const guards = guardsOf(node);
        const printed = canonical(node, source);
        assertions.push(guards === "" ? printed : `${guards}>${printed}`);
        return;
      }
    }
    // Code that never runs holds no assertion: what follows a `return`,
    // `throw`, `break` or `continue` in its block, and the branch of an
    // `if` (or the body of a loop) on a constant that never takes it.
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
    // An assertion in a `try` fails into its `catch`, which passes unless it
    // ends by throwing again; a `finally` that leaves swallows it too.
    if (ts.isTryStatement(node)) {
      const catchClause = node.catchClause;
      const last = catchClause?.block.statements.at(-1);
      const rethrows = catchClause === undefined || (last !== undefined && ts.isThrowStatement(last));
      const finallyLeaves = node.finallyBlock !== undefined && exits(node.finallyBlock);
      if (rethrows && !finallyLeaves) visit(node.tryBlock);
      if (catchClause !== undefined) visit(catchClause.block);
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
    const loopCondition = ts.isWhileStatement(node) ? node.expression : ts.isForStatement(node) ? node.condition : undefined;
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

/** A statement of a test file, as `statementsOf` keeps it. */
interface Statement {
  /** Its printed text, with the tests and hooks around it. */
  readonly key: string;
  /** Where it sits: `top`, or inside a test's or a hook's body. */
  readonly scope: "top" | "body";
  /** The names it declares. */
  readonly declares: readonly string[];
  /** A test or a hook (its header), an import, a class member, or anything else. */
  readonly kind: "test" | "hook" | "import" | "member" | "other";
  /** The test or hook it sits in, as its key: "" at the top or in a plain group. */
  readonly parent: string;
  /** An import's module. */
  readonly from?: string;
  /** The assertions that run after it in its body, printed. */
  readonly assertionsAfter: readonly string[];
  /**
   * Whether it holds an assertion and nothing else that runs (`if (x)
   * assert(…)`): such a statement is judged by its assertions' identity.
   */
  readonly onlyAssertions: boolean;
  /** The assertions it holds, printed. */
  readonly assertionsInside: readonly string[];
  /**
   * A declaration's names and its literal's parts, when it binds an array
   * or object literal: `const cases = [[1, 1]]` may grow a row.
   */
  readonly literal?: { readonly head: string; readonly parts: readonly string[] };
}

/** The names a declaration statement binds. */
function declaredNames(node: ts.Statement): string[] {
  const names: string[] = [];
  const bind = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) bind(declaration.name);
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name !== undefined)
    names.push(node.name.text);
  return names;
}

/**
 * The statements of a test file that a change may add to but not alter,
 * each printed with the tests and hooks around it: the code a test's
 * verdict rests on besides its assertions (its data, its setup, its mocks,
 * its helpers). The walk descends into the bodies of tests and hooks, so a
 * test added inside a `describe` leaves the others as they were, and into
 * class bodies, so a method added to a fake leaves the others. Imports
 * count by the names they bind. Assertions are `assertionsOf`'s.
 */
function statementsOf(path: string, text: string): Statement[] {
  const source = parse(path, text);
  const roots = assertionRoots(source);
  type Entry = Omit<Statement, "assertionsAfter" | "onlyAssertions" | "assertionsInside" | "literal"> & { readonly node: ts.Node };
  const out: Entry[] = [];
  const statement = (node: ts.Statement, prefix: string, scope: "top" | "body"): void => {
    const parent = prefix.endsWith(">") ? prefix.slice(0, -1) : prefix;
    if (ts.isImportDeclaration(node)) {
      const from = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : canonical(node.moduleSpecifier, source);
      const quoted = JSON.stringify(from);
      const clause = node.importClause;
      const add = (key: string, name: string) =>
        out.push({ key: `${prefix}${key}`, scope, declares: [name], kind: "import", parent, from, node });
      if (clause === undefined) out.push({ key: `${prefix}import ${quoted}`, scope, declares: [], kind: "import", parent, from, node });
      else {
        if (clause.name !== undefined) add(`import ${clause.name.text} from ${quoted}`, clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) add(`import * as ${bindings.name.text} from ${quoted}`, bindings.name.text);
        else if (bindings !== undefined)
          for (const element of bindings.elements) add(`import { ${canonical(element, source)} } from ${quoted}`, element.name.text);
      }
      return;
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const root = chainRoot(call.expression);
      if (root !== null && roots.has(root)) return;
      if (root !== null && TEST_STRUCTURE.has(root)) {
        const header = headerOf(call, source);
        out.push({ key: `${prefix}${header}`, scope, declares: [], kind: HOOKS.has(root) ? "hook" : "test", parent, node });
        // A plain group's body runs as the file's top does; a test's or a
        // hook's statements are its own.
        const inner = plainGroup(call) ? prefix : `${prefix}${header}>`;
        const innerScope = plainGroup(call) ? scope : "body";
        for (const argument of call.arguments)
          if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
            if (ts.isBlock(argument.body)) for (const each of argument.body.statements) statement(each, inner, innerScope);
            else
              out.push({
                key: `${inner}${canonical(argument.body, source)}`,
                scope: innerScope,
                declares: [],
                kind: "other",
                parent: inner.endsWith(">") ? inner.slice(0, -1) : inner,
                node: argument.body,
              });
          }
        return;
      }
    }
    if (ts.isClassDeclaration(node)) {
      const head = source.text.slice(node.getStart(source), node.members.pos).replace(/\s+/g, " ").trim();
      out.push({ key: `${prefix}${head}`, scope, declares: declaredNames(node), kind: "other", parent, node });
      for (const member of node.members)
        out.push({ key: `${prefix}${head}>${canonical(member, source)}`, scope, declares: [], kind: "member", parent, node: member });
      return;
    }
    out.push({ key: `${prefix}${canonical(node, source)}`, scope, declares: declaredNames(node), kind: "other", parent, node });
  };
  for (const node of source.statements) statement(node, "", "top");
  // The assertions, by where they start, printed.
  const assertionsAt: { at: number; text: string }[] = [];
  const findAssertions = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = chainRoot(node.expression);
      if (root !== null && roots.has(root)) {
        assertionsAt.push({ at: node.getStart(source), text: canonical(node, source) });
        return;
      }
    }
    ts.forEachChild(node, findAssertions);
  };
  findAssertions(source);
  /** Whether a node holds an assertion, and no other statement that does something. */
  const onlyAssertions = (node: ts.Node): boolean => {
    let assertions = 0;
    let other = false;
    const walk = (child: ts.Node): void => {
      if (other) return;
      if (ts.isCallExpression(child)) {
        const root = chainRoot(child.expression);
        if (root !== null && roots.has(root)) {
          assertions += 1;
          return;
        }
      }
      if (ts.isExpressionStatement(child) && !(ts.isCallExpression(child.expression) && roots.has(chainRoot(child.expression.expression) ?? ""))) {
        other = true;
        return;
      }
      if (ts.isVariableStatement(child) || ts.isFunctionLike(child) || ts.isClassLike(child)) {
        other = true;
        return;
      }
      // A catch runs once the test has failed; whether it swallows that is
      // the assertions' question.
      if (ts.isCatchClause(child)) return;
      ts.forEachChild(child, walk);
    };
    walk(node);
    return assertions > 0 && !other;
  };
  /** `const x = [..]` or `const x = {..}`: its head and its literal's parts, printed. */
  const literalOf = (node: ts.Node): Statement["literal"] => {
    if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) return undefined;
    const declaration = node.declarationList.declarations[0];
    let init = declaration?.initializer;
    while (init !== undefined && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
    if (declaration === undefined || init === undefined) return undefined;
    const head = `${ts.tokenToString(node.declarationList.flags & ts.NodeFlags.Const ? ts.SyntaxKind.ConstKeyword : ts.SyntaxKind.LetKeyword)} ${canonical(declaration.name, source)}${declaration.type === undefined ? "" : `: ${canonical(declaration.type, source)}`}`;
    if (ts.isArrayLiteralExpression(init)) return { head: `${head} = [`, parts: init.elements.map((element) => canonical(element, source)) };
    if (ts.isObjectLiteralExpression(init)) return { head: `${head} = {`, parts: init.properties.map((property) => canonical(property, source)) };
    return undefined;
  };
  return out.map(({ node, ...entry }) => {
    const block = node.parent;
    const end = node.getEnd();
    const start = node.getStart(source);
    const literal = entry.kind === "other" ? literalOf(node) : undefined;
    return {
      ...entry,
      ...(literal === undefined ? {} : { literal }),
      assertionsInside: assertionsAt.filter(({ at }) => at >= start && at < end).map(({ text }) => text),
      onlyAssertions: entry.kind === "other" && onlyAssertions(node),
      assertionsAfter:
        entry.scope === "body" && block !== undefined
          ? assertionsAt.filter(({ at }) => at > end && at < block.getEnd()).map(({ text }) => text)
          : [],
    };
  });
}

/** How much of a statement's key is its own text, past the tests around it. */
function canonicalLength(statements: readonly Statement[], key: string): number {
  const entry = statements.find((each) => each.key === key);
  return entry === undefined ? key.length : key.length - (entry.parent === "" ? 0 : entry.parent.length + 1);
}

/** Every assertion of a file, printed, wherever it is. */
function assertionTexts(path: string, text: string): string[] {
  const source = parse(path, text);
  const roots = assertionRoots(source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = chainRoot(node.expression);
      if (root !== null && roots.has(root)) {
        found.push(canonical(node, source));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** What `before` holds that `after` does not, counted as multisets. */
export function removedFrom(before: readonly string[], after: readonly string[]): string[] {
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

/** Whether a module specifier names the code's own module: a path, or a path alias. */
export function ownSpecifier(specifier: string): boolean {
  return /^(\.|\/|~\/|#|@\/)/.test(specifier);
}

/**
 * How a test file stands in for the code's own modules: a module mocked by
 * specifier (`vi.mock("./cart")`, `jest.mock`, `mock.module`) that is the
 * code's own or named by a computed value, a function spied on or a member
 * written on a binding imported from one (`vi.spyOn(pricing, "round")`,
 * `mock.method(cart, "total")`, `pricing.round = …`). A package's mock
 * (`vi.mock("stripe")`) stands in for a service, not for the code.
 */
function ownModuleMocks(path: string, text: string): string[] {
  const source = parse(path, text);
  const own = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!ownSpecifier(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name !== undefined) own.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) own.add(bindings.name.text);
    else if (bindings !== undefined) for (const element of bindings.elements) own.add(element.name.text);
  }
  const mocked: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const method = callee.name.text;
      const target = callee.expression;
      const byModule =
        (["mock", "doMock", "unstable_mockModule"].includes(method) &&
          ts.isIdentifier(target) &&
          (target.text === "vi" || target.text === "jest")) ||
        (method === "module" &&
          ((ts.isIdentifier(target) && target.text === "mock") ||
            (ts.isPropertyAccessExpression(target) && target.name.text === "mock")));
      if (byModule) {
        const first = node.arguments[0];
        const name = first !== undefined && ts.isStringLiteralLike(first) ? first.text : null;
        if (name === null) mocked.push("a module named by a computed value");
        else if (ownSpecifier(name)) mocked.push(name);
      }
      const spies =
        (method === "spyOn" && ts.isIdentifier(target) && ["vi", "jest"].includes(target.text)) ||
        (method === "method" && ((ts.isIdentifier(target) && target.text === "mock") || (ts.isPropertyAccessExpression(target) && target.name.text === "mock"))) ||
        (["stub", "replace", "spy"].includes(method) && ts.isIdentifier(target) && target.text === "sinon");
      const first = node.arguments[0];
      if (spies && first !== undefined) {
        const root = chainRoot(first);
        if (root !== null && own.has(root)) mocked.push(`${root} (spied on)`);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      const root = chainRoot(node.left);
      if (root !== null && own.has(root)) mocked.push(`${root} (a member written)`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return mocked;
}

/**
 * Why a change to a test weakens it, or null: an assertion removed,
 * rewritten or put where it may not run; a test skipped or focused; a
 * statement the assertions rest on rewritten or removed; a mock, spy or
 * member write of the code's own module added, which can stand in for the
 * code under test; or a statement added that changes what a kept assertion
 * reads (one that declares a name the test already reads, a hook in a
 * scope that holds tests, top-level code, or a statement before a kept
 * assertion in its body). A new test, a new import, a new helper with a
 * name of its own and statements after the last assertion pass.
 */
export function weakenedTest(
  path: string,
  before: string,
  after: string,
  noun = "a test the slice was handed",
): string | null {
  const old = assertionsOf(path, before);
  const now = assertionsOf(path, after);
  const oldStatements = statementsOf(path, before);
  const newStatements = statementsOf(path, after);
  // A data table or a fake object that only grew (a row, a field) keeps
  // every part it had: kept, and the growth is no new statement.
  const grownFrom = new Map<string, string>();
  const removedKeys = removedFrom(
    oldStatements.map((entry) => entry.key),
    newStatements.map((entry) => entry.key),
  );
  const addedKeys = removedFrom(
    newStatements.map((entry) => entry.key),
    oldStatements.map((entry) => entry.key),
  );
  for (const oldKey of removedKeys) {
    const was = oldStatements.find((entry) => entry.key === oldKey)?.literal;
    if (was === undefined) continue;
    const prefix = oldKey.slice(0, oldKey.length - canonicalLength(oldStatements, oldKey));
    const grown = addedKeys.find((newKey) => {
      if (grownFrom.has(newKey) || !newKey.startsWith(prefix)) return false;
      const now = newStatements.find((entry) => entry.key === newKey)?.literal;
      return now !== undefined && now.head === was.head && removedFrom(was.parts, now.parts).length === 0;
    });
    if (grown !== undefined) grownFrom.set(grown, oldKey);
  }
  const grownOld = new Set(grownFrom.values());
  const rewritten = removedKeys.filter((key) => !grownOld.has(key)).length;
  const mocks = [...new Set(removedFrom(ownModuleMocks(path, after), ownModuleMocks(path, before)))].sort();
  // What the change adds, and whether each can change a kept assertion's verdict.
  const added = addedKeys.filter((key) => !grownFrom.has(key));
  const readBefore = new Set<string>();
  const names = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) readBefore.add(node.text);
    ts.forEachChild(node, names);
  };
  names(parse(path, before));
  const oldKeys = new Set(oldStatements.map((entry) => entry.key));
  const keptAssertions = new Set(assertionTexts(path, before));
  const risky = new Set<string>();
  const pool = new Map<string, Statement[]>();
  for (const entry of newStatements) pool.set(entry.key, [...(pool.get(entry.key) ?? []), entry]);
  for (const key of added) {
    const entry = pool.get(key)?.shift();
    if (entry === undefined) continue;
    // A new test's own statements run for it alone.
    if (entry.parent !== "" && !oldKeys.has(entry.parent)) continue;
    if (entry.kind === "test" || entry.kind === "member" || entry.onlyAssertions) continue;
    // A new block, loop or branch around a kept assertion, with code of its
    // own: what the assertion reads may be that code's.
    if (entry.assertionsInside.some((text) => keptAssertions.has(text))) {
      risky.add(key);
      continue;
    }
    if (entry.kind === "import") {
      // A name the test read, bound anew: unless from its runner, what it reads changed.
      const runner = entry.from !== undefined && (ASSERT_EVERY.test(entry.from) || ASSERT_NAMED.test(entry.from));
      if (!runner && entry.declares.some((name) => readBefore.has(name))) risky.add(key);
      continue;
    }
    if (entry.kind === "hook") {
      risky.add(key);
      continue;
    }
    if (entry.declares.length > 0) {
      // A helper with a name of its own passes; one that shadows a name the test reads does not.
      if (entry.declares.some((name) => readBefore.has(name))) risky.add(key);
      continue;
    }
    if (entry.scope === "top" || entry.assertionsAfter.some((text) => keptAssertions.has(text))) risky.add(key);
  }
  const reasons: string[] = [];
  const removed = removedFrom(old.assertions, now.assertions).length;
  if (removed > 0) reasons.push(`removes or rewrites ${removed} assertion${removed === 1 ? "" : "s"} of ${noun}`);
  if (now.skips > old.skips) reasons.push(`skips ${now.skips - old.skips} more test${now.skips - old.skips === 1 ? "" : "s"}`);
  if (now.focused > old.focused)
    reasons.push(
      `focuses ${now.focused - old.focused} more test${now.focused - old.focused === 1 ? "" : "s"} with .only, which skips the rest of the file`,
    );
  if (rewritten > 0)
    reasons.push(
      `rewrites or removes ${rewritten} other statement${rewritten === 1 ? "" : "s"} of ${noun} (the data, setup, mocks or helpers its assertions rest on)`,
    );
  if (mocks.length > 0)
    reasons.push(`mocks ${mocks.length} more of the code's own modules (${mocks.join(", ")}), which can stand in for the code under test`);
  if (risky.size > 0)
    reasons.push(
      `adds ${risky.size} statement${risky.size === 1 ? "" : "s"} that run before ${noun}'s assertions or shadow a name they read`,
    );
  return reasons.length === 0 ? null : reasons.join(", and ");
}
