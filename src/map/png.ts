/**
 * The share card as a PNG, rendered headlessly: by an installed Chrome,
 * Chromium, Edge or Brave (`CHROME_PATH` names another), else by
 * Playwright when it is installed. The page rendered is written in
 * pseudonyms alone (`shareOnly`), unless real names are asked for, so the
 * image cannot hold a name the file does not.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The share card's two sizes. */
export const CARD_SIZES = { landscape: [1200, 630], portrait: [1080, 1350] } as const;

/** A Chromium-family browser on this machine, or null. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env["CHROME_PATH"] ?? env["CARVEOUT_CHROME"];
  if (named !== undefined && existsSync(named)) return named;
  const mac = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Google Chrome Canary"].flatMap((app) =>
    ["/Applications", join(homedir(), "Applications")].map((dir) => join(dir, `${app}.app`, "Contents", "MacOS", app)),
  );
  const windows = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].flatMap((name) => {
    const base = env[name];
    return base === undefined
      ? []
      : [join(base, "Google", "Chrome", "Application", "chrome.exe"), join(base, "Microsoft", "Edge", "Application", "msedge.exe")];
  });
  for (const path of process.platform === "darwin" ? mac : process.platform === "win32" ? windows : []) if (existsSync(path)) return path;
  if (process.platform !== "win32" && process.platform !== "darwin")
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
      try {
        const found = execFileSync("which", [name], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
        if (found !== "") return found;
      } catch {
        // Not on PATH.
      }
    }
  return null;
}

export type PngResult = { readonly ok: true; readonly path: string; readonly by: string } | { readonly ok: false; readonly reason: string };

/** Screenshots `html`'s share card at `width`×`height` into `out`. */
export async function renderCardPng(html: string, out: string, width: number, height: number): Promise<PngResult> {
  const dir = mkdtempSync(join(tmpdir(), "carveout-card-"));
  const page = join(dir, "card.html");
  writeFileSync(page, html);
  const url = `${pathToFileURL(page).href}#card=${width}x${height}`;
  const target = resolve(out);
  try {
    const chrome = findChrome();
    if (chrome !== null) {
      const run = spawnSync(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          `--user-data-dir=${join(dir, "profile")}`,
          "--force-device-scale-factor=1",
          `--window-size=${width},${height}`,
          "--virtual-time-budget=10000",
          `--screenshot=${target}`,
          url,
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 },
      );
      if (existsSync(target) && statSync(target).size > 0) return { ok: true, path: target, by: chrome };
      const playwright = await withPlaywright(url, target, width, height);
      if (playwright.ok) return playwright;
      return { ok: false, reason: `${chrome} wrote no image (exit ${run.status ?? run.signal}).` };
    }
    return await withPlaywright(url, target, width, height);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withPlaywright(url: string, target: string, width: number, height: number): Promise<PngResult> {
  let chromium: { launch: () => Promise<unknown> } | undefined;
  for (const name of ["playwright", "playwright-core"]) {
    try {
      chromium = ((await import(name)) as { chromium?: { launch: () => Promise<unknown> } }).chromium;
      if (chromium !== undefined) break;
    } catch {
      // Not installed.
    }
  }
  if (chromium === undefined) return { ok: false, reason: "no Chrome, Chromium, Edge or Brave was found (set CHROME_PATH), and Playwright is not installed." };
  type Page = { goto(url: string): Promise<unknown>; waitForFunction(fn: string): Promise<unknown>; screenshot(o: object): Promise<unknown> };
  type Browser = { newPage(o: object): Promise<Page>; close(): Promise<void> };
  const browser = (await chromium.launch()) as Browser;
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(url);
    await page.waitForFunction("window.carveoutMap && window.carveoutMap.ready");
    await page.screenshot({ path: target, clip: { x: 0, y: 0, width, height } });
    return { ok: true, path: target, by: "Playwright" };
  } catch (error) {
    return { ok: false, reason: `Playwright could not render it: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await browser.close();
  }
}

/** Opens a file with the system's viewer, without waiting for it. */
export function openFile(path: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [path]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", path]] : ["xdg-open", [path]];
  try {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No viewer: the path is printed.
  }
}
