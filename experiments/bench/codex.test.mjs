import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { profile } from "./codex.mjs";

test("Codex permission profile blocks session siblings and disables network", () => {
  const root = mkdtempSync(join(tmpdir(), "carveout-profile-test-"));
  try {
    const work = join(root, "work"), state = join(root, "state");
    mkdirSync(work); mkdirSync(state); mkdirSync(join(state, "tmp")); mkdirSync(join(state, "home")); mkdirSync(join(state, "codex")); mkdirSync(join(root, "hidden"));
    const rules = profile(work, state);
    assert.match(rules, /approval_policy = "never"/);
    assert.ok(rules.includes(`${JSON.stringify(realpathSync(join(root, "hidden")))} = "deny"`));
    assert.ok(rules.includes(`${JSON.stringify(realpathSync(work))} = "write"`));
    assert.ok(rules.includes(`${JSON.stringify(realpathSync(join(state, "codex")))} = "deny"`));
    assert.match(rules, /\[permissions\.bench\.network\]\nenabled = false/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
