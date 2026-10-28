import assert from "node:assert/strict";
import { test } from "node:test";

import { checkHandle, isValidHandle, normalizeHandle, toHandleCase } from "../../src/handle.js";

const LENGTH_REASON = "Must be between 3 and 30 characters.";
const CHARSET_REASON = "Can use letters, numbers, hyphens and underscores only.";

function lengthRejection() {
  return { status: "invalid", problem: "length", reason: LENGTH_REASON };
}

function charsetRejection() {
  return { status: "invalid", problem: "charset", reason: CHARSET_REASON };
}

function assertNoHandleOrDisplay(result: object, label: string) {
  assert.equal("handle" in result, false, label);
  assert.equal("display" in result, false, label);
}

// Rule: normalizeHandle trims and lowercases raw input, then applies checkHandle to the lowercased form

// Extends "[happy-5] normalizeHandle lowercases the handle and keeps the typed casing as display":
// display is exactly the trimmed input, whatever its casing and whatever whitespace surrounded it.
test("[happy-5] normalizeHandle keeps odd casing for display and trims every whitespace kind", () => {
  const cases: Array<[string, string, string]> = [
    ["fEVERsOUL", "feversoul", "fEVERsOUL"],
    [" DaNa_99　", "dana_99", "DaNa_99"],
    ["\r\n-Acme-\r\n", "-acme-", "-Acme-"],
    ["  ___  ", "___", "___"],
    ["ABC", "abc", "ABC"],
    [`\t${"Ab".repeat(15)}\n`, "ab".repeat(15), "Ab".repeat(15)],
  ];
  for (const [raw, handle, display] of cases) {
    assert.deepEqual(normalizeHandle(raw), { status: "ok", handle, display }, JSON.stringify(raw));
  }
});

// Extends "[happy-5] normalizeHandle lowercases the handle and keeps the typed casing as display":
// checkHandle runs on the lowercased form, so an uppercase letter whose toLowerCase is ASCII is accepted.
test("[happy-5] normalizeHandle accepts a Kelvin sign because it lowercases to k, keeping it in display", () => {
  assert.equal("K".toLowerCase(), "k");
  assert.deepEqual(normalizeHandle(" Kab "), {
    status: "ok",
    handle: "kab",
    display: "Kab",
  });
});

// Extends "[happy-5] normalizeHandle accepts already-lowercase input and trims tabs and newlines":
// each call returns a new, unfrozen object with exactly three keys.
test("[happy-5] normalizeHandle returns a fresh ok object with exactly status, handle and display", () => {
  const first = normalizeHandle(" Dana ");
  assert.deepEqual(Object.keys(first).sort(), ["display", "handle", "status"]);
  assert.equal(Object.isFrozen(first), false);
  assert.notEqual(first, normalizeHandle(" Dana "));
  (first as { handle: string }).handle = "tampered";
  assert.deepEqual(normalizeHandle(" Dana "), { status: "ok", handle: "dana", display: "Dana" });
});

// Extends "[boundary-4] normalizeHandle measures length after trimming for accepted input":
// long padding of any whitespace kind does not count.
test("[boundary-4] normalizeHandle accepts 3 and 30 characters inside long, mixed whitespace padding", () => {
  const padding = " \t\n ".repeat(25);
  assert.deepEqual(normalizeHandle(`${padding}AbC${padding}`), {
    status: "ok",
    handle: "abc",
    display: "AbC",
  });
  assert.equal(normalizeHandle(`${padding}${"Y".repeat(30)}${padding}`).status, "ok");
  assert.equal(normalizeHandle(`\r\n${"y".repeat(30)}\r\n`).status, "ok");
});

// Extends "[boundary-4] normalizeHandle rejects input too short after trimming or over 30 characters":
// the rejection is a length rejection, whatever the untrimmed length.
test("[boundary-4] normalizeHandle rejects 2 characters in long padding and 31 characters in padding as length", () => {
  const padding = " ".repeat(20);
  for (const raw of [
    `${padding}ab${padding}`,
    `${padding}AB${padding}`,
    `\t\n${"x".repeat(31)}\t\n`,
    `  ${"X".repeat(31)}  `,
    " 　",
    "\t\r\n",
    "a",
  ]) {
    assert.deepEqual(normalizeHandle(raw), lengthRejection(), JSON.stringify(raw.slice(0, 12)));
  }
});

// Extends "[boundary-4] normalizeHandle measures length after trimming for accepted input":
// length is measured on the lowercased form, which toLowerCase can make longer.
test("[boundary-4] normalizeHandle measures the lowercased form, so a 2-unit input that lowercases to 4 is not a length problem", () => {
  assert.equal("İİ".toLowerCase().length, 4);
  assert.deepEqual(normalizeHandle("İİ"), charsetRejection());
});

