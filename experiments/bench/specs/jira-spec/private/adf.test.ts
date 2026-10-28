import assert from "node:assert/strict";
import { test } from "node:test";

import { toIssueSpec } from "../../src/spec.js";

/** The descriptionText `toIssueSpec` gives for this description. */
async function textOf(description: unknown): Promise<string> {
  return (await toIssueSpec("ACME-1", { description })).descriptionText;
}

/** A doc whose content is these nodes. */
function doc(...content: unknown[]): unknown {
  return { type: "doc", content };
}

/** A paragraph holding these inline nodes. */
function para(...content: unknown[]): unknown {
  return { type: "paragraph", content };
}

/** A text node. */
function text(value: string): unknown {
  return { type: "text", text: value };
}

/** A list item holding these blocks. */
function item(...content: unknown[]): unknown {
  return { type: "listItem", content };
}

/** A table cell holding these blocks. */
function cell(...content: unknown[]): unknown {
  return { type: "tableCell", content };
}

/** A table row of these cells. */
function row(...content: unknown[]): unknown {
  return { type: "tableRow", content };
}

const HARD_BREAK = { type: "hardBreak" };

// Extends "[happy-11] heading keeps a Markdown marker" and
// "[happy-11] a heading level is clamped to 1-6 and defaults to 1": every level.
test("[happy-11] each heading level from 1 to 6 gets that many # marks", async () => {
  for (let level = 1; level <= 6; level++) {
    const heading = { type: "heading", attrs: { level }, content: [text("Goal")] };
    assert.equal(await textOf(doc(heading)), `${"#".repeat(level)} Goal`);
  }
});

// Extends "[happy-11] a heading level is clamped to 1-6 and defaults to 1": other out-of-range levels.
test("[happy-11] heading levels just past and far past the range are clamped", async () => {
  const heading = (level: number) => doc({ type: "heading", attrs: { level }, content: [text("T")] });
  assert.equal(await textOf(heading(7)), "###### T");
  assert.equal(await textOf(heading(100)), "###### T");
  assert.equal(await textOf(heading(-3)), "# T");
});

// Extends "[happy-11] heading keeps a Markdown marker": a heading's inline text
// includes breaks and other inline nodes.
test("[happy-11] a heading's marker is followed by its whole inline text", async () => {
  const heading = {
    type: "heading",
    attrs: { level: 3 },
    content: [text("Ask "), { type: "mention", attrs: { text: "@Ann" } }, HARD_BREAK, text("today")],
  };
  assert.equal(await textOf(doc(heading)), "### Ask @Ann\ntoday");
});

// Extends "[happy-11] ordered list numbers from order": more items, numbers past 9.
test("[happy-11] an ordered list keeps counting up from its order", async () => {
  const list = { type: "orderedList", attrs: { order: 9 }, content: [item(para(text("a"))), item(para(text("b"))), item(para(text("c")))] };
  assert.equal(await textOf(doc(list)), "9. a\n\n10. b\n\n11. c");
});

// Extends "[happy-11] a list item's later blocks are indented two spaces": in an ordered list.
test("[happy-11] an ordered list item's later blocks are indented two spaces", async () => {
  const list = { type: "orderedList", content: [item(para(text("a")), para(text("b")), para(text("c"))), item(para(text("d")))] };
  assert.equal(await textOf(doc(list)), "1. a\n\n  b\n\n  c\n\n2. d");
});

// Extends "[happy-11] bullet list items get "- "": a nested list's blocks are the
// item's later blocks, so they are indented under it.
test("[happy-11] a list nested in a list item is indented two spaces", async () => {
  const nested = { type: "bulletList", content: [item(para(text("b"))), item(para(text("c")))] };
  const list = { type: "bulletList", content: [item(para(text("a")), nested), item(para(text("d")))] };
  assert.equal(await textOf(doc(list)), "- a\n\n  - b\n\n  - c\n\n- d");
});

// Extends "[happy-11] bullet list items get "- "": more items, and a list among other blocks.
test("[happy-11] a bullet list between paragraphs gives one block per item", async () => {
  const list = { type: "bulletList", content: [item(para(text("one"))), item(para(text("two"))), item(para(text("three")))] };
  assert.equal(await textOf(doc(para(text("Before")), list, para(text("After")))), "Before\n\n- one\n\n- two\n\n- three\n\nAfter");
});

// Extends "[happy-11] blockquote lines get "> "": a blockquote of other block types.
test("[happy-11] each block inside a blockquote is prefixed and they join with one newline", async () => {
  const quote = {
    type: "blockquote",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text("Note")] },
      { type: "bulletList", content: [item(para(text("a"))), item(para(text("b")))] },
      para(text("c")),
    ],
  };
  assert.equal(await textOf(doc(para(text("x")), quote, para(text("y")))), "x\n\n> ## Note\n> - a\n> - b\n> c\n\ny");
});

