/**
 * `carveout map --demo`: a sample map, made up and labelled so on every
 * view and on the share card ("SAMPLE DATA"). A synthetic monorepo of
 * about 2,300 files and sessions that read parts of it, from a fixed seed,
 * for trying the page and recording it without a repository's logs. No
 * number it shows was measured.
 */

import type { ParsedSession, SeenEvent } from "./claude.js";
import type { MapPage, SliceOverlay } from "./html.js";
import type { MapJson, MapResult } from "./index.js";
import { coverOf, formatPercent, numbersOf, sessionData, type MapFile } from "./model.js";
import { formatRanges, unionRanges, type Range } from "./ranges.js";

/** A small seeded generator (mulberry32), so the sample is the same on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "account", "invoice", "billing", "plan", "usage", "quota", "team", "member", "invite", "role", "audit", "event", "webhook",
  "search", "index", "query", "filter", "report", "export", "import", "session", "token", "profile", "settings", "theme",
  "table", "chart", "form", "modal", "toast", "menu", "sidebar", "header", "card", "list", "picker", "upload", "preview",
  "cart", "order", "refund", "payment", "price", "discount", "coupon", "tax", "currency", "ledger", "payout", "schedule",
  "notify", "email", "digest", "queue", "retry", "cache", "rate", "limit", "flag", "metric", "trace", "health",
];
const SUFFIX = ["", "Service", "Store", "Handler", "View", "Panel", "Utils", "Client", "Model", "Schema", "Mapper", "Hooks"];

interface Area {
  readonly dir: string;
  readonly files: number;
  readonly ext: string;
  readonly mean: number;
  readonly pascal?: boolean;
}

const AREAS: readonly Area[] = [
  { dir: "apps/web/src/components", files: 230, ext: ".tsx", mean: 150, pascal: true },
  { dir: "apps/web/src/pages", files: 92, ext: ".tsx", mean: 210, pascal: true },
  { dir: "apps/web/src/hooks", files: 58, ext: ".ts", mean: 70 },
  { dir: "apps/web/src/lib", files: 74, ext: ".ts", mean: 120 },
  { dir: "apps/api/src/routes", files: 84, ext: ".ts", mean: 180 },
  { dir: "apps/api/src/services", files: 112, ext: ".ts", mean: 260 },
  { dir: "apps/api/src/middleware", files: 22, ext: ".ts", mean: 90 },
  { dir: "apps/api/src/jobs", files: 41, ext: ".ts", mean: 140 },
  { dir: "apps/admin/src", files: 150, ext: ".tsx", mean: 170, pascal: true },
  { dir: "packages/ui/src", files: 186, ext: ".tsx", mean: 120, pascal: true },
  { dir: "packages/billing/src", files: 66, ext: ".ts", mean: 240 },
  { dir: "packages/auth/src", files: 48, ext: ".ts", mean: 180 },
  { dir: "packages/db/src", files: 70, ext: ".ts", mean: 200 },
  { dir: "packages/db/migrations", files: 120, ext: ".sql", mean: 45 },
  { dir: "packages/search/src", files: 72, ext: ".ts", mean: 190 },
  { dir: "packages/analytics/src", files: 60, ext: ".ts", mean: 150 },
  { dir: "packages/emails/src", files: 55, ext: ".tsx", mean: 110, pascal: true },
  { dir: "packages/config/src", files: 26, ext: ".ts", mean: 60 },
  { dir: "services/worker/src", files: 92, ext: ".ts", mean: 210 },
  { dir: "services/notifications/src", files: 61, ext: ".ts", mean: 160 },
  { dir: "tests/e2e", files: 84, ext: ".spec.ts", mean: 130 },
  { dir: "infra/terraform", files: 40, ext: ".tf", mean: 95 },
  { dir: "docs", files: 62, ext: ".md", mean: 120 },
  { dir: "scripts", files: 25, ext: ".ts", mean: 80 },
];

const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The sample repository's files: paths and line counts, log-normally sized. */
export function demoFiles(rand = random(7)): MapFile[] {
  const files: MapFile[] = [];
  const used = new Set<string>();
  for (const area of AREAS) {
    for (let i = 0; i < area.files; i++) {
      let path = "";
      for (let tries = 0; tries < 20; tries++) {
        const a = WORDS[Math.floor(rand() * WORDS.length)] ?? "item";
        const b = WORDS[Math.floor(rand() * WORDS.length)] ?? "list";
        const s = SUFFIX[Math.floor(rand() * SUFFIX.length)] ?? "";
        const name = area.pascal ? `${cap(a)}${cap(b)}${s}` : `${a}-${b}${s === "" ? "" : `-${s.toLowerCase()}`}`;
        const nested = rand() < 0.3 ? `/${WORDS[Math.floor(rand() * 16)] ?? "core"}` : "";
        path = area.ext === ".sql" ? `${area.dir}/${String(i + 1).padStart(4, "0")}_${a}_${b}.sql` : `${area.dir}${nested}/${name}${area.ext}`;
        if (!used.has(path)) break;
      }
      used.add(path);
      // Box-Muller: a log-normal spread around the area's mean.
      const normal = Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
      const lines = Math.max(8, Math.round(area.mean * Math.exp(0.7 * normal - 0.245)));
      files.push({ path, lines });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const FOCUS = ["packages/billing/src", "apps/api/src/services", "apps/api/src/routes", "packages/auth/src", "apps/web/src/components", "packages/search/src", "services/worker/src", "apps/web/src/pages"];

/** Sample sessions: each works in one or two areas, reading parts of files, grepping, and editing a few. */
export function demoSessions(files: readonly MapFile[], now: number, rand = random(42)): ParsedSession[] {
  const byArea = (dir: string) => files.filter((file) => file.path.startsWith(`${dir}/`));
  const sessions: ParsedSession[] = [];
  const count = 26;
  for (let s = 0; s < count; s++) {
    const start = now - (49 - Math.floor((s * 48) / count)) * 86_400_000 + Math.floor(rand() * 8) * 3_600_000;
    let at = start;
    const events: SeenEvent[] = [];
    const focus = FOCUS[Math.floor(rand() * FOCUS.length)] ?? "packages/billing/src";
    const pool = [...byArea(focus), ...(rand() < 0.5 ? byArea(FOCUS[Math.floor(rand() * FOCUS.length)] ?? focus) : [])];
    const pick = () => pool[Math.floor(Math.pow(rand(), 2.6) * pool.length)] ?? files[0];
    const steps = 6 + Math.floor(rand() * 12);
    const touched: MapFile[] = [];
    for (let k = 0; k < steps; k++) {
      at += 4_000 + Math.floor(rand() * 70_000);
      const file = pick();
      if (file === undefined) continue;
      const roll = rand();
      if (roll < 0.55) {
        // A Read: the whole of a small file, a window of a large one.
        const window = file.lines <= 70 && rand() < 0.5 ? file.lines : 30 + Math.floor(rand() * 70);
        const from = window >= file.lines ? 1 : 1 + Math.floor(rand() * (file.lines - window));
        events.push({ at, path: file.path, kind: "read", tool: "Read", ranges: [[from, Math.min(file.lines, from + window - 1)]] });
        touched.push(file);
      } else if (roll < 0.75) {
        // A Grep over the area: a few lines with context in several files.
        for (let g = 0; g < 2 + Math.floor(rand() * 4); g++) {
          const hit = pick();
          if (hit === undefined) continue;
          const line = 1 + Math.floor(rand() * hit.lines);
          events.push({ at, path: hit.path, kind: "read", tool: "Grep", ranges: unionRanges([[line - 2, line + 2]], hit.lines) });
        }
      } else if (roll < 0.86) {
        const line = 1 + Math.floor(rand() * Math.max(1, file.lines - 60));
        events.push({ at, path: file.path, kind: "inferred", tool: "Bash: sed", ranges: unionRanges([[line, line + 30 + Math.floor(rand() * 50)]], file.lines) });
      } else if (touched.length > 0) {
        const target = touched[Math.floor(rand() * touched.length)] ?? file;
        const line = 1 + Math.floor(rand() * Math.max(1, target.lines - 20));
        const hunk: Range = [line, Math.min(target.lines, line + 6 + Math.floor(rand() * 14))];
        events.push({ at, path: target.path, kind: "edit", tool: "Edit", ranges: [hunk], edited: unionRanges([[hunk[0] + 3, Math.max(hunk[0] + 3, hunk[1] - 3)]], target.lines) });
      }
    }
    sessions.push({
      agent: s % 7 === 3 ? "codex" : "claude",
      id: `sample-${String(s + 1).padStart(2, "0")}-${Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0")}`,
      files: [],
      cwd: null,
      start,
      end: at,
      title: null,
      events,
      unplaced: 0,
    });
  }
  return sessions;
}

/** The sample map, through the same numbers and page as a real one. */
export function demoMap(now: number): MapResult {
  const files = demoFiles();
  const parsed = demoSessions(files, now);
  const sessions = sessionData(files, parsed);
  const cover = coverOf(files, sessions.flatMap((session) => session.events));
  const totals = numbersOf(files, cover);
  const rand = random(99);
  const slice = (edited: readonly number[]): SliceOverlay => {
    const copied = new Set<number>(edited);
    for (const index of edited) {
      const dir = files[index]?.path.replace(/\/[^/]+$/, "") ?? "";
      files.forEach((file, i) => {
        if (file.path.startsWith(`${dir}/`) && rand() < 0.25) copied.add(i);
      });
    }
    const stub = new Set<number>();
    while (stub.size < 6 + Math.floor(rand() * 14)) {
      const i = Math.floor(rand() * files.length);
      if (!copied.has(i)) stub.add(i);
    }
    const lines = [...copied].reduce((sum, i) => sum + (files[i]?.lines ?? 0), 0);
    return { entries: edited.length, copied: [...copied], stub: [...stub], files: copied.size, percent: (100 * lines) / totals.lines };
  };
  const pageSessions = sessions.map((session) => {
    const edited = [...new Set(session.events.filter((event) => event.kind === "edit").map((event) => event.file))];
    return { ...session, slice: edited.length > 0 ? slice(edited) : null };
  });
  const note = "Sample data, not measured: carveout map --demo";
  const card = {
    label: "Claude has seen",
    percent: formatPercent(totals.percent),
    of: `of this repo · ${Math.round(totals.seenLines).toLocaleString("en-GB")} of ${Math.round(totals.lines).toLocaleString("en-GB")} lines`,
    stats: [
      [totals.filesSeen.toLocaleString("en-GB"), "files read"],
      [totals.filesEdited.toLocaleString("en-GB"), "files edited"],
      [String(sessions.length), "sessions"],
    ] as const,
    note,
    repo: "sample monorepo",
  };
  const page: MapPage = {
    demo: true,
    agentLabel: "Claude",
    repo: "sample monorepo",
    files,
    sharePaths: files.map((file) => file.path),
    cover,
    totals,
    sessions: pageSessions,
    handoff: null,
    card: { real: card, share: card },
    empty: null,
    generatedAt: now,
    methodNote: note,
  };
  const json: MapJson = {
    repo: "sample monorepo",
    generatedAt: new Date(now).toISOString(),
    sample: true,
    agent: "Claude",
    filter: { session: null, since: null, agent: "all" },
    totals,
    method: { sessions: sessions.length, first: null, last: null, logsRead: 0, looked: [], note },
    sessions: sessions.map((session) => ({
      agent: session.agent,
      id: session.id,
      start: new Date(session.start ?? now).toISOString(),
      end: new Date(session.end ?? now).toISOString(),
      events: session.events.length,
      numbers: session.numbers,
      unplaced: 0,
      unmapped: 0,
      slice: null,
    })),
    files: [...cover].map(([index, coverage]) => ({
      path: files[index]?.path ?? "",
      lines: files[index]?.lines ?? 0,
      read: formatRanges(coverage.read),
      inferred: formatRanges(coverage.inferred),
      edited: formatRanges(coverage.edited),
      editedFile: coverage.editedFile,
      firstSeen: new Date(coverage.first).toISOString(),
      lastSeen: new Date(coverage.last).toISOString(),
    })),
    handoff: null,
  };
  return { page, json, timings: { filesMs: 0, logsMs: 0, sliceMs: 0, namesMs: 0 } };
}
