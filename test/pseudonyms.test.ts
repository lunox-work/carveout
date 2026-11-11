/**
 * Ported from sandbox-factory's packages/core/test with the modules it tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyAliases,
  draftPseudonyms,
  vocabularyLeaks,
  workspaceVocabulary,
} from "../src/pseudonyms/index.js";
import type { AliasRule, AliasedFile } from "../src/pseudonyms/index.js";

/** The draft applied as the build applies it: it must hold and leave no name. */
function applied(
  files: readonly AliasedFile[],
  vocabulary: readonly string[],
  rules: readonly AliasRule[],
) {
  const result = applyAliases(files, rules);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(vocabularyLeaks(result.files, vocabulary), []);
  assert.ok(
    result.applied.every((count) => count > 0),
    "every rule renames something",
  );
  return result;
}

test("an import of the workspace's own package becomes the relative path to its module", () => {
  const vocabulary = workspaceVocabulary(["sandbox-factory"]);
  const files: AliasedFile[] = [
    {
      path: "apps/worker/src/run.ts",
      text: 'import { db } from "@sandbox-factory/db";\nimport { core } from "sandbox-factory";\n',
    },
    {
      path: "apps/worker/src/tools/adapter.ts",
      text: "import { db } from '@sandbox-factory/db';\n",
    },
    { path: "packages/db/src/index.ts", text: "export const db = 1;\n" },
    { path: "packages/core/src/index.ts", text: "export const core = 1;\n" },
  ];
  const rules = draftPseudonyms({
    files,
    vocabulary,
    imports: [
      {
        from: "apps/worker/src/run.ts",
        specifier: "@sandbox-factory/db",
        to: "packages/db/src/index.ts",
      },
      {
        from: "apps/worker/src/run.ts",
        specifier: "sandbox-factory",
        to: "packages/core/src/index.ts",
      },
      {
        from: "apps/worker/src/tools/adapter.ts",
        specifier: "@sandbox-factory/db",
        to: "packages/db/src/index.ts",
      },
    ],
  });
  assert.deepEqual(rules, [
    {
      before: '"@sandbox-factory/db"',
      after: '"../../../packages/db/src/index.js"',
      kind: "text",
      paths: ["apps/worker/src/run.ts"],
    },
    {
      before: '"sandbox-factory"',
      after: '"../../../packages/core/src/index.js"',
      kind: "text",
      paths: ["apps/worker/src/run.ts"],
    },
    {
      before: "'@sandbox-factory/db'",
      after: "'../../../../packages/db/src/index.js'",
      kind: "text",
      paths: ["apps/worker/src/tools/adapter.ts"],
    },
  ]);
  applied(files, vocabulary, rules);
});

test("a term is renamed in the identifier it is in, its case kept, and as text where an identifier rule cannot", () => {
  const vocabulary = workspaceVocabulary(["Lunox"]);
  const files: AliasedFile[] = [
    {
      path: "src/client.ts",
      text: [
        "// Talks to the Lunox API.",
        "export const lunoxClient = { token: process.env.LUNOX_TOKEN };",
        "export class LunoxError extends Error {}",
        "export const lunox = 1;",
        'export const label = "lunox";',
      ].join("\n"),
    },
    // A leaf of the listing, whole.
    { path: "__listing__.json#/title", text: "Lunox" },
  ];
  const rules = draftPseudonyms({ files, vocabulary, imports: [] });
  const result = applied(files, vocabulary, rules);
  assert.equal(
    result.files[0]?.text,
    [
      "// Talks to the Acme API.",
      "export const acmeClient = { token: process.env.ACME_TOKEN };",
      "export class AcmeError extends Error {}",
      "export const acme = 1;",
      'export const label = "acme";',
    ].join("\n"),
  );
  assert.equal(result.files[1]?.text, "Acme");
  // The first spelling found is the identifier rule; one that differs from
  // it only by case is text, held in place by the characters around it.
  assert.deepEqual(
    rules.map((rule) => `${rule.kind} ${rule.before}`),
    [
      "identifier Lunox",
      "identifier lunoxClient",
      "identifier LUNOX_TOKEN",
      "identifier LunoxError",
      "text  lunox ",
      'text "lunox"',
    ],
  );
});

test("a term in two casings no identifier rule reaches gets a text rule for each", () => {
  const vocabulary = workspaceVocabulary(["Lunox"]);
  const files: AliasedFile[] = [
    {
      path: "src/notes.ts",
      text: "export class Lunox {}\n// lunox and LUNOX alike.\n",
    },
  ];
  const rules = draftPseudonyms({ files, vocabulary, imports: [] });
  // The identifier rule takes the first spelling; the two it differs from
  // only by case are each text, held by the characters around them.
  assert.deepEqual(
    rules.map((rule) => `${rule.kind} ${rule.before}`),
    ["identifier Lunox", "text  lunox ", "text  LUNOX "],
  );
  const result = applied(files, vocabulary, rules);
  assert.equal(
    result.files[0]?.text,
    "export class Acme {}\n// acme and ACME alike.\n",
  );
});

test("a path segment that carries a term is renamed, and imports follow it", () => {
  const vocabulary = workspaceVocabulary(["lunox"]);
  const files: AliasedFile[] = [
    { path: "src/lunox/paths.ts", text: "export const root = '/';\n" },
    {
      path: "src/app.ts",
      text: 'import { root } from "./lunox/paths.js";\n',
    },
  ];
  const rules = draftPseudonyms({ files, vocabulary, imports: [] });
  const result = applied(files, vocabulary, rules);
  assert.deepEqual(result.renames, [
    { from: "src/lunox/paths.ts", to: "src/acme/paths.ts" },
  ]);
  assert.equal(
    result.files[1]?.text,
    'import { root } from "./acme/paths.js";\n',
  );
});

test("a placeholder the inputs already use is passed over, and no vocabulary drafts nothing", () => {
  const vocabulary = workspaceVocabulary(["lunox", "sandbox-factory"]);
  const files: AliasedFile[] = [
    {
      path: "src/app.ts",
      text: "// Acme Corp's sandbox-factory, built on lunox.\n",
    },
  ];
  const rules = draftPseudonyms({ files, vocabulary, imports: [] });
  const result = applied(files, vocabulary, rules);
  assert.equal(
    result.files[0]?.text,
    "// Acme Corp's globex-labs, built on initech.\n",
  );
  assert.deepEqual(draftPseudonyms({ files, vocabulary: [], imports: [] }), []);
});
