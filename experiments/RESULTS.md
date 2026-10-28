# Results

The procedures are fixed in [README.md](README.md), and the raw data is in
`results/`. All runs used the CLI `ddb11b3+dirty`: the commit before these
changes, plus the uncommitted `src/` each result names by its `dist` hash.
The repositories were read at the heads in `slices.json`, and E4's at the
commits in `results/e4*.json`.

| Experiment           | Verdict                                                                                       | Shipped                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| E1 `status`          | **pass**: 0 false `current` in 345 commits                                                    | `carveout status`                                                                                   |
| E2 three-way patches | **pass**: +61.8 points (bar: 25)                                                              | `--full-index` blob ids, the `--3way` hint, the no-blob report                                      |
| E3 co-change hints   | **fail**: precision 0.27 when tuned; one held-out repository unmeasurable                     | nothing; the function moved to `experiments/cochange.mjs`                                           |
| E4 graph cache       | step 2 **not built**: a parse cache is bounded at 1.03×, and at 2.59× after the fix (bar: 3×) | a per-run fix for a resolution defect step 1 found: n8n from 437 s to 11.7 s, with identical graphs |

## E1: `carveout status`

There were 345 later commits over 12 slices. m1's files were created three
commits before HEAD, so it has none.

|                  | Fresh cut identical | Fresh cut differs |
| ---------------- | ------------------- | ----------------- |
| status `current` | 23                  | **0**             |
| status stale     | 0                   | 322               |

- **Verdict.** The pass needs no false `current`, and there were none. Status
  was also never stale when the fresh cut was identical.
