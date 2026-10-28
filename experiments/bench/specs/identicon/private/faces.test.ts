/**
 * Hidden tests for the identicon contract: golden faces, the literal result
 * and the result's shape, over more seeds than the public suite pins.
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

/** The spec's normative algorithm, steps 2 to 6, written out independently. */
function expected(seed: string): { cells: boolean[]; hue: number } {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(seed)) {
    h = Math.imul(h ^ b, 0x01000193);
  }
  h = h >>> 0;
  const cells: boolean[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const k = col <= 2 ? col : 4 - col;
      cells.push(((h >>> (row * 3 + k)) & 1) === 1);
    }
  }
  if (!cells.includes(true)) cells[12] = true;
  return { cells, hue: (h >>> 15) % 360 };
}

function assertShape(face: Identicon): void {
  assert.equal(face.cells.length, 25);
  for (const cell of face.cells) assert.equal(typeof cell, "boolean");
  for (let row = 0; row < 5; row++) {
    assert.equal(face.cells[row * 5 + 4], face.cells[row * 5 + 0]);
    assert.equal(face.cells[row * 5 + 3], face.cells[row * 5 + 1]);
  }
  assert.ok(Number.isInteger(face.hue));
  assert.ok(face.hue >= 0 && face.hue <= 359);
  assert.deepEqual(Reflect.ownKeys(face).sort(), ["cells", "hue"]);
}

const LONG_GOLDEN = "Zb8f2Kq9Lm3Nx7Rt5Vw1Yc6Hd4Jp0Gs";

/** A fixed, deterministic spread of seeds the public suite never uses. */
const SWEEP: string[] = [
  ...Array.from({ length: 600 }, (_, i) => `user-${i + 3}`),
  ...Array.from({ length: 300 }, (_, i) => `org-${i * 7919}`),
  ...Array.from({ length: 100 }, (_, i) =>
    String.fromCharCode(65 + (i % 26), 97 + ((i * 7) % 26), 48 + (i % 10)),
  ),
];

// ---- golden vectors ---------------------------------------------------------

// Extends "the pinned seeds a, user-1 and user-2 produce their pinned faces":
// the same golden seeds in reverse order, each asked for more than once.
test("[happy-1] the golden seeds keep their faces in reverse order and on repeat", () => {
  for (let round = 0; round < 3; round++) {
    assertFace(identicon(LONG_GOLDEN), ".###. ##### .#.#. ##.## .#.#.", 196);
    assertFace(identicon("user-2"), "#.#.# #.#.# ..... ##### #####", 62);
    assertFace(identicon("user-1"), "..#.. .###. #.#.# ..#.. #####", 326);
    assertFace(identicon("a"), "..#.. #.#.# ..#.. ..#.. .#.#.", 120);
  }
});

// Extends "the pinned seeds ... produce their pinned faces": a lookup table of
// the golden seeds passes those; neighbouring ids follow the same algorithm.
test("[happy-1] neighbouring ids of the golden seeds get the algorithm's faces", () => {
  assertFace(identicon("user-3"), ".#.#. ##.## .#.#. .###. #####", 270);
  assertFace(identicon("org-1"), "##### .#.#. #...# #...# .....", 334);
  assertFace(identicon("日本語"), "##### ..#.. ##.## .###. #.#.#", 206);
});

// Extends "the 31-character pinned seed produces its pinned face": a thousand
// other seeds match the normative algorithm, cell by cell and hue by hue.
test("[happy-1] a thousand other seeds produce the faces the algorithm defines", () => {
  for (const seed of SWEEP) {
    assert.deepEqual(identicon(seed), expected(seed), `seed ${seed}`);
  }
});

// The hue is (h >>> 15) % 360 with no rounding: both ends of 0..359 occur.
test("[happy-1] seeds whose hue lands on 0 and on 359 get exactly those hues", () => {
  assertFace(identicon("org-1344"), "..#.. .###. ##.## ..... .###.", 0);
  assertFace(identicon("org-1497"), "#.#.# .###. .#.#. ##.## ##.##", 0);
  assertFace(identicon("org-399"), "##### #.#.# #.#.# ..... #.#.#", 359);
  assertFace(identicon("org-509"), "..... #...# ..... .#.#. .....", 359);
});

// ---- the literal result -----------------------------------------------------

// Extends "the face for a deep-equals the literal cells array and hue": the
// whole result for user-2 and the empty seed, with nothing else on it.
test("[happy-2] the faces for user-2 and the empty seed deep-equal their literals", () => {
  assert.deepEqual(identicon("user-2"), {
    // prettier-ignore
    cells: [
      true, false, true, false, true,
      true, false, true, false, true,
      false, false, false, false, false,
      true, true, true, true, true,
      true, true, true, true, true,
    ],
    hue: 62,
  });
  assert.deepEqual(identicon(""), {
    // prettier-ignore
    cells: [
      true, false, true, false, true,
      false, false, false, false, false,
      true, true, true, true, true,
      false, true, true, true, false,
      true, false, false, false, true,
    ],
    hue: 225,
  });
});

// Extends "the face for a is a plain, unfrozen object with a plain array": the
// same for a degenerate seed and a long one, and both can be written to.
test("[happy-2] faces for degenerate and long seeds are plain, unfrozen and writable", () => {
  for (const seed of ["user-46623", "user-46705", "x".repeat(10000), ""]) {
    const face = identicon(seed);
    assert.equal(Object.getPrototypeOf(face), Object.prototype);
    assert.ok(Array.isArray(face.cells));
    assert.equal(Object.getPrototypeOf(face.cells), Array.prototype);
    assert.equal(Object.isFrozen(face), false);
    assert.equal(Object.isFrozen(face.cells), false);
    const cells = face.cells as boolean[];
    cells[0] = !cells[0];
    assert.equal(cells[0], !expected(seed).cells[0]);
  }
});

// ---- shape ------------------------------------------------------------------

// Extends "every pinned seed's face has the contract's shape": a thousand
// other seeds, plus the hue-boundary and single-bit seeds.
test("[happy-3] a thousand other seeds' faces have the contract's shape", () => {
  for (const seed of [
    ...SWEEP,
    "org-1344",
    "org-399",
    "u41884",
    "u48149",
    "org-276054",
    "org-210815",
  ]) {
    assertShape(identicon(seed));
  }
});

// Extends "edge seeds' faces have the contract's shape too": every single
// UTF-16 code unit, surrogates included, and astral characters.
test("[happy-3] every single-code-unit seed and some astral seeds have the shape", () => {
  for (let unit = 0; unit <= 0xffff; unit += 37) {
    assertShape(identicon(String.fromCharCode(unit)));
  }
  for (const seed of ["😀", "𝔸", "\u{10FFFF}", "a😀b"]) {
    assertShape(identicon(seed));
  }
});
