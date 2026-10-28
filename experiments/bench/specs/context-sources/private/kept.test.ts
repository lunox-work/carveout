import assert from "node:assert/strict";
import { test } from "node:test";

import { keptDocuments } from "../../src/sources.js";

/** Documents named "d1.md", "d2.md"… whose texts are that many "a" characters. */
function ofLengths(lengths: readonly number[]) {
  return lengths.map((length, index) => ({
    path: `d${index + 1}.md`,
    bytes: length,
    text: "a".repeat(length),
  }));
}

// Extends "[happy-7] a short document is kept with its line endings normalized and its ends trimmed".
test("[happy-7] mixed line endings become newlines and only the ends are trimmed", () => {
  assert.deepEqual(
    keptDocuments([
      {
        path: "docs/guide.md",
        bytes: 77,
        text: "\r\n\r\n  Title\r\r\nBody line\r\n\r\nEnd  \t\r\n",
      },
    ]),
    {
      documents: [
        {
          path: "docs/guide.md",
          bytes: 77,
          text: "Title\n\nBody line\n\nEnd",
          truncated: false,
        },
      ],
      omitted: 0,
    },
  );
});

// Extends "[happy-7] two lone carriage returns become two newlines, inner spaces stay and bytes pass through".
test("[happy-7] several documents are each normalized, with path and bytes passed through even when they disagree with the text", () => {
  assert.deepEqual(
    keptDocuments([
      { path: "README.md", bytes: 0, text: "x\r\ny" },
      { path: "docs/Ünï code.md", bytes: 123456789, text: " \r z \r" },
      { path: "./a.md", bytes: -5, text: "\n\n# A\r\n\r\n" },
    ]),
    {
      documents: [
        { path: "README.md", bytes: 0, text: "x\ny", truncated: false },
        { path: "docs/Ünï code.md", bytes: 123456789, text: "z", truncated: false },
        { path: "./a.md", bytes: -5, text: "# A", truncated: false },
      ],
      omitted: 0,
    },
  );
});

// Extends "[boundary-8] the cap measures the normalized, trimmed text in UTF-16 code units".
test("[boundary-8] the cut keeps the first 12000 code units of the trimmed text and does not trim again", () => {
  const spaced = `${"a".repeat(11999)} ${"b".repeat(50)}`;
  const first = keptDocuments([{ path: "a.md", bytes: 1, text: spaced }]);
  assert.equal(first.documents[0]!.text, `${"a".repeat(11999)} `);
  assert.equal(first.documents[0]!.truncated, true);

  const split = `x${"😀".repeat(6000)}`;
  const second = keptDocuments([{ path: "b.md", bytes: 1, text: split }]);
  assert.equal(second.documents[0]!.text.length, 12000);
  assert.equal(second.documents[0]!.text, split.slice(0, 12000));
  assert.equal(second.documents[0]!.truncated, true);
});

// Extends "[boundary-8] the per-document cap".
test("[boundary-8] each of several documents is cut to the per-document cap on its own", () => {
  const texts = [
    "p".repeat(12001),
    "short",
    "q".repeat(11000),
    `${"r".repeat(12000)}tail`,
    `\r\n${"s".repeat(11999)}\r\n`,
  ];
  const result = keptDocuments(
    texts.map((text, index) => ({ path: `d${index}.md`, bytes: 1, text })),
  );
  assert.deepEqual(
    result.documents.map((document) => document.text),
    ["p".repeat(12000), "short", "q".repeat(11000), "r".repeat(12000), "s".repeat(11999)],
  );
  assert.deepEqual(
    result.documents.map((document) => document.truncated),
    [true, false, false, true, false],
  );
  assert.equal(result.omitted, 0);
});

