/**
 * `carveout map`: the session-log parsers on fixtures (Claude Code and two
 * generations of Codex), the range maths, the shell reads, the numbers end
 * to end, the share card's pseudonyms, and a 50k-file repository.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { parseClaudeSession } from "../src/map/claude.js";
import { applyPatchEvents, parseCodexSession } from "../src/map/codex.js";
import { pageData, renderMapHtml } from "../src/map/html.js";
import { buildMap } from "../src/map/index.js";
import { claudeProjectName, findSessions, repoContext, repoRoots } from "../src/map/logs.js";
import { coverOf, formatPercent, numbersOf, parseSince, repoFiles, sessionData } from "../src/map/model.js";
import { leaksIn, repoVocabulary } from "../src/map/names.js";
import { formatRanges, intersectRanges, rangeLines, subtractRanges, unionRanges } from "../src/map/ranges.js";
import { matchOutput, shellReads, shellTokens } from "../src/map/shell.js";
import { looseLeaks } from "../src/pseudonyms/folder.js";

const FIXTURES = resolve(import.meta.dirname, "../../test/fixtures/map");
const quote = (i: number) => `export const quote${i} = ${i};`;
const tax = (i: number) => `export const tax${i} = ${i};`;
const fmt = (i: number) => `export const fmt${i} = "${i}";`;
const lines = (n: number, line: (i: number) => string) => `${Array.from({ length: n }, (_, k) => line(k + 1)).join("\n")}\n`;

/** A small repository the fixtures read, at a real path. */
function fixtureRepo(name = "acme-ledger"): { root: string; done: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "carveout-map-")));
  const root = join(base, name);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("package.json", `${JSON.stringify({ name: "@ledgerly/quote-engine", version: "1.0.0", author: "Ledgerly Labs" }, null, 2)}\n`);
  write("src/billing/quote.ts", lines(60, quote));
  write("src/billing/tax.ts", lines(30, tax));
  write("src/billing/discount.ts", lines(8, (i) => `export const d${i} = ${i};`));
  write("src/util/format.ts", lines(20, fmt));
  write("docs/notes.md", lines(12, (i) => `note line ${i} about pricing`));
  write("test/quote.test.ts", lines(10, (i) => `// case ${i}`));
  write("ledgerly-sync/src/sync.ts", lines(5, (i) => `export const s${i} = ${i};`));
  write("assets/logo.png", "\u0000PNG");
  return { root, done: () => rmSync(base, { recursive: true, force: true }) };
}

const fixture = (name: string, root: string) => readFileSync(join(FIXTURES, name), "utf8").replaceAll("__ROOT__", root);

function contextFor(root: string) {
  const files = repoFiles(root);
  return { files, ctx: repoContext(root, repoRoots(root), new Set(files.map((file) => file.path))) };
}

