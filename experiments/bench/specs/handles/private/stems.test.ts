import assert from "node:assert/strict";
import { test } from "node:test";

import { checkHandle, handleStemFromEmail, toHandleCase, toHandleStem } from "../../src/handle.js";

const ALLOWED = "abcdefghijklmnopqrstuvwxyz0123456789-_";

/** A fixed linear congruential sequence, so generated inputs are the same on every run. */
function fixedSequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

/** Deterministic mixed text: allowed characters, punctuation, whitespace, uppercase and non-ASCII. */
function generatedTexts(count: number): string[] {
  const pieces = ["a", "Z", "9", "-", "_", " ", ".", "@", "\t", "é", "É", "😀", "日", "İ", "K", "--", "__", "Acme"];
  const next = fixedSequence(24);
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = next() % 45;
    let text = "";
    for (let j = 0; j < length; j++) {
      text += pieces[next() % pieces.length];
    }
    texts.push(text);
  }
  return texts;
}

// Rule: toHandleStem derives a handle that always passes checkHandle

// Extends "[happy-7] toHandleStem lowercases and replaces runs of disallowed characters with one hyphen".
test("[happy-7] toHandleStem collapses runs of mixed disallowed characters, including whitespace and emoji", () => {
  const cases: Array<[string, string]> = [
    ["Hello,   World!!!", "hello-world"],
    ["Mixed CASE 123", "mixed-case-123"],
    ["a\t\n\r b", "a-b"],
    ["dana (work) rivers", "dana-work-rivers"],
    ["😀 smile 😀", "smile"],
    ["a😀b", "a-b"],
    ["one/two\\three", "one-two-three"],
  ];
  for (const [text, stem] of cases) {
    assert.equal(toHandleStem(text), stem, JSON.stringify(text));
  }
});

// Extends "[happy-7] toHandleStem keeps existing hyphens and underscores, strips only outer hyphens, and drops non-ASCII":
// an existing hyphen splits a disallowed run in two, and both halves become their own hyphen.
test("[happy-7] toHandleStem keeps existing hyphens between replaced runs instead of merging them", () => {
  const cases: Array<[string, string]> = [
    ["a - b", "a---b"],
    ["a- b", "a--b"],
    ["a.-.b", "a---b"],
    ["a_.b", "a_-b"],
    ["a._b", "a-_b"],
    ["_-a-_", "_-a-_"],
    ["__dana__", "__dana__"],
    [". _dana_ .", "_dana_"],
  ];
  for (const [text, stem] of cases) {
    assert.equal(toHandleStem(text), stem, JSON.stringify(text));
  }
});

// Extends "[happy-7] toHandleStem lowercases and replaces runs of disallowed characters with one hyphen":
// every disallowed ASCII character becomes a hyphen and every uppercase letter is lowercased.
test("[happy-7] toHandleStem replaces each disallowed ASCII character with a hyphen and lowercases A-Z", () => {
  for (let code = 0; code < 128; code++) {
    const char = String.fromCharCode(code);
    const label = `U+${code.toString(16)}`;
    if (ALLOWED.includes(char)) {
      assert.equal(toHandleStem(`ab${char}cd`), `ab${char}cd`, label);
    } else if (char >= "A" && char <= "Z") {
      assert.equal(toHandleStem(`ab${char}cd`), `ab${char.toLowerCase()}cd`, label);
    } else {
      assert.equal(toHandleStem(`ab${char}cd`), "ab-cd", label);
    }
  }
});

// Extends "[happy-7] toHandleStem keeps existing hyphens and underscores, strips only outer hyphens, and drops non-ASCII":
// the text is lowercased before characters are replaced.
test("[happy-7] toHandleStem lowercases before replacing, so a Kelvin sign becomes k and a dotted I leaves a hyphen", () => {
  assert.equal("K".toLowerCase(), "k");
  assert.equal(toHandleStem("Kelvin Corp"), "kelvin-corp");
  assert.equal("İ".toLowerCase(), "i̇");
  assert.equal(toHandleStem("İstanbul"), "i-stanbul");
});

// Extends "[boundary-6] toHandleStem pads stems shorter than 3 characters with -user":
// padding is decided after stripping, and underscores count towards the length.
test("[boundary-6] toHandleStem pads 1- and 2-character stems left after stripping, underscores included", () => {
  const cases: Array<[string, string]> = [
    ["-ab-", "ab-user"],
    [".ab.", "ab-user"],
    ["--ab", "ab-user"],
    ["a.", "a-user"],
    ["A", "a-user"],
    ["_", "_-user"],
    ["__", "__-user"],
    ["  Jo  ", "jo-user"],
    ["É9", "9-user"],
    ["a😀", "a-user"],
  ];
  for (const [text, stem] of cases) {
    assert.equal(toHandleStem(text), stem, JSON.stringify(text));
  }
});

