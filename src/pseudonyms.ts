/**
 * `carveout/pseudonyms`: the pure half of the pseudonyms, for a caller that
 * cannot load the compiler or Node's modules (a web app): the alias table
 * and its application (`aliases.ts`), the names a workspace goes by and the
 * scan for them (`vocabulary.ts`), the rule-based draft of a table
 * (`draft.ts`), carrying a change between a version's public names and the
 * repository's (`carry.ts`), the platform's renaming and scan before 0.3.0
 * (`legacy.ts`), and the recording mock runtime's text.
 *
 * Nothing this entry loads imports `typescript` or a `node:` module;
 * `test/pseudonyms-entry.test.ts` holds it to that. How a cut and a patch
 * use the table (`pseudonyms/folder.ts`, which reads Git) is not here.
 */

export * from "./pseudonyms/aliases.js";
export * from "./pseudonyms/vocabulary.js";
export * from "./pseudonyms/draft.js";
export * from "./pseudonyms/carry.js";
export * from "./pseudonyms/legacy.js";
export { MOCK_RUNTIME, MOCK_RUNTIME_TYPES } from "./project/mock-runtime.js";
export { dirnameOf, relativeSpecifier, runtimePath } from "./project/paths.js";
