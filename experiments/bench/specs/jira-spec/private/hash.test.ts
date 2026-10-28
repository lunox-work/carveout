import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { ISSUE_FIELDS } from "../../src/mapping.js";
import { specHash, toIssueSpec } from "../../src/spec.js";
import { stripTrailingSlashes } from "../../src/url.js";

/** specHash("Add login", "Users can sign in.") */
const ADD_LOGIN = "24b1c29d416fdea96e63dcd8edf3ccbc14c9e53a0f019720cefd4803fcec0bf5";
/** specHash("Fix the build", "Line one\nLine two") */
const FIX_BUILD = "401c829e08ad2a5a6a3cb4a6913afd15a8f35a9ceb9ddeb48a714539e0b50fa7";
/** specHash("", "") */
const EMPTY = "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d";

/** sha256hex of already-canonical summary and description, joined by NUL. */
function expected(canonSummary: string, canonDescription: string): string {
  return createHash("sha256").update(`${canonSummary}\u0000${canonDescription}`, "utf8").digest("hex");
}

/** Calls specHash with arguments the types would not allow. */
function untypedSpecHash(summary: unknown, descriptionText: unknown) {
  return specHash(summary as string, descriptionText as string);
}

// Extends "[happy-3] a known ASCII summary and description give the known hash":
// inputs no hash table could hold, checked against SHA-256 of the defined input.
test("[happy-3] other summaries and descriptions hash to sha256hex of summary NUL description", async () => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["a", "b"],
    ["Add login", ""],
    ["", "Users can sign in."],
    ["Add logout", "Users can sign out."],
    ["ACME-42: rate limit the API", "Requests over 100/min get a 429.\nLog each one."],
    ["x", "a\u0000b"],
  ];
  for (const [summary, description] of pairs) {
    assert.equal(await specHash(summary, description), expected(summary, description), `${summary} / ${description}`);
  }
});

// Extends "[happy-3] non-ASCII text is hashed as UTF-8 to the known hash".
test("[happy-3] non-ASCII summaries and descriptions are hashed as their UTF-8 bytes", async () => {
  assert.equal(await specHash("Größe ändern", "日本語のテキスト"), expected("Größe ändern", "日本語のテキスト"));
  assert.equal(await specHash("\u{1F680} launch", "ship \u{1F6A2}\nété"), expected("\u{1F680} launch", "ship \u{1F6A2}\nété"));
});

// Extends "[happy-3] a known ASCII summary and description give the known hash": longer inputs.
test("[happy-3] long inputs hash to sha256hex of the whole input", async () => {
  const summary = "s".repeat(5_000);
  const description = "Line of text.\n".repeat(10_000).trimEnd();
  assert.equal(await specHash(summary, description), expected(summary, description));
});

// Extends "[happy-3]": the hash depends on the order of its two arguments.
test("[happy-3] swapping summary and description gives a different, defined hash", async () => {
  assert.equal(await specHash("Users can sign in.", "Add login"), expected("Users can sign in.", "Add login"));
  assert.notEqual(await specHash("Users can sign in.", "Add login"), ADD_LOGIN);
});

// Extends "[boundary-1] whitespace-only inputs canonicalise to empty".
test("[boundary-1] whitespace and line endings alone in either argument hash like two empty strings", async () => {
  assert.equal(await specHash("\r\n\r\n", ""), EMPTY);
  assert.equal(await specHash("", "   \n   \n   "), EMPTY);
  assert.equal(await specHash("\t\r", "\r\r\n\n"), EMPTY);
});

// Extends "[happy-4] the result has the shape of a lowercase hex SHA-256 digest".
test("[happy-4] long, multi-line and NUL-bearing inputs also give a 64-character lowercase hex digest", async () => {
  for (const [summary, description] of [
    ["S".repeat(10_000), "D".repeat(30_000)],
    ["UPPER CASE", "MORE\r\nUPPER"],
    ["\u0000", "\u0000"],
  ] as const) {
    assert.match(await specHash(summary, description), /^[0-9a-f]{64}$/);
  }
});

// Extends "[happy-5] the same inputs always give the same hash": repeated
// calls interleaved with other inputs, so a cache of the last call is not enough.
test("[happy-5] the same inputs give the same hash when calls for other inputs come between", async () => {
  const first = await specHash("Add login", "Users can sign in.");
  const other = await specHash("Fix the build", "Line one\nLine two");
  const second = await specHash("Add login", "Users can sign in.");
  const otherAgain = await specHash("Fix the build", "Line one\nLine two");
  assert.equal(first, ADD_LOGIN);
  assert.equal(second, ADD_LOGIN);
  assert.equal(other, FIX_BUILD);
  assert.equal(otherAgain, FIX_BUILD);
});

