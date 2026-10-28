/**
 * Hidden tests for degenerate hashes: bits 0-14 all zero light only the
 * centre, bits 0-14 all set are kept, and nothing re-rolls the hash.
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

const CENTRE_ONLY = "..... ..... ..#.. ..... .....";
const ALL_ON = "##### ##### ##### ##### #####";

// Extends "a hash with no cell bits set lights only the centre cell": four
// more such seeds, so a table of the two pinned ones is not enough.
test("[boundary-5] other hashes with no cell bits set light only the centre cell", () => {
  assertFace(identicon("org-47672"), CENTRE_ONLY, 198);
  assertFace(identicon("org-64451"), CENTRE_ONLY, 112);
  assertFace(identicon("org-177715"), CENTRE_ONLY, 68);
  assertFace(identicon("org-250559"), CENTRE_ONLY, 130);
});

// h = 0xa7c78000 and 0x4f0f8000: bit 15 is set but bits 0-14 are not. The
// grid is bits 0-14 only, so these still get the centre fix-up, and the hue
// keeps bit 15.
test("[boundary-5] a hash with bit 15 set but no cell bits still lights only the centre", () => {
  assertFace(identicon("org-276054"), CENTRE_ONLY, 223);
  assertFace(identicon("org-294739"), CENTRE_ONLY, 159);
});

// Extends "a hash with every cell bit set keeps every cell": other all-on
// hashes, one of them (0xf5117fff) with bit 15 clear.
test("[boundary-5] other hashes with every cell bit set keep every cell", () => {
  assertFace(identicon("org-33775"), ALL_ON, 289);
  assertFace(identicon("org-50116"), ALL_ON, 213);
  assertFace(identicon("org-210815"), ALL_ON, 194);
  assertFace(identicon("org-284872"), ALL_ON, 116);
});

// One cell bit set is not an empty grid: the centre stays off.
test("[boundary-5] a hash with a single cell bit set is not given the centre", () => {
  // Bit 0 only: the two top corners.
  assertFace(identicon("u41884"), "#...# ..... ..... ..... .....", 299);
  assertFace(identicon("u64078"), "#...# ..... ..... ..... .....", 106);
  // Bit 14 only: the bottom row's middle cell, the highest grid bit.
  assertFace(identicon("u48149"), "..... ..... ..... ..... ..#..", 11);
  assertFace(identicon("u51411"), "..... ..... ..... ..... ..#..", 146);
});

// Bit 8 only sets the centre by itself; the result is the same grid as the
// fix-up gives, with its own hue.
test("[boundary-5] a hash whose only cell bit is the centre's keeps just the centre", () => {
  assertFace(identicon("u57952"), CENTRE_ONLY, 156);
  assertFace(identicon("u68572"), CENTRE_ONLY, 121);
});

// The fix-up sets exactly one cell; the hue is still (h >>> 15) % 360 of the
// original hash, not of a re-rolled one.
test("[boundary-5] the centre fix-up leaves the hue of the original hash", () => {
  const face = identicon("user-54233");
  assert.equal(face.cells.filter((cell) => cell).length, 1);
  assert.equal(face.cells[12], true);
  assert.equal(face.hue, (0x8c0c0000 >>> 15) % 360);
  assert.equal(identicon("user-46623").hue, (0x55ee0000 >>> 15) % 360);
});
