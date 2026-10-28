# Read a Jira ticket's spec and fingerprint it

Ticket #27 adds `packages/jira/src/spec.ts`. It turns the `fields` block of a
Jira issue into a `JiraIssueSpec`: the ticket's key, summary, description as
plain text, issue type and last-updated stamp, plus a `specHash` that changes
only when the words of the summary or the description text change. Line endings
and whitespace at the ends of lines and around the text do not count. Callers
use the hash to tell whether a ticket's spec changed since they last read it.
Jira's REST API v3 (`/rest/api/3`, which `JiraClient.issue` uses) sends
`description` as an Atlassian Document Format (ADF) tree. Older endpoints send a
plain string, and either can be `null`. The module reads the fields the way
`mapping.ts` does: it never throws on a missing or malformed field. It uses a
sensible default instead. Like the rest of the package it is platform-neutral,
with no `node:` imports. Hashing uses the web-standard `globalThis.crypto.subtle`
and `TextEncoder`, which is why `specHash` is async.

## Exports

From `packages/jira/src/spec.ts`, exactly as the ticket gives them:

```ts
export interface JiraIssueSpec {
    readonly key: string;
    readonly summary: string;
    readonly descriptionText: string;
    readonly issueType: string;
    readonly updated: string | null;
    readonly specHash: string;
}

export const SPEC_FIELDS: readonly string[] = [
    "summary",
    "description",
    "issuetype",
    "updated",
];

export async function specHash(summary: string, descriptionText: string): Promise<string>;

export async function toIssueSpec(key: string, fields: {
    summary?: unknown;
    description?: unknown;
    issuetype?: {
        name?: unknown;
    } | null;
    updated?: unknown;
}): Promise<JiraIssueSpec>;
```

The description is flattened by a new module, `packages/jira/src/adf.ts`, which
exports `adfToText(document: unknown): string`. `toIssueSpec`'s
`descriptionText` is `adfToText(fields.description)`.

`packages/jira/src/index.ts` also re-exports `SPEC_FIELDS`, `specHash`,
`toIssueSpec` and `adfToText`, exports the type `JiraIssueSpec`, and now
re-exports the existing `stripTrailingSlashes` from `url.ts`. `JiraClient` gains
one method, `issueSpec(keyOrId: string): Promise<JiraIssueSpec>`, which requests
`SPEC_FIELDS` for one issue and returns `toIssueSpec` of the result.

No other export changes. `ISSUE_FIELDS`, `toIssueDto`, `toBoardDto`,
`toSprintDto`, `stripTrailingSlashes`, the existing `JiraClient` methods and
everything in `credentials.ts` and `oauth.ts` behave as before. In particular
`ISSUE_FIELDS` stays the same 11 fields and does not gain `"description"`.

## Definitions used below

- **sha256hex(s)**: the SHA-256 digest of the UTF-8 encoding of the string `s`,
  written as 64 lowercase hexadecimal characters with no prefix.
- **canon(s)**: `s` split into lines at `"\r\n"`, `"\r"` or `"\n"`, trailing
  whitespace removed from every line, the lines joined with `"\n"`, and the
  result trimmed at both ends. Whitespace inside a line is kept as it is, and
  so are blank lines between lines of text.
- **ADF node**: any non-null object (arrays included, though they have no
  members to read). Its `type`, `text`, `attrs` and `content` members are read
  only when they have the expected type and are ignored otherwise. Items in
  `content` that are not ADF nodes (strings, numbers, `null`) are skipped.
