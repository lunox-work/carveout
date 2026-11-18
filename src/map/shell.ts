/**
 * Reads inferred from a shell command: `cat`, `sed -n`, `head`, `tail`,
 * `nl`, `awk 'NR..'`, `grep` and `rg`, as an agent's shell tool runs them.
 * Best effort, and labelled inferred apart from an agent's own file tools:
 * a shell's words are parsed, not run, and what a pipeline or a truncated
 * output kept is matched against the output that came back.
 */

import { posix } from "node:path";
import { unionRanges, type Range } from "./ranges.js";

/** What a parser can ask of the repository. */
export interface ParseContext {
  /** The repository path (`/`-separated, relative) of an absolute path, or null outside the repository. */
  relative(absolute: string): string | null;
  /** A repository file's lines as they are now, or null when it is not one. */
  lines(path: string): readonly string[] | null;
}

/** Lines of one repository file a command showed. */
export interface ShellRead {
  readonly path: string;
  readonly ranges: Range[];
  /** The program that showed them: `sed`, `cat`, `rg`. */
  readonly program: string;
}

type Token = { readonly word: string } | { readonly op: string };

/** A shell line's words and operators: quotes and escapes undone, `$(...)` and heredoc bodies dropped. */
export function shellTokens(command: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const push = () => {
    if (inWord) tokens.push({ word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end === -1 ? undefined : end);
      inWord = true;
      i = end === -1 ? command.length : end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) j++;
        word += command[j] ?? "";
        j++;
      }
      inWord = true;
      i = j;
    } else if (c === "\\" && i + 1 < command.length) {
      if (command[i + 1] !== "\n") word += command[i + 1] ?? "";
      inWord = inWord || command[i + 1] !== "\n";
      i++;
    } else if (c === "$" && command[i + 1] === "(") {
      // A command substitution's words are not this command's.
      let depth = 0;
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")" && --depth === 0) break;
      }
      word += "$()";
      inWord = true;
      i = j;
    } else if (c === "<" && command[i + 1] === "<") {
      // A heredoc: its body is text, not commands.
      push();
      const rest = command.slice(i + 2).replace(/^[-~]?\s*/, "");
      const tag = /^['"]?([A-Za-z_][\w]*)['"]?/.exec(rest)?.[1];
      if (tag === undefined) {
        i++;
        continue;
      }
      const lineEnd = command.indexOf("\n", i);
      const close = lineEnd === -1 ? -1 : command.indexOf(`\n${tag}`, lineEnd);
      tokens.push({ op: "<<" });
      if (lineEnd !== -1) {
        // What follows the tag on its own line still runs (`<<EOF > file`).
        const tail = command.slice(i + 2, lineEnd).replace(/^[-~]?\s*['"]?[A-Za-z_]\w*['"]?/, "");
        tokens.push(...shellTokens(tail));
      }
      // The tag's own line ends the command: the newline after it is read next.
      i = close === -1 ? command.length : close + tag.length;
    } else if (c === "#" && !inWord) {
      const end = command.indexOf("\n", i);
      i = end === -1 ? command.length : end - 1;
    } else if (c === "\n" || c === ";") {
      push();
      tokens.push({ op: ";" });
    } else if (c === "&" || c === "|") {
      push();
      if (command[i + 1] === c) {
        tokens.push({ op: c + c });
        i++;
      } else if (c === "&" && command[i + 1] === ">") {
        tokens.push({ op: ">" });
        i++;
      } else tokens.push({ op: c === "|" ? "|" : ";" });
    } else if (c === ">" || c === "<") {
      // `2>&1`, `>file`, `>>file`: the descriptor is no word of the command.
      if (/^\d$/.test(word) && inWord) {
        word = "";
        inWord = false;
      }
      push();
      let op = c;
      if (command[i + 1] === c) {
        op += c;
        i++;
      }
      if (command[i + 1] === "&") {
        i++;
        while (/\d|-/.test(command[i + 1] ?? "")) i++;
        continue;
      }
      tokens.push({ op });
    } else if (/\s/.test(c)) push();
    else if ((c === "(" || c === ")" || c === "{" || c === "}") && !inWord) {
      push();
      tokens.push({ op: ";" });
    } else {
      word += c;
      inWord = true;
    }
  }
  push();
  return tokens;
}

/** A pipeline's stages, each its words with redirections taken out; `cd` kept as a stage. */
interface Stage {
  readonly argv: string[];
}
interface Pipeline {
  readonly stages: Stage[];
}

function pipelines(tokens: readonly Token[]): Pipeline[] {
  const out: Pipeline[] = [];
  let stages: Stage[] = [];
  let argv: string[] = [];
  let redirect = false;
  const endStage = () => {
    if (argv.length > 0) stages.push({ argv });
    argv = [];
  };
  const endPipeline = () => {
    endStage();
    if (stages.length > 0) out.push({ stages });
    stages = [];
  };
  for (const token of tokens) {
    if ("word" in token) {
      if (redirect) redirect = false;
      else argv.push(token.word);
    } else if (token.op === "|") endStage();
    else if (token.op === ">" || token.op === ">>" || token.op === "<") redirect = true;
    else if (token.op === "<<") redirect = false;
    else endPipeline();
  }
  endPipeline();
  return out;
}

/** Programs that print the files they are given, whole. */
const WHOLE = new Set(["cat", "bat", "batcat", "less", "more", "nl", "view", "jq", "yq", "type"]);
/** Programs whose output says nothing of a file's lines. */
const SILENT = new Set(["wc", "stat", "file", "ls", "test", "du", "md5sum", "shasum", "sha256sum", "touch", "mkdir", "rm", "cp", "mv", "chmod", "true", "false", "echo", "printf", "git"]);
/** Wrappers whose arguments are another command. */
const WRAPPERS = new Set(["sudo", "command", "nice", "time", "env", "xargs", "timeout", "nohup"]);

/** A program's name without its folder: `/usr/bin/sed` is `sed`. */
const programOf = (word: string) => posix.basename(word);

/** `sed -n` scripts: `10,20p`, `5p`, `1,40p;90,99p`; null when the script does more than print lines. */
function sedRanges(script: string): Range[] | null {
  const ranges: Range[] = [];
  for (const part of script.split(/[;\n]/).map((each) => each.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*,\s*(\d+|\$))?\s*p$/.exec(part);
    if (match === null) return null;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : match[2] === "$" ? Number.MAX_SAFE_INTEGER : Number(match[2]);
    ranges.push([start, end]);
  }
  return ranges;
}

/** `awk 'NR>=10 && NR<=20'`, `awk 'NR==5'`, `awk 'NR>3'`: null for any other program. */
function awkRanges(program: string): Range[] | null {
  const text = program.replace(/\s+/g, "");
  const equal = /^NR==(\d+)(?:\{print\$?0?;?\})?$/.exec(text);
  if (equal !== null) return [[Number(equal[1]), Number(equal[1])]];
  const between = /^NR>(=?)(\d+)&&NR<(=?)(\d+)(?:\{print\$?0?;?\})?$/.exec(text);
  if (between !== null) {
    const start = Number(between[2]) + (between[1] === "=" ? 0 : 1);
    const end = Number(between[4]) - (between[3] === "=" ? 0 : 1);
    return [[start, end]];
  }
  const from = /^NR>(=?)(\d+)(?:\{print\$?0?;?\})?$/.exec(text);
  if (from !== null) return [[Number(from[2]) + (from[1] === "=" ? 0 : 1), Number.MAX_SAFE_INTEGER]];
  return null;
}

/** A `-n 40`, `-n40`, `-40`, `--lines=40` count; `+N` for tail's from-line form. */
function countOption(argv: readonly string[]): { readonly count: number; readonly from: boolean; readonly files: string[] } | null {
  let count = 10;
  let from = false;
  const files: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    let value: string | undefined;
    if (arg === "-n" || arg === "--lines") value = argv[++i];
    else if (arg.startsWith("--lines=")) value = arg.slice(8);
    else if (/^-n[+]?\d+$/.test(arg)) value = arg.slice(2);
    else if (/^-\d+$/.test(arg)) value = arg.slice(1);
    else if (arg === "-c" || arg === "--bytes" || arg.startsWith("--bytes=") || /^-c\d+$/.test(arg)) return null;
    else if (arg.startsWith("-") && arg !== "-") continue;
    else files.push(arg);
    if (value !== undefined) {
      from = value.startsWith("+");
      count = Number(value.replace(/^[+-]/, ""));
      if (!Number.isFinite(count)) return null;
    }
  }
  return { count, from, files };
}

