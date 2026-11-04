import assert from "node:assert/strict";
import { test } from "node:test";
import { isRegistryVersion, resolveScope } from "../../src/sandbox/provenance.js";
import type { DependencyChoice } from "../../src/sandbox/provenance.js";
import { OPERATION_POLICY } from "../../src/slice/manifest.js";
import type { BoundaryContract, SliceManifest } from "../../src/slice/manifest.js";

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
  compilation: {
    attempted: true,
    ok: true,
    diagnostics: [],
    shimmedPackages: [],
  },
  blockers: [],
};

/** Required public-registry packages, none a workspace package, at these pins. */
const scopeOf = (
  pins: Readonly<Record<string, string>>,
  choices?: Readonly<Record<string, DependencyChoice>>,
) =>
  resolveScope({
    manifest: {
      ...manifest,
      requiredBuildInputs: {
        configs: ["package.json"],
        packages: Object.entries(pins).map(([name, version]) => ({
          name,
          version,
          declaredIn: "package.json",
          registry: { source: "public" as const, evidence: "package-lock.json" },
        })),
      },
    },
    contract,
    ...(choices === undefined ? {} : { choices }),
  });

const dependencyOf = (scope: ReturnType<typeof resolveScope>, name: string) =>
  scope.dependencies.find((dependency) => dependency.name === name);

const INSTALLED = "Installed at the version package.json pins.";
const UNRESOLVED = "Not a registry version: a URL or a path.";

// Extends "[happy-8] semver versions, ranges, dist-tags and registry aliases
// are registry versions": more aliases (scoped, dotted and digit names,
// ranges with spaces and bars, aliasing another package) and plain values.
test("[happy-8] more aliases and plain ranges are registry versions", () => {
  for (const version of [
    "v1.2.3",
    "1.2.3 - 2.3.4",
    "^1 || ^2 || >=3 <4",
    "x",
    "next",
    "1.0.0-rc.1",
    "~>1",
    "npm:zod@^3.22.0",
    "npm:zod@*",
    "npm:zod@>=1.0.0 <2.0.0",
    "npm:zod@1.x || 2.x",
    "npm:lodash@4.17.21",
    "npm:lodash.merge@4.6.2",
    "npm:zod4@1.0.0",
    "npm:zod-fork@1.0.0",
    "npm:@acme/zod-fork@latest",
    "npm:@types/node@20.11.5",
    "npm:@a1/b2@1.0.0-beta.1+build.5",
  ])
    assert.equal(isRegistryVersion(version), true, version);
});

// Extends "[happy-8]": the alias's target name is any lowercase package
// name, not just the one it is installed as. A shortcut that accepts only
// "npm:zod@" fails here.
test("[happy-8] an alias is accepted whatever lowercase package it names, and returns the same on every call", () => {
  for (const name of ["react", "string-width", "@babel/core", "@scope/pkg-name"]) {
    const version = `npm:${name}@^1.0.0`;
    assert.equal(isRegistryVersion(version), true, version);
    assert.equal(isRegistryVersion(version), true, `${version} again`);
  }
});

// Extends "[unhappy-1] protocols, paths, other aliases and shorthands are not
// registry versions": more protocols, malformed aliases, nested aliases and
// near misses on the prefix.
test("[unhappy-1] more protocols, malformed and nested aliases, and near-miss prefixes are not registry versions", () => {
  for (const version of [
    "npm:",
    "npm:@1.0.0",
    "npm:@acme@1.0.0",
    "npm:@acme/@1.0.0",
    "npm:@acme/X@1.0.0",
    "npm:ZOD@latest",
    "npm:zod@npm:other@1.0.0",
    "npm:zod@link:../x",
    "npm:zod@https://example.com/z.tgz",
    "npm:zod@acme/zod",
    "npm:zod@1.0.0_beta",
    "npm:zod@1.0.0\n",
    "NPM:zod@1.0.0",
    "Npm:zod@1.0.0",
    " npm:zod@1.0.0",
    "npm :zod@1.0.0",
    "npm:npm:zod@1.0.0",
    "npm:zod@@1.0.0",
    "npm:zod 1.0.0",
    "zod@1.0.0",
    "@1.0.0",
    "portal:../x",
    "git://github.com/a/b.git",
    "git+ssh://git@github.com:a/b.git",
    "gitlab:acme/widgets",
    "bitbucket:acme/widgets",
    "acme/widgets#v1.0.0",
    "./local",
    "../local",
    "/abs/path",
    "~/local",
    "C:\\pkg",
    "1.0.0,2.0.0",
    "1.0.0!",
    "(1.0.0)",
    "1.0.0#sha",
    "1.0.0?x",
  ])
    assert.equal(isRegistryVersion(version), false, version);
});

// "Anything else is false, never an exception": odd inputs return false
// rather than throw.
test("[unhappy-1] odd strings return false and never throw", () => {
  for (const version of [
    "npm:\u0000@1",
    "\u0000",
    "1.0.0\u0000",
    "\uD83D",
    "😀",
    "npm:😀@1.0.0",
    "npm:zod@😀",
    "npm:" + "a".repeat(10000) + "@" + "@".repeat(10000),
    "@".repeat(10000),
  ]) {
    let result: boolean | undefined;
    assert.doesNotThrow(() => {
      result = isRegistryVersion(version);
    }, JSON.stringify(version.slice(0, 20)));
    assert.equal(result, false, JSON.stringify(version.slice(0, 20)));
  }
});

