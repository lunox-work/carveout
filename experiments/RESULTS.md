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

## E5: replaying real commits

The procedure is in [README.md](README.md#e5-replaying-real-commits), and
the bars are in [PLAN-benchmark.md](PLAN-benchmark.md). The runs used CLI
`e407a46` on the eleven commits of `e5-cases.json`, and the raw data is in
`results/e5.jsonl` (newest line per case and mode).

**Usable cases.** The oracle, B plus the commit's whole package change,
passes the package's tests on 8 of 11. The other three fail even then:

- limit-jobs and recent-reads (`4d1491e`) need changes the commit made in
  other packages;
- setup-stage has 7 web tests that fail.

These three are not usable for the benchmark. Their rows are reported, but
they say nothing about carveout.

| Bar                                                         | Result                                      | Verdict  |
| ----------------------------------------------------------- | ------------------------------------------- | -------- |
| Round trip byte-identical in at least 90% of in-slice diffs | 20 of 22; 16 of 16 on the usable cases      | **pass** |
| Every round-tripped patch applies at B                      | 22 of 22                                    | **pass** |
| In-slice and post-merge verdicts agree in at least 95%      | 15 of 16 usable (94%)                       | **fail** |
| No slice-passes, repository-fails case caused by carveout   | 0; the one disagreement is coverage (below) | **pass** |

- **The disagreement.** In step-holds/seam the slice passes and the
  repository fails. The commit changes two code files outside the seam's
  slice (`analysis.ts`, `sizing.ts`), and `apply` named both as outside. In
  diff mode, which holds them, both verdicts pass. This is the slice being
  too small for the change, not mechanics. By the bar as written, E5 fails
  at 94%.
- **The two round-trip misses.** Both are setup-stage (unusable),
  `RepoXray.tsx`, a file the commit adds. One import comes back as
  `../../components/StackIcon` where the commit wrote
  `@/components/StackIcon`. Both resolve to the same file: for a new file,
  the spelling is a guess.
- **Defects E5 found and fixed** (commits `b7cea4e`, `393942d`, `e407a46`):
  - A brought-along test with a computed import blocked the whole folder's
    build.
  - `npm test` ignored tests written after the cut.
  - Slices had no `@types/node`, so `assert.ok` narrowed nothing and four
    usable cases did not build.
  - Two specifiers rewritten to one target came back wrong, and an
    unchanged file was patched.
  - New imports of stubs that `apply --stubs` wrote kept their slice
    spelling.
  - `apply` wrote existing tests as new files, and the merge conflicted.
  - A deleted entry point broke `carveout/run.ts`.
- **Known limits, not fixed.**
  - Web slices type-check under `NodeNext`, where a CommonJS default
    import such as `@testing-library/user-event` loses its members
    (setup-stage).
  - A mock package's types can lack a member the change uses
    (`@aws-sdk/client-ecs` `RunTaskCommand`, recent-reads/diff).
  - A type inferred from an untyped package becomes `unknown` (hono's
    `file`).
- **In-slice baselines.** Tests that fail at the slice's baseline fail on
  the mocks: 3 in identicon (shared's handle schema, whose validator is in
  core) and none in most others. They are counted, not judged.

### E5 on the grown corpus (2026-11-04)

Phase 6 grew the corpus (below) and replayed every case on the fixed CLI,
`2592b02` plus the three fixes E5 found this round (dist `ad8b99c8bd40`,
uncommitted at the time of the run). 26 cases: the 11 above and 15 new ones
from `duediligence/evidence/in-repo-e6b/`.

**Usable cases.** The oracle passes on 21 of 26. Besides the three above,
build-commit and sliced-fixtures fail even with the commit's whole package
change: both need changes the commit made in other packages.

| Bar                                                         | Result                                 | Verdict  |
| ----------------------------------------------------------- | -------------------------------------- | -------- |
| Round trip byte-identical in at least 90% of in-slice diffs | 50 of 52; 42 of 42 on the usable cases | **pass** |
| Every round-tripped patch applies at B                      | 52 of 52                               | **pass** |
| In-slice and post-merge verdicts agree in at least 95%      | 28 of 42 usable rows (67%)             | **fail** |
| No slice-passes, repository-fails case caused by carveout   | 0; the two are coverage (below)        | **pass** |

- **Slice passes, repository fails (2).** step-holds/seam as before, and
  second-atlassian/diff: the commit adds `src/jira/state.ts`, which the
  diff-mode cut (changed files, not added ones) has no folder for, so
  `apply` named it outside and the merge lacked it. Coverage, not mechanics.
- **Slice fails, repository passes (12 rows, 6 cases).** All new, and all
  one shape: the package's tests are integration tests on a mocked service.
  jira-pages, jira-boards, jira-connections, oauth-membership and
  generate-id are `packages/db` or `apps/api` cases whose tests run
  against `postgres`; in the slice that is a recording mock, so the
  commit's own new tests fail there (jira-boards: 13 of 13 added tests),
  while the repository runs them on a database. generate-id fails the
  slice's coverage gate as well. touched-repos (`apps/worker`) does not
  build: the folder relaxes `noImplicitAny` for a callback passed to the
  untyped `typescript-compiler` package, and under `strictNullChecks` without it
  TypeScript types a bare `[]` as `never[]`, which one brought-along test
  pushes into. A known limit now, not fixed: the relax trades one error
  class for another.
- **Defects E5 found and fixed this round** (all three made whole package
  families uncuttable; none showed on the 11 cases of E6a):
  - A doc comment containing the word "import" ran the import regex on to
    the first real import below it, which was then neither rewritten by
    `cut` nor restored by `patch`: every `apps/api` slice failed to
    resolve `sandbox-factory`.
  - `drizzle-orm` was mocked as a service SDK; its schema builders carry
    the types `packages/db` modules need, so no db slice built. It is
    installed now; the driver (`postgres`) stays mocked.
  - The fixture fetched real types for packages the folder would mock, so
    the implicit-any probe passed on types the folder never has, and the
    folder's build failed on `TS7006`. Service packages are untyped in the
    fixture now, as in the folder.
- **Reading.** On the E6a corpus the agreement bar missed by one row; on
  the grown corpus it fails outright, and the cause is not round-trip
  mechanics (42 of 42) but what a slice can run: a package whose tests
  need a live service has no in-slice verdict. E6b judges every arm in the
  repository, so this does not bias the arms against each other, but it
  says the slice arms' agents work without a passing test run in these
  cases.

## E6a: a slice against the whole repository

The bars are in [PLAN-benchmark.md](PLAN-benchmark.md), Phase 5, and the
arithmetic is in `bench/analyze.mjs`. Both were committed before the run.

- **Runs.** Haiku 5.5 on CLI `e407a46` with the harness at `032fed9`. The
  data is in `results/bench.jsonl`.
- **Usable cases.** 8 of 11. A template of every arm must build at B, and
  three did not (`results/bench-unusable.jsonl`):
  - limit-jobs and recent-reads: the slice of the commit's files;
  - setup-stage: the seam slice, a web test under `NodeNext`, as in E5.
- **The brief and the judge.** Each case's developer-confirmed spec
  briefed the agent, and its calibrated hidden suite judged it.

### Haiku, 8 cases × 5 runs

| arm          | accepted | other verdicts           |
| ------------ | -------: | ------------------------ |
| `full`       |  35 / 40 | refused 5                |
| `slice-seam` |  36 / 40 | rejected 3, functional 1 |
| `slice-diff` |  34 / 40 | rejected 5, functional 1 |

| Bar                                                  | Result                             | Verdict         |
| ---------------------------------------------------- | ---------------------------------- | --------------- |
| Non-inferiority, one-sided 95% lower bound above -10 | +2.5 points, bound -9.7            | pass, see below |
| Slice passed, repository failed, at most 5%          | 4 of 40 (10%)                      | **fail**        |
| Total input at least 30% lower (median of cases)     | 14.7% lower; lower in 6 of 8 cases | **fail**        |
| Cost per accepted run at least 30% lower             | 14.5% higher; lower in 3 of 7      | **fail**        |

**Every exception, classified by hand:**

- **The 5 refusals are a harness artifact.** All 5 are ticket-content's
  `full` runs. `turbo` writes a managed block into `AGENTS.md` when it
  detects an agent, and the agent had run `npx turbo`. The scope rule
  refused that block. All 5 passed every other check.
  - Counted as accepted, `full` is 40 of 40. The non-inferiority bound
    then falls to -20.5, and the bar **fails**.
  - The registered pass rests on the artifact, so it is not claimed. The
    harness now takes the block out before the diff (`01691fd`).
- **The 4 slice-passed, repository-failed runs are carveout defects,**
  fixed in `05f4f9f`:
  - **Three (categories)** left an unused `import type`. The repository
    compiles with `noUnusedLocals`, and the slice did not carry it. The
    two `slice-diff` rejections in categories are the same defect.
  - **One (jira-spec)** reached 89.8% branch coverage against the
    package's 90% gate, which the slice did not hold. One `slice-diff` run
    is the same.
- **In-slice false failures, the safe direction.** All 10 identicon slice
  runs failed one hidden test inside the slice and passed it after the
  merge. That test exercises shared's schemas, which delegate to a mocked
  core module.
- **Real failures.** jira-spec `slice-diff` runs 2 and 5 failed a hidden
  boundary test, and both verdicts agree.
- **One more option gap.** identicon `slice-diff` run 4 failed in the
  repository on an implicit `any` in its own test. The slice forces
  `noImplicitAny: false` so that untyped packages compile. Not fixed.

**Where the tokens go.** Agents explore with Bash (`cat`, `ls`,
`grep`) more than with the file tools. Over 40 runs each:

| arm          | Bash calls | Read, Grep, Glob |
| ------------ | ---------: | ---------------: |
| `full`       |        314 |               13 |
| `slice-seam` |        225 |               21 |

The confirmed spec names the files to create, so a `full` agent goes
straight to its package. The fixed costs then weigh most in both arms: the
system prompt, the spec and test output.

Per-case reduction in total input for `slice-seam`:

| case            | reduction |
| --------------- | --------: |
| categories      |       40% |
| identicon       |       28% |
| jira-spec       |       26% |
| analysis-params |       16% |
| context-sources |       14% |
| ticket-content  |        7% |
| step-holds      |      -15% |
| handles         |      -20% |

The slice saves most where a change spans several files with heavy test
output (categories), and costs more on one-file changes (handles,
step-holds). There it adds its own orientation: `BOUNDARY.md` and
`carveout/test.js`. A brief that names the files leaves little exploration
for a slice to save, so this corpus is a hard case for the efficiency
claim. A loose brief needs exploration, but E6's pilot found a loose brief
cannot be judged without a confirmed spec.

### Sonnet check, 8 cases × 3 runs

The same harness and CLI, Sonnet 5.5 on `full` and `slice-seam`.

| arm          | accepted | other verdicts        |
| ------------ | -------: | --------------------- |
| `full`       |  20 / 24 | refused 3, rejected 1 |
| `slice-seam` |  17 / 24 | functional 7          |

| Bar                                         | Result                             | Verdict  |
| ------------------------------------------- | ---------------------------------- | -------- |
| Non-inferiority, bound above -10            | -12.5 points, bound -31.5          | **fail** |
| Slice passed, repository failed, at most 5% | 7 of 24 (29%)                      | **fail** |
| Total input at least 30% lower              | 10.2% lower; lower in 6 of 8 cases | **fail** |
| Cost per accepted run at least 30% lower    | 10.9% lower; lower in 3 of 5       | **fail** |

- **The coverage gate.** All 7 `functional` slice runs passed the hidden
  suite and the importers' build, then missed the package's coverage gate
  in the repository: branches at 82–89% against 90%, in jira-spec,
  categories and handles. The slice did not hold that gate, which
  `05f4f9f` fixes. The `full` agents met it, because the package's own
  `npm test` enforces it.
- **The 3 refusals** are `turbo`'s block in `AGENTS.md` again
  (ticket-content), with every other check passing.
- **The one real failure** is a `full` run of categories, which failed a
  hidden boundary test.
- **Sonnet hit no `noUnusedLocals` failures,** where Haiku hit three.
- **What Sonnet saves.** Total input falls only 10%, but output falls 33%
  (lower in 7 of 8 cases), cost 18% (lower in all 8) and wall time 23%.
  identicon is the outlier: the slice used 2.1× the input, over the
  in-slice test it cannot pass on the mocks.

### What E6a says

- **Correctness.** As registered, it fails on both models. Every exception
  traced to one of three things:
  - two gaps where the slice was looser than the repository
    (`noUnusedLocals`, and the coverage gate), both fixed in `05f4f9f`;
  - one harness artifact (`turbo`), fixed in `01691fd`;
  - and the safe-direction mock limit (identicon).
- **Efficiency.** As registered, it fails: 10–15% less input, against a
  bar of 30%. On these spec-named, mostly one-package changes, the slice
  saves the tokens of exploration and test output, and adds its own
  orientation.
- **Next, E6b.** The same bars, a CLI with the fixes, and a corpus grown
  past 11 cases, with briefs that leave the agent something to find.

### Saved-change parity replay

On frozen CLI `81237de+dirty dist:6ab03afe4f0d`, replay version 2 tried
104 saved slice-agent changes without model calls. Results are in
`results/parity-v2.jsonl`. Of 68 comparable changes, 48 passed in both
places, five failed in both, and none passed in the slice while failing in
the repository. Fifteen failed in the slice while passing in the repository:
12 identicon replays hit a schema mock in the hidden suite, and three
context-sources replays failed the slice's per-added-file coverage threshold
while the repository's whole-package coverage passed.

The remaining 36 are not verdicts: four saved patches are missing, and
`apply` left part of 32 changes outside the slice (13 ticket-content, six
jira-spec, and 13 categories). These exclusions prevent a parity claim.
The replay also does not replace E6's acceptance and efficiency benchmark.

## E6b: the grown corpus

Registered as Phase 6 in [PLAN-benchmark.md](PLAN-benchmark.md) before any
data. The bars are Phase 5's, read with `bench/analyze.mjs --cases` on the
E6b corpus alone.

- **Runs.** Haiku 5.5 on CLI `2592b02+dirty dist:ad8b99c8bd40` (the sources
  of `f1b13dd`) with the harness at `01e4073`, 2026-11-04 05:27 to 09:44
  SGT, $6.35 over the three arms. The data is in `results/bench-e6b.jsonl`.
- **The corpus: 20 cases, not 30.** The rule yielded 41 candidates
  (`duediligence/evidence/in-repo-e6b/`). 16 built alone at B and regressed
  nothing; the other 25 import a member another package's change in the
  same commit adds. 15 calibrated (trim-hyphens dropped). 13 passed E5's
  oracle (build-commit and sliced-fixtures need the other packages'
  changes). 12 had a template of every arm: touched-repos's seam slice fails
  its baseline check, a `never[]` from the implicit-any relax
  (`results/bench-unusable.jsonl`). With E6a's 8, 20; the candidates ran
  out first.
- **The brief and the judge.** As E6a: the developer-confirmed spec briefs,
  the calibrated hidden suite judges. Twelve of the specs were confirmed by
  a simulated developer, with no person in the loop.

### Haiku, 20 cases × 3 runs

| arm          | accepted | other verdicts                      |
| ------------ | -------: | ----------------------------------- |
| `full`       |  45 / 60 | refused 9, rejected 5, functional 1 |
| `slice-seam` |  50 / 60 | rejected 7, functional 3            |
| `slice-diff` |  49 / 60 | rejected 8, functional 3            |

| Bar                                                  | `slice-seam`                                    | `slice-diff`                                    |
| ---------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Non-inferiority, one-sided 95% lower bound above -10 | +8.3 points, bound -3.9: pass, see below        | +6.7 points, bound -5.8: pass, see below        |
| Slice passed, repository failed, at most 5%          | 3 of 60 (5.0%): pass at the bar; 11 unavailable | 3 of 60 (5.0%): pass at the bar; 12 unavailable |
| Total input at least 30% lower (median of cases)     | 21.3% **higher**; lower in 9 of 20: **fail**    | 12.6% **higher**; lower in 8 of 20: **fail**    |
| Cost per accepted run at least 30% lower             | 22.2% **higher**; lower in 4 of 15: **fail**    | 16.3% **higher**; lower in 3 of 15: **fail**    |

**Every exception, classified by hand:**

- **The 9 refusals are a harness artifact, the mirror of E6a's.** All 9 are
  the `full` runs of step-holds, context-sources and workspace-stubs, whose
  base commits have `turbo`'s managed block committed in `AGENTS.md`. The
  strip `01691fd` added for E6a took it out anyway, and the diff showed a
  deletion the agent never made. All 9 passed every other check.
  - Counted as accepted, `full` is 54 of 60. The lower bound then falls to
    -17.1 for `slice-seam` and -19.0 for `slice-diff`, and the bar
    **fails** for both. The registered pass rests on the artifact and is
    not claimed.
  - The strip now leaves a block that is committed at B alone.
- **The 3 slice-passed, repository-failed runs are one carveout gap.** All
  three are workspace-stubs's `slice-seam` runs; its `slice-diff` runs fail
  the same way. The agent did what the commit did: bumped
  `SLICE_TOOL_VERSION` from `slice@3` to `slice@4` and wrote the new
  workspace stubs. In the repository, `slice.test.ts` pins the old version
  and `sandbox.test.ts` expects `declare module "zod";` where the agent
  wrote `declare module "zod*";`. Both tests import the package barrel, and
  `--with-tests` carried only the tests that import the entries directly,
  so the slice held neither and nothing told the agent. Fixed after the
  run in `0782d13` (Phase 7): a test that reaches a slice module through a
  barrel is carried, and the barrel with it.
- **23 in-slice verdicts are unavailable: a judge limit, new since
  `2592b02`.** The parity judge applies the change and the hidden suite to
  a clean cut at B. A module the change adds that the entries do not reach
  falls outside that cut: ticket-content's `ticket.ts` and every test of it,
  categories's `selection/` files, jira-spec's `hash.test.ts`,
  second-atlassian's `state.ts`, jira-connections's test helper. E6a never
  ran this path. Fixed after the run in `0782d13`: `apply` takes the
  modules a change adds past the cut's reach as entries of their own.
- **jira-connections fails in every arm, 0 of 9.** Eight hidden cipher
  tests pin the default key id, a 12-hex fingerprint of the key. The spec
  gives the values for two keys but not the derivation, so no agent can
  reach them. A spec-suite defect; it says nothing about slicing.
- **generate-id is a second carveout gap.** `full` 2 of 3, the slices 0 of
  6, all `functional`: after the merge, packages/db's `assert-all-covered`
  reports three schema files no test loads. The slice carries the coverage
  thresholds (`coverageGateOf` reads `--test-coverage-*`) but not this
  guard, so a slice agent never sees it; a `full` agent did, twice. Fixed
  after the run in `0782d13`: `npm test` in a slice holds the guard over
  the files the change adds.
- **In-slice false failures, the safe direction.** identicon, github-app,
  jira-contract, image-digest, aws-deploy and oauth-membership each fail
  one or more hidden tests inside the slice and pass them after the merge.
  Every one exercises a module or service the slice mocks.
- **Real failures.** jira-spec `full` runs 1 and 3 and `slice-diff` runs 1
  and 2 failed the same hidden boundary test as in E6a (deeply nested
  blockquotes). oauth-membership `slice-seam` run 2 failed in both places:
  a baseline regression inside the slice, a hidden test after the merge.
  workspace-stubs's `full` runs would have been accepted.

**E6a's 8 cases on the new CLI.** `full` 16 of 24 (6 refusals, the artifact
above; 2 rejected), `slice-seam` 24 of 24, `slice-diff` 22 of 24, and no
slice-passed, repository-failed run: the `05f4f9f` fixes hold.

