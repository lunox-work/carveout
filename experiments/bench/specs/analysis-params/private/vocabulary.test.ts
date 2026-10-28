import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANALYSIS_ERROR_CODES,
  ANALYSIS_STATUSES,
  ARTIFACT_KINDS,
  GRAPHIFY_TOOL_VERSION,
  canonicalJson,
  expiredAnalysis,
  type AnalysisParams,
} from "../../src/analysis.js";
import * as bounty from "../../src/bounty.js";
import * as handle from "../../src/handle.js";
import * as core from "../../src/index.js";
import * as pricing from "../../src/pricing/index.js";
import * as repo from "../../src/repo/index.js";
import * as selection from "../../src/selection/index.js";

/**
 * The analysis vocabulary as the package entry point exposes it, the pinned
 * tool version and the parameters type.
 */

// The entry point does not re-export the module until the change lands, so
// its names are looked up by string rather than imported by name.
const entry = core as unknown as Record<string, unknown>;

const STATUSES = ["queued", "running", "succeeded", "failed"];
const ERROR_CODES = [
  "too_large",
  "too_many_files",
  "source_unavailable",
  "tool_failed",
  "tool_timeout",
  "upload_failed",
  "worker_lost",
  "cancelled",
];
const KINDS = ["graph_json", "graph_html", "report_md", "wiki_page", "manifest", "other"];

// Extends "[happy-1] each vocabulary list holds the ticket's values in the
// ticket's order": the lists read through the package entry point.
test("[happy-1] the entry point's vocabulary lists hold the ticket's values in order", () => {
  assert.deepEqual(entry["ANALYSIS_STATUSES"], STATUSES);
  assert.deepEqual(entry["ANALYSIS_ERROR_CODES"], ERROR_CODES);
  assert.deepEqual(entry["ARTIFACT_KINDS"], KINDS);
});

// Extends "[happy-1] the vocabulary lists are plain arrays, not frozen at
// runtime": the same holds for the lists the entry point hands out.
test("[happy-1] the entry point's vocabulary lists are plain unfrozen arrays of distinct values", () => {
  for (const name of ["ANALYSIS_STATUSES", "ANALYSIS_ERROR_CODES", "ARTIFACT_KINDS"]) {
    const list = entry[name];
    assert.equal(Array.isArray(list), true, name);
    assert.equal(Object.isFrozen(list), false, name);
    const values = list as readonly string[];
    assert.equal(new Set(values).size, values.length, name);
  }
  assert.equal((entry["ANALYSIS_STATUSES"] as readonly string[]).length, 4);
  assert.equal((entry["ANALYSIS_ERROR_CODES"] as readonly string[]).length, 8);
  assert.equal((entry["ARTIFACT_KINDS"] as readonly string[]).length, 6);
});

// Extends "[happy-2] the tool version is pinned": read through the entry point.
test("[happy-2] the entry point's tool version is pinned to graphifyy@0.4.18+driver-1", () => {
  assert.equal(entry["GRAPHIFY_TOOL_VERSION"], "graphifyy@0.4.18+driver-1");
  assert.equal(typeof entry["GRAPHIFY_TOOL_VERSION"], "string");
});

// Extends "[happy-3] the package entry point re-exports the module's values":
// the re-exported functions behave as the module's do when called.
test("[happy-3] the functions re-exported by the entry point are the working functions", () => {
  assert.equal(typeof entry["expiredAnalysis"], "function");
  assert.equal(typeof entry["canonicalJson"], "function");
  const viaEntryExpired = entry["expiredAnalysis"] as typeof expiredAnalysis;
  const viaEntryCanonical = entry["canonicalJson"] as typeof canonicalJson;
  assert.deepEqual(viaEntryExpired(2, 4), { status: "queued", attempt: 3 });
  assert.equal(viaEntryCanonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(viaEntryExpired, expiredAnalysis);
  assert.equal(viaEntryCanonical, canonicalJson);
});

// Extends "[happy-3] the re-export keeps the existing exports and adds no
// type-only names": every existing module's export, not only normalizeHandle.
test("[happy-3] the entry point re-exports the module alongside every existing export unchanged", () => {
  assert.equal(entry["ANALYSIS_STATUSES"], ANALYSIS_STATUSES);
  assert.equal(entry["ANALYSIS_ERROR_CODES"], ANALYSIS_ERROR_CODES);
  assert.equal(entry["ARTIFACT_KINDS"], ARTIFACT_KINDS);
  assert.equal(entry["GRAPHIFY_TOOL_VERSION"], GRAPHIFY_TOOL_VERSION);
  const existing: Record<string, unknown>[] = [handle, bounty, selection, pricing, repo];
  for (const module of existing) {
    for (const [name, value] of Object.entries(module)) {
      assert.equal(entry[name], value, name);
    }
  }
  for (const name of [
    "ANALYSIS_STATUSES",
    "ANALYSIS_ERROR_CODES",
    "ARTIFACT_KINDS",
    "GRAPHIFY_TOOL_VERSION",
    "expiredAnalysis",
    "canonicalJson",
  ]) {
    for (const module of existing) {
      assert.equal(name in module, false, name);
    }
  }
});

// Extends "[happy-4] a value typed AnalysisParams carries its deadline in
// minutes": other deadlines, and the value is plain data a cache key can hold.
test("[happy-4] AnalysisParams values carry their deadline in minutes as plain JSON data", () => {
  const thirty: AnalysisParams = { deadlineMinutes: 30 };
  const ninety: AnalysisParams = { deadlineMinutes: 90 };
  assert.equal(thirty.deadlineMinutes, 30);
  assert.equal(ninety.deadlineMinutes, 90);
  assert.equal(canonicalJson(thirty), '{"deadlineMinutes":30}');
  assert.equal(canonicalJson(ninety), '{"deadlineMinutes":90}');
  assert.deepEqual(Object.keys(thirty), ["deadlineMinutes"]);
});
