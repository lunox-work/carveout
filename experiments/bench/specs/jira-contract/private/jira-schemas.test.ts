/**
 * Hidden tests for the Jira wire contract: the permissive `*Response` schemas
 * (what Atlassian sends) and the strict, flat `*Dto` schemas (what we hand on).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as indexModule from "../../src/index.js";
import {
  JIRA_STATUS_CATEGORIES,
  UNKNOWN_BUILD,
  accessibleResourceSchema,
  buildInfoSchema,
  handleSchema,
  jiraBoardDtoSchema,
  jiraBoardPageResponseSchema,
  jiraBoardResponseSchema,
  jiraIssueDtoSchema,
  jiraIssuePageDtoSchema,
  jiraIssuePageResponseSchema,
  jiraIssueResponseSchema,
  jiraSiteDtoSchema,
  jiraSprintDtoSchema,
  jiraSprintPageResponseSchema,
  jiraSprintResponseSchema,
  jiraStatusCategorySchema,
  todoSchema,
  tokenResponseSchema,
  type JiraBoardDto,
  type JiraIssueDto,
  type JiraSprintDto,
} from "../../src/index.js";
import * as buildInfoModule from "../../src/build-info.js";

const SITE = "https://acme.atlassian.net";

const validIssue: JiraIssueDto = {
  id: "10001",
  key: "PROJ-123",
  summary: "Fix the login redirect",
  status: "In Review",
  statusCategory: "indeterminate",
  assignee: "Dana",
  priority: "High",
  issueType: "Bug",
  labels: ["auth"],
  projectKey: "PROJ",
  parentKey: null,
  created: "2026-09-16T00:00:00.000+0000",
  updated: "2026-09-17T09:14:00.000+0000",
  dueDate: null,
  url: "https://acme.atlassian.net/browse/PROJ-123",
};

const validBoard: JiraBoardDto = {
  id: 7,
  name: "Platform",
  type: "scrum",
  projectKey: "PROJ",
  projectName: "Project",
};

const validSprint: JiraSprintDto = {
  id: 3,
  name: "Sprint 3",
  state: "active",
  startDate: null,
  endDate: null,
  goal: null,
};

const ISSUE_DTO_KEYS = [
  "id",
  "key",
  "summary",
  "status",
  "statusCategory",
  "assignee",
  "priority",
  "issueType",
  "labels",
  "projectKey",
  "parentKey",
  "created",
  "updated",
  "dueDate",
  "url",
] as const;

const NULLABLE_ISSUE_DTO_KEYS = [
  "assignee",
  "priority",
  "projectKey",
  "parentKey",
  "created",
  "updated",
  "dueDate",
  "url",
] as const;

/** A copy of `base` without `key`, for "(missing)" rows. */
function without<T extends object>(base: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...base };
  delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------
// @happy 2 / @unhappy 1: jiraStatusCategorySchema
// ---------------------------------------------------------------------------

// Extends "[happy-2] jiraStatusCategorySchema accepts each category":
// every element of the exported constant, in reverse order too.
test("[happy-2] hidden: every JIRA_STATUS_CATEGORIES entry parses to itself, in any order", () => {
  for (const value of [...JIRA_STATUS_CATEGORIES].reverse()) {
    assert.equal(jiraStatusCategorySchema.parse(value), value);
    assert.deepEqual(jiraStatusCategorySchema.safeParse(value), {
      success: true,
      data: value,
    });
  }
});

// Extends "[happy-2] JIRA_STATUS_CATEGORIES is Jira's three categories plus unknown, in order".
test("[happy-2] hidden: JIRA_STATUS_CATEGORIES has exactly four entries and the schema's options match it", () => {
  assert.equal(JIRA_STATUS_CATEGORIES.length, 4);
  assert.deepEqual(JIRA_STATUS_CATEGORIES, ["new", "indeterminate", "done", "unknown"]);
  assert.deepEqual(
    [...jiraStatusCategorySchema.options],
    ["new", "indeterminate", "done", "unknown"],
  );
});

// Extends both "[unhappy-1]" public tests: casing, padding, Jira display
// names, and non-strings are refused, never mapped onto a category.
test("[unhappy-1] hidden: jiraStatusCategorySchema refuses other casings, padding and Jira display names", () => {
  for (const value of [
    "New",
    "NEW",
    "Indeterminate",
    "DONE",
    "Unknown",
    " new",
    "done ",
    "In Progress",
    "in progress",
    "to do",
    "todo",
    "UNDEFINED",
  ]) {
    assert.equal(
      jiraStatusCategorySchema.safeParse(value).success,
      false,
      `accepted ${JSON.stringify(value)}`,
    );
  }
});

test("[unhappy-1] hidden: jiraStatusCategorySchema refuses non-string values", () => {
  for (const value of [undefined, null, 0, 1, true, {}, ["new"]]) {
    assert.equal(jiraStatusCategorySchema.safeParse(value).success, false);
  }
});

// ---------------------------------------------------------------------------
// @happy 3, @happy 4: jiraIssueResponseSchema
// ---------------------------------------------------------------------------

