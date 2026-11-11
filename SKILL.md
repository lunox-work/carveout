---
name: carveout
description:
  Hand one part of a closed TypeScript repository to an outside
  contractor, and take the work back, without showing them the rest. A
  slice is the files a change needs, copied at their repository paths, with
  every module it imports from the rest replaced by a .d.ts stub and a
  recording mock, so the folder installs, builds and tests on its own; its
  edits come back as a patch that runs none of their code and holds CI,
  manifest and lockfile edits and weakened tests. Also, for a change made
  in the repository itself: `impact` lists the files it reaches, the
  exports whose type changed and who takes them, and the tests to run;
  `gate` holds weakened or deleted tests, CI and config edits, and new
  suppressions. Use when someone wants to hand one part of a closed
  repository to a contractor, contributor or untrusted agent, cannot build
  the whole monorepo to change one part, wants to know what a file depends
  on and what depends on it, or wants a minimal reproduction of one module;
  or when someone or an agent changed a TypeScript repository and wants to
  know what it breaks, which tests to run, or whether it weakened a test.
---

# carveout

`carveout <command>` is the CLI: on PATH after `npm i -g carveout`, otherwise
`npx -y carveout`, or `node dist/src/cli.js` from this skill's folder after
`npm install && npm run build`. Node 22.12 or later, and `git` and `npm` on
PATH.

Run it from the repository's root, or pass `--repo <root>`: the root is where
the lockfile and the workspace manifest are, so workspace packages resolve to
their source. Entry points are files or directories relative to the root.

## 0. A change in the repository: impact and gate

```sh
carveout impact [<file>...] [--base <ref>] [--depth N] [--run] [--json]
carveout gate [--base <ref>] [--scope <path>]... [--allow <path>]... [--hook] [--json]
```

Both read the change from Git, the base (default `HEAD`) against the working
tree, untracked files included; `impact` with files named starts from those
instead. Neither runs the repository's code, but for `impact --run`.

`impact` prints the changed exports (type at the base and now, and the
files that take each), the importers nearest first, the tests among them
with their runner, and one command per package that runs just those tests.
Report all of it. A changed export with files that take it is the first
thing to check: those files may no longer compile. Run the tests with
`--run` (exit 2 if a command fails) when the person agrees; they run in the
repository with the person's environment. A runner it does not know falls
back to the package's whole `npm test`, which the output marks. It traces
imports and names, not runtime: say so when you report a clean result.

`gate` exits 6 and lists each hold with why: protected paths, edited check
configuration (tsconfig, linter, test runner), deleted tests, helpers or
fixtures, assertions removed, rewritten, skipped, focused with `.only`,
made unreachable, put under a new condition or swallowed by a `catch`, a
test's data, setup or helpers rewritten, a new mock of the code's own
module, code that could pass a test without the code passing it (an early
`process.exit`, swallowed failures, a rewritten assertion library, code
under test that tells a test run from a real one or rewrites a built-in),
new suppressions (`@ts-ignore`, `eslint-disable`, coverage ignores), and
with `--scope`, files outside it. Run it before you
call a change done. Undo a hold the task did not ask for; keep one the
task did ask for (the behaviour an assertion held was meant to change),
and name it in your reply. `--allow` is for the person, after they have
read the file. `--hook` is for a Claude Code Stop hook: exit 2 with the
holds on stderr, once per stop.

## 1. Plan

```sh
carveout plan <entry>... [--depth N] [--max-files N] [--with-tests]
              [--whole-package] [--follow-workspaces] [--copy-pure]
              [--private <path>]...
```

It reads the import graph and runs nothing. It prints:

- the files the slice holds, each with its depth from the entry points;
- the files the file budget left out, when it ran out;
- the modules that are cut (these become stubs and mocks), marked
  `types only` when the slice imports nothing else from them;
- the files outside the slice that import it;
- the packages it imports, with the repository's own packages marked;
- the services and environment variables it reads;
- its blockers: an import that resolves to no file, a dynamic import of a
  computed name, a credentials file;
