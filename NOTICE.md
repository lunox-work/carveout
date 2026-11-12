# Provenance

The slicing core (`src/slice`, `src/extract`, `src/project`) and the
pseudonyms (`src/pseudonyms`: aliases, vocabulary, draft) are carved out of
[sandbox-factory](https://github.com/lunox-work/sandbox-factory) (MIT), from
`packages/core/src/slice`, `packages/core/src/sandbox` and
`apps/worker/src/tools/slice`. The import graph (`src/graph.ts`) replaces the
graphify driver there with the TypeScript compiler alone.

`src/pseudonyms/carry.ts` is the platform's `packages/core/src/sandbox/carry.ts`
(commit f31d780), moved here verbatim but for a pluggable renaming
(`aliases`). `src/pseudonyms/legacy/` holds that commit's `aliases.ts` and
`vocabulary.ts` frozen, exported with a `V1` suffix (`legacy.ts`).

## Where the forks differ from the platform

carveout's behaviour is kept in each case; `carveout/extract` and
`carveout/pseudonyms` export it.

- `isDataPath`: also `.toml`, `.csv`, `.xml`, `.sql`, `.graphql`, `.gql`,
  `.prisma`, and the images, fonts and media `isAssetPath` names.
- `boundedHost`: never reads the checkout's own `node_modules`.
- `sanitizeDeclaration` and `extractTypeScriptBoundary`: `widenLiterals`
  (default true); with it, a constant read as a type (`typeof KIND`) keeps
  its name-like string literals.
- `filterDeclaration`: `export { a, b } from "./m"` keeps only the names
  asked of it; a barrel lists the names passed through its `export *`.
- `extractTypeScriptBoundary`: `CutEdge` carries `typeOnly`, not
  `targetSymbol`, and an edge with no import asks for the whole module;
  a copied asset is no module to stub; a workspace package's import asks
  its source module; the result has `surface` (the surface check).
- `compileFixture`: drops `rootDir`, `rootDirs` and `outDir`; messages name
  files relative to the checkout (`withoutRoots`).
- `packageUses`: reads `const { a } = await import("pkg")`.
- `loadConfig`: an optional third argument shares workspaces and loaded
  configurations across calls.
- `package-registry.ts`: adds `lockIntegrities` and `publicByIntegrity`
  (a pnpm entry with no URL, matched against the public registry).
- `analyseSlice` (`src/cut.ts`): walks with carveout's own graph and
  `reach`; blocks on a path read unless `pathReads: "omit"`; `CutError`
  codes `no_files`, `too_large`, `unreadable` where the platform throws
  `AnalysisError("tool_failed" | "too_large")`; adds `surface`,
  `keepsImplicitAny`, `implicitAnyFiles`, `walk`; no graphify communities.
- Alias rules: a path may hold any character but a NUL, a backslash, a
  quote or a newline; a path rule matches after a `/` too; a rule's target
  may occur where an earlier rule put it.
- Vocabulary: a term's words do not join across `/`; `scanVocabulary`
  drops a found one-word name `tooCommonAlone` and adds handle stems and
  accent-free spellings.
- Draft: made-up placeholders first, a tail word per extra word of a term
  (`contoso-labs`), restyled to each spelling, and an earlier cut's
  placeholders kept (`preferred`).
