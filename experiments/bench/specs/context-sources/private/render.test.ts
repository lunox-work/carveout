import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type GithubContext,
  type JiraContext,
  jiraContextFields,
  renderSourceContext,
} from "../../src/sources.js";

/** The filled-in issue "PAY-42" of the jiraContextFields rule. */
const PAY_42: JiraContext = {
  key: "PAY-42",
  issueType: "Story",
  status: "In Progress",
  statusCategory: "indeterminate",
  priority: "High",
  labels: ["billing"],
  components: ["api"],
  fixVersions: [],
  parentKey: "PAY-1",
  dueDate: null,
  storyPoints: 5,
  originalEstimateSeconds: 28800,
  remainingEstimateSeconds: null,
  votes: 0,
  watchers: 3,
  subtaskCount: 2,
  links: [{ type: "Blocks", direction: "outward", key: "PAY-50", done: false }],
  updated: "2026-10-01T10:00:00.000+0000",
};

const ACME_PAY: GithubContext = {
  fullName: "acme/pay",
  branch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  documents: [
    { path: "README.md", bytes: 20, text: "# Pay\nCharges cards.", truncated: false },
    { path: "docs/setup.md", bytes: 30000, text: "Run make up.", truncated: true },
  ],
  omitted: 2,
};

const JIRA_SECTION =
  "Jira fields:\n" +
  '{"issueType":"Story","status":"In Progress","priority":"High","labels":["billing"],"components":["api"],"storyPoints":5,"originalEstimateHours":8,"votes":0,"watchers":3,"subtasks":2,"hasParent":true,"links":[{"type":"Blocks","direction":"outward","done":false}]}';

/** An issue with nothing set beyond `key`, with `overrides` applied. */
function bare(key: string, overrides: Partial<JiraContext> = {}): JiraContext {
  return {
    key,
    issueType: null,
    status: null,
    statusCategory: null,
    priority: null,
    labels: [],
    components: [],
    fixVersions: [],
    parentKey: null,
    dueDate: null,
    storyPoints: null,
    originalEstimateSeconds: null,
    remainingEstimateSeconds: null,
    votes: null,
    watchers: null,
    subtaskCount: 0,
    links: [],
    updated: null,
    ...overrides,
  };
}

// Extends "[happy-9] renderSourceContext with both sources".
test("[happy-9] several documents each get a block, in the order given, beside another issue", () => {
  const rendered = renderSourceContext({
    jira: bare("WEB-3", { issueType: "Task" }),
    github: {
      fullName: "acme/web",
      branch: "develop",
      commitSha: "fedcba9876543210fedcba9876543210fedcba98",
      documents: [
        { path: "docs/z.md", bytes: 6, text: "Z text", truncated: false },
        { path: "README.md", bytes: 99, text: "line 1\n\nline 3", truncated: true },
        { path: "a b/notes.md", bytes: 21, text: "--- not a heading ---", truncated: false },
      ],
      omitted: 9,
    },
  });
  assert.equal(
    rendered,
    'Jira fields:\n{"issueType":"Task"}\n\n' +
      "Repository documents:\n\n" +
      "--- docs/z.md ---\nZ text\n\n" +
      "--- README.md (cut short) ---\nline 1\n\nline 3\n\n" +
      "--- a b/notes.md ---\n--- not a heading ---",
  );
});

// Extends "[happy-9] no caps apply when rendering, and the key, repository and commit are not rendered".
test("[happy-9] the Jira line is JSON.stringify of jiraContextFields for the issue given", () => {
  const issue = bare("OPS-8", {
    priority: "Low",
    labels: ["x", "y"],
    remainingEstimateSeconds: 5400,
    parentKey: "OPS-1",
    links: [{ type: "Relates", direction: "inward", key: "OPS-2", done: true }],
  });
  const github: GithubContext = {
    ...ACME_PAY,
    documents: [{ path: "x.md", bytes: 1, text: "x", truncated: false }],
  };
  assert.equal(
    renderSourceContext({ jira: issue, github }),
    `Jira fields:\n${JSON.stringify(jiraContextFields(issue))}\n\nRepository documents:\n\n--- x.md ---\nx`,
  );
});

// Extends "[happy-10] renderSourceContext with only Jira".
test("[happy-10] only Jira, for another issue, gives its two lines", () => {
  assert.equal(
    renderSourceContext({
      jira: bare("OPS-11", {
        status: "Blocked",
        fixVersions: ["3.1"],
        votes: 0,
        links: [{ type: "Blocks", direction: "outward", key: "OPS-12", done: false }],
      }),
      github: null,
    }),
    'Jira fields:\n{"status":"Blocked","fixVersions":["3.1"],"votes":0,"links":[{"type":"Blocks","direction":"outward","done":false}]}',
  );
});

// Extends "[happy-10] only Jira names neither the issue nor what it links to".
test("[happy-10] an issue with no fields set still gives its Jira section", () => {
  assert.equal(
    renderSourceContext({ jira: bare("OPS-1"), github: null }),
    "Jira fields:\n{}",
  );
});

// Extends "[happy-11] renderSourceContext with only the repository".
test("[happy-11] only the repository, with many documents and texts rendered exactly as given", () => {
  const documents = Array.from({ length: 20 }, (_, index) => ({
    path: `docs/p${index}.md`,
    bytes: index,
    text: index === 3 ? "" : index === 7 ? "a\r\nb  " : `text ${index}`,
    truncated: index % 5 === 0,
  }));
  const expected = [
    "Repository documents:",
    ...documents.map(
      (document) =>
        `--- ${document.path}${document.truncated ? " (cut short)" : ""} ---\n${document.text}`,
    ),
  ].join("\n\n");
  assert.equal(
    renderSourceContext({ jira: null, github: { ...ACME_PAY, documents, omitted: 0 } }),
    expected,
  );
});

// Extends "[happy-11] a lone truncated document's text is rendered as given, with nothing added after it".
test("[happy-11] a lone document that is not cut short has a plain heading", () => {
  assert.equal(
    renderSourceContext({
      jira: null,
      github: {
        fullName: "o/r",
        branch: "b",
        commitSha: "c",
        documents: [{ path: "GUIDE.md", bytes: 3, text: "Use it.", truncated: false }],
        omitted: 40,
      },
    }),
    "Repository documents:\n\n--- GUIDE.md ---\nUse it.",
  );
});

// Extends "[boundary-14] renderSourceContext with neither source".
test("[boundary-14] neither source gives \"\" from a frozen argument, every call", () => {
  const context = Object.freeze({ jira: null, github: null });
  assert.equal(renderSourceContext(context), "");
  assert.equal(renderSourceContext(context), "");
});

// Extends "[boundary-15] a repository with no documents contributes nothing".
test("[boundary-15] a repository with no documents contributes nothing, however many were omitted", () => {
  for (const omitted of [12, 1000]) {
    assert.equal(
      renderSourceContext({
        jira: null,
        github: {
          fullName: "acme/empty",
          branch: "trunk",
          commitSha: "abc",
          documents: [],
          omitted,
        },
      }),
      "",
      String(omitted),
    );
    assert.equal(
      renderSourceContext({
        jira: PAY_42,
        github: { ...ACME_PAY, documents: [], omitted },
      }),
      JIRA_SECTION,
      String(omitted),
    );
  }
});