- `Shows`: the lines the cut copies, by why (entry points, depth, whole
  package, pure code, tests and what they bring). Show it to the person
  before a public cut: it is what the contributor reads;
- `Source from outside the entry points`: that code by folder, with its
  lines, tests not counted. Ask the person about each folder before a
  public cut, and add `--private <path>` for any that must stay closed;
- `Tests:`: whether any test in the folder runs the code, and every test
  that does and stays in the repository, with why (not asked for, another
  package's, Jest, reads what no slice carries, the file limit). With none
  in the folder, a pass means it builds and keeps its exports.

The defaults are depth 3 and 40 files. Choose the budget with the person:

- `--depth 0`: only the entry points.
- `--depth 1`: the entry points and what they import directly. This is
  usually enough for one change.
- More depth means more real code and fewer mocks.

Depth counts imports of code. Going through a barrel's re-export does not
add depth, and only the module that declares an imported name comes along,
not the barrel's other modules. A module the slice imports only types from
is always cut to a stub.

When the file limit is reached, the plan lists the files it left out. Raise
`--max-files`, or narrow the entry points. `--json` gives the same report as
data.

`--with-tests` also brings the test files outside the slice that import it
(`*.test.*`, `*.spec.*`, `__tests__/`), when they run on `node:test` or
Vitest (imported, or its globals in a package on Vitest and not Jest). A
test that reaches a slice module through barrels outside the slice, a chain
of them included, counts; each barrel comes along at the depth of what it
forwards, its other re-exports cut. Each test brings its own helpers too: what it imports
at runtime from its package, or from a test folder anywhere, so a fake is
copied rather than stubbed (a stubbed fake fails the test before any
change). When the file budget cannot hold every test, the ones that take
names the entry points declare come first, ahead of tests that take a name
declared further out through the same barrel. The plan lists them, and lists as left behind the tests on other
runners, and those that make an import no slice can carry: a computed
dynamic import, or one that resolves to no file.

Three options move the cut from the hop count to the package. Prefer them
when the plan shows sibling modules or workspace packages cut, or the check
leaves tests failing on the mocks:

- `--whole-package`: every file of the entry points' package the imports
  reach comes along at any depth; the cut falls at the package's edge and
  at service packages. Imports into other packages still stop at `--depth`.
- `--follow-workspaces`: an import of one of the repository's own packages
  is followed into its source, copied or cut like a file, instead of the
  package being stubbed whole at the seam. It copies the lower layers of
  the repository, so pair it with `--private`.
- `--copy-pure`: the pure code the slice runs (a validator, an error
  class, a formatter, in any package) is copied instead of mocked, so the
  tests that use it pass before any change. Pure means nothing its runtime
  imports reach imports a service SDK or Node's disk, network or process
  modules, reads the environment or a path, or is private; through a
  barrel, only the modules that supply the names. It follows the
  workspaces too. The plan lists what it copies: the person reads it.
- `--private <path>`: a file, folder or glob never copied; stubbed wherever
  reached, its literal values widened. The plan names what it kept out.

The repository's owner can set these, with `copy`, `widenLiterals` and `copyPure`,
once in `carveout.config.json` at the root; a flag overrides a boolean,
lists are joined. Read it before proposing flags: it says what the owner
allows a slice to hold.

## 2. Cut

```sh
carveout cut <entry>... --out <empty folder> [--depth N] [--max-files N] [--with-tests]
             [--whole-package] [--follow-workspaces] [--copy-pure] [--private <path>]...
             [--copy <dir>]... [--mock <pkg>]... [--install <pkg>]... [--live <pkg>]...
             [--widen-literals] [--public] [--offline]
```

What the folder holds:

- The slice's files, copied at their repository paths.
- For each cut module: a `.d.ts` stub of what the slice uses, extracted with
  the compiler, beside a `.js` recording mock.
- `package.json` and `tsconfig.json`.
- `carveout/`: the mock runtime, the asset loader, an interface test, and
  `surface/`: the declarations of every export outside code uses, as they
  were at the cut, with the type check `npm test` holds them to.
- `BOUNDARY.md`, an index of the stubbed modules and the public surface
  (the declarations are in the stubs), `carveout.json` and `carveout.env`.
- With `--copy <dir>`, the folder's files beside the slice: what the code
  reads by a name the walk cannot follow, such as `packages/db/drizzle`.
  They are the repository's files, so an edit to one is in the patch, and a
  `path_read` of the folder is no blocker.

How packages are handled:

- Packages the repository installs from the public registry are pinned at
  the versions its package.json files give, along with their `@types` and
  their required peers.
- Service SDKs (Stripe, AWS, databases, HTTP clients, LLM SDKs) become mock
  packages, as do packages from a private registry and the repository's own
  workspace packages.
- `--mock <pkg>` and `--install <pkg>` override the default.
  `--install <pkg>` also adds a package the slice does not import, at the
  version the repository's lockfile has. The cut prints the optional peers
  this applies to. A service package whose class a carried test patches by
  prototype (`S3Client.prototype.send = ...`) is installed without being
  asked, and the cut says so: a mock has no prototype to patch, and such a
  test never reaches the service.
- `--live <pkg>` keeps a service package real: installed and typed as the
  repository has it, and the environment the files that import it read is
  left out of `carveout.env`, so the shell's values or the code's own
  defaults apply. Use it when the package's tests need the service itself
  (a database driver against a local server) and the person has it
  running; the folder's README then says so. Otherwise the tests of such a
  package fail on the mock before any change, and `npm test` can only
  report them as the baseline.

The rest of the cut's behaviour:

- **Imports.** Path aliases, workspace package imports and bundler-style
  extensionless imports are rewritten to the relative paths Node resolves.
  So are modules named to `vi.mock`, `jest.mock` and `require.resolve`.
  Each rewrite is recorded so `patch` can undo it.
- **Files read by path.** A file the slice reads with
  `new URL("./x", import.meta.url)` or `join(__dirname, "x")` is copied.
  A folder read that way, or such a file outside the budget, is a
  `path_read` blocker.
- **Credentials.** A credentials file, or a credential in anything the
  cut would write (a `--copy` folder and the resolved lockfile included),
  stops the cut with exit 1 and nothing written. Tell the person which
  file and line it names; never work around it.
- **Network.** The cut reads package types from the public registry and
  resolves a lockfile. `--offline` skips both, and the folder then has no
  lockfile.
- **Literal types.** Stubs keep them as the source declares them.
  `--widen-literals` writes `string` in place of `"live"`. Use it when the
  folder goes to someone who should not see the constants of the modules it
  cuts. A constant the stub reads as a type (`(typeof KINDS)[number]`)
  keeps its name-like strings, the type's members. It does not hide the
  slice's own source.
- **Someone outside.** `--public` (or `"public": true` in the
  configuration) is for a folder handed to someone outside the
  repository: literals widened, and neither the checkout's path or folder
  name nor the files outside the slice that import it written. Commands that need the
  repository then take `--repo` (default: the current directory).
- **Exit codes.** 0 means ready. 2 means the folder was written with
  blockers, which the cut prints and which `carveout.json` lists.

## 3. Check

```sh
carveout check <folder> [--isolated]
```

It runs `npm ci`, `npm run build` and `npm test` in a scratch copy of the
folder, and exits 0 only when all three pass. The interface test imports
every module that outside code imports from the slice, with the mocks in
place, and `npm test` type-checks `carveout/surface/check.ts`: an export
outside code uses whose type changed fails as `<module> keeps the type of
<name>`, with the compiler's message. With `--with-tests`, `npm test` then runs the slice's own tests: the
`node:test` ones with Node, the Vitest ones with `vitest run`. If Vitest
was mocked (no lockfile), the cut reports `test_runner_mocked`; cut again
with `--install vitest`. When a
package is missing at runtime, the check says which `--install` to cut again
with. Report the result to the person as it is. A failed step is not "mostly
working". `--isolated`, for a folder that came back from someone else,
gives it a scratch HOME and npm cache and no install scripts; it is not a
sandbox, so run an untrusted folder's tests in a container with no
secrets and no network instead. A branch pushed to the repository is not
that: its CI has the repository's secrets and network.

`npm test` in a checked folder reports in short: the counts, then in full
only the failures that are not the baseline's, with the baseline's number.
Read it as it is; there is nothing more in `carveout/test.js`.

The first check of an unedited folder records the tests that fail with
nothing changed: they fail on the mocks, because they need the real
behaviour of a module the slice cuts. They go in `carveout/baseline.json`,
and the check reports them. From then on `npm test` names them but does
not count them, and still fails on any other test, on the coverage gate,
or on the build. Tell the person how many there are.

`npm test` finds the folder's tests when it runs, so tests written after
the cut run too. When the package's own test sets coverage thresholds
(`--test-coverage-lines` and the like), it holds the source files added
after the cut to them. It loads each such file, so one no test imports
counts as uncovered. When coverage falls short, `npm test` says so in a line
of its own. When the package's script also runs `assert-all-covered`, a
source file added under the package that no test loads fails `npm test`,
which names it, as the repository's script would. A test added where the
package's script would not run it (the script's `--test` pattern, such as
`test/*.test.ts`) fails `npm test`, which names it to move, because in the
repository it would cover nothing.

