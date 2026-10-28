# Source context for bounties: Jira fields and repository documents

A bounty can take context from its two sources: its Jira issue's fields
beyond the text (type, status, priority, labels, components, releases,
story points, estimates, demand and links) and its repository's own
documents (READMEs, guides and docs, never code). The API reads these and
stores each change as the source's next version; sizing, spec drafting and
the starter agent are shown them; each step records the versions it used.
This spec covers only the domain rules that make that work, in a new module
`packages/core/src/sources.ts`: which repository files count as documents
and which are read, how their text is cut to fixed caps, which Jira fields
are shown, how both sources are rendered into prompt text, and when a step
is behind the context the overview holds now. Every export is a pure,
synchronous function or a constant. None of them reads a clock, a network,
a database or a file, and none mutates its arguments.

## Exports

`packages/core/src/sources.ts` exports exactly the following. The
signatures are the ticket's, unchanged. `packages/core/src/index.ts` adds
`export * from "./sources.js";` so that the package root `sandbox-factory`
re-exports them.

```ts
import type { StageDrift } from "./stages.js";

export const CONTEXT_SOURCES = ["jira", "github"] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

export interface JiraIssueLinkContext {
    readonly type: string;
    readonly direction: "inward" | "outward";
    readonly key: string | null;
    readonly done: boolean;
}

export interface JiraContext {
    readonly key: string;
    readonly issueType: string | null;
    readonly status: string | null;
    readonly statusCategory: string | null;
    readonly priority: string | null;
    readonly labels: readonly string[];
    readonly components: readonly string[];
    readonly fixVersions: readonly string[];
    readonly parentKey: string | null;
    readonly dueDate: string | null;
    readonly storyPoints: number | null;
    readonly originalEstimateSeconds: number | null;
    readonly remainingEstimateSeconds: number | null;
    readonly votes: number | null;
    readonly watchers: number | null;
    readonly subtaskCount: number;
    readonly links: readonly JiraIssueLinkContext[];
    readonly updated: string | null;
}

export interface GithubContextDocument {
    readonly path: string;
    readonly bytes: number;
    readonly text: string;
    readonly truncated: boolean;
}

export interface GithubContext {
    readonly fullName: string;
    readonly branch: string;
    readonly commitSha: string;
    readonly documents: readonly GithubContextDocument[];
    readonly omitted: number;
}

export interface ContextVersions {
    readonly jira: number | null;
    readonly github: number | null;
}

export const NO_CONTEXT: ContextVersions; // { jira: null, github: null }
export const CONTEXT_DOCUMENTS_MAX = 12;
export const CONTEXT_DOCUMENT_BYTES_MAX = 262_144; // 256 KiB
export const CONTEXT_DOCUMENT_CHARS = 12000;
export const CONTEXT_TOTAL_CHARS = 48000;

export function contextKeywords(title: string): string[];
export function contextDocuments(
    files: readonly { readonly path: string; readonly size: number }[],
    keywords: readonly string[] = [],
): { readonly paths: string[]; readonly omitted: number };
export function keptDocuments(
    documents: readonly { readonly path: string; readonly bytes: number; readonly text: string }[],
): { readonly documents: GithubContextDocument[]; readonly omitted: number };
export function jiraContextFields(context: JiraContext): Record<string, unknown>;
export function renderSourceContext(context: {
    readonly jira: JiraContext | null;
    readonly github: GithubContext | null;
}): string;
export function contextDrift(current: ContextVersions, used: ContextVersions): {
    readonly jira: StageDrift | null;
    readonly github: StageDrift | null;
};
```

