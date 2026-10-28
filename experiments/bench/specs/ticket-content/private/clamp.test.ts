import assert from "node:assert/strict";
import { test } from "node:test";

import { TICKET_LIMITS, clampTicketTitle } from "../../src/ticket.js";

/**
 * clampTicketTitle cuts to the first 255 UTF-16 code units, drops a high
 * surrogate (U+D800 to U+DBFF) left at the cut, and does nothing else.
 */

const EMOJI = "\u{1F600}";

// Extends "[happy-9] titles within the limit are returned unchanged".
test("[happy-9] other titles within the limit are returned unchanged", () => {
  for (const title of [
    "\tRename the billing tab\r\n",
    "Fix  it…",
    "x".repeat(200) + "\n" + "y".repeat(54),
    "导出 CSV \u{1F600}\u{1F680}",
    "é",
  ]) {
    assert.ok(title.length <= TICKET_LIMITS.title);
    assert.equal(clampTicketTitle(title), title);
  }
});

// Extends "[happy-9] a title within the limit that ends on a whole emoji is unchanged":
// a short title is never cut, so even a lone high surrogate at its end stays.
test("[happy-9] a short title ending on a lone high surrogate is unchanged", () => {
  for (const title of ["\ud83d", "Fix \ud83d", "a\udbff"]) {
    assert.equal(clampTicketTitle(title), title);
  }
});

// Extends "[boundary-5] titles are cut to exactly the title limit": other
// lengths and a much longer title.
test("[boundary-5] titles of many lengths over the limit are cut to their first 255 code units", () => {
  const source = Array.from({ length: 2000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  for (const length of [257, 300, 510, 511, 2000]) {
    const title = source.slice(0, length);
    const clamped = clampTicketTitle(title);
    assert.equal(clamped, source.slice(0, 255), `length ${length}`);
    assert.equal(clamped.length, 255);
  }
  assert.equal(clampTicketTitle("q".repeat(100_000)), "q".repeat(255));
});

// Extends "[boundary-5] titles are cut to exactly the title limit": the cut
// keeps the start, not the end, and adds no ellipsis.
test("[boundary-5] the cut keeps the first code units and adds nothing", () => {
  const title = "S" + "m".repeat(253) + "E" + "tail";
  const clamped = clampTicketTitle(title);
  assert.equal(clamped, "S" + "m".repeat(253) + "E");
  assert.equal(clamped.endsWith("…"), false);
  assert.equal(clamped.endsWith("..."), false);
});

// Extends "[boundary-6] an over-long blank title is cut, not trimmed".
test("[boundary-6] blank titles at and over the limit are cut, never trimmed", () => {
  assert.equal(clampTicketTitle("\t".repeat(255)), "\t".repeat(255));
  assert.equal(clampTicketTitle("\n".repeat(1000)), "\n".repeat(255));
  assert.equal(clampTicketTitle(" \r\n".repeat(100)), " \r\n".repeat(85));
  assert.equal(clampTicketTitle(" "), " ");
});

// Extends "[boundary-7] whitespace before the cut is kept": other kinds of
// whitespace at and before the cut.
test("[boundary-7] tabs, CRLF and trailing spaces before the cut are kept", () => {
  const title = "x".repeat(250) + "\t \r\n " + "y".repeat(10);
  assert.equal(title.length, 265);
  const clamped = clampTicketTitle(title);
  assert.equal(clamped, "x".repeat(250) + "\t \r\n ");
  assert.equal(clamped.length, 255);
  const leading = "   " + "z".repeat(300);
  assert.equal(clampTicketTitle(leading), "   " + "z".repeat(252));
});

// Extends "[boundary-8] a surrogate pair that fits whole is kept": pairs
// ending exactly at the cut, from the bottom and the top of the astral range.
test("[boundary-8] astral characters ending exactly at the cut are kept", () => {
  for (const astral of ["\u{10000}", "\u{1F680}", "\u{10FFFF}"]) {
    const title = "a".repeat(253) + astral + "b".repeat(20);
    const clamped = clampTicketTitle(title);
    assert.equal(clamped, "a".repeat(253) + astral);
    assert.equal(clamped.length, 255);
  }
});

// Extends "[boundary-8] a surrogate pair at the start of a long title is kept":
// an odd offset puts every pair whole inside the limit.
test("[boundary-8] emoji after one leading character fit whole up to the limit", () => {
  const clamped = clampTicketTitle("b" + EMOJI.repeat(200));
  assert.equal(clamped, "b" + EMOJI.repeat(127));
  assert.equal(clamped.length, 255);
});

// Extends "[boundary-8] a surrogate pair that fits whole is kept": BMP
// characters next to the surrogate range are not treated as surrogates.
test("[boundary-8] non-surrogate code units at the cut are kept", () => {
  for (const unit of ["퟿", "", "中", "￿", "\udc00"]) {
    const clamped = clampTicketTitle("a".repeat(254) + unit + "b");
    assert.equal(clamped, "a".repeat(254) + unit, `unit ${unit.charCodeAt(0).toString(16)}`);
    assert.equal(clamped.length, 255);
  }
});

// Extends "[boundary-9] a cut never splits a surrogate pair": the high
// surrogates at both ends of the range.
test("[boundary-9] a cut on the first or last high surrogate drops it", () => {
  for (const astral of ["\u{10000}", "\u{10FFFF}", "\u{1F680}"]) {
    const title = "a".repeat(254) + astral + "c".repeat(50);
    const clamped = clampTicketTitle(title);
    assert.equal(clamped, "a".repeat(254));
    assert.equal(clamped.length, 254);
  }
});

// Extends "[boundary-9] a cut never splits a surrogate pair": a high
// surrogate at the cut is dropped even when no low surrogate follows it.
test("[boundary-9] a lone high surrogate left at the cut is dropped", () => {
  for (const high of ["\ud800", "\udbff"]) {
    const clamped = clampTicketTitle("a".repeat(254) + high + "b".repeat(5));
    assert.equal(clamped, "a".repeat(254));
    assert.equal(clamped.length, 254);
  }
});

// Extends "[boundary-9] a title of only emoji is cut to whole emoji": far
// more emoji than fit, mixed with text.
test("[boundary-9] a long title of text and emoji never ends on a high surrogate", () => {
  const title = ("ab" + EMOJI).repeat(500);
  const clamped = clampTicketTitle(title);
  // 63 whole "ab😀" units are 252 code units; then "ab" and the high half.
  assert.equal(clamped, ("ab" + EMOJI).repeat(63) + "ab");
  assert.equal(clamped.length, 254);
  const last = clamped.charCodeAt(clamped.length - 1);
  assert.ok(last < 0xd800 || last > 0xdbff);
});

// Extends "[boundary-10] clamping twice equals clamping once": other inputs,
// including cuts that dropped a surrogate or kept a whole pair.
test("[boundary-10] clamping is idempotent for long, blank and emoji titles", () => {
  for (const title of [
    "x".repeat(100_000),
    " ".repeat(600),
    "a".repeat(253) + EMOJI + "b",
    EMOJI.repeat(300),
    "b" + EMOJI.repeat(300),
    "Add export",
  ]) {
    const once = clampTicketTitle(title);
    assert.ok(once.length <= 255);
    assert.equal(clampTicketTitle(once), once);
  }
  assert.equal(clampTicketTitle(clampTicketTitle(EMOJI.repeat(300))), EMOJI.repeat(127));
});
