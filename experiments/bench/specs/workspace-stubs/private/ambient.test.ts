import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NODE_GLOBAL_DECLARATIONS,
  ambientDeclarations,
} from "../../src/sandbox/project.js";

/** The 4 lines of HEADER, as the spec writes them. */
const H = [
  "// The same declarations the slice was type-checked against: Node's",
  "// modules and globals untyped, and every package untyped. A package the",
  "// project installs is declared by a pattern, which the compiler",
  "// consults only when the package brings no types of its own.",
];

const GLOBALS = [
  'declare module "node:*";',
  "declare var process: any;",
  "declare var Buffer: any;",
  "declare var global: any;",
  "declare var require: any;",
  "declare var module: any;",
  "declare var exports: any;",
  "declare var __dirname: string;",
  "declare var __filename: string;",
  "declare var console: any;",
  "declare var performance: any;",
  "declare var crypto: any;",
  "declare function setTimeout(handler: (...args: any[]) => void, ms?: number, ...args: any[]): any;",
  "declare function clearTimeout(handle: any): void;",
  "declare function setInterval(handler: (...args: any[]) => void, ms?: number, ...args: any[]): any;",
  "declare function clearInterval(handle: any): void;",
  "declare function setImmediate(handler: (...args: any[]) => void, ...args: any[]): any;",
  "declare function clearImmediate(handle: any): void;",
  "declare function queueMicrotask(callback: () => void): void;",
  "declare function structuredClone<T>(value: T): T;",
  "declare function fetch(input: any, init?: any): Promise<any>;",
  "declare function atob(data: string): string;",
  "declare function btoa(data: string): string;",
];

const CLASS_NAMES = [
  "AbortController",
  "AbortSignal",
  "Blob",
  "BroadcastChannel",
  "DOMException",
  "Event",
  "EventTarget",
  "File",
  "FormData",
  "Headers",
  "MessageChannel",
  "MessagePort",
  "ReadableStream",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "WebSocket",
  "WritableStream",
];

const NAMESPACE_TYPES = [
  "Dict",
  "ErrnoException",
  "Immediate",
  "Process",
  "ProcessEnv",
  "ReadOnlyDict",
  "ReadableStream",
  "ReadWriteStream",
  "Signals",
  "Timeout",
  "Timer",
  "WritableStream",
];

const NODE_LIST = [
  ...GLOBALS,
  ...CLASS_NAMES.flatMap((name) => [
    `type ${name}<T0 = any, T1 = any> = any;`,
    `declare var ${name}: any;`,
  ]),
  "declare namespace NodeJS {",
  ...NAMESPACE_TYPES.map((name) => `  type ${name} = any;`),
  "}",
];

const GLOBAL_THIS = "declare var globalThis: any;";
const NODE = [...NODE_LIST, GLOBAL_THIS];

const expected = (packageLines: readonly string[], text = "") =>
  `${[...H, ...NODE, ...packageLines].join("\n")}\n${text}`;

const linesOf = (result: string) => result.split("\n");

const shorthand = (name: string) => [
  `declare module "${name}";`,
  `declare module "${name}/*";`,
];
const pattern = (name: string) => `declare module "${name}*";`;

// Extends "[happy-2] NODE_GLOBAL_DECLARATIONS is exactly the specified list":
// the list built from its three parts, and the same list in the ambient file
// both checks share.
test("[happy-2] the list is 23 globals, 22 classes as type then value, and a 12-type NodeJS namespace, and the ambient file writes it", () => {
  assert.equal(NODE_LIST.length, 81);
  assert.deepEqual([...NODE_GLOBAL_DECLARATIONS], NODE_LIST);
  assert.deepEqual(NODE_GLOBAL_DECLARATIONS.slice(0, 23), GLOBALS);
  CLASS_NAMES.forEach((name, index) => {
    assert.equal(
      NODE_GLOBAL_DECLARATIONS[23 + 2 * index],
      `type ${name}<T0 = any, T1 = any> = any;`,
    );
    assert.equal(NODE_GLOBAL_DECLARATIONS[24 + 2 * index], `declare var ${name}: any;`);
  });
  const lines = linesOf(ambientDeclarations(["zod"]));
  assert.deepEqual(lines.slice(H.length, H.length + 81), NODE_LIST);
});


