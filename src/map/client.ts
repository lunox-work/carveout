/**
 * The map page's script, run in the browser from the HTML file alone: no
 * network, no library. It reads the data block, lays out a squarified
 * treemap on a canvas, and draws the five views (map, replay, slice,
 * carve, share). Kept as a string with no backtick or `${`, so it can sit
 * in a template here.
 */

export const CLIENT_JS = String.raw`
(function () {
"use strict";
var D = JSON.parse(document.getElementById("carveout-data").textContent);
var C = { bg: "#09090b", cell: "#1f1f23", cell2: "#26262b", seen: "#22c55e", soft: "rgba(34,197,94,0.5)", held: "#f43f5e", muted: "#71717a", dim: "#a1a1aa", text: "#fafafa", line: "rgba(255,255,255,0.08)", stub: "#f59e0b" };
var DISPLAY = "Display, 'Space Grotesk', system-ui, sans-serif";
var SANS = "Sans, 'DM Sans', system-ui, sans-serif";
var MONO = "Mono, 'DM Mono', ui-monospace, monospace";

// ---- data ----
var segs = D.segs, segsShare = D.segsShare || D.segs, dirs = D.dirs;
var N = D.files.length / 3;
var fDir = new Int32Array(N), fName = new Int32Array(N), fLines = new Float64Array(N);
for (var i = 0; i < N; i++) { fDir[i] = D.files[3 * i]; fName[i] = D.files[3 * i + 1]; fLines[i] = D.files[3 * i + 2]; }
function pathOf(i, share) {
  var s = share ? segsShare : segs, d = dirs[fDir[i]], parts = [];
  for (var k = 0; k < d.length; k++) parts.push(s[d[k]]);
  parts.push(s[fName[i]]);
  return parts.join("/");
}
function readRanges(arr, at) { var n = arr[at], out = []; for (var k = 0; k < n; k++) out.push([arr[at + 1 + 2 * k], arr[at + 2 + 2 * k]]); return { list: out, next: at + 1 + 2 * n }; }
function linesIn(list) { var t = 0; for (var k = 0; k < list.length; k++) t += list[k][1] - list[k][0] + 1; return t; }
function union(list) {
  if (list.length < 2) return list.slice();
  var s = list.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }), out = [s[0].slice()];
  for (var k = 1; k < s.length; k++) { var last = out[out.length - 1]; if (s[k][0] <= last[1] + 1) last[1] = Math.max(last[1], s[k][1]); else out.push(s[k].slice()); }
  return out;
}
function fmt(n) { return Math.round(n).toLocaleString("en-GB"); }
function pct(p) { if (p === 0) return "0%"; if (p < 0.1) return "<0.1%"; if (p < 10) return (Math.round(p * 10) / 10).toString() + "%"; return Math.round(p) + "%"; }
function day(ms) { return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

// Cumulative coverage: per file read, inferred and edited ranges.
function emptyState() { return { r: new Float64Array(N), f: new Float64Array(N), ed: new Uint8Array(N), cov: {} }; }
var total = emptyState();
(function () {
  var a = D.cover, at = 0;
  while (at < a.length) {
    var idx = a[at], flags = a[at + 1]; at += 2;
    var r = readRanges(a, at); at = r.next;
    var f = readRanges(a, at); at = f.next;
    var e = readRanges(a, at); at = e.next;
    var first = a[at], last = a[at + 1]; at += 2;
    total.cov[idx] = { r: r.list, f: f.list, e: e.list, ed: !!(flags & 1), first: D.t0 + first, last: D.t0 + last };
    total.r[idx] = linesIn(r.list); total.f[idx] = linesIn(f.list); total.ed[idx] = flags & 1;
  }
})();
var sessions = D.sessions.map(function (s) {
  var ev = [], a = s.ev, at = 0;
  while (at < a.length) {
    var t = a[at], file = a[at + 1], kind = a[at + 2], tool = a[at + 3]; at += 4;
    var r = readRanges(a, at); at = r.next;
    var e = readRanges(a, at); at = e.next;
    ev.push({ t: D.t0 + t, file: file, kind: kind, tool: D.tools[tool] || "", r: r.list, e: e.list });
  }
  s.events = ev;
  return s;
});

// ---- tree and treemap ----
var root = { name: "", kids: {}, list: [], files: [], value: 0, depth: 0 };
var dirNode = [];
for (var di = 0; di < dirs.length; di++) {
  var node = root, d = dirs[di];
  for (var k = 0; k < d.length; k++) {
    var key = d[k];
    if (!node.kids[key]) { var child = { seg: key, segs: [key], kids: {}, list: [], files: [], value: 0, depth: node.depth + 1, parent: node }; node.kids[key] = child; node.list.push(child); }
    node = node.kids[key];
  }
  dirNode[di] = node;
}
for (var fi = 0; fi < N; fi++) { var dn = dirNode[fDir[fi]]; dn.files.push(fi); for (var up = dn; up; up = up.parent) up.value += fLines[fi]; }
// A folder holding one folder and no file is drawn as one: "src/map".
(function collapse(n) {
  for (var k = 0; k < n.list.length; k++) {
    var c = n.list[k];
    while (c.files.length === 0 && c.list.length === 1) { var only = c.list[0]; c.segs = c.segs.concat(only.segs); c.kids = only.kids; c.list = only.list; c.files = only.files; for (var j = 0; j < c.list.length; j++) c.list[j].parent = c; }
    collapse(c);
  }
})(root);
function nodeName(n, share) { var s = share ? segsShare : segs; return n.segs.map(function (x) { return s[x]; }).join("/"); }

function squarify(items, x, y, w, h, place) {
  var sum = 0; for (var k = 0; k < items.length; k++) sum += items[k].v;
  if (sum <= 0 || w <= 0 || h <= 0) return;
  var scale = (w * h) / sum, i = 0;
  while (i < items.length) {
    var side = Math.min(w, h), row = [], rs = 0, worst = Infinity;
    while (i < items.length) {
      var a = items[i].v * scale; if (a <= 0) { i++; continue; }
      var nrs = rs + a, mx = a, mn = a;
      for (var j = 0; j < row.length; j++) { var ra = row[j].v * scale; if (ra > mx) mx = ra; if (ra < mn) mn = ra; }
      var nw = Math.max((side * side * mx) / (nrs * nrs), (nrs * nrs) / (side * side * mn));
      if (row.length > 0 && nw > worst) break;
      row.push(items[i]); rs = nrs; worst = nw; i++;
    }
    if (row.length === 0) break;
    if (w >= h) { var cw = rs / h, cy = y; for (var j2 = 0; j2 < row.length; j2++) { var ch = (row[j2].v * scale) / cw; place(row[j2], x, cy, cw, ch); cy += ch; } x += cw; w -= cw; }
    else { var rh = rs / w, cx = x; for (var j3 = 0; j3 < row.length; j3++) { var cw2 = (row[j3].v * scale) / rh; place(row[j3], cx, y, cw2, rh); cx += cw2; } y += rh; h -= rh; }
  }
}

// A layout: tile rectangles per file, and the folders with room for a label.
function layout(W0, H0, opts) {
  opts = opts || {};
  var L = { w: W0, h: H0, X: new Float32Array(N), Y: new Float32Array(N), W: new Float32Array(N), H: new Float32Array(N), groups: [] };
  var head1 = opts.head1 === undefined ? 18 : opts.head1, head2 = opts.head2 === undefined ? 14 : opts.head2;
  function lay(n, x, y, w, h) {
    var items = [];
    for (var k = 0; k < n.list.length; k++) if (n.list[k].value > 0) items.push({ v: n.list[k].value, node: n.list[k] });
    for (var k2 = 0; k2 < n.files.length; k2++) if (fLines[n.files[k2]] > 0) items.push({ v: fLines[n.files[k2]], file: n.files[k2] });
    items.sort(function (a, b) { return b.v - a.v; });
    squarify(items, x, y, w, h, function (it, ix, iy, iw, ih) {
      if (it.file !== undefined) { L.X[it.file] = ix; L.Y[it.file] = iy; L.W[it.file] = iw; L.H[it.file] = ih; return; }
      var c = it.node, pad = c.depth === 1 ? (opts.pad1 === undefined ? 3 : opts.pad1) : c.depth === 2 ? 1.5 : 0.5;
      var head = 0;
      if (c.depth === 1 && iw > 70 && ih > 46 && head1 > 0) head = head1;
      else if (c.depth === 2 && iw > 130 && ih > 80 && head2 > 0) head = head2;
      if (head > 0 || c.depth <= 2) L.groups.push({ node: c, x: ix, y: iy, w: iw, h: ih, head: head, depth: c.depth });
      lay(c, ix + pad, iy + pad + head, Math.max(0, iw - 2 * pad), Math.max(0, ih - 2 * pad - head));
    });
  }
  lay(root, 0, 0, W0, H0);
  return L;
}

var hatch = null;
function hatchPattern(ctx, color) {
  var p = document.createElement("canvas"); p.width = 6; p.height = 6;
  var g = p.getContext("2d"); g.strokeStyle = color; g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(-1, 7); g.lineTo(7, -1); g.moveTo(5, 7); g.lineTo(7, 5); g.moveTo(-1, 1); g.lineTo(1, -1); g.stroke();
  return ctx.createPattern(p, "repeat");
}

// One tile: grey, filled from the bottom by the share of its lines seen.
function drawTile(ctx, L, i, st, o) {
  var x = L.X[i], y = L.Y[i], w = L.W[i], h = L.H[i];
  if (!(w > 0 && h > 0)) return;
  o = o || {};
  var g = w > 2.5 && h > 2.5 ? 0.6 : 0;
  x += g; y += g; w -= 2 * g; h -= 2 * g;
  ctx.fillStyle = o.base || C.cell; ctx.fillRect(x, y, w, h);
  var lines = fLines[i], r = st.r[i], f = st.f[i];
  if (r + f > 0 && lines > 0) {
    var fr = Math.min(1, (r + f) / lines), fh = Math.max(Math.min(h, 1.5), h * fr);
    var rh = fh * (r / (r + f));
    ctx.fillStyle = st.ed[i] ? C.seen : C.soft;
    ctx.fillRect(x, y + h - rh, w, rh);
    if (f > 0) { ctx.fillStyle = hatch || C.soft; ctx.fillRect(x, y + h - fh, w, fh - rh); }
  }
  if (o.hot) { ctx.fillStyle = "rgba(220,255,230," + (0.55 * o.hot).toFixed(3) + ")"; ctx.fillRect(x, y, w, h); }
}

function drawLabels(ctx, L, share, st, scale) {
  scale = scale || 1;
  ctx.textBaseline = "middle";
  for (var k = 0; k < L.groups.length; k++) {
    var gr = L.groups[k]; if (!gr.head) continue;
    var n = gr.node, name = nodeName(n, share), seen = 0, all = 0;
    if (st) { (function walk(m) { for (var j = 0; j < m.files.length; j++) { seen += st.r[m.files[j]] + st.f[m.files[j]]; all += fLines[m.files[j]]; } for (var q = 0; q < m.list.length; q++) walk(m.list[q]); })(n); }
    var size = (gr.depth === 1 ? 11 : 10) * scale;
    ctx.font = "500 " + size + "px " + MONO;
    var maxw = gr.w - 8 * scale, label = name;
    var tag = st && seen > 0 ? "  " + pct((100 * seen) / all) : "";
    var tw = ctx.measureText(label + tag).width;
    while (tw > maxw && label.length > 3) { label = label.slice(0, -2); tw = ctx.measureText(label + "…" + tag).width; if (tw <= maxw) label += "…"; }
    if (tw > maxw) continue;
    ctx.fillStyle = gr.depth === 1 ? C.dim : C.muted;
    ctx.fillText(label, gr.x + 4 * scale, gr.y + gr.head / 2 + 1);
    if (tag) { ctx.fillStyle = C.seen; ctx.fillText(tag, gr.x + 4 * scale + ctx.measureText(label).width, gr.y + gr.head / 2 + 1); }
  }
}

// ---- page ----
var $ = function (id) { return document.getElementById(id); };
var stage = $("stage"), canvas = $("map"), ctx = canvas.getContext("2d");
var L = null, view = "map", grid = null, shown = total, dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
hatch = hatchPattern(ctx, "rgba(34,197,94,0.75)");

function sizeCanvas(cv, w, h) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + "px"; cv.style.height = h + "px"; var c2 = cv.getContext("2d"); c2.setTransform(dpr, 0, 0, dpr, 0, 0); return c2; }
function buildGrid() {
  var cell = 24, cols = Math.ceil(L.w / cell) + 1, rows = Math.ceil(L.h / cell) + 1, g = new Array(cols * rows);
  for (var i = 0; i < N; i++) {
    if (!(L.W[i] > 0 && L.H[i] > 0)) continue;
    var c0 = Math.floor(L.X[i] / cell), c1 = Math.floor((L.X[i] + L.W[i]) / cell), r0 = Math.floor(L.Y[i] / cell), r1 = Math.floor((L.Y[i] + L.H[i]) / cell);
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) { var at = r * cols + c; (g[at] || (g[at] = [])).push(i); }
  }
  grid = { cell: cell, cols: cols, g: g };
}
function tileAt(px, py) {
  if (!grid) return -1;
  var list = grid.g[Math.floor(py / grid.cell) * grid.cols + Math.floor(px / grid.cell)] || [];
  for (var k = 0; k < list.length; k++) { var i = list[k]; if (px >= L.X[i] && px < L.X[i] + L.W[i] && py >= L.Y[i] && py < L.Y[i] + L.H[i]) return i; }
  return -1;
}

function resize() {
  var w = stage.clientWidth, h = stage.clientHeight;
  if (w < 10 || h < 10) return;
  ctx = sizeCanvas(canvas, w, h);
  hatch = hatchPattern(ctx, "rgba(34,197,94,0.75)");
  L = layout(w, h);
  buildGrid();
  redraw();
  if (view === "carve") buildCarve();
}

var sliceSel = null; // { copied: Set, stub: Set }
function redraw() {
  if (!L) return;
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, L.w, L.h);
  for (var i = 0; i < N; i++) drawTile(ctx, L, i, shown);
  if (view === "slice" && sliceSel) drawSlice();
  drawLabels(ctx, L, false, shown);
  if (selected >= 0) outline(selected, C.text, 1.5);
}
function outline(i, color, width, dash) {
  if (!(L.W[i] > 0)) return;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; if (dash) ctx.setLineDash(dash);
  ctx.strokeRect(L.X[i] + 0.5, L.Y[i] + 0.5, Math.max(1, L.W[i] - 1), Math.max(1, L.H[i] - 1)); ctx.restore();
}

// ---- hover and detail ----
var tip = $("tip"), selected = -1;
canvas.addEventListener("mousemove", function (e) {
  var b = canvas.getBoundingClientRect(), i = tileAt(e.clientX - b.left, e.clientY - b.top);
  if (i < 0) { tip.style.display = "none"; return; }
  var seen = shown.r[i] + shown.f[i];
  tip.innerHTML = '<div class="tp">' + esc(pathOf(i, false)) + '</div><div class="tn">' + fmt(fLines[i]) + " lines" +
    (seen > 0 ? ' · <b>' + fmt(seen) + " seen</b> (" + pct((100 * seen) / fLines[i]) + ")" : " · not seen") +
    (shown.ed[i] ? ' · <b>edited</b>' : "") + (shown.f[i] > 0 ? ' · <i>' + fmt(shown.f[i]) + " inferred</i>" : "") + "</div>";
  tip.style.display = "block";
  var tx = e.clientX + 14, ty = e.clientY + 14;
  if (tx + tip.offsetWidth > window.innerWidth - 8) tx = e.clientX - tip.offsetWidth - 14;
  if (ty + tip.offsetHeight > window.innerHeight - 8) ty = e.clientY - tip.offsetHeight - 14;
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
});
canvas.addEventListener("mouseleave", function () { tip.style.display = "none"; });
canvas.addEventListener("click", function (e) {
  var b = canvas.getBoundingClientRect(), i = tileAt(e.clientX - b.left, e.clientY - b.top);
  selected = i; redraw(); detail(i);
});
function rangesText(list) { return list.length === 0 ? '<span class="m">none</span>' : list.map(function (r) { return r[0] === r[1] ? r[0] : r[0] + "–" + r[1]; }).join(", "); }
function detail(i) {
  var p = $("detail");
  if (i < 0) { p.classList.remove("open"); return; }
  var c = shown === total ? total.cov[i] : shown.cov[i];
  var h = '<button class="x" id="dx" aria-label="Close">×</button><div class="dp">' + esc(pathOf(i, false)) + '</div><div class="dn">' + fmt(fLines[i]) + " lines</div>";
  if (!c) h += '<p class="m">No session in this view showed a line of this file.</p>';
  else {
    h += '<dl><dt>Read by a file tool</dt><dd>' + rangesText(c.r) + "</dd>";
    h += '<dt>Inferred from shell commands</dt><dd>' + rangesText(c.f) + "</dd>";
    h += '<dt>Changed by an edit</dt><dd>' + (c.ed ? rangesText(c.e) : '<span class="m">not edited</span>') + "</dd>";
    if (c.first) h += "<dt>First and last seen</dt><dd>" + new Date(c.first).toLocaleString("en-GB") + "<br>" + new Date(c.last).toLocaleString("en-GB") + "</dd>";
    h += "</dl>";
  }
  h += '<p class="m small">Line ranges from local logs. This file holds paths and numbers only, never file contents.</p>';
  p.innerHTML = h; p.classList.add("open");
  $("dx").onclick = function () { selected = -1; detail(-1); redraw(); };
}

// ---- hero numbers ----
function setHero(n, label) {
  $("num").textContent = pct(n.percent);
  $("who").textContent = label || D.agentLabel + " has seen";
  $("sub").innerHTML = "<b>" + fmt(n.seenLines) + "</b> of " + fmt(n.lines) + " lines · <b>" + fmt(n.filesSeen) + "</b> of " + fmt(n.files) + " files read · <b>" + fmt(n.filesEdited) + "</b> edited" +
    (n.inferredLines > 0 ? ' · <i>' + fmt(n.inferredLines) + " lines inferred from shell commands</i>" : "");
}

// ---- tabs ----
var tabs = document.querySelectorAll("[data-view]");
function show(v) {
  view = v;
  for (var k = 0; k < tabs.length; k++) tabs[k].classList.toggle("on", tabs[k].getAttribute("data-view") === v);
  document.body.setAttribute("data-view", v);
  stopReplay(); stopCarve();
  tip.style.display = "none";
  if (v === "map") { shown = total; setHero(D.totals); }
  if (v === "replay") { prepReplay(); }
  if (v === "slice") { prepSlice(); }
  if (v === "share") { drawShare(); }
  if (v === "carve") { shown = total; setHero(D.totals); }
  if (v !== "share") requestAnimationFrame(function () { resize(); if (v === "carve") startCarve(); });
}
for (var t = 0; t < tabs.length; t++) tabs[t].addEventListener("click", function (e) { show(e.currentTarget.getAttribute("data-view")); });

// ---- replay ----
var rp = { s: null, i: 0, playing: false, raf: 0, start: 0, dur: 8000, hot: [], st: null };
function sessionLabel(s) { if (s.all) return "All " + (replayable.length - 1) + " sessions · " + pct(s.n.percent); return (s.agent === "codex" ? "Codex" : "Claude") + " · " + (s.start ? day(s.start) : "?") + " · " + pct(s.n.percent) + (s.title ? " · " + s.title : ""); }
function fillSelect(sel, list, pick) {
  sel.innerHTML = list.map(function (s, k) { return '<option value="' + k + '">' + esc(sessionLabel(s)) + "</option>"; }).join("");
  sel.value = String(pick);
}
var replayable = sessions.filter(function (s) { return s.events.length > 0; });
// Every session in one timeline, in the order their results came back: the default replay.
if (replayable.length > 1) {
  var allEv = [];
  for (var q = 0; q < replayable.length; q++) allEv = allEv.concat(replayable[q].events);
  allEv.sort(function (a, b) { return a.t - b.t; });
  replayable.push({ all: true, agent: "all", events: allEv, n: D.totals, start: allEv[0].t, slice: null });
}
function prepReplay() {
  var sel = $("rsess");
  if (replayable.length === 0) { $("rnote").textContent = "No session in this view has events to replay."; return; }
  if (!rp.s) { fillSelect(sel, replayable, replayable.length - 1); rp.s = replayable[replayable.length - 1]; }
  resetReplay();
}
function resetReplay() {
  rp.st = emptyState(); rp.i = 0; rp.hot = [];
  rp.dur = Math.max(4500, Math.min(rp.s.all ? 9000 : 12000, rp.s.events.length * 90));
  shown = rp.st; setHero({ percent: 0, seenLines: 0, lines: D.totals.lines, filesSeen: 0, files: D.totals.files, filesEdited: 0, inferredLines: 0 }, D.agentLabel + " had seen");
  $("rscrub").value = "0"; $("rtick").textContent = rp.s.events.length + " tool results · press play";
  redraw();
}
function applyEvent(st, ev) {
  var c = st.cov[ev.file] || (st.cov[ev.file] = { r: [], f: [], e: [], ed: false, first: ev.t, last: ev.t });
  if (ev.kind === 1) c.f = union(c.f.concat(ev.r)); else c.r = union(c.r.concat(ev.r));
  if (ev.kind === 2) { c.ed = true; c.e = union(c.e.concat(ev.e)); }
  c.last = ev.t;
  // Inferred lines are those no file tool returned.
  var fOnly = 0, rset = c.r;
  for (var k = 0; k < c.f.length; k++) { for (var l = c.f[k][0]; l <= c.f[k][1]; l++) { var inR = false; for (var q = 0; q < rset.length; q++) if (l >= rset[q][0] && l <= rset[q][1]) { inR = true; break; } if (!inR) fOnly++; } }
  st.r[ev.file] = Math.min(fLines[ev.file], linesIn(c.r)); st.f[ev.file] = Math.min(fLines[ev.file] - st.r[ev.file], fOnly); st.ed[ev.file] = c.ed ? 1 : 0;
}
function heroFrom(st) {
  var seen = 0, files = 0, ed = 0, inf = 0;
  for (var i = 0; i < N; i++) { var s = st.r[i] + st.f[i]; if (s > 0) { seen += s; files++; } inf += st.f[i]; if (st.ed[i]) ed++; }
  return { percent: (100 * seen) / D.totals.lines, seenLines: seen, lines: D.totals.lines, filesSeen: files, files: N, filesEdited: ed, inferredLines: inf };
}
function seekReplay(frac) {
  var target = Math.round(frac * rp.s.events.length);
  $("rscrub").value = String(Math.round(frac * 1000));
  if (target < rp.i) { rp.st = emptyState(); rp.i = 0; shown = rp.st; }
  var now = performance.now();
  while (rp.i < target) { var ev = rp.s.events[rp.i]; applyEvent(rp.st, ev); rp.hot.push({ f: ev.file, t: now }); rp.i++; }
  var last = rp.s.events[Math.max(0, rp.i - 1)];
  if (last && rp.i > 0) $("rtick").innerHTML = '<span class="m">' + new Date(last.t).toLocaleTimeString("en-GB") + "</span> " + esc(last.tool) + " <b>" + esc(pathOf(last.file, false)) + "</b> " + rangesText(last.r);
  setHero(heroFrom(rp.st), D.agentLabel + " had seen");
  drawReplayFrame(now);
}
function drawReplayFrame(now) {
  redraw();
  var keep = [];
  for (var k = 0; k < rp.hot.length; k++) {
    var h = rp.hot[k], age = (now - h.t) / 650;
    if (age < 1) { drawTile(ctx, L, h.f, rp.st, { hot: 1 - age }); keep.push(h); }
  }
  rp.hot = keep;
}
function stepReplay(now) {
  if (!rp.playing) return;
  var frac = Math.min(1, (now - rp.start) / rp.dur);
  $("rscrub").value = String(Math.round(frac * 1000));
  seekReplay(frac);
  if (frac >= 1 && rp.hot.length === 0) { rp.playing = false; $("rplay").textContent = "Replay"; return; }
  rp.raf = requestAnimationFrame(stepReplay);
}
function playReplay() {
  if (!rp.s) return;
  if (rp.i >= rp.s.events.length) resetReplay();
  rp.playing = true; $("rplay").textContent = "Pause";
  rp.start = performance.now() - (rp.i / Math.max(1, rp.s.events.length)) * rp.dur;
  rp.raf = requestAnimationFrame(stepReplay);
}
function stopReplay() { rp.playing = false; cancelAnimationFrame(rp.raf); var b = $("rplay"); if (b) b.textContent = "Play"; }
$("rplay").addEventListener("click", function () { if (rp.playing) stopReplay(); else playReplay(); });
$("rsess").addEventListener("change", function (e) { stopReplay(); rp.s = replayable[Number(e.target.value)]; resetReplay(); });
$("rscrub").addEventListener("input", function (e) { stopReplay(); seekReplay(Number(e.target.value) / 1000); });

// ---- slice overlay ----
var sliceable = sessions.filter(function (s) { return s.slice; });
function drawSlice() {
  for (var i = 0; i < N; i++) {
    if (sliceSel.copied.has(i)) outline(i, C.text, L.W[i] > 6 ? 1.5 : 1);
    else if (sliceSel.stub.has(i)) outline(i, C.stub, 1, [3, 2]);
  }
}
function prepSlice() {
  var box = $("snums"), sel = $("ssess");
  if (D.handoff) {
    sel.style.display = "none";
    var h = D.handoff;
    sliceSel = { copied: new Set(h.copied), stub: new Set(h.stub) };
    shown = total; setHero(D.totals);
    box.innerHTML = '<div><span class="k">This hand-off</span><b class="g">' + fmt(h.files) + " files</b> · " + pct(h.percent) + " of the repo</div>" +
      '<div><span class="k">Stubbed</span><b>' + fmt(h.stub.length) + " files</b> as .d.ts + mocks</div>" +
      '<div><span class="k">Not in the folder</span><b>' + fmt(N - h.copied.length - h.stub.length) + " files</b></div>";
    redraw(); return;
  }
  if (sliceable.length === 0) { sliceSel = null; box.innerHTML = '<div class="m">No session in this view edited a TypeScript file, so there is no change to slice.</div>'; shown = total; return; }
  fillSelect(sel, sliceable, sliceable.length - 1);
  pickSlice(sliceable[sliceable.length - 1]);
}
function pickSlice(s) {
  var st = emptyState(); for (var k = 0; k < s.events.length; k++) applyEvent(st, s.events[k]);
  shown = st; setHero(s.n, (s.agent === "codex" ? "Codex" : "Claude") + " read, this session");
  sliceSel = { copied: new Set(s.slice.copied), stub: new Set(s.slice.stub) };
  $("snums").innerHTML = '<div><span class="k">A slice of this change</span><b class="w">' + fmt(s.slice.files) + " files</b> · " + pct(s.slice.percent) + " of the repo</div>" +
    '<div><span class="k">Your agent read</span><b class="g">' + fmt(s.n.filesSeen) + " files</b> · " + pct(s.n.percent) + " of the repo</div>" +
    '<div class="m small">The slice is what <code>carveout plan</code> with the hand-off defaults would put in a folder for the ' + s.slice.entries + " file(s) this session edited. Outlined white: copied. Dashed amber: stubbed.</div>";
  redraw();
}
$("ssess").addEventListener("change", function (e) { pickSlice(sliceable[Number(e.target.value)]); });

// ---- the carve ----
var carve = { raf: 0, t0: 0, built: false, fixed: null };
function buildCarve() {
  var box = $("carve"), w = Math.min(stage.clientWidth * 0.62, 900), h = w * 0.62;
  var CL = layout(w, h, { head1: 0, head2: 0, pad1: 4 });
  var base = sizeCanvas($("cbase"), w, h), lift = sizeCanvas($("clift"), w, h), top = sizeCanvas($("ctop"), w, h);
  base.fillStyle = "#121215"; base.fillRect(0, 0, w, h);
  lift.clearRect(0, 0, w, h); top.clearRect(0, 0, w, h);
  var liftHatch = hatchPattern(lift, "rgba(34,197,94,0.85)");
  for (var i = 0; i < N; i++) {
    var seen = total.r[i] + total.f[i];
    if (seen > 0) {
      // The hole the lit tile lifts out of.
      base.fillStyle = "#040405"; base.fillRect(CL.X[i] + 0.5, CL.Y[i] + 0.5, Math.max(0.8, CL.W[i] - 1), Math.max(0.8, CL.H[i] - 1));
      var g = total.ed[i] ? top : lift;
      g.fillStyle = total.ed[i] ? C.seen : total.r[i] > 0 ? "rgba(34,197,94,0.78)" : liftHatch;
      var x = CL.X[i] + 0.5, y = CL.Y[i] + 0.5, ww = Math.max(0.8, CL.W[i] - 1), hh = Math.max(0.8, CL.H[i] - 1);
      g.fillRect(x, y, ww, hh);
    } else { base.fillStyle = C.cell; var gp = CL.W[i] > 2.5 ? 0.6 : 0; base.fillRect(CL.X[i] + gp, CL.Y[i] + gp, CL.W[i] - 2 * gp, CL.H[i] - 2 * gp); }
  }
  var slab = $("slab"); slab.style.width = w + "px"; slab.style.height = h + "px";
  box.style.setProperty("--w", w + "px"); box.style.setProperty("--h", h + "px");
  $("ccap").innerHTML = '<b class="g">' + pct(D.totals.percent) + "</b> of the repo lifts out: the lines " + esc(D.agentLabel) + " saw";
  carve.built = true;
}
function ease(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
function carveFrame(sec) {
  var t = sec % 7, k;
  if (t < 1.2) k = 0; else if (t < 3.2) k = ease((t - 1.2) / 2); else if (t < 5.4) k = 1; else if (t < 6.6) k = 1 - ease((t - 5.4) / 1.2); else k = 0;
  var tilt = 1 - Math.min(1, sec / 1.2);
  $("slab").style.transform = "rotateX(" + (58 - 8 * tilt) + "deg) rotateZ(" + (-38 + 6 * tilt) + "deg)";
  $("clift").style.transform = "translateZ(" + (70 * k) + "px)";
  $("ctop").style.transform = "translateZ(" + (120 * k) + "px)";
  $("cshadow").style.opacity = String(0.85 * k);
  $("cshadow").style.transform = "translateZ(1px) scale(" + (1 + 0.02 * k) + ")";
}
function startCarve() {
  buildCarve();
  carve.t0 = performance.now();
  var loop = function (now) { carveFrame(carve.fixed === null ? (now - carve.t0) / 1000 : carve.fixed); carve.raf = requestAnimationFrame(loop); };
  carve.raf = requestAnimationFrame(loop);
}
function stopCarve() { cancelAnimationFrame(carve.raf); }

// ---- share card ----
var shareReal = false, cardSize = "1200x630";
function cardText(share) { return share ? D.card.share : D.card.real; }
function drawCard(cv, W0, H0, share) {
  cv.width = W0; cv.height = H0;
  var g = cv.getContext("2d"), T = cardText(share), portrait = H0 > W0;
  g.fillStyle = C.bg; g.fillRect(0, 0, W0, H0);
  var rg = g.createRadialGradient(W0 * 0.3, -H0 * 0.1, 10, W0 * 0.3, -H0 * 0.1, W0 * 0.9);
  rg.addColorStop(0, "rgba(255,255,255,0.07)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg; g.fillRect(0, 0, W0, H0);
  var gg = g.createRadialGradient(W0 * 0.8, H0 * 0.9, 10, W0 * 0.8, H0 * 0.9, W0 * 0.7);
  gg.addColorStop(0, "rgba(34,197,94,0.10)"); gg.addColorStop(1, "rgba(34,197,94,0)");
  g.fillStyle = gg; g.fillRect(0, 0, W0, H0);
  var M = portrait ? 72 : 64;
  g.textBaseline = "alphabetic";
  g.font = "500 22px " + MONO; g.fillStyle = C.text; g.fillText("carveout map", M, M + 10);
  g.font = "400 18px " + MONO; g.fillStyle = C.muted; g.textAlign = "right"; g.fillText(T.repo, W0 - M, M + 10); g.textAlign = "left";
  var mapX, mapY, mapW, mapH, numSize, y;
  if (portrait) {
    y = M + 120;
    g.font = "500 22px " + MONO; g.fillStyle = C.muted; spaced(g, T.label.toUpperCase(), M, y, 3.2);
    numSize = 250; g.font = "600 " + numSize + "px " + DISPLAY; g.fillStyle = C.seen;
    g.shadowColor = "rgba(34,197,94,0.45)"; g.shadowBlur = 50; g.fillText(T.percent, M - 8, y + 230); g.shadowBlur = 0;
    g.font = "400 32px " + SANS; g.fillStyle = C.dim; g.fillText(T.of, M, y + 300);
    mapX = M; mapY = y + 350; mapW = W0 - 2 * M; mapH = H0 - mapY - 310;
  } else {
    y = M + 108;
    g.font = "500 20px " + MONO; g.fillStyle = C.muted; spaced(g, T.label.toUpperCase(), M, y, 3);
    numSize = 196; g.font = "600 " + numSize + "px " + DISPLAY; g.fillStyle = C.seen;
    g.shadowColor = "rgba(34,197,94,0.45)"; g.shadowBlur = 44; g.fillText(T.percent, M - 6, y + 184); g.shadowBlur = 0;
    g.font = "400 27px " + SANS; g.fillStyle = C.dim; g.fillText(T.of, M, y + 238);
    mapX = 640; mapY = 92; mapW = W0 - mapX - M; mapH = H0 - mapY - 112;
  }
  // The small map.
  g.save(); roundRect(g, mapX - 10, mapY - 10, mapW + 20, mapH + 20, 14); g.fillStyle = "rgba(255,255,255,0.03)"; g.fill();
  g.strokeStyle = C.line; g.lineWidth = 1; g.stroke(); g.restore();
  var CL = layout(mapW, mapH, { head1: portrait ? 26 : 20, head2: 0, pad1: 3 });
  g.save(); g.translate(mapX, mapY);
  var ht = hatch; hatch = hatchPattern(g, "rgba(34,197,94,0.75)");
  for (var i = 0; i < N; i++) drawTile(g, CL, i, total);
  hatch = ht;
  drawLabels(g, CL, share, total, portrait ? 1.35 : 1.15);
  g.restore();
  // Stats and the method note.
  var sy = portrait ? H0 - 190 : H0 - 68, sx = portrait ? M : M;
  var stats = T.stats;
  if (portrait) {
    var colW = (W0 - 2 * M) / stats.length;
    for (var k = 0; k < stats.length; k++) {
      g.font = "600 52px " + DISPLAY; g.fillStyle = k === 0 ? C.seen : C.text; g.fillText(stats[k][0], sx + k * colW, sy);
      g.font = "400 20px " + MONO; g.fillStyle = C.muted; g.fillText(stats[k][1], sx + k * colW, sy + 34);
    }
    g.font = "400 19px " + MONO; g.fillStyle = C.muted; wrap(g, T.note, M, H0 - M - 10, W0 - 2 * M, 26);
  } else {
    var colW2 = 186;
    for (var k2 = 0; k2 < stats.length; k2++) {
      g.font = "600 38px " + DISPLAY; g.fillStyle = k2 === 0 ? C.seen : C.text; g.fillText(stats[k2][0], sx + k2 * colW2, y + 320);
      g.font = "400 15px " + MONO; g.fillStyle = C.muted; g.fillText(stats[k2][1], sx + k2 * colW2, y + 346);
    }
    g.font = "400 16px " + MONO; g.fillStyle = C.muted; g.fillText(T.note, M, H0 - 40);
  }
  if (D.demo) {
    g.save(); g.font = "500 15px " + MONO; var tw = g.measureText("SAMPLE DATA").width;
    g.font = "500 22px " + MONO; var bx = M + g.measureText("carveout map").width + 20; g.font = "500 15px " + MONO;
    roundRect(g, bx, M - 10, tw + 24, 28, 6); g.fillStyle = "rgba(244,63,94,0.14)"; g.fill();
    g.fillStyle = C.held; g.fillText("SAMPLE DATA", bx + 12, M + 9); g.restore();
  }
}
function spaced(g, text, x, y, sp) { for (var k = 0; k < text.length; k++) { g.fillText(text[k], x, y); x += g.measureText(text[k]).width + sp; } }
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function wrap(g, text, x, yBottom, maxw, lh) {
  var words = text.split(" "), lines = [], cur = "";
  for (var k = 0; k < words.length; k++) { var t = cur ? cur + " " + words[k] : words[k]; if (g.measureText(t).width > maxw && cur) { lines.push(cur); cur = words[k]; } else cur = t; }
  if (cur) lines.push(cur);
  for (var j = 0; j < lines.length; j++) g.fillText(lines[j], x, yBottom - (lines.length - 1 - j) * lh);
}
function drawShare() {
  var parts = cardSize.split("x"), cv = $("card");
  drawCard(cv, Number(parts[0]), Number(parts[1]), !shareReal);
  $("realnote").style.display = shareReal ? "block" : "none";
}
var sizeBtns = document.querySelectorAll("[data-size]");
for (var sb = 0; sb < sizeBtns.length; sb++) sizeBtns[sb].addEventListener("click", function (e) {
  cardSize = e.currentTarget.getAttribute("data-size");
  for (var k = 0; k < sizeBtns.length; k++) sizeBtns[k].classList.toggle("on", sizeBtns[k] === e.currentTarget);
  drawShare();
});
var realBox = $("real");
if (realBox) realBox.addEventListener("change", function (e) { shareReal = e.target.checked; drawShare(); });
$("dl").addEventListener("click", function () {
  drawShare();
  var a = document.createElement("a");
  a.download = "carveout-map-" + cardSize + (shareReal ? "-real-names" : "") + ".png";
  a.href = $("card").toDataURL("image/png"); a.click();
});

// ---- start ----
function fontsReady() { return document.fonts && document.fonts.load ? Promise.all(["600 40px Display", "400 20px Sans", "500 20px Mono", "400 20px Mono"].map(function (f) { return document.fonts.load(f); })).then(function () { return document.fonts.ready; }) : Promise.resolve(); }
var hash = location.hash.replace(/^#/, "");
var cardOnly = /^card=(\d+)x(\d+)/.exec(hash);
window.carveoutMap = {
  show: show,
  replayAt: function (frac) { if (view !== "replay") show("replay"); stopReplay(); seekReplay(frac); },
  carveAt: function (sec) { carve.fixed = sec; carveFrame(sec); },
  ready: false
};
fontsReady().then(function () {
  if (cardOnly) {
    document.body.className = "cardonly";
    var cv = $("card"); drawCard(cv, Number(cardOnly[1]), Number(cardOnly[2]), true);
    document.body.appendChild(cv);
    window.carveoutMap.ready = true;
    return;
  }
  setHero(D.totals);
  if (D.empty) { $("empty").style.display = "flex"; }
  var start = /^(map|replay|slice|carve|share)$/.test(hash) ? hash : D.handoff ? "slice" : "map";
  show(start);
  window.addEventListener("resize", function () { if (view !== "share") resize(); });
  window.carveoutMap.ready = true;
});
})();
`;
