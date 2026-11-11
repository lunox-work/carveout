/**
 * Loaded before every test file (`node --import`): cuts write receipts
 * under `CARVEOUT_HOME`, which a test run keeps out of the user's home.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env["CARVEOUT_HOME"] === undefined)
  process.env["CARVEOUT_HOME"] = mkdtempSync(join(tmpdir(), "carveout-home-"));
