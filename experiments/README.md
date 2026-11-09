# Experiments

The procedures below were fixed before any of them ran, so the measurements
in [RESULTS.md](RESULTS.md) can't be tuned to the rules. The ideas and pass
criteria come from the plan in [PLAN.md](PLAN.md); this file adds only what the plan
leaves open.

## Common

- **Slices.** The thirteen in `slices.json`, cut with `--max-files 200`
  and their own flags.
- **History.** Only first-parent history. Each repository is cloned into
  `work/` with `git clone --shared` and checked out only there. The
  repositories themselves are never checked out or written to.
- **Offline cuts.** Every cut in E1 and E2 runs with `--offline`, so no
  registry answer varies between two cuts.
- **Frozen CLI.** The CLI under test is a frozen copy of `dist/`. Every
  result line names its hash, and the carveout commit with `+dirty` when
  the tree had uncommitted changes.
- **Recorded paths.** For a cut, these are:
  - its included files;
  - the files of the modules it cuts;
  - its resolution `inputs`.
- **The cut commit, C0.** Chosen per slice like this:
  1. Cut at HEAD and take its recorded paths.
  2. List the first-parent commits that touch them.
  3. Take the parent of the 50th most recent such commit, or of the oldest
     one when there are fewer.
  4. Move forward along first-parent history until every entry point exists
     and the cut exits 0 or 2. That commit is C0.

## E1: status

- **Later commits.** The first-parent commits after C0 that touch C0's
  recorded paths, oldest first, at most 50.
- **Each later commit.** Check it out in the clone, then:
  - run `carveout status` on the C0 folder;
  - cut afresh into an empty folder.
- **Ground truth.** Whether every file of the fresh cut except
  `carveout.json` is byte-identical to the C0 folder's, with the same set of
  paths. A fresh cut that fails counts as different.
- **Pass.** No commit where status says `current` while the fresh cut
  differs.
- **Also reported:**
  - the share of commits marked `current`;
  - commits where status says stale and the fresh cut is identical;
  - the time status takes against the time a cut takes.

## E2: patches after the repository moves

- **Edited files.** The two included script files (not `.d.ts`) that
  changed in the most first-parent commits after C0, ties broken by path.
  A slice with only one script file gets one edit.
- **The edit.** Insert `export const carveoutE2Marker<n> = <n>;` as a new
  line after the top-level statement whose end is nearest the middle of the
  file, in the C0 folder. Then run `carveout patch`.
- **Cases.** Each first-parent commit after C0 that changed an edited file,
  at most 50 per slice.
- **Each case:**
  - _Plain:_ `git apply --check` exits 0.
  - _Three-way:_ `git apply --3way` exits 0 and leaves no unmerged paths.
  - _Typecheck,_ only for a clean three-way apply: `tsc --noEmit -p` on the
    nearest tsconfig of each edited file, run on the commit and on the
    commit with the patch applied. It typechecks when the patched run adds
    no error. Errors are compared as (file, code, message) without line
    numbers, because the inserted line moves them. TypeScript and
    `node_modules` are borrowed read-only from the live checkout.
- **Pass.** Pooled over all cases, the share that apply three-way and
  typecheck is at least 25 percentage points above the share that apply
  plain.

## E3: co-change hints

- **The split, T.** The commit date of the first-parent commit at 70% of
  each repository's history.
- **Fitting.** Uses the N first-parent commits before T that touch at most
  50 files. A hint is a file outside the slice (the slice's included files
  at HEAD) that:

  - changed in at least k of the fitting commits that touch an included
    file;
  - and in at least x of them, as a share.

  Hints are ranked by count, then share, then path, and kept to 5 per
  slice. Lockfiles and `CHANGELOG.md` are never hints. That rule was added
  to the feature before E3 ran, not tuned on its results.

- **Scoring.** Uses the first-parent commits after T that touch an included
  file and at most 50 files. A hint is _confirmed_ when it changed in at
  least one of them. Over a repository's slices:
  - precision = confirmed hints / hints;
  - recall = co-changed files that were hints / co-changed files, where a
    co-changed file is one outside the slice that changed in a scoring
    commit.
- **Tuning on sandbox-factory.** The grid is N ∈ {100, 300, 1000},
  k ∈ {2, 3} and x ∈ {0.2, 0.3, 0.5}. The highest precision wins, ties go to
  the higher recall, and a setting must give at least 3 hints. That setting
  is then scored unchanged on private-api and private-site.
- **Pass.** Precision of at least 0.3 on both held-out repositories. A
  repository with no hints, or with no scoring commits, has no precision
  and fails.

## E4: graph time

- **Repositories.** Public TypeScript repositories shallow-cloned at their
  default branch, with about 5k, 20k and 45k script files as `listFiles`
  counts them.
- **Measurement.** `buildGraph` timed over 3 runs, reporting the median:
  - total;
  - listing the files;
  - parsing (reading, `preProcessFile`, `createSourceFile` and the dynamic
    import walk);
  - resolving (`loadConfig` and `resolveModuleName`).
- **Step 2** runs only if the median at about 20k files is over 10 s.

## E5: replaying real commits

The pass bars are in [PLAN-benchmark.md](PLAN-benchmark.md), Phase 2. The
script is `e5-replay.mjs`.

- **Cases.** `e5-cases.json`: the eleven sandbox-factory commits of
  duediligence's in-repo evidence, each with its package and its seam (the
  files its ticket names, drafted without the diff).
- **Entries.**
  - _seam:_ each seam file that exists at the commit's parent B. A seam
    file the commit adds (ten of eleven cases) is replaced by its nearest
    folder that exists at B, through that folder's `index.ts` when it has
    one. This uses the seam alone, never the diff.
  - _diff:_ the files the commit changed in its package outside tests,
    without the ones it added.
