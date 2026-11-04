# Point `verifyCommand` at a provenance lookup that exists

`packages/shared/src/build-info.ts` defines the build record every surface
reports. Its `verifyCommand` turns the record's `imageDigest` into a command a
reader can run to find out where those bytes came from. Right now it returns
`gh attestation verify --digest <digest> --repo lunox-work/sandbox-factory`.
`gh attestation verify` has no `--digest` flag. It takes a file path or an
`oci://` image reference, plus `--digest-alg`, so the command it prints fails
with an unknown-flag error. A file path cannot work because the verifier
doesn't have the image bytes. An `oci://` reference cannot work because the
image is in a private ECR registry the verifier can't pull from. GitHub does
offer a lookup by digest that needs neither: the REST endpoint
`GET /repos/{owner}/{repo}/attestations/{subject_digest}`, which `gh api` can
call. It returns the signed attestation bundles recorded for that digest, and
each one names the workflow and commit that produced the bytes.

This change (#45) makes `verifyCommand` return that lookup. It also makes the
seam's doc comments describe the lookup instead of the missing flag. That
covers the `imageDigest` field comment, which currently shows
`gh attestation verify --digest …`, and the `verifyCommand` comment. Both must
call it a lookup of recorded attestations by digest, not a signature check.

**Exports.** The names and signatures stay exactly as they are. Nothing is
added and nothing is removed:

```ts
export const UNKNOWN_BUILD: "unknown";
export const buildInfoSchema: z.ZodObject<…>;          // unchanged
export type BuildInfoDto = z.infer<typeof buildInfoSchema>;
export const versionResponseSchema: typeof buildInfoSchema;
export const unknownBuildInfo: BuildInfoDto;
export function formatVersion(info: BuildInfoDto): string;
export function isIdentified(info: BuildInfoDto): boolean;
export function commitUrl(info: BuildInfoDto): string | undefined;
export function releaseTag(version: string): string;
export function releaseUrl(info: BuildInfoDto): string | undefined;
export function verifyCommand(info: BuildInfoDto): string | undefined; // behaviour changes
export function sameBuild(a: BuildInfoDto, b: BuildInfoDto): boolean;
export function buildBanner(name: string, info: BuildInfoDto): string;
```

Only `verifyCommand` changes behaviour. `UNKNOWN_BUILD`, `buildInfoSchema`,
`versionResponseSchema`, `unknownBuildInfo`, `formatVersion`, `isIdentified`,
`commitUrl`, `releaseTag`, `releaseUrl`, `sameBuild` and `buildBanner` behave
exactly as they do now, and their existing tests in
`packages/shared/test/build-info.test.ts` pass unchanged. The existing test
`verifyCommand takes the digest, which needs no registry access` asserts that
the result contains `--digest <digest>` and `--repo lunox-work/sandbox-factory`.
This spec replaces those assertions. The test
`verifyCommand is undefined when no digest was resolved` still holds.
`packages/shared/test/build-info-resolver.test.ts` is not affected.

The repository slug used in the command is `lunox-work/sandbox-factory`, the
same repository as the module's private `REPOSITORY_URL`. It stays private,
because no new export is added. Other files that print the old command
(`docs/versioning.md`, `.github/workflows/cd.yml`,
`infra/scripts/verify-deploy.sh`, `apps/api/src/image-digest.ts`,
`apps/api/src/routes.ts`) are outside this change.

All exports are pure, synchronous functions of their arguments: no clock,
network, file system or shared state. Overlapping calls can't affect each
other, so this spec has no concurrency scenarios.

```gherkin
Feature: verifyCommand prints a provenance lookup that exists

  Background:
    Given the build record "identified":
      | field       | value                                    |
      | version     | 1.4.2                                    |
      | gitSha      | 7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09 |
      | gitShortSha | 7f3a9c1                                  |
      | buildTime   | 2026-09-17T09:14:00.000Z                 |
      | gitRef      | main                                     |
      | dirty       | false                                    |
    And "identified" has no imageDigest property

  Rule: With a digest, verifyCommand returns exactly "gh api /repos/lunox-work/sandbox-factory/attestations/" followed by the digest

    @happy
    Scenario: A sha256 digest becomes a GitHub attestations API lookup
      Given the record is "identified" with imageDigest "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      When verifyCommand is called with the record
      Then the result is exactly "gh api /repos/lunox-work/sandbox-factory/attestations/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    @happy
    Scenario: The digest is inserted verbatim, with no URL-encoding of the colon
      Given the record is "identified" with imageDigest "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      When verifyCommand is called with the record
      Then the result is exactly "gh api /repos/lunox-work/sandbox-factory/attestations/sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      And the result does not contain "%3A"

    @happy
    Scenario: The command is a single line with no surrounding whitespace
      Given the record is "identified" with imageDigest "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      When verifyCommand is called with the record
      Then the result contains no newline character
      And the result equals itself trimmed of leading and trailing whitespace

  Rule: The command never names the gh attestation verify --digest invocation that does not exist

    @unhappy
    Scenario Outline: The old, non-existent invocation is gone
      Given the record is "identified" with imageDigest "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      When verifyCommand is called with the record
      Then the result does not contain "<fragment>"

      Examples:
        | fragment             |
        | gh attestation verify |
        | --digest             |
        | --repo               |
        | oci://               |

  Rule: verifyCommand returns undefined only when imageDigest is absent or undefined

    @unhappy
    Scenario: No imageDigest property
      Given the record is "identified"
      When verifyCommand is called with the record
      Then the result is undefined

    @unhappy
    Scenario: imageDigest explicitly set to undefined
      Given the record is "identified" with imageDigest set to undefined
      When verifyCommand is called with the record
      Then the result is undefined

    @boundary
    Scenario: The unknown fallback record has no digest
      Given the record is unknownBuildInfo
      When verifyCommand is called with the record
      Then the result is undefined

  Rule: Any string digest, even an empty one, is used verbatim; verifyCommand does not check its format

    @boundary
    Scenario Outline: Non-sha256 or malformed digests pass through unchanged
      Given the record is "identified" with imageDigest "<imageDigest>"
      When verifyCommand is called with the record
      Then the result is exactly "<command>"

      Examples:
        | imageDigest  | command                                                         |
        | sha512:abc   | gh api /repos/lunox-work/sandbox-factory/attestations/sha512:abc   |
        | not-a-digest | gh api /repos/lunox-work/sandbox-factory/attestations/not-a-digest |
        | " "          | gh api /repos/lunox-work/sandbox-factory/attestations/             |

    # In the last row the digest is a single space, so the command ends in
    # "attestations/" followed by one space character.

    @boundary
    Scenario: An empty imageDigest, which buildInfoSchema rejects, still gives a command
      Given the record is "identified" with imageDigest ""
      When verifyCommand is called with the record
      Then the result is exactly "gh api /repos/lunox-work/sandbox-factory/attestations/"

  Rule: Only imageDigest decides the result; whether the build is identified, dirty or released does not matter

    @boundary
    Scenario Outline: The same digest gives the same command whatever the other fields say
      Given the record is <base> with imageDigest "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and <override>
      When verifyCommand is called with the record
      Then the result is exactly "gh api /repos/lunox-work/sandbox-factory/attestations/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

      Examples:
        | base             | override                                       |
        | "identified"     | no other change                                |
        | unknownBuildInfo | no other change                                |
        | "identified"     | dirty true                                     |
        | "identified"     | version "1.0.0" and gitRef "sandbox-factory-v1.0.0" |

    @boundary
    Scenario: verifyCommand does not modify the record it is given
      Given the record is "identified" with imageDigest "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      And a deep copy of the record is taken
      When verifyCommand is called with the record
      Then the record deep-equals the copy

  Rule: The other exports keep their current behaviour, with or without a digest

    @happy
    Scenario: buildInfoSchema still accepts a record with a digest and rejects an empty one
      Given the record is "identified" with imageDigest "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      Then buildInfoSchema.parse returns a record deep-equal to it
      And buildInfoSchema.safeParse of "identified" with imageDigest "" reports success false

    @happy
    Scenario Outline: Adding a digest changes no other function's result
      Given the record is "identified" with imageDigest "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      When <call> is evaluated
      Then the result is <result>

      Examples:
        | call                     | result                                                                                                     |
        | formatVersion(record)    | "1.4.2+7f3a9c1"                                                                                            |
        | isIdentified(record)     | true                                                                                                       |
        | commitUrl(record)        | "https://github.com/lunox-work/sandbox-factory/commit/7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09"             |
        | releaseUrl(record)       | undefined                                                                                                  |
        | sameBuild(record, identified) | true                                                                                                  |
        | buildBanner("api", record) | "api 1.4.2+7f3a9c1 · commit 7f3a9c1e5b2d8a4f6c0e9b3a1d7f5c2e8a4b6d09 · built 2026-09-17T09:14:00.000Z"     |
```

Decided:

- What the command does now: it looks up the attestations GitHub recorded for the digest (`gh api /repos/<repo>/attestations/<digest>`). It no longer claims to verify a signature.
  Ticket: "fix: document a provenance lookup that actually exists (#45)"
  Instead: `gh attestation verify oci://<image>@<digest> --repo lunox-work/sandbox-factory`. That is a real signature check, but it needs pull access to the private ECR registry.
- Which tool runs the lookup: the `gh api` CLI, using a path from the API root with a leading slash (`/repos/...`).
  Ticket: silent.
  Instead: `curl https://api.github.com/repos/lunox-work/sandbox-factory/attestations/<digest>`, which needs no installed or authenticated `gh`.
- Whether to add flags such as `--jq` to pull fields out of the response: no. The command is the bare endpoint.
  Ticket: silent.
  Instead: add a `--jq` filter that decodes each bundle's payload and prints the workflow and commit.
- How the digest is encoded in the path: inserted verbatim, with the `:` left as is.
  Ticket: silent.
  Instead: percent-encode it (`sha256%3A…`) with `encodeURIComponent`.
- Function name and signature: keep `verifyCommand(info: BuildInfoDto): string | undefined`, even though the command it returns is a lookup.
  Ticket: "The change keeps the exports' names and signatures."
  Instead: rename it to `provenanceLookupCommand`, or keep the old name as a deprecated alias.
- Where the repository slug lives: hard-coded `lunox-work/sandbox-factory` inside the module, with no new exported constant.
  Ticket: "The change keeps the exports' names and signatures."
  Instead: export a `REPOSITORY_SLUG` constant shared with `commitUrl`/`releaseUrl`.
- Empty `imageDigest` (`""`): interpolated as is, giving `gh api /repos/lunox-work/sandbox-factory/attestations/`. Only an absent or `undefined` digest returns `undefined`.
  Ticket: silent.
  Instead: return `undefined`, the same as an absent digest, following the resolver's "empty is absent" convention.
- Validating the digest's format: no check. Any string is used verbatim, including `sha512:…`, malformed values and whitespace.
  Ticket: silent.
  Instead: return `undefined` unless the digest matches `^sha256:[0-9a-f]{64}$`, as `normaliseDigest` in `apps/api/src/image-digest.ts` does.
- Whether identification, dirtiness or release status gate the command: they don't. Only `imageDigest` decides the result, as now.
  Ticket: silent.
  Instead: return `undefined` for a record where `isIdentified` is false, as `commitUrl` and `releaseUrl` do.
- Scope of the documentation fix: only the doc comments in `build-info.ts` change. The docs, workflows, scripts and API sources that repeat the old command are out of scope.
  Ticket: "fix: document a provenance lookup that actually exists (#45)"
  Instead: fix every place that prints `gh attestation verify --digest` in the same change.