- **Flattened ADF**: the document becomes a list of **blocks**. Every block has
  its trailing whitespace removed, empty blocks are dropped, and the rest are
  joined with `"\n\n"`. Leading whitespace is kept. Blocks come from node types
  like this:

  | `type`                       | blocks                                                                 |
  | ---------------------------- | ---------------------------------------------------------------------- |
  | `paragraph`                  | one block: its inline text                                             |
  | `heading`                    | one block: `#` repeated `attrs.level` times (default 1, clamped to 1–6), a space, its inline text; none if the inline text is empty |
  | `codeBlock`                  | one block: ```` ``` ```` + `attrs.language` (if a string) + `"\n"` + inline text + `` "\n```" `` |
  | `blockquote`                 | one block: the blocks of its children, each prefixed `"> "`, joined with `"\n"` |
  | `bulletList`, `orderedList`  | for each item, the item's child blocks: the first prefixed `"- "` (bullet) or `"N. "` (ordered, `N` starting at `attrs.order`, default 1), the rest prefixed with two spaces |
  | `taskList`                   | one block per item: `"- [x] "` if the item's `attrs.state` is `"DONE"`, else `"- [ ] "`, then the item's inline text |
  | `table`                      | one block per row: `"\| "` + the row's cells joined with `" \| "` + `" \|"`; a cell is its blocks joined with `" "`, trimmed |
  | `rule`                       | one block: `"---"`                                                     |
  | `mediaSingle`, `mediaGroup`  | one block: `"[media]"` if `content` has one item, else `"[media xN]"`  |
  | anything else, or no `type`  | if `text` is a non-empty string, one block of that text; otherwise the blocks of its children |

- **Inline text** of a node, by its `type`, is the concatenation with no
  separator of:

  | `type`                      | inline text                                                     |
  | --------------------------- | --------------------------------------------------------------- |
  | `text`                      | `text` if it is a string; otherwise the inline text of its children |
  | `hardBreak`                 | `"\n"`                                                          |
  | `mention`                   | `attrs.text` if it is a string, else `"@unknown"`               |
  | `emoji`                     | `attrs.shortName` if it is a string, else `""` (`attrs.text` is not used) |
  | `inlineCard`, `blockCard`   | `attrs.url` if it is a string, else `""`                        |
  | `date`                      | `attrs.timestamp` if it is a string, else `""`                  |
  | anything else               | the inline text of its children, joined with `""`               |

  `marks` and every other member are ignored. Text inside a block is not
  trimmed, collapsed or normalised.
- **Length cap**: a description text longer than 20,000 characters is cut to
  its first 20,000 characters followed by `"\n[truncated]"`.

