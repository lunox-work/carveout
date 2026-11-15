# Hosted mode

The `lunox` MCP server (`https://platform.lunox.work/mcp/carveout`, bundled in
the plugin's `.mcp.json`) works on the person's workspace on the Lunox
platform once they sign in to it through `/mcp`. The CLI signs in on its own
with `carveout login`, in the person's terminal. Never ask for a token in the
chat. Without either, carveout runs locally as before.

## Reads

`list_workspaces` first, then `list_bounties`, `get_bounty`, `get_proposal`,
`get_decisions`, `list_repositories`, `get_snapshot`, `list_sandboxes`,
`get_sandbox`, `get_run`, `get_handout` (public files, the hidden test count
and the commitment hash, never a hidden test), `get_verdict` and `get_usage`.

## Writes, each only when the person asks for it

- **A bounty:** `post_bounty`, `import_github_issue` or `import_jira_issue`
  (its board and numeric issue ids come from the web app, or `list_boards`
  and `search_issues` on the full `/mcp` server, which this one does not
  serve),
  then `size_bounty` (a paid model run). `get_decisions` reads what the priced
  spec decided where the ticket was silent; `confirm_link` is the page where
  the person confirms them. Approving the price is refused until they are
  confirmed (409 `decisions_unconfirmed`, with `confirmUrl`) and while the code
  is still being profiled (409 `profile_pending`; `price_changed` means reload
  and approve the new price).
- **A slice of a connected repository:** `plan_slice` (read the run with
  `get_run`). `carryTests`, on by default, carries the repository's own
  node:test tests of the slice into its versions as read-only public tests,
  those that pass on the untouched project, at most 20. Then `start_sandbox`,
  `cut_slice` with the approved proposal, and `prepare`, which writes the
  hidden tests from the confirmed spec and waits for a person while the
  decisions are unconfirmed (`decisions_unconfirmed`).
- **A hand-off from a repository the workspace has not connected:**
  `upload_handoff` with the bounty, the entry points and the acceptance tests
  sends nothing. It answers two commands: `carveout login --platform … --org
  …`, then `carveout handoff <entry>... --out … --accept <test>... --platform …
  --bounty …`. Run them in the person's checkout (the login opens a browser
  approval they make). The folder is cut, checked, renamed into pseudonyms and
  uploaded with the acceptance tests in its names; the receipt stays on the
  machine. Read the version with `get_sandbox` and its import run with
  `get_run`.
- **Verdicts:** `judge` (or `submit_patch`) sends each changed file whole and
  `get_verdict` reads it: `passed`, `incomplete`, `overfit` (only the failing
  scenarios' keys come back), `refused`. `retry` is a failed submission's one
  retry. `errored`, with `errorCode` (grading timed out, was interrupted or
  failed on the platform's side), is nobody's doing: `regrade` grades the same
  files again and spends no retry. `carryBack: "failed"` means it passed but
  does not carry back to the repository's names, so it is not merged back.
- **A contributor:** `create_contributor_invite` on the current published
  version answers a claim link shown once: give it to the person straight
  away. The contributor works through the `lunox-contribute` skill and its own
  server (below).
- **Taking the work back:** on an uploaded version, `carveout patch --from
  <submission id> --output change.patch` in the checkout that uploaded it. It
  checks the version's hidden suite is the acceptance tests uploaded from
  there (the handout's `hiddenSha256` at `hiddenSha256Version` 2; it says when
  it cannot compare), judges the files by the local receipt, and writes the
  patch in the repository's names; read all of it before anything runs it.
  `get_submission_files` gives the same files in the folder's names, and a
  generated (starter) version's at its own paths. A version sliced from a
  connected repository merges back by pull request, which an owner opens in
  the web app, optionally to merge once CI passes (`when: "ci_passes"`).

## A person's acts, in the web app

Confirming decisions, approving a price, approving a wide slice, acknowledging
each disclosure finding an uploaded or generated version's scan reports (its
publish is refused until an owner has), publishing, and merging back. Hand the
person the link; never act for them.

## Limits and errors

- Model runs (`size_bounty`, `prepare`, `retry`) count against the workspace's
  monthly model-token limit, and builds, imports and grading against its
  evaluator time; `get_usage` shows both. `quota_exceeded` names the `kind`
  and when it resets, `rate_limited` when to try again: tell the person, and
  never retry before then.
- A 409 with `retryable: true` kept what was sent: send the same files again
  after its `Retry-After`, a few times at most. `handoff --platform` does this
  itself.
- `carveout_too_old` (422) and a 426 name the `minimumVersion`: upgrade
  carveout and hand off again.
- `insufficient_scope`: the sign-in predates a scope the tool needs; the
  person signs in again (`/mcp`, or `carveout login`).
- `workspace_credential` / `contributor_credential`: the wrong kind of
  credential for the route; a contributor's `lnxc_` token reaches only
  `/mcp/contribute` and the contribution routes.

## Contributors

Someone invited to another workspace's version adds the contributor server
once, separate from `lunox`, and uses the `lunox-contribute` skill:

```sh
claude mcp add --transport http lunox-contribute https://platform.lunox.work/mcp/contribute
```

then `/mcp` signs in, choosing to sign in as a contributor.
