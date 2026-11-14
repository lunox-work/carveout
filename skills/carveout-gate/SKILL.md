---
name: carveout-gate
description: >-
  Check a change that an agent or a person made in a TypeScript repository
  before calling it done. `carveout impact` lists the files the change reaches,
  the exports whose type changed and the files that take them, and one command
  per package that runs just the affected tests. `carveout gate` holds weakened,
  skipped or deleted tests, rewritten assertions, edited CI, tsconfig, linter or
  test-runner configuration, new mocks of the code's own module, new
  suppressions such as @ts-ignore, and files outside an allowed scope; it also
  runs as a Claude Code Stop hook. Neither runs the repository's code unless
  asked. Use when someone or an agent changed a TypeScript repository and wants
  to know what it breaks, which tests to run, or whether the change weakened a
  test to make it pass.
license: MIT
compatibility: >-
  Node 22.12 or later, git and npm. Runs the carveout@0.4.1 CLI from npm.
---

# carveout-gate

What a change made in the repository reaches, and whether it weakened the checks
that would catch it. To hand a part of the repository to someone outside it
instead, use the `carveout` skill.

`carveout <command>` is the CLI, `carveout@0.4.1`. When `carveout --version`
prints another version or nothing, ask the person before installing it:
`npm i -g carveout@0.4.1`, or put `npx carveout@0.4.1` in place of `carveout` in
each command (in a clone of the repository, `node dist/src/cli.js` after
`npm install && npm run build`). Node 22.12 or later, and `git` and `npm` on
PATH.

Run it from the repository's root, or pass `--repo <root>`.

```sh
carveout impact [<file>...] [--base <ref>] [--depth N] [--run] [--json]
carveout gate [--base <ref>] [--scope <path>]... [--allow <path>]... [--hook] [--json]
```

Both read the change from Git, the base (default `HEAD`) against the working
tree, untracked files included; `impact` with files named starts from those
instead. Neither runs the repository's code, but for `impact --run`.

`impact` prints the changed exports (type at the base and now, and the files
that take each), the importers nearest first, the tests among them with their
runner, and one command per package that runs just those tests. Report all of
it. A changed export with files that take it is the first thing to check: those
files may no longer compile. Run the tests with `--run` (exit 2 if a command
fails) when the person agrees; they run in the repository with the person's
environment. A runner it does not know falls back to the package's whole
`npm test`, which the output marks. It traces imports and names, not runtime:
say so when you report a clean result.

`gate` exits 6 and lists each hold with why: protected paths, edited check
configuration (tsconfig, linter, test runner), deleted tests, helpers or
fixtures, assertions removed, rewritten, skipped, focused with `.only`, made
unreachable, put under a new condition or swallowed by a `catch`, a test's data,
setup or helpers rewritten, a new mock of the code's own module, code that could
pass a test without the code passing it (an early `process.exit`, swallowed
failures, a rewritten assertion library, code under test that tells a test run
from a real one or rewrites a built-in), new suppressions (`@ts-ignore`,
`eslint-disable`, coverage ignores), and with `--scope`, files outside it. Run
it before you call a change done. Undo a hold the task did not ask for; keep one
the task did ask for (the behaviour an assertion held was meant to change), and
name it in your reply. `--allow` is for the person, after they have read the
file. `--hook` is for a Claude Code Stop hook: exit 2 with the holds on stderr,
once per stop.

As a Claude Code Stop hook, when the person asks for one: show them this entry
for `.claude/settings.json`, with the version they installed, and add it only
once they agree. Never change their settings unasked.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "carveout gate --hook" }]
      }
    ]
  }
}
```

## Limits

- **Test runners.** `node:test`, Vitest and Jest tests are named and run with
  their runner; another runner falls back to the package's whole `npm test`.
- **`impact` traces imports, not runtime.** A module loaded by a computed name,
  a file read by path or configuration a test reads is not traced. Inside a
  module it follows the identifiers each top-level statement names, erring
  toward more.
