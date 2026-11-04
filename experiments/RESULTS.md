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

| Bar                                                         | Result                                   | Verdict  |
| ----------------------------------------------------------- | ---------------------------------------- | -------- |
| Round trip byte-identical in at least 90% of in-slice diffs | 50 of 52; 42 of 42 on the usable cases   | **pass** |
| Every round-tripped patch applies at B                      | 52 of 52                                 | **pass** |
| In-slice and post-merge verdicts agree in at least 95%      | 28 of 42 usable rows (67%)               | **fail** |
| No slice-passes, repository-fails case caused by carveout   | 0; the two are coverage (below)          | **pass** |

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

| Case | Arm | Repository verdict | In-slice verdict | Total input tokens | Output tokens | Minutes |
| --- | --- | --- | --- | ---: | ---: | ---: |
| handles | full | accepted | — | 278,529 | 5,591 | 1.90 |
| handles | slice-seam | accepted | pass | 185,835 | 4,985 | 1.89 |
| jira-spec | full | accepted | — | 490,507 | 11,629 | 4.47 |
| jira-spec | slice-seam | accepted | unavailable | 885,904 | 15,243 | 6.60 |

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
