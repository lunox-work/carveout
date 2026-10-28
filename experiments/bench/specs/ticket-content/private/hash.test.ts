import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { DEFAULT_ISSUE_TYPE, TICKET_LIMITS, ticketSpecHash } from "../../src/ticket.js";

/**
 * ticketSpecHash is SHA-256 over the UTF-8 of
 * JSON.stringify([normalized title, normalized description, normalized issue
 * type]), as lowercase hex. The expected values below are computed from the
 * already-normalized strings, written out by hand.
 */

const STORY = "3b83fc961d8b052c4ebb2269255f29a3e901b27eb21f7452ea5f9ac5c5d77444";
const BUG = "7e3c32427cf03005b0304866833c254926f931bbe4beedea60c2e6297afbacc2";
const FIX_IT = "cddb635f134a4d5762ecb6231a36db6d93e45e613c8fc8c2d19837e5aaf6c16c";
const EMPTY = "799c55d702efedb7750db18b36386fc3a3f4be7dddcfb649adeb41a3ed0da228";
const HEX_64 = /^[0-9a-f]{64}$/;

/** The expected fingerprint of three strings that are already normalized. */
function expected(title: string, description: string, issueType: string): string {
  return createHash("sha256")
    .update(JSON.stringify([title, description, issueType]), "utf8")
    .digest("hex");
}

// Extends "[happy-5] known tickets resolve to their known fingerprints":
// tickets outside the known table, so a lookup table cannot pass.
test("[happy-5] tickets outside the known table resolve to their SHA-256 fingerprints", async () => {
  const tickets: ReadonlyArray<readonly [string, string, string]> = [
    ["Add import", "Adds CSV.", "Story"],
    ["Rename the billing tab", "Users asked for it.\n\nSee the thread.", "Improvement"],
    ["Fix it", "", "Bug"],
    ["x", "y", "z"],
    ["Quote \"this\" and \\that\\", "Tab\there", "Sub-task"],
  ];
  for (const [title, description, issueType] of tickets) {
    const hash = await ticketSpecHash(title, description, issueType);
    assert.equal(hash, expected(title, description, issueType), `hashing ${JSON.stringify([title, description, issueType])}`);
    assert.match(hash, HEX_64);
  }
});

// Extends "[happy-5] known tickets resolve to their known fingerprints":
// non-ASCII text is hashed as its UTF-8 bytes.
test("[happy-5] non-ASCII titles and descriptions hash as their UTF-8 bytes", async () => {
  const tickets: ReadonlyArray<readonly [string, string, string]> = [
    ["Café export \u{1F600}", "Ünïcødé — “quoted”", "Story"],
    ["导出 CSV", "添加导出功能。", "任务"],
    ["é", "é", "Bug"],
  ];
  for (const [title, description, issueType] of tickets) {
    assert.equal(
      await ticketSpecHash(title, description, issueType),
      expected(title, description, issueType),
      `hashing ${JSON.stringify([title, description, issueType])}`,
    );
  }
});

// Extends "[happy-5] known tickets resolve to their known fingerprints":
// control characters are hashed with JSON's own escaping.
test("[happy-5] control characters inside a field hash with JSON escaping", async () => {
  const title = "A\u0000B\u0001C";
  const description = "line\n\tindented\u001f";
  assert.equal(
    await ticketSpecHash(title, description, "Task"),
    expected(title, description, "Task"),
  );
});

// Extends "[boundary-3] a whitespace-only ticket hashes like the empty ticket".
test("[boundary-3] a ticket of only Unicode whitespace hashes as the empty ticket", async () => {
  const hash = await ticketSpecHash(" 　", "﻿\r\n ", "\r");
  assert.equal(hash, EMPTY);
  assert.equal(hash, expected("", "", ""));
  assert.match(hash, HEX_64);
});

// Extends "[boundary-3] an entirely empty ticket still hashes": the empty
// ticket resolves to a string, and long blank fields hash the same way.
test("[boundary-3] long blank fields still hash as the empty ticket", async () => {
  const result = ticketSpecHash(" ".repeat(10_000), "\r\n".repeat(10_000), "\t".repeat(100));
  assert.equal(typeof result.then, "function");
  const hash = await result;
  assert.equal(typeof hash, "string");
  assert.equal(hash, EMPTY);
});

// Extends "[boundary-4] an empty issue type is not replaced by the default".
test("[boundary-4] an empty issue type hashes as the empty string for any ticket", async () => {
  const tickets: ReadonlyArray<readonly [string, string]> = [
    ["Add export", "Adds CSV."],
    ["", ""],
    ["Rename", "Long\ndescription"],
  ];
  for (const [title, description] of tickets) {
    const empty = await ticketSpecHash(title, description, "");
    assert.equal(empty, expected(title, description, ""));
    assert.notEqual(empty, await ticketSpecHash(title, description, DEFAULT_ISSUE_TYPE));
    assert.equal(await ticketSpecHash(title, description, "\r\n \t"), empty);
  }
});

