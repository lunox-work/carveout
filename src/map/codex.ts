/**
 * Codex's session logs (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`):
 * one record per line, `{ timestamp, type, payload }`. Codex reads files
 * through its shell, so every read here is inferred (`shell.ts`); its
 * edits are patches. Three generations of the format are read, the newest
 * a log holds and only that one, so a call is never counted twice:
 *
 * - `event_msg` `item_completed` items (Codex Desktop, CLI 0.160):
 *   `CommandExecution` (`command`, `cwd` as a `file://` URL,
 *   `aggregated_output`) and `FileChange` (`changes`: per path `add` with
 *   `content`, `update` with `unified_diff`, `delete`).
 * - `event_msg` `exec_command_end` (`command`, `cwd`, `aggregated_output`)
 *   and `patch_apply_begin` (`changes`).
 * - `response_item` `function_call` named `shell`, `exec_command` or
 *   `shell_command` (JSON `arguments` with `command` and `workdir`) with its
 *   `function_call_output`, and `custom_tool_call` `apply_patch` (the
 *   patch's text) with its output.
 */

import { fileURLToPath } from "node:url";
import { hunkRanges, locateText, unifiedHunks, type ParsedSession, type SeenEvent } from "./claude.js";
import { unionRanges, type Range } from "./ranges.js";
import { shellReads, type ParseContext } from "./shell.js";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A command as Codex logs it, an argv or a string: the shell line it ran. */
function commandLine(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const argv = value.filter((each): each is string => typeof each === "string");
  // `["/bin/zsh", "-lc", "<line>"]`, `["bash", "-c", "<line>"]`.
  const flag = argv.findIndex((arg) => /^-\w*c$/.test(arg));
  if (flag !== -1 && argv[flag + 1] !== undefined && /(?:^|\/)(?:ba|z|da|k|fi)?sh$/.test(argv[0] ?? "")) return argv[flag + 1] ?? null;
  return argv.map((arg) => (/[\s'"]/.test(arg) ? `'${arg.replaceAll("'", "'\\''")}'` : arg)).join(" ");
}

const folderOf = (value: unknown): string | null => {
  const text = asString(value);
  if (text === null) return null;
  if (text.startsWith("file://"))
    try {
      return fileURLToPath(text);
    } catch {
      return null;
    }
  return text;
};

/** An output as logged: a string, `{ output }` JSON, or text parts. */
function outputText(value: unknown): string | null {
  if (typeof value === "string") {
    try {
      const parsed = asRecord(JSON.parse(value));
      const inner = asString(parsed?.["output"]);
      if (inner !== null) return inner;
    } catch {
      // Plain text.
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((part) => asString(asRecord(part)?.["text"]) ?? "").join("\n");
  const record = asRecord(value);
  return asString(record?.["output"]) ?? asString(record?.["content"]);
}

/** One file's change, in any of the shapes Codex has logged it. */
function changeEvents(path: string, change: Record<string, unknown>, at: number, ctx: ParseContext, tool: string): SeenEvent[] | null {
  const relative = ctx.relative(path);
  if (relative === null) return [];
  const lines = ctx.lines(relative);
  const add = asRecord(change["add"]);
  const update = asRecord(change["update"]);
  const kind = asString(change["type"]) ?? (add !== null ? "add" : update !== null ? "update" : change["delete"] !== undefined ? "delete" : null);
  if (kind === "delete") return [];
  if (kind === "add") {
    const content = asString(change["content"]) ?? asString(add?.["content"]) ?? "";
    const count = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    if (count === 0) return [];
    const all = unionRanges([[1, count]], lines?.length);
    return [{ at, path: relative, kind: "edit", tool, ranges: all, edited: all }];
  }
  const diff = asString(change["unified_diff"]) ?? asString(update?.["unified_diff"]);
  if (diff !== null) {
    const moved = asString(change["move_path"]) ?? asString(update?.["move_path"]);
    const target = moved === null ? relative : ctx.relative(moved);
    if (target === null) return [];
    const { seen, edited } = hunkRanges(unifiedHunks(diff));
    const size = ctx.lines(target)?.length;
    return [{ at, path: target, kind: "edit", tool, ranges: unionRanges(seen, size), edited: unionRanges(edited, size) }];
  }
  return lines === null ? null : [];
}

/**
 * An `apply_patch` envelope's files: `*** Add File:` with its `+` lines,
 * `*** Update File:` (and `*** Move to:`) with hunks of ` `, `+` and `-`
 * lines and no line numbers, found where they now sit in the file.
 */
export function applyPatchEvents(patch: string, cwd: string | null, at: number, ctx: ParseContext): { events: SeenEvent[]; unplaced: number } {
  const events: SeenEvent[] = [];
  let unplaced = 0;
  const sections = patch.split(/^(?=\*\*\* (?:Add|Update|Delete) File: )/m);
  const resolve = (word: string) => ctx.relative(word.startsWith("/") ? word : `${cwd ?? ""}/${word}`);
  for (const section of sections) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/m.exec(section);
    if (header === null || header[1] === "Delete") continue;
    const moved = /^\*\*\* Move to: (.+)$/m.exec(section)?.[1];
    const path = resolve((moved ?? header[2] ?? "").trim());
    if (path === null) continue;
    const lines = ctx.lines(path);
    const body = section.split("\n").slice(1).filter((line) => !line.startsWith("*** "));
    // The newline that ends the envelope is no line of the file.
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    if (header[1] === "Add") {
      const count = body.filter((line) => line.startsWith("+")).length;
      if (count === 0) continue;
      const all = unionRanges([[1, count]], lines?.length);
      events.push({ at, path, kind: "edit", tool: "apply_patch", ranges: all, edited: all });
      continue;
    }
    if (lines === null) {
      unplaced++;
      continue;
    }
    const seen: Range[] = [];
    const edited: Range[] = [];
    const hunks: string[][] = [[]];
    for (const line of body) {
      if (line.startsWith("@@")) hunks.push([]);
      else hunks[hunks.length - 1]?.push(line);
    }
    for (const hunk of hunks) {
      const after = hunk.filter((line) => !line.startsWith("-"));
      if (after.length === 0) continue;
      const located = locateText(lines, after.map((line) => line.slice(1)).join("\n"));
      if (located === null) continue;
      seen.push(located);
      after.forEach((line, i) => {
        if (line.startsWith("+")) edited.push([located[0] + i, located[0] + i]);
      });
    }
    if (seen.length === 0) unplaced++;
    else events.push({ at, path, kind: "edit", tool: "apply_patch", ranges: unionRanges(seen), edited: unionRanges(edited) });
  }
  return { events, unplaced };
}

/** The repository lines one Codex rollout put in front of the model. */
export function parseCodexSession(file: string, text: string, ctx: ParseContext): ParsedSession {
  const records: { at: number; type: string; payload: Record<string, unknown> }[] = [];
  let id: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;
  let start: number | null = null;
  let end: number | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    const payload = asRecord(record?.["payload"]);
    if (record === null || payload === null) continue;
    const at = Date.parse(asString(record["timestamp"]) ?? "");
    if (Number.isFinite(at)) {
      start = start === null ? at : Math.min(start, at);
      end = end === null ? at : Math.max(end, at);
    }
    const type = asString(record["type"]) ?? "";
    if (type === "session_meta") {
      id = asString(payload["id"]) ?? asString(payload["session_id"]) ?? id;
      cwd = folderOf(payload["cwd"]) ?? cwd;
    }
    if (type === "turn_context" && cwd === null) cwd = folderOf(payload["cwd"]);
    if (type === "event_msg" && payload["type"] === "thread_name_updated") title = asString(payload["thread_name"]) ?? title;
    records.push({ at: Number.isFinite(at) ? at : (end ?? 0), type, payload });
  }
  const itemOf = (record: (typeof records)[number]) =>
    record.type === "event_msg" && record.payload["type"] === "item_completed" ? asRecord(record.payload["item"]) : null;
  const generation = records.some((record) => {
    const item = itemOf(record);
    return item?.["type"] === "CommandExecution" || item?.["type"] === "FileChange";
  })
    ? "items"
    : records.some((record) => record.type === "event_msg" && (record.payload["type"] === "exec_command_end" || record.payload["type"] === "patch_apply_begin"))
      ? "events"
      : "calls";
  const events: SeenEvent[] = [];
  let unplaced = 0;
  let turnCwd = cwd;
  const shell = (command: string | null, folder: string | null, output: string | null, at: number, tool: string) => {
    if (command === null) return;
    for (const read of shellReads(command, folder ?? turnCwd, output, ctx))
      events.push({ at, path: read.path, kind: "inferred", tool: `${tool}: ${read.program}`, ranges: read.ranges });
  };
  const changes = (value: unknown, at: number, tool: string) => {
    const map = asRecord(value);
    if (map === null) return;
    for (const [path, change] of Object.entries(map)) {
      const record = asRecord(change);
      if (record === null) continue;
      const placed = changeEvents(path.startsWith("/") ? path : `${turnCwd ?? ""}/${path}`, record, at, ctx, tool);
      if (placed === null) unplaced++;
      else events.push(...placed);
    }
  };
  const calls = new Map<string, { name: string; input: string; at: number }>();
  for (const record of records) {
    if (record.type === "turn_context") turnCwd = folderOf(record.payload["cwd"]) ?? turnCwd;
    if (generation === "items") {
      const item = itemOf(record);
      if (item?.["type"] === "CommandExecution")
        shell(commandLine(item["command"]), folderOf(item["cwd"]), asString(item["aggregated_output"]) ?? asString(item["stdout"]), record.at, "shell");
      else if (item?.["type"] === "FileChange") changes(item["changes"], record.at, "patch");
    } else if (generation === "events" && record.type === "event_msg") {
      if (record.payload["type"] === "exec_command_end")
        shell(
          commandLine(record.payload["command"]),
          folderOf(record.payload["cwd"]),
          asString(record.payload["aggregated_output"]) ?? asString(record.payload["formatted_output"]) ?? asString(record.payload["stdout"]),
          record.at,
          "shell",
        );
      else if (record.payload["type"] === "patch_apply_begin") changes(record.payload["changes"], record.at, "patch");
    } else if (generation === "calls" && record.type === "response_item") {
      const kind = record.payload["type"];
      const callId = asString(record.payload["call_id"]) ?? "";
      if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
        const name = asString(record.payload["name"]) ?? (kind === "local_shell_call" ? "local_shell" : "");
        const input =
          asString(record.payload["arguments"]) ?? asString(record.payload["input"]) ?? JSON.stringify(record.payload["action"] ?? {});
        calls.set(callId, { name, input, at: record.at });
      } else if (kind === "function_call_output" || kind === "custom_tool_call_output" || kind === "local_shell_call_output") {
        const call = calls.get(callId);
        if (call === undefined) continue;
        calls.delete(callId);
        const output = outputText(record.payload["output"]);
        if (call.name === "apply_patch") {
          const placed = applyPatchEvents(call.input, turnCwd, record.at, ctx);
          events.push(...placed.events);
          unplaced += placed.unplaced;
          continue;
        }
        if (!["shell", "exec_command", "shell_command", "local_shell", "container.exec"].includes(call.name)) continue;
        let args: Record<string, unknown> | null = null;
        try {
          args = asRecord(JSON.parse(call.input));
        } catch {
          continue;
        }
        const command = commandLine(args?.["command"] ?? args?.["cmd"]);
        // apply_patch run through the shell, as early Codex did.
        if (command !== null && /^\s*apply_patch\b/.test(command)) {
          const placed = applyPatchEvents(command.replace(/^\s*apply_patch\s*/, ""), folderOf(args?.["workdir"]) ?? turnCwd, record.at, ctx);
          events.push(...placed.events);
          unplaced += placed.unplaced;
          continue;
        }
        shell(command, folderOf(args?.["workdir"] ?? args?.["cwd"]), output, record.at, call.name);
      }
    }
  }
  return {
    agent: "codex",
    id: id ?? (/rollout-.*?([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/.exec(file)?.[1] ?? file),
    files: [file],
    cwd,
    start,
    end,
    title,
    events,
    unplaced,
  };
}