- **Cut.** At B, `--with-tests --depth 1 --max-files 200`, online (as a
  person would cut).
- **In the slice.** The slice's tests run at B (the baseline) and again
  after `carveout apply --stubs` of the whole commit. The verdict is per
  test, by name, against the baseline:
  - it holds when every test that passed at baseline still passes, and
    every test the change adds passes;
  - a test that already fails at baseline fails on the mocks, not on the
    change, and is counted, not judged.
- **Round trip.** `carveout merge` into a clean clone at B. Every path the
  apply wrote must be patched, nothing else may be, and each must be
  byte-identical to the commit.
- **Coverage.** The commit's code files in its package that the apply
  wrote nowhere (`outsideCode`), and its test files inside and outside the
  slice.
- **After the merge.** The commit's package test files the slice did not
  hold are laid over the clone. Then `turbo run build` builds the package's
  dependencies, and its test script runs twice:
  - _functional:_ with the coverage flags and the `assert-all-covered`
    step removed;
  - _gate:_ as written.
- **Oracle.** The same judge on B, and on B plus the commit's whole package
  change.
- **Installs.** One `npm ci` (npm 10.9.2, `--ignore-scripts`) per distinct
  lockfile, kept in the target clone. Test runs get a 4 GB heap cap.

## E6b and E7: the grown corpus and the plan arm

The rules are in [PLAN-benchmark.md](PLAN-benchmark.md), Phase 6. What
the plan leaves open:

- **Candidates** come from a discovery pass over sandbox-factory's
  first-parent history that, unlike duediligence's `discover`, lets a commit
  touch several packages; the (commit, package) pair is the candidate, and
  `check` scopes the commit to the package's allowed paths as it does for
  the 11. The case set is `duediligence/evidence/in-repo-e6b/` (cases,
  ledger, specs), run with `--cases`.
- **Specs** are the `<slug>-confirmed` arm's, copied into `bench/specs/<slug>/`
  as the 11 were; a case that reaches the bench has `corpus: "e6b"` in
  `e5-cases.json`.
- **Runs** use `BENCH_TAG=e6b` and `BENCH_RESULTS=results/bench-e6b.jsonl`,
  so E6a's rows (keyed by case, arm, model and run, not by CLI) do not
  stand in for E6b's. `bench/analyze.mjs --cases <the corpus>` reads them,
  and `--arm slice-plan` reads E7's rows.
- **The plan arm** (E7) was retired on 2026-11-06: its session read the
  whole private repository, which the slice exists to keep closed, for 17%
  more input and no more accepted changes. `run.mjs` no longer runs it; its
  rows stay in `results/` and `analyze.mjs --arm slice-plan` still reads them.
- **Live services.** `cutSlice` in `bench/cases.mjs` adds `--live <driver>`
  for a case whose package imports the driver directly (`liveOf`); the
  choice is in the result line's `setup`. The host must run the service the
  repository's own test connects to, or the tests skip in both arms.
- **The guard.** `sliceTests` reads `npm test`'s never-loaded-file line as
  `guardFailed`, and `verdictOf` fails on it as it does on the coverage
  gate; `hiddenVerdictOf` ignores both, as before.
- **Added modules.** The judged slice's `apply --stubs` now carries a
  module the change adds past the cut's reach, so "partial apply" means a
  changed file outside the slice, not an added one.
- **Analysis.** `bench/analyze.mjs` reports the unsafe count with its
  one-sided 95% upper bound and the verdict-coverage share beside Phase 2's
  agreement.

## Replaying benchmark changes for verdict parity

For new benchmark runs, set `BENCH_TAG` and `BENCH_RESULTS` to isolate the
templates, judging clone, session artifacts and results from earlier runs.
The model session must succeed before a verdict is recorded. For a slice,
the judge tests the agent's folder, then applies the submitted change and
hidden tests together to a fresh template. An incomplete apply is reported
as an unavailable in-slice verdict, not as a pass or failure. Analysis
reports the number of unavailable verdicts; they prevent establishing the
parity bar.

The separate Codex pilot is specified in [PLAN-codex.md](PLAN-codex.md).
Run `node bench/codex-probe.mjs` first: it checks `npm test`, a denied
sibling read and a denied network connection in a real Codex session. Use
`--backend codex --model gpt-6.1-sol --concurrency 1` with a distinct
`BENCH_TAG` and `BENCH_RESULTS`. The Codex profile denies the other
workdirs present when its session starts; do not run another benchmark
concurrently. CLI subscription sessions do not report cost in dollars,
and the event stream does not give a comparable model-turn count. Those
metrics are unavailable rather than zero. Codex transcripts have not been
processed by the Claude-specific peek detector and must be reviewed.

`bench/parity.mjs` replays saved E6 changes into newly cut slices without
calling a model. It compares each slice verdict with its recorded repository
verdict. It can also replay full-repository changes and scoped commit changes.
Use `--from slice`, `--from full`, or `--from commit`, and `--arms` to select
the slice arms. The script resumes by CLI build and replay version.

```sh
node bench/parity.mjs --from slice --arms slice-seam,slice-diff
node bench/parity.mjs --report
```

Run these from `experiments/`. Set `BENCH_TAG`, `PARITY_RESULTS`, and
`PARITY_REPO_RESULTS` to separate concurrent runs; tags isolate clones,
templates, and derived patches. A missing patch, unavailable template, or
change that `apply` leaves partly outside the slice is excluded and reported,
not counted as a verdict. A template must pass `check` and its tests after
the recorded mock baseline is applied. Replay version 2 removes the old install-marker
artifact and scopes commit patches to the case's allowed code and package
tests; unversioned replay rows cannot establish parity.
