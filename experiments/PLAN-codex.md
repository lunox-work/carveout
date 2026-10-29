# Codex pilot for the slice benchmark

Recorded before the pilot runs. This is a separate experiment from the
pre-registered Claude E6a. The existing confirmed specs and calibrated
hidden suites are used unchanged.

- Model: `gpt-6.1-sol`, reasoning effort `high`, in independent Codex CLI
  sessions. The installed CLI version is recorded with the run.
- Pilot: handles and jira-spec, one run each in `full` and `slice-seam`.
  Review transcripts and the sandbox's negative tests before considering a
  larger run. These exploratory results are not an E6 pass or failure.
- Use the same base commits, briefs, scope, judge and token definition as
  E6a. Record input, cached input, output, duration and verdict separately
  from Claude. Subscription sessions do not supply dollar cost; cost per
  accepted run is unmeasurable unless a defensible price is available.
- Each agent sees only its own workdir. Codex's permission profile denies
  the workspace, other sessions and hidden suites, and denies network to
  the commands it runs. The model connection remains
  available to the CLI. Fail closed if these checks cannot be established.
- A larger Codex experiment and its sample size will be registered after
  inspecting the pilot and before collecting its data. It will not be
  described as the originally registered Haiku/Sonnet experiment.

The first attempt (`bench-codex-pilot.jsonl`) was stopped after two runs:
the sandbox denied Node's access to a parent directory, so the slice agent
could not run its tests. Those rows are invalid diagnostics, not benchmark
results. The permission profile was corrected and checked with a separate
session running `npm test`, a forbidden sibling read, and a direct-IP
network request. The repeated pilot uses `bench-codex-pilot-v2.jsonl`.
