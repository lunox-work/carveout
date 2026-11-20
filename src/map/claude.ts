/**
 * Claude Code's session logs (`~/.claude/projects/<cwd, every
 * non-alphanumeric character a dash>/<session>.jsonl`, a subagent's under
 * `<session>/subagents/`): one JSON record per line. An assistant record's
 * `tool_use` blocks name the call; the user record that answers it holds a
 * `tool_result` block and, beside it, `toolUseResult`, the tool's own
 * account of what it returned:
 *
 * - Read: `file.startLine` and `file.numLines`, the lines that came back;
 *   else the call's `offset` and `limit` (2000 lines by default).
 * - Edit, MultiEdit, Write: `structuredPatch` hunks (`newStart`,
 *   `newLines`, lines marked `+`, `-` or ` `); a Write that created the
 *   file, its `content` whole.
 * - Grep with `output_mode: "content"`: the lines it printed.
 * - Bash: the command, the record's `cwd`, and its output (`shell.ts`).
 *
 * A call with no result, or an error result, is not counted: only what
 * came back entered the model's context. Glob returns names alone.
 */

import { matchOutput, shellReads, type ParseContext } from "./shell.js";
import { unionRanges, type Range } from "./ranges.js";

export type SeenKind = "read" | "inferred" | "edit";

/** Lines of one repository file one tool call put in front of the model. */
export interface SeenEvent {
  /** Milliseconds since the epoch, when the result came back. */
  readonly at: number;
  readonly path: string;
  readonly kind: SeenKind;
  /** The tool: `Read`, `Grep`, `Edit`, `Bash: sed`, `exec: cat`, `apply_patch`. */
  readonly tool: string;
  /** The lines seen (an edit's: the hunk the tool showed back). */
  readonly ranges: Range[];
  /** An edit's changed lines, in the file after it. */
  readonly edited?: Range[];
}

export interface ParsedSession {
  readonly agent: "claude" | "codex";
  readonly id: string;
  /** The log files read, absolute. */
  readonly files: readonly string[];
  readonly cwd: string | null;
  readonly start: number | null;
  readonly end: number | null;
  readonly title: string | null;
  readonly events: SeenEvent[];
  /** Calls whose file is in the repository but whose lines could not be told. */
  readonly unplaced: number;
}

interface Hunk {
  readonly newStart: number;
  readonly newLines: number;
  readonly lines?: readonly string[];
}

/** A hunk's lines in the file after it, and those of them it added. */
export function hunkRanges(hunks: readonly Hunk[]): { readonly seen: Range[]; readonly edited: Range[] } {
  const seen: Range[] = [];
  const edited: Range[] = [];
  for (const hunk of hunks) {
    if (hunk.newLines > 0) seen.push([hunk.newStart, hunk.newStart + hunk.newLines - 1]);
    let line = hunk.newStart;
    let removedAt: number | null = null;
    for (const text of hunk.lines ?? []) {
      if (text.startsWith("+")) {
        edited.push([line, line]);
        line++;
      } else if (text.startsWith("-")) removedAt = line;
      else if (text.startsWith("\\")) continue;
      else line++;
    }
    // A hunk that only removes lines changed the file where they were.
    if (removedAt !== null && !(hunk.lines ?? []).some((text) => text.startsWith("+")))
      edited.push([Math.max(1, removedAt - 1), Math.max(1, removedAt)]);
  }
  return { seen: unionRanges(seen), edited: unionRanges(edited) };
}

/** `@@ -a,b +c,d @@` hunks of a unified diff, as `structuredPatch` writes them. */
export function unifiedHunks(diff: string): Hunk[] {
  const hunks: { newStart: number; newLines: number; lines: string[] }[] = [];
  for (const line of diff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) hunks.push({ newStart: Number(header[1]), newLines: header[2] === undefined ? 1 : Number(header[2]), lines: [] });
    else if (hunks.length > 0 && /^[ +\-\\]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
      hunks[hunks.length - 1]?.lines.push(line);
  }
  return hunks;
}

/** Where a block of text sits in a file now: the lines it spans, or null when it is not there. */
export function locateText(lines: readonly string[], text: string): Range | null {
  if (text === "") return null;
  const want = text.split("\n");
  const first = want.findIndex((line) => line.trim().length >= 4);
  if (first === -1) return null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== want[first]) continue;
    const start = i - first;
    if (start < 0) continue;
    let ok = true;
    for (let k = 0; k < want.length && ok; k++) if ((lines[start + k] ?? null) !== want[k]) ok = false;
    if (ok) return [start + 1, start + want.length];
  }
  return null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A tool_result block's text: a string, or its text parts joined. */
