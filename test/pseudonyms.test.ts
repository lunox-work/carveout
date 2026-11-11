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
      "// Talks to the Zorvex API.",
      "export const zorvexClient = { token: process.env.ZORVEX_TOKEN };",
      "export class ZorvexError extends Error {}",
      "export const zorvex = 1;",
      'export const label = "zorvex";',
    ].join("\n"),
  );
  assert.equal(result.files[1]?.text, "Zorvex");
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
    "export class Zorvex {}\n// zorvex and ZORVEX alike.\n",
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
    { from: "src/lunox/paths.ts", to: "src/zorvex/paths.ts" },
  ]);
  assert.equal(
    result.files[1]?.text,
    'import { root } from "./zorvex/paths.js";\n',
  );
});

test("a placeholder the inputs already use is passed over, and no vocabulary drafts nothing", () => {
  const vocabulary = workspaceVocabulary(["lunox", "sandbox-factory"]);
  const files: AliasedFile[] = [
    {
      path: "src/app.ts",
      text: "// Zorvex Corp's sandbox-factory, built on lunox.\n",
    },
  ];
  const rules = draftPseudonyms({ files, vocabulary, imports: [] });
  const result = applied(files, vocabulary, rules);
  assert.equal(
    result.files[0]?.text,
    "// Zorvex Corp's velmira-labs, built on quarnell.\n",
  );
  assert.deepEqual(draftPseudonyms({ files, vocabulary: [], imports: [] }), []);
});

test("the owner's other repositories, written after the owner's name, join the vocabulary; a file or a word does not", async () => {
  const { ownedNames } = await import("../src/pseudonyms/index.js");
  const texts = [
    { text: 'const REPOS = "lunox-work/sandbox-factory,lunox-work/sandbox-blueprint,lunox-work/landing";\n' },
    { text: "// See https://github.com/Lunox-Work/sandbox-factory.git and lunox-work/some-notes.md\n" },
    { text: 'import { Button } from "@lunox/ui";\n' },
  ];
  assert.deepEqual(
    ownedNames(texts, ["lunox-work", "lunox"]).map((entry) => entry.name),
    ["sandbox-blueprint", "sandbox-factory"],
  );
});

test("a renaming apply writes maps back byte for byte, or the rules alone do, or nothing is written", async () => {
  const { exactToFolder, fromFolder } = await import("../src/pseudonyms/index.js");
  const table = {
    rules: [{ before: "posthog", after: "zorvex", kind: "identifier" as const, paths: [] }],
    kept: [],
    vocabulary: ["posthog"],
    words: [{ term: "posthog", placeholder: "zorvex" }],
  };
  // Words that come back as written: used.
  const plain = exactToFolder(table, "src/track.ts", "// send to posthog\nexport const posthogKey = 1;\n");
  assert.ok(plain !== null);
  assert.doesNotMatch(plain.text, /posthog/i);
  assert.equal(fromFolder(table, plain.path, plain.text).text, "// send to posthog\nexport const posthogKey = 1;\n");
  // A mixed case restyle cannot keep (PostHog would come back Posthog): the rules alone, which a leak scan then names.
  const mixed = exactToFolder(table, "src/events.ts", "export const PostHogHost = 1;\n");
  assert.deepEqual(mixed, { path: "src/events.ts", text: "export const PostHogHost = 1;\n" });
  // A placeholder word the repository's own text holds maps back to the term: nothing to write.
  assert.equal(exactToFolder(table, "src/notes.ts", "// zorvex is a vendor\n"), null);
});
