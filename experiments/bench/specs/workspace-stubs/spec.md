# Check slices against published types, and build sandboxes the same way

Until now a slice was type-checked with every package declared untyped, and
a generated sandbox project repeated that by writing a `declare module`
shorthand for every package into `sandbox/ambient.d.ts` (`AMBIENT_PATH`),
even for the approved packages it really installs. With #130 the worker
checks a slice against the published types of the registry packages it can
install. It keeps the repository's own workspace packages, and anything
else it cannot install, stubbed as untyped. The contract records the
outcome in `CompilationResult`. In `packages/core`, this change:

- bumps the slice and sandbox-build tool versions;
- exports the Node module and global declarations both checks share, now
  covering more of Node's globals;
- lets `ambientDeclarations` declare installed packages by a pattern, so
  their own types win;
- makes `generateProject` pass every approved package it installs as
  installed, and makes a mocked module's runtime forward its stub's
  relative `export * from` lines;
- exports the registry-version test `resolveScope` uses, which now also
  accepts an `npm:` alias to a registry version;
- widens `CompilationResult` with two optional fields, which the boundary
  markdown renders.

Everything below is pure. Nothing reads a clock, a file, a network or any
shared state. No export mutates its arguments, and two calls with equal
arguments return equal results, so overlapping calls cannot interfere.

## Exports

`packages/core/src/analysis.ts`

```ts
export const SLICE_TOOL_VERSION = "slice@4";            // was "slice@3"
export const SANDBOX_BUILD_RUN_VERSION = "sandbox_build@9"; // was "sandbox_build@8"
```

`toolVersionOf` keeps its behaviour and so returns the new values for
`"slice"` and `"sandbox_build"`. Every other tool version constant stays as it
is: `GRAPHIFY_TOOL_VERSION`, `ABSTRACTIONS_TOOL_VERSION`,
`DATA_MODEL_TOOL_VERSION`, `DOCUMENTS_TOOL_VERSION`, `BRIEF_TOOL_VERSION`,
`SCOPE_TOOL_VERSION`, `FIXTURES_TOOL_VERSION` and `STARTER_TOOL_VERSION`.

`packages/core/src/sandbox/project.ts`

```ts
export const NODE_GLOBAL_DECLARATIONS: readonly string[];

export function ambientDeclarations(
  packages: readonly string[],
  modules: PackageModules = { specifiers: [], text: "" },
  installed: ReadonlySet<string> = new Set(),
): string;
```

`PackageModules` stays as it is. `generateProject` changes in the text of
its `AMBIENT_PATH` file and in the runtime file of a mocked module whose
stub has relative `export * from` lines, as the rules below describe. Its
other files, blockers, rewrites and descriptor stay as they are. All other
exports of the module also stay as they are, including
`projectCompilerOptions`, `tsconfigFor` and `AMBIENT_PATH`.

`packages/core/src/sandbox/provenance.ts`

```ts
export function isRegistryVersion(version: string): boolean;
```

`resolveScope`'s "not a registry version" check is now
`!isRegistryVersion(item.version)`. It accepts everything the private
`REGISTRY_RANGE` test did, and also an `npm:` alias whose target version is
a registry version. The `unresolved` dependency's detail is now
`"Not a registry version: a URL or a path."`. The blocker's detail stays
`"<name> is pinned to <version>, which is not a registry version."`.
`packageNameOf` and the module's other exports stay as they are.

`packages/core/src/slice/manifest.ts`

```ts
export interface CompilationResult {
    readonly attempted: boolean;
    readonly ok: boolean;
    readonly diagnostics: readonly {
        readonly file: string | null;
        readonly line: number | null;
        readonly code: string;
        readonly message: string;
    }[];
    /** Package specifiers declared `any` so the fixture could type-check. */
    readonly shimmedPackages: readonly string[];
    /** Errors the source has too, checked the same way with its own code in place of the stubs: what declaring its packages untyped costs, not counted against the slice. Absent when nothing failed. */
    readonly untypedPackageErrors?: CompilationResult["diagnostics"];
    /** Packages whose published types the check read, at the versions read, rather than declaring them untyped. Absent when none were fetched. */
    readonly typedPackages?: readonly {
        readonly name: string;
        readonly version: string;
    }[];
}
```

