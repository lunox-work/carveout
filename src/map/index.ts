/**
 * `carveout map`: which lines of this repository the coding agents' local
 * session logs show they saw, as numbers (`--json`) and as one HTML page.
 * Reads the logs and the repository; runs nothing, writes only the page.
 */

import { basename, resolve } from "node:path";
import { planSlice, readRepoConfig } from "../carve.js";
import { SLICE_BUDGET_DEFAULTS } from "../core.js";
import type { ParsedSession } from "./claude.js";
import { demoMap } from "./demo.js";
import type { CardText, MapPage, SliceOverlay } from "./html.js";
import { findSessions, repoContext, repoRoots, type AgentName, type LogHomes } from "./logs.js";
import { coverOf, formatPercent, numbersOf, repoFiles, sessionData, type MapFile, type MapNumbers, type SessionData } from "./model.js";
import { shareNames } from "./names.js";
import { formatRanges } from "./ranges.js";

export interface MapOptions {
  readonly root: string;
  /** A session's id (or its start), or `latest`. */
  readonly session?: string;
  /** Leave out sessions that ended before this time. */
  readonly since?: number;
  readonly agent?: AgentName | "all";
  /** Map a hand-off of these entries instead: copied, stubbed, not in the folder. */
  readonly slice?: readonly string[];
  /** Earlier paths of this checkout, whose sessions count. */
  readonly was?: readonly string[];
  readonly homes?: LogHomes;
  /** The sample data, not this repository. */
  readonly demo?: boolean;
  /** Time allowed for the slice overlays of sessions' changes (default 6 s). */
  readonly sliceBudgetMs?: number;
  readonly now?: number;
}

export interface MapJson {
  readonly repo: string;
  readonly generatedAt: string;
  readonly sample: boolean;
  readonly agent: string;
  readonly filter: { readonly session: string | null; readonly since: string | null; readonly agent: string };
  readonly totals: MapNumbers;
  readonly method: {
    readonly sessions: number;
    readonly first: string | null;
    readonly last: string | null;
    readonly logsRead: number;
    readonly looked: readonly string[];
    readonly note: string;
  };
  readonly sessions: readonly {
    readonly agent: string;
    readonly id: string;
    readonly start: string | null;
    readonly end: string | null;
    readonly events: number;
    readonly numbers: MapNumbers;
    readonly unplaced: number;
    readonly unmapped: number;
    readonly slice: { readonly files: number; readonly percent: number } | null;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly lines: number;
    readonly read: string;
    readonly inferred: string;
    readonly edited: string;
    readonly editedFile: boolean;
    readonly firstSeen: string;
    readonly lastSeen: string;
  }[];
  readonly handoff: { readonly entries: readonly string[]; readonly copied: number; readonly stubbed: number; readonly percent: number } | null;
}

export interface MapResult {
  readonly page: MapPage;
  readonly json: MapJson;
  readonly timings: { readonly filesMs: number; readonly logsMs: number; readonly sliceMs: number; readonly namesMs: number };
}

const iso = (time: number | null) => (time === null || !Number.isFinite(time) ? null : new Date(time).toISOString());
const fmt = (n: number) => Math.round(n).toLocaleString("en-GB");
const dayOf = (time: number) => new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

/** Who saw: `Claude`, `Codex`, or `Your agents`. */
export function agentLabel(agents: ReadonlySet<string>, asked: AgentName | "all"): string {
  if (agents.size === 1) return agents.has("codex") ? "Codex" : "Claude";
  if (agents.size === 0) return asked === "codex" ? "Codex" : asked === "claude" ? "Claude" : "Your agents";
  return "Your agents";
}

/** The method in one line: how many sessions, since when, from what. */
export function methodNote(sessions: number, first: number | null, inferred: number, totals: MapNumbers, sample: boolean): string {
  if (sample) return "Sample data, not measured: carveout map --demo";
  const since = first === null ? "" : `, since ${dayOf(first)}`;
  const inferredNote = inferred > 0 ? ` · ${formatPercent((100 * inferred) / Math.max(1, totals.lines))} inferred from shell commands` : "";
  return `${sessions} session${sessions === 1 ? "" : "s"}${since}, line ranges from local logs${inferredNote}`;
}