**Where the tokens go.** The slice costs more on the grown corpus, and
the pattern is in the slice's baseline: the api and db packages' tests run
against a mocked driver or service and fail before the agent touches
anything. Per case, `slice-seam` against `full`, medians over 3 runs:

| case             | tests failing at the slice's baseline | total input | turns `full` → `slice-seam` |
| ---------------- | ------------------------------------: | ----------: | --------------------------: |
| oauth-membership |                                    50 |        -96% |                     22 → 28 |
| github-app       |                                    22 |        -83% |                     11 → 16 |
| jira-boards      |                                   103 |        -77% |                     15 → 24 |
| jira-contract    |                                     5 |        -72% |                     11 → 12 |
| jira-pages       |                                    37 |        -64% |                     14 → 14 |
| second-atlassian |                                    58 |        -53% |                     16 → 18 |
| jira-spec        |                                     – |        -34% |                     17 → 21 |
| context-sources  |                                     0 |        -33% |                     20 → 20 |
| analysis-params  |                                     0 |        -29% |                     10 → 11 |
| image-digest     |                                    35 |        -28% |               1 → 1, see E7 |
| aws-deploy       |                                    27 |        -15% |                     14 → 15 |
| categories       |                                     – |          0% |                     19 → 18 |
| jira-connections |                                     – |          0% |                     36 → 29 |
| workspace-stubs  |                                     5 |         +5% |                     46 → 43 |
| handles          |                                     0 |        +13% |                      10 → 8 |
| identicon        |                                     3 |        +14% |                      12 → 9 |
| generate-id      |                                    89 |        +15% |                     23 → 17 |
| step-holds       |                                     0 |        +17% |                       8 → 7 |
| provenance-doc   |                                     0 |        +21% |                       8 → 7 |
| ticket-content   |                                     – |        +29% |                       9 → 7 |

