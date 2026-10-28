// E3: are co-change hints right often enough to show?
// node experiments/e3-cochange.mjs  → results/e3.json
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, SLICES, WORK, cloneOf, cutAt, firstParent, frozenCli, git } from "./lib.mjs";

const cli = frozenCli();
const { coChangeHints, history } = await import("./cochange.mjs");
const NEVER = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG\.md)$/;

// The slice's files at HEAD, and each repository's history split at T.
const repos = {};
for (const slice of SLICES.slices) {
  const clone = cloneOf(slice.repo, "e3");
  const head = SLICES.repositories[slice.repo].head;
  const out = join(WORK, "e3", slice.id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(WORK, "e3"), { recursive: true });
  const cut = cutAt(cli, clone, slice, head, out);
  if (cut.code !== 0 && cut.code !== 2) throw new Error(`${slice.id}: ${cut.stderr}`);
  slice.included = JSON.parse(readFileSync(join(out, "carveout.json"), "utf8")).manifest.included.map(
    (file) => file.path,
  );
  if (repos[slice.repo] === undefined) {
    const fp = firstParent(clone, head);
    const split = fp[Math.floor(0.7 * fp.length)];
    const T = git(clone, ["show", "-s", "--format=%cI", split]).trim();
    const all = history(clone, { commits: 100000 });
    repos[slice.repo] = { T, split, commits: fp.length, all };
  }
}

function score(repo, params) {
  const { T, all } = repos[repo];
  const fit = all.filter((c) => c.date <= T).slice(0, params.N);
  const later = all.filter((c) => c.date > T && c.files.length <= 50);
  let hints = 0;
  let confirmed = 0;
  let caught = 0;
  let coChanged = 0;
  let scored = 0;
  const perSlice = [];
  for (const slice of SLICES.slices.filter((s) => s.repo === repo)) {
    const inside = new Set(slice.included);
    const list = coChangeHints(fit, slice.included, {
      minCount: params.k,
      minShare: params.x,
      max: 5,
      maxCommitFiles: 50,
    });
    const scoring = later.filter((c) => c.files.some((f) => inside.has(f)));
    const changed = new Set(
      scoring.flatMap((c) => c.files).filter((f) => !inside.has(f) && !NEVER.test(f)),
    );
    const ok = list.filter((h) => changed.has(h.path));
    hints += list.length;
    confirmed += ok.length;
    caught += ok.length;
    coChanged += changed.size;
    scored += scoring.length;
    perSlice.push({
      slice: slice.id,
      hints: list.map((h) => `${h.path} (${h.count}, ${h.share.toFixed(2)})`),
      confirmed: ok.map((h) => h.path),
      scoringCommits: scoring.length,
      coChanged: changed.size,
    });
  }
  return {
    hints,
    confirmed,
    precision: hints === 0 ? null : confirmed / hints,
    recall: coChanged === 0 ? null : caught / coChanged,
    scoringCommits: scored,
    perSlice,
  };
}

const grid = [];
for (const N of [100, 300, 1000])
  for (const k of [2, 3])
    for (const x of [0.2, 0.3, 0.5]) grid.push({ N, k, x, ...score("sandbox-factory", { N, k, x }) });
const eligible = grid.filter((g) => g.hints >= 3 && g.precision !== null);
eligible.sort((a, b) => b.precision - a.precision || (b.recall ?? 0) - (a.recall ?? 0));
const chosen = eligible[0];
const params = { N: chosen.N, k: chosen.k, x: chosen.x };
const heldOut = Object.fromEntries(
  ["private-api", "private-site"].map((repo) => [repo, score(repo, params)]),
);
const pass = Object.values(heldOut).every((r) => r.precision !== null && r.precision >= 0.3);
const result = {
  experiment: "E3",
  cli: cli.id,
  splits: Object.fromEntries(
    Object.entries(repos).map(([repo, r]) => [repo, { T: r.T, split: r.split, firstParentCommits: r.commits }]),
  ),
  grid: grid.map(({ perSlice, ...rest }) => rest),
  chosen: params,
  tuning: chosen,
  heldOut,
  pass,
};
mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", "e3.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(
  `chosen ${JSON.stringify(params)} sandbox-factory precision ${chosen.precision?.toFixed(2)} recall ${chosen.recall?.toFixed(2)} hints ${chosen.hints}\n` +
    Object.entries(heldOut)
      .map(([repo, r]) => `${repo}: precision ${r.precision?.toFixed(2) ?? "none"} recall ${r.recall?.toFixed(2) ?? "none"} hints ${r.hints} scoring commits ${r.scoringCommits}`)
      .join("\n") +
    `\nE3 ${pass ? "PASS" : "FAIL"}\n`,
);
