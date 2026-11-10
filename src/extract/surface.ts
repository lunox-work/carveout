/**
 * The public surface's types, held where the slice can check them.
 *
 * The interface test asserts that each export outside code imports is
 * still there; it cannot see a changed signature, and a slice whose
 * importers live in other packages passes a change that breaks them. So
 * the cut writes, under `carveout/surface/`, the declarations the slice's
 * own modules had when it was cut (a mirror of their paths, each import
 * pointing at the mirror, the folder's stub or the package it named), and
 * `check.ts`, which holds every export outside code uses to that type:
 *
 * - a value must still be assignable to its old type, so every call and
 *   read outside code makes still compiles;
 * - an interface or type alias must be assignable both ways, since
 *   outside code both reads and builds it.
 *
 * `npm test` type-checks `check.ts` with the folder's own compiler (see
 * `carveout/test.js`) and reports each error as the export whose type
 * changed. Enums, and classes with private or protected members, are
 * nominal: an identical copy of one is not assignable to the original, so
 * they are not checked. A check that fails before any edit (a type that
 * holds such a class) fails at the slice's baseline and is not counted.
 */

import { posix } from "node:path";
import ts from "typescript";
import {
  declarationPath,
  relativeSpecifier,
  SURFACE_CHECK_PATH,
  SURFACE_CONFIG_PATH,
  SURFACE_DIR,
} from "../core.js";
import { isTestPath } from "../slice/reach.js";
import { rewriteModuleSpecifiers } from "./typescript.js";

export interface SurfaceInput {
  readonly program: ts.Program;
  /** Included modules outside code imports, with the names it takes. */
  readonly surface: ReadonlyMap<string, ReadonlySet<string> | "*">;
  readonly included: ReadonlySet<string>;
  /** Cut modules whose stub the folder holds at their declaration path. */
  readonly stubbed: ReadonlySet<string>;
  /** A specifier's module in the repository, or null for a package. */
  readonly resolve: (specifier: string, from: string) => string | null;
  readonly abs: (path: string) => string;
}

export interface SurfaceFile {
  readonly path: string;
  readonly text: string;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const mirrorOf = (module: string) => `${SURFACE_DIR}/${declarationPath(module)}`;
const isScript = (path: string) =>
  /\.[cm]?tsx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path);

/** An identifier for a check function, from a module and an export name. */
const identifier = (index: number, name: string) =>
  `surface_${index}_${name.replace(/[^A-Za-z0-9_$]/g, "_")}`;

function nonPublicMembers(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some(
    (declaration) =>
      ts.isClassLike(declaration) &&
      declaration.members.some(
        (member) =>
          (member.name !== undefined && ts.isPrivateIdentifier(member.name)) ||
          (ts.canHaveModifiers(member) &&
            (ts.getModifiers(member) ?? []).some(
              (modifier) =>
                modifier.kind === ts.SyntaxKind.PrivateKeyword ||
                modifier.kind === ts.SyntaxKind.ProtectedKeyword,
            )),
      ),
  );
}

/** How many type parameters a type's declaration takes. */
function typeParameterCount(symbol: ts.Symbol): number {
  for (const declaration of symbol.declarations ?? [])
    if (
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isClassDeclaration(declaration)
    )
      return declaration.typeParameters?.length ?? 0;
  return 0;
}

interface Check {
  readonly module: string;
  readonly name: string;
  readonly kind: "value" | "type";
  readonly parameters: number;
}

/**
 * The mirror and the check for a slice's public surface; empty when there
 * is nothing to check or a module's declarations cannot be emitted.
 */
