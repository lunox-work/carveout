/**
 * The library entry, `carveout/api` (`src/api.ts`), as a platform uses
 * it: `dist/src/api.js` imported with every `child_process` function made
 * to throw (and each attempt recorded), HOME an empty folder and
 * CARVEOUT_HOME unset, every file call carveout makes under HOME recorded. `plan`, `cut`
 * and `patch` on a copy of the shop fixture (no Git checkout, so nothing
 * needs Git) must start no container and run nothing from the folder,
 * leave HOME untouched, and round-trip an unchanged cut to an empty patch
 * with the receipt passed as data. `analyse` must give the cut's manifest
 * and contract and run no process at all, Git included.
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

type Api = typeof import("../src/api.js");

const FIXTURE = resolve(import.meta.dirname, "../../test/fixtures/shop");
const ENTRY = "apps/shop/src/cart.ts";
const require = createRequire(import.meta.url);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "carveout-api-")));
const home = join(scratch, "home");
const repo = join(scratch, "repo");
const out = join(scratch, "slice");
const removeScratch = () => rmSync(scratch, { recursive: true, force: true });
mkdirSync(home);
cpSync(FIXTURE, repo, { recursive: true });
// A test of the slice's own, on node:test, so the plan has one to carry.
writeFileSync(
  join(repo, "apps/shop/src/cart.test.ts"),
  [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { subtotal } from "./cart";',
    "",
    'test("subtotal", () => {',
    "  assert.equal(subtotal([{ cents: 100, quantity: 2 }]), 200);",
    "});",
    "",
  ].join("\n"),
);

/** Every file under `dir`, relative, sorted. */
const tree = (dir: string): string[] =>
  (readdirSync(dir, { recursive: true, withFileTypes: true }) as { name: string; parentPath: string; isFile(): boolean }[])
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();

const spawned: { fn: string; file: string; cwd: string | null }[] = [];
const homeCalls: string[] = [];
let api: Api;

before(async () => {
  process.env["HOME"] = home;
  delete process.env["CARVEOUT_HOME"];
  const childProcess = require("node:child_process") as Record<string, unknown>;
  for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    childProcess[fn] = (file: unknown, ...rest: unknown[]) => {
      const options = rest.find((item) => item !== null && typeof item === "object" && !Array.isArray(item)) as
        | { cwd?: string }
        | undefined;
      spawned.push({ fn, file: String(file), cwd: options?.cwd === undefined ? null : String(options.cwd) });
      throw new Error(`child_process.${fn} called from carveout/api`);
    };
  const inHome = (path: unknown) => {
    const text = path instanceof URL ? path.pathname : String(path);
    return text === home || text.startsWith(`${home}/`);
  };
  for (const module of [require("node:fs"), require("node:fs/promises")] as Record<string, unknown>[])
    for (const [name, original] of Object.entries(module))
      if (typeof original === "function" && /^[a-z]/.test(name) && name !== "watch") {
        const wrapped = function (this: unknown, ...argv: unknown[]) {
          // carveout's own calls only: this file lists HOME itself.
          if ((inHome(argv[0]) || inHome(argv[1])) && /[\\/]dist[\\/]src[\\/]/.test(new Error().stack ?? ""))
            homeCalls.push(`${name} ${String(argv[0])}`);
          return (original as (...args: unknown[]) => unknown).apply(this, argv);
        };
        if ("native" in original) Object.assign(wrapped, { native: (original as { native: unknown }).native });
        module[name] = wrapped;
      }
  syncBuiltinESMExports();
  api = await import("../src/api.js");
});

after(removeScratch);

test("carveout/api resolves to dist/src/api.js by the package's exports", () => {
  assert.equal(import.meta.resolve("carveout/api"), new URL("../src/api.js", import.meta.url).href);
  for (const name of [
    "plan",
    "walk",
    "cut",
    "patch",
    "analyse",
    "importGraph",
    "CutError",
    "integrityOf",
    "gainedIntegrity",
    "weakenedTest",
    "testsVerdict",
    "exposureOf",
  ])
    assert.equal(typeof (api as unknown as Record<string, unknown>)[name], "function", name);
});

