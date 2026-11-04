/**
 * Hidden tests for `trimTrailingSlashes`: only the run of U+002F at the very
 * end is removed, in linear time, and nothing else is touched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { trimTrailingSlashes } from "../../src/index.js";

const SITE = "https://acme.atlassian.net";

/** Fails if one call takes 250 ms or more of wall time. */
function assertTrimsWithinBudget(input: string, expected: string): void {
  const started = performance.now();
  const actual = trimTrailingSlashes(input);
  const elapsed = performance.now() - started;
  assert.equal(actual, expected);
  assert.ok(
    elapsed < 250,
    `took ${elapsed.toFixed(0)} ms on an input of length ${input.length}`,
  );
}

// ---------------------------------------------------------------------------
// @happy 1: trailing slashes are removed, everything before them is kept
// ---------------------------------------------------------------------------

// Extends "[happy-1] trimTrailingSlashes removes one or many trailing slashes":
// runs longer than three, so a fixed-count strip is caught.
test("[happy-1] hidden: trimTrailingSlashes removes runs of 2, 4, 7, 10 and 500 slashes", () => {
  for (const count of [2, 4, 7, 10, 500]) {
    assert.equal(trimTrailingSlashes(SITE + "/".repeat(count)), SITE);
  }
});

// Extends "[happy-1] trimTrailingSlashes keeps the slashes before the trailing run".
test("[happy-1] hidden: trimTrailingSlashes keeps inner and leading slashes before the trailing run", () => {
  assert.equal(
    trimTrailingSlashes("https://jira.example.com/jira////"),
    "https://jira.example.com/jira",
  );
  assert.equal(trimTrailingSlashes("/a/"), "/a");
  assert.equal(trimTrailingSlashes("//a//"), "//a");
  assert.equal(trimTrailingSlashes("https://x//y//z//"), "https://x//y//z");
  assert.equal(trimTrailingSlashes("a/"), "a");
});

// Extends "[happy-1] ...": only the last run goes, not the whole last segment.
test("[happy-1] hidden: trimTrailingSlashes does not remove the path segment before the trailing run", () => {
  assert.equal(
    trimTrailingSlashes("https://acme.atlassian.net/wiki/spaces/"),
    "https://acme.atlassian.net/wiki/spaces",
  );
});

// Extends "[happy-1] ...": non-ASCII text before the run is kept intact.
test("[happy-1] hidden: trimTrailingSlashes keeps non-ASCII text and surrogate pairs before the run", () => {
  assert.equal(trimTrailingSlashes("https://例え.jp/路径//"), "https://例え.jp/路径");
  assert.equal(trimTrailingSlashes("\u{1F600}/"), "\u{1F600}");
  assert.equal(trimTrailingSlashes("café///"), "café");
});

test("[happy-1] hidden: trimming an already trimmed result changes nothing", () => {
  const once = trimTrailingSlashes("https://jira.example.com/jira///");
  assert.equal(once, "https://jira.example.com/jira");
  assert.equal(trimTrailingSlashes(once), once);
});

// ---------------------------------------------------------------------------
// @boundary 1: strings with no trailing slash come back unchanged
// ---------------------------------------------------------------------------

// Extends "[boundary-1] trimTrailingSlashes returns a URL with no trailing slash unchanged".
test("[boundary-1] hidden: trimTrailingSlashes returns other URLs and paths without a trailing slash unchanged", () => {
  for (const input of [
    "https://jira.example.com/jira",
    "a/b/c",
    "//a",
    "///leading",
    "https://x//y",
  ]) {
    assert.equal(trimTrailingSlashes(input), input);
  }
});

// Extends "[boundary-1] trimTrailingSlashes leaves inner double slashes and a single character alone".
test("[boundary-1] hidden: trimTrailingSlashes leaves long inner slash runs and other single characters alone", () => {
  const inner = "a" + "/".repeat(50) + "b";
  assert.equal(trimTrailingSlashes(inner), inner);
  for (const input of ["a", "0", ".", ":", "\\"]) {
    assert.equal(trimTrailingSlashes(input), input);
  }
});