The worker fills these fields. Core does not compute them. The only reader
in core is `renderBoundaryMarkdown`, which renders both in its Compilation
section. `generateProject` does not read them.
`renderPublicSurfaceMarkdown`, `boundarySummary` and `sliceReadiness` keep
their behaviour and ignore both new fields.

## Exact texts

`NODE_GLOBAL_DECLARATIONS` has 81 entries, in this order. Entries 0 to 22
are:

```
declare module "node:*";
declare var process: any;
declare var Buffer: any;
declare var global: any;
declare var require: any;
declare var module: any;
declare var exports: any;
declare var __dirname: string;
declare var __filename: string;
declare var console: any;
declare var performance: any;
declare var crypto: any;
declare function setTimeout(handler: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearTimeout(handle: any): void;
declare function setInterval(handler: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearInterval(handle: any): void;
declare function setImmediate(handler: (...args: any[]) => void, ...args: any[]): any;
declare function clearImmediate(handle: any): void;
declare function queueMicrotask(callback: () => void): void;
declare function structuredClone<T>(value: T): T;
declare function fetch(input: any, init?: any): Promise<any>;
declare function atob(data: string): string;
declare function btoa(data: string): string;
```

Entries 23 to 66 are two lines for each of these 22 class names, in this
order: `AbortController`, `AbortSignal`, `Blob`, `BroadcastChannel`,
`DOMException`, `Event`, `EventTarget`, `File`, `FormData`, `Headers`,
`MessageChannel`, `MessagePort`, `ReadableStream`, `Request`, `Response`,
`TextDecoder`, `TextEncoder`, `TransformStream`, `URL`, `URLSearchParams`,
`WebSocket`, `WritableStream`. For a name `N` the two lines are:

```
type N<T0 = any, T1 = any> = any;
declare var N: any;
```

Entries 67 to 80 are:

```
declare namespace NodeJS {
  type Dict = any;
  type ErrnoException = any;
  type Immediate = any;
  type Process = any;
  type ProcessEnv = any;
  type ReadOnlyDict = any;
  type ReadableStream = any;
  type ReadWriteStream = any;
  type Signals = any;
  type Timeout = any;
  type Timer = any;
  type WritableStream = any;
}
```

`declare var globalThis: any;` is not in the list. `ambientDeclarations`
writes it right after the list.

The array is not frozen at runtime, like the repository's other exported
constant arrays, and callers must not change it.

`HEADER` is written whatever `installed` holds. It replaces the previous
header:

```
// The same declarations the slice was type-checked against: Node's
// modules and globals untyped, and every package untyped. A package the
// project installs is declared by a pattern, which the compiler
// consults only when the package brings no types of its own.
```

The header is internal and not exported. It is named here only so the
scenarios can refer to it.

`ambientDeclarations(packages, modules, installed)` returns the following
lines joined with `"\n"`, then one `"\n"`, then `modules.text` exactly as
given:

1. the 4 lines of `HEADER`;
2. every entry of `NODE_GLOBAL_DECLARATIONS`, in order;
3. `declare var globalThis: any;`;
4. for each distinct name in `packages`, sorted by UTF-16 code unit (the
   module's `compare`):
   - if `installed` has the name: `declare module "<name>*";`, but only when
     `modules.specifiers` does not contain `<name>`. No shorthand and no
     `/*` wildcard;
   - otherwise `declare module "<name>";`, but only when
     `modules.specifiers` does not contain `<name>`, then
     `declare module "<name>/*";`.

Names are written exactly as given, with no escaping, as today.
`modules.text` is never parsed or filtered. A module the text declares for
an installed package stays in the text.

A mocked module's runtime file (the `.js` beside the stub of a module in
`contract.outbound`) ends with one `export * from "<specifier>";` line for
each line of the stub text that is exactly `export * from "<specifier>"` or
`export * from '<specifier>'`, with or without a trailing `;`, where
`<specifier>` starts with `./` or `../`. The lines keep the stub's order and
come after the module's other exports. The specifier is written with double
quotes. When such a line is written, the runtime has no `export {};`.

