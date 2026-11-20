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