function resultText(block: Record<string, unknown>): string {
  const content = block["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => asString(asRecord(part)?.["text"]) ?? "")
      .filter(Boolean)
      .join("\n");
  return "";
}

/** `cat -n` style lines (`  12\ttext`, as Read and Grep print) without their numbers. */
const stripNumbers = (text: string) => text.replace(/^\s*\d+\t/gm, "");

interface Pending {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly cwd: string | null;
  readonly sidechain: boolean;
}

/**
 * The repository lines one Claude Code session put in front of the model,
 * call by call. `texts` are the session's log and its subagents' logs.
 */
export function parseClaudeSession(
  id: string,
  logs: readonly { readonly file: string; readonly text: string }[],
  ctx: ParseContext,
): ParsedSession {
  const events: SeenEvent[] = [];
  let cwd: string | null = null;
  let start: number | null = null;
  let end: number | null = null;
  let title: string | null = null;
  let unplaced = 0;
  for (const log of logs) {
    const pending = new Map<string, Pending>();
    for (const line of log.text.split("\n")) {
      if (line.trim() === "") continue;
      let record: Record<string, unknown> | null;
      try {
        record = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (record === null) continue;
      const at = Date.parse(asString(record["timestamp"]) ?? "");
      if (Number.isFinite(at)) {
        start = start === null ? at : Math.min(start, at);
        end = end === null ? at : Math.max(end, at);
      }
      const recordCwd = asString(record["cwd"]);
      if (cwd === null && recordCwd !== null && record["isSidechain"] !== true) cwd = recordCwd;
      if (record["type"] === "ai-title" || record["type"] === "summary") title = asString(record["aiTitle"]) ?? asString(record["title"]) ?? asString(record["summary"]) ?? title;
      const message = asRecord(record["message"]);
      const content = message?.["content"];
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const block = asRecord(part);
        if (block === null) continue;
        if (block["type"] === "tool_use") {
          const callId = asString(block["id"]);
          const name = asString(block["name"]);
          const input = asRecord(block["input"]);
          if (callId !== null && name !== null && input !== null)
            pending.set(callId, { name, input, cwd: recordCwd, sidechain: record["isSidechain"] === true });
          continue;
        }
        if (block["type"] !== "tool_result") continue;
        const call = pending.get(asString(block["tool_use_id"]) ?? "");
        if (call === undefined || block["is_error"] === true) continue;
        pending.delete(asString(block["tool_use_id"]) ?? "");
        const result = asRecord(record["toolUseResult"]);
        const when = Number.isFinite(at) ? at : (end ?? 0);
        const placed = callEvents(call, result, resultText(block), when, ctx);
        if (placed === null) unplaced++;
        else events.push(...placed);
      }
    }
  }
  return { agent: "claude", id, files: logs.map((log) => log.file), cwd, start, end, title, events, unplaced };
}

/** The events of one answered call; null when its file is the repository's but its lines cannot be told. */
function callEvents(
  call: Pending,
  result: Record<string, unknown> | null,
  text: string,
  at: number,
  ctx: ParseContext,
): SeenEvent[] | null {
  const { name, input } = call;
  const tool = call.sidechain ? `${name} (subagent)` : name;
  const repoPath = (value: unknown) => {
    const absolute = asString(value);
    return absolute === null ? null : ctx.relative(absolute);
  };
  switch (name) {
    case "Read": {
      const path = repoPath(input["file_path"]);
      if (path === null) return [];
      const lines = ctx.lines(path);
      const file = asRecord(result?.["file"]);
      if (result !== null && result["type"] !== undefined && result["type"] !== "text") return [];
      const startLine = asNumber(file?.["startLine"]);
      const numLines = asNumber(file?.["numLines"]);
      if (startLine !== null && numLines !== null)
        return numLines === 0 ? [] : [{ at, path, kind: "read", tool, ranges: unionRanges([[startLine, startLine + numLines - 1]], lines?.length) }];
      if (lines === null) return null;
      const offset = asNumber(input["offset"]) ?? 1;
      const limit = asNumber(input["limit"]) ?? 2000;
      // The text that came back says how far it went when the tool's account is missing.
      const shown = text.split("\n").filter((line) => /^\s*\d+\t/.test(line)).length;
      const count = shown > 0 ? Math.min(shown, limit) : limit;
      return [{ at, path, kind: "read", tool, ranges: unionRanges([[offset, offset + count - 1]], lines.length) }];
    }
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const path = repoPath(input["file_path"]);
      if (path === null) return [];
      const lines = ctx.lines(path);
      const hunks = Array.isArray(result?.["structuredPatch"]) ? (result?.["structuredPatch"] as Hunk[]) : null;
      if (name === "Write" && (result?.["type"] === "create" || hunks === null || hunks.length === 0)) {
        const written = asString(input["content"]) ?? asString(result?.["content"]) ?? "";
        const count = written === "" ? 0 : written.split("\n").length - (written.endsWith("\n") ? 1 : 0);
        if (count === 0) return [];
        const all: Range[] = unionRanges([[1, count]], lines?.length);
        return [{ at, path, kind: "edit", tool, ranges: all, edited: all }];
      }
      if (hunks !== null && hunks.length > 0) {
        const { seen, edited } = hunkRanges(hunks);
        return [{ at, path, kind: "edit", tool, ranges: unionRanges(seen, lines?.length), edited: unionRanges(edited, lines?.length) }];
      }
      // No patch kept: where each new text now sits, when it is still there.
      if (lines === null) return null;
      const edits = name === "MultiEdit" && Array.isArray(input["edits"]) ? (input["edits"] as unknown[]).map(asRecord) : [input];
      const found = edits.flatMap((edit) => {
        const range = locateText(lines, asString(edit?.["new_string"]) ?? "");
        return range === null ? [] : [range];
      });
      if (found.length === 0) return null;
      const ranges = unionRanges(found);
      return [{ at, path, kind: "edit", tool, ranges, edited: ranges }];
    }
    case "Grep": {
      if (input["output_mode"] !== "content") return [];
      const output = asString(result?.["content"]) ?? text;
      const searched = asString(input["path"]);
      const base = call.cwd ?? "";
      const single = searched === null ? null : ctx.relative(searched.startsWith("/") ? searched : `${base}/${searched}`);
      const singleFile = single !== null && ctx.lines(single) !== null ? single : null;
      return grepEvents(output, singleFile, call.cwd, at, tool, ctx);
    }
    case "Bash": {
      const command = asString(input["command"]);
      if (command === null) return [];
      const stdout = asString(result?.["stdout"]);
      const stderr = asString(result?.["stderr"]) ?? "";
      // When the model was shown a preview of a long output (set aside in a
      // file), the preview is what it saw, whatever stdout kept.
      const output = stdout === null || /<persisted-output>|Output too large/.test(text) ? text : `${stdout}\n${stderr}`;
      return shellReads(command, call.cwd, output, ctx).map((read) => ({
        at,
        path: read.path,
        kind: "inferred" as const,
        tool: `${tool}: ${read.program}`,
        ranges: read.ranges,
      }));
    }
    default:
      return [];
  }
}