```gherkin
Feature: Read a Jira issue's spec and fingerprint it

  Background:
    Given the exports of "packages/jira/src/spec.ts"

  Rule: SPEC_FIELDS lists exactly the Jira fields toIssueSpec reads, in this order

    @happy
    Scenario: SPEC_FIELDS is the four spec fields
      When SPEC_FIELDS is read
      Then it deep-equals ["summary", "description", "issuetype", "updated"]

    @happy
    Scenario: ISSUE_FIELDS is unchanged by this feature
      When ISSUE_FIELDS is read from "packages/jira/src/mapping.ts"
      Then it deep-equals ["summary", "status", "assignee", "priority", "issuetype", "labels", "created", "updated", "duedate", "parent", "project"]

  Rule: specHash is sha256hex(canon(summary) + "\u0000" + canon(descriptionText)), 64 lowercase hex characters

    @happy
    Scenario Outline: Known inputs give known hashes
      When specHash(<summary>, <descriptionText>) is awaited
      Then it resolves to "<hash>"

      Examples:
        | summary         | descriptionText          | hash                                                             |
        | "Add login"     | "Users can sign in."     | 24b1c29d416fdea96e63dcd8edf3ccbc14c9e53a0f019720cefd4803fcec0bf5 |
        | "Fix the build" | "Line one\nLine two"     | 401c829e08ad2a5a6a3cb4a6913afd15a8f35a9ceb9ddeb48a714539e0b50fa7 |
        | "Café"          | "naïve 🙂"               | 9c4cc9badc248d4348703cb96e07cb1dc086a58719c9e27252c8258dec119ca4 |

    @boundary
    Scenario: Two empty strings still hash
      When specHash("", "") is awaited
      Then it resolves to "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"

    @happy
    Scenario: The result always has the hex digest's shape
      When specHash("Add login", "Users can sign in.") is awaited
      Then the result matches /^[0-9a-f]{64}$/

    @happy
    Scenario: The same inputs always give the same hash
      When specHash("Add login", "Users can sign in.") is awaited twice
      Then both results are equal

    @boundary
    Scenario: Moving text across the summary/description boundary changes the hash
      When specHash("a\nb", "c") is awaited
      And specHash("a", "b\nc") is awaited
      Then the first resolves to "896144d1d44195e89a7ed32b80e86e5c886c7f993eaf12f946524018d68dbd9c"
      And the second resolves to "214df3f68e1a607f5baa40cc3315f4316ae58b282b6c0bf288b89fec4da7aa80"

    @boundary
    Scenario Outline: Surrounding and trailing whitespace and line endings do not change the hash
      When specHash(<summary>, <descriptionText>) is awaited
      Then it resolves to "24b1c29d416fdea96e63dcd8edf3ccbc14c9e53a0f019720cefd4803fcec0bf5", the same as specHash("Add login", "Users can sign in.")

      Examples:
        | summary          | descriptionText             |
        | "Add login"      | "Users can sign in. "       |
        | "Add login"      | "  Users can sign in.\n\n"  |
        | "  Add login  "  | "Users can sign in."        |

    @boundary
    Scenario: CRLF hashes the same as LF
      When specHash("Fix the build", "Line one\r\nLine two") is awaited
      Then it resolves to "401c829e08ad2a5a6a3cb4a6913afd15a8f35a9ceb9ddeb48a714539e0b50fa7"

    @boundary
    Scenario: Whitespace inside a line is significant
      When specHash("Add login", "Users  can sign in.") is awaited
      Then it resolves to "9e8adb77f867c7c699b7b519248d5f241818f57c86bf3f495f4d50be8b92d458"
      And that differs from specHash("Add login", "Users can sign in.")

    @boundary
    Scenario: Unicode is hashed as given, without normalisation
      When specHash("Café", "") and specHash("Café", "") are awaited
      Then the first resolves to "6d376e109ca48a4c0406fbcef2371b0094c5aee541b5d71ca6adce921a59a792"
      And the second resolves to "4958810ccced6aa6642407420b24b5b561d0b12d72d229f855814f307491f030"

  Rule: specHash rejects a non-string argument with a TypeError

    @unhappy
    Scenario Outline: A non-string argument rejects
      When specHash(<summary>, <descriptionText>) is awaited, with the types bypassed
      Then the promise rejects with a TypeError

      Examples:
        | summary   | descriptionText |
        | undefined | ""              |
        | 42        | ""              |
        | ""        | null            |
        | ""        | { }             |

  Rule: Concurrent specHash calls are independent

    @concurrency
    Scenario: Overlapping calls each resolve to their own input's hash
      When these are started together and awaited with Promise.all:
        | summary         | descriptionText      |
        | "Add login"     | "Users can sign in." |
        | ""              | ""                   |
        | "Fix the build" | "Line one\nLine two" |
      Then the results are, in the same order:
        | hash                                                             |
        | 24b1c29d416fdea96e63dcd8edf3ccbc14c9e53a0f019720cefd4803fcec0bf5 |
        | 6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d |
        | 401c829e08ad2a5a6a3cb4a6913afd15a8f35a9ceb9ddeb48a714539e0b50fa7 |

  Rule: toIssueSpec returns exactly the six JiraIssueSpec keys, with specHash equal to specHash(summary, descriptionText)

    @happy
    Scenario: A complete v3 issue becomes a spec
      Given fields:
        """
        {
          "summary": "Add login",
          "description": {
            "type": "doc", "version": 1,
            "content": [
              { "type": "paragraph", "content": [ { "type": "text", "text": "Users can sign in." } ] }
            ]
          },
          "issuetype": { "name": "Story" },
          "updated": "2026-10-20T09:15:00.000+0000"
        }
        """
      When toIssueSpec("ACME-123", fields) is awaited
      Then the result deep-equals:
        | key             | ACME-123                                                         |
        | summary         | Add login                                                        |
        | descriptionText | Users can sign in.                                               |
        | issueType       | Story                                                            |
        | updated         | 2026-10-20T09:15:00.000+0000                                     |
        | specHash        | 24b1c29d416fdea96e63dcd8edf3ccbc14c9e53a0f019720cefd4803fcec0bf5 |
      And Object.keys of the result are exactly key, summary, descriptionText, issueType, updated, specHash

    @happy
    Scenario: The key is passed through verbatim
      When toIssueSpec("acme-7", { "summary": "x" }) is awaited
      Then key is "acme-7"

    @happy
    Scenario: The input fields object is not modified
      Given fields { "summary": "Add login", "description": "Users can sign in.", "issuetype": { "name": "Bug" }, "updated": null }
      When toIssueSpec("ACME-1", fields) is awaited
      Then fields still deep-equals { "summary": "Add login", "description": "Users can sign in.", "issuetype": { "name": "Bug" }, "updated": null }

    @happy
    Scenario: Issue type and updated stamp do not affect the hash
      Given fields A { "summary": "Add login", "description": "Users can sign in.", "issuetype": { "name": "Story" }, "updated": "2026-10-20T09:15:00.000+0000" }
      And fields B { "summary": "Add login", "description": "Users can sign in.", "issuetype": { "name": "Bug" }, "updated": "2026-10-24T17:00:00.000+0000" }
      When toIssueSpec("ACME-1", A) and toIssueSpec("ACME-2", B) are awaited
      Then both specHash values are "24b1c29d416fdea96e63dcd8edf3ccbc14c9e53a0f019720cefd4803fcec0bf5"

  Rule: summary is used verbatim when it is a string, otherwise it becomes ""

    @boundary
    Scenario Outline: summary values
      When toIssueSpec("ACME-1", { "summary": <summary> }) is awaited
      Then summary is <result>

      Examples:
        | summary          | result           |
        | "  Add login  "  | "  Add login  "  |
        | ""               | ""               |
        | absent           | ""               |
        | null             | ""               |
        | 42               | ""               |
        | ["Add login"]    | ""               |

  Rule: issueType is issuetype.name when it is a string, otherwise "Task", the same default toIssueDto uses

    @boundary
    Scenario Outline: issuetype values
      When toIssueSpec("ACME-1", { "issuetype": <issuetype> }) is awaited
      Then issueType is <result>

      Examples:
        | issuetype          | result  |
        | { "name": "Bug" }  | "Bug"   |
        | { "name": "" }     | ""      |
        | { }                | "Task"  |
        | { "name": null }   | "Task"  |
        | { "name": 3 }      | "Task"  |
        | null               | "Task"  |
        | absent             | "Task"  |

  Rule: updated is used verbatim when it is a string, otherwise it is null

    @boundary
    Scenario Outline: updated values
      When toIssueSpec("ACME-1", { "updated": <updated> }) is awaited
      Then updated is <result>

      Examples:
        | updated                         | result                          |
        | "2026-10-20T09:15:00.000+0000"  | "2026-10-20T09:15:00.000+0000"  |
        | "not a date"                    | "not a date"                    |
        | ""                              | ""                              |
        | null                            | null                            |
        | absent                          | null                            |
        | 1729415700000                   | null                            |

  Rule: A string description has runs of spaces collapsed and is trimmed, an ADF node is flattened to its text, anything else becomes ""

    @happy
    Scenario: A plain-string description, as older endpoints send it, keeps its words and newlines
      When toIssueSpec("ACME-1", { "summary": "Fix the build", "description": "Line one\nLine two" }) is awaited
      Then descriptionText is "Line one\nLine two"
      And specHash is "401c829e08ad2a5a6a3cb4a6913afd15a8f35a9ceb9ddeb48a714539e0b50fa7"

    @boundary
    Scenario Outline: Whitespace other than newlines in a string description collapses to one space, and the ends are trimmed
      When toIssueSpec("ACME-1", { "description": <description> }) is awaited
      Then descriptionText is <text>

      Examples:
        | description        | text       |
        | "  a\r\nb  "       | "a \nb"    |
        | "a \t  b\n\n  c"   | "a b\n\n c" |

    @boundary
    Scenario: A description longer than 20,000 characters is truncated with a marker
      When toIssueSpec("ACME-1", { "description": a string of 20001 "x" characters }) is awaited
      Then descriptionText is 20000 "x" characters followed by "\n[truncated]"

    @boundary
    Scenario: A description of exactly 20,000 characters is kept whole
      When toIssueSpec("ACME-1", { "description": a string of 20000 "x" characters }) is awaited
      Then descriptionText is that same string

    @boundary
    Scenario Outline: A description that is neither a string nor an ADF node becomes ""
      When toIssueSpec("ACME-1", { "summary": "", "description": <description> }) is awaited
      Then descriptionText is ""
      And specHash is "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"

      Examples:
        | description |
        | absent      |
        | null        |
        | 42          |
        | true        |
        | ["text"]    |

    @happy
    Scenario Outline: ADF documents flatten to text
      When toIssueSpec("ACME-1", { "description": <description> }) is awaited
      Then descriptionText is <text>

      Examples:
        | case                              | description | text |
        | one paragraph                     | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]} | "Hello" |
        | marked runs join with no gap      | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello "},{"type":"text","text":"world","marks":[{"type":"strong"}]}]}]} | "Hello world" |
        | paragraphs join with a blank line | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"First"}]},{"type":"paragraph","content":[{"type":"text","text":"Second"}]}]} | "First\n\nSecond" |
        | hard break is a newline           | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"line one"},{"type":"hardBreak"},{"type":"text","text":"line two"}]}]} | "line one\nline two" |
        | heading keeps a Markdown marker   | {"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Goal"}]},{"type":"paragraph","content":[{"type":"text","text":"Ship it"}]}]} | "## Goal\n\nShip it" |
        | bullet list items get "- "        | {"type":"doc","content":[{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"b"}]}]}]}]} | "- a\n\n- b" |
        | ordered list numbers from order   | {"type":"doc","content":[{"type":"orderedList","attrs":{"order":3},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"b"}]}]}]}]} | "3. a\n\n4. b" |
        | code block is fenced              | {"type":"doc","content":[{"type":"codeBlock","attrs":{"language":"sh"},"content":[{"type":"text","text":"npm ci\nnpm test"}]}]} | "```sh\nnpm ci\nnpm test\n```" |
        | blockquote lines get "> "         | {"type":"doc","content":[{"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]},{"type":"paragraph","content":[{"type":"text","text":"b"}]}]}]} | "> a\n> b" |
        | table rows are pipe-separated     | {"type":"doc","content":[{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Field"}]}]},{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Value"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"1"}]}]}]}]}]} | "\| Field \| Value \|\n\n\| a \| 1 \|" |
        | mention uses attrs.text           | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"ask "},{"type":"mention","attrs":{"id":"123","text":"@Ann"}}]}]} | "ask @Ann" |
        | emoji uses shortName, not text    | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"ok "},{"type":"emoji","attrs":{"shortName":":smile:","text":"😄"}}]}]} | "ok :smile:" |
        | emoji with only shortName         | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"emoji","attrs":{"shortName":":smile:"}}]}]} | ":smile:" |
        | inline card uses attrs.url        | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"see "},{"type":"inlineCard","attrs":{"url":"https://acme.atlassian.net/browse/ACME-9"}}]}]} | "see https://acme.atlassian.net/browse/ACME-9" |
        | task items get checkboxes         | {"type":"doc","content":[{"type":"taskList","content":[{"type":"taskItem","content":[{"type":"text","text":"do "},{"type":"text","text":"this"}]},{"type":"taskItem","content":[{"type":"text","text":"then that"}]}]}]} | "- [ ] do this\n\n- [ ] then that" |
        | a DONE task item is ticked        | {"type":"doc","content":[{"type":"taskList","content":[{"type":"taskItem","attrs":{"state":"DONE"},"content":[{"type":"text","text":"done"}]},{"type":"taskItem","attrs":{"state":"TODO"},"content":[{"type":"text","text":"todo"}]}]}]} | "- [x] done\n\n- [ ] todo" |
        | unknown inline node adds nothing  | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"State: "},{"type":"status","attrs":{"text":"DONE"}},{"type":"text","text":" ok"}]}]} | "State:  ok" |
        | a root that is not a doc          | {"type":"paragraph","content":[{"type":"text","text":"bare"}]} | "bare" |

    @boundary
    Scenario Outline: Empty and degenerate ADF
      When toIssueSpec("ACME-1", { "description": <description> }) is awaited
      Then descriptionText is <text>

      Examples:
        | case                                         | description | text |
        | empty doc                                    | {"type":"doc","version":1,"content":[]} | "" |
        | doc with no content member                   | {"type":"doc","version":1} | "" |
        | empty object                                 | {} | "" |
        | an empty paragraph adds no block             | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]},{"type":"paragraph"},{"type":"paragraph","content":[{"type":"text","text":"b"}]}]} | "a\n\nb" |
        | a rule is a "---" block                      | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]},{"type":"rule"},{"type":"paragraph","content":[{"type":"text","text":"b"}]}]} | "a\n\n---\n\nb" |
        | trailing whitespace of a block is removed    | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"  padded  "}]}]} | "  padded" |

    @unhappy
    Scenario Outline: Malformed ADF members are ignored rather than thrown on
      When toIssueSpec("ACME-1", { "description": <description> }) is awaited
      Then it resolves without throwing
      And descriptionText is <text>

      Examples:
        | case                                   | description | text |
        | non-node items in content are skipped  | {"type":"doc","content":["x",null,7,[],{"type":"paragraph","content":[{"type":"text","text":"a"}]}]} | "a" |
        | text that is not a string              | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":42}]}]} | "" |
        | content that is not an array           | {"type":"doc","content":{"type":"paragraph"}} | "" |
        | text children of a node with no type   | {"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]} | "a\n\nb" |
        | mention without attrs                  | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"mention"}]}]} | "@unknown" |
        | inlineCard with a non-string url       | {"type":"doc","content":[{"type":"paragraph","content":[{"type":"inlineCard","attrs":{"url":5}}]}]} | "" |
        | text node's own content is ignored     | {"type":"text","text":"x","content":[{"type":"text","text":"y"}]} | "x" |

    @boundary
    Scenario: Deeply nested ADF does not overflow the stack, and content past 50 levels is dropped
      Given an ADF description of 100000 nested "blockquote" nodes, each with the next as its only content item, and the innermost holding one paragraph with text "deep"
      When toIssueSpec("ACME-1", { "description": description }) is awaited
      Then it resolves without throwing
      And descriptionText is "> " repeated 49 times followed by ">", with no "deep"

  Rule: Missing fields yield a spec of defaults rather than an error; a null or undefined fields block rejects

    @boundary
    Scenario: An empty fields block
      When toIssueSpec("ACME-1", {}) is awaited
      Then the result deep-equals:
        | key             | ACME-1                                                           |
        | summary         |                                                                  |
        | descriptionText |                                                                  |
        | issueType       | Task                                                             |
        | updated         | null                                                             |
        | specHash        | 6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d |

    @unhappy
    Scenario Outline: A fields block that is not an object rejects
      When toIssueSpec("ACME-1", <fields>) is awaited, with the types bypassed
      Then the promise rejects with a TypeError

      Examples:
        | fields    |
        | null      |
        | undefined |

  Rule: Concurrent toIssueSpec calls are independent

    @concurrency
    Scenario: Overlapping calls each resolve to their own issue's spec
      When toIssueSpec("ACME-1", { "summary": "Add login", "description": "Users can sign in." }) and toIssueSpec("ACME-2", { "summary": "Fix the build", "description": "Line one\nLine two" }) are started together and awaited with Promise.all
      Then the first has key "ACME-1" and specHash "24b1c29d416fdea96e63dcd8edf3ccbc14c9e53a0f019720cefd4803fcec0bf5"
      And the second has key "ACME-2" and specHash "401c829e08ad2a5a6a3cb4a6913afd15a8f35a9ceb9ddeb48a714539e0b50fa7"

  Rule: The package index re-exports the new surface

    @happy
    Scenario: The spec exports are reachable from the package entry point
      When "packages/jira/src/index.ts" is imported
      Then SPEC_FIELDS, specHash and toIssueSpec are the same values as those exported by "packages/jira/src/spec.ts"
      And adfToText is the same value as that exported by "packages/jira/src/adf.ts"
      And stripTrailingSlashes is the same value as that exported by "packages/jira/src/url.ts"
```

