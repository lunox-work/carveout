import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANALYSIS_TOOLS,
  SANDBOX_BUILD_RUN_VERSION,
  SLICE_TOOL_VERSION,
  toolVersionOf,
} from "../../src/analysis.js";

// Extends "[happy-1] toolVersionOf reports the bumped slice and sandbox-build
// versions and the rest unchanged": every tool the module lists, read twice,
// with the bumped constants and the reported versions agreeing.
test("[happy-1] every listed tool reports its version, the two bumped ones included, on every call", () => {
  const want: Record<string, string> = {
    slice: "slice@4",
    sandbox_build: "sandbox_build@9",
    graphify: "graphifyy@0.4.18+driver-1",
    abstractions: "abstractions@3",
    data_model: "data_model@1",
    documents: "documents@1",
    brief: "brief@1",
    scope: "scope@5",
    fixtures: "fixtures@3",
    sandbox_starter: "sandbox_starter@4",
  };
  assert.deepEqual([...ANALYSIS_TOOLS].sort(), Object.keys(want).sort());
  for (const tool of ANALYSIS_TOOLS) {
    assert.equal(toolVersionOf(tool), want[tool], tool);
    assert.equal(toolVersionOf(tool), want[tool], `${tool} again`);
  }
  assert.equal(SLICE_TOOL_VERSION, "slice@4");
  assert.equal(SANDBOX_BUILD_RUN_VERSION, "sandbox_build@9");
});

// The shortcut: bump the constants but leave toolVersionOf returning the old
// literals (or the reverse).
test("[happy-1] the slice and sandbox-build versions are no longer the old ones, by constant or by tool", () => {
  for (const version of [
    SLICE_TOOL_VERSION,
    SANDBOX_BUILD_RUN_VERSION,
    toolVersionOf("slice"),
    toolVersionOf("sandbox_build"),
  ]) {
    assert.notEqual(version, "slice@3");
    assert.notEqual(version, "sandbox_build@8");
  }
  assert.equal(toolVersionOf("slice"), SLICE_TOOL_VERSION);
  assert.equal(toolVersionOf("sandbox_build"), SANDBOX_BUILD_RUN_VERSION);
  assert.equal(toolVersionOf("slice"), "slice@4");
  assert.equal(toolVersionOf("sandbox_build"), "sandbox_build@9");
});
