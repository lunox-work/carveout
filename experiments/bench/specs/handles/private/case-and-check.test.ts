import assert from "node:assert/strict";
import { test } from "node:test";

import { checkHandle, toHandleCase } from "../../src/handle.js";

const LENGTH_REASON = "Must be between 3 and 30 characters.";
const CHARSET_REASON = "Can use letters, numbers, hyphens and underscores only.";

const ALLOWED = "abcdefghijklmnopqrstuvwxyz0123456789-_";

function lengthRejection() {
  return { status: "invalid", problem: "length", reason: LENGTH_REASON };
}

function charsetRejection() {
  return { status: "invalid", problem: "charset", reason: CHARSET_REASON };
}

/** Every ASCII character (0-127) outside a-z, 0-9, "-" and "_". */
function disallowedAscii(): string[] {
  const chars: string[] = [];
  for (let code = 0; code < 128; code++) {
    const char = String.fromCharCode(code);
    if (!ALLOWED.includes(char)) chars.push(char);
  }
  return chars;
}

// Rule: toHandleCase trims surrounding whitespace and lowercases, and does nothing else

// Extends "[happy-3] toHandleCase trims and lowercases, keeping every other character":
// trimming is String.prototype.trim, so it covers every whitespace kind it removes.
test("[happy-3] toHandleCase trims carriage returns, form feeds, no-break and ideographic spaces", () => {
  assert.equal(toHandleCase("\r\nDana\r\n"), "dana");
  assert.equal(toHandleCase("\v\fDana\f\v"), "dana");
  assert.equal(toHandleCase(" Dana "), "dana");
  assert.equal(toHandleCase("　Dana "), "dana");
  assert.equal(toHandleCase("﻿Dana "), "dana");
});

// Extends "[happy-3] toHandleCase trims and lowercases, keeping every other character":
// nothing else is done: no collapsing, removal, hyphen stripping, cutting or padding.
test("[happy-3] toHandleCase keeps inner whitespace, punctuation, outer hyphens and any length as they are", () => {
  const cases: Array<[string, string]> = [
    ["  A  B  ", "a  b"],
    ["A\tB\nC", "a\tb\nc"],
    ["Rivers.Dana+Work@Example.Test", "rivers.dana+work@example.test"],
    ["  -Dana-  ", "-dana-"],
    ["__Dana__", "__dana__"],
    ["A", "a"],
    ["X".repeat(50), "x".repeat(50)],
    ["Zoë Café 😀", "zoë café 😀"],
    ["ÀÉÎÕÜ", "àéîõü"],
  ];
  for (const [raw, cased] of cases) {
    assert.equal(toHandleCase(raw), cased, JSON.stringify(raw));
  }
});

// Extends "[happy-3] toHandleCase returns an empty string for empty and whitespace-only input".
test("[happy-3] toHandleCase returns an empty string for any mix of whitespace", () => {
  for (const raw of ["\t", "\n\n", " \t\r\n ", " 　", " ".repeat(100)]) {
    assert.equal(toHandleCase(raw), "", JSON.stringify(raw));
  }
});

// Extends "[happy-3] toHandleCase trims and lowercases, keeping every other character":
// lowercasing is String.prototype.toLowerCase, even where it changes length.
test("[happy-3] toHandleCase lowercases with toLowerCase, including length-changing letters", () => {
  assert.equal(toHandleCase(" İB "), "İb".toLowerCase());
  assert.equal(toHandleCase(" İB ").length, 3);
  assert.equal(toHandleCase("KAB"), "kab");
});

// Extends "[boundary-1] toHandleCase applied to its own output is unchanged".
test("[boundary-1] toHandleCase is idempotent over unusual whitespace, punctuation and non-ASCII input", () => {
  for (const raw of [
    "  Mixed_Case-9 　",
    "\r\nÉCOLE\t",
    "  -A.B@C-  ",
    "X".repeat(40),
    "",
    "Kİ",
  ]) {
    const once = toHandleCase(raw);
    assert.equal(toHandleCase(once), once, JSON.stringify(raw));
    assert.equal(toHandleCase(toHandleCase(once)), once, JSON.stringify(raw));
  }
  assert.equal(toHandleCase(toHandleCase("  Mixed_Case-9 　")), "mixed_case-9");
});

// Rule: checkHandle checks an already-cased handle as given

// Extends "[happy-4] checkHandle accepts leading hyphens, all underscores and doubled hyphens":
// there is no rule about leading or trailing "-" or "_" anywhere.
test("[happy-4] checkHandle accepts trailing hyphens, all hyphens, and mixed outer underscores and hyphens", () => {
  for (const handle of ["abc-", "---", "_-_", "-_-", "ab_", "_ab", "a--", "--a", "9-9"]) {
    assert.deepEqual(checkHandle(handle), { status: "ok" }, handle);
  }
});

// Extends "[happy-4] checkHandle accepts ordinary lowercase handles": every allowed character.
test("[happy-4] checkHandle accepts every allowed character in every position", () => {
  for (const char of ALLOWED) {
    assert.deepEqual(checkHandle(char.repeat(3)), { status: "ok" }, char);
    assert.deepEqual(checkHandle(`${char}ab`), { status: "ok" }, char);
    assert.deepEqual(checkHandle(`a${char}b`), { status: "ok" }, char);
    assert.deepEqual(checkHandle(`ab${char}`), { status: "ok" }, char);
  }
  assert.deepEqual(checkHandle("abcdefghijklmnopqrstuvwxyz"), { status: "ok" });
  assert.deepEqual(checkHandle("0123456789-_"), { status: "ok" });
});