## 4. Work in the folder

Edit the slice's files there. To see what a mock was asked, or to make it
answer, import from `carveout/mock.js`:

- `recordedCalls()` lists the calls a mock received.
- `mockImplementation("module:<path>.<name>", fn)` installs behaviour for one
  value.

`npm run dev` runs `carveout/run.ts`, which loads each entry point. Replace
it to exercise the slice. Everything under `carveout/` is generated, as are
the stubs and the root configuration.

## 5. Status

```sh
carveout status <folder>
```

It makes the cut again in memory, from the request `carveout.json`
records, and compares every file it would write with what the folder
holds. It writes nothing. It prints `current` and exits 0, or prints what is
stale and exits 4. The causes it names:

- a slice file that changed, or one the walk now reaches or no longer does;
- a cut module whose declarations changed, naming the symbols added,
  removed or changed;
- generated configuration and boundary files.

A change only to a cut module's function bodies leaves its stub, and so the
folder, current. Status takes about as long as a cut. Use it to learn what
moved before deciding to cut again, not to save the time of a cut.

## 6. Patch

```sh
carveout patch <folder> [--repo <checkout>] [--allow <path|glob>]... --output change.patch
git apply change.patch           # at the repository's root
git apply --3way change.patch    # when patch says files moved since the cut
```