`StageDrift` is the existing type from `packages/core/src/stages.ts`.
`packages/core/src/repo/stack.ts` adds
`export function inSkippedDirectory(path: string): boolean`, true when one
of the path's directories (not its name) is a skipped directory as defined
below. The other type-only additions are `ApprovedTaskContext` and an
optional `context` on `ApprovedTaskSnapshot` in
`packages/core/src/sandbox/approved-task.ts`, and an optional `context:
ContextVersions` on the overview, bounty and sandbox steps of
`BountyStages`. Every existing export keeps its current behaviour,
including `stageDrift`, `overviewVersionOf`, `overviewApproved`,
everything in `repo/tree.ts` and `repo/stack.ts`, `bounty.ts`, `handle.ts`
and `analysis.ts`, and `CONTEXT_BUILDERS` (the analysis tools, a different
thing from these sources). The one other change in the package is that
`STARTER_TOOL_VERSION` in `packages/core/src/analysis.ts` becomes
`"sandbox_starter@3"`, because the starter agent is now shown this
context. The lists `contextKeywords`, `contextDocuments` and
`keptDocuments` return are new arrays: changing them does not change the
arguments or any later result.

## Definitions used below

- **Code-point order** compares strings with `<` and `>`, as
  `repo/tree.ts` does. It does not use `localeCompare`.
- A path is used exactly as given: it is not normalized, so `./docs/a.md`
  and `docs/a.md` are different paths. Its **segments** are its parts
  split on `/`. Its **name** is the last segment, and its **directories**
  are the segments before the name. Its **depth** is the number of
  segments.
- A path is **Markdown** when it ends in `.md`, `.mdx` or `.markdown`,
  compared case-insensitively.
- A name's **stem** is the name without a final `.md`, `.mdx` or
  `.markdown` (case-insensitive), lower-cased (`README.md` → `readme`,
  `readme.ja.md` → `readme.ja`).
- **Docs directories** are `docs`, `doc`, `documentation`, `adr` and
  `adrs`, compared case-insensitively.
- **Root guides** are the stems `contributing`, `architecture`, `design`,
  `development`, `agents`, `claude`, `conventions` and `overview`.
- **Skipped directories** are `node_modules`, `bower_components`,
  `vendor`, `third_party`, `Pods`, `.venv`, `venv`, `dist`, `build`, `out`,
  `target`, `fixtures`, `__fixtures__`, `testdata`, `examples` and
  `example`, compared exactly, case included.
- **Boilerplate stems** are `changelog`, `changes`, `history`, `license`,
  `licence`, `copying`, `code_of_conduct`, `security`, `notice`,
  `authors`, `contributors` and `codeowners`.
- A document's **tier** is: 0 for a README at the root (depth 1, stem
  `readme`); 1 for a root guide at the root; 2 for a path with a docs
  directory among its directories; 3 for any other path whose stem is
  `readme`; 4 for anything else. The first that applies wins.

