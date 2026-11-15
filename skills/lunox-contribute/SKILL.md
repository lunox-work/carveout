---
name: lunox-contribute
description: >-
  Work on a task you were invited to on the Lunox platform as an outside
  contributor: fetch the version's public project, implement it within its
  editable paths, preview and submit the changed files, and read the verdict
  from hidden tests you never see. Use when someone has a Lunox contribution or
  claim link, mentions lnxc_ tokens or the /mcp/contribute server, or asks to
  submit work to a Lunox sandbox they do not own.
license: MIT
compatibility: >-
  Needs the Lunox contributor MCP server
  (https://platform.lunox.work/mcp/contribute) signed in as a contributor, or
  an lnxc_ contributor token for HTTP clients, and Node to run the project.
---

# lunox-contribute

A workspace on the Lunox platform invited you to one published version of a
sandbox: a standalone project with a task, public tests you can run, and
hidden tests that judge your submission. You see that version's public
project and your own submissions, nothing else of the workspace, and never a
hidden test.

## Connect

- **Claim first.** The person opens the claim link they were given, signs in
  to Lunox and claims it. A link is shown to the workspace once; ask them for
  the link only if they have not claimed it yet, never for a token.
- **Claude Code:** the contributor server is separate from the `lunox`
  workspace server, so add it once:
  `claude mcp add --transport http lunox-contribute https://platform.lunox.work/mcp/contribute`,
  then `/mcp` signs in; on the consent page the person chooses to sign in as a
  contributor. Other MCP clients take the same URL as a remote HTTP server.
- **Headless clients** send `Authorization: Bearer lnxc_…`: a contributor
  token the person makes on the web app's Contributions page and puts in the
  client's configuration themselves. A workspace token (`lnx_…`) is refused
  here (`workspace_credential`), and a contributor token never reaches a
  workspace (`contributor_credential`).

## Work

1. `list_contributions`: each version you may work on, with its `versionId`
   and whether it still takes submissions.
2. `get_contribution` with that id: the task summary, the commands to install,
   build, test and run it, and the editable paths. `TASK.md` in the project
   holds the task in full, with its scenarios and rules.
3. `get_project_files`: write each file at `root`/`path`; `encoding: "utf8"`
   is text as is, `"base64"` is decoded bytes. Call it again with the page's
   `nextCursor` as `cursor` until `nextCursor` is null. A file marked
   `too_large` has no content here: download the whole project as a .zip from
   the Contributions page, or `GET /api/v1/contributions/<versionId>/archive`
   with the contributor token.
4. Work in that folder with the commands from step 2 (`npm ci`, `npm test`)
   until the public tests pass. Change only the editable paths (new `.ts`
   files beside them are allowed). Never edit `tests/`, `package.json`, the
   lockfile, `tsconfig.json`, `.npmrc` or any other config: the submission is
   refused for it.
5. `preview_submission` with every file you changed or added, each whole:
   it lists what would be submitted and each refusal by path, stores nothing
   and spends no attempt. Fix any refusal before you go on.
6. `submit` the same files, then poll `get_my_submission` (about every 30
   seconds) until it is no longer `queued` or `running`.

## The verdict

- `passed`: done; the workspace takes it from there.
- `incomplete`: a public test fails. `overfit`: the public tests pass and a
  hidden one does not; you get only the failing scenarios' keys. Re-read those
  scenarios in `TASK.md`, fix the code, then `preview_submission` with
  `retryOf` and `retry`. You have one first submission and one retry per
  version; a retry is not retried, and a passed submission has none.
- `refused`: each file's reason; fix what it names and retry.
- `errored`, with `errorCode` (grading timed out, was interrupted or failed
  on the platform's side): not your doing. `regrade` grades the same files
  again and spends no retry.
- `already_submitted` names your first submission: retry that one instead.
  `rate_limited` says when to try again: tell the person and wait, never loop.

A command-line client may instead POST the zipped project folder to
`/api/v1/contributions/<versionId>/submissions/zip` (`application/zip`,
`?dryRun=1` to preview) with the contributor token.