Tool results are larger in the slice in 20 of 20 cases (median 39%
larger). Two reasons, read from the transcripts: `npm test` in the slice
prints the baseline failures every time, and agents read the slice's own
orientation, `BOUNDARY.md`, `carveout/test.js` and `carveout/baseline.json`,
before the code. The E6a reading stands for the one-file cases: a brief
that names the files leaves little exploration to save, and the slice's
fixed cost shows.

### What E6b says

- **Acceptance.** Parity on the registered count rests on the refusal
  artifact; on the corrected count `full` leads by 7 points over 60 runs
  each, and the bar fails. Three runs per cell on 20 cases cannot separate
  a 7-point gap from noise either way.
- **Efficiency.** Both bars fail, more clearly than in E6a. On packages
  whose tests need a live service, the mock turns the slice's test suite red
  at baseline, and the agent pays for that in turns and tool output. The
  slice saves tokens only on small, pure packages.
- **Mechanics.** Two carveout gaps found: tests that reach a changed
  module through the package barrel were not carried, and a repository's
  never-loaded-file guard was not. One judge gap: a clean cut did not
  reach modules the change adds. All three fixed in `0782d13`, Phase 7,
  after the run. One spec-suite defect (jira-connections) stands; the
  harness artifact (the strip) is fixed.

## E7: a planned slice

Registered with E6b in Phase 6. `slice-plan` is two sessions: a planning
session in a copy of the repository at B names the slice's entries from
the spec (`bench/prompts/plan.md`); the harness cuts them with the slice
arms' flags, checks the cut and installs it; a second session works in it
under the slice brief. Every measurement sums the two. The arm is held to
the four Phase 5 bars against E6b's `full` rows.

- **Runs.** Haiku 5.5 on the same CLI dist as E6b (`ad8b99c8bd40`, now
  under `01e4073`), 2026-11-04 09:46 to 11:37 SGT, $2.75 with the planning
  sessions. The rows are in `results/bench-e6b.jsonl` under `slice-plan`.

### Haiku, 20 cases × 3 runs

| arm          | accepted | other verdicts                          |
| ------------ | -------: | --------------------------------------- |
| `slice-plan` |  52 / 60 | rejected 7, functional 1, plan_failed 0 |
| `slice-seam` |  50 / 60 | rejected 7, functional 3                |
| `full`       |  45 / 60 | refused 9, rejected 5, functional 1     |

| Bar                                                  | Result                                                                                      | Verdict                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| Non-inferiority, one-sided 95% lower bound above -10 | +11.7 points, bound -0.2; against the corrected `full` (54 of 60): -3.3 points, bound -13.3 | pass as registered, **fail** corrected |
| Slice passed, repository failed, at most 5%          | 0 of 46 with a verdict; 14 unavailable                                                      | pass                                   |
| Total input at least 30% lower (median of cases)     | 35.7% **higher**; lower in 1 of 20                                                          | **fail**                               |
| Cost per accepted run at least 30% lower             | 51.9% **higher**; lower in 1 of 15                                                          | **fail**                               |

**The planner.** Every run named entries that exist at B and cut to a
slice that passed its baseline check: `plan_failed` is 0 of 60. A planning
session costs a median 107k input tokens, 5 turns, 21 seconds and $0.005,
17% of the run's input at the median. It named the mechanical seam exactly
in 5 of 60 runs; it usually names the files the spec says to change and
their tests. That is why it beats `slice-seam` where the seam was blind:

- **workspace-stubs, 3 of 3 where `slice-seam` had 0 of 3.** All three
  plans named the four source files and the tests `slice.test.ts` and
  `sandbox.test.ts`, which import the package barrel and which the seam cut
  did not carry. The agent then saw the version pin and the stub format
  the repository expects.
- **The plan varies.** ticket-content run 2 named `handle.ts` and its test,
  a 2-file slice, and passed; runs 1 and 3 named the barrel, 40 files.
  context-sources ran in 8 files once and 62 files twice.