// Extends "[boundary-11] empty and whitespace edge cases": other whitespace
// characters, untrimmed in either test, and spaces as the alias's range.
test("[boundary-11] spaces count as range characters; other whitespace and the empty range never do, with no trimming", () => {
  const rows: readonly [string, boolean][] = [
    ["   ", true],
    [" 1.2.3 ", true],
    ["npm:zod@   ", true],
    ["npm:zod@ 1.0.0 ", true],
    ["npm:@acme/x@ ", true],
    ["\n", false],
    ["\t", false],
    ["\r", false],
    ["1.2.3\r", false],
    ["1.2.3\r\n", false],
    ["\u00a01.2.3", false],
    ["1.2.3\u2003", false],
    ["\ufeff1.2.3", false],
    ["npm:zod@\t1.0.0", false],
    ["npm:zod@1.0.0\t", false],
    ["npm:zod@\n", false],
    ["npm:@acme/x@", false],
  ];
  for (const [version, result] of rows)
    assert.equal(isRegistryVersion(version), result, JSON.stringify(version));
});

// Extends "[happy-9] resolveScope installs a pin that aliases a registry
// version": several aliased packages, one by default and one by choice,
// beside a plain pin, all installed with no blocker.
test("[happy-9] several aliased pins install by default and by choice, beside a plain pin", () => {
  const scope = scopeOf(
    {
      zod: "npm:zod@3.22.4",
      lodash: "npm:lodash.merge@^4.6.2",
      ui: "npm:@acme/ui@>=1.0.0 <2.0.0",
      react: "^18.2.0",
    },
    { lodash: "approved-package" },
  );
  for (const [name, version] of [
    ["zod", "npm:zod@3.22.4"],
    ["lodash", "npm:lodash.merge@^4.6.2"],
    ["ui", "npm:@acme/ui@>=1.0.0 <2.0.0"],
    ["react", "^18.2.0"],
  ] as const)
    assert.deepEqual(dependencyOf(scope, name), {
      name,
      kind: "package",
      version,
      resolution: "approved-package",
      detail: INSTALLED,
    });
  assert.deepEqual(scope.blockers, []);
});

// Extends "[unhappy-2] resolveScope still refuses to install a pin that is not
// a registry version": more refused pins, malformed aliases among them, each
// with the new detail and its own blocker, beside an installed alias.
test("[unhappy-2] each non-registry pin is unresolved with the new detail and its own blocker", () => {
  const refused: Record<string, string> = {
    a: "workspace:*",
    b: "git+https://github.com/a/b.git",
    c: "npm:zod@file:../x",
    d: "npm:zod",
    e: "npm:zod@1@2",
    f: "acme/widgets",
    g: "",
  };
  const scope = scopeOf(
    { ...refused, zod: "npm:zod@3.22.4" },
    Object.fromEntries(
      Object.keys(refused).map((name) => [name, "approved-package" as const]),
    ),
  );
  for (const [name, version] of Object.entries(refused)) {
    assert.deepEqual(dependencyOf(scope, name), {
      name,
      kind: "package",
      version,
      resolution: "unresolved",
      detail: UNRESOLVED,
    });
    assert.ok(
      scope.blockers.some(
        (blocker) =>
          blocker.code === "dependency_unresolved" &&
          blocker.detail === `${name} is pinned to ${version}, which is not a registry version.`,
      ),
      name,
    );
  }
  assert.equal(scope.blockers.length, Object.keys(refused).length);
  assert.equal(dependencyOf(scope, "zod")?.resolution, "approved-package");
  for (const dependency of scope.dependencies)
    assert.notEqual(dependency.detail, "Not a registry version: a URL, a path or an alias.");
});

// resolveScope's check is `!isRegistryVersion(item.version)`: an approved pin
// is refused exactly when isRegistryVersion says it is not a registry version.
test("[unhappy-2] resolveScope refuses an approved pin exactly when isRegistryVersion rejects it", () => {
  for (const version of [
    "3.22.4",
    "npm:zod@3.22.4",
    "npm:zod@ ",
    " ",
    "npm:Zod@1.0.0",
    "npm:zod@github:a/b",
    "1.0.0_beta",
    "link:../shared",
  ]) {
    const scope = scopeOf({ zod: version }, { zod: "approved-package" });
    const resolution = dependencyOf(scope, "zod")?.resolution;
    if (isRegistryVersion(version)) {
      assert.equal(resolution, "approved-package", version);
      assert.deepEqual(scope.blockers, [], version);
    } else {
      assert.equal(resolution, "unresolved", version);
      assert.equal(dependencyOf(scope, "zod")?.detail, UNRESOLVED, version);
    }
  }
});

// Extends "[happy-10] resolveScope still approves a registry pin": every kind
// of registry pin the old test accepted is still approved by default, and is
// a registry version by the exported test.
test("[happy-10] every plain registry pin is a registry version and is approved by default", () => {
  const pins: Record<string, string> = {
    a: "3.22.4",
    b: "^1.2.0",
    c: "~1.2",
    d: ">=1.0.0 <2.0.0",
    e: "1.x || 2.x",
    f: "*",
    g: "latest",
    h: "1.0.0-beta.1+build.5",
  };
  for (const version of Object.values(pins))
    assert.equal(isRegistryVersion(version), true, version);
  const scope = scopeOf(pins);
  for (const [name, version] of Object.entries(pins))
    assert.deepEqual(dependencyOf(scope, name), {
      name,
      kind: "package",
      version,
      resolution: "approved-package",
      detail: INSTALLED,
    });
  assert.deepEqual(scope.blockers, []);
});