// Extends "[happy-3] jiraIssueResponseSchema parses an issue with no fields block".
test("[happy-3] hidden: jiraIssueResponseSchema parses other id/key pairs with no fields block unchanged", () => {
  for (const input of [
    { id: "1", key: "A-1" },
    { id: "99999999", key: "LONGPROJECT_2-4711" },
  ]) {
    const parsed = jiraIssueResponseSchema.parse(input);
    assert.deepEqual(parsed, input);
    assert.equal("fields" in parsed, false);
  }
});

const fullerIssueResponse = {
  id: "10002",
  key: "PROJ-124",
  fields: {
    summary: "Ship the board view",
    status: {
      name: "Done",
      statusCategory: { key: "done", name: "Done" },
    },
    assignee: { displayName: "Dana" },
    priority: { name: "High", key: "2" },
    parent: { key: "PROJ-100" },
    issuetype: { name: "Story", key: "story" },
    labels: ["auth", "ui", "backend"],
    project: { key: "PROJ", name: "Project" },
    created: "2026-09-16T00:00:00.000+0000",
    updated: "2026-09-17T09:14:00.000+0000",
    duedate: "2026-10-01",
  },
};

// Extends "[happy-4] jiraIssueResponseSchema parses a full Jira issue unchanged":
// every nullish object present instead of null.
test("[happy-4] hidden: jiraIssueResponseSchema parses an issue with assignee, priority, parent and dates present unchanged", () => {
  assert.deepEqual(
    jiraIssueResponseSchema.parse(fullerIssueResponse),
    fullerIssueResponse,
  );
});

// Extends "[happy-4] jiraIssueResponseSchema keeps the nulls Jira sent rather than dropping them":
// the other nullish members, with the rest absent.
test("[happy-4] hidden: jiraIssueResponseSchema keeps null created and labels-free fields unchanged", () => {
  const input = {
    id: "10003",
    key: "PROJ-125",
    fields: {
      assignee: null,
      priority: null,
      parent: null,
      created: null,
      updated: null,
      duedate: null,
    },
  };
  assert.deepEqual(jiraIssueResponseSchema.parse(input), input);
});

test("[happy-4] hidden: jiraIssueResponseSchema accepts undefined for the nullish members", () => {
  const input = {
    id: "10003",
    key: "PROJ-125",
    fields: {
      assignee: undefined,
      priority: undefined,
      parent: undefined,
      created: undefined,
      updated: undefined,
      duedate: undefined,
    },
  };
  assert.equal(jiraIssueResponseSchema.safeParse(input).success, true);
});

test("[happy-4] hidden: jiraIssueResponseSchema parses an empty label list and empty nested objects unchanged", () => {
  const input = {
    id: "1",
    key: "A-1",
    fields: {
      labels: [],
      status: {},
      assignee: {},
      priority: {},
      issuetype: {},
      project: {},
      parent: {},
    },
  };
  assert.deepEqual(jiraIssueResponseSchema.parse(input), input);
});

// ---------------------------------------------------------------------------
// @boundary 5, @boundary 6: permissive issue responses
// ---------------------------------------------------------------------------

// Extends "[boundary-5] jiraIssueResponseSchema parses an empty fields block".
test("[boundary-5] hidden: jiraIssueResponseSchema returns an empty fields block unchanged", () => {
  const input = { id: "2", key: "B-2", fields: {} };
  assert.deepEqual(jiraIssueResponseSchema.parse(input), input);
});

// Extends "[boundary-5] jiraIssueResponseSchema keeps an unrecognised status category key unchanged".
test("[boundary-5] hidden: jiraIssueResponseSchema keeps other unrecognised status category keys as free strings", () => {
  for (const key of ["undefined", "Done", "", "custom-category", "NEW"]) {
    const input = {
      id: "1",
      key: "A-1",
      fields: {
        status: { name: "Whatever", statusCategory: { key, name: "Weird" } },
      },
    };
    assert.deepEqual(jiraIssueResponseSchema.parse(input), input);
  }
});

test("[boundary-5] hidden: jiraIssueResponseSchema accepts a status without a category and a category without a key", () => {
  for (const status of [{ name: "Open" }, { statusCategory: {} }, { statusCategory: { name: "To Do" } }]) {
    const input = { id: "1", key: "A-1", fields: { status } };
    assert.deepEqual(jiraIssueResponseSchema.parse(input), input);
  }
});

// Extends "[boundary-6] jiraIssueResponseSchema keeps unknown keys at every level":
// every nested object, not just assignee.
test("[boundary-6] hidden: jiraIssueResponseSchema keeps unknown keys in every nested object", () => {
  const input = {
    id: "1",
    key: "A-1",
    self: "https://acme.atlassian.net/rest/api/3/issue/1",
    renderedFields: { description: "<p>x</p>" },
    fields: {
      description: { type: "doc", content: [] },
      customfield_10020: [{ id: 3, name: "Sprint 3" }],
      status: {
        name: "In Review",
        id: "10002",
        statusCategory: { key: "indeterminate", colorName: "yellow", id: 4 },
      },
      priority: { name: "High", key: "2", iconUrl: "https://x.test/p.png" },
      issuetype: { name: "Bug", subtask: false },
      project: { key: "PROJ", name: "Project", projectTypeKey: "software" },
      parent: { key: "PROJ-1", fields: { summary: "Epic" } },
      assignee: { displayName: "Dana", active: true, avatarUrls: { "48x48": "u" } },
    },
  };
  assert.deepEqual(jiraIssueResponseSchema.parse(input), input);
});