test("carveout/extract resolves by the package's exports, with the extractor and the fixture compile", async () => {
  assert.equal(import.meta.resolve("carveout/extract"), new URL("../src/extract.js", import.meta.url).href);
  const extract = (await import("../src/extract.js")) as unknown as Record<string, unknown>;
  for (const name of [
    "npmPackageTypes",
    "sha256",
    "gitBlobId",
    "gitFileMode",
    "boundedHost",
    "extractionOptions",
    "filterDeclaration",
    "loadConfig",
    "isNodeBuiltin",
    "declarationPathFor",
    "isScriptPath",
    "compileFixture",
    "packageUses",
    "packageModules",
    "packageShim",
    "nearestCompilerOptions",
    "workspacePackages",
    "workspaceModuleResolver",
    "packageRegistries",
    "extractTypeScriptBoundary",
  ])
    assert.equal(typeof extract[name], "function", name);
  assert.ok(Array.isArray(extract["NODE_BUILTINS"]));
  assert.ok(Array.isArray(extract["UNTYPED_PACKAGE_CODES"]));
  assert.equal(typeof extract["UNTYPED_PACKAGE_OPTIONS"], "object");
  assert.equal(extract["SHIM_PATH"], "__slice__/packages.d.ts");
});

test("plan lists the files, cuts, surface and tests, and writes nothing", () => {
  const before = tree(scratch);
  const planned = api.plan({ root: repo, entries: [ENTRY], depth: 1, withTests: true });
  assert.deepEqual(tree(scratch), before);
  assert.deepEqual(planned.included, [
    "apps/shop/src/cart.css",
    "apps/shop/src/cart.test.ts",
    "apps/shop/src/cart.ts",
    "apps/shop/src/tax.ts",
  ]);
  // @fx/money is a workspace package, not followed: stubbed as a package, not cut as a module.
  assert.deepEqual(planned.cuts.modules, []);
  assert.deepEqual(planned.workspacePackages, ["@fx/money"]);
  assert.deepEqual(planned.tests.carried, [{ file: "apps/shop/src/cart.test.ts", runner: "node" }]);
  assert.deepEqual(planned.surface, [{ module: ENTRY, names: ["total"], importers: ["apps/shop/src/checkout.ts"] }]);
  assert.deepEqual(planned.packages, ["@fx/money", "stripe"]);
  assert.deepEqual(planned.blockers, []);
  const without = api.plan({ root: repo, entries: [ENTRY], depth: 1 });
  assert.deepEqual(without.tests.carried, []);
  assert.deepEqual(
    without.tests.left.map(({ file, reason }) => ({ file, reason })),
    [{ file: "apps/shop/src/cart.test.ts", reason: "not-asked" }],
  );
});

test("walk is the walk plan reports: included files, edges both ways, links inside, carried tests", () => {
  const before = tree(scratch);
  const walked = api.walk({ root: repo, entries: [ENTRY], depth: 1, withTests: true });
  const planned = api.plan({ root: repo, entries: [ENTRY], depth: 1, withTests: true });
  assert.deepEqual(tree(scratch), before);
  assert.deepEqual(walked.included, planned.included);
  assert.deepEqual(walked.entries, [ENTRY]);
  assert.deepEqual(walked.unknownEntryPoints, []);
  assert.deepEqual(walked.cuts.outbound, planned.cuts.outbound);
  assert.deepEqual(
    walked.cuts.inbound.map((edge) => edge.from),
    ["apps/shop/src/checkout.ts"],
  );
  assert.deepEqual(walked.tests, ["apps/shop/src/cart.test.ts"]);
  assert.ok(walked.internal.every((edge) => walked.included.includes(edge.from) && walked.included.includes(edge.to)));
  assert.ok(walked.dependencies.some((dependency) => dependency.specifier === "stripe" && dependency.status === "external"));
  assert.equal(walked.depthOf[ENTRY], 0);
  assert.deepEqual(api.walk({ root: repo, entries: ["nope.ts"] }).unknownEntryPoints, ["nope.ts"]);
});

let made: Awaited<ReturnType<Api["cut"]>>;

test("cut writes the folder and its carveout.json, and returns the receipt as data", async () => {
  made = await api.cut({ root: repo, entries: [ENTRY], depth: 1, withTests: true, out, offline: true });
  assert.equal(made.out, out);
  assert.equal(made.ready, true, JSON.stringify(made.blockers));
  assert.deepEqual(JSON.parse(readFileSync(join(out, "carveout.json"), "utf8")), made.record);
  assert.equal(made.receipt.cutId, made.record.cutId);
  assert.equal(made.receipt.repo, repo);
  assert.notEqual(made.record.request.public, true);
  for (const path of ["apps/shop/src/cart.ts", "apps/shop/src/cart.test.ts", "packages/money/src/index.d.ts"])
    assert.ok(tree(out).includes(path), path);
  // Written nowhere: not in HOME, not beside the folder.
  assert.deepEqual(tree(home), []);
  assert.deepEqual(readdirSync(scratch).sort(), ["home", "repo", "slice"]);
});

