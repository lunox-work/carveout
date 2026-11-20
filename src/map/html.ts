/**
 * The map as one HTML file: the data, the styles, the script and the
 * fonts inline (base64), so it opens from disk with no network. It holds
 * paths, line counts and line ranges, never a file's contents.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeenKind } from "./claude.js";
import { CLIENT_JS } from "./client.js";
import { formatPercent, type FileCoverage, type MapFile, type MapNumbers, type SessionData } from "./model.js";
import type { Range } from "./ranges.js";

/** What `carveout plan` with the hand-off defaults would hold, by file index. */
export interface SliceOverlay {
  /** The files the plan was asked for. */
  readonly entries: number;
  readonly copied: readonly number[];
  readonly stub: readonly number[];
  /** Files the folder would copy. */
  readonly files: number;
  /** The lines it shows, as a share of the map's lines. */
  readonly percent: number;
}

/** The share card's words: the real ones, kept on this machine, and those in pseudonyms. */
export interface CardText {
  readonly label: string;
  readonly percent: string;
  readonly of: string;
  readonly stats: readonly (readonly [string, string])[];
  readonly note: string;
  readonly repo: string;
}

export interface MapPage {
  readonly demo: boolean;
  /** `Claude`, `Codex`, or `Your agents`. */
  readonly agentLabel: string;
  readonly repo: string;
  readonly files: readonly MapFile[];
  /** Each file's path in pseudonyms, in the order of `files`. */
  readonly sharePaths: readonly string[];
  readonly cover: ReadonlyMap<number, FileCoverage>;
  readonly totals: MapNumbers;
  readonly sessions: readonly (SessionData & { readonly slice: SliceOverlay | null })[];
  readonly handoff: (SliceOverlay & { readonly copied: readonly number[] }) | null;
  readonly card: { readonly real: CardText; readonly share: CardText };
  /** No session found: the folders looked in. */
  readonly empty: readonly string[] | null;
  /** Leave the real names out of the file altogether: for rendering the share card. */
  readonly shareOnly?: boolean;
  readonly generatedAt: number;
  readonly methodNote: string;
}

const KIND: Record<SeenKind, number> = { read: 0, inferred: 1, edit: 2 };

const flatRanges = (ranges: readonly Range[]) => [ranges.length, ...ranges.flat()];

/** The data block the page's script reads: paths as a segment table, ranges flattened, times from the first. */
export function pageData(page: MapPage): Record<string, unknown> {
  const real = page.shareOnly === true ? page.sharePaths : page.files.map((file) => file.path);
  const segIndex = new Map<string, number>();
  const segs: string[] = [];
  const segsShare: string[] = [];
  const dirIndex = new Map<string, number>();
  const dirs: number[][] = [];
  const files: number[] = [];
  real.forEach((path, i) => {
    const parts = path.split("/");
    const shareParts = (page.sharePaths[i] ?? path).split("/");
    const ids = parts.map((part, k) => {
      const key = `${part}\u0000${shareParts[k] ?? part}`;
      let id = segIndex.get(key);
      if (id === undefined) {
        id = segs.length;
        segIndex.set(key, id);
        segs.push(part);
        segsShare.push(shareParts[k] ?? part);
      }
      return id;
    });
    const dirKey = ids.slice(0, -1).join(",");
    let dir = dirIndex.get(dirKey);
    if (dir === undefined) {
      dir = dirs.length;
      dirIndex.set(dirKey, dir);
      dirs.push(ids.slice(0, -1));
    }
    files.push(dir, ids[ids.length - 1] ?? 0, page.files[i]?.lines ?? 0);
  });
  const times = [
    ...[...page.cover.values()].map((coverage) => coverage.first),
    ...page.sessions.flatMap((session) => session.events.map((event) => event.at)),
  ].filter((time) => Number.isFinite(time) && time > 0);
  const t0 = times.length === 0 ? 0 : Math.min(...times);
  const cover: number[] = [];
  for (const [index, coverage] of [...page.cover].sort((a, b) => a[0] - b[0]))
    cover.push(
      index,
      coverage.editedFile ? 1 : 0,
      ...flatRanges(coverage.read),
      ...flatRanges(coverage.inferred),
      ...flatRanges(coverage.edited),
      Math.max(0, coverage.first - t0),
      Math.max(0, coverage.last - t0),
    );
  const tools: string[] = [];
  const toolIndex = new Map<string, number>();
  const toolOf = (tool: string) => {
    let id = toolIndex.get(tool);
    if (id === undefined) {
      id = tools.length;
      toolIndex.set(tool, id);
      tools.push(tool);
    }
    return id;
  };
  const sessions = page.sessions.map((session) => ({
    id: session.id,
    agent: session.agent,
    start: session.start,
    end: session.end,
    title: page.shareOnly === true ? null : session.title,
    n: session.numbers,
    slice: session.slice,
    ev: session.events.flatMap((event) => [
      Math.max(0, event.at - t0),
      event.file,
      KIND[event.kind],
      toolOf(event.tool),
      ...flatRanges(event.ranges),
      ...flatRanges(event.edited ?? []),
    ]),
  }));
  return {
    v: 1,
    demo: page.demo,
    agentLabel: page.agentLabel,
    repo: page.shareOnly === true ? page.card.share.repo : page.repo,
    generatedAt: page.generatedAt,
    t0,
    segs,
    segsShare,
    dirs,
    files,
    cover,
    tools,
    totals: page.totals,
    sessions,
    // The entries' paths stay out: the files' indexes say which they are.
    handoff:
      page.handoff === null
        ? null
        : { entries: page.handoff.entries, copied: page.handoff.copied, stub: page.handoff.stub, files: page.handoff.files, percent: page.handoff.percent },
    card: page.shareOnly === true ? { real: page.card.share, share: page.card.share } : page.card,
    empty: page.empty !== null,
    looked: page.shareOnly === true ? [] : (page.empty ?? []),
  };
}

