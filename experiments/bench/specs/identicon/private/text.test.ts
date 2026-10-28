/**
 * Hidden tests for how the seed becomes bytes: UTF-8, no trimming, no case
 * folding, no normalization, U+FFFD for lone surrogates, no length limit.
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

// ---- bytes ------------------------------------------------------------------

// Extends "case and leading whitespace give their own faces": trailing
// whitespace, a tab, a leading newline and an upper-cased id.
test("[boundary-1] trailing whitespace, tabs, newlines and upper case are kept", () => {
  assertFace(identicon("a "), "..#.. ..#.. ##### .###. #...#", 305);
  assertFace(identicon("a\t"), "##### ##### ..#.. .#.#. ..#..", 145);
  assertFace(identicon("\na"), "..#.. .###. ##### #.#.# .#.#.", 142);
  assertFace(identicon("USER-1"), "..#.. .###. .#.#. ##### .#.#.", 15);
});

// Extends "NFC and NFD spellings of café give different faces": three
// spellings of Å (NFC, NFD, the angstrom sign) and two of the Hangul syllable
// 가, each hashed as written.
test("[boundary-1] canonically equivalent spellings of Å and 가 keep their own faces", () => {
  assert.equal("Å".normalize("NFC"), "Å");
  assert.equal("Å".normalize("NFC"), "Å");
  assertFace(identicon("Å"), "#.#.# .#.#. ##.## .#.#. #...#", 132);
  assertFace(identicon("Å"), ".###. ##### ..#.. ##### ##.##", 305);
  assertFace(identicon("Å"), "..... #...# #.#.# ..#.. ##.##", 100);
  assert.equal("가".normalize("NFC"), "가");
  assertFace(identicon("가"), "#.#.# .#.#. ..#.. #.#.# .....", 257);
  assertFace(identicon("가"), "#...# .#.#. ..... ##.## .....", 31);
});

// é is one UTF-16 code unit below 256 but two UTF-8 bytes: hashing code
// units, or Latin-1, gives a different face.
test("[boundary-1] a non-ASCII character is hashed as its UTF-8 bytes", () => {
  assertFace(identicon("é"), "#...# ..... ##.## ..#.. .###.", 195);
  assertFace(identicon("é"), "##### ##.## ..#.. ##.## ..#..", 151);
  assertFace(identicon("😀"), "..... #...# ..... ##.## #...#", 157);
});

// Case folding would map ß to SS, and compatibility normalization ﬁ to fi.
test("[boundary-1] ß, SS, the ﬁ ligature and fi each keep their own faces", () => {
  assertFace(identicon("ß"), "##### .#.#. ..#.. .#.#. .....", 52);
  assertFace(identicon("SS"), "##.## ..#.. ##.## #.#.# #...#", 29);
  assertFace(identicon("ﬁ"), "#.#.# .#.#. ..#.. ..#.. #####", 187);
  assertFace(identicon("fi"), "..... .#.#. ##.## ##### #.#.#", 13);
});

// Every code point from U+0000 to U+07FF (one and two UTF-8 bytes), and a
// spread of three- and four-byte ones, matches the algorithm over UTF-8.
test("[boundary-1] single code points of every UTF-8 length match the algorithm", () => {
  const seeds: string[] = [];
  for (let cp = 0; cp <= 0x7ff; cp++) seeds.push(String.fromCodePoint(cp));
  for (let cp = 0x800; cp <= 0xffff; cp += 211) {
    if (cp < 0xd800 || cp > 0xdfff) seeds.push(String.fromCodePoint(cp));
  }
  for (let cp = 0x10000; cp <= 0x10ffff; cp += 4099) {
    seeds.push(String.fromCodePoint(cp));
  }
  for (const seed of seeds) {
    assert.deepEqual(
      identicon(seed),
      expected(seed),
      `code point ${seed.codePointAt(0)}`,
    );
  }
});

// ---- lone surrogates --------------------------------------------------------

// Extends "a lone high surrogate hashes as U+FFFD": a lone surrogate between
// other characters is replaced in place, not dropped.
test("[boundary-2] a lone surrogate inside a seed hashes as U+FFFD in place", () => {
  const face = identicon("a\uD800b");
  assert.deepEqual(face, identicon("a�b"));
  assertFace(face, "#.#.# #.#.# ##### ##.## #####", 34);
  assert.notDeepEqual(face, identicon("ab"));
});

// Extends "a lone low surrogate also hashes as U+FFFD": a low surrogate
// before a high one is two lone surrogates, so two U+FFFD.
test("[boundary-2] a reversed surrogate pair hashes as two U+FFFD", () => {
  const face = identicon("\uDE00\uD83D");
  assert.deepEqual(face, identicon("��"));
  assertFace(face, "##### ..... .#.#. ..#.. #...#", 248);
});

// A well-formed pair is one astral character, not two replacements.
test("[boundary-2] a valid surrogate pair is not replaced, but a trailing lone half is", () => {
  assert.notDeepEqual(identicon("😀"), identicon("��"));
  assert.notDeepEqual(identicon("😀"), identicon("�"));
  assertFace(identicon("\uD83D"), ".#.#. #...# #...# .###. #...#", 239);
  assert.deepEqual(identicon("user-\uD83D"), identicon("user-�"));
  assert.deepEqual(identicon("user-\uD83D"), expected("user-�"));
});

// ---- any string -------------------------------------------------------------

// Extends "the empty seed is accepted and hashes zero bytes": the empty seed
// after other calls, and two NULs are not one NUL.
test("[boundary-3] the empty seed keeps its face after other seeds and on repeat", () => {
  identicon("user-46623");
  identicon("a");
  for (let i = 0; i < 3; i++) {
    assertFace(identicon(""), "#.#.# ..... ##### .###. #...#", 225);
  }
});

// Extends "a single NUL character is not the empty seed": NUL bytes count one
// by one, so one and two NULs differ from each other and from "".
test("[boundary-3] one and two NUL characters each hash their bytes", () => {
  assertFace(identicon("\u0000"), "##### ##.## ..#.. .###. #.#.#", 64);
  assertFace(identicon("\u0000\u0000"), "#.#.# #...# ##### ##.## #...#", 301);
});

// Extends "a seed of 9999 x's is hashed in full": ten times longer.
test("[boundary-4] a seed of 100000 x's is hashed in full", () => {
  assertFace(identicon("x".repeat(100000)), "#.#.# ..... #...# ##### .###.", 143);
});

// Extends "a seed of 10000 x's is hashed in full, unlike 9999": seeds that
// differ only in their last or first character, far past any prefix limit.
test("[boundary-4] 100000-character seeds differing only at one end get different faces", () => {
  const lastDiffers = "x".repeat(99999) + "y";
  const firstDiffers = "y" + "x".repeat(99999);
  assertFace(identicon(lastDiffers), ".#.#. .###. .#.#. .###. .###.", 351);
  assertFace(identicon(firstDiffers), "..#.. ..... ##### #.#.# #...#", 250);
});

// A long multi-byte seed: 50000 characters, 100000 UTF-8 bytes.
test("[boundary-4] a long multi-byte seed is hashed over all its UTF-8 bytes", () => {
  const seed = "é".repeat(50000);
  assert.deepEqual(identicon(seed), expected(seed));
  assert.notDeepEqual(identicon(seed), identicon("é".repeat(49999)));
  const astral = "a😀".repeat(20000);
  assert.deepEqual(identicon(astral), expected(astral));
});
