# carveout

Hand one part of a closed TypeScript repository to an outside contractor as a slice that installs, builds and tests on its own, and take a checked patch back. Also checks a change made in the repository: what it reaches, the tests to run, and weakened tests or config edits. Optional hosted mode: after sign-in, a bundled MCP server works with the person's workspace on the Lunox platform (platform.lunox.work).

## Skills

- **carveout-gate**: Check a change that an agent or a person made in a TypeScript repository before calling it done. `carveout impact` lists the files the change reaches, the exports whose type changed and the files that take them, and one command per package that runs just the affected tests. `carveout gate` holds weakened, skipped or deleted tests, rewritten assertions, edited CI, tsconfig, linter or test-runner configuration, new mocks of the code's own module, new suppressions such as @ts-ignore, and files outside an allowed scope; it also runs as a Claude Code Stop hook. Neither runs the repository's code unless asked. Use when someone or an agent changed a TypeScript repository and wants to know what it breaks, which tests to run, or whether the change weakened a test to make it pass.

- **carveout**: Hand one part of a closed TypeScript repository to an outside contractor, contributor or untrusted agent, and take the work back, without showing them the rest. A slice is the files a change needs, at their repository paths, with every module it imports from the rest replaced by a .d.ts stub and a recording mock, so the folder installs, builds and tests on its own; a public one is written in pseudonyms. `handoff` cuts, checks and says whether the folder is ready, with a TASK.md of the work and when it is accepted; the work comes back as a patch that runs none of their code and holds CI, manifest and lockfile edits, tests bent to pass and new reach; `widen` and `refresh` keep a long job going. Use when someone wants to hand one part of a closed repository to someone outside it, cannot build the whole monorepo to change one part, wants to know what a file depends on and what depends on it, or wants a minimal reproduction of one module.

- **lunox-contribute**: Work on a task you were invited to on the Lunox platform as an outside contributor: fetch the version's public project, implement it within its editable paths, preview and submit the changed files, and read the verdict from hidden tests you never see. Use when someone has a Lunox contribution or claim link, mentions lnxc_ tokens or the /mcp/contribute server, or asks to submit work to a Lunox sandbox they do not own.

## Install

```sh
claude plugin marketplace add lunox-work/carveout
claude plugin install carveout@carveout
```

## Requirements

- **carveout-gate**: Node 22.12 or later, git and npm. Runs the carveout@0.5.0 CLI from npm.

- **carveout**: Node 22.12 or later, git and npm; Docker to run a returned folder's code. Runs the carveout@0.5.0 CLI from npm; online cuts read the npm registry.

- **lunox-contribute**: Needs the Lunox contributor MCP server (https://platform.lunox.work/mcp/contribute) signed in as a contributor, or an lnxc_ contributor token for HTTP clients, and Node to run the project.

## Hosted mode

The plugin bundles the `lunox` MCP server, Lunox's hosted platform at https://platform.lunox.work/mcp/carveout.
Claude Code signs in to it on first use (`/mcp`); signed out, the skills run locally as before.
Without the plugin: `claude mcp add --transport http lunox https://platform.lunox.work/mcp/carveout`; other MCP clients take the
same URL as a remote HTTP server.

## Links

- [Privacy](https://lunox.work/privacy/platform)
- [Documentation](https://github.com/lunox-work/carveout/blob/main/docs/REFERENCE.md)
- [Support](https://github.com/lunox-work/carveout/issues)

## Data

- **Sent off the machine:** an online cut asks registry.npmjs.org for the
  versions and type declarations of the public packages the slice imports
  (package names and versions only). `--offline` skips it. Nothing else is
  sent unless the person signs in (below); there is no telemetry.
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
- **The bundled `lunox` MCP server:** in Claude Code it talks to
  platform.lunox.work only once the person signs in to it through `/mcp`.
  Its read tools (`list_*`, `get_*`) read the account and the workspace, with
  its bounties, repositories, sandboxes and runs. Its write tools run only
  when the person asks for that action: a bounty posted (its title and text)
  or imported from a GitHub or Jira issue, a slice planned and cut from a
  repository already connected to the workspace, a sandbox version built, a
  contractor's changed files submitted for a verdict or graded again, a
  contributor invited to a published version, and a passing submission's
  files taken back. `upload_handoff` sends nothing: it answers the
  `carveout login` and `carveout handoff --platform` commands, which upload
  from the person's machine as above. `size_bounty`, `prepare` and `retry`
  start model runs on the platform that count against the workspace's monthly
  token limit. Confirming decisions, approving a price, acknowledging
  disclosure findings, publishing and merging back happen in the platform's
  web app, not through the plugin. The platform's privacy policy, which also
  covers this plugin and the MCP server, is at
  https://lunox.work/privacy/platform.
- **The `lunox-contribute` skill:** for a person invited to contribute, it
  talks to platform.lunox.work only through the contributor MCP server they
  add and sign in to themselves (`/mcp/contribute`), or their own `lnxc_`
  token: it reads the version they were invited to and submits the files they
  changed for a verdict.
- **Personal data:** a public cut reads the repository's Git `user.name` and
  `user.email`, with its package, owner and remote names, to replace them with
  pseudonyms. The table that maps them back is kept in the maintainer's
  receipt under `~/.carveout/receipts/` on the same machine.
- **Retention:** carveout itself runs no service and keeps nothing outside the
  folders it writes, that receipt, the upload records and, after `login`, the
  token. What the platform keeps after sign-in is governed by its privacy
  policy.

## Source

This branch holds only the plugin's files. The CLI, its documentation and the
skills' source are on the main branch of https://github.com/lunox-work/carveout. License: MIT.
