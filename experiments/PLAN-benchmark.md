# PLAN: slice against full repository (E5–E7)

Two claims to prove, in this order:

1. **Correct.** Work done in a slice is still correct after `patch` merges it
   back. The repository's own tests decide that, on a fresh checkout, not
   the slice's mocks.
2. **Cheaper.** For the same task, an agent in a slice uses fewer input and
   output tokens than an agent in the full repository, and is accepted no
   less often.

Claim 2 means nothing without claim 1, and claim 1 depends on how well
mergeback works. So the plan fixes the mechanics first and checks them
without a model (E5). Then it pilots, and only then runs the benchmark
(E6, E7). As in [PLAN.md](PLAN.md), every pass bar below is fixed before
its experiment runs. Work that fails its bar is reported, not tuned until
it passes.

## Where mergeback stands (2026-10-28)

`patchProject` in `src/carve.ts` and E2 cover one case: an edit to an
included file, applied with `--3way`. An agent's real change can also do
the following, and today none of it survives the trip back:

| Gap                     | What happens now                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deleted or renamed file | `listTree` walks only the files that exist, so a deletion never reaches the patch.                                                                                                                                       |
| New import in a file    | `undoRewrites` undoes only the specifiers the cut recorded. A new import of a stub keeps its slice-relative path, often across a package boundary.                                                                       |
| New file                | Copied raw. None of its imports are restored.                                                                                                                                                                            |
| Edit to a stub or mock  | Dropped with a warning (`generatedEdits`). The task needed code outside the slice, and the merged patch won't compile.                                                                                                   |
| `package.json` edit     | Generated, so dropped. A new dependency is lost.                                                                                                                                                                         |
| Test using the mocks    | It imports `carveout/mock.js`, which isn't in the repository, so it breaks after the merge.                                                                                                                              |
| Changed export          | Importers outside the slice are listed in `BOUNDARY.md` but never checked. The slice passes and the repository fails.                                                                                                    |
| Repository gates        | sandbox-factory's package `npm test` enforces 80–90% coverage and `assert-all-covered`. Its `AGENTS.md` and conventions aren't in the slice either. A slice agent can't see the rules its merged change will be held to. |
| Verify after merge      | E2 left `patch --apply --verify <cmd>` waiting on your decision, because it acts on a checkout.                                                                                                                          |

## Phase 1: mergeback mechanics (no model)

Each item gets a fixture test in `test/` (the `shop` fixture, extended)
before it counts as done.

- **M1. Deletions and renames.** Included files missing from the folder go
  into the patch as deletions. `git diff` without `--no-renames` detects
  renames.
- **M2. Restore imports by target, not by literal.** For every changed or
  new script file, resolve each specifier in the slice. If it lands on an
  included file, a stub or a workspace package, write the specifier the
  repository would use for that target: the alias, the workspace name, or
  the extensionless form the file's neighbours use. This replaces
  `undoRewrites`'s literal map for edited files.
- **M3. Boundary edits are an outcome.** An edit to a stub, a mock,
`package.json` or `tsconfig.json` is reported as `boundary`, with the
module and the symbols, under its own exit code (5), and is never
silently dropped. E6 counts these runs separately. A later `carveout grow
<dir> <module>` (re-cut with one more entry, keeping the edits) is built
  only if E6 shows that boundary edits are common.
- **M4. `carveout apply <dir> <patch>`.** The reverse of `patch`: it applies
  a repository patch inside a slice and rewrites imports forward, as the
  cut does. E5 replays real commits with it, and the judge uses it to bring
  hidden tests into a slice.
- **M5. `carveout merge <dir> --into <checkout> [--verify <cmd>]`.** It runs
  `patch`, then `git apply --3way` into the named checkout, then the verify
  command, and reports each step as `check` does. `--into` is required:
  there is no default to the current checkout (decision 1 below).
- **M6. Surface check at patch time.** Compare the slice's offered exports
  (the cut's `BOUNDARY.md` surface) before and after the edits. A changed or
  removed export that an outside importer uses is a warning that names the
  importers. The slice can't verify them; the merge's verify step can.
- **M7. Slice-only tests.** A new test that imports `carveout/` is kept out
  of the patch and listed. A new test that doesn't is patched, at the path
  and on the runner the repository's package uses.
- **M8. Gates in the slice.** `cut` copies the package's test gate (its
  coverage thresholds) into the slice's `npm test`, and the repository's
  `AGENTS.md` into the slice's `BOUNDARY.md` (decision 4 below).