**Every exception, classified by hand:**

- **jira-connections 0 of 3 and generate-id 0 of 3** fail as every arm
  does: the spec-suite defect and the never-loaded-file guard of E6b. Two
  generate-id runs also fail hidden tests on the root's `ID_PREFIXES`.
- **oauth-membership run 2** failed a hidden test after the merge, as the
  `slice-seam` run 2 did; **second-atlassian run 1** failed two hidden
  boundary tests on the half-configured environment. Both real.
- **The 14 unavailable in-slice verdicts** are the judge limit of E6b: a
  module the change adds past the entries' reach falls outside the clean
  cut (ticket-content, categories, context-sources, jira-boards,
  second-atlassian, jira-connections, jira-spec).

**Where the tokens go.** Per case, medians over 3 runs, total input:

| case             |    `full` | `slice-plan` | of which planning | reduction |
| ---------------- | --------: | -----------: | ----------------: | --------: |
| categories       | 1,124,930 |      887,122 |           156,834 |      +21% |
| analysis-params  |   281,529 |      284,950 |            80,030 |       -1% |
| jira-spec        | 1,088,918 |    1,134,937 |            99,935 |       -4% |
| generate-id      |   699,476 |      761,690 |           108,501 |       -9% |
| workspace-stubs  | 2,688,799 |    3,225,940 |           167,977 |      -20% |
| provenance-doc   |   165,447 |      199,789 |            55,388 |      -21% |
| jira-connections | 2,226,296 |    2,720,215 |           163,778 |      -22% |
| identicon        |   241,440 |      305,730 |            71,419 |      -27% |
| jira-boards      |   741,454 |      982,710 |           123,919 |      -33% |
| handles          |   242,291 |      324,756 |            76,415 |      -34% |
| ticket-content   |   272,342 |      374,185 |           106,503 |      -37% |
| context-sources  |   591,576 |      848,262 |           145,858 |      -43% |
| second-atlassian |   543,894 |      849,250 |           101,324 |      -56% |
| step-holds       |   186,163 |      311,647 |            70,677 |      -67% |
| aws-deploy       |   376,863 |      636,312 |           107,117 |      -69% |
| github-app       |   456,133 |      798,158 |           109,257 |      -75% |
| jira-pages       |   273,316 |      491,629 |           101,720 |      -80% |
| jira-contract    |   285,783 |      609,829 |           124,572 |     -113% |
| oauth-membership |   634,471 |    1,407,136 |            83,058 |     -122% |
| image-digest     |    56,640 |      876,458 |           111,622 | see below |

The work session alone, planning taken out, costs more than `full` in 15
of 20 cases: the planned slices are the seam slices' size and share their
red baseline on the service-backed packages. The planning session then
adds a fixed 55k to 168k on top.

**image-digest's accounting is a harness artifact, in every arm.** Its
agents ran `npm test` in the background, and a session the agent re-enters
writes one result line per entry. The harness read the last line only, so
the 9 E6b rows and `slice-plan` run 3 record one turn and 56k to 79k input
tokens for sessions of 13 to 18 minutes. Summed over the result lines, the
medians are `full` 872,576, `slice-seam` 1,317,865 (-51%), `slice-diff`
1,128,142 (-29%) and `slice-plan` 1,114,535 (-28%). The rows stand as
recorded; `bench/lib.mjs` now sums the lines. Without image-digest the
medians of the per-case reduction are -21.3% for `slice-seam` and -34.0%
for `slice-plan`, unchanged in direction.

### What E7 says

- **A planner can choose a working cut every time**, at about 100k tokens
  and 20 seconds, and chooses at least as well as the mechanical seam: 52
  against 50 accepted, and 3 of 3 where the seam's test selection failed.
- **It does not make the slice cheap.** Two sessions cost more than one
  `full` session in 19 of 20 cases, and more than `slice-seam` in most.
  On the Phase 6 bars `slice-plan` fails both efficiency bars and, on the
  corrected `full` count, non-inferiority too.
- **The lever is the slice's baseline, not the cut.** Phase 7's `--live`
  keeps the service real, so the api and db slices start green; that is
  the next run's question for every slice arm.

## Exploratory Codex pilot

The separate procedure is in [PLAN-codex.md](PLAN-codex.md). This is not
the registered Claude E6. Four independent `gpt-6.1-sol` sessions ran
with Codex CLI `0.164.0-alpha.11.1`, high reasoning effort, and frozen
carveout `81237de+dirty dist:3084ea8f01c0`. Raw results are in
`results/bench-codex-pilot-v2.jsonl`.

| Case      | Arm        | Repository verdict | In-slice verdict | Total input tokens | Output tokens | Minutes |
| --------- | ---------- | ------------------ | ---------------- | -----------------: | ------------: | ------: |
| handles   | full       | accepted           | —                |            278,529 |         5,591 |    1.90 |
| handles   | slice-seam | accepted           | pass             |            185,835 |         4,985 |    1.89 |
| jira-spec | full       | accepted           | —                |            490,507 |        11,629 |    4.47 |
| jira-spec | slice-seam | accepted           | unavailable      |            885,904 |        15,243 |    6.60 |

The slice used 33.3% fewer input tokens on handles and 80.6% more on
jira-spec. One run per arm and two cases are too few for a reliability or
efficiency claim. Codex's subscription session reported no dollar cost or
comparable model-turn count; neither is estimated here.

The Jira in-slice verdict is unavailable: `apply` left the hidden
`hash.test.ts` outside because it contains computed dynamic imports. The
slice deliberately leaves such tests behind, so the hidden suite was
incomplete in the slice. All hidden tests ran in the repository judge.
Both agents' own `npm test` commands passed. There were no scope or
boundary violations; the four command traces were reviewed. The Codex
transcripts are not processed by the Claude-specific peek detector.

The first pilot attempt (`results/bench-codex-pilot.jsonl`) was stopped
after its sandbox prevented Node from resolving a parent directory. Its
two rows are invalid setup diagnostics. Before the repeated pilot, a live
probe confirmed that Node and `npm test` worked while a sibling-file read
and a direct-IP connection were blocked. The same network endpoint was
reachable from the host. The pilot remains exploratory: E5's registered
agreement bar, the expanded E6b corpus, and E7 remain open.

## Phase 7: the mergeback claim

Registered in [PLAN-benchmark.md](PLAN-benchmark.md), Phase 7, on
2026-11-04 before any data. The CLI holds the four fixes of `0782d13` and
the mock-version fix of `87d8e78`. Data in `results/parity-p7.jsonl`
(replays) and `results/parity-repo.jsonl` (commit verdicts, now with
`judgeMs`); `parity.mjs` records each slice judgment's time.

### Gate 1, first round: CLI `87d8e78 dist:4c39fe3ab24d`

The saved E6b and E6a slice-arm changes and each case's commit, replayed
into a clean cut at B and judged there, 228 replays (176 of saved
changes, 52 of commits). Postgres served `--live` for `packages/db`.

| Bar                                                | Result                                                       | Verdict  |
| -------------------------------------------------- | ------------------------------------------------------------ | -------- |
| Gate: zero unsafe rows among the comparable ones   | 2 of 163 (1.2%, one-sided 95% upper bound 3.9%)              | **fail** |
| Verdict coverage at least 90% of judged slice rows | 163 of 176 (92.6%)                                           | pass     |
| Phase 2's agreement, reported                      | 105 both pass, 50 both fail, 71 safe disagreements, 2 unsafe |          |

