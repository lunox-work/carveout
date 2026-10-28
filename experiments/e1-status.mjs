// E1: does `carveout status` ever say current when a fresh cut differs?
// node experiments/e1-status.mjs [slice ids...]  → results/e1.jsonl
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  HERE,
  SLICES,
  WORK,
  carveout,
  checkout,
  chooseC0,
  cloneOf,
  cutAt,
  frozenCli,
  recordedPaths,
  sameTree,
  touching,
} from "./lib.mjs";
import { readFileSync } from "node:fs";

const cli = frozenCli();
const only = process.argv.slice(2);
const out = join(HERE, "results", "e1.jsonl");
mkdirSync(join(HERE, "results"), { recursive: true });

for (const slice of SLICES.slices) {
  if (only.length > 0 && !only.includes(slice.id)) continue;
  const clone = cloneOf(slice.repo);
  const scratch = join(WORK, "e1", slice.id);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const c0 = chooseC0(cli, clone, slice, scratch);
  const record = JSON.parse(readFileSync(join(c0.out, "carveout.json"), "utf8"));
  const later = touching(clone, c0.head, recordedPaths(record), c0.sha).slice(0, 50);
  process.stderr.write(`${slice.id}: C0 ${c0.sha.slice(0, 10)}, ${later.length} later commits\n`);
  for (const sha of later) {
    checkout(clone, sha);
    const status = carveout(cli, ["status", c0.out, "--json"]);
    let parsed = null;
    try {
      parsed = JSON.parse(status.stdout);
    } catch {}
    const fresh = join(scratch, "fresh");
    const cut = cutAt(cli, clone, slice, sha, fresh);
    const cutOk = cut.code === 0 || cut.code === 2;
    const differ = cutOk ? sameTree(c0.out, fresh) : ["<cut failed>"];
    const line = {
      experiment: "E1",
      cli: cli.id,
      slice: slice.id,
      repo: slice.repo,
      c0: c0.sha,
      commit: sha,
      statusExit: status.code,
      statusCurrent: parsed?.current ?? null,
      causes: parsed?.stale?.map((item) => item.cause) ?? null,
      inputsChanged: parsed?.inputsChanged?.length ?? null,
      freshIdentical: differ.length === 0,
      differ: differ.slice(0, 20),
      differCount: differ.length,
      statusMs: status.ms,
      cutMs: cut.ms,
      cutExit: cut.code,
    };
    appendFileSync(out, `${JSON.stringify(line)}\n`);
    if (line.statusCurrent === true && !line.freshIdentical)
      process.stderr.write(`  FALSE CURRENT at ${sha.slice(0, 10)}: ${differ.join(", ")}\n`);
  }
}
