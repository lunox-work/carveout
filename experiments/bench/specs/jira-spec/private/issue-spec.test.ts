import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { SPEC_FIELDS, specHash, toIssueSpec } from "../../src/spec.js";

type Fields = Parameters<typeof toIssueSpec>[1];

/** specHash("Add login", "Users can sign in.") */
const ADD_LOGIN = "24b1c29d416fdea96e63dcd8edf3ccbc14c9e53a0f019720cefd4803fcec0bf5";
/** specHash("Fix the build", "Line one\nLine two") */
const FIX_BUILD = "401c829e08ad2a5a6a3cb4a6913afd15a8f35a9ceb9ddeb48a714539e0b50fa7";
/** specHash("", "") */
const EMPTY = "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d";

const SPEC_KEYS = ["key", "summary", "descriptionText", "issueType", "updated", "specHash"];

/** sha256hex of already-canonical summary and description, joined by NUL. */
function expected(canonSummary: string, canonDescription: string): string {
  return createHash("sha256").update(`${canonSummary}\u0000${canonDescription}`, "utf8").digest("hex");
}

/** A paragraph of one text node. */
function para(value: string): unknown {
  return { type: "paragraph", content: [{ type: "text", text: value }] };
}

/** A doc whose content is these nodes. */
function doc(...content: unknown[]): unknown {
  return { type: "doc", version: 1, content };
}

