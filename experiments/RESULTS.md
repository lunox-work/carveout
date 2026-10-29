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