interface Candidate {
  readonly path: string;
  /** The lines the command asks for; null when the output alone says (grep, a pipeline). */
  readonly ranges: Range[] | "whole" | { readonly tail: number } | null;
  readonly program: string;
}

/** Options of grep and rg that take a value. */
const GREP_VALUE_OPTIONS = new Set([
  "-e", "-f", "-m", "-A", "-B", "-C", "-g", "-t", "-T", "--glob", "--type", "--type-not", "--max-count",
  "--after-context", "--before-context", "--context", "--regexp", "--file", "--include", "--exclude", "--exclude-dir",
  "-d", "-D", "--color", "--colour", "-M", "--max-columns", "--max-depth", "--sort", "--sortr", "-j", "--threads",
]);

/** The files a grep or rg names, and whether it prints matching lines at all. */
function grepTargets(argv: readonly string[]): { readonly paths: string[]; readonly prints: boolean } {
  let prints = true;
  let pattern = false;
  const paths: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      paths.push(...argv.slice(i + (pattern ? 1 : 2)));
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0] ?? arg;
      if (["--files-with-matches", "--files-without-match", "--count", "--quiet", "--files", "--count-matches", "--type-list", "--stats"].includes(name)) prints = false;
      if (name === "--regexp" || name === "--file") pattern = true;
      if (GREP_VALUE_OPTIONS.has(name) && !arg.includes("=")) i++;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const letters = arg.slice(1);
      if (/[lLcq]/.test(letters.replace(/[A-Z]\d*$/, "")) && !/^[ABCmMtTgdDj]/.test(letters)) prints = false;
      if (letters.includes("e") || letters.includes("f")) pattern = true;
      if (GREP_VALUE_OPTIONS.has(`-${letters.slice(-1)}`) && !/\d$/.test(letters)) i++;
      continue;
    }
    if (!pattern) {
      pattern = true;
      continue;
    }
    paths.push(arg);
  }
  return { paths, prints };
}

