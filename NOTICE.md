# Provenance

The slicing core (`src/slice`, `src/extract`, `src/project`) is carved out of
[sandbox-factory](https://github.com/lunox-work/sandbox-factory) (MIT), from
`packages/core/src/slice`, `packages/core/src/sandbox` and
`apps/worker/src/tools/slice`. The import graph (`src/graph.ts`) replaces the
graphify driver there with the TypeScript compiler alone.