```gherkin
Feature: Source context for bounties
  The rules in packages/core/src/sources.ts that pick, cut, render and
  compare the context a bounty takes from its Jira issue and its repository.

  Background:
    Given the exports of "packages/core/src/sources.ts"

  Rule: The constants are fixed values

    @happy
    Scenario: The sources and caps have their declared values
      Then CONTEXT_SOURCES deep-equals ["jira", "github"]
      And CONTEXT_DOCUMENTS_MAX is 12
      And CONTEXT_DOCUMENT_BYTES_MAX is 262144
      And CONTEXT_DOCUMENT_CHARS is 12000
      And CONTEXT_TOTAL_CHARS is 48000

    @happy
    Scenario: NO_CONTEXT names no version of either source
      Then NO_CONTEXT deep-equals { "jira": null, "github": null }

  Rule: contextKeywords lower-cases the title, splits it into words and keeps the words of 4 or more characters in first-seen order without repeats
    The title is lower-cased with toLowerCase, then split on every run of
    characters other than the ASCII letters a-z and the digits 0-9, so
    spaces, hyphens, underscores, slashes, dots, punctuation and non-ASCII
    letters all separate words. A word is kept when it has at least 4
    characters. Words made only of digits are kept. There is no stopword
    list and no cap on the number of words kept.

    @happy
    Scenario Outline: Titles become keywords
      When contextKeywords is called with "<title>"
      Then it returns <keywords>

      Examples:
        | title                                 | keywords                                          |
        | Fix login redirect for SSO users      | ["login", "redirect", "users"]                    |
        | Add dark-mode toggle to settings_page | ["dark", "mode", "toggle", "settings", "page"]    |
        | Überprüfung der Zahlungen             | ["berpr", "fung", "zahlungen"]                    |
        | Billing/Invoices: export.CSV          | ["billing", "invoices", "export"]                 |

    @boundary
    Scenario Outline: Short words and repeats are dropped
      When contextKeywords is called with "<title>"
      Then it returns <keywords>

      Examples:
        | title                     | keywords               |
        | Upgrade to v2 of API 2024 | ["upgrade", "2024"]    |
        | Cache cache CACHE         | ["cache"]              |
        | abc abcd                  | ["abcd"]               |
        | the and with from         | ["with", "from"]       |
        |                           | []                     |
        |    --- !!! ...            | []                     |

  Rule: contextDocuments counts a file as a document when it is Markdown and is not under a skipped directory, under .github, or boilerplate
    A file counts when its path is Markdown, no directory is a skipped
    directory, no segment is exactly ".github", and its stem is not a
    boilerplate stem. A Markdown file counts at any depth and in any
    directory. A file that does not count is neither returned nor counted
    in "omitted". Returned paths are the paths exactly as given.

    @happy
    Scenario Outline: Which files count as documents
      Given a file "<path>" of size 100
      When contextDocuments is called with only that file and no keywords
      Then paths is <paths>
      And omitted is 0

      Examples:
        | path                          | paths                          |
        | README.md                     | ["README.md"]                  |
        | readme.markdown               | ["readme.markdown"]            |
        | packages/web/README.md        | ["packages/web/README.md"]     |
        | GUIDE.md                      | ["GUIDE.md"]                   |
        | docs/intro.mdx                | ["docs/intro.mdx"]             |
        | DOCS/Setup.MD                 | ["DOCS/Setup.MD"]              |
        | ./docs/setup.md               | ["./docs/setup.md"]            |
        | notes/plan.md                 | ["notes/plan.md"]              |
        | test/README.md                | ["test/README.md"]             |
        | docs/.vitepress/theme.md      | ["docs/.vitepress/theme.md"]   |
        | Vendor/notes.md               | ["Vendor/notes.md"]            |

    @unhappy
    Scenario Outline: Code, other text and excluded files are not documents
      Given a file "<path>" of size 100
      When contextDocuments is called with only that file and no keywords
      Then paths is []
      And omitted is 0

      Examples:
        | path                        | why                              |
        | readme                      | not Markdown                     |
        | Readme.rst                  | not Markdown                     |
        | README.txt                  | not Markdown                     |
        | src/index.ts                | code                             |
        | docs/conf.py                | code under a docs directory      |
        | docs/diagram.png            | not Markdown                     |
        | notes.txt                   | not Markdown                     |
        | documentation/api/auth.rst  | not Markdown                     |
        | website/guides/start.adoc   | not Markdown                     |
        | CHANGELOG.md                | boilerplate stem                 |
        | LICENSE.md                  | boilerplate stem                 |
        | docs/CODE_OF_CONDUCT.md     | boilerplate stem                 |
        | SECURITY.md                 | boilerplate stem                 |
        | .github/CONTRIBUTING.md     | .github segment                  |
        | node_modules/lib/README.md  | skipped directory                |
        | vendor/docs/guide.md        | skipped directory                |
        | examples/demo/README.md     | skipped directory                |
        | fixtures/a.md               | skipped directory                |
        | README.md.bak               | not Markdown                     |

  Rule: contextDocuments reads only documents with a usable size, at most CONTEXT_DOCUMENTS_MAX of them, and counts the rest past the cap in omitted
    A document whose size is not above 0, or is above
    CONTEXT_DOCUMENT_BYTES_MAX, or is not a number (NaN, Infinity) is
    ignored: it is neither returned nor counted in "omitted". After
    ranking, only the first CONTEXT_DOCUMENTS_MAX documents are returned,
    and each one past that is counted in "omitted".

    @boundary
    Scenario Outline: The size limit
      Given a file "docs/guide.md" of size <size>
      When contextDocuments is called with only that file and no keywords
      Then paths is <paths>
      And omitted is <omitted>

      Examples:
        | size     | paths             | omitted |
        | 1        | ["docs/guide.md"] | 0       |
        | 262144   | ["docs/guide.md"] | 0       |
        | 262145   | []                | 0       |
        | 0        | []                | 0       |
        | -1       | []                | 0       |
        | NaN      | []                | 0       |
        | Infinity | []                | 0       |

    @boundary
    Scenario: Documents past the count cap are counted, not returned
      Given the files "docs/a01.md" to "docs/a14.md", each of size 100, listed in reverse order
      When contextDocuments is called with those files and no keywords
      Then paths is "docs/a01.md" to "docs/a12.md" in that order
      And omitted is 2

    @boundary
    Scenario: Exactly CONTEXT_DOCUMENTS_MAX documents are all returned
      Given the files "docs/a01.md" to "docs/a12.md", each of size 100
      When contextDocuments is called with those files and no keywords
      Then paths has 12 entries
      And omitted is 0

    @unhappy
    Scenario: A listing with no documents returns nothing
      When contextDocuments is called with [] and no keywords
      Then paths is [] and omitted is 0

  Rule: contextDocuments ranks by tier, a keyword match lifting a document ahead of the tier above its own but never ahead of the root README, then shallowest, then by path
    Each document gets a rank of twice its tier. A document of tier 1 or
    more whose lower-cased path contains any keyword as a substring gets
    the rank max(1, 2 × tier − 3) instead: a matched root guide or docs
    document ranks 1, a matched other README 3 and a matched other file 5.
    Keywords are used as given, not trimmed or lower-cased, and matching
    one keyword or several gives the same rank. Documents are sorted by
    rank, lowest first, then by depth, lowest first, then by path in
    code-point order, so the result does not depend on the order of the
    listing.

    Background:
      Given the files:
        | path                     | size   |
        | src/index.ts             | 900    |
        | packages/api/README.md   | 1500   |
        | docs/billing/invoices.md | 3000   |
        | docs/setup.md            | 2000   |
        | CONTRIBUTING.md          | 1200   |
        | CHANGELOG.md             | 50000  |
        | node_modules/x/README.md | 100    |
        | docs/empty.md            | 0      |
        | docs/huge.md             | 300000 |
        | README.md                | 4000   |

    @happy
    Scenario: Without keywords the root README leads, then root guides, then docs, then other READMEs
      When contextDocuments is called with those files and keywords []
      Then paths is ["README.md", "CONTRIBUTING.md", "docs/setup.md", "docs/billing/invoices.md", "packages/api/README.md"]
      And omitted is 0

    @happy
    Scenario Outline: A path matching a keyword moves ahead of the tier above its own
      When contextDocuments is called with those files and keywords <keywords>
      Then paths is <paths>

      Examples:
        | keywords                | paths                                                                                                   |
        | ["billing", "invoices"] | ["README.md", "docs/billing/invoices.md", "CONTRIBUTING.md", "docs/setup.md", "packages/api/README.md"] |
        | ["api"]                 | ["README.md", "CONTRIBUTING.md", "packages/api/README.md", "docs/setup.md", "docs/billing/invoices.md"] |
        | ["setup", "billing"]    | ["README.md", "docs/setup.md", "docs/billing/invoices.md", "CONTRIBUTING.md", "packages/api/README.md"] |
        | ["BILLING"]             | ["README.md", "CONTRIBUTING.md", "docs/setup.md", "docs/billing/invoices.md", "packages/api/README.md"] |
        | ["readme"]              | ["README.md", "CONTRIBUTING.md", "packages/api/README.md", "docs/setup.md", "docs/billing/invoices.md"] |
        | ["contributing"]        | ["README.md", "CONTRIBUTING.md", "docs/setup.md", "docs/billing/invoices.md", "packages/api/README.md"] |

    @boundary
    Scenario: Matching more keywords does not rank a document higher than matching one
      When contextDocuments is called with those files and keywords ["invoices", "billing", "docs"]
      Then paths is ["README.md", "docs/setup.md", "docs/billing/invoices.md", "CONTRIBUTING.md", "packages/api/README.md"]

    @boundary
    Scenario: Ranking does not depend on the order of the listing
      When contextDocuments is called with those files in reverse order and keywords ["api"]
      Then the result deep-equals the result for the files in their listed order with keywords ["api"]

    @boundary
    Scenario Outline: Every tier, with and without a match
      Given the files "src/notes/billing.md", "packages/api/README.md", "docs/setup.md", "ARCHITECTURE.md", "README.md", "adr/0001-record.md" and "GUIDE.md", each of size 100
      When contextDocuments is called with those files and keywords <keywords>
      Then paths is <paths>

      Examples:
        | keywords    | paths                                                                                                                    |
        | []          | ["README.md", "ARCHITECTURE.md", "adr/0001-record.md", "docs/setup.md", "packages/api/README.md", "GUIDE.md", "src/notes/billing.md"] |
        | ["billing"] | ["README.md", "ARCHITECTURE.md", "adr/0001-record.md", "docs/setup.md", "src/notes/billing.md", "packages/api/README.md", "GUIDE.md"] |
        | ["guide"]   | ["README.md", "ARCHITECTURE.md", "adr/0001-record.md", "docs/setup.md", "GUIDE.md", "packages/api/README.md", "src/notes/billing.md"] |

  Rule: keptDocuments keeps documents in the order given, normalizes and trims each text, cuts each to CONTEXT_DOCUMENT_CHARS and all of them together to CONTEXT_TOTAL_CHARS
    Documents are taken in input order with a running room that starts at
    CONTEXT_TOTAL_CHARS. Each text has "\r\n" and lone "\r" turned into
    "\n" and is then trimmed. A document whose trimmed text is "" is
    dropped and counted in "omitted". A document met when the room is 0 is
    dropped and counted in "omitted". Otherwise its text is cut to
    min(CONTEXT_DOCUMENT_CHARS, room) UTF-16 code units. A kept document's
    room is reduced by its kept text's length. Its "truncated" flag is true
    exactly when its trimmed text was cut. Its "path" and "bytes" pass
    through unchanged. keptDocuments applies no count cap of its own.

    @happy
    Scenario Outline: A short document is kept with its line endings normalized and its ends trimmed
      When keptDocuments is called with [{ "path": "README.md", "bytes": 10, "text": <text> }]
      Then documents is [{ "path": "README.md", "bytes": 10, "text": <kept>, "truncated": false }]
      And omitted is 0

      Examples:
        | text                               | kept                       |
        | "Hello\r\n"                        | "Hello"                    |
        | "  # Pay\r\nCharges\rcards.\n\n"   | "# Pay\nCharges\ncards."   |

    @boundary
    Scenario Outline: The per-document cap
      When keptDocuments is called with one document whose text is <length> "a" characters
      Then that document's text has <kept> characters
      And its truncated is <truncated>
      And omitted is 0

      Examples:
        | length | kept  | truncated |
        | 1      | 1     | false     |
        | 12000  | 12000 | false     |
        | 12001  | 12000 | true      |
        | 50000  | 12000 | true      |

    @boundary
    Scenario Outline: The total cap cuts the document that reaches it and omits the rest
      When keptDocuments is called with documents whose texts have lengths <lengths>
      Then the kept texts have lengths <kept>
      And their truncated flags are <truncated>
      And omitted is <omitted>

      Examples:
        | lengths                             | kept                               | truncated                          | omitted |
        | [12000, 12000, 12000, 12000, 10]    | [12000, 12000, 12000, 12000]       | [false, false, false, false]       | 1       |
        | [12000, 12000, 12000, 11000, 5000]  | [12000, 12000, 12000, 11000, 1000] | [false, false, false, false, true] | 0       |
        | [20000, 20000, 20000, 20000]        | [12000, 12000, 12000, 12000]       | [true, true, true, true]           | 0       |
        | [30000, 30000, 30000, 30000, 30000] | [12000, 12000, 12000, 12000]       | [true, true, true, true]           | 1       |

    @boundary
    Scenario: More than CONTEXT_DOCUMENTS_MAX documents are all kept
      When keptDocuments is called with 13 documents whose texts are "doc 1" to "doc 13"
      Then documents are "doc 1" to "doc 13" in that order
      And omitted is 0

    @unhappy
    Scenario: Blank documents are dropped and counted
      When keptDocuments is called with:
        | path      | bytes | text    |
        | a.md      | 3     | "  \n"  |
        | b.md      | 0     | ""      |
        | README.md | 5     | "Hello" |
      Then documents is [{ "path": "README.md", "bytes": 5, "text": "Hello", "truncated": false }]
      And omitted is 2

    @unhappy
    Scenario: No documents
      When keptDocuments is called with []
      Then documents is [] and omitted is 0

  Rule: jiraContextFields gives the issue's fields that are set in a fixed order, without naming the issue or anything it links to
    The keys, in this insertion order, are: issueType, status, priority,
    labels, components, fixVersions, dueDate, storyPoints,
    originalEstimateHours, remainingEstimateHours, votes, watchers,
    subtasks, hasParent, links. "key", "updated", "statusCategory",
    "parentKey" and the seconds estimates are never included. A field is
    left out when it is null or an empty array. Strings (blank ones
    included), numbers (0 included) and array items are kept as given, in
    their given order. Each estimate is its seconds divided by 3600,
    rounded to one decimal with Math.round. subtasks is subtaskCount, left
    out when it is 0. hasParent is true when parentKey is not null and is
    left out otherwise. Each link is a new object with the keys type,
    direction and done, in that order; a link's key is never included.

    @happy
    Scenario: A filled-in issue
      Given the JiraContext "PAY-42":
        """
        { "key": "PAY-42", "issueType": "Story", "status": "In Progress",
          "statusCategory": "indeterminate", "priority": "High",
          "labels": ["billing"], "components": ["api"], "fixVersions": [],
          "parentKey": "PAY-1", "dueDate": null, "storyPoints": 5,
          "originalEstimateSeconds": 28800, "remainingEstimateSeconds": null,
          "votes": 0, "watchers": 3, "subtaskCount": 2,
          "links": [{ "type": "Blocks", "direction": "outward", "key": "PAY-50", "done": false }],
          "updated": "2026-10-01T10:00:00.000+0000" }
        """
      When jiraContextFields is called with it
      Then JSON.stringify of the result is:
        """
        {"issueType":"Story","status":"In Progress","priority":"High","labels":["billing"],"components":["api"],"storyPoints":5,"originalEstimateHours":8,"votes":0,"watchers":3,"subtasks":2,"hasParent":true,"links":[{"type":"Blocks","direction":"outward","done":false}]}
        """

    @boundary
    Scenario: An issue with nothing beyond its key gives no fields
      Given a JiraContext with key "OPS-1", every nullable field null, every array empty, subtaskCount 0 and updated "2026-10-01T10:00:00.000+0000"
      When jiraContextFields is called with it
      Then the result deep-equals {}

    @boundary
    Scenario: Blank strings and zero are kept, a link's key is left out
      Given a JiraContext with key "OPS-2", priority "  ", status "", storyPoints 0, dueDate "2026-11-30", subtaskCount 0, links [{ "type": "Relates", "direction": "inward", "key": null, "done": true }] and every other field null or empty
      When jiraContextFields is called with it
      Then JSON.stringify of the result is:
        """
        {"status":"","priority":"  ","dueDate":"2026-11-30","storyPoints":0,"links":[{"type":"Relates","direction":"inward","done":true}]}
        """

    @boundary
    Scenario Outline: Estimates are given in hours to one decimal
      Given a JiraContext with key "OPS-3", originalEstimateSeconds <original>, remainingEstimateSeconds <remaining>, subtaskCount 0 and every other field null or empty
      When jiraContextFields is called with it
      Then the result deep-equals <fields>

      Examples:
        | original | remaining | fields                                                         |
        | 28800    | null      | { "originalEstimateHours": 8 }                                 |
        | 5400     | 1000      | { "originalEstimateHours": 1.5, "remainingEstimateHours": 0.3 } |
        | 3600     | 180       | { "originalEstimateHours": 1, "remainingEstimateHours": 0.1 }   |
        | 0        | 59        | { "originalEstimateHours": 0, "remainingEstimateHours": 0 }     |

  Rule: renderSourceContext writes the Jira section, then the repository section, separated by one blank line
    The Jira section is the line "Jira fields:" followed by a line holding
    JSON.stringify(jiraContextFields(jira)). The repository section starts
    with the line "Repository documents:". Each document follows as a block
    after one blank line: the line "--- <path> ---", or "--- <path> (cut
    short) ---" when the document is truncated, then the text as given.
    The issue key, the repository's fullName, branch and commitSha, and
    "omitted" are not rendered. A null Jira source, and a null repository
    source or one with no documents, contribute nothing; with neither the
    result is "". Sections are joined with "\n\n" and nothing is added
    after the last one. No caps are applied here: the text is rendered as
    given. In the scenarios below, "\n" stands for a newline character.

    Background:
      Given the JiraContext "PAY-42" from the jiraContextFields rule
      And the GithubContext "acme/pay":
        """
        { "fullName": "acme/pay", "branch": "main",
          "commitSha": "0123456789abcdef0123456789abcdef01234567",
          "documents": [
            { "path": "README.md", "bytes": 20, "text": "# Pay\nCharges cards.", "truncated": false },
            { "path": "docs/setup.md", "bytes": 30000, "text": "Run make up.", "truncated": true }
          ],
          "omitted": 2 }
        """

    @happy
    Scenario: Both sources
      When renderSourceContext is called with { "jira": "PAY-42", "github": "acme/pay" }
      Then it returns:
        """
        Jira fields:
        {"issueType":"Story","status":"In Progress","priority":"High","labels":["billing"],"components":["api"],"storyPoints":5,"originalEstimateHours":8,"votes":0,"watchers":3,"subtasks":2,"hasParent":true,"links":[{"type":"Blocks","direction":"outward","done":false}]}

        Repository documents:

        --- README.md ---
        # Pay
        Charges cards.

        --- docs/setup.md (cut short) ---
        Run make up.
        """

    @happy
    Scenario: Only Jira
      When renderSourceContext is called with { "jira": "PAY-42", "github": null }
      Then it returns the two Jira lines of the previous scenario and nothing else

    @happy
    Scenario: Only the repository
      When renderSourceContext is called with { "jira": null, "github": "acme/pay" }
      Then it returns the previous scenario's text from "Repository documents:" to the end

    @boundary
    Scenario: Neither source
      When renderSourceContext is called with { "jira": null, "github": null }
      Then it returns ""

    @boundary
    Scenario Outline: A repository with no documents contributes nothing
      Given the GithubContext "acme/pay" with documents [] and omitted <omitted>
      When renderSourceContext is called with { "jira": null, "github": that context }
      Then it returns ""

      Examples:
        | omitted |
        | 0       |
        | 1       |

  Rule: contextDrift says a step is behind a source when the overview holds a newer version of it than the step used
    For each source, when current[source] is null the drift is null.
    Otherwise, when used[source] is null or less than current[source], the
    drift is { uses: used[source], current: current[source] }. Otherwise,
    when the step used the same version or a later one, the drift is null.

    @happy
    Scenario Outline: Drift per source
      When contextDrift is called with current { "jira": <cj>, "github": <cg> } and used { "jira": <uj>, "github": <ug> }
      Then jira is <jira>
      And github is <github>

      Examples:
        | cj   | cg   | uj   | ug   | jira                         | github                       |
        | 3    | 2    | 3    | 2    | null                         | null                         |
        | 4    | 2    | 3    | 2    | { "uses": 3, "current": 4 }  | null                         |
        | 4    | 5    | null | null | { "uses": null, "current": 4 } | { "uses": null, "current": 5 } |
        | 1    | 7    | 1    | 6    | null                         | { "uses": 6, "current": 7 }  |

    @boundary
    Scenario Outline: Nothing is behind a source the overview holds no version of, or a step ahead of it
      When contextDrift is called with current { "jira": <cj>, "github": <cg> } and used { "jira": <uj>, "github": <ug> }
      Then jira is null
      And github is null

      Examples:
        | cj   | cg   | uj   | ug   |
        | null | null | 2    | 1    |
        | null | null | null | null |
        | 2    | 1    | 3    | 4    |

    @boundary
    Scenario: NO_CONTEXT against itself
      When contextDrift is called with NO_CONTEXT and NO_CONTEXT
      Then it returns { "jira": null, "github": null }
```

