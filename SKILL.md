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
carveout plan <entry>... [--depth N] [--max-files N]
```

It reads the import graph and runs nothing. It prints:

- the files the slice holds, each with its depth from the entry points;
- the modules that are cut (these become stubs and mocks);
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

Being at the file limit means the walk was cut short. Raise `--max-files`,
or narrow the entry points. `--json` gives the same report as data.

## 2. Cut

```sh
carveout cut <entry>... --out <empty folder> [--depth N] [--max-files N]
```

What the folder holds:

- The slice's files, copied at their repository paths.
- For each cut module: a `.d.ts` stub of what the slice uses, extracted with
  the compiler, beside a `.js` recording mock.
- `package.json` and `tsconfig.json`.
- `carveout/`: the mock runtime, the asset loader and an interface test.
- `BOUNDARY.md`, `carveout.json` and `carveout.env`.

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
  this applies to.

The rest of the cut's behaviour:

- **Imports.** Path aliases, workspace package imports and bundler-style
  extensionless imports are rewritten to the relative paths Node resolves.
  Each rewrite is recorded so `patch` can undo it.
- **Credentials.** The cut refuses a credentials file, and blocks on any
  credential it finds in what it writes. Neither is ever copied.
- **Network.** The cut reads package types from the public registry and
  resolves a lockfile. `--offline` skips both, and the folder then has no
  lockfile.
- **Literal types.** Stubs keep them as the source declares them.
  `--widen-literals` writes `string` in place of `"live"`. Use it when the
  folder goes to someone who should not see the constants of the modules it
  cuts. It does not hide the slice's own source.
- **Exit codes.** 0 means ready. 2 means the folder was written with
  blockers, which the cut prints and which `carveout.json` lists.

## 3. Check

```sh
carveout check <folder>
```

It runs `npm ci`, `npm run build` and `npm test` in a scratch copy of the
folder, and exits 0 only when all three pass. The test imports every module
that outside code imports from the slice, with the mocks in place. When a
package is missing at runtime, the check says which `--install` to cut again
with. Report the result to the person as it is. A failed step is not "mostly
working".

## 4. Work in the folder

Edit the slice's files there. To see what a mock was asked, or to make it
answer, import from `carveout/mock.js`:

- `recordedCalls()` lists the calls a mock received.
- `mockImplementation("module:<path>.<name>", fn)` installs behaviour for one
  value.

`npm run dev` runs `carveout/run.ts`, which loads each entry point. Replace
it to exercise the slice. Everything under `carveout/` is generated, as are
the stubs and the root configuration.

## 5. Patch

```sh
carveout patch <folder> --output change.patch
git apply change.patch      # at the repository's root
```

The patch holds:

- every edited slice file, with the import rewrites undone;
- every new file outside `carveout/`.

It leaves out edits to generated files and says so. It also warns when the
repository's copy moved since the cut; the patch is then against the commit
the cut read. Exit code 3 means there was nothing to patch.

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
