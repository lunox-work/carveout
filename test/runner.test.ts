/**
 * The folder's `npm test` runner: a Vitest test that fails on the mocks
 * before any edit joins the baseline as a node:test one does, and the run
 * counts each runner's tests apart from carveout's own checks of the
 * public surface.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { countsOf } from "../src/carve.js";
import { testRunnerScript } from "../src/project/project.js";

let scratch = "";

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "carveout-runner-"));
});

after(() => rmSync(scratch, { recursive: true, force: true }));

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

/** A folder with the runner, an empty environment and loader, and these files. */
function folder(name: string, files: Record<string, string>): string {
  const root = join(scratch, name);
  write(root, {
    "package.json": JSON.stringify({ name, type: "module" }),
    "carveout.env": "",
    "carveout/assets.js": "export {};\n",
    "carveout/test.js": testRunnerScript(undefined),
    ...files,
  });
  return root;
}

/** A stand-in for Vitest: writes REPORT where `--outputFile.json=` says, as Vitest's JSON reporter does, and exits STATUS. */
function vitest(root: string, report: object, status: number): void {
  write(root, {
    "node_modules/.bin/vitest": [
      "#!/bin/sh",
      'echo "$@" > vitest-args.txt',
      'for arg in "$@"; do case "$arg" in --outputFile.json=*) out="${arg#--outputFile.json=}";; esac; done',
      'mkdir -p "$(dirname "$out")"',
      `cat > "$out" <<'EOF'`,
      JSON.stringify(report),
      "EOF",
      `exit ${status}`,
      "",
    ].join("\n"),
  });
  chmodSync(join(root, "node_modules/.bin/vitest"), 0o755);
}

/** The runner, as `npm test` runs it: not inside this file's own test run. */
const run = (root: string) => {
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  return spawnSync(process.execPath, ["carveout/test.js"], { cwd: root, encoding: "utf8", env });
};