// Extends "[boundary-6] toHandleStem returns -user when nothing usable remains":
// 3-character stems, including ones built from a replaced run, are not padded.
test("[boundary-6] toHandleStem does not pad stems of exactly 3 characters and returns -user for empty stems", () => {
  const cases: Array<[string, string]> = [
    ["a b", "a-b"],
    ["a   b", "a-b"],
    ["___", "___"],
    ["-a_b-", "a_b"],
    ["--", "-user"],
    ["   ", "-user"],
    ["😀", "-user"],
    [".-.-.", "-user"],
    ["Ééé", "-user"],
  ];
  for (const [text, stem] of cases) {
    assert.equal(toHandleStem(text), stem, JSON.stringify(text));
  }
});

// Extends "[boundary-7] toHandleStem keeps the first 30 characters of a long stem":
// other lengths and characters.
test("[boundary-7] toHandleStem keeps 31-, 29- and 1000-character stems to at most 30 characters", () => {
  assert.equal(toHandleStem("x".repeat(31)), "x".repeat(30));
  assert.equal(toHandleStem("x".repeat(29)), "x".repeat(29));
  assert.equal(toHandleStem("Ab".repeat(500)), "ab".repeat(15));
  assert.equal(toHandleStem("_".repeat(40)), "_".repeat(30));
  assert.equal(toHandleStem("0123456789".repeat(4)), "012345678901234567890123456789");
});

// Extends "[boundary-7] toHandleStem strips hyphens before cutting and may leave a trailing hyphen":
// runs are collapsed and outer hyphens stripped before the cut, and the cut is never followed by another strip.
test("[boundary-7] toHandleStem collapses and strips before the cut, and keeps hyphens the cut leaves at the end", () => {
  assert.equal(toHandleStem(`a${".".repeat(100)}${"b".repeat(40)}`), `a-${"b".repeat(28)}`);
  assert.equal(toHandleStem(`${"-".repeat(3)}${"a".repeat(40)}`), "a".repeat(30));
  assert.equal(toHandleStem(`${".".repeat(50)}${"a".repeat(40)}`), "a".repeat(30));
  assert.equal(toHandleStem(`${"x".repeat(28)}---y`), `${"x".repeat(28)}--`);
  assert.equal(toHandleStem(`${"x".repeat(29)}-y`), `${"x".repeat(29)}-`);
  assert.equal(toHandleStem(`${"x".repeat(29)}${"é".repeat(10)}yyy`), `${"x".repeat(29)}-`);
  assert.equal(toHandleStem(`${"x".repeat(28)}${"-".repeat(20)}`), "x".repeat(28));
  assert.equal(toHandleStem(`${"x".repeat(25)} Acme Corp`), `${"x".repeat(25)}-acme`);
});

// Extends "[boundary-8] toHandleStem returns -user for 100000 hyphens":
// long runs on both sides, in the middle, and alternating with disallowed characters.
test("[boundary-8] toHandleStem handles 100000-character runs on both sides of, and between, usable characters", () => {
  const run = "-".repeat(100000);
  assert.equal(toHandleStem(`${run}a${run}`), "a-user");
  assert.equal(toHandleStem(`${run}abc${run}`), "abc");
  assert.equal(toHandleStem(`a${run}b`), `a${"-".repeat(29)}`);
  assert.equal(toHandleStem(`a${".".repeat(100000)}b`), "a-b");
  assert.equal(toHandleStem(".-".repeat(50000)), "-user");
  assert.equal(toHandleStem(`ab${" -".repeat(50000)}`), "ab-user");
});

// Extends "[boundary-8] toHandleStem strips a 100000-hyphen prefix and collapses a 100000-character disallowed run":
// a large input made of many short runs.
test("[boundary-8] toHandleStem handles 100000 alternating usable and disallowed characters", () => {
  assert.equal(toHandleStem("a.".repeat(100000)), "a-".repeat(15));
  assert.equal(toHandleStem(`${"-".repeat(200000)}`), "-user");
});

// Extends both "[boundary-9]" public tests: many more inputs, generated from a fixed sequence.
test("[boundary-9] stems from 500 generated texts all pass checkHandle and are unchanged by toHandleCase", () => {
  for (const text of generatedTexts(500)) {
    const stem = toHandleStem(text);
    assert.deepEqual(checkHandle(stem), { status: "ok" }, JSON.stringify(text));
    assert.equal(toHandleCase(stem), stem, JSON.stringify(text));
  }
});