test("[boundary-6] hidden: jiraIssuePageResponseSchema keeps unknown keys on the page and on each issue", () => {
  const input = {
    expand: "schema,names",
    warningMessages: ["slow"],
    issues: [
      { id: "1", key: "A-1", expand: "x", fields: { customfield_1: null } },
      { id: "2", key: "A-2", fields: { status: { statusCategory: { colorName: "green" } } } },
    ],
  };
  assert.deepEqual(jiraIssuePageResponseSchema.parse(input), input);
});

// ---------------------------------------------------------------------------
// @unhappy 2: malformed issue responses
// ---------------------------------------------------------------------------

// Extends "[unhappy-2] jiraIssueResponseSchema refuses an issue without an id or a key".
test("[unhappy-2] hidden: jiraIssueResponseSchema refuses an empty object and null or numeric keys", () => {
  for (const input of [
    {},
    { fields: {} },
    { id: null, key: "A-1" },
    { id: "1", key: null },
    { id: "1", key: 1 },
    { id: "1", fields: { summary: "x" } },
  ]) {
    assert.equal(
      jiraIssueResponseSchema.safeParse(input).success,
      false,
      `accepted ${JSON.stringify(input)}`,
    );
  }
});

// Extends "[unhappy-2] jiraIssueResponseSchema refuses a numeric id and mistyped fields".
test("[unhappy-2] hidden: jiraIssueResponseSchema refuses other mistyped members of fields", () => {
  for (const fields of [
    { labels: ["auth", 1] },
    { labels: null },
    { summary: null },
    { status: "In Review" },
    { status: { name: 5 } },
    { status: { statusCategory: { key: 2 } } },
    { assignee: "Dana" },
    { assignee: { displayName: 5 } },
    { priority: "High" },
    { issuetype: { name: 1 } },
    { project: { key: 1 } },
    { parent: { key: 100 } },
    { created: 1_726_444_800_000 },
    { updated: false },
    { duedate: 20261001 },
  ]) {
    const input = { id: "1", key: "A-1", fields };
    assert.equal(
      jiraIssueResponseSchema.safeParse(input).success,
      false,
      `accepted ${JSON.stringify(fields)}`,
    );
  }
});

test("[unhappy-2] hidden: jiraIssueResponseSchema refuses null for members that are optional but not nullish", () => {
  for (const fields of [
    { status: null },
    { issuetype: null },
    { project: null },
  ]) {
    const input = { id: "1", key: "A-1", fields };
    assert.equal(
      jiraIssueResponseSchema.safeParse(input).success,
      false,
      `accepted ${JSON.stringify(fields)}`,
    );
  }
  assert.equal(
    jiraIssueResponseSchema.safeParse({ id: "1", key: "A-1", fields: null }).success,
    false,
  );
});

// ---------------------------------------------------------------------------
// @boundary 7, @unhappy 3: jiraIssuePageResponseSchema
// ---------------------------------------------------------------------------

// Extends "[boundary-7] jiraIssuePageResponseSchema parses a page without issues to an empty list":
// the default applies alongside cursors too.
test("[boundary-7] hidden: jiraIssuePageResponseSchema defaults issues to [] when only cursors are sent", () => {
  assert.deepEqual(jiraIssuePageResponseSchema.parse({ total: 0 }), {
    total: 0,
    issues: [],
  });
  assert.deepEqual(
    jiraIssuePageResponseSchema.parse({ nextPageToken: "tok", startAt: 0, maxResults: 50 }),
    { nextPageToken: "tok", startAt: 0, maxResults: 50, issues: [] },
  );
  assert.deepEqual(jiraIssuePageResponseSchema.parse({ issues: undefined }), {
    issues: [],
  });
});

test("[boundary-7] hidden: jiraIssuePageResponseSchema gives each parse its own empty list", () => {
  const first = jiraIssuePageResponseSchema.parse({});
  const second = jiraIssuePageResponseSchema.parse({});
  assert.deepEqual(first.issues, []);
  assert.deepEqual(second.issues, []);
});

// Extends "[boundary-7] jiraIssuePageResponseSchema returns pages with a token or offsets unchanged".
test("[boundary-7] hidden: jiraIssuePageResponseSchema returns a page of many issues with every cursor unchanged", () => {
  const issues = Array.from({ length: 50 }, (_, index) => ({
    id: String(10_000 + index),
    key: `PROJ-${index + 1}`,
  }));
  const input = { issues, total: 120, startAt: 50, maxResults: 50, nextPageToken: "next" };
  assert.deepEqual(jiraIssuePageResponseSchema.parse(input), input);
});