/** Grep's content output: `path:12:text`, `path-12-text` (context), `12:text` (one file), or without numbers. */
function grepEvents(
  output: string,
  single: string | null,
  cwd: string | null,
  at: number,
  tool: string,
  ctx: ParseContext,
): SeenEvent[] {
  const byPath = new Map<string, { ranges: Range[]; texts: string[] }>();
  const entry = (path: string) => {
    let found = byPath.get(path);
    if (found === undefined) {
      found = { ranges: [], texts: [] };
      byPath.set(path, found);
    }
    return found;
  };
  const resolve = (word: string) => {
    const path = ctx.relative(word.startsWith("/") ? word : `${cwd ?? ""}/${word}`);
    return path !== null && ctx.lines(path) !== null ? path : null;
  };
  for (const line of output.split("\n").slice(0, 20_000)) {
    if (line === "" || line === "--" || /^Found \d+ (?:files?|lines?)/.test(line)) continue;
    const numbered = /^(.+?)([:-])(\d+)\2(.*)$/.exec(line);
    const numberedPath = numbered === null ? null : resolve(numbered[1] ?? "");
    if (numbered !== null && numberedPath !== null) {
      entry(numberedPath).ranges.push([Number(numbered[3]), Number(numbered[3])]);
      continue;
    }
    const bare = /^(\d+)[:-](.*)$/.exec(line);
    if (bare !== null && single !== null) {
      entry(single).ranges.push([Number(bare[1]), Number(bare[1])]);
      continue;
    }
    const named = /^(.+?):(.*)$/.exec(line);
    const namedPath = named === null ? null : resolve(named[1] ?? "");
    if (named !== null && namedPath !== null) {
      entry(namedPath).texts.push(named[2] ?? "");
      continue;
    }
    if (single !== null) entry(single).texts.push(line);
  }
  const events: SeenEvent[] = [];
  for (const [path, found] of byPath) {
    const lines = ctx.lines(path);
    if (lines === null) continue;
    const ranges = unionRanges([...found.ranges, ...matchOutput(lines, stripNumbers(found.texts.join("\n")))], lines.length);
    if (ranges.length > 0) events.push({ at, path, kind: "read", tool, ranges });
  }
  return events;
}
