import assert from "node:assert/strict";
import { test } from "node:test";

import { ticketKey } from "../../src/ticket.js";

/**
 * Any string jiraKey is returned exactly as given; only a null, undefined or
 * absent jiraKey falls back to "T-" and the number as JavaScript formats it.
 */

// Extends "[happy-10] a ticket shows its Jira key, else T- and its number".
test("[happy-10] other Jira keys and numbers choose the key the same way", () => {
  assert.equal(ticketKey({ number: 42, jiraKey: "PROJ-9999" }), "PROJ-9999");
  assert.equal(ticketKey({ number: 12 }), "T-12");
  assert.equal(ticketKey({ number: 12, jiraKey: null }), "T-12");
  assert.equal(ticketKey({ number: 12, jiraKey: undefined }), "T-12");
  assert.equal(ticketKey({ number: 1234567 }), "T-1234567");
  assert.equal(ticketKey({ number: 100000 }), "T-100000");
});

// Extends "[happy-10] a Jira key is returned with its casing and line breaks":
// strings that look like missing values are still keys.
test("[happy-10] Jira keys that read like empty values are returned as given", () => {
  for (const jiraKey of ["null", "undefined", "0", "false", "NaN", "T-"]) {
    assert.equal(ticketKey({ number: 5, jiraKey }), jiraKey);
  }
});

// Extends "[happy-10] a ticket shows its Jira key, else T- and its number":
// a long, non-ASCII key is not cut, trimmed or reformatted.
test("[happy-10] a long non-ASCII Jira key is returned unchanged", () => {
  const jiraKey = `  ÄÖÜ-\u{1F600}-${"9".repeat(300)}\r\n`;
  assert.equal(ticketKey({ number: 1, jiraKey }), jiraKey);
});

// Extends "[boundary-11] blank Jira keys are returned as they are".
test("[boundary-11] blank Jira keys of other whitespace are returned as they are", () => {
  for (const jiraKey of [" ", "\r\n", " ".repeat(100), "　﻿"]) {
    assert.equal(ticketKey({ number: 3, jiraKey }), jiraKey);
  }
  assert.equal(ticketKey({ number: 1042, jiraKey: "" }), "");
});

// Extends "[boundary-12] numbers are formatted the way JavaScript formats them".
test("[boundary-12] other numbers are formatted as String formats them", () => {
  const numbers = [
    0.1 + 0.2,
    -0,
    1e-7,
    123456789012,
    -2.5,
    Number.NEGATIVE_INFINITY,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    2 ** 53 + 2,
  ];
  for (const number of numbers) {
    assert.equal(ticketKey({ number }), `T-${String(number)}`, `number ${String(number)}`);
  }
  assert.equal(ticketKey({ number: 0.1 + 0.2 }), "T-0.30000000000000004");
  assert.equal(ticketKey({ number: -0 }), "T-0");
  assert.equal(ticketKey({ number: 1e-7 }), "T-1e-7");
  assert.equal(ticketKey({ number: -2.5 }), "T--2.5");
});

// Extends "[boundary-13] a Jira key wins over any number, blank keys included".
test("[boundary-13] a Jira key wins over unusual numbers", () => {
  for (const number of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, -0, 2 ** 60]) {
    assert.equal(ticketKey({ number, jiraKey: "ACME-1" }), "ACME-1");
    assert.equal(ticketKey({ number, jiraKey: "   " }), "   ");
  }
});