// Extends "[boundary-4] an empty issue type is not replaced by the default":
// the empty ticket is not the empty ticket with the default issue type.
test("[boundary-4] the empty ticket is not hashed as a Task", async () => {
  assert.notEqual(await ticketSpecHash("", "", "Task"), EMPTY);
  assert.equal(await ticketSpecHash("", "", "Task"), expected("", "", "Task"));
});

// Extends "[happy-6] line-ending and trailing whitespace noise does not change the hash".
test("[happy-6] noise in every field resolves to the fingerprint of the normalized fields", async () => {
  assert.equal(
    await ticketSpecHash(
      "\r\n  Rename the billing tab  \r",
      "\n Users asked for it.\t\r\r\n  See the thread.  \r\n\r\n",
      "　Improvement\r\n",
    ),
    expected("Rename the billing tab", "Users asked for it.\n\n  See the thread.", "Improvement"),
  );
});

// Extends "[happy-6] a noisy known ticket still resolves to its known fingerprint".
test("[happy-6] lone CR line endings hash like LF line endings", async () => {
  assert.equal(
    await ticketSpecHash("Title", "One\rTwo\rThree", "Bug"),
    await ticketSpecHash("Title", "One\nTwo\nThree", "Bug"),
  );
  assert.equal(
    await ticketSpecHash("Title", "One\r\nTwo\r\nThree", "Bug"),
    expected("Title", "One\nTwo\nThree", "Bug"),
  );
});

// Extends "[happy-6] line-ending and trailing whitespace noise does not change the hash":
// a description at its limit with CRLF noise on every line.
test("[happy-6] a long noisy description hashes as its normalized form", async () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
  const noisy = lines.map((line) => `${line}  `).join("\r\n");
  assert.ok(noisy.length <= TICKET_LIMITS.description);
  assert.equal(
    await ticketSpecHash("Long", noisy, "Story"),
    expected("Long", lines.join("\n"), "Story"),
  );
});

// Extends "[happy-7] a change of meaning in any field changes the hash".
test("[happy-7] small changes of meaning in any field change the hash", async () => {
  const base = await ticketSpecHash("Add export", "Adds CSV.", "Story");
  const changed: ReadonlyArray<readonly [string, string, string]> = [
    ["Add export.", "Adds CSV.", "Story"],
    ["Add\texport", "Adds CSV.", "Story"],
    ["Add export", "Adds CSV", "Story"],
    ["Add export", "adds CSV.", "Story"],
    ["Add export", "Adds\nCSV.", "Story"],
    ["Add export", "Adds CSV.", "STORY"],
    ["Add export", "Adds CSV.", "Stories"],
    ["Adds CSV.", "Add export", "Story"],
  ];
  for (const [title, description, issueType] of changed) {
    const hash = await ticketSpecHash(title, description, issueType);
    assert.notEqual(hash, base, `hashing ${JSON.stringify([title, description, issueType])}`);
    assert.equal(hash, expected(title, description, issueType));
  }
});

// Extends "[happy-7] the title is hashed whole, not clamped": a title far
// over the limit, and one differing only past the limit.
test("[happy-7] a title far over the limit is hashed whole", async () => {
  const title = "x".repeat(1000);
  assert.equal(await ticketSpecHash(title, "", "Task"), expected(title, "", "Task"));
  assert.notEqual(
    await ticketSpecHash(`${title}a`, "", "Task"),
    await ticketSpecHash(`${title}b`, "", "Task"),
  );
});

// Extends "[happy-7] blank lines, inner indentation and case are meaning":
// Unicode text is not folded into another form.
test("[happy-7] composed and decomposed accents hash differently", async () => {
  assert.notEqual(
    await ticketSpecHash("Café", "", "Task"),
    await ticketSpecHash("Café", "", "Task"),
  );
});

// Extends "[unhappy-1] text cannot be shifted between fields to forge a hash".
test("[unhappy-1] text shifted between description and issue type does not forge a hash", async () => {
  const pairs: ReadonlyArray<
    readonly [readonly [string, string, string], readonly [string, string, string]]
  > = [
    [["X", "AB", "C"], ["X", "A", "BC"]],
    [["X", "", "AB"], ["X", "A", "B"]],
    [["", "A", "B"], ["A", "B", ""]],
    [["AB", "", ""], ["", "", "AB"]],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(
      await ticketSpecHash(a[0], a[1], a[2]),
      await ticketSpecHash(b[0], b[1], b[2]),
      `comparing ${JSON.stringify(a)} with ${JSON.stringify(b)}`,
    );
  }
});