## Phase 2: E5, replaying real commits (no model)

A real commit is an "agent" whose answer is known. If carveout can't round
trip it, no agent result means anything.

- **Corpus.** sandbox-factory's first-parent `feat`/`fix`/`perf` commits
  (103 today; every one after 2026-09-15, after the model's training
  cutoff). Commits are picked as `duediligence/evidence/in-repo.mjs
discover` picks them: one package, source changed outside tests, a test
  added or changed, no harness change. Start with its 11 checked cases
  (`evidence/in-repo/cases.json`), then the rest.
- **Entries.** Each case's `seam`: the files the ticket names, drafted
  without the diff. A second run uses the files the commit actually
  changed.
- **Per case, at the commit's parent B:**
  1. Cut the entries at B with `--with-tests --depth 1`, then `check`.
  2. **Coverage.** Which of the commit's changed files lie outside the
     slice. Record it, and replay only the part inside.
  3. Run `carveout apply` (M4) of the commit's in-slice diff, then
     `npm test` in the slice. That gives the in-slice verdict.
  4. Run `carveout patch`, then compare it with the commit's own in-slice
     diff (**round trip**).
  5. Run `carveout merge` into a fresh `git clone --shared` at B, then the
     package's build and tests plus a typecheck of the importing packages.
     That gives the post-merge verdict.
- **Pass, fixed now:**
  - at least 90% of in-slice diffs round-trip byte-identical, and every
    failure is explained;
  - 100% of round-tripped patches apply cleanly at B;
  - the in-slice and post-merge verdicts agree in at least 95% of cases,
    with **no** case where the slice passes and the repository fails
    because of carveout itself (outside importers, M6, are counted
    separately).
- **Iterate.** Every failure is a defect for Phase 1. Fix it, add a
  fixture, and re-run E5 on a frozen `dist/` (as in E1–E4). E5 is settled
  only when one frozen build passes all three bars.
- **Also produced:** the benchmark's cases. A case is usable when its seam
  slice covers the commit's code, the commit passes post-merge, and its
  tests fail at B.

## Phase 3: the harness (`experiments/bench/`)

Reuse duediligence's session runner rather than writing a new one:
`claude()`, `sessionSettings()`, the slot and memory gate, and `peeks()`
from `duediligence/experiments/bin/lib.mjs`. Copy them; the two repositories
are independent.

- **Case.** `{ repo, commit, package, seam }` in `e5-cases.json`, plus,
  from duediligence's in-repo evidence (`bench/specs/<slug>/`):

  - the developer-confirmed spec, which is the brief;
  - its toolchain, which gives the allowed paths and the hidden folder;
  - its calibrated hidden suite, which is the judge.

  _Changed after the pilot_ (see Phase 4). The plan first briefed the
  commit message and judged with the commit's own tests.

- **Arms.**

  | arm          | the agent works in                                                                             | entries                                                     |
  | ------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
  | `full`       | the whole repository at B, dependencies installed                                              | none                                                        |
  | `slice-seam` | a carveout slice at B                                                                          | the case's seam                                             |
  | `slice-diff` | a carveout slice at B                                                                          | the files the commit changed: a ceiling, never the headline |
  | `slice-plan` | the whole repository read-only, cuts its own slice with `carveout plan`, then works in it (E7) | its own                                                     |

- **Blindness.** Every workdir comes from `git archive B` plus a fresh
  `git init`, so no later commit is reachable. The OS sandbox and the deny
  rules are as in duediligence, and the hidden tests stay out of every
  workdir.
- **Setup off the clock.** For the `full` arm, `npm ci` runs once per base
  into a template, which each run copies with APFS `cp -c`. Setup time is
  recorded for both sides (install against cut plus check) but kept apart
  from model cost.