// Extends "[happy-2] NODE_GLOBAL_DECLARATIONS holds the 81 declarations in
// order": every entry, not a sample, appears exactly once in an ambient
// file, and globalThis once, outside the list.
test("[happy-2] every declaration of the list appears exactly once in an ambient file, and globalThis once after it", () => {
  assert.equal(NODE_GLOBAL_DECLARATIONS.includes(GLOBAL_THIS), false);
  for (const entry of NODE_GLOBAL_DECLARATIONS)
    assert.equal(entry.includes("\n"), false, entry);
  const lines = linesOf(ambientDeclarations(["pg"], undefined, new Set(["pg"])));
  for (const entry of NODE_GLOBAL_DECLARATIONS)
    assert.equal(lines.filter((line) => line === entry).length, 1, entry);
  assert.equal(lines.filter((line) => line === GLOBAL_THIS).length, 1);
  assert.equal(lines.indexOf(GLOBAL_THIS), H.length + 81);
});

// Extends "[boundary-1] package lines come only after the globalThis line",
// with declared modules, installed and uninstalled packages and a text all at
// once: globalThis stays at the end of the list, not where it used to be.
test("[boundary-1] with packages, declared modules and installed names, globalThis still follows the list directly", () => {
  const result = ambientDeclarations(
    ["b", "a", "c"],
    { specifiers: ["a"], text: "// tail\n" },
    new Set(["b"]),
  );
  const lines = linesOf(result);
  assert.deepEqual(lines.slice(0, 4), H);
  assert.deepEqual(lines.slice(4, 85), [...NODE_GLOBAL_DECLARATIONS]);
  assert.equal(lines[85], GLOBAL_THIS);
  assert.equal(lines[4 + 3], "declare var global: any;");
  assert.notEqual(lines[4 + 4], GLOBAL_THIS);
  assert.deepEqual(lines.slice(86), [
    'declare module "a/*";',
    'declare module "b*";',
    'declare module "c";',
    'declare module "c/*";',
    "// tail",
    "",
  ]);
});

// Extends "[happy-3] package names sort by UTF-16 code unit": more names,
// duplicates, characters outside ASCII and outside the BMP, where code-point
// or locale order differs.
test("[happy-3] many names, repeated, sort by UTF-16 code unit, not by code point or locale", () => {
  const result = ambientDeclarations([
    "ｚ",
    "zod",
    "😀",
    "é",
    "Zod",
    "zod.x",
    "@z/a",
    "zod-mini",
    "zod",
    "é",
    "ｚ",
  ]);
  const order = ["@z/a", "Zod", "zod", "zod-mini", "zod.x", "é", "😀", "ｚ"];
  assert.equal(result, expected(order.flatMap(shorthand)));
});

// The shortcut: sort the output lines instead of the names. For "a" and "a!"
// the name order is a, a! but the line order would put 'declare module "a!";'
// first.
test("[happy-3] the names are sorted, not the lines they produce", () => {
  assert.equal(
    ambientDeclarations(["a!", "a"]),
    expected([
      'declare module "a";',
      'declare module "a/*";',
      'declare module "a!";',
      'declare module "a!/*";',
    ]),
  );
});

// Names are written exactly as given, with no escaping.
test("[happy-3] names with quotes, backslashes and spaces are written as given, without escaping", () => {
  assert.equal(
    ambientDeclarations(['we"ird', "back\\slash", "has space"]),
    expected([
      'declare module "back\\slash";',
      'declare module "back\\slash/*";',
      'declare module "has space";',
      'declare module "has space/*";',
      'declare module "we"ird";',
      'declare module "we"ird/*";',
    ]),
  );
});