/** A manifest or contract without what the caller stamps in: the commit, and whether the files differ from it. */
const unstamped = (value: object): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  for (const key of ["sourceCommitSha", "sourceDirty", "boundaryContractSha256"]) delete copy[key];
  return copy;
};

test("analyse gives the manifest and contract cut wrote, and runs no process", async () => {
  const before = tree(scratch);
  const tried = spawned.length;
  const lines: string[] = [];
  const analysis = await api.analyse({
    root: repo,
    entries: [ENTRY],
    depth: 1,
    withTests: true,
    commitSha: "c0ffee",
    widenLiterals: made.receipt.record.request.widenLiterals,
    log: (line) => lines.push(line),
  });
  assert.equal(spawned.length, tried, JSON.stringify(spawned.slice(tried)));
  assert.deepEqual(tree(scratch), before);
  assert.ok(lines.length > 0);
  assert.equal(analysis.manifest.sourceCommitSha, "c0ffee");
  assert.equal(analysis.contract.sourceCommitSha, "c0ffee");
  assert.equal(analysis.manifest.sourceDirty, false);
  assert.deepEqual(unstamped(analysis.manifest), unstamped(made.receipt.record.manifest));
  const written = JSON.parse(readFileSync(join(out, "carveout/contract.json"), "utf8")) as object;
  assert.deepEqual(unstamped(JSON.parse(analysis.contractJson) as object), unstamped(written));
  assert.deepEqual(analysis.contract, JSON.parse(analysis.contractJson));
  assert.equal(analysis.ready, made.ready);
  assert.deepEqual(analysis.walk.included, made.receipt.record.manifest.included.map((file) => file.path));
  assert.deepEqual(
    analysis.stubs.map((stub) => stub.path),
    made.receipt.record.manifest.synthetic.filter((file) => file.kind === "stub").map((file) => file.path),
  );
});

test("analyse on a graph from importGraph walks the same, and the graph serves many analyses", async () => {
  const tried = spawned.length;
  const graph = api.importGraph(repo);
  const options = { root: repo, entries: [ENTRY], depth: 1, withTests: true, commitSha: null, widenLiterals: false, graph };
  const lazy = await api.analyse({ ...options, graph: undefined });
  const reused = await api.analyse(options);
  const other = await api.analyse({ ...options, entries: ["apps/shop/src/tax.ts"] });
  assert.equal(spawned.length, tried, JSON.stringify(spawned.slice(tried)));
  const { graphSha256: _lazy, ...lazyRest } = lazy.manifest;
  const { graphSha256: _reused, ...reusedRest } = reused.manifest;
  assert.deepEqual(reusedRest, lazyRest);
  assert.equal(reused.contractJson, lazy.contractJson);
  assert.deepEqual(other.walk.entries, ["apps/shop/src/tax.ts"]);
  assert.ok(graph.nodes.length >= lazy.walk.included.length);
});

test("analyse reads package types through the fetcher given, and nothing else", async () => {
  const typed = join(scratch, "typed");
  cpSync(repo, typed, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(typed, "apps/shop/package.json"), "utf8")) as { dependencies: Record<string, string> };
  manifest.dependencies["date-fns"] = "3.6.0";
  writeFileSync(join(typed, "apps/shop/package.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(typed, "package-lock.json"),
    JSON.stringify({
      name: "shop-monorepo",
      lockfileVersion: 3,
      packages: {
        "": { name: "shop-monorepo" },
        "node_modules/date-fns": { version: "3.6.0", resolved: "https://registry.npmjs.org/date-fns/-/date-fns-3.6.0.tgz" },
      },
    }),
  );
  writeFileSync(
    join(typed, "apps/shop/src/day.ts"),
    'import { format } from "date-fns";\n\nexport const day = (date: Date) => format(date, "yyyy-MM-dd");\n',
  );
  const types = join(scratch, "types");
  mkdirSync(join(types, "node_modules/date-fns"), { recursive: true });
  writeFileSync(join(types, "node_modules/date-fns/package.json"), JSON.stringify({ name: "date-fns", version: "3.6.0", types: "index.d.ts" }));
  writeFileSync(join(types, "node_modules/date-fns/index.d.ts"), "export declare function format(date: Date, pattern: string): string;\n");
  const asked: unknown[] = [];
  const tried = spawned.length;
  try {
    const analysis = await api.analyse({
      root: typed,
      entries: ["apps/shop/src/day.ts"],
      depth: 1,
      commitSha: null,
      packageTypes: async (requests) => {
        asked.push(...requests);
        return { directory: types, packages: [{ name: "date-fns", version: "3.6.0" }] };
      },
    });
    assert.equal(spawned.length, tried, JSON.stringify(spawned.slice(tried)));
    assert.deepEqual(asked, [{ name: "date-fns", spec: "3.6.0" }]);
    assert.deepEqual(analysis.contract.compilation.typedPackages, [{ name: "date-fns", version: "3.6.0" }]);
    assert.equal(analysis.contract.compilation.ok, true, JSON.stringify(analysis.contract.compilation.diagnostics));
  } finally {
    rmSync(typed, { recursive: true, force: true });
    rmSync(types, { recursive: true, force: true });
  }
});

