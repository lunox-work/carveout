// Renders assets/hero.png from index.html at 2x. Needs Playwright:
// PLAYWRIGHT=<dir containing node_modules/playwright> node assets/src/render.mjs
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(process.env.PLAYWRIGHT ?? process.cwd(), "package.json"));
const { chromium } = require("playwright");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(path.join(here, "index.html")).href);
await page.evaluate(() => document.fonts.ready);
await page.locator("#hero").screenshot({ path: path.join(here, "..", "hero.png") });
await browser.close();
