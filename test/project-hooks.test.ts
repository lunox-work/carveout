/**
 * `generateProject`'s hooks for a platform that hands the folder out under
 * its own terms (`ProjectHooks`): source maps, mock defaults, a walkthrough
 * and the package's version and npm pin. Without them, the folder is byte
 * for byte what carveout wrote before they existed.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { generateProject, type ProjectInput } from "../src/project/project.js";

/** A slice of one file that imports one cut module, as `analyse` describes it. */
const input: ProjectInput = {
  origin: { repository: null, name: "fees-slice" },
  manifest: {
    entryPoints: ["src/fees.ts"],
    cuts: {
      outbound: [
        {
          from: "src/fees.ts",
          to: "src/ledger.ts",
          relation: "imports",
          specifier: "./ledger.js",
          location: "L1",
          targetSymbol: null,
        },
      ],
      inbound: [],
    },
    internalImports: [],
    params: { tests: false },
    externals: { packages: [], environment: [{ name: "FEE_RATE", files: ["src/fees.ts"] }] },
  } as unknown as ProjectInput["manifest"],
  contract: {
    outbound: [
      {
        module: "src/ledger.ts",
        importers: ["src/fees.ts"],
        symbols: [
          {
            name: "balance",
            kind: "function",
            declaration: "export declare function balance(): number;",
          },
        ],
      },
    ],
    inbound: [],
  } as unknown as ProjectInput["contract"],
  sources: [
    {
      originalPath: "src/fees.ts",
      path: "src/fees.ts",
      text: 'import { balance } from "./ledger.js";\nexport const fee = () => balance() * Number(process.env.FEE_RATE);\n',
    },
  ],
  stubs: [
    {
      module: "src/ledger.ts",
      path: "src/ledger.ts",
      text: "export declare function balance(): number;\n",
    },
  ],
  dependencies: [],
  knownSpecifiers: [],
};

const digest = (project: ReturnType<typeof generateProject>) =>
  createHash("sha256")
    .update(JSON.stringify(project.files.map((file) => [file.path, file.class, file.public, file.text])))
    .digest("hex");
const text = (project: ReturnType<typeof generateProject>, path: string) =>
  project.files.find((file) => file.path === path)?.text ?? "";

test("without hooks, the folder is what carveout wrote before them", () => {
  const plain = generateProject(input);
  assert.deepEqual(plain.blockers, []);
  // carveout 0.4.1's folder for this slice, before hooks existed.
  assert.equal(digest(plain), "0296e8f53f4e74b2999b05d3af0bc63df3761fb15383cb6fc5a319c1d952a33f");
  assert.equal(digest(generateProject({ ...input, hooks: {} })), digest(plain));
});

test("the hooks change what each names and nothing else", () => {
  const plain = generateProject(input);
  const hooked = generateProject({
    ...input,
    hooks: {
      sourceMaps: true,
      mockDefaults: [
        { module: "src/ledger.ts", path: "module:src/ledger.ts.balance", implementation: " () => 100 " },
        { module: "src/ledger.ts", path: "module:src/ledger.ts.audit", implementation: "() => null" },
        { module: "src/elsewhere.ts", path: "module:src/elsewhere.ts.x", implementation: "() => 1" },
      ],
      walkthrough: 'import { fee } from "../src/fees.js";\nconsole.log(fee());\n',
      packageVersion: "3.0.0",
      packageManager: "npm@10.9.2",
    },
  });
  assert.deepEqual(hooked.blockers, []);
  const changed = hooked.files
    .filter((file) => text(plain, file.path) !== file.text)
    .map((file) => file.path);
  assert.deepEqual(changed, [".gitignore", "carveout/run.ts", "package.json", "src/ledger.js", "tsconfig.json"]);
  assert.deepEqual(
    hooked.files.map((file) => file.path),
    plain.files.map((file) => file.path),
  );
  // Source maps, kept out of git.
  assert.equal(JSON.parse(text(hooked, "tsconfig.json")).compilerOptions.sourceMap, true);
  assert.equal(JSON.parse(text(plain, "tsconfig.json")).compilerOptions.sourceMap, false);
  assert.equal(text(hooked, ".gitignore"), `${text(plain, ".gitignore")}*.map\n`);
  // The module's defaults, sorted, after its mock; another module's not.
  assert.equal(
    text(hooked, "src/ledger.js"),
    [
      "// Generated runtime for the declarations in ledger.d.ts.",
      "// Every value is a recording mock; see carveout/mock.js and the README.",
      'import { createMock, fixture } from "../carveout/mock.js";',
      'const mock = createMock("module:src/ledger.ts");',
      'fixture("module:src/ledger.ts.audit", () => null);',
      'fixture("module:src/ledger.ts.balance", () => 100);',
      'export const balance = mock["balance"];',
      "",
    ].join("\n"),
  );
  assert.equal(text(hooked, "carveout/run.ts"), 'import { fee } from "../src/fees.js";\nconsole.log(fee());\n');
  // The version and npm pin, `packageManager` right after `engines`.
  const pkg = JSON.parse(text(hooked, "package.json")) as Record<string, unknown>;
  assert.equal(pkg["version"], "3.0.0");
  assert.deepEqual(Object.keys(pkg).slice(4, 7), ["engines", "packageManager", "scripts"]);
  assert.equal("packageManager" in JSON.parse(text(plain, "package.json")), false);
});