- **The 2 unsafe rows are a bench artifact, not a carveout gap.**
  categories, Sonnet `slice-seam` runs 1 and 2 of E6a: the rows' verdict
  is `functional` (the package's coverage gate at 82 to 89% branches),
  but the gate output recorded in the rows names tests that appear in
  neither run's transcript; run 2's are the tests of `full` Sonnet run 3.
  The two runs' `change.patch` and `transcript.jsonl` were written at
  06:31 SGT on 2026-10-29, 55 minutes after their rows: a later run under
  the same key overwrote them. Replayed in the slice, the saved change
  covers its added files at 96% and 97% branches and would pass the
  repository's gate too. Not comparable; `parity.mjs` now reports a
  saved change more than 15 minutes newer than its row as a stale
  artifact (`33dce74`).
- **A wrong fix, tried and reverted.** Read first as the gate holding
  only added files, `665e777` held every edited copied file to the
  threshold on its own. The second round on that CLI (`dist:e92caf1806db`)
  still had the 2 rows and turned 47 changes the repository accepted
  into slice failures on one edited file at 85 to 89% (jira-pages 6 of 6,
  identicon, github-app, jira-contract, image-digest), since the
  repository measures the whole package and the slice holds part of it.
  Reverted in `656e237`; the cut now records each copied file's hash as
  written, for a gate that could compare an edited file with its own
  baseline. The third round, on the reverted CLI, is below.

### Gate 1, third round: CLI `33dce74 dist:a9b3eedbe082`

The same 228 replays on the CLI with the gate over added files, the
copied-file hashes and the stale-artifact rule.

| Bar                                                | Result                                                       | Verdict  |
| -------------------------------------------------- | ------------------------------------------------------------ | -------- |
| Gate: zero unsafe rows among the comparable ones   | 0 of 159 (one-sided 95% upper bound 1.7%; bar: at most 2%)   | **pass** |
| Verdict coverage at least 90% of judged slice rows | 159 of 176 (90.3%)                                           | **pass** |
| Phase 2's agreement, reported                      | 103 both pass, 52 both fail, 73 safe disagreements, 0 unsafe |          |

- Against the first round, 4 rows changed and nothing else: the stale
  artifacts, categories and handles Sonnet `slice-seam` runs 1 and 2 of
  E6a, are reported as such and not judged.
- The 17 slice rows without a verdict: jira-spec's hidden test with a
  computed import (9, plus 2 with no saved patch), the 4 stale artifacts,
  one build failure each in identicon and categories. Coverage passes by
  one row; the judge limit on computed imports is the next thing to lift.
- Safe direction, 73 rows, as in the first round: 46 on a mocked module's
  hidden test, 16 commits reaching past the seam's cut, 7 failing the
  agent's own run, 2 without a template, 2 stale.
- **The gate holds.** No change that passed a slice on this CLI failed
  the repository, over 159 replays of 20 cases. The 2% bar is met at its
  only reachable value, zero, as Phase 7 said it would be.

### Gate 2, first round: E5 on CLI `33dce74 dist:a9b3eedbe082`

Every case of `e5-cases.json`, seam and diff, with `--live postgres` for
`packages/db`. The round trip failed in 35 of 52 rows and the in-slice
build in 44, where the previous CLI had 42 of 42 round trips.

- **One defect, in Phase 7's fourth fix.** `apply` cuts again with the
  modules a change adds past the cut's reach as entries, so a judge's
  clean cut reaches them. It took them from any package: E5 applies the
  whole commit, and a `packages/core` slice gained the commit's
  `apps/web`, `apps/api` and `packages/db` additions, which built against
  mocks they were never cut for (`organizations.ts`: implicit `any` on
  every row) and came back with their imports rewritten across packages.
  Every file that differed in the round trip was in another package; the
  same-package additions the fix was for (ticket-content's `ticket.ts`)
  came back byte-identical. Fixed: a module another package gains is
  outside again, as before `0782d13`. The bench never saw this because
  its changes stay inside one package.
- Both gates run again on the fixed CLI, below.

### Both gates on CLI `1009bdd dist:12be6e03d313`

The CLI E6c runs on. E5 on every case, both modes; then the parity
replay a fourth time.

| Bar                                                             | Result                                                               | Verdict  |
| --------------------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| E5: round trip byte-identical in at least 90% of in-slice diffs | 49 of 52; 42 of 42 on the usable cases                               | **pass** |
| E5: every round-tripped patch applies at B                      | 52 of 52                                                             | **pass** |
| E5: in-slice and post-merge verdicts agree in at least 95%      | 39 of 52; 31 of 42 usable (74%)                                      | **fail** |
| Unsafe direction at most 2% of rows with an in-slice verdict    | E5: 0 of 40 usable full applies; parity: 0 of 159 (upper bound 1.7%) | **pass** |
| Verdict coverage at least 90%                                   | parity: 159 of 176 (90.3%)                                           | **pass** |

- **Parity is row for row what the third round was**: 0 rows changed.
  The apply fix changes nothing for a change inside one package.
- **E5's agreement bar still fails, in the safe direction only.** The 11
  disagreements on usable cases: step-holds/seam (a partial apply, its
  two outside files, as before: not an in-slice verdict); jira-boards,
  jira-connections, jira-pages and generate-id in both modes, whose
  tests fail at the slice's baseline; oauth-membership (`apps/api`,
  through the mocked `db` package, as the rule foresaw); touched-repos
  (the `never[]` build, a known limit). The 3 round-trip misses are the
  unusable setup-stage and limit-jobs.
- **`--live postgres` did not turn the db slices green, and the reason
  is a new limit.** The driver is real and the tests reach the server
  (they create their scratch databases), then fail on
  `Can't find meta/_journal.json`: `packages/db`'s migrations live in
  `packages/db/drizzle/`, named to drizzle's `migrate` by the bare
  string default `"drizzle"`, which the walk cannot see. The slice has
  no migrations folder, so 89 to 103 tests fail at baseline exactly as
  they did on the mock. A folder a package reads by a configured name
  needs an explicit `--copy <dir>` or the like; not in this round. The
  db cases carry a red baseline into E6c, in the safe direction.
- **The 13 rows without an in-slice verdict**: jira-spec's hidden
  `hash.test.ts` has a computed dynamic import, which `apply` leaves
  outside by rule (9 rows, 2 more with no saved patch); one build failure
  each in identicon and categories. A judge limit, as in the Codex pilot;
  the coverage bar passes without it.
- **Safe direction, 71 rows, no bar.** 46 fail a hidden test that
  exercises a module the slice mocks (identicon 14, github-app 8,
  image-digest 8, aws-deploy 7, jira-contract 6, oauth-membership 3); 16
  are commits whose change reaches outside the seam's cut (step-holds,
  jira-pages, aws-deploy, the db cases' `fake-db.ts`); 7 fail the agent's
  own test run in the slice; 2 have no template.
- **Templates.** limit-jobs, setup-stage and touched-repos have none, as
  before: the `never[]` from the implicit-any relax and the `NodeNext`
  web test.

### E6c: the E6b corpus on the gated CLI

Phase 7's third step: E6b's 20 cases × `full`, `slice-seam` and
`slice-diff` × 3 runs on Haiku 5.5, on the CLI that passed both gates;
Phase 5's bars plus the two mergeback bars, read with `bench/analyze.mjs`
on `results/bench-e6c.jsonl`.

- **Runs.** CLI `1009bdd dist:12be6e03d313`, the harness of `87cbcff`,
  2026-11-04 15:30 to 19:50 SGT, $6.95 over the three arms (`full` $1.90,
  `slice-seam` $2.63, `slice-diff` $2.43). The `full` templates are
  E6b's (`BENCH_FULL_TEMPLATES`); the slice templates were cut fresh.

| arm          | accepted | other verdicts            |
| ------------ | -------: | ------------------------- |
| `full`       |  52 / 60 | rejected 5, functional 3  |
| `slice-seam` |  46 / 60 | rejected 11, functional 3 |
| `slice-diff` |  49 / 60 | rejected 8, functional 3  |

| Bar                                                          | `slice-seam`                                   | `slice-diff`                                   |
| ------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| Non-inferiority, one-sided 95% lower bound above -10         | -10.0 points, bound -21.5: **fail**            | -5.0 points, bound -16.1: **fail**             |
| Slice passed, repository failed, at most 5%                  | 3 of 60 (5.0%): pass at the bar; 4 unavailable | 3 of 60 (5.0%): pass at the bar; 4 unavailable |
| Total input at least 30% lower (median of cases)             | 23.9% **higher**; lower in 3 of 20: **fail**   | 16.8% **higher**; lower in 6 of 20: **fail**   |
| Cost per accepted run at least 30% lower                     | 24.0% **higher**; lower in 2 of 17: **fail**   | 14.2% **higher**; lower in 2 of 17: **fail**   |
| Unsafe direction at most 2% of rows with an in-slice verdict | 3 of 56 (5.4%, upper bound 12.7%): **fail**    | 3 of 56 (5.4%, upper bound 12.7%): **fail**    |
| Verdict coverage at least 90%                                | 56 of 60 (93.3%): pass                         | 56 of 60 (93.3%): pass                         |

**Every exception, classified by hand:**

- **The refusals are gone.** 0 of 60 `full` runs refused (E6b: 9); the
  `AGENTS.md` strip holds. `full` is 52 of 60, seven above E6b, and that
  alone turns E6b's non-inferiority pass, which rested on the artifact,
  into the fail above.
- **The unsafe rows are one case and one rule.** workspace-stubs: `full`
  3 of 3, both slice arms 0 of 3, every slice run passing in the slice
  and failing two hidden tests after the merge. The change is E6b's:
  the agent wrote `declare module "zod*";` where the hidden
  `sandbox.test.ts` expects the wildcard and the bare form both. E6b
  blamed the barrel rule, and `0782d13` carried tests that reach the
  slice through a barrel: `slice.test.ts` came along, `sandbox.test.ts`
  did not. A second rule left it behind: the test has a computed import
  (`await import(pathToFileURL(file).href)`, a file it writes itself),
  and the walk read any non-external dependency as a path no slice can
  carry, then reported the test as running on neither runner. The parity
  gate cannot see this: a replayed commit satisfies the test it does not
  carry, and only a wrong change finds it. Fixed after the run in
  `18bdebd`: a computed import no longer leaves a test behind, narrowed
  in `2c5864b` to a test whose every other reach the slice holds (the
  first form carried `build-info-resolver.test.ts`, whose `typeof import`
  names a root script no slice cuts, and three templates failed their
  baseline check at B). On that build the plan carries `sandbox.test.ts`
  (8 tests, 17 files); at the
  slice's baseline 18 of its 25 tests pass, among them the one that
  catches this change, so a slice agent sees it and the judge counts it.
  Not re-run; E8c runs on the fixed CLI.
- **jira-connections, 0 of 9**: the spec-suite defect from E6b (the key
  fingerprint no spec gives), every arm alike.
- **generate-id, 0 of 9, all `functional`**: the coverage guard the slice
  holds since `0782d13` fails the same way in every arm; E6b's `full`
  passed it twice. Agreement, no slice gap.
- **jira-boards, 4 runs** (`full` 1, `slice-seam` 2, `slice-diff` 1): the
  hidden store test does not compile against the agent's narrower type
  (`object | undefined`, given `null` and `unknown`). The slice's build
  fails the same way: agreement.
- **oauth-membership, `slice-seam` 1 of 3.** Run 2 is a real failure, a
  regression in the slice and a hidden test after the merge. Run 3 is a
  limit: the agent wrote a test helper, `jira-doubles.ts`, that imports
  the slice's `carveout/` harness; the patch left it out as slice-only
  and said so, and the new test it serves does not compile in the
  repository. No in-slice verdict (partial apply). `slice-diff` run 3: 48
  hidden tests fail in the slice and 4 after the merge, agreement.
- **Real failures**: second-atlassian `full` run 2 (3 boundary tests on
  environment config), provenance-doc `slice-seam` run 1 (62 hidden tests,
  in both places).
- **4 rows without an in-slice verdict per arm**: jira-spec's hidden
  `hash.test.ts` has a computed import that `apply` leaves outside (3 in
  each arm, as in the gates), plus the two partial applies above.
- **Safe direction, 16 (`slice-seam`) and 17 (`slice-diff`) rows**:
  identicon, github-app, jira-contract, image-digest, aws-deploy and
  oauth-membership fail a hidden test that exercises a module or service
  the slice mocks and pass it after the merge, as before.

**What E6c says.**

- The third corpus run gives the same answer on tokens: the slice reads
  more than the whole repository in 17 of 20 cases (`slice-seam`) and
  14 of 20 (`slice-diff`), medians 24% and 17% more input. Phase 5's
  efficiency bars have failed on every corpus and CLI tried.
- **The mergeback bar fails on model runs where the gate passed.** The
  gate replays commits, which pass every test, so a test the slice
  leaves behind costs nothing there; a model's wrong change is what
  finds it, 6 of 6 times in one case. The gate is necessary, not
  sufficient: the 2% claim needs model-written changes, and this run is
  the first measurement of it: 5.4% on 56 rows, one rule, now fixed.
- With the refusals gone the slice arms sit below `full` (-10 and -5
  points) and the bound fails. Without workspace-stubs: `full` 49 of 57,
  `slice-seam` 46 of 57, `slice-diff` 49 of 57.

## Phase 8: where else a slice pays

Registered in [PLAN-benchmark.md](PLAN-benchmark.md), Phase 8, on
2026-11-04 before any data. The no-model avenues read the E6b and E7
rows, transcripts and templates (CLI `ad8b99c8bd40`); their scripts are
`e8-exposure.mjs`, `e8-scope.mjs` and `e8-setup-time.mjs`, and their data
is in `results/e8-*.json*`.

### E8a: exposure

What the 60 `full` runs of E6b (Haiku 5.5) read, against what the case's
`slice-seam` template holds. A file counts as read when a `Read` call
named it or a `Bash` command fed it to `cat`, `head`, `sed`, `grep` and
the like; a path only listed or executed counts as named. Medians over 3
runs.

| case             | slice holds | files read | read outside the slice | bytes outside |
| ---------------- | ----------: | ---------: | ---------------------: | ------------: |
| workspace-stubs  |          10 |         24 |                     16 |       157,950 |
| second-atlassian |          13 |          7 |                      4 |        26,088 |
| jira-connections |          25 |         12 |                      5 |        25,006 |
| handles          |           2 |          5 |                      3 |        16,314 |
| ticket-content   |          40 |          7 |                      5 |        13,175 |
| jira-spec        |          10 |          7 |                      2 |        11,433 |
| oauth-membership |           7 |          6 |                      2 |         7,301 |
| jira-contract    |           4 |          4 |                      3 |         6,821 |
| jira-pages       |           9 |          5 |                      3 |         6,410 |
| identicon        |           6 |          6 |                      4 |         5,964 |
| step-holds       |           3 |          4 |                      2 |         2,847 |
| categories       |           5 |          3 |                      3 |         1,876 |
| analysis-params  |          22 |          4 |                      2 |         1,765 |
| generate-id      |          21 |          6 |                      2 |         1,734 |
| context-sources  |          62 |         11 |                      1 |         1,669 |
| image-digest     |           9 |          6 |                      2 |         1,486 |
| jira-boards      |          30 |          6 |                      1 |         1,339 |
| aws-deploy       |           4 |          3 |                      1 |         1,338 |
| github-app       |          12 |          3 |                      1 |         1,112 |
| provenance-doc   |           2 |          3 |                      1 |         1,076 |

- **Median over cases: 6 files read, 2 of them outside the slice, 4.4 KB.**
  58 of 60 runs read something outside; in 18 of 20 cases every run did.
- **What is read outside** is mostly orientation: the root `package.json`,
  `AGENTS.md`, `turbo.json`, the lockfile and the root markdown files in 6
  to 9 runs each; then the neighbouring packages (`packages/core` in 21
  runs, `packages/shared`, `packages/db` and `packages/jira` in 12 to 14,
  `apps/api` in 12). workspace-stubs is the outlier: the agent read the
  sandbox-factory sources it was changing stubs for, 16 files and 158 KB.
- **No credential, `.env`, `infra/` or `.github/` file was read.** The 5
  matches on the sensitive pattern are source modules named
  `credentials.ts` and `secrets.ts`, which belong to the packages in play.
- **Reading.** On a brief that names the files, a `full` agent reads
  little, so the slice's confidentiality benefit on this corpus is a
  handful of neighbouring files per task. The benefit is the ceiling of
  what the agent could have read, not what it did; this corpus does not
  show an agent wandering. A loose brief (E8c) is the test of that.

### E8b: setup time and disk

Each E6b case in a fresh copy, one at a time with nothing else running, on
the Mac mini: `npm ci` with a warm npm cache (npm 10.9.2,
`--ignore-scripts`), the build the arm's agent needs, and one `npm test`
of the package. `full` is the repository's sources at B; the slice is the
E6b `slice-seam` template's sources (CLI `ad8b99c8bd40`). Data in
`results/e8-setup-time.jsonl`.

| case               | `full` to first test | `slice` to first test | `full` node_modules | `slice` node_modules |
| ------------------ | -------------------: | --------------------: | ------------------: | -------------------: |
| handles            |                4.4 s |                 1.1 s |              347 MB |                33 MB |
| identicon          |                3.8 s |                 1.2 s |              347 MB |                41 MB |
| step-holds         |                5.3 s |                 1.4 s |              706 MB |                33 MB |
| ticket-content     |                3.7 s |                 1.2 s |              437 MB |                33 MB |
| analysis-params    |                3.6 s |                 1.2 s |              400 MB |                33 MB |
| jira-spec          |                3.5 s |                14.9 s |              347 MB |                41 MB |
| categories         |                4.1 s |                 1.1 s |              400 MB |                33 MB |
| context-sources    |                4.9 s |                 1.4 s |              705 MB |                33 MB |
| github-app         |                4.2 s |                 1.7 s |              400 MB |                41 MB |
| jira-pages         |                4.4 s |                 1.5 s |              359 MB |                49 MB |
| oauth-membership   |                4.5 s |                 1.8 s |              347 MB |                84 MB |
| second-atlassian   |                4.8 s |                 2.4 s |              347 MB |                84 MB |
| jira-contract      |                3.6 s |                 1.2 s |              347 MB |                41 MB |
| provenance-doc     |                3.0 s |                 1.3 s |              267 MB |                41 MB |
| image-digest       |                3.7 s |                 2.3 s |              267 MB |                85 MB |
| aws-deploy         |                3.9 s |                 1.6 s |              267 MB |                84 MB |
| workspace-stubs    |                5.6 s |                 1.2 s |              695 MB |                33 MB |
| jira-boards †      |                5.7 s |                 2.1 s |              347 MB |                50 MB |
| jira-connections † |                4.4 s |                 2.0 s |              347 MB |                50 MB |
| generate-id †      |                4.5 s |                 2.0 s |              347 MB |                50 MB |

† Measured on CLI `12be6e03d313` after the fix below, cut with
`--live postgres`.

| Bar                                           | Result                                                              | Verdict  |
| --------------------------------------------- | ------------------------------------------------------------------- | -------- |
| Time to the first test run at least 50% lower | median 4.3 s against 1.5 s; median ratio 0.35; lower in 19 of 20    | **pass** |
| `node_modules` at least 50% smaller           | median 347 MB against 41 MB; median ratio 0.12; smaller in 20 of 20 | **pass** |

- **The absolute numbers are small.** sandbox-factory installs from a warm
  cache in 2 to 4 seconds and its workspace builds in about a second, so
  the slice saves three seconds per setup here. The bar passes on the
  ratio; the benefit's size is a property of the repository, and this
  one is small. n8n's measurement is pending (below).
- **jira-spec's slice is slower**, 14 s against 3.5 s: its `npm test`
  runs the package's whole suite through the slice's TypeScript build
  before testing, where the repository's package test runs a prebuilt
  `dist-test`.
- **Three slices did not install: a carveout defect, fixed.** jira-boards,
  jira-connections and generate-id (`packages/db`) failed `npm ci` under
  npm 10.9.2: the slice mocks `postgres` at `0.0.0-carveout`, and the
  installed `drizzle-orm` has a peer range `postgres >=3` that no 0.0.0
  satisfies. npm 11, which cut the templates, had let it through. Fixed
  in `87d8e78`: a mock carries the floor of its importer's pin (3.4.5
  here). Re-measured on the gated CLI, the three install in 2 seconds at
  50 MB, and the bars hold on all 20 cases.