```gherkin
Feature: Slices checked against published types, and projects built the same way

  Background:
    Given "H" stands for the 4 lines of HEADER
    And "NODE" stands for the 81 entries of NODE_GLOBAL_DECLARATIONS followed by the line "declare var globalThis: any;"

  Rule: The slice and sandbox-build tool versions are bumped; the rest stay

    @happy
    Scenario: The bumped versions are what toolVersionOf reports
      When toolVersionOf is called with each tool
      Then it returns:
        | tool            | version                    |
        | slice           | slice@4                    |
        | sandbox_build   | sandbox_build@9            |
        | graphify        | graphifyy@0.4.18+driver-1  |
        | abstractions    | abstractions@3             |
        | data_model      | data_model@1               |
        | documents       | documents@1                |
        | brief           | brief@1                    |
        | scope           | scope@5                    |
        | fixtures        | fixtures@3                 |
        | sandbox_starter | sandbox_starter@4          |
      And SLICE_TOOL_VERSION is "slice@4"
      And SANDBOX_BUILD_RUN_VERSION is "sandbox_build@9"

  Rule: NODE_GLOBAL_DECLARATIONS is the fixed list of Node's modules and globals

    @happy
    Scenario: The list holds the 81 declarations in order
      When NODE_GLOBAL_DECLARATIONS is read
      Then it has 81 entries
      And entry 0 is 'declare module "node:*";'
      And entry 1 is "declare var process: any;"
      And entry 9 is "declare var console: any;"
      And entry 22 is "declare function btoa(data: string): string;"
      And entry 23 is "type AbortController<T0 = any, T1 = any> = any;"
      And entry 24 is "declare var AbortController: any;"
      And entry 66 is "declare var WritableStream: any;"
      And entry 67 is "declare namespace NodeJS {"
      And entry 68 is "  type Dict = any;"
      And entry 80 is "}"
      And no entry is "declare var globalThis: any;"
      And no entry contains a newline

    @boundary
    Scenario: The ambient file writes the list right after the header, then globalThis
      When ambientDeclarations is called with packages []
      Then the lines after the header are the 81 entries of NODE_GLOBAL_DECLARATIONS and then "declare var globalThis: any;", with nothing between them

  Rule: With nothing installed, every package is declared untyped by shorthand and wildcard

    @happy
    Scenario: Every package is declared untyped by shorthand and wildcard
      When ambientDeclarations is called with packages ["zod", "@acme/shared", "zod"]
      Then the result is H, NODE and these lines, joined by "\n" and followed by "\n":
        | line                                 |
        | declare module "@acme/shared";       |
        | declare module "@acme/shared/*";     |
        | declare module "zod";                |
        | declare module "zod/*";              |

    @boundary
    Scenario: No packages gives only the header and Node's declarations
      When ambientDeclarations is called with packages []
      Then the result is H and NODE, joined by "\n", followed by "\n"

    @happy
    Scenario: A declared module replaces its shorthand but keeps its wildcard
      Given modules with specifiers ["@acme/shared"] and text 'declare module "@acme/shared" {\n  export type Task = any;\n}\n'
      When ambientDeclarations is called with packages ["@acme/shared", "zod"] and those modules
      Then the result has no line 'declare module "@acme/shared";'
      And it has the lines 'declare module "@acme/shared/*";', 'declare module "zod";' and 'declare module "zod/*";'
      And it ends with the modules' text exactly

    @boundary
    Scenario: An explicitly empty installed set is the same as leaving it out
      When ambientDeclarations is called with packages ["zod"], the default modules and installed new Set()
      Then the result equals ambientDeclarations(["zod"])

  Rule: An installed package is declared only by a pattern, so its own types apply

    @happy
    Scenario: An installed package gets one pattern line in place of its shorthand and wildcard
      When ambientDeclarations is called with packages ["lodash", "zod", "pg"], the default modules and installed {"zod"}
      Then the result is H, NODE and these lines, joined by "\n" and followed by "\n":
        | line                          |
        | declare module "lodash";      |
        | declare module "lodash/*";    |
        | declare module "pg";          |
        | declare module "pg/*";        |
        | declare module "zod*";        |
      And it has no line 'declare module "zod";' and no line 'declare module "zod/*";'

    @boundary
    Scenario Outline: The header never changes; installed changes only the package lines
      When ambientDeclarations is called with packages <packages> and installed <installed>
      Then the header is H
      And the package lines are <lines>

      Examples:
        | packages  | installed | lines                                            |
        | ["zod"]   | {}        | declare module "zod"; / declare module "zod/*";  |
        | ["zod"]   | {"zod"}   | declare module "zod*";                           |
        | ["zod"]   | {"left"}  | declare module "zod"; / declare module "zod/*";  |
        | []        | {"zod"}   | none                                             |

    @boundary
    Scenario: Installed names match whole package names, case and all
      When ambientDeclarations is called with packages ["@acme/sdk", "Zod"] and installed {"@acme", "zod"}
      Then the result has the lines 'declare module "@acme/sdk";', 'declare module "@acme/sdk/*";', 'declare module "Zod";' and 'declare module "Zod/*";'
      And it has no line ending in '*";' other than those two wildcards and 'declare module "node:*";'

    @boundary
    Scenario: A module text for an installed package replaces its pattern and is appended as given
      Given modules with specifiers ["zod"] and text 'declare module "zod" {\n  export const z: any;\n}\n'
      When ambientDeclarations is called with packages ["zod"], those modules and installed {"zod"}
      Then the result has no line 'declare module "zod";', no line 'declare module "zod/*";' and no line 'declare module "zod*";'
      And the result is H and NODE joined by "\n", followed by "\n" and the modules' text exactly

    @boundary
    Scenario: The arguments are not mutated and repeated calls agree
      Given packages ["zod", "pg"] and installed {"zod"}
      When ambientDeclarations is called twice with them
      Then both results are equal
      And packages is still ["zod", "pg"] and installed still holds only "zod"

  Rule: generateProject treats every approved package it installs as installed

    # "installed" = the names of dependencies with kind "package", resolution
    # "approved-package" and a non-null version (the ones written to the project's
    # package.json dependencies). contract.compilation.typedPackages is not read.

    @happy
    Scenario: Approved packages get a pattern; mocked ones keep their shorthand
      Given dependencies:
        | name   | kind    | version | resolution       |
        | zod    | package | ^3.22.0 | approved-package |
        | lodash | package | 4.17.21 | approved-package |
        | pg     | package | ^8.11.0 | runtime-mock     |
      And contract.compilation.typedPackages is [{ name: "zod", version: "3.22.4" }]
      When generateProject is called
      Then the file at AMBIENT_PATH starts with H
      And it has the lines 'declare module "lodash*";' and 'declare module "zod*";'
      And it has no line 'declare module "zod";', 'declare module "zod/*";', 'declare module "lodash";' or 'declare module "lodash/*";'
      And it has the lines 'declare module "pg";' and 'declare module "pg/*";'
      And package.json's dependencies are still { "lodash": "4.17.21", "pg": "file:mocks/pg", "zod": "^3.22.0" }

    @boundary
    Scenario Outline: The ambient file does not depend on typedPackages
      Given the same dependencies and contract.compilation.typedPackages is <typed>
      When generateProject is called
      Then the file at AMBIENT_PATH equals the one generated when typedPackages is absent
      And its text equals ambientDeclarations(["lodash", "pg", "zod", ...the bare names of knownSpecifiers], input.packageModules, {"lodash", "zod"})

      Examples:
        | typed                                  |
        | absent                                 |
        | []                                     |
        | [{ name: "zod", version: "3.22.4" }]   |

    @boundary
    Scenario Outline: Only approved, pinned packages count as installed
      Given a dependency "<name>" of kind "package" with version <version> and resolution "<resolution>"
      When generateProject is called
      Then the file at AMBIENT_PATH <pattern> the line 'declare module "<name>*";'
      And it <wildcard> the line 'declare module "<name>/*";'

      Examples:
        | name       | version | resolution       | pattern       | wildcard      |
        | zod        | "1.0.0" | approved-package | has           | does not have |
        | stripe     | "*"     | runtime-mock     | does not have | has           |
        | @acme/sdk  | null    | approved-package | does not have | does not have |

    # In the third row, the approved package with a null version is neither
    # installed nor mocked, so it was never among the ambient packages, as before.

  Rule: A mocked module's runtime forwards its stub's relative star exports

    @happy
    Scenario: Relative export-star lines are forwarded; others are not
      Given the outbound module "lib/service.ts" with a stub at "lib/service.ts" whose text is:
        """
        export * from "./types.js";
        export * from '../x/y.js'
        export * from "zod";
        export * as ns from "./ns.js";
        export declare function createService(): Service;
        """
      When generateProject is called
      Then the file "lib/service.js" of class "mock" ends with the lines:
        | line                         |
        | export * from "./types.js";  |
        | export * from "../x/y.js";   |
      And it has no line 'export * from "zod";' and no line containing "./ns.js"

    @boundary
    Scenario: A stub the contract does not list as a module still gets an empty runtime
      Given a stub for "lib/types.ts" at "lib/types.ts" with text 'export * from "./more.js";\n', and "lib/types.ts" is not in contract.outbound
      When generateProject is called
      Then the file "lib/types.js" has the text "export {};\n"

  Rule: isRegistryVersion accepts what the public registry resolves, directly or through an npm alias

    # True when version is non-empty and every character is one of
    # 0-9 A-Z a-z . - + ^ ~ < > = | * and the space (U+0020). Also true for
    # "npm:<name>@<range>", where <name> is a lowercase npm package name
    # (optionally "@scope/name"), and <range> is non-empty, has no "@" and
    # passes the first test. Anything else is false, never an exception.

    @happy
    Scenario Outline: Semver versions, ranges, dist-tags and registry aliases are registry versions
      When isRegistryVersion is called with "<version>"
      Then it returns true

      Examples:
        | version              |
        | 3.22.4               |
        | ^1.2.0               |
        | ~1.2                 |
        | >=1.0.0 <2.0.0       |
        | 1.x \|\| 2.x         |
        | *                    |
        | latest               |
        | 1.0.0-beta.1+build.5 |
        | npm:zod@3.22.4       |
        | npm:@acme/x@^1.0.0   |
        | npm:zod@latest       |

    @unhappy
    Scenario Outline: Protocols, paths, other aliases and shorthands are not
      When isRegistryVersion is called with "<version>"
      Then it returns false

      Examples:
        | version                          |
        | workspace:*                      |
        | file:../shared                   |
        | link:../shared                   |
        | git+https://github.com/a/b.git   |
        | github:acme/widgets              |
        | acme/widgets                     |
        | https://example.com/pkg.tgz      |
        | 1.0.0_beta                       |
        | npm:zod                          |
        | npm:zod@                         |
        | npm:Zod@1.0.0                    |
        | npm:zod@file:../x                |
        | npm:zod@github:a/b               |
        | npm:zod@1@2                      |

    @boundary
    Scenario Outline: Empty and whitespace edge cases
      When isRegistryVersion is called with <version>
      Then it returns <result>

      Examples:
        | version      | result |
        | ""           | false  |
        | " "          | true   |
        | "npm:zod@ "  | true   |
        | "1.2.3\n"    | false  |
        | "\t1.2.3"    | false  |

    @happy
    Scenario: resolveScope installs a pin that aliases a registry version
      Given a required package "zod" pinned to "npm:zod@3.22.4", registry source "public", not a workspace package
      And the owner's choice for "zod" is "approved-package"
      When resolveScope is called
      Then its dependency "zod" is { name: "zod", kind: "package", version: "npm:zod@3.22.4", resolution: "approved-package", detail: "Installed at the version package.json pins." }
      And it has no blockers

    @unhappy
    Scenario: resolveScope still refuses to install a pin that is not a registry version
      Given a required package "zod" pinned to "file:../zod", registry source "public", not a workspace package
      And the owner's choice for "zod" is "approved-package"
      When resolveScope is called
      Then its dependency "zod" has resolution "unresolved" and detail "Not a registry version: a URL or a path."
      And its blockers include { code: "dependency_unresolved", detail: "zod is pinned to file:../zod, which is not a registry version." }

    @happy
    Scenario: resolveScope still approves a registry pin
      Given a required package "zod" pinned to "^3.22.0" with registry source "public"
      When resolveScope is called with no choices
      Then its dependency "zod" has resolution "approved-package"

  Rule: CompilationResult takes the new fields as optional, and the boundary markdown renders them

    @happy
    Scenario: A slice@3 compilation result is still a CompilationResult
      Given { attempted: true, ok: true, diagnostics: [], shimmedPackages: ["pg"] }
      Then it type-checks as a CompilationResult with untypedPackageErrors and typedPackages undefined

    @happy
    Scenario: A slice@4 result carries typed packages and untyped-package errors
      Given a CompilationResult with:
        | field                | value                                                                                   |
        | attempted            | true                                                                                    |
        | ok                   | true                                                                                    |
        | diagnostics          | []                                                                                      |
        | shimmedPackages      | ["@acme/shared"]                                                                        |
        | untypedPackageErrors | [{ file: "src/app.ts", line: 4, code: "TS2347", message: "Untyped function calls may not accept type arguments." }] |
        | typedPackages        | [{ name: "zod", version: "3.22.4" }]                                                    |
      Then it type-checks as a CompilationResult

    @happy
    Scenario: The boundary markdown names the typed packages and counts the uncounted errors
      Given a compilation { attempted: true, ok: true, diagnostics: [], shimmedPackages: ["pg"] } with typedPackages [{ name: "zod", version: "3.22.4" }, { name: "@types/x", version: "1.0.0" }] and untypedPackageErrors [{ file: "src/b.ts", line: 9, code: "TS2347", message: "Untyped." }]
      When renderBoundaryMarkdown is called
      Then the result ends with these lines, joined by "\n":
        | line                                                                                                                                         |
        | ## Compilation                                                                                                                               |
        |                                                                                                                                              |
        | The included files and stubs type-check together, with `pg` declared as untyped packages.                                                    |
        |                                                                                                                                              |
        | Checked against the published types of `zod@3.22.4`, `@types/x@1.0.0`.                                                                     |
        |                                                                                                                                              |
        | 1 more error the source has too, with its packages untyped, is not counted; the sandbox build checks them against the packages it installs. |
        |                                                                                                                                              |
      And the result does not contain "TS2347"

    @boundary
    Scenario: Untyped-package errors are counted, not listed, after a failed compilation's list
      Given a compilation { attempted: true, ok: false, diagnostics: [{ file: "src/a.ts", line: 3, code: "TS2322", message: "Bad." }], shimmedPackages: [] } with untypedPackageErrors [{ file: "src/b.ts", line: 9, code: "TS2347", message: "Untyped." }, { file: null, line: null, code: "TS1", message: "x" }]
      When renderBoundaryMarkdown is called
      Then the result ends with "## Compilation\n\n- `src/a.ts`:3 TS2322: Bad.\n\n2 more errors the source has too, with its packages untyped, are not counted; the sandbox build checks them against the packages it installs.\n"
      And the result does not contain "TS2347"

    @boundary
    Scenario: Absent or empty new fields render as before
      Given a contract whose compilation is { attempted: true, ok: true, diagnostics: [], shimmedPackages: ["pg"] }
      And the same contract with typedPackages [] and untypedPackageErrors [] added
      When renderBoundaryMarkdown is called with each and the same manifest
      Then both results are equal
      And neither contains "Checked against the published types" or "not counted"

    @boundary
    Scenario: Typed packages are named even when no compilation was attempted
      Given a compilation { attempted: false, ok: false, diagnostics: [], shimmedPackages: [] } with typedPackages [{ name: "zod", version: "3.22.4" }]
      When renderBoundaryMarkdown is called
      Then the result ends with "## Compilation\n\nNo compilation was attempted for this language.\n\nChecked against the published types of `zod@3.22.4`.\n"
```