// Extends "[unhappy-2] normalizeHandle returns the checkHandle rejection with no handle or display":
// other rejected inputs, each equal to checkHandle of the trimmed, lowercased input.
test("[unhappy-2] normalizeHandle returns exactly checkHandle(toHandleCase(raw)) for more rejected inputs", () => {
  const cases: Array<[string, object]> = [
    ["  a  ", lengthRejection()],
    [" A.B ", charsetRejection()],
    [" Dana Rivers ", charsetRejection()],
    ["Dana!", charsetRejection()],
    ["  😀😀  ", charsetRejection()],
    ["Zoë", charsetRejection()],
    ["dana@example.test", charsetRejection()],
    ["X".repeat(31), lengthRejection()],
    [`  ${"Dana.".repeat(10)}  `, lengthRejection()],
    ["İb", charsetRejection()],
  ];
  for (const [raw, expected] of cases) {
    const result = normalizeHandle(raw);
    assert.deepEqual(result, expected, JSON.stringify(raw));
    assert.deepEqual(result, checkHandle(toHandleCase(raw)), JSON.stringify(raw));
    assert.deepEqual(Object.keys(result).sort(), ["problem", "reason", "status"]);
    assertNoHandleOrDisplay(result, JSON.stringify(raw));
  }
});

// Extends "[unhappy-2] normalizeHandle rejects whitespace-only input as length and a non-ASCII letter as charset":
// rejections are fresh objects and mutating one changes nothing.
test("[unhappy-2] normalizeHandle returns a fresh rejection object on every call", () => {
  const first = normalizeHandle("ab");
  const second = normalizeHandle("ab");
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), false);
  (first as { problem: string }).problem = "charset";
  assert.deepEqual(normalizeHandle("ab"), lengthRejection());
  assertNoHandleOrDisplay(second, "ab");
});

// Extends "[boundary-5] the normalized handle equals toHandleCase of the input and passes checkHandle":
// more accepted inputs.
test("[boundary-5] for many accepted inputs the normalized handle equals toHandleCase and passes checkHandle", () => {
  for (const raw of [
    "\n___\t",
    " -A- ",
    "  0123456789  ",
    "Dana--Rivers",
    "KAB",
    `\t${"Z_".repeat(15)}`,
  ]) {
    const result = normalizeHandle(raw);
    assert.equal(result.status, "ok", JSON.stringify(raw));
    const handle = result.status === "ok" ? result.handle : "";
    assert.equal(handle, toHandleCase(raw), JSON.stringify(raw));
    assert.deepEqual(checkHandle(handle), { status: "ok" }, JSON.stringify(raw));
    assert.equal(result.status === "ok" && result.display, raw.trim(), JSON.stringify(raw));
  }
});

// Rule: isValidHandle is true exactly when normalizeHandle would return status "ok"

// Extends "[happy-6] isValidHandle agrees with normalizeHandle on typical input":
// agreement over a wider set, including inputs that only pass after trimming and lowercasing.
test("[happy-6] isValidHandle agrees with normalizeHandle on padded, uppercase, unusual and edge input", () => {
  const valid = [
    "ABC",
    " Dana ",
    "\r\n---\r\n",
    "___",
    "  abc  ",
    `  ${"X".repeat(30)}  `,
    "Kab",
  ];
  const invalid = [
    "  ab  ",
    `  ${"X".repeat(31)}  `,
    "   ",
    "Dana Rivers",
    "Zoë",
    "😀😀",
    "İİ",
    "a\nb",
    "dana@example.test",
  ];
  for (const raw of valid) {
    assert.equal(isValidHandle(raw), true, JSON.stringify(raw));
    assert.equal(normalizeHandle(raw).status, "ok", JSON.stringify(raw));
  }
  for (const raw of invalid) {
    assert.equal(isValidHandle(raw), false, JSON.stringify(raw));
    assert.equal(normalizeHandle(raw).status, "invalid", JSON.stringify(raw));
  }
});

// Extends "[happy-6] isValidHandle is true at 30 characters and false at 31, 2 and 0":
// every length, padded and in uppercase.
test("[happy-6] isValidHandle is true exactly for 3 to 30 characters after trimming, for every length up to 40", () => {
  for (let length = 0; length <= 40; length++) {
    const raw = ` ${"Q".repeat(length)}\t`;
    assert.equal(isValidHandle(raw), length >= 3 && length <= 30, `length ${length}`);
  }
});