// Extends "[boundary-9] the total cap cuts the document that reaches it and omits the rest".
test("[boundary-9] a document that fits the room left is kept whole, the next is cut to what remains", () => {
  const result = keptDocuments(ofLengths([12000, 12000, 12000, 11500, 400, 200, 1]));
  assert.deepEqual(
    result.documents.map((document) => [document.path, document.text.length]),
    [
      ["d1.md", 12000],
      ["d2.md", 12000],
      ["d3.md", 12000],
      ["d4.md", 11500],
      ["d5.md", 400],
      ["d6.md", 100],
    ],
  );
  assert.deepEqual(
    result.documents.map((document) => document.truncated),
    [false, false, false, false, false, true],
  );
  assert.equal(result.omitted, 1);
});

// Extends "[boundary-9] a blank document takes no room, and each one met after the room is used up is omitted".
test("[boundary-9] the room is used by the kept trimmed text, not by the raw text or the bytes", () => {
  const padded = Array.from({ length: 4 }, (_, index) => ({
    path: `p${index}.md`,
    bytes: 999999,
    text: `  ${"a".repeat(11990)}\r\n\r\n`,
  }));
  const result = keptDocuments([
    ...padded,
    { path: "last.md", bytes: 1, text: "b".repeat(100) },
  ]);
  assert.deepEqual(
    result.documents.map((document) => document.text.length),
    [11990, 11990, 11990, 11990, 40],
  );
  assert.equal(result.documents[4]!.text, "b".repeat(40));
  assert.deepEqual(
    result.documents.map((document) => document.truncated),
    [false, false, false, false, true],
  );
  assert.equal(result.omitted, 0);
});

// Extends "[boundary-9] the total cap cuts the document that reaches it and omits the rest".
test("[boundary-9] documents that exactly fill the total are kept whole, and every later one is omitted", () => {
  const result = keptDocuments([
    ...ofLengths([9600, 9600, 9600, 9600, 9600]),
    { path: "x.md", bytes: 1, text: "x" },
    { path: "blank.md", bytes: 1, text: "  " },
    { path: "y.md", bytes: 1, text: "y".repeat(20000) },
  ]);
  assert.deepEqual(
    result.documents.map((document) => [document.text.length, document.truncated]),
    [
      [9600, false],
      [9600, false],
      [9600, false],
      [9600, false],
      [9600, false],
    ],
  );
  assert.equal(result.omitted, 3);
});

// Extends "[boundary-10] more than CONTEXT_DOCUMENTS_MAX documents are all kept".
test("[boundary-10] a hundred short documents are all kept in the order given", () => {
  const documents = Array.from({ length: 100 }, (_, index) => ({
    path: `n${100 - index}.md`,
    bytes: 7,
    text: `doc ${index + 1}`,
  }));
  const result = keptDocuments(documents);
  assert.deepEqual(
    result.documents,
    documents.map((document) => ({ ...document, truncated: false })),
  );
  assert.equal(result.omitted, 0);
});

// Extends "[unhappy-3] blank documents are dropped and counted".
test("[unhappy-3] blank documents anywhere in the list are dropped and counted, whatever their bytes", () => {
  assert.deepEqual(
    keptDocuments([
      { path: "a.md", bytes: 5000, text: "\r" },
      { path: "b.md", bytes: 1, text: "a" },
      { path: "c.md", bytes: 4, text: "  \t " },
      { path: "d.md", bytes: 1, text: "b" },
      { path: "e.md", bytes: 3, text: "\n\r\n" },
      { path: "f.md", bytes: 0, text: "" },
    ]),
    {
      documents: [
        { path: "b.md", bytes: 1, text: "a", truncated: false },
        { path: "d.md", bytes: 1, text: "b", truncated: false },
      ],
      omitted: 4,
    },
  );
});

// Extends "[unhappy-4] keptDocuments with no documents".
test("[unhappy-4] no documents gives a new empty list on every call, from a frozen input", () => {
  const input = Object.freeze([]) as readonly {
    path: string;
    bytes: number;
    text: string;
  }[];
  const first = keptDocuments(input);
  assert.equal(first.documents.length, 0);
  assert.equal(first.omitted, 0);
  first.documents.push({ path: "x.md", bytes: 1, text: "x", truncated: false });
  assert.deepEqual(keptDocuments(input), { documents: [], omitted: 0 });
});
