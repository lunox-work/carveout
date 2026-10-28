import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTEXT_DOCUMENT_BYTES_MAX,
  CONTEXT_DOCUMENT_CHARS,
  CONTEXT_DOCUMENTS_MAX,
  CONTEXT_SOURCES,
  CONTEXT_TOTAL_CHARS,
  NO_CONTEXT,
  contextDocuments,
  contextDrift,
  keptDocuments,
} from "../../src/sources.js";

// Extends "[happy-1] the sources and caps have their declared values".
test("[happy-1] the declared caps are the ones contextDocuments and keptDocuments apply", () => {
  assert.equal(CONTEXT_DOCUMENTS_MAX, 12);
  assert.equal(CONTEXT_DOCUMENT_BYTES_MAX, 262144);
  assert.equal(CONTEXT_DOCUMENT_CHARS, 12000);
  assert.equal(CONTEXT_TOTAL_CHARS, 48000);

  const many = Array.from({ length: CONTEXT_DOCUMENTS_MAX + 3 }, (_, index) => ({
    path: `docs/n${String(index).padStart(2, "0")}.md`,
    size: 100,
  }));
  const listed = contextDocuments(many);
  assert.equal(listed.paths.length, 12);
  assert.equal(listed.omitted, 3);

  assert.deepEqual(
    contextDocuments([
      { path: "docs/at.md", size: 262144 },
      { path: "docs/over.md", size: 262145 },
    ]),
    { paths: ["docs/at.md"], omitted: 0 },
  );

  const one = keptDocuments([
    { path: "a.md", bytes: 1, text: "a".repeat(CONTEXT_DOCUMENT_CHARS + 1) },
  ]);
  assert.equal(one.documents[0]!.text.length, 12000);

  const total = keptDocuments(
    Array.from({ length: 10 }, (_, index) => ({
      path: `d${index}.md`,
      bytes: 1,
      text: "b".repeat(10000),
    })),
  );
  assert.equal(
    total.documents.reduce((sum, document) => sum + document.text.length, 0),
    48000,
  );
});

// Extends "[happy-1] the byte cap is exactly 256 KiB and the total holds four whole documents".
test("[happy-1] CONTEXT_SOURCES lists jira then github, the sources contextDrift answers for", () => {
  assert.deepEqual([...CONTEXT_SOURCES], ["jira", "github"]);
  const drift = contextDrift({ jira: 2, github: 2 }, { jira: 1, github: 1 });
  assert.deepEqual(Object.keys(drift).sort(), [...CONTEXT_SOURCES].sort());
  for (const source of CONTEXT_SOURCES) {
    assert.deepEqual(drift[source], { uses: 1, current: 2 }, source);
  }
});

// Extends "[happy-2] NO_CONTEXT names no version of either source".
test("[happy-2] NO_CONTEXT holds no version: an overview at it puts nothing behind, a step at it is behind every held version", () => {
  assert.deepEqual(NO_CONTEXT, { jira: null, github: null });
  assert.deepEqual(contextDrift(NO_CONTEXT, { jira: 9, github: 0 }), {
    jira: null,
    github: null,
  });
  assert.deepEqual(contextDrift({ jira: 0, github: 6 }, NO_CONTEXT), {
    jira: { uses: null, current: 0 },
    github: { uses: null, current: 6 },
  });
  assert.deepEqual(NO_CONTEXT, { jira: null, github: null });
});
