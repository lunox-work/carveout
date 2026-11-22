# carveout

Hand one part of a closed TypeScript repository to an outside contractor as a slice that installs, builds and tests on its own, and take a checked patch back. Also checks a change made in the repository: what it reaches, the tests to run, and weakened tests or config edits.

## Skills

- **carveout-gate**: Check a change that an agent or a person made in a TypeScript repository before calling it done. `carveout impact` lists the files the change reaches, the exports whose type changed and the files that take them, and one command per package that runs just the affected tests. `carveout gate` holds weakened, skipped or deleted tests, rewritten assertions, edited CI, tsconfig, linter or test-runner configuration, new mocks of the code's own module, new suppressions such as @ts-ignore, and files outside an allowed scope; it also runs as a Claude Code Stop hook. Neither runs the repository's code unless asked. Use when someone or an agent changed a TypeScript repository and wants to know what it breaks, which tests to run, or whether the change weakened a test to make it pass. Also `carveout map`, for "what has my agent seen, or read, in this repo": the lines its local logs show it read, as one page.

- **carveout**: Hand one part of a closed TypeScript repository to an outside contractor, contributor or untrusted agent, and take the work back, without showing them the rest. A slice is the files a change needs, at their repository paths, with every module it imports from the rest replaced by a .d.ts stub and a recording mock, so the folder installs, builds and tests on its own; a public one is written in pseudonyms. `handoff` cuts, checks and says whether the folder is ready, with a TASK.md of the work and when it is accepted; the work comes back as a patch that runs none of their code and holds CI, manifest and lockfile edits, tests bent to pass and new reach; `widen` and `refresh` keep a long job going. Use when someone wants to hand one part of a closed repository to someone outside it, cannot build the whole monorepo to change one part, wants to know what a file depends on and what depends on it, or wants a minimal reproduction of one module.

## Examples

- "Hand `src/billing/invoice.ts` to an outside contractor: cut a slice that
  installs, builds and tests on its own, with a task to add VAT rounding."
  The carveout skill plans the slice, cuts it into a folder with a TASK.md,
  and says whether it is ready to hand off.
- "The contractor sent back their folder. Check it and give me a patch I can
  apply." The carveout skill turns the work into a patch, holding CI,
  manifest and lockfile edits and tests bent to pass.
- "My agent changed `packages/api`. What does the change reach, which tests
  should I run, and did it weaken any test?" The carveout-gate skill runs
  `impact` and `gate` and reports the files reached, the tests to run and any
  weakened test or config edit.

## Install

```sh
claude plugin marketplace add lunox-work/carveout
claude plugin install carveout@carveout
```

## Requirements

- **carveout-gate**: Node 22.12 or later, git and npm. Runs the carveout@0.5.0 CLI from npm.

- **carveout**: Node 22.12 or later, git and npm; Docker to run a returned folder's code. Runs the carveout@0.5.0 CLI from npm; online cuts read the npm registry.

## Links

- [Privacy](https://lunox.work/privacy/platform)
- [Terms](https://lunox.work/terms)
- [Documentation](https://github.com/lunox-work/carveout/blob/main/docs/REFERENCE.md)
- [Support](https://github.com/lunox-work/carveout/issues)

## Data

- **No MCP server:** the plugin bundles no MCP server; its skills run the
  CLI on the machine, and installing it asks for no sign-in.
- **Sent off the machine:** an online cut asks registry.npmjs.org for the
  versions and type declarations of the public packages the slice imports
  (package names and versions only). `--offline` skips it. Nothing else is
  sent unless the person signs in (below); there is no telemetry.
- **`carveout map`** reads Claude Code's and Codex's session logs on the same
  machine (`~/.claude/projects`, `~/.codex/sessions`) and the repository's file
  list, and writes one HTML file there: paths, line counts and line ranges,
  never file contents. It sends nothing; `--png` renders the share card with a
  local browser.
- **Lunox platform, only after sign-in:** without an account the CLI is
  unchanged and local. `carveout login` signs in to Lunox's hosted service at
  platform.lunox.work with a code approved in the browser, and stores a
  workspace API token in `~/.lunox/credentials` on the same machine (mode 600,
  shared with bouncer); `logout` deletes it. `login`, `whoami`,
  `logout`, `handoff --platform` and `patch --from` are the only commands that
  talk to the platform. The CLI sends the token, its name and version, and,
  once at sign-in, the machine's host name to label the token.
  `handoff --platform` uploads the hand-off folder (public, in pseudonyms: the
  files a contractor would get) and the `--accept` tests renamed into the
  folder's names; never the receipt, its table, or source outside the slice.
  `patch --from` downloads a passing submission's changed files and reads the
  version's handout (its public file list and the hidden suite's hash). What
  was uploaded is recorded in `~/.carveout/platform/` on the same machine,
  with the hash of the acceptance tests as uploaded.
- **Personal data:** a public cut reads the repository's Git `user.name` and
  `user.email`, with its package, owner and remote names, to replace them with
  pseudonyms. The table that maps them back is kept in the maintainer's
  receipt under `~/.carveout/receipts/` on the same machine.
- **Retention:** carveout itself runs no service and keeps nothing outside the
  folders it writes, that receipt, the upload records and, after `login`, the
  token. What the platform keeps after sign-in is governed by its privacy
  policy, at https://lunox.work/privacy/platform.

## Source

This branch holds only the plugin's files. The CLI, its documentation and the
skills' source are on the main branch of https://github.com/lunox-work/carveout. License: MIT.