// ---------------------------------------------------------------------------
// @boundary 2: empty and all-slash strings trim to the empty string
// ---------------------------------------------------------------------------

// Extends "[boundary-2] trimTrailingSlashes trims all-slash strings to the empty string".
test("[boundary-2] hidden: trimTrailingSlashes trims all-slash strings of other lengths to the empty string", () => {
  for (const count of [2, 3, 4, 6, 64, 1000]) {
    assert.equal(trimTrailingSlashes("/".repeat(count)), "");
  }
});

// ---------------------------------------------------------------------------
// @boundary 3: only U+002F counts as a slash
// ---------------------------------------------------------------------------

// Extends "[boundary-3] trimTrailingSlashes keeps trailing backslashes":
// a backslash before the slash run stays, only the slashes go.
test("[boundary-3] hidden: trimTrailingSlashes removes slashes after a backslash but keeps the backslash", () => {
  assert.equal(trimTrailingSlashes("a\\/"), "a\\");
  assert.equal(trimTrailingSlashes("a/\\//"), "a/\\");
  assert.equal(trimTrailingSlashes("a\\"), "a\\");
});

// Extends "[boundary-3] trimTrailingSlashes does not trim a slash followed by a space or a tab".
test("[boundary-3] hidden: trimTrailingSlashes keeps a slash followed by other whitespace", () => {
  for (const tail of ["\n", "\r", "\r\n", " ", " ", "﻿", "  ", "\v", "\f"]) {
    const input = SITE + "/" + tail;
    assert.equal(trimTrailingSlashes(input), input);
  }
});

test("[boundary-3] hidden: trimTrailingSlashes removes only the slashes after trailing whitespace", () => {
  assert.equal(trimTrailingSlashes(SITE + "/ /"), SITE + "/ ");
  assert.equal(trimTrailingSlashes(SITE + "/\t//"), SITE + "/\t");
});

test("[boundary-3] hidden: trimTrailingSlashes keeps slash look-alikes that are not U+002F", () => {
  for (const lookAlike of ["／", "∕", "⁄", "⧸", "̸"]) {
    const input = SITE + lookAlike;
    assert.equal(trimTrailingSlashes(input), input);
  }
});

// ---------------------------------------------------------------------------
// @boundary 4: a long run of slashes is handled in linear time
// ---------------------------------------------------------------------------

// Extends "[boundary-4] trimTrailingSlashes handles each long input within 250 ms":
// the input ends in "/", so an `endsWith("/")` fast path in front of the old
// regex does not skip the quadratic scan over the inner run.
test("[boundary-4] hidden: a long inner run followed by text and one slash is trimmed within 250 ms", () => {
  const run = "/".repeat(60_000);
  assertTrimsWithinBudget(SITE + run + "x/", SITE + run + "x");
  assertTrimsWithinBudget(run + "x/", run + "x");
});

// Extends "[boundary-4] ...": longer input with non-slash text after the run.
test("[boundary-4] hidden: 100,000 slashes followed by text come back unchanged within 250 ms", () => {
  const input = SITE + "/".repeat(100_000) + "x";
  assertTrimsWithinBudget(input, input);
});

// Extends "[boundary-4] ...": an inner run and a trailing run together.
test("[boundary-4] hidden: an inner run of 60,000 and a trailing run of 60,000 are handled within 250 ms", () => {
  const run = "/".repeat(60_000);
  assertTrimsWithinBudget(SITE + run + "jira" + run, SITE + run + "jira");
});

// Extends "[boundary-4] trimTrailingSlashes returns the right output for long runs of slashes".
test("[boundary-4] hidden: 2,000,000 slashes trim to the empty string within 250 ms", () => {
  assertTrimsWithinBudget("/".repeat(2_000_000), "");
});

test("[boundary-4] hidden: a long run after a long non-slash prefix is trimmed within 250 ms", () => {
  const prefix = "a".repeat(200_000);
  assertTrimsWithinBudget(prefix + "/".repeat(60_000), prefix);
});
