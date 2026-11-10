/**
 * The version catalogs a pnpm or Bun workspace pins through (`catalog:`),
 * which npm cannot read: a slice takes the catalog's version.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkspaceCatalogs } from "../src/project/catalog.js";

test("a pnpm workspace's catalogs are read, the default and the named", () => {
  const catalogs = parseWorkspaceCatalogs(
    [
      "packages:",
      "  - packages/*",
      "",
      "catalog:",
      "  '@ai-sdk/anthropic': ^4.0.87",
      "  zod: 3.25.0 # pinned",
      "",
      "catalogMode: strict",
      "",
      "catalogs:",
      "  # the compiler",
      "  typescript:",
      "    tsdown: ^0.22.8",
      "    typescript: 7.0.2",
      "  typescript-tooling:",
      "    typescript: 'npm:@typescript/typescript6@6.0.2'",
      "",
    ].join("\n"),
  );
  assert.equal(catalogs.get("default")?.get("@ai-sdk/anthropic"), "^4.0.87");
  assert.equal(catalogs.get("default")?.get("zod"), "3.25.0");
  assert.equal(catalogs.get("typescript")?.get("typescript"), "7.0.2");
  assert.equal(catalogs.get("typescript-tooling")?.get("typescript"), "npm:@typescript/typescript6@6.0.2");
  assert.equal(catalogs.get("default")?.get("packages/*"), undefined);
});
