// Records assets/map.gif: carveout map's replay, then the carve, on the sample data
// (labelled SAMPLE DATA on the page). Needs Playwright and gifenc, and a built CLI:
// npm run build && PLAYWRIGHT=<dir containing node_modules/playwright-core and gifenc> node assets/src/record-map.mjs
// Uses the installed Chrome (channel "chrome"); CHROME_CHANNEL= picks Playwright's own Chromium.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const require = createRequire(path.resolve(process.env.PLAYWRIGHT ?? process.cwd(), "package.json"));
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}
const { GIFEncoder, quantize, applyPalette } = require("gifenc");

/** An 8-bit, non-interlaced PNG (as Chrome writes screenshots) to RGBA pixels. */
function decodePng(buffer) {
  let at = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const data = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const kind = buffer.toString("ascii", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      type = body[9];
    } else if (kind === "IDAT") data.push(body);
    at += 12 + length;
  }
  const channels = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * channels];
      out[(y * width + x) * 4 + 1] = line[x * channels + 1];
      out[(y * width + x) * 4 + 2] = line[x * channels + 2];
      out[(y * width + x) * 4 + 3] = 255;
    }
    previous.set(line);
  }
  return { width, height, pixels: out };
}

const dir = mkdtempSync(path.join(tmpdir(), "carveout-gif-"));
const html = path.join(dir, "map.html");
execFileSync(process.execPath, [path.join(repo, "dist/src/cli.js"), "map", "--demo", "--no-open", "--out", html], { stdio: "inherit" });
const browser = await chromium.launch(process.env.CHROME_CHANNEL === "" ? {} : { channel: process.env.CHROME_CHANNEL ?? "chrome" });
const width = 960;
const height = 600;
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(html).href}#replay`);
await page.waitForFunction("window.carveoutMap && window.carveoutMap.ready");
const fps = 10;
const gif = GIFEncoder();
let palette = null;
let last = null;
// One palette for the whole loop, its last entry kept for "unchanged": each
// frame after the first holds only the pixels that changed.
const TRANSPARENT = 127;
const frame = async (delay) => {
  const { pixels } = decodePng(await page.screenshot({ type: "png" }));
  const index = applyPalette(pixels, palette.slice(0, TRANSPARENT));
  if (last === null) gif.writeFrame(index, width, height, { palette, delay, dispose: 1 });
  else {
    const delta = new Uint8Array(index);
    for (let i = 0; i < delta.length; i++) if (index[i] === last[i]) delta[i] = TRANSPARENT;
    gif.writeFrame(delta, width, height, { palette, delay, dispose: 1, transparent: true, transparentIndex: TRANSPARENT });
  }
  last = index;
};
// Replay: every sample session in order, 3.8 s.
// The palette comes from the end of the replay, when the most green is lit.
await page.evaluate(() => window.carveoutMap.replayAt(1));
palette = [...quantize(decodePng(await page.screenshot({ type: "png" })).pixels, TRANSPARENT), [0, 0, 0]];
for (let i = 0; i <= 3.8 * fps; i++) {
  await page.evaluate((f) => window.carveoutMap.replayAt(f), i / (3.8 * fps));
  await frame(1000 / fps);
}
await frame(700);
// The carve: tilt, lift, hold, 4 s.
await page.evaluate(() => window.carveoutMap.show("carve"));
await page.waitForTimeout(300);
for (let i = 0; i <= 4 * fps; i++) {
  await page.evaluate((s) => window.carveoutMap.carveAt(s), (i / fps) * 1.25);
  await frame(1000 / fps);
}
await frame(900);
await browser.close();
gif.finish();
writeFileSync(path.join(here, "..", "map.gif"), gif.bytes());
rmSync(dir, { recursive: true, force: true });
console.log(`assets/map.gif: ${(gif.bytes().length / 1024 / 1024).toFixed(1)} MB`);