Decided:

- Hash algorithm and format: SHA-256 through `crypto.subtle`, written as 64 lowercase hex characters with no prefix.
- Hash input encoding: UTF-8 of `canon(summary) + "\u0000" + canon(descriptionText)`; the NUL separator keeps text moved between the two fields from colliding.
- Hash scope: only the summary and the description text count. Key, issue type and `updated` do not change it.
- Hash normalisation: line endings (`\r\n`, `\r`, `\n`) are unified, trailing whitespace on each line and whitespace at both ends are ignored. Whitespace inside a line, blank lines between text, and Unicode form (no NFC/NFD normalisation) are significant.
- `specHash` with a non-string argument rejects with a `TypeError`; the message is not specified.
- Missing or non-string `summary` becomes `""`, not `toIssueDto`'s `"(no summary)"` placeholder, so placeholder text never lands in the spec or the hash. A string summary is kept verbatim in `summary`, even though the hash ignores its surrounding whitespace.
- Missing or non-string `issuetype.name` becomes `"Task"`, matching `toIssueDto`. An empty string is kept.
- Non-string `updated` becomes `null`. Strings pass through unvalidated.
- `key` is passed through verbatim, with no validation.
- `fields` of `null` or `undefined` rejects with a `TypeError`; `{}` gives the all-defaults spec.
- Description: a string has every run of non-newline whitespace (including `\r` and tabs) collapsed to one space and is trimmed at both ends; an object is read as ADF; anything else becomes `""`.
- Description length: more than 20,000 characters is cut to 20,000 followed by `"\n[truncated]"`, for string and ADF descriptions alike.
- ADF flattening: the block and inline tables above. Blocks are joined with `"\n\n"`, trailing whitespace is removed from each block, and empty blocks are dropped. Headings, lists, task items, code blocks, blockquotes and tables keep Markdown-like markers. Unknown inline nodes add only their children's text. Non-node `content` items are skipped. A `mention` with no string `attrs.text` is `"@unknown"`; `emoji` uses `attrs.shortName` only.
- ADF nesting: content more than 50 levels below the root is dropped, and 100,000 levels resolve without a stack overflow.
- The result has exactly six own keys, and the input `fields` object is not mutated.
- Concurrent calls share no state, and each resolves to the result of its own input.
- `ISSUE_FIELDS` is unchanged. `index.ts` re-exports the new values, `adfToText`, `stripTrailingSlashes` and the type. `JiraClient` gains `issueSpec(keyOrId)`.
