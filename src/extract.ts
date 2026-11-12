/**
 * `carveout/extract`: the stub extractor and the fixture compile a cut
 * runs, for a platform that calls them itself (sandbox-factory's worker,
 * whose `slice/*`, `compiler-config.ts` and `package-registry.ts` these
 * were forked from; NOTICE.md lists where they differ now).
 *
 * - `extract/hash.ts`: `sha256`, `gitBlobId`, `gitFileMode`.
 * - `extract/typescript.ts`: the boundary extractor and its parts
 *   (`extractTypeScriptBoundary`, `boundedHost`, `extractionOptions`,
 *   `filterDeclaration`, `sanitizeDeclaration`, `NODE_BUILTINS`,
 *   `isNodeBuiltin`, `isScriptPath`, `isDataPath`, `declarationPathFor`).
 * - `extract/fixture.ts`: `compileFixture`, `packageUses`,
 *   `packageModules`, `packageShim`, `SHIM_PATH`, `UNTYPED_PACKAGE_OPTIONS`,
 *   `UNTYPED_PACKAGE_CODES`, `DIAGNOSTICS_MAX`.
 * - `extract/package-types.ts`: `npmPackageTypes` (npm, scripts off) and
 *   the `PackageTypesFetcher` contract `analyse` takes.
 * - `extract/compiler-config.ts`: `loadConfig`, `nearestCompilerOptions`,
 *   `workspacePackages`, `workspaceModuleResolver`, `exportTarget`,
 *   `pnpmWorkspacePatterns`.
 * - `extract/package-registry.ts`: `packageRegistries`,
 *   `isPublicRegistry`, `lockIntegrities`, `publicByIntegrity`.
 *
 * Only `npmPackageTypes` starts a process; `publicByIntegrity` reads the
 * public registry over HTTPS.
 */

export * from "./extract/hash.js";
export * from "./extract/typescript.js";
export * from "./extract/fixture.js";
export * from "./extract/package-types.js";
export * from "./extract/compiler-config.js";
export * from "./extract/package-registry.js";
