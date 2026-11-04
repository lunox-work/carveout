import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AMBIENT_PATH,
  NODE_GLOBAL_DECLARATIONS,
  ambientDeclarations,
  generateProject,
} from "../../src/sandbox/project.js";
import type { ProjectInput, ProjectStub } from "../../src/sandbox/project.js";
import type { ResolvedDependency } from "../../src/sandbox/provenance.js";
import { OPERATION_POLICY } from "../../src/slice/manifest.js";
import type {
  BoundaryContract,
  BoundaryModule,
  CompilationResult,
  SliceManifest,
} from "../../src/slice/manifest.js";

const H = [
  "// The same declarations the slice was type-checked against: Node's",
  "// modules and globals untyped, and every package untyped. A package the",
  "// project installs is declared by a pattern, which the compiler",
  "// consults only when the package brings no types of its own.",
];

const NODE = [...NODE_GLOBAL_DECLARATIONS, "declare var globalThis: any;"];

const expectedAmbient = (packageLines: readonly string[], text = "") =>
  `${[...H, ...NODE, ...packageLines].join("\n")}\n${text}`;

const shorthand = (name: string) => [
  `declare module "${name}";`,
  `declare module "${name}/*";`,
];
const pattern = (name: string) => `declare module "${name}*";`;

const manifest: SliceManifest = {
  schemaVersion: 1,
  toolVersion: "slice@4",
  extractorVersion: "typescript@5.9.3",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_graph",
  graphSha256: "b".repeat(64),
  params: {
    deadlineMinutes: 30,
    graphRunId: "arn_graph",
    entryPoints: ["src/app.ts"],
    budget: { maxFiles: 40, maxDepth: 3 },
    includeInferred: false,
  },
  entryPoints: ["src/app.ts"],
  budget: { maxFiles: 40, maxDepth: 3 },
  included: [
    {
      path: "src/app.ts",
      blobId: "c".repeat(40),
      sha256: "d".repeat(64),
      mode: "100644",
      sizeBytes: 10,
      operations: ["edit"],
    },
  ],
  synthetic: [],
  requiredBuildInputs: { configs: ["package.json"], packages: [] },
  cuts: { outbound: [], inbound: [] },
  internalImports: [],
  externals: { packages: [], environment: [] },
  communities: [0],
  blockers: [],
  policy: OPERATION_POLICY,
  boundaryContractSha256: "f".repeat(64),
  meta: {
    includedFiles: 1,
    includedBytes: 10,
    outboundCuts: 0,
    inboundCuts: 0,
    stubCoverage: "full",
    externals: 0,
    blockers: 0,
    ready: true,
  },
};

const compilation: CompilationResult = {
  attempted: true,
  ok: true,
  diagnostics: [],
  shimmedPackages: ["pg"],
};

const contract: BoundaryContract = {
  schemaVersion: 1,
  toolVersion: "slice@4",
  extractorVersion: "typescript@5.9.3",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_graph",
  language: "typescript",
  outbound: [],
  inbound: [],
  stubCoverage: "full",
  compilation,
  blockers: [],
};

const approved = (name: string, version: string | null): ResolvedDependency => ({
  name,
  kind: "package",
  version,
  resolution: "approved-package",
  detail: "Installed at the version package.json pins.",
});
const mocked = (name: string, version: string | null): ResolvedDependency => ({
  name,
  kind: "package",
  version,
  resolution: "runtime-mock",
  detail: "Replaced by a generated recording mock package.",
});

const dependencies: readonly ResolvedDependency[] = [
  approved("zod", "^3.22.0"),
  approved("lodash", "4.17.21"),
  mocked("pg", "^8.11.0"),
];

function input(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return {
    version: {
      sandboxId: "sbx_1",
      versionId: "sbv_1",
      version: 1,
      title: "Fix the widget",
      specSummary: "Make it work.",
      complexity: "M",
      tags: ["typescript"],
    },
    manifest,
    contract,
    sources: [
      {
        originalPath: "src/app.ts",
        path: "src/app.ts",
        text: "export function run() { return 1; }\n",
      },
    ],
    stubs: [],
    spec: null,
    dependencies,
    acceptanceTests: [],
    knownSpecifiers: ["fs", "path"],
    ...overrides,
  };
}

