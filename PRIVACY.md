# Privacy

carveout is a command-line tool and agent skill that runs on your machine. It
needs no account and sends no telemetry, and nothing it handles reaches its
authors unless you sign in to Lunox's hosted platform, which is optional
(below).

- **Sent off the machine:** an online cut asks registry.npmjs.org for the
  versions and type declarations of the public packages the slice imports
  (package names and versions only). `--offline` skips it. Nothing else is
  sent unless the person signs in (below); there is no telemetry.
- **Lunox platform, only after sign-in:** without an account the CLI is
  unchanged and local. `carveout login` signs in to Lunox's hosted service at
  platform.lunox.work with a code approved in the browser, and stores a
  workspace API token in `~/.lunox/credentials` on the same machine (mode 600,
  shared with duediligence); `logout` deletes it. `login`, `whoami`,
  `logout`, `handoff --platform` and `patch --from` are the only commands that
  talk to the platform. The CLI sends the token, its name and version, and,
  once at sign-in, the machine's host name to label the token.
  `handoff --platform` uploads the hand-off folder (public, in pseudonyms: the
  files a contractor would get) and the `--accept` tests renamed into the
  folder's names; never the receipt, its table, or source outside the slice.
  `patch --from` downloads a passing submission's changed files. What was
  uploaded is recorded in `~/.carveout/platform/` on the same machine.
- **The bundled `lunox` MCP server:** in Claude Code it talks to
  platform.lunox.work only once the person signs in to it through `/mcp`.
  Its read tools (`list_*`, `get_*`) read the account and the workspace, with
  its bounties, repositories, sandboxes and runs. Its write tools run only
  when the person asks for that action: a bounty posted or imported from a
  GitHub issue (its title and text), a slice planned and cut from a
  repository already connected to the workspace, a sandbox version built,
  and a contractor's patch submitted for a verdict. `size_bounty`, `prepare`
  and `retry` start model runs on the platform that count against the
  workspace's monthly token limit. Approvals, publishing and merging happen
  in the platform's web app, not through the plugin. The platform's privacy
  policy is at https://platform.lunox.work/privacy.
- **Personal data:** a public cut reads the repository's Git `user.name` and
  `user.email`, with its package, owner and remote names, to replace them with
  pseudonyms. The table that maps them back is kept in the maintainer's
  receipt under `~/.carveout/receipts/` on the same machine.
- **Retention:** carveout itself runs no service and keeps nothing outside the
  folders it writes, that receipt, the upload records and, after `login`, the
  token. What the platform keeps after sign-in is governed by its privacy
  policy.

Questions about this policy: open an issue at
https://github.com/lunox-work/carveout/issues.

Last updated 2026-11-14.
