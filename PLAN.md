# Plan: hosted MCP in the plugin, and a library for sandbox-factory

Status: proposal, 2026-11-12. Delete this file when it lands. The platform
side is in `public/sandbox-factory/PLAN.md`; the phases below use its
numbering.

## 1. A library entry for sandbox-factory (its phase 3, slicing)

`src/core.ts` already re-exports the slice and project modules that were
forked from sandbox-factory's `packages/core` (`reach`, `manifest`,
`provenance`, `secrets`, `build`, `project`). Make that fork a supported
API, so the platform can consume it instead of keeping two copies in step.

- Add `"exports"` to `package.json`: `"./api"` pointing to
  `dist/src/api.js`, plus its types. `src/api.ts` exposes:
  - `plan({ root, entries, depth, withTests })`: included files, cuts,
    public surface and carried-test candidates, each with a runner or the
    reason it was refused. It writes nothing.
  - `cut({ root, entries, depth, out, withTests, copyPure, offline })`:
    the same folder and `carveout.json` as the CLI. `public` defaults to
    off here, because the platform applies its own alias table.
  - `patch({ receipt, folder })`: the import-rewrite reversal plus
    `handoffPolicy` refusals (`src/policy.ts`). It runs nothing from the
    folder.
  - `integrityOf`, `gainedIntegrity`, `weakenedTest` (`src/policy.ts`,
    `src/test-integrity.ts`) for the platform's submission checks.
- `./api` must never start Docker, spawn the folder's code or read
  `~/.carveout`. The receipt is passed in as data, so the platform can
  store it as a private artifact. Test this with a `node:test` file that
  imports `dist/src/api.js` and stubs `child_process`.
- Keep `typescript` pinned at 5.9.3. The worker pins the same version as
  `typescript-compiler`; a bump in either must happen in both.
- **Done when** sandbox-factory's worker writes a `slice-manifest.json`
  from `plan()` for its smoke fixture, and `patch()` round-trips an
  unchanged cut byte for byte.

## 2. The MCP server in the plugin (after the platform's phase 1 is live)

- Add `.mcp.json` at the repository root:

  ```json
  {
    "mcpServers": {
      "lunox": {
        "type": "http",
        "url": "https://platform.lunox.work/mcp/carveout"
      }
    }
  }
  ```

  Hosted tools (`plan_slice`, `cut_slice`, `download_slice`,
  `submit_patch`) work on repositories connected to sandbox-factory through
  its GitHub App. `impact` and `gate` stay local only.

- `scripts/skill.mjs`: add `.mcp.json` to `PLUGIN_FILES`, and have `check`
  validate it as duediligence's plan describes.
- **Data and privacy.** `data.md` and `PRIVACY.md` say "carveout runs no
  service", which would no longer be true. Add: the CLI is unchanged and
  local; the `lunox` server is Lunox's hosted service, used after sign-in;
  it reads connected repositories through the GitHub App; receipts and
  pseudonym tables stay on the platform; state retention; and a link to the
  platform's privacy policy.
- **`skills/carveout/SKILL.md`.** Hosted mode applies when the `lunox`
  tools are present and the repository is connected. Same order as local
  mode: plan → agree entries and depth with the person → cut → hand the
  `download_slice` URL to the contractor → `submit_patch` on the folder
  that came back → report the verdict as it is. Never pass a receipt
  through the conversation. `skills/carveout-gate` does not change.
- Bump to 0.2.0. Publish npm first, then pack, then the `plugin-branch`.
- **Done when** a plugin install from a local marketplace lists the `lunox`
  server, `plan_slice` answers for a connected repository, and the local
  CLI still passes `npm test` while signed out.

## 3. The CLI as a platform client (the platform's phases 5–6)

Local mode stays the default, and nothing below runs without `login`.

- `carveout login`, `logout` and `whoami` share `~/.lunox/credentials`
  with duediligence (device flow).
- `carveout handoff --platform --bounty <id>` cuts locally, as `handoff`
  does now, and uploads only the public folder, through
  `POST /orgs/:orgId/slices`. The receipt stays in `~/.carveout/receipts/`.
  This is for a workspace that will not connect its repository to GitHub.
  Cut with `--public` on, because the platform never sees the private
  names. The platform then aliases nothing further, builds, and lets
  duediligence write the hidden suite on the uploaded slice.
- `carveout patch --from <submission-id>` downloads a judged submission's
  returned folder and runs the same local `patch` with the local receipt
  (policy, reverse rewrites, pseudonyms back). Its output is the same as
  for a folder that came back by hand.
- `carveout plan --platform <repository>` prints the platform's
  `slice-plan` for a connected repository, in the same format as a local
  plan.
- HTTP: the published `@lunox-work/client` (fetch-only), or a vendored
  `src/platform.ts` if that adds unwanted weight. Send the CLI version and
  handle `426`.
- `data.md` and `PRIVACY.md`: `--platform` uploads the public folder only,
  never the receipt or source outside the slice.
- **Done when**, for a repository that is not connected,
  `handoff --platform` → contributor submission → `patch --from` gives the
  same patch as the manual hand-off, and the upload holds no name the
  receipt maps.
