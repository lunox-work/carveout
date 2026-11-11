/**
 * Pseudonyms for a public folder: the names a workspace goes by
 * (`vocabulary.ts`), a reversible table of renames that hides them
 * (`aliases.ts`), drafted by rule (`draft.ts`), and how a cut and a patch
 * use them (`folder.ts`). Carved out of sandbox-factory's
 * `packages/core/src/sandbox`, as the slicing core was (NOTICE.md).
 */

export * from "./aliases.js";
export * from "./draft.js";
export * from "./vocabulary.js";
export * from "./folder.js";
