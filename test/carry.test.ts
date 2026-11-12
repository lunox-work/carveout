/**
 * Ported from sandbox-factory's packages/core/test/carry.test.ts with
 * carry.ts (commit f31d780), on carveout's alias implementation; the last
 * test is carveout's: a version built with the old renaming carries back
 * under it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALIASES_V1,
  applyAliases,
  carryChange,
  forwardChange,
  keptLines,
  learnedRenames,
  linesOf,
  projectPathOf,
  resolveRelative,
  reverseSubmission,
  tokensOf,
  type AliasRule,
} from "../src/pseudonyms.js";

const rules: AliasRule[] = [
  { before: "AcmeOrders", after: "Orders", kind: "identifier", paths: [] },
  { before: "Acme", after: "Shop", kind: "text", paths: [] },
  { before: "src/acme", after: "src/shop", kind: "path", paths: [] },
];

/** The repository's file at the pinned commit, in its own names. */
const repository = new Map([
  [
    "src/acme/orders.ts",
    [
      'import { ledger } from "@/acme/ledger";',
      "",
      "// Acme's order book.",
      "export class AcmeOrders {",
      "  total(): number {",
      "    return ledger.sum();",
      "  }",
      "}",
      "",
    ].join("\n"),
  ],
]);

/**
 * The version's copy, as a build makes it: the name table, then the path
 * alias rewritten to the slice's mock.
 */
function publicCopy(): Map<string, string> {
  const aliased = applyAliases(
    [...repository].map(([path, text]) => ({ path, text })),
    rules,
  );
  assert.equal(aliased.ok, true);
  return new Map(
    aliased.files.map((file) => [
      file.path,
      file.text.replace('"@/acme/ledger"', '"../../sandbox/mocks/ledger.js"'),
    ]),
  );
}

function reverse(submitted: { path: string; text: string }[]) {
  const copy = publicCopy();
  return reverseSubmission({
    submitted,
    publicText: (path) => copy.get(path) ?? null,
    repositoryText: (path) => repository.get(path) ?? null,
    rules,
    renames: [{ from: "src/acme/orders.ts", to: "src/shop/orders.ts" }],
    harness: ["sandbox/mocks/ledger.ts"],
  });
}

const edit = (from: string, to: string) => {
  const text = publicCopy().get("src/shop/orders.ts") ?? "";
  assert.ok(text.includes(from));
  return [{ path: "src/shop/orders.ts", text: text.replace(from, to) }];
};

test("a submission carries back by line: kept lines byte for byte, added lines in the repository's names", () => {
  const submitted = edit(
    "    return ledger.sum();\n",
    "    // Shop rounds an Orders total.\n    return Math.round(ledger.sum());\n",
  );
  const back = reverse(submitted);
  assert.deepEqual(back.refused, []);
  assert.deepEqual(back.files, [
    {
      path: "src/acme/orders.ts",
      text: (repository.get("src/acme/orders.ts") ?? "").replace(
        "    return ledger.sum();\n",
        "    // Acme rounds an AcmeOrders total.\n    return Math.round(ledger.sum());\n",
      ),
    },
  ]);
  // The import the build rewrote is the repository's, as it was.
  assert.match(back.files[0]?.text ?? "", /from "@\/acme\/ledger"/);

  // And forward again: the CI judge's path gives the submission back.
  const copy = publicCopy();
  const again = forwardChange({
    changed: back.files.map((file) => ({ ...file })),
    publicText: (path) => copy.get(path) ?? null,
    repositoryText: (path) => repository.get(path) ?? null,
    rules,
    renames: [{ from: "src/acme/orders.ts", to: "src/shop/orders.ts" }],
  });
  assert.deepEqual(again, { files: submitted, refused: [] });
});

test("an unchanged submission carries nothing, and a new file lands at the repository's path", () => {
  assert.deepEqual(
    reverse([
      {
        path: "src/shop/orders.ts",
        text: publicCopy().get("src/shop/orders.ts") ?? "",
      },
    ]),
    { files: [], refused: [] },
  );
  assert.deepEqual(
    reverse([
      {
        path: "src/shop/refunds.ts",
        text: 'import { Orders } from "./orders.js";\nexport const refund = (o: Orders) => o.total();\n',
      },
    ]),
    {
      files: [
        {
          path: "src/acme/refunds.ts",
          text: 'import { AcmeOrders } from "./orders.js";\nexport const refund = (o: AcmeOrders) => o.total();\n',
        },
      ],
      refused: [],
    },
  );
});

test("added text holding the repository's own names, or importing the harness, is refused", () => {
  const leaked = reverse(
    edit("  total(): number {\n", "  // Acme\n  total(): number {\n"),
  );
  assert.deepEqual(leaked.files, []);
  assert.match(leaked.refused[0]?.reason ?? "", /does not map back/);

  const mock = reverse(
    edit(
      "export class Orders {\n",
      'import { fake } from "../../sandbox/mocks/ledger.js";\nexport class Orders {\n',
    ),
  );
  assert.deepEqual(mock.files, []);
  assert.equal(mock.refused[0]?.path, "src/shop/orders.ts");
  assert.match(mock.refused[0]?.reason ?? "", /harness/);
});

