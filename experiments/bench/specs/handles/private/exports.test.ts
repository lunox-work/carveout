import assert from "node:assert/strict";
import { test } from "node:test";

import * as handleModule from "../../src/handle.js";
import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  checkHandle,
  handleStemFromEmail,
  isValidHandle,
  normalizeHandle,
  toHandleCase,
  toHandleStem,
} from "../../src/handle.js";
import * as root from "../../src/index.js";

const LENGTH_REASON = "Must be between 3 and 30 characters.";

const HANDLE_EXPORTS = [
  "HANDLE_MAX_LENGTH",
  "HANDLE_MIN_LENGTH",
  "checkHandle",
  "handleStemFromEmail",
  "isValidHandle",
  "normalizeHandle",
  "toHandleCase",
  "toHandleStem",
];

type Fn = (input: string) => unknown;

function fromRoot(name: string): Fn {
  const value = (root as unknown as Record<string, unknown>)[name];
  assert.equal(typeof value, "function", `${name} should be a function exported from index.ts`);
  return value as Fn;
}

// Extends "[happy-1] HANDLE_MIN_LENGTH is 3 and HANDLE_MAX_LENGTH is 30":
// the constants are the limits checkHandle actually enforces.
test("[happy-1] checkHandle enforces exactly HANDLE_MIN_LENGTH and HANDLE_MAX_LENGTH as its limits", () => {
  assert.equal(HANDLE_MIN_LENGTH, 3);
  assert.equal(HANDLE_MAX_LENGTH, 30);
  assert.deepEqual(checkHandle("a".repeat(HANDLE_MIN_LENGTH)), { status: "ok" });
  assert.deepEqual(checkHandle("a".repeat(HANDLE_MAX_LENGTH)), { status: "ok" });
  assert.deepEqual(checkHandle("a".repeat(HANDLE_MIN_LENGTH - 1)), {
    status: "invalid",
    problem: "length",
    reason: LENGTH_REASON,
  });
  assert.deepEqual(checkHandle("a".repeat(HANDLE_MAX_LENGTH + 1)), {
    status: "invalid",
    problem: "length",
    reason: LENGTH_REASON,
  });
});

// Extends "[happy-1] HANDLE_MIN_LENGTH is 3 and HANDLE_MAX_LENGTH is 30":
// the stem rules use the same constants for the cut and the padding.
test("[happy-1] toHandleStem cuts at HANDLE_MAX_LENGTH and pads below HANDLE_MIN_LENGTH", () => {
  assert.equal(toHandleStem("q".repeat(HANDLE_MAX_LENGTH + 5)).length, HANDLE_MAX_LENGTH);
  assert.equal(toHandleStem("q".repeat(HANDLE_MIN_LENGTH)), "qqq");
  assert.equal(toHandleStem("q".repeat(HANDLE_MIN_LENGTH - 1)), "qq-user");
});

// Extends "[happy-2] every handle export is reachable from the package root as the same value":
// the root functions are not only present but behave as the handle.ts ones.
test("[happy-2] handle functions called through the package root give the handle.ts results", () => {
  assert.deepEqual(fromRoot("checkHandle")("dana"), { status: "ok" });
  assert.deepEqual(fromRoot("normalizeHandle")("  Dana  "), {
    status: "ok",
    handle: "dana",
    display: "Dana",
  });
  assert.equal(fromRoot("isValidHandle")("  Dana  "), true);
  assert.equal(fromRoot("toHandleCase")("  Dana  "), "dana");
  assert.equal(fromRoot("toHandleStem")("Acme Corp"), "acme-corp");
  assert.equal(fromRoot("handleStemFromEmail")("dana@example.test"), "dana");
});

// Extends "[happy-2] every handle export is reachable from the package root as the same value".
test("[happy-2] every handle export of the package root is identical to the handle.ts export, constants included", () => {
  const rootValues = root as unknown as Record<string, unknown>;
  const handleValues = handleModule as unknown as Record<string, unknown>;
  for (const name of HANDLE_EXPORTS) {
    assert.ok(Object.prototype.hasOwnProperty.call(rootValues, name), `${name} should be exported from index.ts`);
    assert.equal(rootValues[name], handleValues[name], name);
  }
  assert.equal(rootValues.HANDLE_MIN_LENGTH, 3);
  assert.equal(rootValues.HANDLE_MAX_LENGTH, 30);
  assert.equal(rootValues.toHandleStem, toHandleStem);
  assert.equal(rootValues.handleStemFromEmail, handleStemFromEmail);
  assert.equal(rootValues.isValidHandle, isValidHandle);
  assert.equal(rootValues.normalizeHandle, normalizeHandle);
  assert.equal(rootValues.toHandleCase, toHandleCase);
});

// Extends "[happy-2] the package root keeps its existing exports alongside the handle exports":
// existing behaviour is checked through calls, not just presence.
test("[happy-2] the package root keeps the existing todo behaviour next to working handle exports", () => {
  assert.equal(fromRoot("toHandleStem")("Zoë Café"), "zo-caf");
  assert.equal(root.TITLE_MAX_LENGTH, 200);
  assert.deepEqual([...root.TODO_FILTERS], ["all", "active", "completed"]);
  assert.equal(root.isTodoFilter("active"), true);
  assert.equal(root.isTodoFilter("done"), false);
  assert.equal(root.isValidTitle("  ok  "), true);
  assert.equal(root.isValidTitle("   "), false);
  assert.throws(() => root.normalizeTitle("   "), root.InvalidTitleError);
  const todo = {
    id: "todo_1",
    title: "write tests",
    done: false,
    createdAt: "2026-09-16T00:00:00.000Z",
  };
  assert.equal(root.toggle(todo).done, true);
  assert.equal(root.rename(todo, "  renamed  ").title, "renamed");
  assert.equal(root.matchesFilter(todo, "completed"), false);
  assert.deepEqual(root.filterTodos([todo], "active"), [todo]);
  assert.deepEqual(root.countTodos([todo, root.toggle(todo)]), {
    total: 2,
    active: 1,
    completed: 1,
  });
});