### E8c: a loose brief

Registered: the E6b corpus × `full` and `slice-seam` × 3 runs on Haiku
5.5, briefed with the commit's own message in place of the confirmed spec,
same allowed paths, same calibrated hidden suite. Bars: Phase 5's two
efficiency bars; acceptance reported with no bar.

- **Runs.** CLI `2c5864b dist:e4197b89cf13` (the computed-import rule as
  narrowed), 2026-11-04 20:09 to 22:09 SGT, $3.67 (`full` $1.80,
  `slice-seam` $1.87). The data is in `results/bench-e8c.jsonl`, each row
  marked `brief: "ticket"`. A first start on `18bdebd` lost three
  templates to the broad rule (the 12:02–12:04Z rows of
  `bench-unusable.jsonl`) and was stopped before any session finished.
- **The briefs.** Nine of the 20 messages are one subject line (8 to 12
  words); the rest run from 15 to 2,923 words (jira-pages, aws-deploy,
  identicon), written for a reader of the diff, not for someone about to
  write it.

| arm          | accepted | other verdicts           |
| ------------ | -------: | ------------------------ |
| `full`       |   0 / 60 | rejected 55, no change 5 |
| `slice-seam` |   0 / 60 | rejected 54, no change 6 |

| Bar                                              | `slice-seam`                                   |
| ------------------------------------------------ | ---------------------------------------------- |
| Total input at least 30% lower (median of cases) | 12.1% **higher**; lower in 9 of 20: **fail**   |
| Cost per accepted run at least 30% lower         | no accepted run in either arm: **unavailable** |