export function surfaceFiles(input: SurfaceInput): SurfaceFile[] {
  const { program } = input;
  const checker = program.getTypeChecker();
  const checks: Check[] = [];
  for (const [module, names] of [...input.surface].sort(([a], [b]) =>
    compare(a, b),
  )) {
    if (!isScript(module) || isTestPath(module)) continue;
    const source = program.getSourceFile(input.abs(module));
    if (source === undefined) continue;
    const symbol = checker.getSymbolAtLocation(source);
    if (symbol === undefined) continue;
    for (const exported of checker.getExportsOfModule(symbol)) {
      const name = exported.getName();
      if (names !== "*" && !names.has(name)) continue;
      const target =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      const flags = target.flags;
      if (flags & ts.SymbolFlags.Enum) continue;
      const nominal = flags & ts.SymbolFlags.Class && nonPublicMembers(target);
      if (
        flags & ts.SymbolFlags.Value &&
        !(flags & ts.SymbolFlags.ValueModule) &&
        !nominal
      )
        checks.push({ module, name, kind: "value", parameters: 0 });
      if (flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))
        checks.push({
          module,
          name,
          kind: "type",
          parameters: typeParameterCount(target),
        });
    }
  }
  if (checks.length === 0) return [];

  // The declarations of every included module the checked ones reach.
  const mirror = new Map<string, string>();
  const queue = [...new Set(checks.map((check) => check.module))];
  while (queue.length > 0) {
    const module = queue.shift() as string;
    if (mirror.has(module)) continue;
    const source = program.getSourceFile(input.abs(module));
    if (source === undefined) return [];
    if (program.getDeclarationDiagnostics(source).length > 0) return [];
    let emitted: string | null = null;
    program.emit(
      source,
      (fileName, content) => {
        if (/\.d\.[cm]?ts$/.test(fileName)) emitted = content;
      },
      undefined,
      true,
    );
    if (emitted === null) return [];
    const at = mirrorOf(module);
    let unresolvable = false;
    const text = rewriteModuleSpecifiers(emitted, (specifier) => {
      const target = input.resolve(specifier, module);
      if (target === null) {
        // A package resolves from the folder's node_modules, as it does
        // from the module itself; a relative path that names nothing
        // cannot be relocated.
        if (specifier.startsWith(".")) {
          // A stylesheet or image the slice copied, at its own path.
          const asset = posix.normalize(
            posix.join(posix.dirname(module), specifier.split(/[?#]/)[0] ?? ""),
          );
          if (input.included.has(asset)) return relativeSpecifier(at, asset);
          unresolvable = true;
        } else if (specifier.startsWith("/")) unresolvable = true;
        return null;
      }
      if (input.included.has(target) && isScript(target)) {
        queue.push(target);
        return relativeSpecifier(at, mirrorOf(target));
      }
      if (input.stubbed.has(target))
        return relativeSpecifier(at, declarationPath(target));
      // A declaration file or an asset the slice copied, at its own path.
      if (input.included.has(target)) return relativeSpecifier(at, target);
      unresolvable = true;
      return null;
    });
    if (unresolvable) return [];
    mirror.set(module, text);
  }

  const modules = [...new Set(checks.map((check) => check.module))].sort(compare);
  const alias = new Map(modules.map((module, index) => [module, index]));
  const lines = [
    "// Generated by carveout. `npm test` type-checks this file with",
    "// carveout/surface/tsconfig.json: each line holds an export that code",
    "// outside the slice uses to the type it had when the slice was cut",
    "// (the declarations beside this file). An error on a line is that",
    "// export's type changed in a way the code outside may not accept.",
  ];
  for (const module of modules) {
    const index = alias.get(module) as number;
    const valued = checks.some(
      (check) => check.module === module && check.kind === "value",
    );
    lines.push(
      `import type * as before_${index} from ${JSON.stringify(relativeSpecifier(SURFACE_CHECK_PATH, mirrorOf(module)))};`,
      `import ${valued ? "" : "type "}* as after_${index} from ${JSON.stringify(relativeSpecifier(SURFACE_CHECK_PATH, module))};`,
    );
  }
  checks.forEach((check, position) => {
    const index = alias.get(check.module) as number;
    const id = identifier(position, check.name);
    const label = `// ${check.module} | ${check.name} | ${check.kind}`;
    const member = (side: string) => `${side}_${index}.${check.name}`;
    if (check.kind === "value")
      lines.push(
        `export function ${id}(): typeof ${member("before")} { return ${member("after")}; } ${label}`,
      );
    else {
      const args =
        check.parameters === 0
          ? ""
          : `<${Array.from({ length: check.parameters }, () => "any").join(", ")}>`;
      const before = `${member("before")}${args}`;
      const after = `${member("after")}${args}`;
      lines.push(
        `export function ${id}(before: ${before}, after: ${after}): [${after}, ${before}] { return [before, after]; } ${label}`,
      );
    }
  });
  return [
    ...[...mirror]
      .sort(([a], [b]) => compare(a, b))
      .map(([module, text]) => ({ path: mirrorOf(module), text })),
    { path: SURFACE_CHECK_PATH, text: `${lines.join("\n")}\n` },
    {
      path: SURFACE_CONFIG_PATH,
      text: `${JSON.stringify(
        {
          extends: "../../tsconfig.json",
          compilerOptions: {
            noEmit: true,
            noUnusedLocals: false,
            noUnusedParameters: false,
          },
          // The folder's own declarations too (the ambient globals and
          // the package shims), as its build reads them.
          include: ["check.ts", "**/*.d.ts", "../../**/*.d.ts"],
          exclude: ["../../node_modules", "../../carveout/packages"],
        },
        null,
        2,
      )}\n`,
    },
  ];
}