- **Judge, identical for every arm.** Take a fresh clone at B. Apply the
  change: the workdir diff for `full`; `carveout merge` for the slice arms,
  where an apply failure is its own verdict. Overlay the hidden tests. Then
  run:

  1. **functional**: the hidden tests and the package's existing tests,
     without the coverage gate;
  2. **gates**: the package's `npm test` as written, coverage included;
  3. **importers**: a typecheck of every package that imports the changed
     files.

  For the slice arms, also apply the hidden tests into the submitted slice
  (M4) and run them. That is the in-slice verdict, compared with the
  post-merge one.

- **Verdicts.**
  - `accepted`: functional, gates and importers all pass;
  - `functional`: only the gates fail;
  - `rejected`;
  - `boundary` (M3);
  - `apply-failed`;
  - `refused` (it touched tests or the harness, as in duediligence).
- **Usage.** Extend `claude()` to keep the result line's `usage` and
  `modelUsage`: `input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `output_tokens`, plus cost, turns and
  duration. From the transcript, also count Read, Grep and Glob calls and
  the bytes of tool results the agent was given.

## Phase 4: pilot (model, nothing counted)

Three cases × `full` and `slice-seam` × 2 runs, on Haiku. Read every
transcript. Look for agents fighting the mocks, editing stubs, writing tests
that can't merge, hitting coverage gates, or a harness that leaks. Each
finding goes back to Phase 1 or 3. Repeat until a pilot round turns up
nothing new.

**Findings (2026-10-29).** Three rounds, on handles, jira-spec and
categories (identicon in the first).

1. **The ticket against the commit's tests: 0 of 12 accepted in either
   arm.** The commit's tests assert what the ticket never says:

   - exact messages;
   - a module the ticket does not name (`adf.ts`);
   - a dozen exports beyond the interface.

   This is duediligence's finding again: a spec has to be confirmed before
   it can judge. So the brief became the confirmed spec, and the judge its
   calibrated hidden suite, on which duediligence's Haiku passes 5 of 5 in
   every case.

2. **An in-slice judge defect.** Applied alone at B, a hidden test of a
   module the change adds was left behind as unresolved, and the agent's
   own test ran in its place. The in-slice verdict now applies the change
   and the hidden suite as one patch.
3. **Third round: 12 of 12 accepted, and the in-slice verdict agrees 6 of 6.** There were no boundary edits, no peeks, and no file outside scope.
   Slice agents read `BOUNDARY.md` and `carveout/test.js`, and two of six
   read `carveout.json` (up to 18 KB). That overhead is small, so nothing
   changed for it.

## Phase 5: E6 (pre-registered, model)

- **Size (amended 2026-10-29, before any E6 data).** E6a: the 11 cases
  with a confirmed spec, × `full`, `slice-seam` and `slice-diff` × 5 runs,
  on Haiku 5.5. A case is usable when its calibration passed and a template
  of every arm builds at B (the slice's own tests run). A case that does not
  is reported and left out. Then the Sonnet 5.5 check: 10 of the usable
  cases × `full` and `slice-seam` × 3 runs. E6b, on a corpus grown to 30,
  comes later and is held to the same bars.
- **Correctness bars:**
  - `slice-seam` acceptance (post-merge) is within 10 points of `full`
    (non-inferiority, one-sided 95%);
  - "slice passed, repository failed" happens in at most 5% of
    `slice-seam` runs.
- **Efficiency bars, paired per case, median over runs:**

  - `slice-seam`'s total input tokens (fresh, cache write and cache read)
    are at least 30% below `full`'s;
  - cost per accepted run is at least 30% below `full`'s.

  Output tokens, turns, wall time and tool-result bytes are reported with
  no bar.

- **Report.**
  - Each metric per arm: median, IQR and the paired difference.
  - Verdict counts.
  - Every disagreement between the in-slice and post-merge verdicts,
    classified by hand (mechanics, outside importer, mock behaviour,
    gate).

E7 then adds `slice-plan`, with the planning tokens counted against it.
It's the arm that answers whether slicing pays when nobody hands the agent
its entries.

## Phase 6: E6b and E7 (registered 2026-11-04, before any data)

**The corpus.** Grown by a rule, not by hand, from sandbox-factory's
first-parent, non-merge `feat`/`fix`/`perf` commits since 2026-09-15:

- A candidate is a (commit, package) pair where the package is one of
  `packages/core`, `packages/shared`, `packages/db`, `apps/api` or
  `apps/worker` (`apps/web` is left out: E5 found web slices under
  `NodeNext` unusable); the package's changed files include no harness
  file, at least one non-test source file and at least one test file that
  imports a changed source file or the package's `src/index`; the seam
  diff adds 20 to 700 lines; and there are at most 8 seam files.
- The commits of the 11 existing cases are left out. One case per commit:
  the package with the most tests importing its changed files, ties to the
  larger seam diff.
- **The seam** is mechanical: the changed non-test source files that the
  commit's tests import directly, `index.ts` barrels dropped when another
  file qualifies; when the tests import only the package index, every
  changed non-test source file but the barrel. `allowed` is the seam
  files' folders. The seam is the slice's entries, not what the agent is
  told (the agent gets the spec and the allowed paths).
- **Usability**, in this order, with every failure recorded and the case
  left out: duediligence's `in-repo.mjs check` (the commit's package
  changes alone build at B and regress no existing test); the drafted and
  the simulated-developer-confirmed spec and the calibrated hidden suite
  (`prepare`, as for the 11, with no person in the loop); E5's replay on
  the frozen CLI; and a template of every arm that builds at B.
- The rule yields 40 candidates (`duediligence/evidence/in-repo-e6b/`);
  they are checked newest first until the usable corpus, with the 8 usable
  cases of E6a, reaches 30, or the candidates run out. The number reached is
  reported, and the bars are read on that corpus.

**E6b.** The usable corpus × `full`, `slice-seam` and `slice-diff` × 3
runs, on Haiku 5.5, on one frozen CLI that holds `05f4f9f` and `01691fd`.
The bars are Phase 5's, unchanged. The 8 E6a cases are rerun on the new
CLI with the rest; E6a's rows stay in `results/bench.jsonl` under their
CLI id and are not pooled with E6b's.

**E7.** The same corpus × `slice-plan` × 3 runs, on Haiku 5.5, judged as
the slice arms are, against E6b's `full` rows. `slice-plan` is two
sessions: in a copy of the repository at B, with the frozen CLI laid in at
`.carveout/`, the agent is given the spec and asked only to name the
slice's entries (`bench/prompts/plan.md`); the harness cuts those entries
with the slice arms' flags, checks the cut and installs it; a second
session works in it under the slice brief. Every measurement sums the two
sessions. A run whose named entries do not exist at B, or whose cut fails
its baseline check, is `plan_failed`: not accepted, and its planning
session's tokens count. Bars: `slice-plan` is held to the four bars of
Phase 5 in place of `slice-seam`; its `plan_failed` share is reported
with no bar.

**Order.** E5 on the frozen CLI for every case first. Then E6b. Then E7.
A run the usage limit stops is resumed, never restarted: a case, arm and
run with a line is done.

## Phase 7: the mergeback claim (registered 2026-11-04, before any data)

E5 and E6b leave "a change that passes in the slice passes after the
merge" unestablished. Phase 2's agreement bar counts the safe direction
(the slice fails on a mock, the repository passes) with the unsafe one
(the slice passes, the repository fails), and on the grown corpus the safe
direction alone fails it (28 of 42). The in-slice verdict was unavailable
in 23 E6b rows. This phase fixes the causes found and splits the bar.

**The fixes**, all code, none of it a model, in the CLI the runs name:

1. `cut --live <package>`: a service package kept real, installed and
   typed as the repository has it, with the environment its importers
   read left out of `carveout.env`. For packages whose tests need the
   service itself (`packages/db`, `apps/api` on `postgres`), so the slice
   has a verdict where before it had only a red baseline.
2. `--with-tests` carries a test that reaches a slice module through a
   barrel outside the slice, and the barrel with it (workspace-stubs's
   three unsafe rows).
3. `npm test` in a slice holds the package's never-loaded-file guard
   (`assert-all-covered`) over the files the change adds (generate-id).
4. `apply` takes the modules a change adds past the cut's reach as entries
   of their own, with their tests, so the judge's clean cut reaches them
   (the 23 unavailable verdicts).

Not in this round: a typecheck of the slice's outside importers (M6).
`BOUNDARY.md` still lists them unchecked.

**Bars**, read on rows with an in-slice verdict (`ok` true or false; not
a partial apply, a failed apply, or an install or build failure in the
judged slice). Phase 2's 95% agreement bar is still reported, unchanged.

- Unsafe direction: the slice passes and the repository fails in at most
  2% of such rows, with the one-sided 95% upper bound reported beside the
  count, and every such row classified by hand as a carveout gap, a judge
  gap or a spec-suite defect. A carveout gap is a defect to fix before
  the next run, as in Phase 2.
- Verdict coverage: at least 90% of judged slice rows have an in-slice
  verdict.
- Safe-direction disagreements are reported with their cause, no bar.

**Live services.** A case's slice is cut with `--live <driver>` when the
case's package imports the driver directly in its sources or tests
(`from "postgres"`), reads its connection from the environment with a
local default (`DATABASE_URL`, `127.0.0.1:5432`), and the judge's host
runs that service, as the repository's own test needs. On this corpus
that is `packages/db` alone: `apps/api` reaches the database through the
`db` workspace package, which the slice mocks whatever the driver is, so
its integration tests stay in the safe direction until a slice can hold a
workspace package's sources (not in this round). The same host serves
`full`; when the service is down, the repository's tests skip, and so do
the slice's. The choice is recorded per case in the result line's
`setup`; the rule is fixed before the run.

**Order**, cheapest first, each a gate for the next:

1. The parity replay (`bench/parity.mjs --from slice`, no model) of the
   saved E6a and E6b slice-arm changes on the fixed CLI, each judged in
   its slice with its hidden suite. Gate: zero unsafe rows among the
   comparable ones. A failure sends the fix back before any model run.
2. E5 on the fixed CLI for every case in `e5-cases.json`, with the live
   rule above. Gate: Phase 2's round-trip and apply bars, and the unsafe
   bar.
3. E6c: the E6b corpus × `full`, `slice-seam` and `slice-diff` × 3 runs,
   on Haiku 5.5, Phase 5's bars plus the two above. 120 slice rows can
   meet the 2% bar only at zero unsafe rows (upper bound 2.5%); that is
   reported as such, not rounded to a pass.

## Phase 8: where else a slice pays (registered 2026-11-04, before any data)

E6a, E6b and E7 measured one benefit, tokens, on a corpus built against
it: the brief names the files, the repository is small, and most packages
lean on a mocked service. Phase 8 measures the other benefits the README
claims, each on its own bar, cheapest first. Nothing here replaces Phase 7:
a token or time win on a change that does not merge is no win, so Phase 7's
gates run before the model arms below (E8c, E8f, E8g).

**E8a: exposure (no model).** The README's first use is "an agent or a
contractor sees only part of the code". From the saved E6b transcripts
(`work/bench/runs-e6b/<slug>/full-*/<n>/transcript.jsonl`, 20 cases × 3
runs), every repository file the `full` agent read: the path of each
`Read` call, and each existing repository path named in a `Bash` command.
Against it, the file set of the case's `slice-seam` template (the slice's
own copied sources and tests, not its stubs). Reported per case, median
over runs: files read, files read that the slice does not hold, and the
bytes of those files; and the count of reads of `.env*`, `infra/`,
`.github/` or a credentials path. No bar: the number is the claim's size.
A `full` agent that reads nothing outside the slice says the slice costs
nothing in exposure and buys nothing either.

**E8b: setup time and disk (no model).** "Work on one package without
installing or building the others." For each usable E6b case, in a fresh
copy of the `full` template's sources and of the `slice-seam` template:
`npm ci` with a warm npm cache, the build the arm's agent needs
(`buildDependencies` for `full`, `npm run build` in the slice), and one
`npm test` of the package, timed and run one at a time, with the
`node_modules` size after. Bars, median over cases: time to the first test
run at least 50% lower in the slice, and `node_modules` at least 50%
smaller. The same on one n8n slice against n8n's own install, if a clone
and its install finish inside 30 minutes on this machine; reported with
no bar, or reported as not finished.

**E8c: a loose brief (model).** The E6b corpus × `full` and `slice-seam` ×
3 runs on Haiku 5.5, briefed with the commit's own subject and message
(`e5-cases.json`, the ticket) in place of the confirmed spec, with the
allowed paths as before, and judged by the same calibrated hidden suite.
Bars: Phase 5's two efficiency bars. Acceptance is reported in both arms
with no bar: the pilot found loose briefs judged by the commit's tests
gave 0 of 12, and a calibrated suite may not change that; the question
is whether the slice's saving grows when the agent has to find the code.

**E8d: scope from the ticket (no model).** E7's 60 planning sessions named
entries from the spec alone. For each, the size of the planned cut
(`setup.files`) against the commit's real package change (files and lines
in `duediligence/evidence/in-repo-e6b/ledger.jsonl` and `git show`), and
whether the planned entries cover every file the commit changed. Reported:
Spearman's ρ between planned files and changed lines, the share of plans
whose cut holds every changed file, and `outsideScope` writes per arm
across E6b and E7. No bar; this says whether a plan is a usable scope and
sizing feature.

**E8e: a slice as the judge (no model).** Phase 7's parity replay judges
each saved change twice: in a clean cut and in the repository. The time of
each judgment is recorded beside the verdict. Bar: median judge time at
least 50% lower in the slice, on rows where both verdicts exist and agree.
Disagreements are Phase 7's business.

**E8f: a weaker model in a slice (analysis, then model).** From existing
rows, cross-CLI and said so: Sonnet 5.5 `full` (E6a's 8 cases, CLI
`e407a46`) against Haiku 5.5 `slice-seam` on the same cases (E6b's rerun,
CLI `ad8b99c8bd40`): acceptance and cost per accepted run. Then, after
Phase 7's gates, Sonnet 5.5 `full` × 3 runs on those 8 cases on the fixed
harness, so the pair shares a harness. Bar: Haiku-in-slice acceptance
within 10 points of Sonnet-in-full (one-sided 95%) at a cost per accepted
run at least 50% lower.

**E8g: a large repository (model).** The efficiency claim's best case is a
repository too large to read. cal.com and n8n are public, post-cutoff and
already walked in E4. Candidates by Phase 6's rule on each (first-parent
`feat`/`fix` commits since 2026-09-15, one package, tests importing the
change), checked with duediligence's `in-repo.mjs check`, specs confirmed
by the simulated developer. If the repository's install, build and test at
B do not complete on this machine, that is the result, reported with the
step that failed and its time. If it does: up to 8 usable cases × `full`
and `slice-seam` × 3 runs on Haiku 5.5, Phase 5's four bars.

**Order.** E8a, E8d, E8f's analysis, E8b; then Phase 7's gates (which
yield E8e); then E6c; then E8c, E8f's runs, E8g. Each model arm resumes
rather than restarts. `memory_pressure` is checked before each, one
model run at a time under 40% free.

## Confounds, and how each is handled

- **The seam names where to work.** The slice saves searching that the
  `full` agent has to do. That is the benefit being measured, but someone
  has to choose the seam: E7 measures that cost, and `slice-diff` gives
  the ceiling.
- **Ceiling effects.** In duediligence, Haiku sat near 100% on precise
  specs. Tickets here are real commit messages, which are looser. If both
  arms still sit at the ceiling, E6 then rests on its efficiency bars.
- **Big commits.** Some commits span phases (`4d1491e`). The case's
  `allowed` paths scope what is judged, as in duediligence.
- **Limits.** The Max plan's 5-hour limit stops runs, so resume as
  duediligence does. Use concurrency 2 and `--min-free 30`, with a heap cap
  on each test run.

## Decisions for you

1. **Where `merge` may write.** Recommended: only into a checkout named
   with `--into`, never a default. The benchmark merges only into scratch
   clones.
2. **Repositories.** Recommended: sandbox-factory first, since it's public
   and newer than the training cutoff. Command-center and landing come
   later, if E5 finds too few usable cases.
3. **Models.** Recommended: Haiku for volume, plus a Sonnet subset.
4. **Conventions in the slice (M8).** Carrying `AGENTS.md` and the coverage
   gate makes the slice more honest, but also bigger. Recommended: carry
   them, and record the token cost.

5. **Cases for E6.** Decided 2026-10-29: E6a on the 11, 5 runs each, now;
   E6b once the corpus is grown to 30.

## Order

Phase 1 (M1–M3, M4 first: E5 needs it), then E5. Loop between the two
until E5 passes. Then Phase 3, the pilot loop, E6 and E7. Results go in
[RESULTS.md](RESULTS.md) and the procedures in [README.md](README.md),
like E1–E4.