type Project = ReturnType<typeof generateProject>;

const fileOf = (project: Project, path: string) =>
  project.files.find((file) => file.path === path);

const ambientOf = (project: Project) => fileOf(project, AMBIENT_PATH)?.text ?? "";

const ambientLines = (project: Project) => ambientOf(project).split("\n");

const withTyped = (
  typedPackages: CompilationResult["typedPackages"] | "absent",
): BoundaryContract => ({
  ...contract,
  compilation:
    typedPackages === "absent" ? compilation : { ...compilation, typedPackages },
});

const moduleOf = (
  module: string,
  symbols: BoundaryModule["symbols"],
): BoundaryModule => ({
  module,
  symbols,
  importedBy: ["src/app.ts"],
  stubPath: `stubs/${module.replace(/\.ts$/, ".d.ts")}`,
});

const stubOf = (module: string, text: string): ProjectStub => ({
  module,
  path: module,
  text,
});

/** The runtime's lines, without the empty string after a final newline. */
const runtimeLines = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const createService = {
  name: "createService",
  kind: "function",
  declaration: "export declare function createService(): Service;",
};

// Extends "[happy-6] approved packages get a pattern; mocked ones keep their
// shorthand": more approved packages (scoped, aliased, a dist-tag), more
// mocked ones (one without a version), typedPackages empty, and the whole
// file checked.
test("[happy-6] every approved, pinned package gets a pattern and every mocked one its shorthand, in one sorted file", () => {
  const project = generateProject(
    input({
      contract: withTyped([]),
      dependencies: [
        mocked("stripe", null),
        approved("zod", "^3.22.0"),
        approved("@acme/ui", "1.2.3"),
        mocked("pg", "^8.11.0"),
        approved("lodash", "npm:lodash@4.17.21"),
        approved("react", "latest"),
      ],
    }),
  );
  assert.equal(
    ambientOf(project),
    expectedAmbient([
      pattern("@acme/ui"),
      ...shorthand("fs"),
      pattern("lodash"),
      ...shorthand("path"),
      ...shorthand("pg"),
      pattern("react"),
      ...shorthand("stripe"),
      pattern("zod"),
    ]),
  );
  const pkg = JSON.parse(fileOf(project, "package.json")?.text ?? "{}") as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies, {
    "@acme/ui": "1.2.3",
    lodash: "npm:lodash@4.17.21",
    pg: "file:mocks/pg",
    react: "latest",
    stripe: "file:mocks/stripe",
    zod: "^3.22.0",
  });
});

// Extends "[happy-6] an approved package the check did not read types for is
// still declared by a pattern". The shortcut: apply the pattern only to the
// approved list and add the known specifiers' bare names afterwards. A known
// specifier under an installed package must not bring back its shorthand.
test("[happy-6] an installed package that is also a known specifier's package still gets only its pattern", () => {
  const project = generateProject(
    input({ knownSpecifiers: ["zod/v4", "lodash", "fs/promises"] }),
  );
  assert.equal(
    ambientOf(project),
    expectedAmbient([
      ...shorthand("fs"),
      pattern("lodash"),
      ...shorthand("pg"),
      pattern("zod"),
    ]),
  );
});