// Extends "[happy-5]": inputs that only canonicalise the same give the same hash.
test("[happy-5] the same non-ASCII inputs give the same defined hash every time", async () => {
  const hashes = [];
  for (let i = 0; i < 5; i++) {
    hashes.push(await specHash("Café", "naïve \u{1F642}"));
  }
  assert.deepEqual(hashes, Array(5).fill("9c4cc9badc248d4348703cb96e07cb1dc086a58719c9e27252c8258dec119ca4"));
});

// Extends "[boundary-2] moving text across the summary/description boundary
// changes the hash": a separator other than NUL, or none, gets these wrong.
test("[boundary-2] the summary and description are joined by a NUL, not a newline or nothing", async () => {
  assert.equal(await specHash("ab", "c"), expected("ab", "c"));
  assert.equal(await specHash("a", "bc"), expected("a", "bc"));
  assert.notEqual(await specHash("ab", "c"), await specHash("a", "bc"));
  assert.notEqual(await specHash("a", "b"), createHash("sha256").update("a\nb").digest("hex"));
  assert.notEqual(await specHash("a", "b"), createHash("sha256").update("ab").digest("hex"));
});

// Extends "[boundary-2]": moving a whole line from the description into the summary.
test("[boundary-2] moving a line from the description to the summary changes the hash", async () => {
  const before = await specHash("Fix the build", "Line one\nLine two");
  const after = await specHash("Fix the build\nLine one", "Line two");
  assert.equal(before, FIX_BUILD);
  assert.equal(after, expected("Fix the build\nLine one", "Line two"));
  assert.notEqual(after, before);
});

// Extends "[boundary-3] a trailing space on the description does not change the hash":
// trailing whitespace on every line, not just the last.
test("[boundary-3] trailing whitespace on inner lines of the description is ignored", async () => {
  assert.equal(await specHash("Fix the build", "Line one   \nLine two\t"), FIX_BUILD);
  assert.equal(await specHash("Fix the build", "\n\n  Line one\t \nLine two  \n\n"), expected("Fix the build", "Line one\nLine two"));
});

// Extends "[boundary-3] spaces around the summary do not change the hash":
// the summary is canonicalised line by line too.
test("[boundary-3] a multi-line summary has its line endings and trailing whitespace canonicalised", async () => {
  assert.equal(await specHash("Fix the build \r\nnow\t", "x"), expected("Fix the build\nnow", "x"));
  assert.equal(await specHash("\n\tAdd login\n\n", "Users can sign in.  \n"), ADD_LOGIN);
});

// Extends "[boundary-3]": leading whitespace is only dropped at the ends of the
// whole text, never at the start of an inner line.
test("[boundary-3] leading whitespace of an inner line is kept", async () => {
  assert.equal(await specHash("Plan", "Steps:\n  one\n\ttwo"), expected("Plan", "Steps:\n  one\n\ttwo"));
  assert.notEqual(await specHash("Plan", "Steps:\n  one\n\ttwo"), await specHash("Plan", "Steps:\none\ntwo"));
});

// Extends "[boundary-4] a lone CR and trailing spaces before a line ending hash the same as LF":
// mixed endings within one text, in the summary as well as the description.
test("[boundary-4] mixed CRLF, CR and LF endings in one text hash the same as LF", async () => {
  assert.equal(await specHash("a\r\nb\rc\nd", "e\rf\r\ng"), expected("a\nb\nc\nd", "e\nf\ng"));
  assert.equal(await specHash("a\nb\nc\nd", "e\nf\ng"), expected("a\nb\nc\nd", "e\nf\ng"));
});

// Extends "[boundary-4] CRLF hashes the same as LF": CR CR LF is two line
// breaks, and LF CR is two line breaks, each making a blank line.
test("[boundary-4] a CR followed by CRLF, and LF followed by CR, each make a blank line", async () => {
  assert.equal(await specHash("t", "a\r\r\nb"), expected("t", "a\n\nb"));
  assert.equal(await specHash("t", "a\n\rb"), expected("t", "a\n\nb"));
  assert.equal(await specHash("t", "a\r\n\r\nb"), expected("t", "a\n\nb"));
});

// Extends "[boundary-5] whitespace inside a line is significant": tabs and
// leading-of-word spacing in the summary too.
test("[boundary-5] tabs and runs of spaces inside a line of either argument are kept", async () => {
  assert.equal(await specHash("Add\tlogin", "Users can sign in."), expected("Add\tlogin", "Users can sign in."));
  assert.equal(await specHash("Add  login", "Users can sign in."), expected("Add  login", "Users can sign in."));
  assert.notEqual(await specHash("Add\tlogin", "Users can sign in."), ADD_LOGIN);
  assert.notEqual(await specHash("Add  login", "Users can sign in."), ADD_LOGIN);
});