## Decided:

- The Node list starts with `declare module "node:*";`, has 81 entries (the previous 15 globals other than `globalThis`, plus `performance`, `crypto`, `setImmediate`, `clearImmediate`, `fetch`, `atob`, `btoa`, 22 Node classes as type and value, and a `NodeJS` namespace of 12 types), and leaves out `declare var globalThis: any;`, which `ambientDeclarations` writes after it.
  - Ticket: "export const NODE_GLOBAL_DECLARATIONS: readonly string[] = …;"
  - Instead: leave out the `node:*` module line and keep today's 16 globals in today's order, or use the worker shim's shorter 9-line list.
- `NODE_GLOBAL_DECLARATIONS` is not frozen at runtime.
  - Ticket: silent.
  - Instead: `Object.freeze` it.
- An installed package gets one pattern line, `declare module "<name>*";`, in place of both its shorthand and its `/*` wildcard. A name in `modules.specifiers` gets no pattern line.
  - Ticket: "export function ambientDeclarations(packages: readonly string[], modules: PackageModules = { specifiers: [], text: "" }, installed: ReadonlySet<string> = new Set()): string;"
  - Instead: write nothing for an installed package, or drop only the shorthand and keep the wildcard for subpaths.
- `installed` is matched against whole names as given, case-sensitively, with no `packageNameOf` folding.
  - Ticket: silent.
  - Instead: normalise both sides with `packageNameOf`.