test("ranges merge, subtract, intersect and print", () => {
  assert.deepEqual(unionRanges([[6, 9], [1, 5], [20, 22], [21, 30], [40, 39]]), [[1, 9], [20, 30]]);
  assert.deepEqual(unionRanges([[1, 100]], 40), [[1, 40]]);
  assert.deepEqual(unionRanges([[0, 3]]), [[1, 3]]);
  assert.equal(rangeLines([[1, 9], [20, 30]]), 20);
  assert.deepEqual(subtractRanges([[1, 10], [20, 30]], [[3, 4], [8, 22]]), [[1, 2], [5, 7], [23, 30]]);
  assert.deepEqual(intersectRanges([[1, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]]);
  assert.equal(formatRanges([[1, 1], [4, 9]]), "1, 4-9");
});

test("shell words: quotes, operators, redirections and heredocs", () => {
  const words = (command: string) => shellTokens(command).map((token) => ("word" in token ? token.word : `<${token.op}>`));
  assert.deepEqual(words(`cd "my dir" && sed -n '1,5p' a.ts 2>&1 | head -3`), ["cd", "my dir", "<&&>", "sed", "-n", "1,5p", "a.ts", "<|>", "head", "-3"]);
  assert.deepEqual(words("cat <<EOF > out.txt\nhello world\nEOF\nnl b.ts"), ["cat", "<<<>", "<>>", "out.txt", "<;>", "nl", "b.ts"]);
});

test("shell reads: sed, head, tail, awk, cat, pipelines, grep, and only what a cut-short output held", () => {
  const { root, done } = fixtureRepo();
  try {
    const { ctx } = contextFor(root);
    const read = (command: string, output: string | null = null, cwd = root) =>
      shellReads(command, cwd, output, ctx).map((each) => [each.path, formatRanges(each.ranges)]);
    assert.deepEqual(read("sed -n '10,20p' src/billing/quote.ts"), [["src/billing/quote.ts", "10-20"]]);
    assert.deepEqual(read("sed -n -e '1,3p' -e '9p' src/billing/tax.ts"), [["src/billing/tax.ts", "1-3, 9"]]);
    assert.deepEqual(read("head -n 5 src/billing/quote.ts; tail -3 src/billing/tax.ts"), [["src/billing/quote.ts", "1-5"], ["src/billing/tax.ts", "28-30"]]);
    assert.deepEqual(read("tail -n +55 src/billing/quote.ts"), [["src/billing/quote.ts", "55-60"]]);
    assert.deepEqual(read("awk 'NR>=4 && NR<=6' src/util/format.ts"), [["src/util/format.ts", "4-6"]]);
    assert.deepEqual(read(`cat ${root}/src/util/format.ts docs/notes.md`), [["src/util/format.ts", "1-20"], ["docs/notes.md", "1-12"]]);
    assert.deepEqual(read("cd src/billing && head -2 tax.ts", null, root), [["src/billing/tax.ts", "1-2"]]);
    assert.deepEqual(read("cat src/billing/quote.ts | head -4"), [["src/billing/quote.ts", "1-4"]]);
    // A filter after the read: only the lines whose text came back.
    assert.deepEqual(read("cat src/billing/quote.ts | grep quote4", lines(1, () => quote(4)) + quote(40)), [["src/billing/quote.ts", "4, 40"]]);
    assert.deepEqual(read("rg -n quote4 src", `src/billing/quote.ts:4:${quote(4)}\nsrc/billing/quote.ts:40:${quote(40)}`), [["src/billing/quote.ts", "4, 40"]]);
    assert.deepEqual(read("grep tax2 src/billing/tax.ts", `${tax(2)}\n${tax(20)}`), [["src/billing/tax.ts", "2, 20"]]);
    assert.deepEqual(read("rg -l quote src", "src/billing/quote.ts"), []);
    assert.deepEqual(read("wc -l src/billing/quote.ts && ls src"), []);
    // An output the tool cut short counts only the lines it held.
    const truncated = `<persisted-output>\nPreview (first 2KB):\n${quote(1)}\n${quote(2)}\n${quote(3)}\n...\n</persisted-output>`;
    assert.deepEqual(read("cat src/billing/quote.ts", truncated), [["src/billing/quote.ts", "1-3"]]);
    assert.deepEqual(read("cat src/billing/quote.ts | head -40", truncated), [["src/billing/quote.ts", "1-3"]]);
    assert.deepEqual(read("cat /etc/hosts ../outside.ts"), []);
    assert.deepEqual(matchOutput(["alpha one", "}", "beta two", "alpha one"], "alpha one\n}\nbeta two"), [[1, 3]]);
  } finally {
    done();
  }
});

test("Claude Code: Read by its own account and by offset, Grep's content, edits' hunks, a Write, Bash inferred, a subagent's read", () => {
  const { root, done } = fixtureRepo();
  try {
    const { files, ctx } = contextFor(root);
    const session = parseClaudeSession("sess-claude-1", [{ file: "x.jsonl", text: fixture("claude-session.jsonl", root) }], ctx);
    assert.equal(session.title, "Fix the quote rounding");
    assert.equal(session.cwd, root);
    const cover = coverOf(files, sessionData(files, [session])[0]?.events ?? []);
    const byPath = new Map([...cover].map(([index, coverage]) => [files[index]?.path, coverage]));
    const show = (path: string) => {
      const coverage = byPath.get(path);
      return coverage === undefined ? null : { read: formatRanges(coverage.read), inferred: formatRanges(coverage.inferred), edited: formatRanges(coverage.edited), editedFile: coverage.editedFile };
    };
    assert.deepEqual(show("src/billing/quote.ts"), { read: "3-5, 10-29, 39-41, 50-53", inferred: "", edited: "51-52", editedFile: true });
    assert.deepEqual(show("src/billing/tax.ts"), { read: "1-30", inferred: "", edited: "", editedFile: false });
    assert.deepEqual(show("src/util/format.ts"), { read: "2, 15-16", inferred: "1, 3-5", edited: "2, 16", editedFile: true });
    assert.deepEqual(show("src/billing/discount.ts"), { read: "1-8", inferred: "", edited: "1-8", editedFile: true });
    assert.deepEqual(show("docs/notes.md"), { read: "", inferred: "1-4, 8-9, 11", edited: "", editedFile: false });
    assert.deepEqual(show("test/quote.test.ts"), { read: "1-10", inferred: "", edited: "", editedFile: false });
    assert.ok(session.events.some((event) => event.tool === "Read (subagent)"));
    assert.ok(!session.events.some((event) => event.tool.startsWith("Glob")));
    const numbers = numbersOf(files, cover);
    assert.equal(numbers.readLines, 30 + 30 + 3 + 8 + 10);
    assert.equal(numbers.inferredLines, 4 + 7);
    assert.equal(numbers.filesSeen, 6);
    assert.equal(numbers.filesEdited, 3);
  } finally {
    done();
  }
});

test("Codex Desktop items: shell reads inferred, a pipeline matched to its output, FileChange hunks, and no call counted twice", () => {
  const { root, done } = fixtureRepo();
  try {
    const { files, ctx } = contextFor(root);
    const session = parseCodexSession("rollout.jsonl", fixture("codex-items.jsonl", root), ctx);
    assert.equal(session.id, "0199aaaa-0000-7000-8000-000000000001");
    assert.equal(session.events.length, 4);
    assert.ok(session.events.every((event) => event.kind !== "read"));
    const cover = coverOf(files, sessionData(files, [session])[0]?.events ?? []);
    const byPath = new Map([...cover].map(([index, coverage]) => [files[index]?.path, coverage]));
    assert.equal(formatRanges(byPath.get("src/billing/quote.ts")?.inferred ?? []), "20-35");
    assert.equal(formatRanges(byPath.get("src/billing/tax.ts")?.inferred ?? []), "5-9");
    assert.equal(formatRanges(byPath.get("src/billing/tax.ts")?.read ?? []), "10-12");
    assert.equal(formatRanges(byPath.get("src/billing/tax.ts")?.edited ?? []), "11");
    assert.equal(formatRanges(byPath.get("src/billing/discount.ts")?.edited ?? []), "1-8");
  } finally {
    done();
  }
});

test("Codex CLI calls: a shell function call and an apply_patch found where it sits", () => {
  const { root, done } = fixtureRepo();
  try {
    const { files, ctx } = contextFor(root);
    const session = parseCodexSession("rollout.jsonl", fixture("codex-calls.jsonl", root), ctx);
    const cover = coverOf(files, sessionData(files, [session])[0]?.events ?? []);
    const byPath = new Map([...cover].map(([index, coverage]) => [files[index]?.path, coverage]));
    assert.equal(formatRanges(byPath.get("docs/notes.md")?.inferred ?? []), "1-3");
    assert.equal(formatRanges(byPath.get("src/util/format.ts")?.read ?? []), "6-8");
    assert.equal(formatRanges(byPath.get("src/util/format.ts")?.edited ?? []), "7");
    const added = applyPatchEvents("*** Begin Patch\n*** Add File: src/new.ts\n+a\n+b\n*** End Patch", root, 0, ctx);
    // An added file counts whole; the map drops it later if it is not in the repository now.
    assert.deepEqual(added.events.map((event) => [event.path, formatRanges(event.ranges)]), [["src/new.ts", "1-2"]]);
  } finally {
    done();
  }
});

test("sessions are found by their folder or by naming the repository, filtered by time, and a run with none says where it looked", () => {
  const { root, done } = fixtureRepo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "carveout-homes-")));
  try {
    const homes = { claude: join(home, "claude"), codex: join(home, "codex") };
    const own = join(homes.claude, "projects", claudeProjectName(root));
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "sess-claude-1.jsonl"), fixture("claude-session.jsonl", root));
    // Started elsewhere, but it read this repository.
    const other = join(homes.claude, "projects", "-elsewhere");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "sess-2.jsonl"), fixture("claude-session.jsonl", root).replaceAll('"cwd":"', '"cwd":"/elsewhere'));
    writeFileSync(join(other, "sess-3.jsonl"), fixture("claude-session.jsonl", "/some/other/repo"));
    const day = join(homes.codex, "sessions", "2026", "11", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-11-01T10-00-00-0199aaaa.jsonl"), fixture("codex-items.jsonl", root));
    const { ctx } = contextFor(root);
    const found = findSessions({ roots: repoRoots(root), agents: ["claude", "codex"], homes, ctx });
    assert.deepEqual(found.sessions.map((session) => `${session.agent}:${session.id}`).sort(), [
      "claude:sess-2",
      "claude:sess-claude-1",
      "codex:0199aaaa-0000-7000-8000-000000000001",
    ]);
    assert.equal(findSessions({ roots: repoRoots(root), agents: ["codex"], homes, ctx }).sessions.length, 1);
    const map = buildMap({ root, homes, now: Date.parse("2026-11-18T00:00:00Z") });
    assert.equal(map.json.method.sessions, 3);
    assert.equal(map.json.agent, "Your agents");
    const latest = buildMap({ root, homes, session: "0199aaaa" });
    assert.equal(latest.json.agent, "Codex");
    assert.equal(latest.json.sessions.length, 1);
    assert.throws(() => buildMap({ root, homes, session: "nope" }), /No session nope/);
    const since = parseSince("1d", Date.parse("2026-11-18T00:00:00Z"));
    assert.ok(since !== null);
    const none = buildMap({ root, homes: { claude: join(home, "none"), codex: join(home, "none") } });
    assert.deepEqual(none.page.empty, [join(home, "none", "projects"), join(home, "none", "sessions")]);
    assert.match(renderMapHtml(none.page), /No agent sessions found for this repository/);
  } finally {
    done();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the page holds paths and ranges, never a file's contents, and its numbers are the JSON's", () => {
  const { root, done } = fixtureRepo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "carveout-homes-")));
  try {
    const homes = { claude: join(home, "claude"), codex: join(home, "codex") };
    const own = join(homes.claude, "projects", claudeProjectName(root));
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "sess-claude-1.jsonl"), fixture("claude-session.jsonl", root));
    const map = buildMap({ root, homes });
    assert.equal(map.json.totals.seenLines, 92);
    assert.equal(map.json.agent, "Claude");
    assert.ok(!map.json.files.some((file) => file.path.endsWith(".png")));
    const html = renderMapHtml(map.page);
    assert.ok(!html.includes("export const"), "no file contents in the page");
    assert.ok(!html.includes("note line"), "no file contents in the page");
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<script>[\s\S]*<\/script>/, "")), "nothing loads from the network");
    const data = pageData(map.page) as { totals: { seenLines: number }; files: number[] };
    assert.equal(data.totals.seenLines, 92);
    assert.equal(data.files.length / 3, map.json.totals.files);
    assert.equal(formatPercent(0.04), "<0.1%");
    assert.equal(formatPercent(3.84), "3.8%");
    assert.equal(formatPercent(38.4), "38%");
  } finally {
    done();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a share card in pseudonyms holds none of the repository's names", () => {
  const { root, done } = fixtureRepo("ledgerly-quote-engine");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "carveout-homes-")));
  try {
    const homes = { claude: join(home, "claude"), codex: join(home, "codex") };
    const own = join(homes.claude, "projects", claudeProjectName(root));
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "sess-claude-1.jsonl"), fixture("claude-session.jsonl", root));
    const map = buildMap({ root, homes });
    // The vocabulary a public cut scans for: the scope, the author, the checkout's name, the Git identity.
    const vocabulary = repoVocabulary(root);
    assert.ok(vocabulary.includes("ledgerly") && vocabulary.includes("ledgerly-quote-engine"), vocabulary.join(", "));
    // The real page names the repository; the card in pseudonyms must not.
    assert.ok(leaksIn(JSON.stringify(map.page.card.real) + map.page.files.map((file) => file.path).join("\n"), vocabulary));
    const share = renderMapHtml({ ...map.page, shareOnly: true }, { fonts: "" });
    const leaks = looseLeaks([{ path: "card.html", text: share }], vocabulary);
    assert.deepEqual(leaks, [], `the share page holds ${JSON.stringify(leaks)}`);
    const data = pageData({ ...map.page, shareOnly: true }) as { segs: string[]; card: { share: unknown }; repo: string };
    assert.deepEqual(looseLeaks([{ path: "", text: [...data.segs, JSON.stringify(data.card), data.repo].join("\n") }], vocabulary), []);
    // The folder named for the owner was renamed, not dropped.
    assert.equal(data.segs.length, new Set(pageData(map.page).segs as string[]).size);
  } finally {
    done();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the sample map says it is sample data everywhere it shows a number", () => {
  const map = buildMap({ root: ".", demo: true, now: Date.parse("2026-11-18T00:00:00Z") });
  assert.equal(map.json.sample, true);
  assert.match(map.page.card.share.note, /Sample data, not measured/);
  assert.ok(map.page.totals.files > 1500);
  const html = renderMapHtml(map.page, { fonts: "" });
  assert.match(html, /SAMPLE DATA · not measured/);
});