test("a Vitest test that fails before any edit is in the TAP the baseline is read from, and once there is not counted", () => {
  const root = folder("vitest", {
    "src/a.test.ts": 'import { it } from "vitest";\n',
    "src/b.test.ts": 'import { it } from "vitest";\n',
  });
  const here = realpathSync(root);
  const report = (failing: string[]) => ({
    testResults: [
      {
        name: join(here, "src/a.test.ts"),
        status: failing.length > 0 ? "failed" : "passed",
        message: "",
        assertionResults: [
          { ancestorTitles: ["money"], title: "adds", status: "passed" },
          ...["fails on the mock", "fails # on purpose", "fails after the change"].map((title) => ({
            ancestorTitles: ["money"],
            title,
            status: failing.includes(title) ? "failed" : "passed",
            failureMessages: failing.includes(title) ? [`AssertionError: expected 1 to be 2 (${title})\n    at src/a.test.ts:9:3`] : [],
          })),
          { ancestorTitles: ["money"], title: "skipped", status: "skipped" },
        ],
      },
      // A file whose import throws: failed, with no test run.
      { name: join(here, "src/b.test.ts"), status: "failed", message: "Cannot find module './missing.js'", assertionResults: [] },
    ],
  });

  // The first run: no baseline, so every failure fails it.
  vitest(root, report(["fails on the mock", "fails # on purpose"]), 1);
  const first = run(root);
  assert.equal(first.status, 1, first.stdout + first.stderr);
  // No baseline yet: Vitest's own report, and the JSON one.
  assert.match(readFileSync(join(root, "vitest-args.txt"), "utf8"), /--reporter=default --reporter=json/);
  const tap = readFileSync(join(root, "carveout/.last-run.tap"), "utf8");
  assert.match(tap, /^not ok \d+ - src\/a\.test\.ts > money > fails on the mock$/m);
  // `#` is escaped, so the name is not read as a TAP directive.
  assert.match(tap, /^not ok \d+ - src\/a\.test\.ts > money > fails \\# on purpose$/m);
  assert.match(tap, /^not ok \d+ - src\/b\.test\.ts$/m);
  // Five tests in the one file (one skipped) and the file that failed to load.
  assert.deepEqual(countsOf(tap), {
    tests: 6,
    pass: 2,
    fail: 3,
    runners: { vitest: { tests: 6, pass: 2, fail: 3 } },
  });
  assert.match(first.stdout, /npm test: 2 of 6 test\(s\) pass \(vitest\)\./);

  // The failures as `check` records them: the baseline.
  const failing = [...tap.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map((match) => match[1]);
  write(root, { "carveout/baseline.json": JSON.stringify({ failing }) });
  const second = run(root);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  // With one, the JSON report alone: the baseline's failures go unprinted.
  assert.doesNotMatch(readFileSync(join(root, "vitest-args.txt"), "utf8"), /--reporter=default/);
  assert.match(second.stdout, /3 Vitest test\(s\) fail on the mocks as they did when the folder was checked/);
  assert.match(second.stdout, /3 failure\(s\) as before any edit, on the mocks, not counted/);

  // A failure the baseline does not name fails the run, and is named.
  vitest(root, report(["fails on the mock", "fails # on purpose", "fails after the change"]), 1);
  const third = run(root);
  assert.equal(third.status, 1);
  // In full, with its message; the baseline's failures not printed.
  assert.match(
    third.stdout,
    /Failing now and not when the folder was checked:\n\nnot ok - src\/a\.test\.ts > money > fails after the change\n {2}AssertionError: expected 1 to be 2 \(fails after the change\)\n {6}at src\/a\.test\.ts:9:3/,
  );
  assert.doesNotMatch(third.stdout, /\(fails on the mock\)/);

  // A run that fails with every test passing (an error outside any test) fails.
  write(root, { "carveout/baseline.json": JSON.stringify({ failing: [] }) });
  vitest(root, { testResults: [report([]).testResults[0]] }, 1);
  assert.equal(run(root).status, 1);
  vitest(root, { testResults: [report([]).testResults[0]] }, 0);
  assert.equal(run(root).status, 0);
});

test("node:test's counts leave out the interface test's checks, which are counted as the public surface's", () => {
  const root = folder("node", {
    "src/thing.ts": "export const thing = 1;\n",
    "src/thing.js": "export const thing = 1;\n",
    "src/c.test.ts": 'import { test } from "node:test";\n',
    "src/c.test.js": [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'test("passes", () => assert.equal(1, 1));',
      'test("fails on the mock", () => assert.equal(1, 2));',
      "",
    ].join("\n"),
    "carveout/tests/interface.test.ts": 'import { test } from "node:test";\n',
    "carveout/tests/interface.test.js": [
      'import { test } from "node:test";',
      'test("src/thing.ts keeps its public surface", () => {});',
      "",
    ].join("\n"),
  });
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const counts = countsOf(readFileSync(join(root, "carveout/.last-run.tap"), "utf8"));
  assert.deepEqual(counts, {
    tests: 2,
    pass: 1,
    fail: 1,
    runners: { "node:test": { tests: 2, pass: 1, fail: 1 } },
    surface: { checks: 1, fail: 0 },
  });
  assert.match(result.stdout, /npm test: 1 of 2 test\(s\) pass \(node:test\); 1 of 1 check\(s\) of the public surface hold\./);
});

test("a TAP from a folder cut before the runner's counts is read as node:test's summary", () => {
  assert.deepEqual(countsOf("TAP version 13\nok 1 - a\n# tests 1\n# pass 1\n# fail 0\n"), { tests: 1, pass: 1, fail: 0 });
  assert.equal(countsOf("TAP version 13\n"), undefined);
});

test("the surface's type check does not count the implicit anys the build does not, and counts any other error", () => {
  const surface = (name: string, diagnostics: string, waived: string[]) => {
    const root = folder(name, {
      "carveout/test.js": testRunnerScript(undefined, false, waived),
      "carveout/surface/check.ts": "export const c0 = 0; // apps/api/src/db.ts | pool | value\n",
      "carveout/surface/tsconfig.json": "{}\n",
      "node_modules/.bin/tsc": `#!/bin/sh\ncat <<'EOF'\n${diagnostics}\nEOF\nexit 2\n`,
    });
    chmodSync(join(root, "node_modules/.bin/tsc"), 0o755);
    return run(root);
  };
  const implicit = "apps/api/src/db.ts(3,10): error TS7006: Parameter 'err' implicitly has an 'any' type.";
  const waived = surface("surface-waived", implicit, ["apps/api/src/db.ts"]);
  assert.equal(waived.status, 0, waived.stdout);
  assert.match(waived.stdout, /1 of 1 check\(s\) of the public surface hold/);
  const counted = surface("surface-counted", implicit, []);
  assert.equal(counted.status, 1);
  assert.match(counted.stdout, /the public surface's declarations compile/);
});
