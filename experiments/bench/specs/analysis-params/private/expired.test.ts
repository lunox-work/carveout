import assert from "node:assert/strict";
import { test } from "node:test";

import { expiredAnalysis } from "../../src/analysis.js";

/**
 * The watchdog's rule for an analysis whose worker lost its lease, beyond the
 * limits and values the public suite uses: requeue as `attempt + 1` while
 * `attempt < maxAttempts`, otherwise fail with `attempt` unchanged.
 */

type Row = [attempt: number, maxAttempts: number, status: "queued" | "failed", result: number];

function assertRows(rows: Row[]): void {
  for (const [attempt, maxAttempts, status, result] of rows) {
    let actual: ReturnType<typeof expiredAnalysis> | undefined;
    assert.doesNotThrow(() => {
      actual = expiredAnalysis(attempt, maxAttempts);
    });
    assert.deepEqual(actual, { status, attempt: result }, `expiredAnalysis(${attempt}, ${maxAttempts})`);
  }
}

// Extends "[happy-5] an expired attempt is requeued while attempts remain and
// failed at the limit": every attempt up to and past limits other than 3 and 10.
test("[happy-5] every attempt below each limit from 1 to 12 is requeued as the next and the rest fail", () => {
  for (let maxAttempts = 1; maxAttempts <= 12; maxAttempts += 1) {
    for (let attempt = 1; attempt <= maxAttempts + 3; attempt += 1) {
      const expected =
        attempt < maxAttempts
          ? { status: "queued", attempt: attempt + 1 }
          : { status: "failed", attempt };
      assert.deepEqual(expiredAnalysis(attempt, maxAttempts), expected, `${attempt} of ${maxAttempts}`);
    }
  }
});

// Extends "[happy-5] the last attempt before the limit is requeued as the
// limit itself": a large limit, so a rule tuned to small limits shows.
test("[happy-5] an analysis with a limit of 1000 is requeued from 999 and failed at 1000", () => {
  assertRows([
    [1, 1000, "queued", 2],
    [500, 1000, "queued", 501],
    [999, 1000, "queued", 1000],
    [1000, 1000, "failed", 1000],
  ]);
});

// Extends "[boundary-1] attempts at the edges of the limit": other limits, and
// attempts far past a lowered limit.
test("[boundary-1] attempts far past a lowered limit fail with their own number", () => {
  assertRows([
    [2, 2, "failed", 2],
    [2, 1, "failed", 2],
    [3, 2, "failed", 3],
    [100, 3, "failed", 100],
    [Number.MAX_SAFE_INTEGER, 1, "failed", Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER, "queued", Number.MAX_SAFE_INTEGER - 1],
    [1, Number.MAX_SAFE_INTEGER, "queued", 2],
  ]);
});

// Extends "[boundary-2] each call returns a new object": the failed branch too,
// and many calls in a row.
test("[boundary-2] failed and queued results are new objects on every call", () => {
  const failedA = expiredAnalysis(3, 3);
  const failedB = expiredAnalysis(3, 3);
  assert.deepEqual(failedA, failedB);
  assert.notEqual(failedA, failedB);
  const seen = new Set<object>();
  for (let index = 0; index < 20; index += 1) {
    const result = expiredAnalysis(index % 2 === 0 ? 1 : 3, 3);
    assert.equal(seen.has(result), false);
    seen.add(result);
  }
  assert.equal(seen.size, 20);
});

// Extends "[boundary-2] changing one result does not affect the next call":
// calls interleaved with other arguments, so no state carries between them.
test("[boundary-2] results do not depend on earlier calls with other arguments", () => {
  const failed = expiredAnalysis(3, 3);
  assert.deepEqual(failed, { status: "failed", attempt: 3 });
  assert.deepEqual(expiredAnalysis(3, 3), { status: "failed", attempt: 3 });
  assert.deepEqual(expiredAnalysis(1, 3), { status: "queued", attempt: 2 });
  assert.deepEqual(expiredAnalysis(7, 2), { status: "failed", attempt: 7 });
  assert.deepEqual(expiredAnalysis(1, 3), { status: "queued", attempt: 2 });
  assert.deepEqual(expiredAnalysis(3, 3), { status: "failed", attempt: 3 });
});

// Extends "[boundary-3] arguments that are not positive integers are compared
// as given": fractions near the limit, where `attempt + 1 <= maxAttempts` and
// `attempt < maxAttempts` disagree.
test("[boundary-3] a fractional attempt below the limit is requeued even when attempt + 1 passes it", () => {
  assertRows([
    [2.5, 3, "queued", 3.5],
    [2.75, 3, "queued", 3.75],
    [3, 3.5, "queued", 4],
    [3.5, 3.5, "failed", 3.5],
    [3.5, 3, "failed", 3.5],
    [0.5, 1, "queued", 1.5],
  ]);
});

// Extends "[boundary-3] negative, infinite and NaN limits go through the same
// comparison": NaN on both sides, negative pairs and infinite attempts, where
// `attempt >= maxAttempts ? fail : requeue` and the spec's rule disagree.
test("[boundary-3] NaN, negative and infinite arguments go through attempt < maxAttempts", () => {
  assertRows([
    [Number.NaN, Number.NaN, "failed", Number.NaN],
    [Number.NaN, 0, "failed", Number.NaN],
    [0, Number.NaN, "failed", 0],
    [-5, -3, "queued", -4],
    [-3, -5, "failed", -3],
    [-1, 0, "queued", 0],
    [Number.POSITIVE_INFINITY, 3, "failed", Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY, 0, "queued", Number.NEGATIVE_INFINITY],
    [3, Number.NEGATIVE_INFINITY, "failed", 3],
    [-0, 3, "queued", 1],
  ]);
});

// Extends "[boundary-3] arguments that are not positive integers are compared
// as given": a failed attempt is returned unchanged, so -0 stays -0.
test("[boundary-3] a failed attempt of -0 is returned as -0, unchanged", () => {
  const result = expiredAnalysis(-0, 0);
  assert.equal(result.status, "failed");
  assert.equal(Object.is(result.attempt, -0), true);
});