test("a 50,000-file repository maps within the time and size budget", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "carveout-map-big-")));
  const root = join(base, "big");
  const home = join(base, "home");
  try {
    const count = 49_990;
    let made = 0;
    for (let d = 0; made < count; d++) {
      const dir = join(root, `pkg-${d % 40}`, `mod-${d}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 100 && made < count; f++, made++) writeFileSync(join(dir, `file-${f}.ts`), lines(5 + ((d * 7 + f) % 60), (i) => `export const v${i} = ${i};`));
    }
    // One session that read 400 files of it.
    const own = join(home, "claude", "projects", claudeProjectName(root));
    mkdirSync(own, { recursive: true });
    const records: string[] = [];
    for (let k = 0; k < 400; k++) {
      const path = join(root, `pkg-${k % 40}`, `mod-${k}`, `file-${k % 100}.ts`);
      records.push(JSON.stringify({ type: "assistant", cwd: root, timestamp: new Date(1_790_000_000_000 + k * 1000).toISOString(), message: { content: [{ type: "tool_use", id: `t${k}`, name: "Read", input: { file_path: path } }] } }));
      records.push(JSON.stringify({ type: "user", cwd: root, timestamp: new Date(1_790_000_000_000 + k * 1000).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: `t${k}`, content: "" }] }, toolUseResult: { type: "text", file: { filePath: path, startLine: 1, numLines: 5, totalLines: 5 } } }));
    }
    writeFileSync(join(own, "big.jsonl"), `${records.join("\n")}\n`);
    const started = Date.now();
    const map = buildMap({ root, homes: { claude: join(home, "claude"), codex: join(home, "codex") }, sliceBudgetMs: 0 });
    const html = renderMapHtml(map.page);
    const ms = Date.now() - started;
    t.diagnostic(`50k files: ${map.json.totals.files} files, ${map.json.totals.lines} lines, ${ms} ms (files ${map.timings.filesMs} ms, logs ${map.timings.logsMs} ms, names ${map.timings.namesMs} ms), HTML ${(html.length / 1024 / 1024).toFixed(2)} MB`);
    assert.equal(map.json.totals.files, count);
    assert.equal(map.json.totals.filesSeen, 400);
    assert.ok(ms < 60_000, `took ${ms} ms`);
    assert.ok(html.length < 8 * 1024 * 1024, `HTML is ${html.length} bytes`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
