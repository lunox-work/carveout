# PLAN: experiments from Scion, Graft and Entire

Four experiments for carveout, taken from three sources: Anthropic's
[Redesigning source control](https://www.anthropic.com/research/redesigning-source-control)
(Scion), [Graft](https://github.com/feder-cr/git-ai), an open-source
implementation of Scion, and Entire's
[entire-graph](https://github.com/entireio/entire-graph). Each experiment has
a measurement, and a pass criterion fixed before it runs. Work whose
measurement fails is dropped, not tuned until it passes.

Settled 2026-10-28: see [RESULTS.md](RESULTS.md). What shipped is recorded
in the README. This file is kept as the plan the experiments were held to.

Baseline (2026-10-28): `plan packages/core/src/slice/scope.ts --depth 1`
on sandbox-factory, which has 733 script files, takes 1.1 s (1.8 s user).

Order: E1 and E2 first; they are independent. E3 next. E4 only if its
first step measures a problem.

## Shared evidence

- `experiments/slices.json`: the README's thirteen test slices (repository,
  commit, entry points, depth). Write it down first; every experiment below
  reuses it.
- `experiments/` holds the scripts and results and stays out of the package
  (`files` in package.json already excludes it).
- Every result names the carveout commit and the repository commits it ran on.

## E1. `carveout status <dir>`: is a cut still current?

**Idea.** Scion and Graft store a summary of the paths each commit changed,
so a history query can skip commits that leave a path untouched.
entire-graph diffs revisions symbol by symbol. For carveout, the question
is whether a cut folder still matches the repository, and which parts no
longer do. Today that is answered only at `patch` time, and only for
included files (`patchProject`, `drifted`, `src/carve.ts`).

**Change.** `status` reads `carveout.json` and compares it with the
repository (HEAD plus the working tree):

1. Included files: sha256 against the record (as `patch` does now).
2. Cut modules: extract each stub again from current source and compare
   it with the `generated` hash. When they differ, report which symbols
   were added, removed or changed signature. A change to a body only
   leaves the stub alone and reports nothing.
3. Resolution inputs: the tsconfig files, package.json files and lockfile
   the cut read. If `carveout.json` does not record their hashes yet, add
   them to the record first.
4. New importers of the slice's public surface: for information only, never
   stale.

Output: `current`, or a list of what is stale and why. Choose the exit code
when building it; 0 to 3 are taken (`src/cli.ts`).

**Measurement.** For each slice in `slices.json`, cut at the slice's commit,
then walk 50 later commits of its repository that touch any recorded path.
At each commit, run `status` and also cut afresh. Ground truth: whether the
fresh cut's files (excluding `carveout.json`) are identical to the old one.

**Pass.**

- No commit where `status` says `current` and the fresh cut differs. One
  such case fails E1 until it is fixed.
- Report the share of commits marked `current`. That share is how often a
  re-cut could be skipped.

## E2. A patch that still applies after the repository moves

**Idea.** In Scion, a changeset records changed files by content address
against its first parent, and the server rebases it onto the current tip.
Graft lands a model's merge only if a verify command passes on the exact
tree that would land. Today carveout writes the patch against the commit
the cut was taken at and warns about drifted files, and `git apply` fails
when the surrounding lines have moved.

**Change.** The base bytes of each patched file are that file at the source
commit, so their blob already exists in the repository's object store.

- Emit the diff with `--full-index`, so its `index` lines carry those blob
  ids.
- Tell the user to run `git apply --3way` whenever `drifted` is not empty.
- Exception: a base taken from a dirty working-tree file has no blob in
  the repository. Report that file as unable to merge three-way, and never
  write objects into the user's repository.

**Measurement.** For each slice, make a scripted edit to two of its
included files at the cut commit. Then apply the patch at each later
commit that changed those files. Count the commits where plain `git apply`
succeeds and those where `git apply --3way` applies cleanly. Then run the
repository's typecheck on the result, since a clean apply is not the same
as a correct merge (Graft's verify gate).

**Pass.** `--3way` applies and typechecks on at least 25 percentage points
more drifted cases than plain `git apply`. If so, ship `--full-index` and
the hint. A `patch --apply --verify <cmd>` flag would act on the user's
checkout, so it waits for the user to decide whether they want it.

## E3. Co-change hints in `plan`

**Idea.** entire-graph's `impact` lists the files that historically change
together with a symbol. Imports miss couplings such as a migration and its
schema, a route and its client, or a fixture and its test. carveout works
on a local checkout, so its history costs only a `git log`.

**Change.** Read `git log --name-only` over the last N commits, skipping
commits that touch more than 50 files (Graft treats an oversized change
the same way). Then list files outside the slice that changed in at least
k of the commits touching an included file and in at least x% of them.
`plan` shows them under "Often changed with the slice". They are never
walked or copied. `--json` includes them.

**Measurement.** Split each repository's history at a date T. Fit the hints
on commits before T. Score them on commits after T that touch the slice:
how many hints were also changed in those commits (precision), and how many
co-changed files the hints caught (recall). Fix k, x and N on one
repository, then report results on the other two without retuning.

**Pass.** Precision of at least 0.3, with at most 5 hints per slice, on
both held-out repositories. Otherwise drop the feature. A list people learn
to ignore is worse than no list.

## E4. Graph cache, only if the graph is slow

**Idea.** Scion and Graft key derived data by immutable content, with the
version in the key, so nothing ever needs invalidating. entire-graph caches
the committed tree only: after a security fix (its ADR 0004), working-tree
queries always rebuild.

**Step 1, measure.** Time `buildGraph` (`src/graph.ts`) on public
TypeScript repositories of about 5k, 20k and 45k script files. The graph
stops at `GRAPH_FILES_MAX = 50_000` files. Report the time spent parsing
and the time spent resolving imports separately.

**Continue only if** the graph takes over 10 s at 20k files.

**Step 2, cache.** Cache what each file's parse yields (its import
specifiers), keyed by (git blob id of the bytes, carveout version). Compute
the blob id from the bytes, as `gitBlobId` already does, so uncommitted
edits get their own keys and are never served stale. Run import resolution
again on every run. It depends on which other paths exist, so caching it
would need a key that every added or removed file invalidates. Store the
cache under `~/.carveout/graph` beside `types`.

**Pass.** A warm `plan` at 20k files is at least 3× faster than a cold one,
and its output is identical to a cold run's on every slice in
`slices.json`.

## Not pursued, and why

- **Fetching only changed objects, and tiered caches** (Scion's tiers,
  Graft's `GetObjects`, Entire's git-sync). carveout reads a local
  checkout and downloads no source; these belong to sandbox-factory's
  worker.
- **Checking cached objects against their ids** (Graft's cache tier). The
  only cache is `~/.carveout/types`, installed by npm, which already checks
  integrity.
- **entire-graph in place of carveout's graph.** carveout's graph is the
  TypeScript compiler's own module resolution, which is ground truth for TS
  imports. entire-graph's headline score is on LoCoMo, a test of finding
  details in long conversations; it says nothing about how accurate import
  edges are.
- **Landing without a queue, compare-and-swap refs, changeset logs, Trails,
  session capture.** These are for hosting and merging code, not for
  cutting it.
