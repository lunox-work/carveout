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