const FONTS: readonly (readonly [string, string, number])[] = [
  ["Mono", "dm-mono-latin-400-normal.woff2", 400],
  ["Mono", "dm-mono-latin-500-normal.woff2", 500],
  ["Sans", "dm-sans-latin-400-normal.woff2", 400],
  ["Sans", "dm-sans-latin-500-normal.woff2", 500],
  ["Display", "space-grotesk-latin-600-normal.woff2", 600],
];

/** The fonts as `@font-face` rules with the files inline, from the package's `assets/src/fonts`; none when it is missing. */
export function fontFaces(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/src/map/ in the package, src/map/ in a checkout run through a loader.
  const folder = [join(here, "../../../assets/src/fonts"), join(here, "../../assets/src/fonts")].find((dir) => existsSync(dir));
  if (folder === undefined) return "";
  return FONTS.map(([family, file, weight]) => {
    const path = join(folder, file);
    if (!existsSync(path)) return "";
    return `@font-face{font-family:${family};src:url(data:font/woff2;base64,${readFileSync(path).toString("base64")}) format("woff2");font-weight:${weight};font-display:block}`;
  }).join("\n");
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** The page. */
export function renderMapHtml(page: MapPage, options: { readonly fonts?: string } = {}): string {
  const data = JSON.stringify(pageData(page)).replace(/</g, "\\u003c").replaceAll(String.fromCharCode(0x2028), "\\u2028").replaceAll(String.fromCharCode(0x2029), "\\u2029");
  const title = page.shareOnly === true ? "carveout map" : `carveout map · ${page.repo}`;
  const percent = formatPercent(page.totals.percent);
  const looked = (page.empty ?? []).map((dir) => `<code>${escapeHtml(dir)}</code>`).join("<br>");
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${options.fonts ?? fontFaces()}
:root{--bg:#09090b;--line:rgb(255 255 255/.08);--text:#fafafa;--muted:#71717a;--dim:#a1a1aa;--cell:#1f1f23;--seen:#22c55e;--held:#f43f5e;--stub:#f59e0b}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:Sans,"DM Sans",system-ui,sans-serif;display:flex;flex-direction:column;overflow:hidden}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 60% 40% at 50% 0%,rgb(255 255 255/.06),transparent)}
body.cardonly{overflow:hidden;display:block;background:#000}
body.cardonly>*:not(canvas){display:none!important}
body.cardonly canvas{display:block;max-width:none!important;max-height:none!important;border-radius:0!important;box-shadow:none!important}
code{font-family:Mono,ui-monospace,monospace;font-size:.92em}
b{font-weight:500}
.g{color:var(--seen)}.w{color:var(--text)}.m{color:var(--muted)}.small{font-size:12px;line-height:1.5}
header{display:flex;align-items:center;gap:24px;padding:16px 28px;border-bottom:1px solid var(--line);position:relative;z-index:2}
.mark{font-family:Mono,monospace;font-weight:500;font-size:15px;letter-spacing:.02em;white-space:nowrap}
.mark span{color:var(--muted)}
nav{display:flex;gap:4px;background:rgb(255 255 255/.04);border:1px solid var(--line);border-radius:9px;padding:3px}
nav button,.seg button{font:500 13px Mono,monospace;color:var(--dim);background:none;border:0;border-radius:6px;padding:7px 13px;cursor:pointer;letter-spacing:.02em}
nav button:hover,.seg button:hover{color:var(--text)}
nav button.on,.seg button.on{background:rgb(255 255 255/.09);color:var(--text)}
.legend{margin-left:auto;display:flex;gap:16px;font:12px Mono,monospace;color:var(--muted);flex-wrap:wrap;justify-content:flex-end}
.legend i{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:6px}
.hero{display:flex;align-items:flex-end;gap:28px;padding:22px 28px 16px;position:relative;z-index:1}
.num{font-family:Display,"Space Grotesk",sans-serif;font-weight:600;font-size:clamp(56px,7.4vw,104px);line-height:.86;letter-spacing:-.045em;color:var(--seen);text-shadow:0 0 40px rgb(34 197 94/.35)}
.who{font:500 13px Mono,monospace;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin-bottom:10px}
.sub{font:14px Mono,monospace;color:var(--dim);line-height:1.6}
.sub b{color:var(--text)}.sub i{font-style:normal;color:var(--muted)}
.demo{font:500 12px Mono,monospace;color:var(--held);background:rgb(244 63 94/.12);border:1px solid rgb(244 63 94/.3);border-radius:6px;padding:4px 8px;margin-left:auto;align-self:flex-start}
.bar{display:none;align-items:center;gap:14px;padding:0 28px 12px;font:13px Mono,monospace;color:var(--dim);position:relative;z-index:1;min-height:40px}
body[data-view=replay] #rbar,body[data-view=slice] #sbar,body[data-view=share] #cbar{display:flex}
select{font:13px Mono,monospace;background:#141417;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:7px 10px;max-width:420px}
.btn{font:500 13px Mono,monospace;background:var(--seen);color:#04150a;border:0;border-radius:7px;padding:8px 16px;cursor:pointer}
.btn.ghost{background:rgb(255 255 255/.08);color:var(--text)}
input[type=range]{flex:1;accent-color:var(--seen);min-width:120px}
#rtick{flex:2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#rtick b{color:var(--text)}
#snums{display:flex;gap:28px;align-items:baseline;flex-wrap:wrap}
#snums .k{color:var(--muted);margin-right:10px;text-transform:uppercase;font-size:11px;letter-spacing:.12em}
#snums b{font-family:Display,sans-serif;font-size:20px;letter-spacing:-.02em}
main{flex:1;position:relative;min-height:0;margin:0 28px 0;}
#stage{position:absolute;inset:0}
#map{display:block}
body[data-view=carve] #map,body[data-view=share] #map{display:none}
#carve{display:none;position:absolute;inset:0;align-items:center;justify-content:center;perspective:1600px;overflow:hidden}
body[data-view=carve] #carve{display:flex}
#slab{position:relative;transform-style:preserve-3d;transform:rotateX(58deg) rotateZ(-38deg);transition:none}
#slab canvas,#cshadow{position:absolute;left:0;top:0}
#cbase{box-shadow:0 0 0 1px rgb(255 255 255/.06)}
#slab::before{content:"";position:absolute;left:0;top:100%;width:100%;height:28px;background:linear-gradient(#18181b,#0c0c0e);transform-origin:top;transform:rotateX(-90deg)}
#slab::after{content:"";position:absolute;left:100%;top:0;width:28px;height:100%;background:linear-gradient(90deg,#141417,#09090b);transform-origin:left;transform:rotateY(90deg)}
#cshadow{width:100%;height:100%;opacity:0;background:radial-gradient(ellipse at center,rgb(34 197 94/.25),transparent 70%);filter:blur(14px)}
#clift{filter:drop-shadow(0 0 6px rgb(34 197 94/.5))}
#ctop{filter:drop-shadow(0 0 10px rgb(34 197 94/.8))}
#ccap{position:absolute;left:0;right:0;bottom:22px;text-align:center;font:15px Mono,monospace;color:var(--dim)}
#ccap b{font-family:Display,sans-serif;font-size:22px}
#share{display:none;position:absolute;inset:0;align-items:center;justify-content:center;flex-direction:column;gap:14px}
body[data-view=share] #share{display:flex}
#card{max-width:100%;max-height:calc(100% - 40px);border-radius:12px;box-shadow:0 30px 80px rgb(0 0 0/.6),0 0 0 1px var(--line)}
#realnote{display:none;font:12px Mono,monospace;color:var(--held)}
#tip{position:fixed;display:none;pointer-events:none;z-index:9;background:#141417ee;border:1px solid var(--line);border-radius:8px;padding:9px 11px;font:12px Mono,monospace;max-width:460px;backdrop-filter:blur(6px)}
#tip .tp{color:var(--text);word-break:break-all;margin-bottom:4px}
#tip .tn{color:var(--muted)}#tip b{color:var(--seen);font-weight:500}#tip i{font-style:normal;color:var(--dim)}
#detail{position:absolute;top:0;right:0;bottom:0;width:340px;max-width:90%;background:#111114f2;border-left:1px solid var(--line);padding:20px;transform:translateX(105%);transition:transform .18s ease;overflow:auto;z-index:5;font-size:13px}
#detail.open{transform:none}
#detail .x{position:absolute;top:10px;right:12px;background:none;border:0;color:var(--muted);font-size:22px;cursor:pointer}
#detail .dp{font:500 13px Mono,monospace;word-break:break-all;margin-right:20px}
#detail .dn{font:12px Mono,monospace;color:var(--muted);margin:6px 0 16px}
#detail dt{font:11px Mono,monospace;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-top:14px}
#detail dd{font:13px Mono,monospace;margin-top:5px;line-height:1.55;word-break:break-word}
#detail p{margin-top:18px}
footer{padding:12px 28px 14px;font:12px Mono,monospace;color:var(--muted);display:flex;gap:18px;flex-wrap:wrap}
#empty{display:none;position:absolute;inset:0;z-index:4;align-items:center;justify-content:center;background:rgb(9 9 11/.82)}
#empty div{max-width:560px;font:14px/1.7 Mono,monospace;color:var(--dim);border:1px solid var(--line);border-radius:12px;padding:24px;background:#111114}
#empty b{color:var(--text);font-family:Display,sans-serif;font-size:22px;display:block;margin-bottom:8px}
@media (max-width:820px){header{flex-wrap:wrap;padding:12px 16px}.legend{display:none}.hero{padding:16px}main{margin:0 16px}.bar{padding:0 16px 10px;flex-wrap:wrap}footer{padding:10px 16px}}
</style>
</head>
<body data-view="map">
<header>
  <div class="mark">carveout <span>map</span></div>
  <nav>
    <button data-view="map" class="on">Map</button>
    <button data-view="replay">Replay</button>
    <button data-view="slice">Slice</button>
    <button data-view="carve">Carve</button>
    <button data-view="share">Share</button>
  </nav>
  <div class="legend">
    <span><i style="background:var(--seen);box-shadow:0 0 8px rgb(34 197 94/.7)"></i>edited</span>
    <span><i style="background:rgb(34 197 94/.5)"></i>read</span>
    <span><i style="background:repeating-linear-gradient(135deg,rgb(34 197 94/.8) 0 2px,transparent 2px 4px)"></i>inferred from shell</span>
    <span><i style="background:var(--cell)"></i>not seen</span>
  </div>
</header>
<section class="hero">
  <div><div class="who" id="who">${escapeHtml(page.agentLabel)} has seen</div><div class="num" id="num">${percent}</div></div>
  <div><div class="sub" id="sub"></div><div class="sub m" style="margin-top:4px">of this repo, by line, from local session logs</div></div>
  ${page.demo ? '<div class="demo">SAMPLE DATA · not measured</div>' : ""}
</section>
<div class="bar" id="rbar"><select id="rsess"></select><button class="btn" id="rplay">Play</button><input type="range" id="rscrub" min="0" max="1000" value="0"><div id="rtick"></div><span id="rnote" class="m"></span></div>
<div class="bar" id="sbar"><select id="ssess"></select><div id="snums"></div></div>
<div class="bar" id="cbar"><div class="seg"><button data-size="1200x630" class="on">1200×630</button><button data-size="1080x1350">1080×1350</button></div>
  <label class="m"><input type="checkbox" id="real"> real names (stays on this machine)</label><button class="btn" id="dl">Download PNG</button><span id="realnote">Real names are on: this image names the repository.</span></div>
<main>
  <div id="stage"><canvas id="map"></canvas></div>
  <div id="carve"><div id="slab"><canvas id="cbase"></canvas><div id="cshadow"></div><canvas id="clift"></canvas><canvas id="ctop"></canvas></div><div id="ccap"></div></div>
  <div id="share"><canvas id="card" width="1200" height="630"></canvas></div>
  <aside id="detail"></aside>
  <div id="empty"><div><b>No agent sessions found for this repository.</b>Looked in:<br>${looked}<br><br>Run a Claude Code or Codex session in this folder, then run <code>carveout map</code> again.</div></div>
</main>
<footer><span>${escapeHtml(page.methodNote)}</span><span>Paths and line ranges only: no file contents.</span><span>Made locally by carveout. Nothing was uploaded.</span></footer>
<div id="tip"></div>
<script type="application/json" id="carveout-data">${data}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}
