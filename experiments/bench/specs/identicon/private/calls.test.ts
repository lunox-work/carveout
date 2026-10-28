/**
 * Hidden tests for repeated, interleaved and overlapping calls: no cache, no
 * module state, a new object and array every time.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { identicon, type Identicon } from "../../src/identicon.js";

/** Five space-separated rows, `#` for true and `.` for false. */
function grid(rows: string): boolean[] {
  return rows
    .split(" ")
    .join("")
    .split("")
    .map((cell) => cell === "#");
}

function assertFace(face: Identicon, rows: string, hue: number): void {
  assert.deepEqual(face.cells, grid(rows));
  assert.equal(face.hue, hue);
}

/** Seeds and their pinned faces, including the degenerate ones. */
const FACES: ReadonlyArray<readonly [string, string, number]> = [
  ["user-1", "..#.. .###. #.#.# ..#.. #####", 326],
  ["user-2", "#.#.# #.#.# ..... ##### #####", 62],
  ["a", "..#.. #.#.# ..#.. ..#.. .#.#.", 120],
  ["", "#.#.# ..... ##### .###. #...#", 225],
  ["user-46623", "..... ..... ..#.. ..... .....", 76],
  ["user-46705", "##### ##### ##### ##### #####", 247],
  ["u41884", "#...# ..... ..... ..... .....", 299],
  ["org-509", "..... #...# ..... .#.#. .....", 359],
];

// ---- repeated calls ---------------------------------------------------------

// Extends "repeated calls agree in new objects with new cells arrays": five
// calls each for degenerate, empty and long seeds, all distinct objects.
test("[happy-4] five calls per seed agree, each in its own object and array", () => {
  for (const seed of ["user-46623", "user-46705", "", "x".repeat(10000)]) {
    const faces = Array.from({ length: 5 }, () => identicon(seed));
    for (let i = 0; i < faces.length; i++) {
      assert.deepEqual(faces[i], faces[0]);
      for (let j = i + 1; j < faces.length; j++) {
        assert.notEqual(faces[i], faces[j]);
        assert.notEqual(faces[i]?.cells, faces[j]?.cells);
      }
    }
  }
});

// Extends "mutating a returned face does not change a later call's face":
// mutate the hue and cells of a degenerate face, then of every pinned face.
test("[happy-4] mutating faces of degenerate and other seeds leaves later calls intact", () => {
  for (const [seed, rows, hue] of FACES) {
    const face = identicon(seed) as { cells: boolean[]; hue: number };
    face.cells.reverse();
    face.cells[12] = !face.cells[12];
    face.cells.length = 3;
    face.hue = -1;
    assertFace(identicon(seed), rows, hue);
  }
});

// A later call must not reach back into an earlier result either.
test("[happy-4] an earlier face is unchanged by later calls with the same seed", () => {
  const first = identicon("user-46623");
  const snapshot = [...first.cells];
  const second = identicon("user-46623") as { cells: boolean[]; hue: number };
  second.cells.fill(true);
  identicon("user-46623");
  assert.deepEqual(first.cells, snapshot);
  assertFace(first, "..... ..... ..#.. ..... .....", 76);
});

// ---- interleaved calls ------------------------------------------------------

// Extends "user-1 is unaffected by earlier calls with user-2, a and the empty
// seed": every pinned seed after every other one, in both orders.
test("[concurrency-1] every pinned seed is unaffected by any other seed called before it", () => {
  for (const [before] of FACES) {
    for (const [seed, rows, hue] of FACES) {
      identicon(before);
      assertFace(identicon(seed), rows, hue);
    }
  }
});

// Extends "user-2 is unaffected by earlier degenerate seeds": a centre fix-up
// must not leak into a single-bit seed's grid, whose centre is off.
test("[concurrency-1] a single-bit seed right after a degenerate one keeps its centre off", () => {
  identicon("user-46623");
  assertFace(identicon("u41884"), "#...# ..... ..... ..... .....", 299);
  identicon("user-54233");
  identicon("user-46705");
  assertFace(identicon("u48149"), "..... ..... ..... ..... ..#..", 11);
});

// A long run of calls changes nothing for the seed asked for last.
test("[concurrency-1] user-1 is unaffected by a thousand earlier calls", () => {
  for (let i = 0; i < 1000; i++) identicon(`user-${i}`);
  identicon("x".repeat(10000));
  assertFace(identicon("user-1"), "..#.. .###. #.#.# ..#.. #####", 326);
});

// ---- overlapping async tasks ------------------------------------------------

// Extends "calls from overlapping async tasks agree with sequential calls":
// 400 tasks over eight seeds, degenerate ones included, compared with the
// pinned faces rather than with another call.
test("[concurrency-2] 400 overlapping tasks over eight seeds each get the pinned face", async () => {
  const results = await Promise.all(
    Array.from({ length: 400 }, async (_, i) => {
      const entry = FACES[i % FACES.length]!;
      await Promise.resolve();
      return { entry, face: identicon(entry[0]) };
    }),
  );
  for (const { entry, face } of results) assertFace(face, entry[1], entry[2]);
});

// Extends "async tasks resuming out of order each get their pinned face":
// tasks resume after a varying, non-monotonic number of ticks, so calls for
// different seeds interleave in an order that is neither start nor reverse.
test("[concurrency-2] tasks resuming in a scrambled order each get the pinned face", async () => {
  const results = await Promise.all(
    Array.from({ length: 160 }, async (_, i) => {
      const entry = FACES[(i * 3) % FACES.length]!;
      const ticks = (i * 37) % 53;
      for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
      return { entry, first: identicon(entry[0]), second: identicon(entry[0]) };
    }),
  );
  for (const { entry, first, second } of results) {
    assertFace(first, entry[1], entry[2]);
    assertFace(second, entry[1], entry[2]);
    assert.notEqual(first.cells, second.cells);
  }
});