/** Freezes a value and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

// Extends "[happy-1] fields outside SPEC_FIELDS are not read": members outside
// SPEC_FIELDS that throw when read must never be touched.
test("[happy-1] toIssueSpec never reads a member outside SPEC_FIELDS", async () => {
  const fields = {
    summary: "Add login",
    description: "Users can sign in.",
    issuetype: { name: "Story" },
    updated: "2026-10-20T09:15:00.000+0000",
  };
  for (const name of ["status", "assignee", "labels", "created", "project"]) {
    Object.defineProperty(fields, name, {
      enumerable: true,
      get() {
        throw new Error(`${name} was read`);
      },
    });
  }
  const spec = await toIssueSpec("ACME-1", fields as Fields);
  assert.equal(spec.specHash, ADD_LOGIN);
  assert.equal(spec.issueType, "Story");
});

// Extends "[happy-1]": each field in SPEC_FIELDS is read and reaches the result.
test("[happy-1] every SPEC_FIELDS member is read by toIssueSpec", async () => {
  const read = new Set<string | symbol>();
  const fields = new Proxy(
    {
      summary: "Add login",
      description: "Users can sign in.",
      issuetype: { name: "Story" },
      updated: "2026-10-20T09:15:00.000+0000",
    },
    {
      get(target, property, receiver) {
        read.add(property);
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const spec = await toIssueSpec("ACME-1", fields);
  assert.equal(spec.updated, "2026-10-20T09:15:00.000+0000");
  for (const name of SPEC_FIELDS) {
    assert.ok(read.has(name), `${name} is read`);
  }
});

// Extends "[happy-6] a complete v3 issue becomes a spec": another complete
// issue, with a multi-block ADF description, so fixed outputs do not pass.
test("[happy-6] another complete v3 issue becomes its own spec", async () => {
  const spec = await toIssueSpec("OPS-4521", {
    summary: "Rotate the signing keys",
    description: doc(
      para("Keys expire on Friday."),
      { type: "bulletList", content: [{ type: "listItem", content: [para("staging")] }, { type: "listItem", content: [para("production")] }] },
    ),
    issuetype: { name: "Bug" },
    updated: "2026-10-24T17:00:00.000+0000",
  });
  const descriptionText = "Keys expire on Friday.\n\n- staging\n\n- production";
  assert.deepEqual(spec, {
    key: "OPS-4521",
    summary: "Rotate the signing keys",
    descriptionText,
    issueType: "Bug",
    updated: "2026-10-24T17:00:00.000+0000",
    specHash: expected("Rotate the signing keys", descriptionText),
  });
  assert.deepEqual(Object.keys(spec).sort(), [...SPEC_KEYS].sort());
});

// Extends "[happy-6] specHash equals specHash of the result's summary and descriptionText":
// for summaries and descriptions whose canonical form differs from the raw one.
test("[happy-6] specHash is the hash of the canonical summary and descriptionText", async () => {
  for (const fields of [
    { summary: "  Fix the build \r\n", description: "Line one\nLine two" },
    { summary: "Plan", description: doc(para("  indented"), para("next")) },
    { summary: "Tabs\there", description: "a \t b" },
    { summary: 7, description: doc({ type: "codeBlock", content: [{ type: "text", text: "npm test" }] }) },
  ] as Fields[]) {
    const spec = await toIssueSpec("ACME-1", fields);
    assert.equal(spec.specHash, await specHash(spec.summary, spec.descriptionText));
  }
  const padded = await toIssueSpec("ACME-1", { summary: "  Fix the build \r\n", description: "Line one\nLine two" });
  assert.equal(padded.specHash, FIX_BUILD);
  const indented = await toIssueSpec("ACME-1", { summary: "Plan", description: doc(para("  indented"), para("next")) });
  assert.equal(indented.specHash, expected("Plan", "indented\n\nnext"));
});

// Extends "[happy-6] the result has exactly the six keys": also for an all-defaults result.
test("[happy-6] the result has exactly the six own keys for sparse and malformed fields too", async () => {
  for (const fields of [{}, { summary: null, issuetype: null }, { description: doc(para("a")), extra: 1 }] as Fields[]) {
    const spec = await toIssueSpec("ACME-1", fields);
    assert.deepEqual(Object.keys(spec).sort(), [...SPEC_KEYS].sort());
  }
});

// Extends "[happy-7] the key is passed through verbatim": other shapes of key.
test("[happy-7] keys of any shape are passed through verbatim", async () => {
  for (const key of ["ACME-123", "10042", "ops-1/../2", "KEY WITH SPACES", "Ü-1 \u{1F680}", "x".repeat(500)]) {
    assert.equal((await toIssueSpec(key, { summary: "x" })).key, key);
  }
});

// Extends "[happy-7]": the key is not part of the hash.
test("[happy-7] different keys with the same spec share a specHash", async () => {
  const a = await toIssueSpec("ACME-1", { summary: "Add login", description: "Users can sign in." });
  const b = await toIssueSpec("OTHER-999", { summary: "Add login", description: "Users can sign in." });
  assert.equal(a.key, "ACME-1");
  assert.equal(b.key, "OTHER-999");
  assert.equal(a.specHash, ADD_LOGIN);
  assert.equal(b.specHash, ADD_LOGIN);
});

// Extends "[happy-8] an ADF description in the input is not modified": a deeply
// frozen block with nested lists and a table, so any write throws.
test("[happy-8] a deeply frozen fields block with a rich ADF description is read without being written", async () => {
  const make = () => ({
    summary: "  Add login  ",
    description: doc(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal   " }] },
      { type: "bulletList", content: [{ type: "listItem", content: [para("a  "), para("b")] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [para(" c ")] }] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "d" }] }] },
    ),
    issuetype: { name: "Story" },
    updated: "2026-10-20T09:15:00.000+0000",
  });
  const fields = deepFreeze(make());
  const spec = await toIssueSpec("ACME-1", fields);
  assert.equal(spec.descriptionText, "## Goal\n\n- a\n\n  b\n\n| c |\n\n- [x] d");
  assert.deepEqual(fields, make());
});

// Extends "[happy-8] the input fields object is not modified": a string
// description that toIssueSpec collapses is left as it was in the input.
test("[happy-8] a string description that gets collapsed is left as given in the input", async () => {
  const fields = { summary: "Add login", description: "  Users \t can\r\nsign in.  " };
  const spec = await toIssueSpec("ACME-1", fields);
  assert.equal(spec.descriptionText, "Users can \nsign in.");
  assert.deepEqual(fields, { summary: "Add login", description: "  Users \t can\r\nsign in.  " });
  assert.deepEqual(Object.keys(fields), ["summary", "description"]);
});

// Extends "[happy-9] issue type and updated stamp do not affect the hash":
// with an ADF description and other issue types and stamps.
test("[happy-9] issue type and updated stamp do not affect the hash of an ADF description", async () => {
  const description = doc(para("Line one"), para("Line two"));
  const hash = expected("Fix the build", "Line one\n\nLine two");
  for (const [issuetype, updated] of [
    [{ name: "Epic" }, "2020-01-01T00:00:00.000+0000"],
    [{ name: "Sub-task" }, null],
    [undefined, 1729415700000],
    [{ name: 3 }, "not a date"],
  ] as const) {
    const spec = await toIssueSpec("ACME-1", { summary: "Fix the build", description, issuetype, updated } as Fields);
    assert.equal(spec.specHash, hash);
  }
});

// Extends "[happy-10] a plain-string description keeps its words and newlines":
// more lines, non-ASCII text, and the hash of the result.
test("[happy-10] a multi-line, non-ASCII plain-string description keeps its words and newlines", async () => {
  const description = "Étape un\nÉtape deux\n\nÉtape trois \u{1F642}";
  const spec = await toIssueSpec("ACME-1", { summary: "Plan", description });
  assert.equal(spec.descriptionText, description);
  assert.equal(spec.specHash, expected("Plan", description));
});

// Extends "[boundary-7]": other non-string summaries.
for (const [label, summary] of [
  ["true", true],
  ["an object", { text: "Add login" }],
  ["a String object", new String("Add login")],
  ["0", 0],
] as const) {
  test(`[boundary-7] a summary of ${label} becomes empty`, async () => {
    const spec = await toIssueSpec("ACME-1", { summary, description: "Users can sign in." });
    assert.equal(spec.summary, "");
    assert.equal(spec.specHash, expected("", "Users can sign in."));
  });
}

// Extends "[boundary-7] a string summary is kept verbatim, surrounding spaces included":
// inner tabs, CRLF and trailing newlines are kept too, while the hash ignores them.
test("[boundary-7] a multi-line summary is kept verbatim while the hash canonicalises it", async () => {
  const summary = "\tFix the build \r\nnow  \n";
  const spec = await toIssueSpec("ACME-1", { summary, description: "x" });
  assert.equal(spec.summary, summary);
  assert.equal(spec.specHash, expected("Fix the build\nnow", "x"));
});

// Extends "[boundary-7]": the summary never takes toIssueDto's placeholder.
test("[boundary-7] a missing summary is empty, not a placeholder, and hashes as empty", async () => {
  const spec = await toIssueSpec("ACME-1", { description: "Users can sign in." });
  assert.equal(spec.summary, "");
  assert.equal(spec.specHash, expected("", "Users can sign in."));
});

// Extends "[boundary-8]": other issuetype values.
for (const [label, issuetype, issueType] of [
  ["a padded name", { name: "  Story " }, "  Story "],
  ["a non-ASCII name", { name: "Fehler" }, "Fehler"],
  ["a boolean name", { name: true }, "Task"],
  ["an object name", { name: { value: "Bug" } }, "Task"],
  ["an array name", { name: ["Bug"] }, "Task"],
  ["a string issuetype", "Bug", "Task"],
  ["a numeric issuetype", 3, "Task"],
  ["an array issuetype", ["Bug"], "Task"],
  ["an issuetype with other members only", { id: "10001", iconUrl: "x" }, "Task"],
] as const) {
  test(`[boundary-8] an issuetype of ${label} gives ${JSON.stringify(issueType)}`, async () => {
    const spec = await toIssueSpec("ACME-1", { issuetype } as Fields);
    assert.equal(spec.issueType, issueType);
  });
}

// Extends "[boundary-9]": other updated values.
for (const [label, updated, result] of [
  ["a padded string", "  2026-10-20  ", "  2026-10-20  "],
  ["an ISO string with a Z offset", "2026-10-20T09:15:00Z", "2026-10-20T09:15:00Z"],
  ["a Date", new Date(0), null],
  ["true", true, null],
  ["0", 0, null],
  ["an object", { value: "2026-10-20" }, null],
  ["an array", ["2026-10-20"], null],
] as const) {
  test(`[boundary-9] an updated of ${label} gives ${JSON.stringify(result)}`, async () => {
    const spec = await toIssueSpec("ACME-1", { updated } as Fields);
    assert.equal(spec.updated, result);
  });
}

// Extends "[boundary-10]": tabs, CRs and spaces in other places and runs.
for (const [label, description, text] of [
  ["leading and trailing tabs", "\t\tLead\t", "Lead"],
  ["two lone CRs between words", "a\r\rb", "a b"],
  ["spaces on both sides of a newline", "a  \n  b", "a \n b"],
  ["a whitespace-only line between lines", "a\n \t \nb", "a\n \nb"],
  ["newlines at the ends", "\n\nLine\n\n", "Line"],
  ["only newlines", "\n\n\n", ""],
  ["many separated runs", "one  two\t\tthree \t four", "one two three four"],
  ["a CRLF-only text", "\r\n\r\n", ""],
] as const) {
  test(`[boundary-10] a string description with ${label} collapses and trims`, async () => {
    const spec = await toIssueSpec("ACME-1", { description });
    assert.equal(spec.descriptionText, text);
  });
}

// Extends "[boundary-10]": the hash is taken over the collapsed text.
test("[boundary-10] the hash of a collapsed string description is the hash of the collapsed text", async () => {
  const spec = await toIssueSpec("ACME-1", { summary: "Add login", description: "Users   can\tsign  in." });
  assert.equal(spec.descriptionText, "Users can sign in.");
  assert.equal(spec.specHash, ADD_LOGIN);
});

// Extends "[boundary-11] a string description longer than 20,000 characters is truncated":
// much longer input, and multi-line input cut mid-line.
test("[boundary-11] a much longer string description is cut to its first 20,000 characters", async () => {
  const spec = await toIssueSpec("ACME-1", { description: "abcd".repeat(15_000) });
  assert.equal(spec.descriptionText, `${"abcd".repeat(5_000)}\n[truncated]`);
});

test("[boundary-11] a multi-line string description is cut at character 20,000 whatever the lines", async () => {
  const description = "line\n".repeat(5_000) + "tail";
  const spec = await toIssueSpec("ACME-1", { description });
  assert.equal(spec.descriptionText, `${description.slice(0, 20_000)}\n[truncated]`);
});

// Extends "[boundary-11] an ADF description longer than 20,000 characters is truncated":
// the cap applies to the joined text, not to each text node or block.
test("[boundary-11] an ADF description whose blocks only together pass 20,000 characters is truncated", async () => {
  const spec = await toIssueSpec("ACME-1", { description: doc(para("y".repeat(10_000)), para("z".repeat(10_000))) });
  assert.equal(spec.descriptionText, `${"y".repeat(10_000)}\n\n${"z".repeat(9_998)}\n[truncated]`);
});

// Extends "[boundary-11]": the hash is taken over the truncated text.
test("[boundary-11] the specHash of a truncated description is the hash of the truncated text", async () => {
  const spec = await toIssueSpec("ACME-1", { summary: "Big", description: "x".repeat(25_000) });
  assert.equal(spec.specHash, expected("Big", `${"x".repeat(20_000)}\n[truncated]`));
});

// Extends "[boundary-11]": one character past the cap after collapsing.
test("[boundary-11] a string that collapses to 20,001 characters is truncated", async () => {
  const spec = await toIssueSpec("ACME-1", { description: `  ${"x".repeat(20_001)}  ` });
  assert.equal(spec.descriptionText, `${"x".repeat(20_000)}\n[truncated]`);
});

// Extends "[boundary-12] a description of exactly 20,000 characters is kept whole":
// the cap counts the description text, after collapsing and trimming.
test("[boundary-12] a string longer than 20,000 characters that collapses to fewer is kept whole", async () => {
  const description = "x\t\t".repeat(10_000);
  const spec = await toIssueSpec("ACME-1", { description });
  assert.equal(spec.descriptionText, "x ".repeat(10_000).trimEnd());
});

test("[boundary-12] a padded string that trims to exactly 20,000 characters is kept whole", async () => {
  const spec = await toIssueSpec("ACME-1", { description: `   ${"x".repeat(20_000)}\n\n` });
  assert.equal(spec.descriptionText, "x".repeat(20_000));
});

// Extends "[boundary-12] an ADF description of exactly 20,000 characters is kept whole":
// with the 20,000 made up of two blocks and their separator.
test("[boundary-12] an ADF description of two blocks totalling exactly 20,000 characters is kept whole", async () => {
  const spec = await toIssueSpec("ACME-1", { description: doc(para("y".repeat(9_999)), para("z".repeat(9_999))) });
  assert.equal(spec.descriptionText, `${"y".repeat(9_999)}\n\n${"z".repeat(9_999)}`);
});

test("[boundary-12] a description of 19,999 characters is kept whole", async () => {
  const description = "x".repeat(19_999);
  assert.equal((await toIssueSpec("ACME-1", { description })).descriptionText, description);
});

// Extends "[boundary-13]": other values that are neither strings nor ADF nodes,
// and arrays, which are ADF nodes with no members to read.
for (const [label, description] of [
  ["an explicit undefined", undefined],
  ["0", 0],
  ["false", false],
  ["an empty array", []],
  ["an array of ADF nodes", [{ type: "paragraph", content: [{ type: "text", text: "a" }] }]],
  ["an array holding a doc", [{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }]],
] as const) {
  test(`[boundary-13] a description of ${label} becomes ""`, async () => {
    const spec = await toIssueSpec("ACME-1", { summary: "", description });
    assert.equal(spec.descriptionText, "");
    assert.equal(spec.specHash, EMPTY);
  });
}

// Extends "[boundary-13]": the summary still counts when the description is dropped.
test("[boundary-13] a non-node description leaves the hash to the summary alone", async () => {
  const spec = await toIssueSpec("ACME-1", { summary: "Add login", description: 42 });
  assert.equal(spec.descriptionText, "");
  assert.equal(spec.specHash, expected("Add login", ""));
});

// Extends "[boundary-16] an empty fields block yields a spec of defaults":
// explicit undefined members and a prototype-less object.
test("[boundary-16] a fields block of explicit undefined members yields the defaults", async () => {
  const spec = await toIssueSpec("OPS-9", { summary: undefined, description: undefined, issuetype: undefined, updated: undefined });
  assert.deepEqual(spec, {
    key: "OPS-9",
    summary: "",
    descriptionText: "",
    issueType: "Task",
    updated: null,
    specHash: EMPTY,
  });
});

test("[boundary-16] a prototype-less empty fields block yields the defaults", async () => {
  const spec = await toIssueSpec("OPS-10", Object.create(null) as Fields);
  assert.deepEqual(spec, {
    key: "OPS-10",
    summary: "",
    descriptionText: "",
    issueType: "Task",
    updated: null,
    specHash: EMPTY,
  });
});

// Extends "[unhappy-3]": other keys, and later calls are unaffected.
test("[unhappy-3] null and undefined fields reject with a TypeError whatever the key", async () => {
  for (const key of ["", "ACME-1", "OPS-4521"]) {
    await assert.rejects(toIssueSpec(key, null as unknown as Fields), TypeError);
    await assert.rejects(toIssueSpec(key, undefined as unknown as Fields), TypeError);
  }
  const spec = await toIssueSpec("ACME-1", { summary: "Add login", description: "Users can sign in." });
  assert.equal(spec.specHash, ADD_LOGIN);
});

// Extends "[concurrency-2] overlapping toIssueSpec calls each resolve to their own issue's spec":
// many calls, mixing string and ADF descriptions of very different sizes.
test("[concurrency-2] many overlapping toIssueSpec calls each resolve to their own spec, in order", async () => {
  const inputs = Array.from({ length: 24 }, (_, i) => {
    const text = i % 4 === 0 ? `Long${i}.`.repeat(4_000) : `Short ${i}`;
    const description = i % 2 === 0 ? text : doc(para(text));
    return { key: `ACME-${i}`, summary: `Summary ${i}`, text, description };
  });
  const specs = await Promise.all(
    inputs.map(({ key, summary, description }) => toIssueSpec(key, { summary, description, issuetype: { name: `T${key}` } })),
  );
  specs.forEach((spec, i) => {
    const { key, summary, text } = inputs[i]!;
    const descriptionText = text.length > 20_000 ? `${text.slice(0, 20_000)}\n[truncated]` : text;
    assert.deepEqual(spec, {
      key,
      summary,
      descriptionText,
      issueType: `T${key}`,
      updated: null,
      specHash: expected(summary, descriptionText),
    });
  });
});

// Extends "[concurrency-2] a rejecting call overlapping a valid one does not disturb it":
// several rejections interleaved with several valid calls.
test("[concurrency-2] interleaved rejecting and valid calls each settle on their own input", async () => {
  const results = await Promise.allSettled([
    toIssueSpec("ACME-1", { summary: "Add login", description: "Users can sign in." }),
    toIssueSpec("BAD-1", undefined as unknown as Fields),
    toIssueSpec("ACME-2", { summary: "Fix the build", description: doc(para("Line one"), para("Line two")) }),
    toIssueSpec("BAD-2", null as unknown as Fields),
    toIssueSpec("ACME-3", {}),
  ]);
  const [a, bad1, b, bad2, c] = results;
  assert.ok(a?.status === "fulfilled" && a.value.key === "ACME-1" && a.value.specHash === ADD_LOGIN);
  assert.ok(bad1?.status === "rejected" && bad1.reason instanceof TypeError);
  assert.ok(b?.status === "fulfilled" && b.value.key === "ACME-2");
  assert.equal(b.value.specHash, expected("Fix the build", "Line one\n\nLine two"));
  assert.ok(bad2?.status === "rejected" && bad2.reason instanceof TypeError);
  assert.ok(c?.status === "fulfilled" && c.value.key === "ACME-3" && c.value.specHash === EMPTY);
});