// Extends "[boundary-9] stems from cut, all-hyphen and non-ASCII text pass checkHandle and are unchanged by toHandleCase".
test("[boundary-9] stems from underscore, whitespace, uppercase non-ASCII and long text pass checkHandle", () => {
  for (const text of [
    "_",
    "\t\n",
    "İİ",
    "K",
    "ÉCOLE",
    "😀".repeat(40),
    `${"x".repeat(28)}---y`,
    "Acme, Inc. — The Best Company In The Whole Wide World",
  ]) {
    const stem = toHandleStem(text);
    assert.deepEqual(checkHandle(stem), { status: "ok" }, JSON.stringify(text));
    assert.equal(toHandleCase(stem), stem, JSON.stringify(text));
  }
});

// Rule: handleStemFromEmail applies toHandleStem to the local part of the address

// Extends "[happy-8] handleStemFromEmail derives the stem from the local part": other domains and local parts.
test("[happy-8] handleStemFromEmail ignores any domain and keeps underscores and digits of the local part", () => {
  const cases: Array<[string, string]> = [
    ["dana@acme.io", "dana"],
    ["first_last@mail.example.org", "first_last"],
    ["Dana.Rivers@EXAMPLE.TEST", "dana-rivers"],
    ["a.b.c@x", "a-b-c"],
    ["user123+tag@sub.domain.co.uk", "user123-tag"],
    ["abc@this-domain-is-very-long-and-has-many-parts.example", "abc"],
  ];
  for (const [email, stem] of cases) {
    assert.equal(handleStemFromEmail(email), stem, email);
  }
});

// Extends "[happy-8] handleStemFromEmail pads a two-character local part with -user".
test("[happy-8] handleStemFromEmail pads one- and two-character local parts and leaves three alone", () => {
  assert.equal(handleStemFromEmail("QA@acme.io"), "qa-user");
  assert.equal(handleStemFromEmail("x@acme.io"), "x-user");
  assert.equal(handleStemFromEmail("-q-@acme.io"), "q-user");
  assert.equal(handleStemFromEmail("abc@acme.io"), "abc");
});

// Extends "[boundary-10] handleStemFromEmail uses the whole string without @, splits on the first @, and cuts to 30".
test("[boundary-10] handleStemFromEmail splits only on the first of several @ and treats a full-width @ as text", () => {
  assert.equal(handleStemFromEmail("ab@cd@ef"), "ab-user");
  assert.equal(handleStemFromEmail("dana@rivers@acme.io"), "dana");
  assert.equal(handleStemFromEmail("x@"), "x-user");
  assert.equal(handleStemFromEmail("@@"), "-user");
  assert.equal(handleStemFromEmail("@"), "-user");
  assert.equal(handleStemFromEmail("dana＠example.test"), "dana-example-test");
});

// Extends "[boundary-10] handleStemFromEmail returns -user for an empty or all-hyphen local part".
test("[boundary-10] handleStemFromEmail handles whitespace, punctuation-only and long local parts", () => {
  assert.equal(handleStemFromEmail("   @acme.io"), "-user");
  assert.equal(handleStemFromEmail("...@acme.io"), "-user");
  assert.equal(handleStemFromEmail(" Dana Rivers @acme.io"), "dana-rivers");
  assert.equal(handleStemFromEmail("Rivers.Dana"), "rivers-dana");
  assert.equal(handleStemFromEmail(`${"x".repeat(29)}.y@acme.io`), `${"x".repeat(29)}-`);
  assert.equal(handleStemFromEmail(`${"Ab".repeat(30)}`), "ab".repeat(15));
  assert.equal(handleStemFromEmail(`${"-".repeat(100000)}@acme.io`), "-user");
});

// Extends "[boundary-11] handleStemFromEmail equals toHandleStem of the text before the first @, or of the whole string".
test("[boundary-11] handleStemFromEmail equals toHandleStem of the local part for many addresses", () => {
  const cases: Array<[string, string]> = [
    ["Dana.Rivers+Work@Acme.IO", "Dana.Rivers+Work"],
    ["@acme.io", ""],
    ["jo@acme.io", "jo"],
    ["a@b@c", "a"],
    ["no at sign at all", "no at sign at all"],
    [`${"x".repeat(60)}@acme.io`, "x".repeat(60)],
    ["Zoë.Café@acme.io", "Zoë.Café"],
  ];
  for (const [email, local] of cases) {
    assert.equal(handleStemFromEmail(email), toHandleStem(local), email);
  }
  assert.equal(handleStemFromEmail("Zoë.Café@acme.io"), "zo-caf");
});

// Extends "[boundary-11] handleStemFromEmail equals toHandleStem of the local part": generated local parts.
test("[boundary-11] handleStemFromEmail equals toHandleStem of the local part for 200 generated addresses", () => {
  for (const text of generatedTexts(200)) {
    const at = text.indexOf("@");
    const local = at === -1 ? text : text.slice(0, at);
    assert.equal(handleStemFromEmail(`${text}@acme.io`), toHandleStem(local), JSON.stringify(text));
    assert.equal(handleStemFromEmail(text), toHandleStem(local), JSON.stringify(text));
  }
});
