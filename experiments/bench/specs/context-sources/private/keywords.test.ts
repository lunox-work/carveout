import assert from "node:assert/strict";
import { test } from "node:test";

import { contextKeywords } from "../../src/sources.js";

// Extends "[happy-3] titles become keywords".
test("[happy-3] tabs, newlines, brackets and dots separate words, and letters mixed with digits stay one word", () => {
  assert.deepEqual(
    contextKeywords("OAuth2 callback\tfails\non iOS 17.4 (prod-eu) [v10beta]"),
    ["oauth2", "callback", "fails", "prod", "v10beta"],
  );
});

// Extends "[happy-3] titles become keywords".
test("[happy-3] the title is lower-cased before it is split", () => {
  // U+212A KELVIN SIGN lower-cases to the ASCII letter "k".
  assert.deepEqual(contextKeywords("Kelvin SCALE"), ["kelvin", "scale"]);
});

// Extends "[happy-3] keywords have no cap and the returned list is a new array".
test("[happy-3] a long title with repeats keeps every word once, in first-seen order", () => {
  const words = Array.from(
    { length: 150 },
    (_, index) => `term${String(index).padStart(3, "0")}`,
  );
  const title = [
    ...words,
    ...[...words].reverse().map((word) => word.toUpperCase()),
    "ab",
    "abc",
  ].join(", ");
  assert.deepEqual(contextKeywords(title), words);
});

// Extends "[boundary-1] short words and repeats are dropped".
test("[boundary-1] four characters are kept and three are not, wherever they stand", () => {
  assert.deepEqual(contextKeywords("abcd x abc y 1234 zz 123 wxyz"), [
    "abcd",
    "1234",
    "wxyz",
  ]);
  assert.deepEqual(contextKeywords("User's can't won't settings"), [
    "user",
    "settings",
  ]);
});

// Extends "[boundary-1] a repeat keeps its first-seen position and digit-only words count".
test("[boundary-1] repeats differing in case or separator collapse to the first", () => {
  assert.deepEqual(contextKeywords("Deploy-deploy_DEPLOY/deploy.deploy"), [
    "deploy",
  ]);
  assert.deepEqual(contextKeywords("Login, login; logout LOGIN 0042 0042"), [
    "login",
    "logout",
    "0042",
  ]);
});

// Extends "[boundary-1] short words and repeats are dropped".
test("[boundary-1] titles of short words, separators or non-ASCII letters give no keywords", () => {
  for (const title of ["ab cd ef", "日本語のタイトル", "\t\n\r", "ééééé", "a-b-c-d"]) {
    assert.deepEqual(contextKeywords(title), [], JSON.stringify(title));
  }
});