/** The share card's words. */
export function cardText(label: string, totals: MapNumbers, sessions: number, note: string, repo: string): CardText {
  return {
    label: `${label} has seen`,
    percent: formatPercent(totals.percent),
    of: `of this repo · ${fmt(totals.seenLines)} of ${fmt(totals.lines)} lines`,
    stats: [
      [fmt(totals.filesSeen), "files read"],
      [fmt(totals.filesEdited), "files edited"],
      [fmt(sessions), sessions === 1 ? "session" : "sessions"],
    ],
    note,
    repo,
  };
}

/** What `carveout plan` with the hand-off's defaults holds for these entries, by the map's file indexes. */
export function sliceOverlay(root: string, entries: readonly string[], files: readonly MapFile[], totals: MapNumbers): SliceOverlay & { readonly entryPaths: readonly string[] } {
  const config = readRepoConfig(root);
  const planned = planSlice({
    repo: root,
    entryPoints: entries,
    budget: SLICE_BUDGET_DEFAULTS,
    tests: true,
    wholePackage: config.wholePackage ?? true,
    copyPure: config.copyPure ?? true,
  });
  const index = new Map(files.map((file, i) => [file.path, i]));
  const copied = planned.walk.included.flatMap((path) => (index.has(path) ? [index.get(path) ?? 0] : []));
  const held = new Set(copied);
  const stub = planned.cutModules.flatMap((path) => {
    const at = index.get(path);
    return at === undefined || held.has(at) ? [] : [at];
  });
  return {
    entries: entries.length,
    entryPaths: entries,
    copied,
    stub,
    files: planned.walk.included.length,
    percent: totals.lines === 0 ? 0 : (100 * planned.exposure.lines) / totals.lines,
  };
}

/** The sessions a `--session` value names: `latest`, an id or its start. */
export function pickSessions(sessions: readonly SessionData[], session: string | undefined): SessionData[] {
  if (session === undefined) return [...sessions];
  const withEvents = sessions.filter((each) => each.events.length > 0);
  if (session === "latest") {
    const latest = [...withEvents].sort((a, b) => (b.end ?? 0) - (a.end ?? 0))[0];
    return latest === undefined ? [] : [latest];
  }
  return sessions.filter((each) => each.id === session || each.id.startsWith(session));
}

