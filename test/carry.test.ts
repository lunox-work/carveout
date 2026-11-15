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
  STRANDED_NAME_REASON,
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

/**
 * A repository, its version under `table` (no build transforms beyond the
 * table), and a submission's reverse: for the text-rule and scope cases.
 */
function carryBack(
  table: AliasRule[],
  files: Record<string, string>,
  submitted: Record<string, string>,
) {
  const aliased = applyAliases(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    table,
  );
  assert.equal(aliased.ok, true, JSON.stringify(aliased.problems));
  const version = new Map(aliased.files.map((file) => [file.path, file.text]));
  const byPublic = new Map(aliased.renames.map(({ from, to }) => [to, from]));
  return reverseSubmission({
    submitted: Object.entries(submitted).map(([path, text]) => ({ path, text })),
    publicText: (path) => version.get(path) ?? null,
    repositoryText: (path) => files[byPublic.get(path) ?? path] ?? null,
    rules: table,
    renames: aliased.renames,
    harness: [],
  });
}

const added = (text: string, after: string, line: string) => {
  assert.ok(text.includes(after));
  return text.replace(after, `${after}${line}`);
};

test("a host rule carries whole: a contributor's own `example` or `com` is not renamed into the host's words", () => {
  const table: AliasRule[] = [
    { before: "wiki.orvanta.internal", after: "wiki.example.com", kind: "text", paths: [] },
  ];
  const repo = "// Docs live at wiki.orvanta.internal for the team.\nexport const answer = 42;\n";
  const version = "// Docs live at wiki.example.com for the team.\nexport const answer = 42;\n";
  // What a word-by-word reading of the originals would learn, and does not.
  assert.equal(learnedRenames(linesOf(version), linesOf(repo)).renames.get("example"), "orvanta");
  assert.deepEqual(
    learnedRenames(linesOf(version), linesOf(repo), (line) => line.replace("wiki.example.com", "wiki.orvanta.internal")),
    { renames: new Map(), ambiguous: new Set() },
  );
  const back = carryBack(
    table,
    { "src/docs.ts": repo },
    {
      "src/docs.ts": added(
        version,
        "export const answer = 42;\n",
        "export const example = 'wiki';\n// com is a word too.\nexport const home = `https://wiki.example.com/home`;\n",
      ),
    },
  );
  // The line alone: it once came back as `export const orvanta = 'wiki';`.
  assert.deepEqual(
    carryBack(table, { "src/docs.ts": repo }, {
      "src/docs.ts": added(version, "export const answer = 42;\n", "export const example = 'wiki';\n"),
    }),
    {
      files: [{ path: "src/docs.ts", text: added(repo, "export const answer = 42;\n", "export const example = 'wiki';\n") }],
      refused: [],
    },
  );
  assert.deepEqual(back.refused, []);
  assert.deepEqual(back.files, [
    {
      path: "src/docs.ts",
      text: added(
        repo,
        "export const answer = 42;\n",
        "export const example = 'wiki';\n// com is a word too.\nexport const home = `https://wiki.orvanta.internal/home`;\n",
      ),
    },
  ]);
});

test("an email rule carries whole: `org` and `example` written by the contributor stay theirs", () => {
  const table: AliasRule[] = [
    { before: "ops@orvanta.io", after: "ops@example.org", kind: "text", paths: [] },
  ];
  const repo = "// Mail ops@orvanta.io when it breaks.\nexport const retries = 3;\n";
  const version = "// Mail ops@example.org when it breaks.\nexport const retries = 3;\n";
  const back = carryBack(
    table,
    { "src/ops.ts": repo },
    {
      "src/ops.ts": added(version, "export const retries = 3;\n", "export const org = { example: 1, io: 2 };\n// Or ops@example.org.\n"),
    },
  );
  assert.deepEqual(back.refused, []);
  assert.equal(
    back.files[0]?.text,
    added(repo, "export const retries = 3;\n", "export const org = { example: 1, io: 2 };\n// Or ops@orvanta.io.\n"),
  );
});

test("a multi-word brand carries whole, and names derived from a text rule inside longer identifiers still carry back", () => {
  const table: AliasRule[] = [
    { before: "OrvantaPaymentsClient", after: "NorthwindShopClient", kind: "identifier", paths: [] },
    { before: "Orvanta Payments", after: "Northwind Shop", kind: "text", paths: [] },
    { before: "Kestrel", after: "Heron", kind: "text", paths: [] },
  ];
  const repo = [
    "// Orvanta Payments settles every order.",
    "export class OrvantaPaymentsClient {}",
    "export class KestrelLedger {}",
    "",
  ].join("\n");
  const back = carryBack(
    table,
    { "src/pay.ts": repo },
    {
      "src/pay.ts": [
        "// Northwind Shop settles every order.",
        "export class NorthwindShopClient {}",
        "export class HeronLedger {}",
        "export const Shop = 'cart';",
        "export const Payments = Shop;",
        "// Northwind Shop refunds too.",
        "export const client = new NorthwindShopClient();",
        "export class HeronLedgerFactory extends HeronLedger {}",
        "",
      ].join("\n"),
    },
  );
  assert.deepEqual(back.refused, []);
  assert.equal(
    back.files[0]?.text,
    [
      "// Orvanta Payments settles every order.",
      "export class OrvantaPaymentsClient {}",
      "export class KestrelLedger {}",
      "export const Shop = 'cart';",
      "export const Payments = Shop;",
      "// Orvanta Payments refunds too.",
      "export const client = new OrvantaPaymentsClient();",
      "export class KestrelLedgerFactory extends KestrelLedger {}",
      "",
    ].join("\n"),
  );
});