## Decided:

- `NO_CONTEXT` is `{ jira: null, github: null }`. It is not frozen.
- `CONTEXT_DOCUMENT_BYTES_MAX` is 262144 (256 KiB). A larger document is ignored and not counted in `omitted`.
- A file with a size that is 0 or less, or not finite, is ignored and not counted in `omitted`.
- What counts as a document: any `.md`/`.mdx`/`.markdown` file (case-insensitive), at any depth and in any directory. READMEs without one of these extensions, `.txt`, `.rst` and `.adoc` files are not documents.
- These are never documents: paths with a `.github` segment, paths under a skipped directory (exact-case match), and boilerplate stems (changelog, licence, security and the like). Other hidden directories and test directories are not excluded.
- Paths are used as given, with no normalization and no de-duplication.
- Document ranking: by tier (root README, root guides, docs/adr directories, other READMEs, other files). A keyword match lifts a document ahead of the tier above its own but never ahead of the root README, then depth, then code-point path order. The result is the same whatever the input order.
- A keyword matches when it is a substring of the lower-cased path. Keywords are used as given, not trimmed or lower-cased. Matching several keywords ranks the same as matching one.
- `omitted` from `contextDocuments` counts only the documents past the 12-document cap.
- Keywords: the lower-cased title split on runs of characters other than ASCII `a-z0-9`, with words of at least 4 characters kept (digits included), no repeats, in first-seen order. There is no stopword list and no cap.
- `keptDocuments` keeps the input order and does not re-rank. It has no count cap of its own.
- Each text has `\r\n` and `\r` turned into `\n` and is trimmed before it is cut and measured.
- The total cap cuts the document that reaches it. Once the room is 0, later documents are omitted and counted.
- Cuts count UTF-16 code units.
- Blank texts are dropped and counted in `omitted`.
- No truncation marker goes into stored text. `truncated` carries that, and `renderSourceContext` adds ` (cut short)` to the document's heading.
- `jiraContextFields` gives `issueType, status, priority, labels, components, fixVersions, dueDate, storyPoints, originalEstimateHours, remainingEstimateHours, votes, watchers, subtasks, hasParent, links` in that order. It leaves out nulls and empty arrays, keeps blank strings and `0`, and leaves out `subtasks` when it is 0. It never includes `key`, `updated`, `statusCategory`, `parentKey` or a link's `key`. Estimates are in hours rounded to one decimal, and links are not capped.
- `renderSourceContext` format: the `Jira fields:` section first, then the `Repository documents:` section, joined by one blank line. Documents use `--- path ---` headings. The issue key, repository name, branch, commit and omitted count are not rendered. There is no trailing newline added. A repository with no documents contributes nothing, and the result is `""` when neither source contributes.
- `contextDrift`: no drift when the overview has no version of a source. Drift when the step used no version or an older one. No drift when it used the same version or a later one.
- Concurrency: every export is pure and synchronous with no shared mutable state, so there are no `@concurrency` scenarios.
- Outside the seam, `STARTER_TOOL_VERSION` becomes `"sandbox_starter@3"`, `index.ts` re-exports `sources.ts`, and `repo/stack.ts` exports `inSkippedDirectory`.
