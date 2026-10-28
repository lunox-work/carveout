import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeSpecText } from "../../src/ticket.js";

/**
 * Lines split on "\r\n", "\r" or "\n"; each line is trimEnd-ed; lines are
 * joined with "\n"; the whole is trimmed. Inner spaces, blank lines and the
 * indentation of every line but the first are kept.
 */

// Extends "[happy-4] normalizing spec text removes line-ending and edge noise".
test("[happy-4] a CRLF is one line break, not two", () => {
  assert.equal(normalizeSpecText("a\r\nb"), "a\nb");
  assert.equal(normalizeSpecText("a\r\r\nb"), "a\n\nb");
  assert.equal(normalizeSpecText("a\r\n\rb"), "a\n\nb");
  assert.equal(normalizeSpecText("a\n\r\nb"), "a\n\nb");
  assert.equal(normalizeSpecText("a\r\n\r\n\r\nb"), "a\n\n\nb");
});

// Extends "[happy-4] normalizing spec text removes line-ending and edge noise".
test("[happy-4] trailing whitespace is every kind String.prototype.trimEnd removes", () => {
  assert.equal(normalizeSpecText("One \nTwo　\nThree "), "One\nTwo\nThree");
  assert.equal(normalizeSpecText("One\v\f\nTwo"), "One\nTwo");
  assert.equal(normalizeSpecText("One  \nTwo"), "One\nTwo");
  assert.equal(normalizeSpecText("﻿Title﻿"), "Title");
});

// Extends "[happy-4] indentation after the first line and blank lines are kept".
test("[happy-4] inner whitespace and lines made blank by trimming are kept", () => {
  assert.equal(normalizeSpecText("a\tb  c"), "a\tb  c");
  assert.equal(normalizeSpecText("a\n   \nb"), "a\n\nb");
  assert.equal(normalizeSpecText("a\n\t\t\n\t b \t"), "a\n\n\t b");
  assert.equal(normalizeSpecText("  first\n\tsecond\n    third  "), "first\n\tsecond\n    third");
  // U+2028 is not one of the three line endings, so it stays inside a line.
  assert.equal(normalizeSpecText("a b"), "a b");
});

// Extends "[happy-4] normalizing spec text removes line-ending and edge noise":
// a long text with mixed line endings on every line.
test("[happy-4] a long text with mixed line endings normalizes line by line", () => {
  const endings = ["\r\n", "\r", "\n"];
  let input = "";
  const lines: string[] = [];
  for (let i = 0; i < 3000; i += 1) {
    const line = `${i % 7 === 0 ? "  " : ""}line ${i}`;
    lines.push(line);
    input += `${line} \t${endings[i % 3]}`;
  }
  assert.equal(normalizeSpecText(input), lines.join("\n").trim());
  assert.equal(normalizeSpecText(input).includes("\r"), false);
});

// Extends "[boundary-1] empty and whitespace-only text normalizes to the empty string".
test("[boundary-1] text of any whitespace and line endings normalizes to the empty string", () => {
  for (const input of [
    " ",
    "　\r\n﻿",
    " \r \n \r\n \t ",
    "\v\f",
    "\n".repeat(5000),
    " \r\n".repeat(5000),
  ]) {
    assert.equal(normalizeSpecText(input), "", `normalizing ${JSON.stringify(input.slice(0, 20))}`);
  }
});

// Extends "[boundary-2] normalizing is idempotent for every example input".
test("[boundary-2] normalizing is idempotent for inputs the public examples do not use", () => {
  for (const input of [
    "a\r\r\nb",
    "  \n  \n   x  \n\n",
    "﻿ a  \r\n\t b　",
    "x\n\n\n\ny",
    "\t\tindented\r\n\t\tstill",
    "a b \r",
  ]) {
    const once = normalizeSpecText(input);
    assert.equal(normalizeSpecText(once), once, `normalizing ${JSON.stringify(input)} twice`);
  }
});

// Extends "[boundary-2] normalizing twice equals normalizing once".
test("[boundary-2] the idempotent result is the spec's normalized form", () => {
  const once = normalizeSpecText("\r\n  a\t\r\n\r\n\t b \r c \n\n");
  assert.equal(once, "a\n\n\t b\n c");
  assert.equal(normalizeSpecText(normalizeSpecText(once)), "a\n\n\t b\n c");
});
