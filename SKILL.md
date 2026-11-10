---
name: carveout
description:
  Carve a slice out of a TypeScript repository or monorepo into a standalone
  folder: the files a change needs, copied at their
  repository paths, with every module it imports from the rest of the
  repository replaced by a .d.ts stub and a recording mock, so the folder
  installs, builds and tests on its own; then turn the edits made there back
  into a patch for the repository. Use when someone wants to work on, hand
  off, review, test or give an agent one part of a large repository or
  monorepo without the rest of it, wants to know what a file or folder
  depends on and what depends on it, or wants a minimal reproduction of one
  module.
---

# carveout

`carveout <command>` is the CLI: on PATH after `npm i -g carveout`, otherwise
`npx -y carveout`, or `node dist/src/cli.js` from this skill's folder after
`npm install && npm run build`. Node 22.12 or later, and `git` and `npm` on
PATH.

Run it from the repository's root, or pass `--repo <root>`: the root is where
the lockfile and the workspace manifest are, so workspace packages resolve to
their source. Entry points are files or directories relative to the root.

## 1. Plan

```sh
carveout plan <entry>... [--depth N] [--max-files N] [--with-tests]
              [--whole-package] [--follow-workspaces] [--private <path>]...
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
  computed name, a credentials file.

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
Vitest. A test that reaches a slice module through a barrel outside the
slice counts; the barrel comes along at the depth of what it forwards, its
other re-exports cut. Each test brings its own helpers too: what it imports
at runtime from its package, or from a test folder anywhere, so a fake is
copied rather than stubbed (a stubbed fake fails the test before any
change). The plan lists them, and lists as left behind the tests on other
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
- `--private <path>`: a file, folder or glob never copied; stubbed wherever
  reached, its literal values widened. The plan names what it kept out.

The repository's owner can set all three, with `copy` and `widenLiterals`,
once in `carveout.config.json` at the root; a flag overrides a boolean,
lists are joined. Read it before proposing flags: it says what the owner
allows a slice to hold.

## 2. Cut

```sh
carveout cut <entry>... --out <empty folder> [--depth N] [--max-files N] [--with-tests]
             [--whole-package] [--follow-workspaces] [--private <path>]...
             [--copy <dir>]... [--mock <pkg>]... [--install <pkg>]... [--live <pkg>]...
             [--widen-literals] [--public] [--offline]
```

What the folder holds:

- The slice's files, copied at their repository paths.
- For each cut module: a `.d.ts` stub of what the slice uses, extracted with
  the compiler, beside a `.js` recording mock.
- `package.json` and `tsconfig.json`.
- `carveout/`: the mock runtime, the asset loader and an interface test.
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
place. With `--with-tests`, `npm test` then runs the slice's own tests: the
`node:test` ones with Node, the Vitest ones with `vitest run`. If Vitest
was mocked (no lockfile), the cut reports `test_runner_mocked`; cut again
with `--install vitest`. When a
package is missing at runtime, the check says which `--install` to cut again
with. Report the result to the person as it is. A failed step is not "mostly
working". `--isolated`, for a folder that came back from someone else,
gives it a scratch HOME and npm cache and no install scripts; it is not a
sandbox, so run an untrusted folder's tests in CI or a container instead.

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
  `carveout.config.json`); a deleted test. Show the person the list;
  `--allow <path|glob>` carries one they reviewed.

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
--public` (with `--with-tests --whole-package` so the folder's tests
exercise real code), `check`, hand the folder over. When it comes back,
`patch` from the repository's root, show the refusals, and apply the
patch on a branch for a pull request. Tell the maintainer plainly: the
slice's tests ran against mocks, a test that needed `carveout/` did not
come back, and the repository's CI is what decides.

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
  package.json files.
