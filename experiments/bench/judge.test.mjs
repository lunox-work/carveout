import assert from "node:assert/strict";
import { test } from "node:test";
import { hiddenVerdictOf, verdictOf } from "../judge.mjs";

test("hidden suite placement does not fail the agent's own test gate", () => {
  const baseline = { tests: { existing: true } };
  const after = { ok: false, step: "test", tests: { existing: true, hidden: true }, unrun: true, gateFailed: true };
  assert.equal(verdictOf(baseline, after).ok, false);
  assert.equal(hiddenVerdictOf(baseline, after).ok, true);
  assert.equal(hiddenVerdictOf(baseline, { ...after, tests: { existing: true, hidden: false } }).ok, false);
  assert.equal(hiddenVerdictOf(baseline, { ok: false, step: "build" }).ok, false);
});