/** The map of a repository, or of the sample data. */
export function buildMap(options: MapOptions): MapResult {
  if (options.demo === true) return demoMap(options.now ?? Date.now());
  const root = resolve(options.root);
  const asked = options.agent ?? "all";
  const agents: AgentName[] = asked === "all" ? ["claude", "codex"] : [asked];
  const started = Date.now();
  const files = repoFiles(root);
  const filesMs = Date.now() - started;
  const fileSet = new Set(files.map((file) => file.path));
  const roots = repoRoots(root, options.was);
  const ctx = repoContext(root, roots, fileSet);
  const logsStart = Date.now();
  const found = findSessions({ roots, agents, ctx, ...(options.homes === undefined ? {} : { homes: options.homes }), ...(options.since === undefined ? {} : { since: options.since }) });
  const inWindow = (session: ParsedSession) => options.since === undefined || (session.end ?? 0) >= options.since;
  const all = sessionData(files, found.sessions.filter(inWindow));
  const chosen = pickSessions(all, options.session);
  if (options.session !== undefined && chosen.length === 0)
    throw new Error(
      options.session === "latest"
        ? "No session with a read in this repository was found."
        : `No session ${options.session} was found for this repository. Sessions found: ${all.map((each) => each.id.slice(0, 8)).join(", ") || "none"}.`,
    );
  const logsMs = Date.now() - logsStart;
  const cover = coverOf(files, chosen.flatMap((session) => session.events));
  const totals = numbersOf(files, cover);
  // The slice overlays: the latest sessions that edited script files, within the budget.
  const sliceStart = Date.now();
  const budget = options.sliceBudgetMs ?? 6000;
  const slices = new Map<SessionData, SliceOverlay>();
  for (const session of [...chosen].reverse()) {
    if (Date.now() - sliceStart > budget || slices.size >= 3) break;
    const edited = [...new Set(session.events.filter((event) => event.kind === "edit").map((event) => event.path))].filter(
      (path) => SCRIPT.test(path) && !path.endsWith(".d.ts"),
    );
    if (edited.length === 0) continue;
    try {
      slices.set(session, sliceOverlay(root, edited, files, totals));
    } catch {
      // A change no plan can be made of (an entry the graph cannot read): no overlay.
    }
  }
  let handoff: (SliceOverlay & { readonly entryPaths: readonly string[] }) | null = null;
  if (options.slice !== undefined && options.slice.length > 0) handoff = sliceOverlay(root, options.slice, files, totals);
  const sliceMs = Date.now() - sliceStart;
  const namesStart = Date.now();
  const names = shareNames(root, files.map((file) => file.path));
  const namesMs = Date.now() - namesStart;
  const seenAgents = new Set(chosen.filter((session) => session.events.length > 0).map((session) => session.agent));
  const label = agentLabel(seenAgents, asked);
  const counted = chosen.filter((session) => session.events.length > 0);
  const first = counted.length === 0 ? null : Math.min(...counted.map((session) => session.start ?? Infinity));
  const last = counted.length === 0 ? null : Math.max(...counted.map((session) => session.end ?? 0));
  const note = methodNote(counted.length, first === Infinity ? null : first, totals.inferredLines, totals, false);
  const repoName = basename(root);
  const empty = counted.length === 0 ? found.looked : null;
  const page: MapPage = {
    demo: false,
    agentLabel: label,
    repo: repoName,
    files,
    sharePaths: names.paths,
    cover,
    totals,
    sessions: chosen.map((session) => ({ ...session, slice: slices.get(session) ?? null })),
    handoff,
    card: { real: cardText(label, totals, counted.length, note, repoName), share: cardText(label, totals, counted.length, note, names.repo) },
    empty,
    generatedAt: options.now ?? Date.now(),
    methodNote: note,
  };
  const json: MapJson = {
    repo: root,
    generatedAt: new Date(page.generatedAt).toISOString(),
    sample: false,
    agent: label,
    filter: { session: options.session ?? null, since: iso(options.since ?? null), agent: asked },
    totals,
    method: { sessions: counted.length, first: iso(first === Infinity ? null : first), last: iso(last), logsRead: found.read, looked: found.looked, note },
    sessions: chosen.map((session) => ({
      agent: session.agent,
      id: session.id,
      start: iso(session.start),
      end: iso(session.end),
      events: session.events.length,
      numbers: session.numbers,
      unplaced: session.unplaced,
      unmapped: session.unmapped,
      slice: slices.has(session) ? { files: slices.get(session)?.files ?? 0, percent: slices.get(session)?.percent ?? 0 } : null,
    })),
    files: [...cover]
      .sort((a, b) => a[0] - b[0])
      .map(([index, coverage]) => ({
        path: files[index]?.path ?? "",
        lines: files[index]?.lines ?? 0,
        read: formatRanges(coverage.read),
        inferred: formatRanges(coverage.inferred),
        edited: formatRanges(coverage.edited),
        editedFile: coverage.editedFile,
        firstSeen: new Date(coverage.first).toISOString(),
        lastSeen: new Date(coverage.last).toISOString(),
      })),
    handoff: handoff === null ? null : { entries: handoff.entryPaths, copied: handoff.copied.length, stubbed: handoff.stub.length, percent: handoff.percent },
  };
  return { page, json, timings: { filesMs, logsMs, sliceMs, namesMs } };
}