- `modules.text` is appended verbatim, even when it declares an installed package.
  - Ticket: silent.
  - Instead: parse the text and drop the blocks of installed specifiers.
- One new header is written whatever `installed` holds. With `installed` empty the package lines are as before, but the output is not byte-identical to before: the header and the Node declarations changed, and `globalThis` now comes after the list.
  - Ticket: silent.
  - Instead: keep today's header and globals when `installed` is empty, and switch to a second header otherwise.
- `generateProject` treats every approved package with a non-null version as installed. It does not read `contract.compilation.typedPackages`.
  - Ticket: silent.
  - Instead: treat as installed only the approved packages named in `typedPackages`.
- A mocked module's runtime forwards each relative `export * from "./x.js"` line of its stub as `export * from "./x.js";`. Bare specifiers and `export * as` are not forwarded. Stubs the contract does not list as modules keep `export {};`.
  - Ticket: silent.
  - Instead: give a barrel's runtime only the names its own declarations export.
- `isRegistryVersion` is the `REGISTRY_RANGE` test, extended to `npm:<lowercase name>@<range>` where `<range>` passes that test: `npm:zod@3.22.4` is true, `npm:Zod@1.0.0` and `npm:zod@file:../x` are false, `""` is false, `" "` is true, and there is no trimming.
  - Ticket: "export function isRegistryVersion(version: string): boolean;"
  - Instead: keep refusing every `npm:` alias, or trim the input and treat empty or blank as `*`.