// Extends "[boundary-8] the ambient file does not depend on typedPackages":
// typedPackages naming a mocked package, a package not among the
// dependencies, and other versions; known specifiers with subpaths.
test("[boundary-8] no typedPackages value, a mocked package or a stranger included, changes the ambient file", () => {
  const packageModules = {
    specifiers: ["@acme/ui"],
    text: 'declare module "@acme/ui" {\n  export const Button: any;\n}\n',
  };
  const knownSpecifiers = ["fs/promises", "@acme/ui/button", "path"];
  const ambientWith = (typed: CompilationResult["typedPackages"] | "absent") =>
    ambientOf(
      generateProject(
        input({ contract: withTyped(typed), packageModules, knownSpecifiers }),
      ),
    );
  const want = ambientDeclarations(
    ["lodash", "pg", "zod", "fs", "@acme/ui", "path"],
    packageModules,
    new Set(["lodash", "zod"]),
  );
  assert.equal(
    want,
    expectedAmbient(
      [
        'declare module "@acme/ui/*";',
        ...shorthand("fs"),
        pattern("lodash"),
        ...shorthand("path"),
        ...shorthand("pg"),
        pattern("zod"),
      ],
      packageModules.text,
    ),
  );
  const typedValues: (CompilationResult["typedPackages"] | "absent")[] = [
    "absent",
    [],
    [{ name: "pg", version: "8.11.3" }],
    [{ name: "react", version: "18.2.0" }],
    [
      { name: "zod", version: "3.23.0" },
      { name: "lodash", version: "4.17.21" },
      { name: "pg", version: "8.11.3" },
      { name: "@types/pg", version: "8.10.0" },
    ],
  ];
  for (const typed of typedValues)
    assert.equal(ambientWith(typed), want, JSON.stringify(typed));
});

// The shortcut: treat as installed what typedPackages names. A mocked package
// named there must keep its shorthand and get no pattern.
test("[boundary-8] a mocked package named in typedPackages keeps its shorthand and gets no pattern", () => {
  const lines = ambientLines(
    generateProject(
      input({ contract: withTyped([{ name: "pg", version: "8.11.3" }]) }),
    ),
  );
  assert.deepEqual(lines.slice(0, H.length), H);
  assert.ok(lines.includes('declare module "pg";'));
  assert.ok(lines.includes('declare module "pg/*";'));
  assert.equal(lines.includes(pattern("pg")), false);
});

// A module text for an installed package, through generateProject: the
// installed package gets neither its pattern nor its shorthand, and the text
// is written as given.
test("[boundary-6] an approved package the package modules declare gets no line of its own in the generated ambient file", () => {
  const packageModules = {
    specifiers: ["zod"],
    text: 'declare module "zod" {\n  export const z: any;\n}\n',
  };
  const text = ambientOf(generateProject(input({ packageModules })));
  assert.equal(
    text,
    expectedAmbient(
      [...shorthand("fs"), pattern("lodash"), ...shorthand("path"), ...shorthand("pg")],
      packageModules.text,
    ),
  );
});

// Extends "[boundary-9] only approved, pinned packages count as installed":
// more rows (an alias pin, a dist-tag, a mock without a version, an
// unresolved pin), each checked for the pattern, the shorthand and the
// wildcard, under the new header.
test("[boundary-9] approved pinned packages get only a pattern; mocked ones only shorthand; others no line", () => {
  const rows: readonly [ResolvedDependency, "pattern" | "shorthand" | "none"][] = [
    [approved("zod", "npm:zod@3.22.4"), "pattern"],
    [approved("react", "latest"), "pattern"],
    [approved("@acme/ui", ">=1.0.0 <2.0.0"), "pattern"],
    [mocked("pg", null), "shorthand"],
    [mocked("@acme/shared", "workspace:*"), "shorthand"],
    [
      {
        name: "axios",
        kind: "package",
        version: "file:../axios",
        resolution: "unresolved",
        detail: "Not a registry version: a URL or a path.",
      },
      "none",
    ],
    [approved("@acme/sdk", null), "none"],
  ];
  for (const [dependency, want] of rows) {
    const name = dependency.name;
    const lines = ambientLines(
      generateProject(input({ dependencies: [dependency], knownSpecifiers: [] })),
    );
    assert.deepEqual(lines.slice(0, H.length), H, name);
    assert.equal(lines.includes(pattern(name)), want === "pattern", name);
    assert.equal(lines.includes(`declare module "${name}";`), want === "shorthand", name);
    assert.equal(lines.includes(`declare module "${name}/*";`), want === "shorthand", name);
  }
});