// Extends "[unhappy-3] jiraIssuePageResponseSchema refuses a page with one bad issue":
// the bad issue first, last, or in the middle of a longer page.
test("[unhappy-3] hidden: jiraIssuePageResponseSchema refuses a page with one bad issue at any position", () => {
  const good = (index: number) => ({ id: String(index), key: `A-${index}` });
  const bads = [{ id: "9" }, { key: "A-9" }, { id: 9, key: "A-9" }, { id: "9", key: "A-9", fields: { labels: "x" } }];
  for (const bad of bads) {
    for (const position of [0, 5, 9]) {
      const issues: unknown[] = Array.from({ length: 10 }, (_, index) => good(index));
      issues[position] = bad;
      assert.equal(
        jiraIssuePageResponseSchema.safeParse({ issues }).success,
        false,
        `accepted ${JSON.stringify(bad)} at ${position}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// @happy 5, @unhappy 4: jiraBoardResponseSchema
// ---------------------------------------------------------------------------

// Extends "[happy-5] jiraBoardResponseSchema parses a board with a type and location unchanged".
test("[happy-5] hidden: jiraBoardResponseSchema parses a kanban board with a partial location unchanged", () => {
  for (const input of [
    { id: 42, name: "Support", type: "kanban" },
    { id: 0, name: "", location: {} },
    { id: 8, name: "Ops", location: { displayName: "Ops (OPS)" } },
  ]) {
    assert.deepEqual(jiraBoardResponseSchema.parse(input), input);
  }
});

test("[happy-5] hidden: jiraBoardResponseSchema keeps unknown keys on the board and its location", () => {
  const input = {
    id: 7,
    name: "Platform",
    self: "https://acme.atlassian.net/rest/agile/1.0/board/7",
    location: { projectKey: "PROJ", projectId: 10000, avatarURI: "/a.png" },
  };
  assert.deepEqual(jiraBoardResponseSchema.parse(input), input);
});

// Extends "[unhappy-4] jiraBoardResponseSchema refuses a string id" and the missing-field test.
test("[unhappy-4] hidden: jiraBoardResponseSchema refuses null or mistyped ids and names", () => {
  for (const input of [
    {},
    { id: null, name: "Platform" },
    { id: 7, name: null },
    { id: 7, name: 7 },
    { id: "", name: "Platform" },
    { id: "0", name: "Platform", type: "scrum" },
    { id: 7, name: "Platform", type: 1 },
    { id: 7, name: "Platform", location: { projectKey: 1 } },
  ]) {
    assert.equal(
      jiraBoardResponseSchema.safeParse(input).success,
      false,
      `accepted ${JSON.stringify(input)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// @boundary 8: board and sprint pages
// ---------------------------------------------------------------------------

// Extends "[boundary-8] board and sprint pages without values parse to an empty list".
test("[boundary-8] hidden: board and sprint pages default values to [] alongside isLast and offsets", () => {
  assert.deepEqual(jiraBoardPageResponseSchema.parse({ isLast: true }), {
    isLast: true,
    values: [],
  });
  assert.deepEqual(
    jiraBoardPageResponseSchema.parse({ startAt: 0, maxResults: 50, total: 0 }),
    { startAt: 0, maxResults: 50, total: 0, values: [] },
  );
  assert.deepEqual(jiraSprintPageResponseSchema.parse({ isLast: false }), {
    isLast: false,
    values: [],
  });
});

// Extends "[boundary-8] jiraBoardPageResponseSchema returns a last page with values unchanged".
test("[boundary-8] hidden: board and sprint pages with several values and cursors come back unchanged", () => {
  const boards = {
    values: [
      { id: 7, name: "Platform", type: "scrum" },
      { id: 8, name: "Ops", location: { projectKey: "OPS" } },
      { id: 9, name: "Web" },
    ],
    isLast: false,
    startAt: 0,
    maxResults: 3,
    total: 10,
  };
  assert.deepEqual(jiraBoardPageResponseSchema.parse(boards), boards);
  const sprints = {
    values: [
      { id: 1, name: "Sprint 1", state: "closed" },
      { id: 2, name: "Sprint 2", startDate: null, endDate: null, goal: null },
    ],
    isLast: true,
  };
  assert.deepEqual(jiraSprintPageResponseSchema.parse(sprints), sprints);
});

test("[boundary-8] hidden: board and sprint pages keep unknown keys", () => {
  const boards = { values: [{ id: 7, name: "Platform", extra: 1 }], self: "s" };
  assert.deepEqual(jiraBoardPageResponseSchema.parse(boards), boards);
  const sprints = { values: [{ id: 3, name: "Sprint 3", originBoardId: 7 }], maxResults: 50 };
  assert.deepEqual(jiraSprintPageResponseSchema.parse(sprints), sprints);
});

// ---------------------------------------------------------------------------
// @happy 6, @unhappy 5: jiraSprintResponseSchema
// ---------------------------------------------------------------------------

// Extends "[happy-6] jiraSprintResponseSchema parses a sprint with null dates and goal".
test("[happy-6] hidden: jiraSprintResponseSchema parses a sprint with string dates and goal unchanged", () => {
  const input = {
    id: 4,
    name: "Sprint 4",
    state: "closed",
    startDate: "2026-09-01T00:00:00.000Z",
    endDate: "2026-09-15T00:00:00.000Z",
    goal: "Ship the board view",
  };
  assert.deepEqual(jiraSprintResponseSchema.parse(input), input);
});

test("[happy-6] hidden: jiraSprintResponseSchema keeps unknown keys and mixes null and string dates", () => {
  const input = {
    id: 5,
    name: "Sprint 5",
    state: "future",
    startDate: "2026-10-01",
    endDate: null,
    originBoardId: 7,
    self: "s",
  };
  assert.deepEqual(jiraSprintResponseSchema.parse(input), input);
});

// Extends "[unhappy-5] jiraSprintResponseSchema refuses a string id".
test("[unhappy-5] hidden: jiraSprintResponseSchema refuses a string id even with every other field present", () => {
  for (const id of ["3", "", "0"]) {
    assert.equal(
      jiraSprintResponseSchema.safeParse({ ...validSprint, id }).success,
      false,
    );
  }
});

// Extends "[unhappy-5] jiraSprintPageResponseSchema refuses a page holding a sprint with a string id".
test("[unhappy-5] hidden: jiraSprintPageResponseSchema refuses a string-id sprint after valid ones", () => {
  const input = {
    values: [
      { id: 1, name: "Sprint 1" },
      { id: 2, name: "Sprint 2" },
      { id: "3", name: "Sprint 3" },
    ],
    isLast: true,
  };
  assert.equal(jiraSprintPageResponseSchema.safeParse(input).success, false);
});

// ---------------------------------------------------------------------------
// @happy 7, @unhappy 6: tokenResponseSchema
// ---------------------------------------------------------------------------

// Extends "[happy-7] tokenResponseSchema parses a full token response unchanged".
test("[happy-7] hidden: tokenResponseSchema parses partial token responses and keeps unknown keys", () => {
  for (const input of [
    { access_token: "at-2", expires_in: 0 },
    { access_token: "at", expires_in: 3600, refresh_token: "rt" },
    { access_token: "at", expires_in: 3600, scope: "read:jira-user" },
    { access_token: "at", expires_in: 3600, token_type: "Bearer", id_token: "x", extra: { a: 1 } },
  ]) {
    assert.deepEqual(tokenResponseSchema.parse(input), input);
  }
});

// Extends both "[unhappy-6]" public tests.
test("[unhappy-6] hidden: tokenResponseSchema refuses an empty object and null or mistyped required fields", () => {
  for (const input of [
    {},
    { refresh_token: "rt", scope: "s" },
    { access_token: null, expires_in: 3600 },
    { access_token: 1, expires_in: 3600 },
    { access_token: "at", expires_in: null },
    { access_token: "at", refresh_token: "rt", scope: "s", token_type: "Bearer" },
  ]) {
    assert.equal(
      tokenResponseSchema.safeParse(input).success,
      false,
      `accepted ${JSON.stringify(input)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// @boundary 9, @unhappy 7: accessibleResourceSchema
// ---------------------------------------------------------------------------

// Extends "[boundary-9] accessibleResourceSchema gives a resource without scopes an empty list".
test("[boundary-9] hidden: accessibleResourceSchema defaults scopes for another site and keeps unknown keys", () => {
  const input = { id: "cloud-2", url: "https://other.atlassian.net/", name: "Other", extra: true };
  assert.deepEqual(accessibleResourceSchema.parse(input), { ...input, scopes: [] });
  assert.deepEqual(
    accessibleResourceSchema.parse({ id: "c", url: SITE, name: "Acme", scopes: undefined }),
    { id: "c", url: SITE, name: "Acme", scopes: [] },
  );
});

test("[boundary-9] hidden: accessibleResourceSchema keeps the scopes Atlassian sent", () => {
  const input = {
    id: "cloud-1",
    url: SITE,
    name: "Acme",
    avatarUrl: "https://x.test/a.png",
    scopes: ["read:jira-work", "write:jira-work", "offline_access"],
  };
  assert.deepEqual(accessibleResourceSchema.parse(input), input);
});

// Extends both "[unhappy-7]" public tests.
test("[unhappy-7] hidden: accessibleResourceSchema refuses an empty object and null or mistyped id, url or name", () => {
  for (const input of [
    {},
    { scopes: [] },
    { id: null, url: SITE, name: "Acme" },
    { id: 1, url: SITE, name: "Acme" },
    { id: "cloud-1", url: null, name: "Acme" },
    { id: "cloud-1", url: SITE, name: 5 },
    { cloudId: "cloud-1", url: SITE, name: "Acme" },
  ]) {
    assert.equal(
      accessibleResourceSchema.safeParse(input).success,
      false,
      `accepted ${JSON.stringify(input)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// @happy 8, @happy 9: jiraIssueDtoSchema
// ---------------------------------------------------------------------------

// Extends "[happy-8] jiraIssueDtoSchema parses the valid issue DTO to itself".
test("[happy-8] hidden: jiraIssueDtoSchema parses other well-formed issue DTOs to themselves", () => {
  for (const statusCategory of JIRA_STATUS_CATEGORIES) {
    const input = {
      ...validIssue,
      id: "20002",
      key: "OPS-7",
      statusCategory,
      labels: ["a", "b", "c"],
      parentKey: "OPS-1",
      dueDate: "2026-10-01",
    };
    assert.deepEqual(jiraIssueDtoSchema.parse(input), input);
  }
  const noLabels = { ...validIssue, labels: [] };
  assert.deepEqual(jiraIssueDtoSchema.parse(noLabels), noLabels);
});

test("[happy-8] hidden: jiraIssueDtoSchema output has exactly the fifteen issue DTO keys", () => {
  const parsed = jiraIssueDtoSchema.parse(validIssue);
  assert.deepEqual(Object.keys(parsed).sort(), [...ISSUE_DTO_KEYS].sort());
});

// Extends "[happy-9] jiraIssueDtoSchema accepts a null url on its own".
test("[happy-9] hidden: jiraIssueDtoSchema accepts null in each nullable field on its own", () => {
  for (const key of NULLABLE_ISSUE_DTO_KEYS) {
    const input = { ...validIssue, [key]: null };
    assert.deepEqual(jiraIssueDtoSchema.parse(input), input, `refused null ${key}`);
  }
});

// Extends "[happy-9] jiraIssueDtoSchema accepts null in every nullable field".
test("[happy-9] hidden: jiraIssueDtoSchema keeps every nullable field null rather than dropping it", () => {
  const input: Record<string, unknown> = { ...validIssue };
  for (const key of NULLABLE_ISSUE_DTO_KEYS) input[key] = null;
  const parsed = jiraIssueDtoSchema.parse(input) as Record<string, unknown>;
  for (const key of NULLABLE_ISSUE_DTO_KEYS) {
    assert.equal(key in parsed, true, `${key} dropped`);
    assert.equal(parsed[key], null);
  }
});

// ---------------------------------------------------------------------------
// @boundary 10, @boundary 11: strip and plain strings
// ---------------------------------------------------------------------------

// Extends "[boundary-10] jiraIssueDtoSchema drops a description and other unknown keys".
test("[boundary-10] hidden: jiraIssueDtoSchema drops Jira-shaped and other unknown keys", () => {
  const parsed = jiraIssueDtoSchema.parse({
    ...validIssue,
    description: { type: "doc", content: [{ text: "secret client text" }] },
    renderedFields: { description: "<p>secret</p>" },
    boardId: 7,
    issuetype: { name: "Bug" },
    duedate: "2026-10-01",
    customfield_10010: 5,
  });
  assert.deepEqual(parsed, validIssue);
  assert.deepEqual(Object.keys(parsed).sort(), [...ISSUE_DTO_KEYS].sort());
});

test("[boundary-10] hidden: jiraIssuePageDtoSchema drops unknown keys on the page and on each issue", () => {
  const parsed = jiraIssuePageDtoSchema.parse({
    issues: [{ ...validIssue, description: "secret client text" }],
    total: 1,
    startAt: 0,
    expand: "names",
  });
  assert.deepEqual(parsed, { issues: [validIssue], total: 1 });
});

// Extends "[boundary-11] jiraIssueDtoSchema accepts an empty summary, a free-form key and a free-form created".
test("[boundary-11] hidden: jiraIssueDtoSchema accepts empty and free-form strings in every string field", () => {
  const input = {
    ...validIssue,
    id: "",
    key: "proj-1",
    summary: " ",
    status: "",
    issueType: "",
    assignee: "",
    priority: "",
    projectKey: "",
    parentKey: "not a key",
    created: "",
    updated: "last week",
    dueDate: "soon",
    url: "not a url",
    labels: ["", " "],
  };
  assert.deepEqual(jiraIssueDtoSchema.parse(input), input);
});

test("[boundary-11] hidden: jiraIssueDtoSchema accepts a relative url and a lowercase key on their own", () => {
  for (const patch of [{ url: "/browse/PROJ-123" }, { key: "a-1" }, { key: "PROJ123" }]) {
    const input = { ...validIssue, ...patch };
    assert.deepEqual(jiraIssueDtoSchema.parse(input), input);
  }
});

// ---------------------------------------------------------------------------
// @unhappy 8: malformed issue DTOs
// ---------------------------------------------------------------------------

// Extends "[unhappy-8] jiraIssueDtoSchema refuses missing nullable keys, ...":
// every key is required, not only assignee and url.
test("[unhappy-8] hidden: jiraIssueDtoSchema refuses the valid DTO with any one key missing", () => {
  for (const key of ISSUE_DTO_KEYS) {
    assert.equal(
      jiraIssueDtoSchema.safeParse(without(validIssue, key)).success,
      false,
      `accepted a DTO without ${key}`,
    );
  }
});

test("[unhappy-8] hidden: jiraIssueDtoSchema refuses undefined in each nullable field", () => {
  for (const key of NULLABLE_ISSUE_DTO_KEYS) {
    assert.equal(
      jiraIssueDtoSchema.safeParse({ ...validIssue, [key]: undefined }).success,
      false,
      `accepted undefined ${key}`,
    );
  }
});

test("[unhappy-8] hidden: jiraIssueDtoSchema refuses null in each non-nullable field", () => {
  for (const key of ["id", "key", "summary", "status", "statusCategory", "issueType", "labels"] as const) {
    assert.equal(
      jiraIssueDtoSchema.safeParse({ ...validIssue, [key]: null }).success,
      false,
      `accepted null ${key}`,
    );
  }
});

// Extends "[unhappy-8] jiraIssueDtoSchema refuses a status category outside the enum".
test("[unhappy-8] hidden: jiraIssueDtoSchema refuses other status categories and mistyped values", () => {
  for (const patch of [
    { statusCategory: "Done" },
    { statusCategory: "undefined" },
    { statusCategory: "In Progress" },
    { statusCategory: "" },
    { labels: "auth" },
    { labels: ["auth", 1] },
    { id: 0 },
    { key: 123 },
    { assignee: { displayName: "Dana" } },
    { priority: { name: "High" } },
    { url: 1 },
  ]) {
    assert.equal(
      jiraIssueDtoSchema.safeParse({ ...validIssue, ...patch }).success,
      false,
      `accepted ${JSON.stringify(patch)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// @happy 10, @unhappy 9: jiraIssuePageDtoSchema
// ---------------------------------------------------------------------------

// Extends "[happy-10] jiraIssuePageDtoSchema parses a page of the valid issue DTO unchanged".
test("[happy-10] hidden: jiraIssuePageDtoSchema parses a page of several issues with every cursor unchanged", () => {
  const issues = Array.from({ length: 25 }, (_, index) => ({
    ...validIssue,
    id: String(10_001 + index),
    key: `PROJ-${123 + index}`,
    url: index % 2 === 0 ? null : `${SITE}/browse/PROJ-${123 + index}`,
  }));
  const input = { issues, total: 100, nextStartAt: 25, nextPageToken: "tok-2" };
  assert.deepEqual(jiraIssuePageDtoSchema.parse(input), input);
});

// Extends "[happy-10] jiraIssuePageDtoSchema returns empty pages with offsets or a token unchanged".
test("[happy-10] hidden: jiraIssuePageDtoSchema returns pages with a single cursor unchanged", () => {
  for (const input of [
    { issues: [] },
    { issues: [], total: 7 },
    { issues: [], nextStartAt: 0 },
    { issues: [validIssue], nextPageToken: "" },
  ]) {
    assert.deepEqual(jiraIssuePageDtoSchema.parse(input), input);
  }
});

// Extends both "[unhappy-9]" public tests.
test("[unhappy-9] hidden: jiraIssuePageDtoSchema refuses a page whose issues are absent, undefined or null", () => {
  for (const input of [
    { nextStartAt: 50 },
    { total: 3, nextStartAt: 50, nextPageToken: "tok" },
    { issues: undefined },
    { issues: null },
  ]) {
    assert.equal(
      jiraIssuePageDtoSchema.safeParse(input).success,
      false,
      `accepted ${JSON.stringify(input)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// @happy 11, @unhappy 10: jiraBoardDtoSchema
// ---------------------------------------------------------------------------

// Extends "[happy-11] jiraBoardDtoSchema parses the valid board DTO to itself"
// and "[happy-11] jiraBoardDtoSchema accepts a null project key and name".
test("[happy-11] hidden: jiraBoardDtoSchema parses other boards and null project fields to themselves", () => {
  for (const input of [
    { ...validBoard, projectKey: null, projectName: null },
    { ...validBoard, projectKey: null },
    { ...validBoard, projectName: null },
    { id: 42, name: "Support", type: "kanban", projectKey: "SUP", projectName: "Support" },
    { id: 0, name: "", type: "", projectKey: "", projectName: "" },
  ]) {
    assert.deepEqual(jiraBoardDtoSchema.parse(input), input);
  }
});

test("[happy-11] hidden: jiraBoardDtoSchema drops unknown keys", () => {
  assert.deepEqual(
    jiraBoardDtoSchema.parse({
      ...validBoard,
      location: { projectKey: "PROJ" },
      self: "s",
      boardId: "jrb_7",
    }),
    validBoard,
  );
});

// Extends both "[unhappy-10]" public tests.
test("[unhappy-10] hidden: jiraBoardDtoSchema refuses the valid board with any one key missing", () => {
  for (const key of ["id", "name", "type", "projectKey", "projectName"] as const) {
    assert.equal(
      jiraBoardDtoSchema.safeParse(without(validBoard, key)).success,
      false,
      `accepted a board without ${key}`,
    );
  }
});

test("[unhappy-10] hidden: jiraBoardDtoSchema refuses null or mistyped ids, names and types", () => {
  for (const patch of [
    { id: null },
    { id: "jrb_7" },
    { name: null },
    { type: null },
    { type: undefined },
    { projectName: undefined },
    { projectKey: 1 },
  ]) {
    assert.equal(
      jiraBoardDtoSchema.safeParse({ ...validBoard, ...patch }).success,
      false,
      `accepted ${JSON.stringify(patch)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// @happy 12, @unhappy 11: jiraSprintDtoSchema
// ---------------------------------------------------------------------------

// Extends "[happy-12] jiraSprintDtoSchema parses a sprint with null dates and goal to itself".
test("[happy-12] hidden: jiraSprintDtoSchema parses sprints with string dates and goal to themselves", () => {
  for (const input of [
    {
      id: 4,
      name: "Sprint 4",
      state: "closed",
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-15T00:00:00.000Z",
      goal: "Ship it",
    },
    { ...validSprint, state: "future", startDate: "2026-10-01" },
    { ...validSprint, goal: "" },
  ]) {
    assert.deepEqual(jiraSprintDtoSchema.parse(input), input);
  }
});

test("[happy-12] hidden: jiraSprintDtoSchema drops unknown keys", () => {
  assert.deepEqual(
    jiraSprintDtoSchema.parse({ ...validSprint, originBoardId: 7, self: "s" }),
    validSprint,
  );
});

// Extends both "[unhappy-11]" public tests.
test("[unhappy-11] hidden: jiraSprintDtoSchema refuses a missing state even with string dates, and a null or numeric state", () => {
  const dated = {
    id: 4,
    name: "Sprint 4",
    startDate: "2026-09-01",
    endDate: "2026-09-15",
    goal: "Ship it",
  };
  for (const input of [
    dated,
    { ...validSprint, state: null },
    { ...validSprint, state: 1 },
  ]) {
    assert.equal(
      jiraSprintDtoSchema.safeParse(input).success,
      false,
      `accepted ${JSON.stringify(input)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// @happy 13, @unhappy 12: jiraSiteDtoSchema
// ---------------------------------------------------------------------------

const siteDto = { cloudId: "cloud-1", url: SITE, name: "Acme" };

// Extends "[happy-13] jiraSiteDtoSchema drops scopes": scopes alongside an avatar.
test("[happy-13] hidden: jiraSiteDtoSchema drops scopes but keeps the avatar", () => {
  const withAvatar = { ...siteDto, avatarUrl: "https://x.test/a.png" };
  assert.deepEqual(
    jiraSiteDtoSchema.parse({
      ...withAvatar,
      scopes: ["read:jira-work", "write:jira-work"],
    }),
    withAvatar,
  );
});

test("[happy-13] hidden: jiraSiteDtoSchema drops other unknown keys and an accessible resource's id", () => {
  const parsed = jiraSiteDtoSchema.parse({
    ...siteDto,
    id: "cloud-1",
    scopes: [],
    extra: true,
  });
  assert.deepEqual(parsed, siteDto);
  assert.equal("scopes" in parsed, false);
  assert.equal("avatarUrl" in parsed, false);
});

// Extends "[happy-13] jiraSiteDtoSchema parses a site with or without an avatar unchanged".
test("[happy-13] hidden: jiraSiteDtoSchema parses another site unchanged", () => {
  const input = {
    cloudId: "11111111-2222-3333-4444-555555555555",
    url: "https://other.atlassian.net/",
    name: "",
  };
  assert.deepEqual(jiraSiteDtoSchema.parse(input), input);
});

// Extends both "[unhappy-12]" public tests.
test("[unhappy-12] hidden: jiraSiteDtoSchema refuses a missing cloudId even with an avatar and scopes, and a null cloudId", () => {
  for (const input of [
    { url: SITE, name: "Acme", avatarUrl: "https://x.test/a.png", scopes: [] },
    { ...siteDto, cloudId: null },
    { ...siteDto, cloudId: 1 },
    { ...siteDto, cloudId: undefined },
  ]) {
    assert.equal(
      jiraSiteDtoSchema.safeParse(input).success,
      false,
      `accepted ${JSON.stringify(input)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// @happy 14: the existing contract is unchanged
// ---------------------------------------------------------------------------

// Extends "[happy-14] todoSchema still parses a well-formed todo to itself".
test("[happy-14] hidden: todoSchema still parses a done todo with another id to itself", () => {
  const input = {
    id: "todo_42",
    title: "ship the jira contract",
    done: true,
    createdAt: "2026-11-04T12:30:00.000Z",
  };
  assert.deepEqual(todoSchema.parse(input), input);
});

// Extends "[happy-14] handleSchema still lowercases and trims, ...".
test("[happy-14] hidden: handleSchema still lowercases and trims other handles", () => {
  assert.equal(handleSchema.parse("FeverSoul"), "feversoul");
  assert.equal(handleSchema.parse("\tFEVERSOUL \n"), "feversoul");
});

// Extends "[happy-14] ... the build-info exports are still re-exported":
// every build-info export, not only the two the public test names.
test("[happy-14] hidden: every export of build-info is re-exported unchanged from the index", () => {
  const index = indexModule as unknown as Record<string, unknown>;
  const buildInfo = buildInfoModule as unknown as Record<string, unknown>;
  const names = Object.keys(buildInfo);
  assert.ok(names.includes("buildInfoSchema"));
  assert.ok(names.includes("UNKNOWN_BUILD"));
  for (const name of names) {
    assert.equal(index[name], buildInfo[name], `${name} is not re-exported`);
  }
  assert.equal(buildInfoSchema, buildInfoModule.buildInfoSchema);
  assert.equal(UNKNOWN_BUILD, buildInfoModule.UNKNOWN_BUILD);
});

test("[happy-14] hidden: the existing schema exports are still present on the index", () => {
  const index = indexModule as unknown as Record<string, unknown>;
  for (const name of [
    "titleSchema",
    "todoFilterSchema",
    "handleSchema",
    "todoSchema",
    "todoListSchema",
    "createTodoSchema",
    "updateTodoSchema",
    "ORGANIZATION_ROLES",
    "organizationRoleSchema",
    "organizationSummarySchema",
    "membershipSchema",
    "membershipListSchema",
    "organizationMemberSchema",
    "organizationMemberListSchema",
    "pendingInvitationSchema",
    "pendingInvitationListSchema",
    "inviteMemberSchema",
    "errorSchema",
  ]) {
    assert.notEqual(index[name], undefined, `${name} is missing`);
  }
});