/** The candidates one pipeline's first stage reads, before its output is consulted. */
function stageCandidates(argv: readonly string[], resolve: (word: string) => string | null): Candidate[] {
  let args = [...argv];
  while (args.length > 1 && WRAPPERS.has(programOf(args[0] ?? ""))) {
    args = args.slice(1);
    while (args.length > 1 && (args[0]?.startsWith("-") === true || /^\w+=/.test(args[0] ?? ""))) args = args.slice(1);
  }
  while (args.length > 1 && /^\w+=/.test(args[0] ?? "")) args = args.slice(1);
  const program = programOf(args[0] ?? "");
  const files = (words: readonly string[]) =>
    words.flatMap((word) => {
      const path = resolve(word);
      return path === null ? [] : [path];
    });
  if (WHOLE.has(program)) {
    const words = args.slice(1).filter((arg) => !arg.startsWith("-") || arg === "-");
    return files(words).map((path) => ({ path, ranges: "whole" as const, program }));
  }
  if (program === "head" || program === "tail") {
    const option = countOption(args);
    if (option === null) return [];
    return files(option.files).map((path) => ({
      path,
      program,
      ranges:
        program === "head"
          ? [[1, option.count] as Range]
          : option.from
            ? [[option.count, Number.MAX_SAFE_INTEGER] as Range]
            : { tail: option.count },
    }));
  }
  if (program === "sed") {
    const quiet = args.includes("-n") || args.includes("--quiet") || args.includes("--silent");
    if (!quiet || args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place")) return [];
    const scripts: string[] = [];
    const words: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "-e" || arg === "--expression") scripts.push(args[++i] ?? "");
      else if (arg === "-n" || arg === "--quiet" || arg === "--silent" || arg === "-E" || arg === "-r") continue;
      else if (arg.startsWith("-")) continue;
      else if (scripts.length === 0) scripts.push(arg);
      else words.push(arg);
    }
    const ranges = sedRanges(scripts.join(";"));
    if (ranges === null) return [];
    return files(words).map((path) => ({ path, ranges, program }));
  }
  if (program === "awk" || program === "gawk") {
    const words = args.slice(1).filter((arg) => !arg.startsWith("-"));
    const ranges = awkRanges(words[0] ?? "");
    if (ranges === null) return [];
    return files(words.slice(1)).map((path) => ({ path, ranges, program }));
  }
  if (program === "grep" || program === "egrep" || program === "rg" || program === "ag" || program === "ack") {
    const { paths, prints } = grepTargets(args);
    if (!prints) return [];
    // The files named; a folder or no path at all is told by the output's own paths.
    return [
      ...files(paths).map((path) => ({ path, ranges: null, program })),
      { path: "", ranges: null, program },
    ];
  }
  if (program === "git" && args[1] === "show") {
    return args.slice(2).flatMap((arg) => {
      const at = arg.indexOf(":");
      if (at === -1) return [];
      const path = resolve(arg.slice(at + 1).startsWith("/") ? arg.slice(at + 1) : `./${arg.slice(at + 1)}`);
      return path === null ? [] : [{ path, ranges: "whole" as const, program: "git show" }];
    });
  }
  return [];
}