// The same rows in one project: the whole file is what ambientDeclarations
// gives with the approved, pinned names installed.
test("[boundary-9] with every kind of dependency together, only the approved, pinned ones are installed", () => {
  const project = generateProject(
    input({
      knownSpecifiers: ["fs"],
      dependencies: [
        approved("zod", "npm:zod@3.22.4"),
        mocked("pg", null),
        {
          name: "axios",
          kind: "package",
          version: "file:../axios",
          resolution: "unresolved",
          detail: "Not a registry version: a URL or a path.",
        },
        approved("@acme/sdk", null),
        approved("react", "latest"),
      ],
    }),
  );
  assert.equal(
    ambientOf(project),
    expectedAmbient([
      ...shorthand("fs"),
      ...shorthand("pg"),
      pattern("react"),
      pattern("zod"),
    ]),
  );
});

// Extends "[happy-7] a mocked module's runtime forwards its stub's relative
// export-star lines, others not": more lines in an unsorted order, both quote
// styles, with and without ";", a deeper parent path, and a last line with
// no newline.
test("[happy-7] every exact relative export-star line is forwarded in the stub's order, double-quoted with a semicolon", () => {
  const stub = [
    'export * from "./z.js";',
    "export declare function createService(): Service;",
    "export * from '../../deep/a.js';",
    'export * from "zod/v4";',
    'export * from "./b/c.js"',
    "export * from '@acme/x';",
    "export * from './a.js'",
  ].join("\n");
  const project = generateProject(
    input({
      contract: {
        ...contract,
        outbound: [moduleOf("lib/service.ts", [createService])],
      },
      stubs: [stubOf("lib/service.ts", stub)],
    }),
  );
  const runtime = fileOf(project, "lib/service.js");
  assert.equal(runtime?.class, "mock");
  const lines = runtimeLines(runtime?.text ?? "");
  assert.deepEqual(lines.slice(-4), [
    'export * from "./z.js";',
    'export * from "../../deep/a.js";',
    'export * from "./b/c.js";',
    'export * from "./a.js";',
  ]);
  assert.equal(lines.filter((line) => line.startsWith("export * from")).length, 4);
  assert.equal(lines.some((line) => line.includes("zod/v4")), false);
  assert.equal(lines.some((line) => line.includes("@acme/x")), false);
  assert.ok(lines.some((line) => line.includes("createService")));
  assert.equal(lines.includes("export {};"), false);
});

// The shortcut: match loosely (trim, search within a line, accept any
// specifier starting with "."). Only lines that are exactly the form are
// forwarded.
test("[happy-7] lines that are not exactly a relative export-star line are not forwarded", () => {
  const stub = [
    'export * from "./kept.js";',
    '  export * from "./indented.js";',
    'export * from "./trailing.js"; ',
    'export type * from "./types-only.js";',
    'export *  from "./double-space.js";',
    'export * from "/absolute.js";',
    'export * from ".hidden.js";',
    'export * from "./mixed.js\';',
    '// export * from "./commented.js";',
    'export { thing } from "./named.js";',
    'export * as ns from "../ns.js";',
    'export * from "./with-comment.js"; // why',
    "export interface Service {}",
  ].join("\n");
  const project = generateProject(
    input({
      contract: {
        ...contract,
        outbound: [moduleOf("lib/service.ts", [createService])],
      },
      stubs: [stubOf("lib/service.ts", `${stub}\n`)],
    }),
  );
  const lines = runtimeLines(fileOf(project, "lib/service.js")?.text ?? "");
  assert.equal(lines.at(-1), 'export * from "./kept.js";');
  for (const name of [
    "indented",
    "trailing",
    "types-only",
    "double-space",
    "absolute",
    "hidden",
    "mixed",
    "commented",
    "named",
    "ns.js",
    "with-comment",
  ])
    assert.equal(lines.some((line) => line.includes(name)), false, name);
});