// Extends "[happy-11] code block is fenced": several text nodes, a break, kept indentation.
test("[happy-11] a code block's inline text is fenced as it is", async () => {
  const code = { type: "codeBlock", attrs: { language: "ts" }, content: [text("  const a = 1;"), HARD_BREAK, text("  a  +  1")] };
  assert.equal(await textOf(doc(code)), "```ts\n  const a = 1;\n  a  +  1\n```");
});

// Extends "[happy-11] a code block with no language string has a bare fence".
test("[happy-11] a code block with an empty language or no text still has its fence", async () => {
  assert.equal(await textOf(doc({ type: "codeBlock", attrs: { language: "" }, content: [text("x")] })), "```\nx\n```");
  assert.equal(await textOf(doc({ type: "codeBlock", attrs: { language: "py" }, content: [] })), "```py\n\n```");
});

// Extends "[happy-11] table rows are pipe-separated": more columns and rows, an empty cell.
test("[happy-11] a wider table gives one pipe-separated block per row", async () => {
  const table = {
    type: "table",
    content: [
      row(cell(para(text("A"))), cell(para(text("B"))), cell(para(text("C")))),
      row(cell(para(text("1"))), cell(), cell(para(text("3")))),
      row(cell(para(text(" x "))), cell(para(text("y"))), cell(para(text("z")))),
    ],
  };
  assert.equal(await textOf(doc(table)), "| A | B | C |\n\n| 1 |  | 3 |\n\n| x | y | z |");
});

// Extends "[happy-11] mention uses attrs.text": several mentions in one paragraph.
test("[happy-11] several mentions each use their own attrs.text", async () => {
  const mention = (name: string) => ({ type: "mention", attrs: { id: name, text: name } });
  assert.equal(await textOf(doc(para(mention("@Ann"), text(" and "), mention("@Bo")))), "@Ann and @Bo");
});

// Extends "[happy-11] emoji uses shortName, not text": a non-string shortName gives nothing.
test("[happy-11] an emoji with a non-string shortName adds nothing, even with attrs.text", async () => {
  assert.equal(await textOf(doc(para(text("ok"), { type: "emoji", attrs: { shortName: 5, text: "\u{1F604}" } }))), "ok");
});

// Extends "[happy-11] inline card uses attrs.url" and "[happy-11] date and card nodes use their string attrs".
test("[happy-11] cards and dates with no attrs add nothing", async () => {
  assert.equal(
    await textOf(doc(para(text("a"), { type: "inlineCard" }, text("b"), { type: "blockCard" }, text("c"), { type: "date" }))),
    "abc",
  );
});

// Extends "[happy-11] media nodes become a media placeholder with a count": other counts.
test("[happy-11] media groups count their items", async () => {
  const media = { type: "media", attrs: { id: "1" } };
  assert.equal(await textOf(doc({ type: "mediaGroup", content: [media, media, media] })), "[media x3]");
  assert.equal(await textOf(doc({ type: "mediaGroup", content: [media] })), "[media]");
  assert.equal(await textOf(doc({ type: "mediaSingle", content: [] })), "[media x0]");
});

// Extends "[happy-11] task items get checkboxes": a task item's inline text reaches into its children.
test("[happy-11] a task item's inline text includes text inside its paragraph", async () => {
  const list = { type: "taskList", content: [{ type: "taskItem", content: [para(text("write "), text("tests"))] }] };
  assert.equal(await textOf(doc(list)), "- [ ] write tests");
});

// Extends "[happy-11] a DONE task item is ticked": only the exact "DONE" ticks.
test("[happy-11] a task item is ticked only when its state is exactly DONE", async () => {
  const task = (state: unknown, value: string) => ({ type: "taskItem", attrs: { state }, content: [text(value)] });
  const list = { type: "taskList", content: [task("done", "a"), task("DONE ", "b"), task("DONE", "c")] };
  assert.equal(await textOf(doc(list)), "- [ ] a\n\n- [ ] b\n\n- [x] c");
});

// Extends "[happy-11] task items get checkboxes": an item with no text keeps its box.
test("[happy-11] a task item with no text is its checkbox alone", async () => {
  const list = { type: "taskList", content: [{ type: "taskItem", content: [] }, { type: "taskItem", content: [text("b")] }] };
  assert.equal(await textOf(doc(list)), "- [ ]\n\n- [ ] b");
});

// Extends "[happy-11] unknown inline node adds nothing": an unknown inline node
// with children adds its children's text.
test("[happy-11] an unknown inline node adds the inline text of its children", async () => {
  const wrapper = { type: "inlineExtension", attrs: { text: "ignored" }, content: [text("in"), { type: "fancy", content: [text("side")] }] };
  assert.equal(await textOf(doc(para(text("a "), wrapper, text(" b")))), "a inside b");
});

