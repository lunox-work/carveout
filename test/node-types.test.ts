import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ambientDeclarations, projectCompilerOptions, scanNamedImports } from "../src/project/project.js";
import { packageModules, packageUses } from "../src/extract/fixture.js";

test("web slices preserve bundler module resolution", () => {
  const web = projectCompilerOptions({ module: "ESNext", moduleResolution: "Bundler" });
  assert.equal(web["module"], "ESNext");
  assert.equal(web["moduleResolution"], "Bundler");
  assert.equal(projectCompilerOptions(undefined)["moduleResolution"], "NodeNext");
});

test("mock packages export names destructured from dynamic imports", () => {
  const names = scanNamedImports([{
    path: "src/launcher.ts",
    originalPath: "src/launcher.ts",
    text: 'async function launch() { const { ECSClient, RunTaskCommand: Command } = await import("@aws-sdk/client-ecs"); return [ECSClient, Command]; }',
  }]);
  assert.deepEqual([...names.get("@aws-sdk/client-ecs") ?? []], ["ECSClient", "RunTaskCommand"]);
  const uses = packageUses(new Map([["launcher.ts", 'async function launch() { const { RunTaskCommand: Command } = await import("@aws-sdk/client-ecs"); return Command; }']]), (name) => name === "@aws-sdk/client-ecs");
  assert.match(packageModules(uses).text, /export const RunTaskCommand:/);
});

test("real Node declarations narrow File and type callbacks in a slice", () => {
  const dir = mkdtempSync(join(tmpdir(), "carveout-node-types-"));
  try {
    symlinkSync(resolve(import.meta.dirname, "../../node_modules"), join(dir, "node_modules"));
    writeFileSync(join(dir, "ambient.d.ts"), ambientDeclarations([], undefined, new Set(), true));
    writeFileSync(join(dir, "index.ts"), `
import { spawn } from "node:child_process";
export function size(value: unknown) { return value instanceof File ? value.size : 0; }
export function encode(value: Buffer) { return value.toString("base64"); }
spawn("node").on("exit", (code) => { const status: number | null = code; return status; });
`);
    const result = spawnSync(process.execPath, [resolve(dir, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "index.ts", "ambient.d.ts"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