The patch holds:

- every edited slice file, and every deleted one;
- every new file outside `carveout/`, without what `npm run build` wrote
  beside it.

Imports come back as the repository writes them. The cut's rewrites are
undone. A new import is spelled the way the slice already names its target
(an alias, a workspace package), or else as a relative path in the
package's own extension style. A new import across packages that nothing
names is restored as a relative path, and `patch` says so.

It leaves out, and names:

- **Boundary edits** (exit code 5): an edit to a stub or a mock, or a
  dependency added to the folder's package.json. The change needs more
  than the slice holds, so the patch alone is short of it. Cut again with
  more entries, or make that part of the change in the repository.
- **Slice-only files**: a new or edited file that imports `carveout/`,
  such as a test against the mocks. The repository has no `carveout/`.
- Edits to other generated files.
- **What the hand-off policy refuses** (exit code 6): a new file outside
  the packages the slice holds files of; a protected path (CI workflows,
  hooks, `.vscode`, `.devcontainer`, `package.json`, lockfiles, `.npmrc`,
  `.env*`, Dockerfiles, Makefiles, `*.sh`, `CODEOWNERS`,
  `carveout.config.json`); a deleted test, helper or fixture; an edited
  test that removes or rewrites an assertion, skips or focuses (`.only`) a
  test, leaves an assertion unreachable, under a new condition or in a
  `catch` that swallows it, rewrites the data, setup or helpers its
  assertions rest on, or mocks the code's own module; an edited fixture; a
  script that gains a way to pass a test without the code (an early
  `process.exit`, swallowed failures, a rewritten assertion library, code
  under test that detects the test runner or rewrites a built-in); new
  suppressions or edited check configuration; a script, new or edited,
  that gains a reach it did not have (Node's disk, network or process
  modules, a service SDK, `fetch`, `eval`, `Function` also through
  `.constructor`, the environment, a module loaded from a URL, a module or
  global named by a computed value or hidden behind one). Show the person
  the list; `--allow <path|glob>` carries one they reviewed.