// One forwarded line for each matching line of the stub: a line repeated in
// the stub is forwarded each time.
test("[happy-7] a relative export-star line repeated in the stub is forwarded once for each time it appears", () => {
  const stub = 'export * from "./a.js";\nexport * from "./b.js";\nexport * from \'./a.js\'\n';
  const project = generateProject(
    input({
      contract: { ...contract, outbound: [moduleOf("lib/service.ts", [])] },
      stubs: [stubOf("lib/service.ts", stub)],
    }),
  );
  const lines = runtimeLines(fileOf(project, "lib/service.js")?.text ?? "");
  assert.deepEqual(lines.slice(-3), [
    'export * from "./a.js";',
    'export * from "./b.js";',
    'export * from "./a.js";',
  ]);
  assert.equal(lines.includes("export {};"), false);
});

// Several mocked modules: each runtime forwards its own stub's lines only,
// after its own exports; a module with no such line keeps its runtime as it
// was, "export {};" included when it exports no value.
test("[happy-7] each of several mocked modules forwards only its own stub's lines, after its own exports", () => {
  const project = generateProject(
    input({
      contract: {
        ...contract,
        outbound: [
          moduleOf("lib/service.ts", [
            createService,
            { name: "VERSION", kind: "variable", declaration: "export declare const VERSION: string;" },
          ]),
          moduleOf("lib/model.ts", [
            { name: "Model", kind: "interface", declaration: "export interface Model {}" },
          ]),
          moduleOf("lib/plain.ts", [
            { name: "Plain", kind: "interface", declaration: "export interface Plain {}" },
          ]),
        ],
      },
      stubs: [
        stubOf(
          "lib/service.ts",
          'export * from "./service-types.js";\nexport declare function createService(): Service;\nexport declare const VERSION: string;\n',
        ),
        stubOf("lib/model.ts", "export * from '../shared/model.js'\nexport interface Model {}\n"),
        stubOf("lib/plain.ts", 'export * from "zod";\nexport interface Plain {}\n'),
      ],
    }),
  );
  const service = runtimeLines(fileOf(project, "lib/service.js")?.text ?? "");
  assert.equal(service.at(-1), 'export * from "./service-types.js";');
  assert.equal(service.filter((line) => line.startsWith("export * from")).length, 1);
  const forwarded = service.indexOf('export * from "./service-types.js";');
  for (const name of ["createService", "VERSION"]) {
    const index = service.findIndex((line) => line.includes(name));
    assert.ok(index !== -1 && index < forwarded, name);
  }
  assert.equal(service.includes("export {};"), false);

  const model = runtimeLines(fileOf(project, "lib/model.js")?.text ?? "");
  assert.equal(model.at(-1), 'export * from "../shared/model.js";');
  assert.equal(model.filter((line) => line.startsWith("export * from")).length, 1);
  assert.equal(model.includes("export {};"), false);

  const plain = runtimeLines(fileOf(project, "lib/plain.js")?.text ?? "");
  assert.equal(plain.some((line) => line.startsWith("export * from")), false);
  assert.equal(plain.at(-1), "export {};");
});

// Extends "[boundary-10] a stub the contract does not list as a module still
// gets an empty runtime": several relative lines and values in the unlisted
// stub, beside a listed module that does forward its own.
test("[boundary-10] unlisted stubs keep an empty runtime while a listed module beside them forwards its lines", () => {
  const project = generateProject(
    input({
      contract: {
        ...contract,
        outbound: [moduleOf("lib/service.ts", [createService])],
      },
      stubs: [
        stubOf(
          "lib/service.ts",
          'export * from "./types.js";\nexport declare function createService(): Service;\n',
        ),
        stubOf(
          "lib/types.ts",
          "export * from \"./more.js\";\nexport * from '../other.js'\nexport declare const value: number;\n",
        ),
        stubOf("lib/more.ts", 'export * from "./deeper.js"'),
      ],
    }),
  );
  assert.equal(fileOf(project, "lib/types.js")?.text, "export {};\n");
  assert.equal(fileOf(project, "lib/more.js")?.text, "export {};\n");
  const service = runtimeLines(fileOf(project, "lib/service.js")?.text ?? "");
  assert.equal(service.at(-1), 'export * from "./types.js";');
});
