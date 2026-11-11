import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneLock, seededLockfile } from "../src/carve.js";

test("a seeded lock preserves workspace-specific and nested dependency versions", () => {
  const repo = mkdtempSync(join(tmpdir(), "carveout-lock-"));
  try {
    assert.equal(seededLockfile(repo, ["apps/a"], { name: "slice" }), null);
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/dep": { version: "1.0.0" },
        "node_modules/dep/node_modules/child": { version: "1.2.0" },
        "node_modules/workspace": { resolved: "apps/a", link: true },
        "apps/a/node_modules/dep": { version: "2.0.0" },
        "apps/b/node_modules/dep": { version: "3.0.0" },
      },
    }));
    const lock = seededLockfile(repo, ["apps/a", "apps/b"], { name: "slice", version: "1.0.0" });
    const packages = lock?.["packages"] as Record<string, { version?: string }>;
    assert.equal(packages["node_modules/dep"]?.version, "2.0.0");
    assert.equal(packages["node_modules/dep/node_modules/child"]?.version, "1.2.0");
    assert.equal(packages["node_modules/workspace"], undefined);
    assert.equal(packages[""]?.version, "1.0.0");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a resolved lock loses what npm left with nothing to install it under", () => {
  const lock = {
    packages: {
      "": { name: "slice" },
      "node_modules/kept": { version: "1.0.0" },
      "node_modules/kept/node_modules/child": { version: "1.1.0" },
      // vitest went; what npm nested under it stayed, marked extraneous or not.
      "node_modules/vitest/node_modules/magic-string": { version: "1.4.1", extraneous: true },
      "node_modules/@vitest/mocker/node_modules/magic-string": { version: "1.4.2" },
      "node_modules/@vitest/mocker/node_modules/magic-string/node_modules/deeper": { version: "0.1.0" },
      "node_modules/stray": { version: "2.0.0", extraneous: true },
    },
  };
  assert.equal(pruneLock(lock), 4);
  assert.deepEqual(Object.keys(lock.packages), ["", "node_modules/kept", "node_modules/kept/node_modules/child"]);
  assert.equal(pruneLock(lock), 0);
});