// Extends "[happy-4] checkHandle accepts leading hyphens, all underscores and doubled hyphens":
// each call returns a new, unfrozen object with only the status key, and mutating it changes nothing.
test("[happy-4] checkHandle returns a fresh ok object with exactly one key on every call", () => {
  const first = checkHandle("dana") as { status: string };
  assert.deepEqual(Object.keys(first), ["status"]);
  assert.equal(Object.isFrozen(first), false);
  first.status = "tampered";
  assert.deepEqual(checkHandle("dana"), { status: "ok" });
  assert.notEqual(checkHandle("dana"), checkHandle("abc"));
});

// Extends "[boundary-2] checkHandle accepts handles of exactly 3 and exactly 30 characters":
// every length, with characters other than "x".
test("[boundary-2] checkHandle accepts every length from 3 to 30 and rejects every other length up to 64", () => {
  for (let length = 0; length <= 64; length++) {
    for (const char of ["x", "-", "_", "7"]) {
      const expected = length >= 3 && length <= 30 ? { status: "ok" } : lengthRejection();
      assert.deepEqual(checkHandle(char.repeat(length)), expected, `${length} of ${char}`);
    }
  }
});

// Extends "[boundary-2] checkHandle rejects handles of 0, 2 and 31 characters as length".
test("[boundary-2] checkHandle rejects a 1-character, a 31-character mixed and a very long handle as length", () => {
  assert.deepEqual(checkHandle("a"), lengthRejection());
  assert.deepEqual(checkHandle("dana_rivers-0123456789abcdefghi"), lengthRejection());
  assert.equal("dana_rivers-0123456789abcdefghi".length, 31);
  assert.deepEqual(checkHandle("dana_rivers-0123456789abcdefgh"), { status: "ok" });
  assert.deepEqual(checkHandle("a".repeat(10000)), lengthRejection());
});

// Extends "[unhappy-1] checkHandle rejects punctuation and spaces as charset":
// every disallowed ASCII character, at the start, middle and end.
test("[unhappy-1] checkHandle rejects every disallowed ASCII character in any position as charset", () => {
  for (const char of disallowedAscii()) {
    const label = `U+${char.charCodeAt(0).toString(16)}`;
    assert.deepEqual(checkHandle(`${char}ab`), charsetRejection(), label);
    assert.deepEqual(checkHandle(`a${char}b`), charsetRejection(), label);
    assert.deepEqual(checkHandle(`ab${char}`), charsetRejection(), label);
  }
});

// Extends "[unhappy-1] checkHandle rejects uppercase, untrimmed whitespace and non-ASCII as charset":
// line breaks anywhere, and characters that only look like allowed ones.
test("[unhappy-1] checkHandle rejects embedded line breaks and look-alike or invisible characters as charset", () => {
  for (const handle of [
    "\nabc",
    "ab\ncd",
    "abc\r\n",
    "abc ",
    "ab c",
    "ａbc",
    "abc​",
    "Kab",
    "abı",
    "ée",
    "a😀",
    "\ud800ab",
    "ABC",
    "Dana",
    "x".repeat(29) + "X",
  ]) {
    assert.deepEqual(checkHandle(handle), charsetRejection(), JSON.stringify(handle));
  }
});

// Extends "[unhappy-1] checkHandle rejects punctuation and spaces as charset":
// rejections are fresh objects with exactly the three keys.
test("[unhappy-1] checkHandle returns a fresh charset rejection with exactly three keys on every call", () => {
  const first = checkHandle("has.dot");
  const second = checkHandle("has.dot");
  assert.deepEqual(Object.keys(first).sort(), ["problem", "reason", "status"]);
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), false);
  (first as { reason: string }).reason = "tampered";
  assert.deepEqual(checkHandle("has.dot"), charsetRejection());
});

// Extends "[boundary-3] checkHandle reports only length for a 2-code-unit or 31-character handle with bad characters":
// lengths are UTF-16 code units, not code points or graphemes.
test("[boundary-3] checkHandle counts UTF-16 code units when choosing between length and charset", () => {
  // One emoji is 2 code units: too short alone, right length with one more character.
  assert.deepEqual(checkHandle("😀"), lengthRejection());
  assert.deepEqual(checkHandle("a😀"), charsetRejection());
  // 15 emoji are 30 code units; 16 are 32.
  assert.deepEqual(checkHandle("😀".repeat(15)), charsetRejection());
  assert.deepEqual(checkHandle("😀".repeat(16)), lengthRejection());
  // A combining accent is its own code unit.
  assert.deepEqual(checkHandle("é"), lengthRejection());
  assert.deepEqual(checkHandle("ée"), charsetRejection());
});

// Extends "[boundary-3] checkHandle reports length before charset, and charset at a valid length".
test("[boundary-3] checkHandle reports length, not charset, for every too-short or too-long handle of bad characters", () => {
  for (const handle of [
    "",
    ".",
    "AB",
    " a",
    "\n\n",
    "X".repeat(31),
    "a b c d e f g h i j k l m n o p q",
    ".".repeat(100),
  ]) {
    assert.deepEqual(checkHandle(handle), lengthRejection(), JSON.stringify(handle.slice(0, 12)));
  }
  for (const handle of ["ABC", "X".repeat(30), " ab", "...", "a b c d e f g h i j k l m n o"]) {
    assert.deepEqual(checkHandle(handle), charsetRejection(), JSON.stringify(handle));
  }
});