// Extends "[unhappy-1] a forged field separator in the title does not shift fields":
// separators other than a quote-comma or a line break.
test("[unhappy-1] separator characters inside a field do not forge a hash", async () => {
  for (const separator of ["\u0000", "\u001f", "|", ",", "\t", '","', '\\","']) {
    assert.notEqual(
      await ticketSpecHash(`A${separator}B`, "", "Task"),
      await ticketSpecHash("A", "B", "Task"),
      `separator ${JSON.stringify(separator)}`,
    );
    assert.notEqual(
      await ticketSpecHash("T", `A${separator}B`, ""),
      await ticketSpecHash("T", "A", "B"),
      `separator ${JSON.stringify(separator)}`,
    );
  }
});

// Extends "[unhappy-1] text cannot be shifted between fields to forge a hash":
// reordering the same three values.
test("[unhappy-1] the same three values in another order do not forge a hash", async () => {
  const hashes = new Set([
    await ticketSpecHash("A", "B", "C"),
    await ticketSpecHash("A", "C", "B"),
    await ticketSpecHash("B", "A", "C"),
    await ticketSpecHash("B", "C", "A"),
    await ticketSpecHash("C", "A", "B"),
    await ticketSpecHash("C", "B", "A"),
  ]);
  assert.equal(hashes.size, 6);
  assert.equal(await ticketSpecHash("B", "A", "C"), expected("B", "A", "C"));
});

// Extends "[unhappy-1] text cannot be shifted between fields to forge a hash":
// backslashes and quotes next to the field boundary.
test("[unhappy-1] escapes next to a field boundary do not forge a hash", async () => {
  assert.notEqual(
    await ticketSpecHash("a\\", "b", "Task"),
    await ticketSpecHash("a", "\\b", "Task"),
  );
  assert.equal(await ticketSpecHash("a\\", "b", "Task"), expected("a\\", "b", "Task"));
  assert.equal(await ticketSpecHash('a"', '"b', "Task"), expected('a"', '"b', "Task"));
});

// Extends "[happy-8] the same ticket hashes the same every time": other
// calls between the repeats do not change the result.
test("[happy-8] the same ticket hashes the same with other calls in between", async () => {
  const first = await ticketSpecHash("Rename", "Café \u{1F600}", "Bug");
  await ticketSpecHash("Other", "x".repeat(5000), "Story");
  await ticketSpecHash("", "", "");
  const again = await ticketSpecHash("Rename", "Café \u{1F600}", "Bug");
  assert.equal(again, first);
  assert.equal(first, expected("Rename", "Café \u{1F600}", "Bug"));
});

// Extends "[happy-8] a description at its limit hashes the same every time".
test("[happy-8] a ticket at every text limit hashes to the same correct value ten times", async () => {
  const title = "t".repeat(TICKET_LIMITS.title);
  const description = "d".repeat(TICKET_LIMITS.description);
  const issueType = "i".repeat(TICKET_LIMITS.issueType);
  const want = expected(title, description, issueType);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(await ticketSpecHash(title, description, issueType), want);
  }
});

// Extends "[concurrency-1] many interleaved overlapping calls do not interfere":
// many distinct inputs, so each call must resolve to its own hash.
test("[concurrency-1] fifty overlapping calls with distinct inputs each resolve to their own hash", async () => {
  const inputs = Array.from(
    { length: 50 },
    (_, i) => [`Ticket ${i}`, `Description ${i}\n${"z".repeat(i * 100 + 1)}`, i % 2 === 0 ? "Story" : "Bug"] as const,
  );
  const results = await Promise.all(inputs.map(([t, d, k]) => ticketSpecHash(t, d, k)));
  assert.deepEqual(
    results,
    inputs.map(([t, d, k]) => expected(t, d, k)),
  );
});

// Extends "[concurrency-1] overlapping hash calls resolve in call order to their own hashes":
// a large first call does not let later small calls take its place.
test("[concurrency-1] a slow first call and fast later calls resolve in call order", async () => {
  const big = "b".repeat(TICKET_LIMITS.description);
  const results = await Promise.all([
    ticketSpecHash("Big", `  ${big}\r\n`, "Story"),
    ticketSpecHash("Fix it", "", "Task"),
    ticketSpecHash("Add export", "Adds CSV.", "Bug"),
    ticketSpecHash("", "", ""),
    ticketSpecHash("Add export", "Adds CSV.", "Story"),
  ]);
  assert.deepEqual(results, [expected("Big", big, "Story"), FIX_IT, BUG, EMPTY, STORY]);
});
