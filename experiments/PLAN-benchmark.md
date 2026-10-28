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

- **Case.** `{ repo, base, commit, ticket, seam, hiddenTests, package,
allowed }`. The ticket is the commit message, as in duediligence's
  in-repo cases. `hiddenTests` are the commit's added or changed test
  files.
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

## Phase 5: E6 (pre-registered, model)

- **Size.** At least 30 usable cases from E5, × `full`, `slice-seam` and
  `slice-diff` × 3 runs, on Haiku 5.5. Re-run a subset of 10 cases × 2 arms
  × 3 runs on Sonnet 5.5, to check that the result isn't specific to one
  model.
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

## Order

Phase 1 (M1–M3, M4 first: E5 needs it), then E5. Loop between the two
until E5 passes. Then Phase 3, the pilot loop, E6 and E7. Results go in
[RESULTS.md](RESULTS.md) and the procedures in [README.md](README.md),
like E1–E4.
