import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seededLockfile } from "../src/carve.js";

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
