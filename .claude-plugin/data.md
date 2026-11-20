- **No MCP server:** the plugin bundles no MCP server; its skills run the
  CLI on the machine, and installing it asks for no sign-in.
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
- **Personal data:** a public cut reads the repository's Git `user.name` and
  `user.email`, with its package, owner and remote names, to replace them with
  pseudonyms. The table that maps them back is kept in the maintainer's
  receipt under `~/.carveout/receipts/` on the same machine.
- **Retention:** carveout itself runs no service and keeps nothing outside the
  folders it writes, that receipt, the upload records and, after `login`, the
  token. What the platform keeps after sign-in is governed by its privacy
  policy, at https://lunox.work/privacy/platform.