// Extends "[boundary-5] a blank line between lines of text is significant":
// the number of blank lines counts, and is kept as given.
test("[boundary-5] several blank lines between lines are each kept", async () => {
  const two = await specHash("Fix the build", "Line one\n\n\nLine two");
  assert.equal(two, expected("Fix the build", "Line one\n\n\nLine two"));
  assert.notEqual(two, await specHash("Fix the build", "Line one\n\nLine two"));
  // A line of only spaces is a blank line once its trailing whitespace goes.
  assert.equal(await specHash("Fix the build", "Line one\n   \nLine two"), expected("Fix the build", "Line one\n\nLine two"));
});

// Extends "[boundary-6] Unicode is hashed as given, without normalisation": in the description.
test("[boundary-6] composed and decomposed forms in the description hash as given", async () => {
  const composed = await specHash("", "naïve");
  const decomposed = await specHash("", "naïve");
  assert.equal(composed, expected("", "naïve"));
  assert.equal(decomposed, expected("", "naïve"));
  assert.notEqual(composed, decomposed);
});

// Extends "[unhappy-1]": other non-string types, for each argument.
for (const [label, summary, description] of [
  ["a boolean summary", true, ""],
  ["an array summary", ["Add login"], ""],
  ["a null summary", null, "Users can sign in."],
  ["an object summary", { summary: "Add login" }, ""],
  ["an undefined description", "Add login", undefined],
  ["a numeric description", "Add login", 0],
  ["an array description", "Add login", ["Users can sign in."]],
  ["a String object description", "Add login", new String("Users can sign in.")],
  ["two non-strings", 1, 2],
] as const) {
  test(`[unhappy-1] ${label} rejects with a TypeError`, async () => {
    await assert.rejects(untypedSpecHash(summary, description), TypeError);
  });
}

// Extends "[concurrency-1] overlapping specHash calls each resolve to their own input's hash":
// more calls, of very different sizes, so they may finish out of order.
test("[concurrency-1] many overlapping calls of different sizes each resolve to their own hash, in order", async () => {
  const inputs: Array<readonly [string, string]> = [];
  for (let i = 0; i < 30; i++) {
    inputs.push([`Summary ${i}`, i % 3 === 0 ? `big ${i} `.repeat(20_000).trimEnd() : `small ${i}`]);
  }
  const results = await Promise.all(inputs.map(([s, d]) => specHash(s, d)));
  assert.deepEqual(results, inputs.map(([s, d]) => expected(s, d)));
});

// Extends "[concurrency-1]": the same input started several times among others.
test("[concurrency-1] overlapping calls with repeated and canonically equal inputs resolve consistently", async () => {
  const results = await Promise.all([
    specHash("Add login", "Users can sign in."),
    specHash("Fix the build", "Line one\r\nLine two"),
    specHash("  Add login  ", "Users can sign in.\n"),
    specHash("", ""),
    specHash("Add login", "Users can sign in."),
  ]);
  assert.deepEqual(results, [ADD_LOGIN, FIX_BUILD, ADD_LOGIN, EMPTY, ADD_LOGIN]);
});

// Extends "[happy-12] the spec exports are reachable from the package entry point":
// the entry-point functions behave as the spec module's do.
test("[happy-12] the entry point's specHash and toIssueSpec give the spec results", async () => {
  const indexPath: string = "../../src/index.js";
  const index = (await import(indexPath)) as Record<string, unknown>;
  const indexHash = index["specHash"] as typeof specHash;
  const indexSpec = index["toIssueSpec"] as typeof toIssueSpec;
  assert.equal(indexHash, specHash);
  assert.equal(indexSpec, toIssueSpec);
  assert.equal(await indexHash("Add login", "Users can sign in."), ADD_LOGIN);
  assert.equal((await indexSpec("ACME-1", { summary: "Fix the build", description: "Line one\nLine two" })).specHash, FIX_BUILD);
  assert.deepEqual([...(index["SPEC_FIELDS"] as string[])], ["summary", "description", "issuetype", "updated"]);
  assert.equal(index["stripTrailingSlashes"], stripTrailingSlashes);
  assert.equal(index["ISSUE_FIELDS"], ISSUE_FIELDS);
});

// Extends "[happy-12]": the entry point's adfToText is the flattener toIssueSpec uses.
test("[happy-12] the entry point's adfToText is adf.ts's and flattens as toIssueSpec does", async () => {
  const indexPath: string = "../../src/index.js";
  const adfPath: string = "../../src/adf.js";
  const index = (await import(indexPath)) as Record<string, unknown>;
  const adf = (await import(adfPath)) as Record<string, unknown>;
  const adfToText = index["adfToText"] as (document: unknown) => string;
  assert.equal(adfToText, adf["adfToText"]);
  const description = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Goal" }] },
      { type: "paragraph", content: [{ type: "text", text: "Ship it" }] },
    ],
  };
  assert.equal(adfToText(description), "### Goal\n\nShip it");
  assert.equal(adfToText(description), (await toIssueSpec("ACME-1", { description })).descriptionText);
});
