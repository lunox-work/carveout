# Privacy

carveout is a command-line tool and agent skill that runs on your machine. Its
authors run no service for it: there is no account, no server and no
telemetry, and nothing it handles reaches the authors.

- **Sent off the machine:** an online cut asks registry.npmjs.org for the
  versions and type declarations of the public packages the slice imports
  (package names and versions only). `--offline` skips it. Nothing else is
  sent; there is no telemetry.
- **Personal data:** a public cut reads the repository's Git `user.name` and
  `user.email`, with its package, owner and remote names, to replace them with
  pseudonyms. The table that maps them back is kept in the maintainer's
  receipt under `~/.carveout/receipts/` on the same machine.
- **Retention:** carveout runs no service and keeps nothing outside the
  folders it writes and that receipt.

Questions about this policy: open an issue at
https://github.com/lunox-work/carveout/issues.

Last updated 2026-11-12.