- **Nothing passes, in either arm.** 44 of the 55 `full` rejections and 42
  of the 54 slice ones are compile failures: the hidden suite does not
  build against what the agent wrote, because it pins names, signatures
  and modules the confirmed spec names and the commit message does not.
  The rest fail hidden tests. 11 runs changed nothing (analysis-params 6
  of 6, ticket-content 3, workspace-stubs 2): the agent read, found no
  task it could pin down, and stopped. The pilot's 0 of 12 holds with a
  calibrated suite; acceptance here is a property of the brief, not of
  the arm.
- **The mergeback bars, for the record.** 0 unsafe rows of 41 with an
  in-slice verdict; 41 of 41 agree; coverage 68% (13 partial applies, 6
  no-change rows), below the bar.
- **Where the tokens go.** Both arms read less than with the spec (median
  case input `full` 467k against E6c's 618k, `slice-seam` 647k against
  824k) in about the same turns (18): the agent gives up sooner. The
  slice is lower in 9 of 20 cases, higher in the median case: having to
  find the code does not make the slice cheaper, it makes the slice's
  smaller search space pay in half the cases and its stubs and mocks
  cost in the other half (image-digest, workspace-stubs, oauth-membership
  read two to three times `full`'s input).

**What E8c says.** With a brief that does not name the files, the slice
saves no tokens either, and the question the avenue asked (does the
saving grow when the agent must find the code) has its answer: no, the
median goes from 24% more input with the spec to 12% more without it,
and the arm comparison is otherwise degenerate at zero acceptance each.
A brief loose enough to need a search is too loose for a calibrated
hidden suite, on this corpus.

### E8d: scope from the ticket

E7's 60 planning sessions named entries from the spec alone. Each planned
cut was re-planned with the frozen CLI in the case's tree at B and set
against the commit's real package change.

- **A planned cut holds every file the commit changed in 38 of 60 plans**
  (112 of 141 modified code files held; 44 of 72 added files land in a
  folder the cut reaches). The misses are one shape: the planner names
  the module the spec is about and not the sibling the commit also
  touched (step-holds, aws-deploy, jira-pages: 1 of 3 or 1 of 2 modified
  files), or a folder the commit adds (categories's `selection/`,
  generate-id's three schema files).
- **Coverage does not decide the verdict:** 34 of 38 accepted when the
  plan covers the change, 18 of 22 when it does not. The spec, not the
  cut, tells the agent where to write, and `apply` carries the rest.
- **Size.** Planned cuts median 9 files against the seam's 9.5; the
  planner matched the seam in every run of 9 cases, chose smaller in 2,
  larger in 4, and varied between runs in 5. Spearman's ρ between planned files and the commit's changed lines is
  0.25 (0.34 against changed files); the seam's own size reaches 0.52.
  Neither is a sizing feature on its own.
- **Scope.** No slice arm wrote outside its allowed paths in any of the
  180 slice rows. The 9 `full` rows with outside writes are the
  `AGENTS.md` strip artifact E6b describes, not the agent's.

### E8e: a slice as the judge

From Phase 7's first round: each case's commit judged in its `slice-seam`
cut (the agent's view and the hidden suite, two runs of the slice's
`npm test`) and in the repository (`judge()` on an installed clone with
its workspace dependencies prebuilt), both timed. The 12 cases with a
commit replay and a repository time:

| case             | slice judge | repository judge | verdicts                  |
| ---------------- | ----------: | ---------------: | ------------------------- |
| categories       |       1.9 s |            3.6 s | agree                     |
| handles          |       3.2 s |            3.9 s | agree                     |
| provenance-doc   |       3.8 s |            3.4 s | agree                     |
| jira-contract    |       4.0 s |            3.2 s | agree                     |
| analysis-params  |       4.5 s |            4.2 s | agree                     |
| generate-id      |       4.7 s |            5.0 s | agree                     |
| context-sources  |       7.0 s |            5.8 s | agree                     |
| second-atlassian |      13.7 s |            3.0 s | agree                     |
| identicon        |       5.1 s |            4.7 s | disagree (mocked schema)  |
| github-app       |       6.6 s |            4.8 s | disagree (mocked schema)  |
| oauth-membership |       6.7 s |            4.2 s | disagree (agent test)     |
| image-digest     |      12.1 s |            3.0 s | disagree (mocked service) |

| Bar                                                          | Result                                                            | Verdict  |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | -------- |
| Median judge time at least 50% lower in the slice (agreeing) | 4.2 s against 3.8 s; median ratio 1.08 (third round: 4.3 s, 1.11) | **fail** |

- The slice judge builds the slice with `tsc` twice and runs its tests
  twice; the repository judge reuses a warm clone whose dependencies are
  built, and the package's own test is a second or two. On a repository
  whose package test is this fast there is nothing for a slice to save,
  and the disagreements (4 of 12, every one the safe direction) would
  still send a change to the repository.

### E8f: a weaker model in a slice, from existing rows

Cross-CLI, as registered: Sonnet 5.5 `full` from E6a (CLI `3a7b6cafb637`)
against Haiku 5.5 `slice-seam` from E6b's rerun of the same 8 cases (CLI
`ad8b99c8bd40`), 24 runs each. Haiku `full` on the E6b CLI beside them.

| arm                | accepted | corrected for refusals | cost per accepted run | median input | median output |
| ------------------ | -------: | ---------------------: | --------------------: | -----------: | ------------: |
| Sonnet `full`      |  20 / 24 |                23 / 24 |                $0.185 |      104,916 |         4,721 |
| Haiku `slice-seam` |  24 / 24 |                24 / 24 |                $0.028 |      345,849 |        12,938 |
| Haiku `full`       |  16 / 24 |                22 / 24 |                $0.034 |      281,072 |        10,977 |

- Haiku in a slice was accepted at least as often as Sonnet in the
  repository on every case (categories: 3 of 3 against 2 of 3) at 15% of
  the cost per accepted run. Haiku in the repository on the same CLI
  reaches 22 of 24 at $0.034, so most of that saving is the model's price,
  not the slice's; the slice adds 2 runs out of 24 and costs 18% less per
  accepted run than Haiku `full`.
- Not a result on its own: the two arms ran on different CLIs and
  harness versions, the harness strip changed between them, and the E6b
  rerun's Haiku `full` refusals are the artifact. The registered run is
  below.

**The registered run.** Sonnet 5.5 `full` × 3 on the 8 cases, spec
briefs, the shared `full` templates, harness of `4dde419`, 2026-11-04
22:11 to 22:24 SGT, $3.69. Beside it, E6c's Haiku rows on the same 8
cases (CLI `1009bdd`, spec briefs, the same harness), so the pair shares
the harness and the judge. The data is in `results/bench-e8f.jsonl`.

| arm                      | accepted | cost per accepted run | median input | median output | median minutes |
| ------------------------ | -------: | --------------------: | -----------: | ------------: | -------------: |
| Sonnet `full` (E8f)      |  24 / 24 |                $0.154 |      107,768 |         4,771 |            0.7 |
| Haiku `slice-seam` (E6c) |  24 / 24 |                $0.029 |      320,797 |        11,773 |            0.9 |
| Haiku `full` (E6c)       |  24 / 24 |                $0.023 |      287,052 |        10,525 |            1.0 |

| Bar                                                                     | Result                                | Verdict         |
| ----------------------------------------------------------------------- | ------------------------------------- | --------------- |
| Haiku-in-slice within 10 points of Sonnet-in-full (one-sided 95% bound) | 0 points, bound -10.1 (24 of 24 each) | **fail** at 0.1 |
| Cost per accepted run at least 50% lower                                | 81% lower                             | **pass**        |

- **The bar's first half fails on arithmetic, not on data**: at 24 of 24
  in both arms the difference is 0 and a one-sided 95% Newcombe bound on
  24 runs sits at -10.1, a tenth of a point past -10. With 36 runs each
  it would pass. Read as registered, the bar fails; read as a ceiling
  effect, the 8 cases cannot separate any two arms (the Phase 5 confound
  list foresaw this).
- **The cost half passes, and the control takes it away.** Haiku in the
  repository is also 24 of 24, at $0.023 per accepted run: 85% below
  Sonnet. The 81% saving is the model's price; the slice costs 25% more
  than Haiku `full` on these cases (it reads 12% more input), as E6c
  found on all 20.
- **Sonnet reads a third of what Haiku reads** (108k against 287k input)
  and writes less than half, in 0.7 minutes: the stronger model needs no
  slice to be frugal.

**What E8f says.** A weaker model in a slice matches a stronger one in
the repository on this corpus, at a fifth of the cost; so does the weaker
model in the repository, at less. The slice is not what makes Haiku
enough here; the corpus is.

### E8g: a large repository

Registered: candidates from cal.com and n8n by Phase 6's rule; if the
repository's install, build and test at B do not complete on this
machine, that is the result, with the step that failed and its time.
Time-boxed to 30 minutes, 2026-11-04 22:25 to 22:33 SGT, n8n first.

| step                                          | result                                                                                         | time           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------- |
| clone (`--filter=blob:none`, one branch)      | 449 MB                                                                                         | under 1 min    |
| discover, Phase 6's rule, whole repository    | 40 candidates, every one spanning packages (`packages/@n8n/*`, `modules/*`)                    | 1 min 7 s      |
| discover, one package each                    | `packages/cli`, `core`, `workflow`: 20 each, one to seven files, with tests                    | 30 s each      |
| **install at HEAD** (`pnpm 12.4.2`, corepack) | **killed at 1.15 GB free**: 3,116 of 3,317 packages added, 2.7 GB `node_modules`, 5.1 GB store | **2 min 12 s** |
| build, test                                   | not reached                                                                                    |                |

- **The failing step is the install, for disk.** The machine had 4.6 GB
  free after the clone (13 GB of this benchmark's own `full` templates
  sit on the same disk); n8n's install wants about 8 GB between the
  content-addressed store and the linked `node_modules`. cal.com was not
  attempted: nothing was left to attempt it with. The model arms did not
  run.
- **E8b's n8n measurement, the half that was possible.** One slice at
  the base of `96cfba9` (`packages/workflow`, "Keep the ExpressionError
  name in minified builds", 1 file, 1 test): the cut reads n8n's whole
  graph and returns in 5.5 s (4.0 s at depth 2), 2 files, 140 KB on disk,
  no blocker, against an install that had not finished at 2 min 12 s and
  2.7 GB. Then two limits of the cut, not of the machine:
  - the slice's `package.json` carries `"typescript": "catalog:typescript"`,
    a pnpm catalog reference npm rejects (`EUNSUPPORTEDPROTOCOL`), and
    pnpm cannot resolve without the workspace's catalog file;
  - the slice has no lockfile, because carveout writes one from
    `package-lock.json` only, so `npm ci` refuses before that.
    A slice of a pnpm workspace with catalogs needs the catalog resolved at
    cut time; not in this round.
- **The walk's own limit on n8n's layout.** `--with-tests` carried no
  test at either depth: the commit's test (`native-evaluation-parity`)
  does not import the entry at B. Phase 6's rule picks commits whose
  tests import the change; on n8n those tests reach it through the
  package barrel or a built artefact, and the two-file slice shows the
  seam, not the feature.

**What E8g says.** The avenue's premise holds, a repository this size
cannot be read or installed casually, and the slice's cut is cheap
against it (5 s and 140 KB against minutes and gigabytes). What it does
not show is a working slice: catalog references and the missing lockfile
stop the install, and the seam carries no test. The benefit a large
repository offers is real and this CLI does not yet collect it.

### What Phase 8 says

Seven avenues, registered before data, on the corpus Phase 5 built.

| avenue                      | bar                         | result                                                            |
| --------------------------- | --------------------------- | ----------------------------------------------------------------- |
| E8a exposure                | none                        | `full` agents read 2 files outside the slice (median), no secrets |
| E8b setup time and disk     | ≥50% lower, both            | **pass**: 0.35× time, 0.12× disk; ~3 s and ~300 MB on this repo   |
| E8c loose brief             | Phase 5 efficiency          | **fail**: 12% more input; 0 of 60 accepted in both arms           |
| E8d scope from the ticket   | none                        | plans cover the change in 38 of 60; ρ 0.25 with size              |
| E8e slice as the judge      | ≥50% lower judge time       | **fail**: 1.1× slower                                             |
| E8f weaker model in a slice | within 10 pts, ≥50% cheaper | cost **pass** (81%), bound -10.1; Haiku `full` is cheaper still   |
| E8g large repository        | feasibility, then Phase 5   | install does not complete here; cut 5 s, slice does not install   |

The slice's measurable wins on this corpus are the ones that do not
involve a model: a smaller tree to install and read, a bounded view, a
cheap cut. Every bar that puts a model in the slice fails or is taken by
a control: the token saving does not appear (Phase 5, E6c, E8c), the
judge is not faster (E8e), and a weaker model does as well in the
repository as in the slice (E8f). The one mergeback number from model
runs (E6c) sits above the 2% bar on a rule since fixed and not re-run.