- `resolveScope` installs an approved package pinned to a registry alias, and an unresolved pin's detail is "Not a registry version: a URL or a path."
  - Ticket: silent.
  - Instead: keep refusing aliases with the detail "Not a registry version: a URL, a path or an alias."
- `untypedPackageErrors` means errors the source has too, checked the same way with its own code in place of the stubs. They are not counted against the slice, and the field is absent when nothing failed.
  - Ticket: "readonly untypedPackageErrors?: CompilationResult["diagnostics"];"
  - Instead: the diagnostics of a second check run with every package untyped.
- `typedPackages[].version` is the version whose published types were read, not the repository's pin, and the field is absent when no types were fetched.
  - Ticket: "readonly typedPackages?: readonly { readonly name: string; readonly version: string; }[];"
  - Instead: the range the repository's `package.json` pins.
- The boundary markdown's Compilation section ends with "Checked against the published types of `name@version`, …." when `typedPackages` is non-empty, then "N more error(s) … not counted; …" when `untypedPackageErrors` is non-empty, each after a blank line and whether or not a compilation was attempted. It never lists the uncounted errors themselves. `boundarySummary`, `sliceReadiness` and `renderPublicSurfaceMarkdown` ignore both fields.
  - Ticket: silent.
  - Instead: leave the markdown unchanged and ignore both fields.
- Only `SLICE_TOOL_VERSION` and `SANDBOX_BUILD_RUN_VERSION` change. `STARTER_TOOL_VERSION` stays at `sandbox_starter@4`, even though the starter's ambient file, which passes no `installed`, now carries the new header and Node declarations.
  - Ticket: "export const SLICE_TOOL_VERSION = "slice@4"; export const SANDBOX_BUILD_RUN_VERSION = "sandbox_build@9";"
  - Instead: bump the starter version too.
- Every export stays pure, and overlapping calls share no state, so there are no `@concurrency` scenarios.
  - Ticket: silent.
  - Instead: specify caching or memoised shared declarations.