test("a file that does not line up, or a name the build renamed two ways, is refused", () => {
  const files = [
    {
      fromPath: "a.ts",
      toPath: "a.ts",
      fromOriginal: "x\n",
      toOriginal: "x\ny\n",
      edited: "z\n",
    },
  ];
  const identity = { to: (text: string) => text, back: (text: string) => text };
  assert.match(
    carryChange(files, identity).refused[0]?.reason ?? "",
    /does not line up/,
  );
  const twoWays = carryChange(
    [
      {
        fromPath: "a.ts",
        toPath: "a.ts",
        fromOriginal: "const a = 1;\nconst a = 2;\n",
        toOriginal: "const b = 1;\nconst c = 2;\n",
        edited: "const a = 1;\nconst a = 2;\nlog(a);\n",
      },
    ],
    identity,
  );
  assert.match(twoWays.refused[0]?.reason ?? "", /two ways/);
  // Without a harness check, an import is carried as any other line.
  assert.deepEqual(
    carryChange(
      [
        {
          fromPath: "a.ts",
          toPath: "b.ts",
          fromOriginal: null,
          toOriginal: null,
          edited: 'import "./x.js";\n',
        },
      ],
      identity,
    ).files,
    [{ path: "b.ts", text: 'import "./x.js";\n' }],
  );
});

test("the line helpers: lines keep their endings, tokens keep literals whole, kept lines are a longest match", () => {
  assert.deepEqual(linesOf(""), []);
  assert.deepEqual(linesOf("a\nb"), ["a\n", "b"]);
  assert.deepEqual(tokensOf('f("a b", x1)'), [
    "f",
    "(",
    '"a b"',
    ",",
    " ",
    "x1",
    ")",
  ]);
  // Escapes stay inside a literal; an unclosed quote, or `${`, is a character.
  assert.deepEqual(tokensOf("'a\\'b' x"), ["'a\\'b'", " ", "x"]);
  assert.deepEqual(tokensOf('"ab'), ['"', "ab"]);
  assert.deepEqual(tokensOf("`a${b}`"), ["`", "a$", "{", "b", "}", "`"]);
  assert.deepEqual(tokensOf("`ok`\n"), ["`ok`", "\n"]);
  assert.deepEqual(tokensOf("'a\n'"), ["'", "a", "\n", "'"]);
  // Linear: a long line of escaped quotes with no close is quick.
  const hostile = `"${'\\"'.repeat(50_000)}`;
  const started = Date.now();
  assert.equal(tokensOf(hostile).length > 1, true);
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(keptLines(["a", "b", "c"], ["a", "x", "c"]), [0, -1, 2]);
  assert.deepEqual(
    keptLines(["a", "b", "c", "d"], ["x", "c", "b", "y"]),
    [-1, 2, -1, -1],
  );
  // Too many changed lines to match: only the shared head and tail are kept.
  const many = Array.from({ length: 2100 }, (_, i) => `a${i}`);
  const other = Array.from({ length: 2100 }, (_, i) => `b${i}`);
  assert.deepEqual(
    keptLines(["h", ...many, "t"], ["h", ...other, "t"]).filter((i) => i >= 0),
    [0, 2101],
  );
  assert.deepEqual(
    learnedRenames(["f(a, b)", "same", "g(x)"], ["f(c, d)", "same", "g(x, y)"]),
    {
      renames: new Map([
        ["a", "c"],
        ["b", "d"],
      ]),
      ambiguous: new Set(),
    },
  );
  assert.equal(resolveRelative("src/a/b.ts", "../c/./d.js"), "src/c/d.js");
  assert.equal(resolveRelative("b.ts", "./x"), "x");
});

test("a version built with the old renaming carries back under it (ALIASES_V1), and not under carveout's", () => {
  // carveout renames a path rule after a `/` too; the old renaming did not,
  // so the version kept `../../packages/lunox-money` as the repository has it.
  const pathRules: AliasRule[] = [
    { before: "packages/lunox-money", after: "packages/shop-money", kind: "path", paths: [] },
  ];
  const original = 'import { cents } from "../../packages/lunox-money/src/index.js";\n';
  const input = {
    submitted: [
      {
        path: "apps/web/a.ts",
        text: `${original}import { round } from "../../packages/lunox-money/src/round.js";\n`,
      },
    ],
    publicText: () => original,
    repositoryText: () => original,
    rules: pathRules,
    renames: [],
    harness: [],
  };
  const current = reverseSubmission(input);
  assert.deepEqual(current.files, []);
  assert.match(current.refused[0]?.reason ?? "", /does not map back/);
  const old = reverseSubmission({ ...input, aliases: ALIASES_V1 });
  assert.deepEqual(old.refused, []);
  assert.deepEqual(old.files, [{ path: "apps/web/a.ts", text: input.submitted[0]?.text }]);
  // Where a repository file lands in the version, by the renaming it was built with.
  assert.equal(projectPathOf("packages/lunox-money/src/index.ts", [], pathRules), "packages/shop-money/src/index.ts");
  assert.equal(projectPathOf("packages/lunox-money/src/index.ts", [], pathRules, ALIASES_V1), "packages/shop-money/src/index.ts");
});