- **Current share.** 6.7% of commits were marked current. The commits were
  chosen because they touch a recorded path, and they mostly changed the
  slice: of the 322 stale commits, only 23 changed nothing but generated
  files (`package.json` pins, and `BOUNDARY.md` and the contract's lists).
- **Cost.** Status takes as long as a cut, with medians of 0.6–2.6 s against
  0.6–2.3 s. It makes the cut again in memory, which is what extracting
  "each stub again from current source" (plan, step 2) requires. So what
  it saves is a re-cut and a merge, not time.
- **Plan deviations.**
  - _Commit identity._ The commit was taken out of the folder's `README.md`,
    `BOUNDARY.md` and `carveout/contract.json` before E1 ran, and is now only
    in `carveout.json`. Otherwise every later commit would change those
    three files, and the ground truth would be "stale" at every commit.
  - _New importers._ The plan has them as information only. Here they make
    the folder stale, because they change `BOUNDARY.md` and the contract, so
    a fresh cut differs. Treating them as information would have produced
    false `current`s. Status still lists them separately.

## E2: patches after the repository moves

There were 55 cases over 10 slices; m1, m6 and m8 had no commits that
changed their edited files.

|                                  | Cases | Share |
| -------------------------------- | ----- | ----- |
| plain `git apply --check`        | 15    | 27.3% |
| `git apply --3way`, clean        | 49    | 89.1% |
| three-way, clean, and typechecks | 49    | 89.1% |

- **Verdict.** Three-way and typecheck came in 61.8 points above plain,
  against a bar of 25.
- **No regressions.** No case applied plain and then failed three-way.
- **Failures.** Of the 6 cases that failed both ways, 5 were real conflicts:
  upstream had changed the lines around the inserted statement. In the
  sixth (m5), the edited file had been deleted.
- **Typecheck limits.** Every clean three-way merge typechecked against its
  commit with no added errors. The edit was a benign inserted statement, so
  the typecheck catches a garbled merge, not a wrong one.
- **Environment.** `node_modules` was borrowed from the live checkout, and
  baseline errors from that environment were the same with and without the
  patch.
- **Still waiting on you.** `patch --apply --verify <cmd>` would act on the
  user's checkout, so per the plan it waits on your decision.

## E3: co-change hints

- **Split.** T falls at 70% of each history: sandbox-factory on 2026-10-03
  (185 commits), private-api on 2026-10-23 (23), private-site on
  2026-10-20 (58).
- **Tuning on sandbox-factory.** All 18 settings gave the same 15 hints,
  precision 0.27 and recall 0.009. There are fewer than 100 fitting
  commits before T, so N, k and x never separate. The chosen setting was
  N 100, k 2, x 0.2.
- **private-api.** Precision 1.00, recall 0.08, 5 hints. All 5 came from one
  slice, the web app's `src`, which had 5 scoring commits.
- **private-site.** No commit after T touches either slice, so it has no
  precision. Its 5 hints (`AGENTS.md`, `README.md`, `package.json` and
  others) also read as noise.
- **Verdict.** Fail on both counts: no precision on private-site, and the
  tuning repository itself is below 0.3. The feature is dropped. These
  repositories are too young to say whether co-change hints work at all.
  Measuring that would need repositories with long histories.

## E4: graph time

Step 1 ran at `dist:9e7b8e87d04c`, as the median of 3 runs in fresh
processes:

| Repository      | Script files | Total     | Listing | Parsing | Resolving |
| --------------- | ------------ | --------- | ------- | ------- | --------- |
| cal.com         | 5,073        | 16.2 s    | 0.2 s   | 2.2 s   | 13.8 s    |
| n8n             | 23,979       | **455 s** | 0.4 s   | 12.5 s  | 442 s     |
| DefinitelyTyped | 33,319       | 17.1 s    | 0.5 s   | 10.8 s  | 5.8 s     |

- **Repositories.** No public repository with about 45k script files under
  the 50k cap turned up among ten counted. DefinitelyTyped, at 33k, stands
  in.
- **Step 2.** The gate (over 10 s at 20k files) is crossed. But step 2, as
  planned, caches only parses and leaves resolution as it is. Parsing is
  12.5 s of n8n's 455 s, so a perfect parse cache gives at most
  455 / 442.7 = 1.03×, against a 3× pass. It was not built.
- **The defect.** Profiling showed what step 1 had measured. `loadConfig`
  rebuilt its view of the workspace packages on every call: it globbed the
  workspace folders and read every package's `package.json`. The graph
  called it once per directory, 1,508 times on cal.com and 5,474 on n8n.
- **The fix.** One workspace scan per graph build, each tsconfig loaded
  once, and the compiler's module-resolution cache with file checks
  memoized. All of it lives within one run, so nothing outlives the tree it
  read. This is not the plan's step 2, which keeps derived data across
  runs.
- **Same graphs.** The graphs are byte-identical before and after on all
  six repositories. Total graph time before and after:

  | Repository      | Before | After  |
  | --------------- | ------ | ------ |
  | sandbox-factory | 1.0 s  | 0.5 s  |
  | cal.com         | 13.1 s | 2.0 s  |
  | DefinitelyTyped | 16.7 s | 14.0 s |
  | n8n             | 437 s  | 11.7 s |

  The private repositories gave identical graphs too; the check is
  `e4-same.mjs`, and its output is in `results/e4-same.txt`.

Step 1 rerun on the fixed build (`results/e4-after-fix.json`, median of 3):

| Repository      | Script files | Total  | Listing | Parsing | Resolving |
| --------------- | ------------ | ------ | ------- | ------- | --------- |
| cal.com         | 5,073        | 2.1 s  | 0.1 s   | 1.5 s   | 0.6 s     |
| n8n             | 23,979       | 11.8 s | 0.3 s   | 9.0 s   | 2.5 s     |
| DefinitelyTyped | 33,319       | 13.7 s | 0.5 s   | 10.3 s  | 2.9 s     |

- **The gate again.** n8n is still over 10 s, so step 2 was weighed against
  the fixed build.
- **Step 2's ceiling.** A warm run as planned must still do three things:
  - list the files (0.33 s);
  - read and hash every file for its blob id, measured at 1.77 s for n8n's
    151 MB;
  - resolve every import, which the plan keeps uncached (2.46 s).

  That's at least 4.56 s against a cold 11.79 s, a ceiling of 2.59× before
  any cache is read. The bar is 3×, so step 2 fails as specified, and it
  was not built.

- **The faster alternative, not taken.** Taking clean files' blob ids from
  Git's index would avoid the reads. The plan rules that out on purpose:
  ids taken from bytes are what keep uncommitted edits from being served
  stale.
