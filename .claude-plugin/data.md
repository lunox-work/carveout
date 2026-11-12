- **Sent off the machine:** an online cut asks registry.npmjs.org for the
  versions and type declarations of the public packages the slice imports
  (package names and versions only). `--offline` skips it. Nothing else is
  sent unless the person signs in (below); there is no telemetry.
- **Lunox platform, only after sign-in:** without an account the CLI is
  unchanged and local. `carveout login` signs in to Lunox's hosted service at
  platform.lunox.work with a code approved in the browser, and stores a
  workspace API token in `~/.lunox/credentials` on the same machine (mode 600,
  shared with duediligence); `logout` deletes it. `login`, `whoami` and
  `logout` are the only commands that talk to the platform, and for now they
  only read the account and the workspace, sending the token, the CLI's name
  and version, and, once at sign-in, the machine's host name to label the
  token. No slice, receipt or source is uploaded. The platform's privacy
  policy is at https://platform.lunox.work/privacy.
- **Personal data:** a public cut reads the repository's Git `user.name` and
  `user.email`, with its package, owner and remote names, to replace them with
  pseudonyms. The table that maps them back is kept in the maintainer's
  receipt under `~/.carveout/receipts/` on the same machine.
- **Retention:** carveout itself runs no service and keeps nothing outside the
  folders it writes, that receipt and, after `login`, the token. What the
  platform keeps after sign-in is governed by its privacy policy.