// Extends "[boundary-2] no packages gives only the header and Node's
// declarations": no packages, but installed names and declared specifiers.
test("[boundary-2] no packages gives only the header and Node's declarations, whatever installed and specifiers hold", () => {
  assert.equal(
    ambientDeclarations([], { specifiers: ["zod", "pg"], text: "" }, new Set(["zod", "lodash"])),
    `${[...H, ...NODE].join("\n")}\n`,
  );
  const text = 'declare module "zod" {}\n';
  assert.equal(
    ambientDeclarations([], { specifiers: ["zod"], text }, new Set(["zod"])),
    `${[...H, ...NODE].join("\n")}\n${text}`,
  );
});

// Extends "[happy-4] a declared module replaces its shorthand but keeps its
// wildcard": several declared names, repeated packages, and specifiers that
// match only part of a name, another case or a subpath.
test("[happy-4] declared specifiers drop only their own shorthand, matched as whole names", () => {
  const text =
    'declare module "@acme/shared" {\n  export type Task = any;\n}\ndeclare module "pg" {\n  export const Pool: any;\n}';
  const result = ambientDeclarations(
    ["pg", "@acme/shared", "zod", "lodash", "pg", "react"],
    {
      specifiers: ["@acme/shared", "pg", "zod/v4", "Lodash", "rea"],
      text,
    },
  );
  assert.equal(
    result,
    expected(
      [
        'declare module "@acme/shared/*";',
        ...shorthand("lodash"),
        'declare module "pg/*";',
        ...shorthand("react"),
        ...shorthand("zod"),
      ],
      text,
    ),
  );
  assert.ok(result.endsWith(text));
});

// Extends "[boundary-3] an explicitly empty installed set is the same as
// leaving it out": with declared modules and several packages, and the
// result is the new text, not the old one.
test("[boundary-3] an explicitly empty installed set with declared modules is the same as leaving it out", () => {
  const modules = { specifiers: ["pg"], text: 'declare module "pg" {}\n' };
  const packages = ["zod", "pg", "@acme/ui"];
  const explicit = ambientDeclarations(packages, modules, new Set());
  assert.equal(explicit, ambientDeclarations(packages, modules));
  assert.equal(
    explicit,
    expected(
      [...shorthand("@acme/ui"), 'declare module "pg/*";', ...shorthand("zod")],
      modules.text,
    ),
  );
});

// Extends "[happy-5] an installed package gets one pattern line": several
// installed names interleaved with uninstalled ones, repeated, and installed
// names the packages do not have.
test("[happy-5] several installed packages each get one pattern line in their sorted place", () => {
  const result = ambientDeclarations(
    ["react", "zod", "@types/node", "lodash", "zod", "axios", "react"],
    undefined,
    new Set(["zod", "react", "@types/node", "express"]),
  );
  assert.equal(
    result,
    expected([
      pattern("@types/node"),
      ...shorthand("axios"),
      ...shorthand("lodash"),
      pattern("react"),
      pattern("zod"),
    ]),
  );
  const lines = linesOf(result);
  assert.equal(lines.filter((line) => line === pattern("zod")).length, 1);
  assert.equal(lines.includes('declare module "express*";'), false);
  for (const name of ["zod", "react", "@types/node"])
    for (const line of shorthand(name)) assert.equal(lines.includes(line), false, line);
});

// Extends "[happy-5] a scoped installed package gets its pattern line ... in
// sorted place". The shortcut: sort the produced lines. As lines,
// 'declare module "a!";' sorts before 'declare module "a*";' ("!" < "*"),
// but by name "a" comes first, and the spec sorts names.
test("[happy-5] an installed package's pattern line takes its name's place in the order", () => {
  assert.equal(
    ambientDeclarations(["c", "a!", "b", "a"], undefined, new Set(["a", "c"])),
    expected([pattern("a"), ...shorthand("a!"), ...shorthand("b"), pattern("c")]),
  );
  assert.equal(
    ambientDeclarations(["a!", "a"], undefined, new Set(["a!"])),
    expected([...shorthand("a"), pattern("a!")]),
  );
});

