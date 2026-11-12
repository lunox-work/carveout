/**
 * `carveout/pseudonyms` (`src/pseudonyms.ts`) is pure: nothing it loads
 * imports `typescript` or a `node:` module, so a web app can bundle it.
 * Checked twice: by reading every compiled module it reaches, and by
 * loading it with a resolve hook that fails on either (where Node has
 * `module.registerHooks`). Also the old scan and renaming beside the new.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import * as nodeModule from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY = fileURLToPath(new URL("../src/pseudonyms.js", import.meta.url));
const BUILTINS = new Set(builtinModules);
const forbidden = (specifier: string) =>
  specifier === "typescript" || specifier.startsWith("typescript/") || specifier.startsWith("node:") || BUILTINS.has(specifier);

/** Every specifier a compiled module imports or exports from, static or dynamic. */
function specifiersOf(text: string): string[] {
  const found: string[] = [];
  // Statements start a line in the compiler's output; a string that
  // happens to hold the word `import` does not.
  for (const match of text.matchAll(/^(?:import|export)\s[^'";]*?\sfrom\s*(['"])([^'"]+)\1/gm)) found.push(match[2] ?? "");
  for (const match of text.matchAll(/^import\s*(['"])([^'"]+)\1/gm)) found.push(match[2] ?? "");
  for (const match of text.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) found.push(match[2] ?? "");
  for (const match of text.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) found.push(match[2] ?? "");
  return found;
}

test("every module carveout/pseudonyms reaches imports neither typescript nor a node: module", () => {
  const seen = new Set<string>();
  const bad: string[] = [];
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\bimport\s*\(\s*[^'"\s]/, `${file} imports a computed name`);
    for (const specifier of specifiersOf(text)) {
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
      else bad.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(bad.filter((line) => forbidden(line.slice(line.lastIndexOf(": ") + 2))), []);
  // Nothing but its own modules at all.
  assert.deepEqual(bad, []);
  for (const module of ["aliases", "vocabulary", "draft", "carry", "legacy"])
    assert.ok(seen.has(join(dirname(ENTRY), "pseudonyms", `${module}.js`)), module);
  assert.ok(![...seen].some((file) => /[\\/](project|extract)[\\/]project\.js$|folder\.js$/.test(file)), [...seen].join("\n"));
});

test("loaded under a resolve hook that refuses typescript and node: modules, it loads", async (t) => {
  const registerHooks = (nodeModule as unknown as { registerHooks?: (hooks: object) => { deregister(): void } }).registerHooks;
  if (registerHooks === undefined) {
    t.skip("this Node has no module.registerHooks");
    return;
  }
  const root = pathToFileURL(dirname(ENTRY)).href;
  const refused: string[] = [];
  const hooks = registerHooks({
    resolve(specifier: string, context: { parentURL?: string }, next: (s: string, c: object) => unknown) {
      if (context.parentURL?.startsWith(root) === true && forbidden(specifier)) {
        refused.push(`${context.parentURL} -> ${specifier}`);
        throw new Error(`carveout/pseudonyms imported ${specifier}`);
      }
      return next(specifier, context);
    },
  });
  try {
    // A fresh instance: the query keeps it apart from any earlier import.
    const loaded = (await import(`${pathToFileURL(ENTRY).href}?pure`)) as Record<string, unknown>;
    assert.equal(typeof loaded["applyAliases"], "function");
    assert.equal(typeof loaded["reverseSubmission"], "function");
    assert.equal(typeof loaded["draftPseudonyms"], "function");
    assert.equal(typeof loaded["relativeSpecifier"], "function");
    assert.match(String(loaded["MOCK_RUNTIME"]), /export function createMock/);
    assert.match(String(loaded["MOCK_RUNTIME_TYPES"]), /export function recordedCalls\(\): RecordedCall\[\];/);
  } finally {
    hooks.deregister();
  }
  assert.deepEqual(refused, []);
});

test("the old scan and the new: tooCommonAlone and `/` keep a name from the new one, and the union blocks on both", async () => {
  const p = await import("../src/pseudonyms.js");
  // `search` names the repository here; the code calls its own things so.
  assert.deepEqual(p.scanVocabulary([{ name: "search", kind: "name" }]), []);
  assert.deepEqual(p.workspaceVocabularyV1([{ name: "search", kind: "name" }]), ["search"]);
  // An owner's name is always scanned for.
  assert.deepEqual(p.scanVocabulary([], ["search"]), ["search"]);
  // A handle's stem is a spelling of its own in the new scan.
  assert.deepEqual(p.scanVocabulary([{ name: "lunoxhq", kind: "organization" }]), ["lunoxhq", "lunox"]);
  // A term's words joined across `/` are two folders to the new scan.
  assert.equal(p.termMatches("acme/orders", "acme-orders").length, 0);
  assert.equal(p.termMatchesV1("acme/orders", "acme-orders").length, 1);
  const files = [{ path: "src/search.ts", text: "export const acme = 1; // acme/orders\n" }];
  const current = p.vocabularyLeaks(files, [...p.scanVocabulary(["search", "acme-orders"]), "acme"]);
  const legacy = p.vocabularyLeaksV1(files, [...p.workspaceVocabularyV1(["search", "acme-orders"]), "acme"]);
  assert.deepEqual(current.map((leak) => leak.term), ["acme"]);
  assert.deepEqual(
    p.unionVocabularyLeaks(current, legacy).map((leak) => leak.term),
    ["acme", "search", "acme-orders"],
  );
  assert.equal(p.vocabularyBlockersV1(legacy).length, legacy.length);
});

test("the old renaming, frozen: a path rule does not match after a `/`, nor a path with a space", async () => {
  const p = await import("../src/pseudonyms.js");
  const rules = [{ before: "packages/lunox-money", after: "packages/shop-money", kind: "path" as const, paths: [] }];
  const file = { path: "apps/web/a.ts", text: 'import "../../packages/lunox-money/x.js";\n' };
  assert.equal(p.renameFileV1(file, rules).text, file.text);
  assert.equal(p.renameFile(file, rules).text, 'import "../../packages/shop-money/x.js";\n');
  assert.deepEqual(p.invertAliasRulesV1(rules), p.invertAliasRules(rules));
  const spaced = [{ before: "assets/Lunox Logo.png", after: "assets/Shop Logo.png", kind: "path" as const, paths: [] }];
  assert.equal(p.validateAliasRules(spaced).ok, true);
  assert.equal(p.validateAliasRulesV1(spaced).ok, false);
  const applied = p.applyAliasesV1([{ path: "src/a.ts", text: "packages/lunox-money\n" }], rules);
  assert.equal(applied.ok, true);
  assert.equal(applied.files[0]?.text, "packages/shop-money\n");
});