/** Whether an output is a piece of what the command printed: truncated or set aside by the agent's tool. */
export function outputTruncated(output: string): boolean {
  return /<persisted-output>|Output too large|tokens? truncated|\[\.\.\. ?\d+ (?:lines|chars|bytes) truncated|…\s*\d+ (?:tokens|lines) truncated/i.test(output);
}

/**
 * The lines of `path` whose text the output holds, in order: each output
 * line found nearest after the last one matched. Lines too short to say
 * which line they are (`}`, blank) only count between two matches.
 */
export function matchOutput(lines: readonly string[], output: string, within?: readonly Range[]): Range[] {
  const index = new Map<string, number[]>();
  const inside = (line: number) => within === undefined || within.some(([start, end]) => line >= start && line <= end);
  lines.forEach((text, i) => {
    const key = text.trim();
    if (key.length < 4 || !inside(i + 1)) return;
    const list = index.get(key);
    if (list === undefined) index.set(key, [i + 1]);
    else list.push(i + 1);
  });
  const found: number[] = [];
  let cursor = 0;
  for (const raw of output.split("\n")) {
    // A grep's `path:12:` or `12:` prefix, or nl's numbering, is not the line's text.
    const text = raw.replace(/^\s*\d+[\t:-]/, "").trim();
    const candidates = index.get(text) ?? index.get(raw.trim());
    if (candidates === undefined) continue;
    const next = candidates.find((line) => line > cursor) ?? candidates[0];
    if (next === undefined) continue;
    found.push(next);
    cursor = next;
  }
  // Short lines between two matched lines a few apart came with them.
  const ranges: Range[] = [];
  const sorted = [...new Set(found)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const line = sorted[i] ?? 0;
    const last = ranges[ranges.length - 1];
    if (last !== undefined && line - last[1] <= 3 && line > last[1]) ranges[ranges.length - 1] = [last[0], line];
    else ranges.push([line, line]);
  }
  return unionRanges(ranges);
}

/** grep and rg output lines, `path:12:text`, `path-12-text` (context), `12:text` or `path:text`, by file. */
function grepOutput(
  output: string,
  resolve: (word: string) => string | null,
  single: string | null,
  ctx: ParseContext,
): ShellRead[] {
  const numbered = new Map<string, Range[]>();
  const unnumbered = new Map<string, string[]>();
  const add = (path: string, line: number) => {
    const list = numbered.get(path) ?? [];
    list.push([line, line]);
    numbered.set(path, list);
  };
  const addText = (path: string, text: string) => {
    const list = unnumbered.get(path) ?? [];
    list.push(text);
    unnumbered.set(path, list);
  };
  for (const line of output.split("\n").slice(0, 20_000)) {
    if (line === "" || line === "--") continue;
    const withPath = /^(.+?)([:-])(\d+)\2(.*)$/.exec(line);
    if (withPath !== null) {
      const path = resolve(withPath[1] ?? "");
      if (path !== null && ctx.lines(path) !== null) {
        add(path, Number(withPath[3]));
        continue;
      }
    }
    const bare = /^(\d+)[:-](.*)$/.exec(line);
    if (bare !== null && single !== null) {
      add(single, Number(bare[1]));
      continue;
    }
    const named = /^(.+?):(.*)$/.exec(line);
    if (named !== null) {
      const path = resolve(named[1] ?? "");
      if (path !== null && ctx.lines(path) !== null) {
        addText(path, named[2] ?? "");
        continue;
      }
    }
    if (single !== null) addText(single, line);
  }
  const reads: ShellRead[] = [];
  for (const path of new Set([...numbered.keys(), ...unnumbered.keys()])) {
    const lines = ctx.lines(path);
    if (lines === null) continue;
    const ranges = unionRanges(
      [...(numbered.get(path) ?? []), ...matchOutput(lines, (unnumbered.get(path) ?? []).join("\n"))],
      lines.length,
    );
    if (ranges.length > 0) reads.push({ path, ranges, program: "grep" });
  }
  return reads;
}

/**
 * The repository lines a shell command showed, from its words, its working
 * folder and, when the tool kept it, its output. A command whose output
 * was cut short counts only the lines the output holds.
 */
export function shellReads(command: string, cwd: string | null, output: string | null, ctx: ParseContext): ShellRead[] {
  let dir = cwd;
  const resolveWord = (word: string): string | null => {
    if (word === "" || word === "-" || word.includes("$") || word.includes("*") || word.includes("?")) return null;
    const home = process.env["HOME"] ?? "";
    const expanded = word.startsWith("~/") && home !== "" ? posix.join(home, word.slice(2)) : word;
    const absolute = posix.isAbsolute(expanded) ? expanded : dir === null ? null : posix.join(dir, expanded);
    if (absolute === null) return null;
    const path = ctx.relative(absolute);
    return path !== null && ctx.lines(path) !== null ? path : null;
  };
  const truncated = output !== null && outputTruncated(output);
  const reads: ShellRead[] = [];
  for (const pipeline of pipelines(shellTokens(command))) {
    const first = pipeline.stages[0]?.argv ?? [];
    if (programOf(first[0] ?? "") === "cd") {
      const target = first[1];
      if (target !== undefined && !target.includes("$")) {
        const home = process.env["HOME"] ?? "";
        const expanded = target === "~" ? home : target.startsWith("~/") ? posix.join(home, target.slice(2)) : target;
        dir = posix.isAbsolute(expanded) ? posix.normalize(expanded) : dir === null ? null : posix.join(dir, expanded);
      }
      continue;
    }
    if (SILENT.has(programOf(first[0] ?? "")) && programOf(first[0] ?? "") !== "git") continue;
    const candidates = stageCandidates(first, resolveWord);
    if (candidates.length === 0) continue;
    const downstream = pipeline.stages.slice(1).map((stage) => stage.argv);
    // A filter after the read shows only part of it.
    const filtered = downstream.length > 0;
    let cap: ((ranges: Range[], total: number) => Range[]) | null = null;
    if (downstream.length === 1) {
      const next = downstream[0] ?? [];
      const program = programOf(next[0] ?? "");
      if (program === "head" || program === "tail") {
        const option = countOption(next);
        if (option !== null && option.files.length === 0)
          cap = (ranges, total) => {
            const lines = ranges.flatMap(([start, end]) => {
              const out: number[] = [];
              for (let line = start; line <= Math.min(end, total); line++) out.push(line);
              return out;
            });
            const kept =
              program === "head" ? lines.slice(0, option.count) : option.from ? lines.slice(option.count - 1) : lines.slice(-option.count);
            return unionRanges(kept.map((line): Range => [line, line]));
          };
      } else if (SILENT.has(program)) continue;
    }
    for (const candidate of candidates) {
      if (candidate.ranges === null) {
        // grep and rg: the output says which lines.
        if (output === null || filtered) continue;
        const single = candidate.path === "" ? (candidates.filter((each) => each.path !== "").length === 1 ? candidates[0]?.path ?? null : null) : null;
        if (candidate.path !== "") continue;
        reads.push(...grepOutput(output, resolveWord, single, ctx));
        continue;
      }
      const lines = ctx.lines(candidate.path);
      if (lines === null) continue;
      const total = lines.length;
      let ranges: Range[] =
        candidate.ranges === "whole"
          ? [[1, total]]
          : "tail" in candidate.ranges
            ? [[Math.max(1, total - candidate.ranges.tail + 1), total]]
            : candidate.ranges;
      ranges = unionRanges(ranges, total);
      if (cap !== null) ranges = cap(ranges, total);
      else if (filtered || truncated) {
        // Only what came back counts.
        if (output === null) continue;
        ranges = matchOutput(lines, output, ranges);
      }
      if (ranges.length > 0) reads.push({ path: candidate.path, ranges, program: candidate.program });
    }
  }
  return reads;
}