// Extends "[boundary-4] the header never changes; installed changes only the
// package lines": more rows, with several packages and installed names.
test("[boundary-4] across more installed sets the header and Node lines stay put and only package lines change", () => {
  const rows: readonly [string[], Set<string>, string[]][] = [
    [["pg", "zod"], new Set(["pg", "zod"]), [pattern("pg"), pattern("zod")]],
    [["pg", "zod"], new Set(["pg"]), [pattern("pg"), ...shorthand("zod")]],
    [["zod"], new Set(["ZOD"]), shorthand("zod")],
    [["zod"], new Set(["zod*"]), shorthand("zod")],
    [["zod", "zod"], new Set(["zod", "zod"]), [pattern("zod")]],
    [[], new Set(), []],
  ];
  for (const [packages, installed, lines] of rows) {
    const result = ambientDeclarations(packages, undefined, installed);
    assert.equal(result, expected(lines), JSON.stringify([packages, [...installed]]));
    assert.deepEqual(linesOf(result).slice(0, H.length), H);
  }
});

// Extends "[boundary-5] installed names match whole package names, case and
// all": prefixes, subpaths, longer names and folded scope names do not match.
test("[boundary-5] installed names match neither prefixes, subpaths nor package names folded from a subpath", () => {
  const result = ambientDeclarations(
    ["zod", "@acme/sdk/client", "zod-mini", "react-dom", "@Acme/ui", "zod/v4"],
    undefined,
    new Set(["zo", "zod-", "zod-mini", "react", "@acme/sdk", "@acme/ui", "zod"]),
  );
  assert.equal(
    result,
    expected([
      ...shorthand("@Acme/ui"),
      ...shorthand("@acme/sdk/client"),
      ...shorthand("react-dom"),
      pattern("zod"),
      pattern("zod-mini"),
      ...shorthand("zod/v4"),
    ]),
  );
});

// Extends "[boundary-6] a module text for an installed package replaces its
// pattern": declared and installed, declared only, installed only, together,
// with a text that also mentions installed names and has no final newline.
test("[boundary-6] declared installed packages get no line; the text is appended verbatim even where it declares them", () => {
  const text =
    'declare module "zod" {\n  export const z: any;\n}\ndeclare module "lodash" {\n  export const get: any;\n}\ndeclare module "pg*";';
  const result = ambientDeclarations(
    ["zod", "pg", "lodash", "react"],
    { specifiers: ["zod", "lodash"], text },
    new Set(["zod", "pg"]),
  );
  assert.equal(
    result,
    expected(
      ['declare module "lodash/*";', pattern("pg"), ...shorthand("react")],
      text,
    ),
  );
  assert.ok(result.endsWith(`\n${text}`));
  const before = linesOf(result.slice(0, result.length - text.length));
  assert.equal(before.includes(pattern("zod")), false);
  assert.equal(before.includes('declare module "zod";'), false);
  assert.equal(before.includes('declare module "zod/*";'), false);
});

// Extends "[boundary-7] the arguments are not mutated and repeated calls
// agree": frozen, unsorted, repeated inputs; equal but distinct arguments
// agree too, and the shared list is left as it was.
test("[boundary-7] frozen, unsorted, repeated arguments are left as they were and equal calls agree", () => {
  const packages = Object.freeze(["zod", "pg", "zod", "@a/b"]);
  const specifiers = Object.freeze(["pg"]);
  const modules = Object.freeze({ specifiers, text: 'declare module "pg" {}\n' });
  const installed = new Set(["zod", "x"]);
  const first = ambientDeclarations(packages, modules, installed);
  const second = ambientDeclarations(packages, modules, installed);
  const third = ambientDeclarations(
    ["zod", "pg", "zod", "@a/b"],
    { specifiers: ["pg"], text: 'declare module "pg" {}\n' },
    new Set(["x", "zod"]),
  );
  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(
    first,
    expected(
      [...shorthand("@a/b"), 'declare module "pg/*";', pattern("zod")],
      'declare module "pg" {}\n',
    ),
  );
  assert.deepEqual(packages, ["zod", "pg", "zod", "@a/b"]);
  assert.deepEqual(specifiers, ["pg"]);
  assert.deepEqual([...installed], ["zod", "x"]);
  assert.deepEqual([...NODE_GLOBAL_DECLARATIONS], NODE_LIST);
});