`patch` runs none of the folder's code and takes nothing in it on trust: a
`carveout.json` that names a path outside the folder is refused, and the
repository is the one given with `--repo` (else the record's), which must
hold the cut's commit.

Its `index` lines carry the full blob ids of the cut commit's files. When a
file moved since the cut, `patch` says so: apply with `git apply --3way`,
which merges against that commit. In the experiments, plain apply carried
27% of such patches and `--3way` 89%. A file cut from uncommitted changes
has no blob to merge against, and `patch` names it. Exit code 3 means there
was nothing to patch. `--json` prints the lists with the diff.

## 7. Merge and apply

```sh
carveout merge <folder> --into <checkout> --verify "npm test" [--verify-env <name>]... [--allow <path>]...
carveout apply <folder> upstream.patch [--stubs] [--repo <checkout>]
```

`merge` runs `patch`, then `git apply --3way` in the checkout you name,
then the verify command at its root. It reports each step, and exits 2 when
one fails, 6 (applying nothing) when the hand-off policy refuses a path.
The verify command gets a scratch HOME and only the variables named with
`--verify-env`. It never picks a checkout itself. Name a clean clone, or
the person's own checkout only when they ask.

## 8. Someone outside the repository

To let a contributor work on one part of a closed repository: `plan`,
agree the entries and `--private` paths with the maintainer, `cut
--public` (with `--with-tests --whole-package --copy-pure` so the folder's
tests exercise real code rather than mocks; drop `--copy-pure`, or mark
that code `--private`, where it must stay closed), `check`, hand the
folder over. When it comes back,
`patch` from the repository's root, show the refusals, and have the
maintainer read the whole patch, with `carveout impact --base HEAD` after
applying it on a branch (it runs nothing) for the importers and tests the
contributor never saw, before anything runs it: its tests and new
files (a runner config among them) are code that runs beside the closed
repository, and the policy reads their reach, not their intent. Then apply it on a branch
for a pull request. Tell the maintainer plainly: the slice's tests ran
against mocks, a test that needed `carveout/` did not come back, and the
repository's CI is what decides, once the patch has been read.

`apply` goes the other way: a patch for the repository at the cut's commit
comes into the folder, with its imports rewritten as a cut writes them. It
lists the paths outside the slice, which it does not apply, and the stubs
the change needs from cut modules. `--stubs` writes those stubs and their
mocks; without it, it exits 5 when some are needed. `patch` afterwards
gives back the slice's part of the change.

## Limits

- **Languages.** Only TypeScript is extracted into stubs. A slice that
  includes JavaScript sources is cut and written, but reports
  `language_unsupported`. Other languages are not sliced.
- **Inferred types.** A stub can be narrower than the source when a type is
  inferred from a package the cut could not read. The cut reports this as
  `partial` coverage or `compile_error`.
- **Bundler-only runtime.** Under Node, `import.meta.env` reads
  `carveout.env`. Lazy globs and globs of assets work, but an eager
  `import.meta.glob` of modules finds nothing.
- **Lockfiles.** Peers and `--install` versions are read from an npm
  `package-lock.json`. With pnpm or Yarn, versions come from the
  package.json files, a `catalog:` pin from the workspace's catalog; a pnpm
  entry with no tarball URL counts as public when its integrity matches the
  public registry's (online cuts).
- **Test runners.** `node:test` and Vitest; a Jest test is left behind and
  named. `impact` also names Jest tests and runs them with Jest.
- **`impact` traces imports, not runtime.** A module loaded by a computed
  name, a file read by path or configuration a test reads is not traced.
  Inside a module it follows the identifiers each top-level statement
  names, erring toward more.