test("analyse: a path read blocks unless omitted, and no slice at all is a CutError with its code", async () => {
  const reads = join(scratch, "reads");
  cpSync(FIXTURE, reads, { recursive: true });
  mkdirSync(join(reads, "apps/shop/python"));
  writeFileSync(join(reads, "apps/shop/python/run.py"), 'print("hi")\n');
  writeFileSync(
    join(reads, "apps/shop/src/runner.ts"),
    'import { fileURLToPath } from "node:url";\n\nexport const script = (): string => fileURLToPath(new URL("../python/run.py", import.meta.url));\n',
  );
  try {
    const options = { root: reads, entries: ["apps/shop/src/runner.ts"], depth: 1, commitSha: null };
    const blocked = await api.analyse(options);
    assert.ok(blocked.manifest.blockers.some((blocker) => blocker.code === "path_read"), JSON.stringify(blocked.manifest.blockers));
    const omitted = await api.analyse({ ...options, pathReads: "omit" });
    assert.deepEqual(omitted.manifest.blockers.filter((blocker) => blocker.code === "path_read"), []);
    await assert.rejects(
      api.analyse({ ...options, entries: ["nope.ts"] }),
      (error: unknown) => error instanceof api.CutError && error.code === "no_files" && /nope\.ts names no file/.test(error.message),
    );
  } finally {
    rmSync(reads, { recursive: true, force: true });
  }
});

test("patch round-trips an unchanged cut to an empty patch, by the receipt given", async () => {
  const unchanged = await api.patch({ receipt: made.receipt, folder: out });
  assert.equal(unchanged.diff, "");
  assert.deepEqual([unchanged.changed, unchanged.added, unchanged.deleted, unchanged.refused, unchanged.boundary], [[], [], [], [], []]);
  assert.equal(unchanged.recordFrom, "receipt");
});

test("patch holds what the hand-off policy refuses, and a receipt of another cut", async () => {
  mkdirSync(join(out, ".github/workflows"), { recursive: true });
  writeFileSync(join(out, ".github/workflows/ci.yml"), "on: push\n");
  try {
    const held = await api.patch({ receipt: made.receipt, folder: out });
    assert.deepEqual(held.refused.map((refusal) => refusal.path), [".github/workflows/ci.yml"]);
    assert.equal(held.diff, "");
  } finally {
    rmSync(join(out, ".github"), { recursive: true, force: true });
  }
  const other = { ...made.receipt, cutId: "0".repeat(32) };
  await assert.rejects(api.patch({ receipt: other, folder: out }), /is the receipt of cut 00000000/);
  await assert.rejects(api.patch({ receipt: { ...made.receipt, schemaVersion: 2 } as never, folder: out }), /not a carveout receipt/);
});

test("the policy's text checks", () => {
  assert.deepEqual(api.integrityOf("src/a.ts", "export const a = 1;\n"), []);
  assert.ok(api.gainedIntegrity("src/a.ts", "export const a = 1;\n", 'export const a = process.env.NODE_ENV === "test" ? 2 : 1;\n').length > 0);
  const kept = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("a", () => {\n  assert.equal(1, 1);\n});\n';
  assert.equal(api.weakenedTest("src/a.test.ts", kept, kept), null);
  assert.equal(typeof api.weakenedTest("src/a.test.ts", kept, kept.replace("  assert.equal(1, 1);\n", "")), "string");
});

test("nothing started a container or ran the folder's code, and HOME was never touched", () => {
  // Git on the repository is the most the API may run; here it is no checkout, and each attempt threw.
  assert.ok(spawned.some((call) => call.cwd === repo), "the trap saw no attempt at all");
  for (const call of spawned) {
    assert.equal(call.file, "git", JSON.stringify(call));
    assert.ok(call.cwd === null || !(call.cwd === out || call.cwd.startsWith(`${out}/`)), JSON.stringify(call));
  }
  assert.deepEqual(homeCalls, []);
  assert.deepEqual(tree(home), []);
});