// Extends "[happy-11] marked runs join with no gap": marks never add text.
test("[happy-11] link and code marks add nothing to the text", async () => {
  const linked = { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.com" } }] };
  const code = { type: "text", text: "npm", marks: [{ type: "code" }] };
  assert.equal(await textOf(doc(para(text("see "), linked, text(", run "), code))), "see docs, run npm");
});

// Extends "[happy-11] paragraphs join with a blank line": text inside a block is
// not trimmed, collapsed or normalised, and leading whitespace is kept.
test("[happy-11] text inside an ADF block keeps its runs of whitespace and leading spaces", async () => {
  assert.equal(await textOf(doc(para(text("a   b\t c")), para(text("  d")))), "a   b\t c\n\n  d");
  assert.equal(await textOf(doc(para(text("Café")))), "Café");
});

// Extends "[happy-11] a root that is not a doc": other block types at the root.
test("[happy-11] a heading, list or table at the root flattens on its own", async () => {
  assert.equal(await textOf({ type: "heading", attrs: { level: 2 }, content: [text("x")] }), "## x");
  assert.equal(await textOf({ type: "bulletList", content: [item(para(text("a")))] }), "- a");
  assert.equal(await textOf({ type: "rule" }), "---");
});

// Extends "[happy-11]": a node of unknown type with a text member is one block of that text.
test("[happy-11] an unknown block with string text is a block of that text, else its children's blocks", async () => {
  assert.equal(await textOf(doc(para(text("a")), { type: "placeholder", text: "Fill in" }, para(text("b")))), "a\n\nFill in\n\nb");
  assert.equal(await textOf(doc({ type: "panel", attrs: { panelType: "info" }, content: [para(text("x")), para(text("y"))] })), "x\n\ny");
  assert.equal(await textOf(doc({ type: "expand", text: "", content: [para(text("z"))] })), "z");
});

// Extends "[happy-11]": a document mixing every block type.
test("[happy-11] a document mixing block types joins all their blocks in order", async () => {
  const description = doc(
    { type: "heading", attrs: { level: 1 }, content: [text("Login")] },
    para(text("Users can sign in.")),
    { type: "rule" },
    { type: "codeBlock", attrs: { language: "sh" }, content: [text("npm test")] },
    { type: "orderedList", content: [item(para(text("open"))), item(para(text("type")))] },
    { type: "table", content: [row(cell(para(text("k"))), cell(para(text("v"))))] },
    { type: "mediaSingle", content: [{ type: "media" }] },
  );
  assert.equal(
    await textOf(description),
    "# Login\n\nUsers can sign in.\n\n---\n\n```sh\nnpm test\n```\n\n1. open\n\n2. type\n\n| k | v |\n\n[media]",
  );
});

// Extends "[boundary-14] empty and degenerate ADF": other empty documents.
for (const [name, description, expected] of [
  ["a doc of only empty paragraphs", doc({ type: "paragraph" }, para(), para(text(""))), ""],
  ["a doc of whitespace and breaks", doc(para(text("  ")), para(HARD_BREAK, HARD_BREAK), para(text("\t"))), ""],
  ["a doc with null content", { type: "doc", content: null }, ""],
  ["an empty bullet list", doc({ type: "bulletList", content: [] }), ""],
  ["an empty table", doc({ type: "table", content: [] }), ""],
  ["a doc of only a rule", doc({ type: "rule" }), "---"],
  ["empty paragraphs before and after text", doc(para(), para(text("a")), para()), "a"],
  ["an empty list item between items", doc({ type: "bulletList", content: [item(para(text("a"))), item(), item(para(text("b")))] }), "- a\n\n- b"],
] as const) {
  test(`[boundary-14] empty and degenerate ADF: ${name}`, async () => {
    assert.equal(await textOf(description), expected);
  });
}

// Extends "[boundary-14] trailing whitespace of a block is removed": only the
// end of the block, not the end of each line inside it.
test("[boundary-14] only a block's trailing whitespace is removed, not that before an inner break", async () => {
  assert.equal(await textOf(doc(para(text("a  "), HARD_BREAK, text("b  "), HARD_BREAK))), "a  \nb");
});

// Extends "[boundary-14] trailing whitespace of a block is removed": in every block.
test("[boundary-14] trailing whitespace is removed from every block, not only the last", async () => {
  assert.equal(await textOf(doc(para(text("a \t")), para(text("b  ")), para(text("c")))), "a\n\nb\n\nc");
});

// Extends "[unhappy-2] malformed ADF is ignored rather than thrown on": other malformed members.
for (const [name, description, expected] of [
  ["an array nested in content is a node with nothing to read", doc([para(text("hidden"))], para(text("a"))), "a"],
  ["non-node items among inline content", doc(para("raw", null, 3, text("a"), [text("hidden")])), "a"],
  ["a heading with null attrs", doc({ type: "heading", attrs: null, content: [text("T")] }), "# T"],
  ["a heading with a string level", doc({ type: "heading", attrs: { level: "3" }, content: [text("T")] }), "# T"],
  ["an ordered list with a string order", doc({ type: "orderedList", attrs: { order: "5" }, content: [item(para(text("a")))] }), "1. a"],
  ["a code block with a null language", doc({ type: "codeBlock", attrs: { language: null }, content: [text("x")] }), "```\nx\n```"],
  ["a task item with a non-string state", doc({ type: "taskList", content: [{ type: "taskItem", attrs: { state: true }, content: [text("a")] }] }), "- [ ] a"],
  ["a mention with a numeric attrs.text", doc(para({ type: "mention", attrs: { text: 42 } })), "@unknown"],
  ["a date with a numeric timestamp", doc(para(text("due "), { type: "date", attrs: { timestamp: 1729415700000 } })), "due"],
  ["a blockCard with a null url", doc(para(text("x"), { type: "blockCard", attrs: { url: null } })), "x"],
  ["a type that is an object", { type: { name: "paragraph" }, content: [text("a")] }, "a"],
  ["a text node whose text is an object", doc(para({ type: "text", text: { value: "x" } })), ""],
  ["an inline text node with non-string text reads its children", doc(para({ type: "text", text: 42, content: [text("y")] })), "y"],
  ["a doc whose content is a string", { type: "doc", content: "hello" }, ""],
  ["a table row with non-node items", doc({ type: "table", content: [row("x", null, cell(para(text("a"))))] }), "| a |"],
  ["a list item whose content is not an array", doc({ type: "bulletList", content: [item(para(text("a"))), { type: "listItem", content: "b" }] }), "- a"],
] as const) {
  test(`[unhappy-2] malformed ADF is ignored rather than thrown on: ${name}`, async () => {
    assert.equal(await textOf(description), expected);
  });
}

/** `depth` nested copies of `wrap` around `inner`. */
function nest(depth: number, wrap: (child: unknown) => unknown, inner: unknown): unknown {
  let node = inner;
  for (let i = 0; i < depth; i++) node = wrap(node);
  return node;
}

const blockquote = (child: unknown) => ({ type: "blockquote", content: [child] });

// Extends "[boundary-15] deeply nested ADF does not overflow the stack": nodes
// of no type, so a depth guard on blockquotes alone is not enough.
test("[boundary-15] 100,000 nested untyped nodes resolve and drop the text past 50 levels", async () => {
  const description = nest(100_000, (child) => ({ content: [child] }), text("deep"));
  assert.equal(await textOf(description), "");
});

// Extends "[boundary-15]": deep inline nesting inside a paragraph.
test("[boundary-15] 100,000 nested inline nodes in a paragraph resolve and drop the deep text", async () => {
  const deep = nest(100_000, (child) => ({ type: "strong", content: [child] }), text("deep"));
  assert.equal(await textOf(doc(para(text("start"), deep))), "start");
});

// Extends "[boundary-15]": deep nested lists.
test("[boundary-15] 50,000 nested lists, 100,000 levels, resolve without the deep text", async () => {
  const deep = nest(50_000, (child) => ({ type: "bulletList", content: [item(child)] }), para(text("deep")));
  const spec = await toIssueSpec("ACME-1", { description: doc(deep) });
  assert.ok(!spec.descriptionText.includes("deep"));
});

// Extends "[boundary-15]": dropping deep content leaves the shallow content around it.
test("[boundary-15] content beside a too-deep branch is kept", async () => {
  const deep = nest(100_000, (child) => ({ type: "panel", content: [child] }), para(text("deep")));
  assert.equal(await textOf(doc(para(text("before")), deep, para(text("after")))), "before\n\nafter");
});

// Extends "[boundary-15] deeply nested ADF ... content past 50 levels is dropped":
// any depth well past 50 gives the same cut-off result.
test("[boundary-15] 60 and 1,000 nested blockquotes are cut off like 100,000", async () => {
  for (const depth of [60, 1_000]) {
    const description = nest(depth, blockquote, para(text("deep")));
    assert.equal(await textOf(description), `${"> ".repeat(49)}>`);
  }
});

// Extends "[boundary-15] shallowly nested blockquotes keep their text": deeper, still under 50.
test("[boundary-15] 40 nested blockquotes keep their text", async () => {
  assert.equal(await textOf(nest(40, blockquote, para(text("deep")))), `${"> ".repeat(40)}deep`);
});