test("a brand's single word, added alone, stays the contributor's", () => {
  const table: AliasRule[] = [
    { before: "Orvanta Payments", after: "Northwind Shop", kind: "text", paths: [] },
  ];
  const repo = "// Orvanta Payments settles every order.\n";
  // It once came back as `export const Payments = 'cart';`.
  assert.deepEqual(
    carryBack(table, { "src/pay.ts": repo }, {
      "src/pay.ts": "// Northwind Shop settles every order.\nexport const Shop = 'cart';\n",
    }),
    {
      files: [{ path: "src/pay.ts", text: `${repo}export const Shop = 'cart';\n` }],
      refused: [],
    },
  );
});

test("a scoped rule's public name, added outside its scope, is refused, not landed half renamed", () => {
  const table: AliasRule[] = [
    { before: "Client", after: "AcmeClient", kind: "identifier", paths: ["packages/a"] },
  ];
  const files = {
    "packages/a/client.ts": "export class Client {}\n",
    "packages/b/use.ts": "export const b = 1;\n",
    "packages/c/natural.ts": "export const AcmeClient = 'theirs';\n",
  };
  // Inside the scope, a new file carries back.
  const inside = carryBack(table, files, {
    "packages/a/extra.ts": 'import { AcmeClient } from "./client";\nexport const c = new AcmeClient();\n',
  });
  assert.deepEqual(inside, {
    files: [{ path: "packages/a/extra.ts", text: 'import { Client } from "./client";\nexport const c = new Client();\n' }],
    refused: [],
  });
  // Outside it, a new file, or a line added to a file, is refused.
  const fresh = carryBack(table, files, {
    "packages/b/extra.ts": 'import { AcmeClient } from "../a/client";\n',
  });
  assert.deepEqual(fresh.files, []);
  assert.equal(fresh.refused[0]?.path, "packages/b/extra.ts");
  assert.deepEqual(fresh.refused, [{ path: "packages/b/extra.ts", reason: STRANDED_NAME_REASON }]);
  const edited = carryBack(table, files, {
    "packages/b/use.ts": "export const b = 1;\nexport type Kind = AcmeClient;\n",
  });
  assert.deepEqual(edited.files, []);
  assert.deepEqual(edited.refused, [{ path: "packages/b/use.ts", reason: STRANDED_NAME_REASON }]);
  // A file whose repository copy holds the name as its own word keeps it.
  assert.deepEqual(
    carryBack(table, files, {
      "packages/c/natural.ts": "export const AcmeClient = 'theirs';\nexport const again = AcmeClient;\n",
    }),
    {
      files: [
        {
          path: "packages/c/natural.ts",
          text: "export const AcmeClient = 'theirs';\nexport const again = AcmeClient;\n",
        },
      ],
      refused: [],
    },
  );
});

test("a deletion carries back to the repository's path, and one it cannot place is refused", () => {
  const copy = publicCopy();
  const withHelper = new Map([...repository, ["src/acme/helper.ts", "export const acmeHelper = 1;\n"]]);
  const base = {
    publicText: (path: string) => (path === "src/shop/helper.ts" ? "export const shopHelper = 1;\n" : (copy.get(path) ?? null)),
    repositoryText: (path: string) => withHelper.get(path) ?? null,
    rules,
    renames: [{ from: "src/acme/orders.ts", to: "src/shop/orders.ts" }],
    harness: ["sandbox/mocks/ledger.ts"],
  };
  // Without deletions, the answer is as it always was: no `deleted` field.
  assert.deepEqual(reverseSubmission({ ...base, submitted: [] }), { files: [], refused: [] });
  // A file the build moved, and one the path rule renames, land at the repository's paths.
  assert.deepEqual(reverseSubmission({ ...base, submitted: [], deleted: ["src/shop/orders.ts", "src/shop/helper.ts", "src/shop/helper.ts"] }), {
    files: [],
    refused: [],
    deleted: ["src/acme/helper.ts", "src/acme/orders.ts"],
  });
  const refused = reverseSubmission({
    ...base,
    submitted: edit("    return ledger.sum();\n", "    return 0;\n"),
    deleted: ["src/shop/orders.ts", "sandbox/mocks/ledger.js", "src/shop/nowhere.ts"],
  });
  assert.deepEqual(refused.deleted, []);
  assert.deepEqual(
    refused.refused.map(({ path, reason }) => [path, reason]),
    [
      ["sandbox/mocks/ledger.js", "The submission deletes part of the sandbox's harness, which the repository does not have."],
      ["src/shop/nowhere.ts", "The submission deletes a file the version does not have."],
      ["src/shop/orders.ts", "The submission both changes and deletes this file."],
    ],
  );
  assert.equal(refused.files.length, 1, "the edit still carries");
  // A file of the version the repository does not have at the pinned commit.
  const gone = reverseSubmission({ ...base, repositoryText: () => null, submitted: [], deleted: ["src/shop/helper.ts"] });
  assert.deepEqual(gone.refused, [{ path: "src/shop/helper.ts", reason: "The submission deletes a file the repository does not have at the pinned commit." }]);
});
