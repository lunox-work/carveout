/**
 * Paths inside a generated folder, as `/`-separated strings: pure, with no
 * Node module and no compiler, so the pseudonyms entry (`carveout/pseudonyms`)
 * can use them in a browser.
 */

export function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** `../lib/service.js` from `src/app.ts` to `lib/service.ts`. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  const from = dirnameOf(fromFile).split("/").filter(Boolean);
  const to = toFile.split("/").filter(Boolean);
  let common = 0;
  while (
    common < from.length &&
    common < to.length - 1 &&
    from[common] === to[common]
  )
    common += 1;
  const up = from.length - common;
  const rest = to.slice(common).join("/");
  const prefix = up === 0 ? "./" : "../".repeat(up);
  return `${prefix}${runtimePath(rest)}`;
}

/** The emitted JavaScript path of a TypeScript source path. */
export function runtimePath(path: string): string {
  if (path.endsWith(".d.ts")) return `${path.slice(0, -5)}.js`;
  if (path.endsWith(".mts")) return `${path.slice(0, -4)}.mjs`;
  if (path.endsWith(".cts")) return `${path.slice(0, -4)}.cjs`;
  if (path.endsWith(".tsx") || path.endsWith(".ts"))
    return `${path.replace(/\.tsx?$/, "")}.js`;
  return path;
}
