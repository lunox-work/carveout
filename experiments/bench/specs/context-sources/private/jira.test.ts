import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type JiraContext,
  type JiraIssueLinkContext,
  jiraContextFields,
} from "../../src/sources.js";

const FIELD_ORDER = [
  "issueType",
  "status",
  "priority",
  "labels",
  "components",
  "fixVersions",
  "dueDate",
  "storyPoints",
  "originalEstimateHours",
  "remainingEstimateHours",
  "votes",
  "watchers",
  "subtasks",
  "hasParent",
  "links",
];

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

// Extends "[happy-8] a filled-in issue".
test("[happy-8] another filled-in issue, with two links", () => {
  const issue = bare("WEB-7", {
    issueType: "Bug",
    status: "To Do",
    statusCategory: "new",
    priority: "Highest",
    labels: ["ui", "a11y"],
    components: ["web"],
    fixVersions: ["2026.11"],
    parentKey: "WEB-1",
    dueDate: "2026-12-24",
    storyPoints: 13,
    originalEstimateSeconds: 1800,
    remainingEstimateSeconds: 9000,
    votes: 2,
    watchers: 0,
    subtaskCount: 1,
    links: [
      { type: "Blocks", direction: "inward", key: "WEB-9", done: true },
      { type: "Relates", direction: "outward", key: null, done: false },
    ],
    updated: "2026-10-02T08:30:00.000+0000",
  });
  assert.equal(
    JSON.stringify(jiraContextFields(issue)),
    '{"issueType":"Bug","status":"To Do","priority":"Highest","labels":["ui","a11y"],"components":["web"],"fixVersions":["2026.11"],"dueDate":"2026-12-24","storyPoints":13,"originalEstimateHours":0.5,"remainingEstimateHours":2.5,"votes":2,"watchers":0,"subtasks":1,"hasParent":true,"links":[{"type":"Blocks","direction":"inward","done":true},{"type":"Relates","direction":"outward","done":false}]}',
  );
});

// Extends "[happy-8] every field set gives every key in order, with new link objects and the issue unchanged".
test("[happy-8] the keys keep the fixed order whatever order the issue's own keys are in", () => {
  const reversed: JiraContext = {
    updated: "2026-10-01T10:00:00.000+0000",
    links: [{ type: "Clones", direction: "outward", key: "R-2", done: false }],
    subtaskCount: 4,
    watchers: 7,
    votes: 1,
    remainingEstimateSeconds: 3600,
    originalEstimateSeconds: 7200,
    storyPoints: 8,
    dueDate: "2027-01-01",
    parentKey: "R-0",
    fixVersions: ["9"],
    components: ["core"],
    labels: ["l"],
    priority: "Medium",
    statusCategory: "indeterminate",
    status: "Review",
    issueType: "Epic",
    key: "R-1",
  };
  assert.deepEqual(Object.keys(jiraContextFields(reversed)), FIELD_ORDER);

  const some: JiraContext = {
    ...bare("R-3"),
    links: [{ type: "Blocks", direction: "inward", key: "R-4", done: true }],
    parentKey: "R-0",
    votes: 3,
    issueType: "Task",
  };
  assert.deepEqual(Object.keys(jiraContextFields(some)), [
    "issueType",
    "votes",
    "hasParent",
    "links",
  ]);
});

// Extends "[happy-8] every field set gives every key in order, with new link objects and the issue unchanged".
test("[happy-8] a link keeps only its type, direction and done, whatever else it carries", () => {
  const extra = {
    type: "Duplicates",
    direction: "inward" as const,
    key: "DUP-1",
    done: true,
    summary: "Same bug",
    url: "https://example.invalid/DUP-1",
  };
  const link: JiraIssueLinkContext = extra;
  const fields = jiraContextFields(
    bare("L-1", {
      links: [
        link,
        { type: "Blocks", direction: "outward", key: "L-2", done: false },
      ],
    }),
  );
  assert.deepEqual(fields, {
    links: [
      { type: "Duplicates", direction: "inward", done: true },
      { type: "Blocks", direction: "outward", done: false },
    ],
  });
});

// Extends "[happy-8] a filled-in issue".
test("[happy-8] arrays keep repeats and order, and fractional points and large counts pass through", () => {
  assert.deepEqual(
    jiraContextFields(
      bare("A-1", {
        labels: ["b", "a", "b"],
        components: ["z", "z"],
        fixVersions: ["2.0", "1.0", "10.0"],
        storyPoints: 2.5,
        votes: 1000,
        watchers: 12,
        subtaskCount: 37,
      }),
    ),
    {
      labels: ["b", "a", "b"],
      components: ["z", "z"],
      fixVersions: ["2.0", "1.0", "10.0"],
      storyPoints: 2.5,
      votes: 1000,
      watchers: 12,
      subtasks: 37,
    },
  );
});

// Extends "[boundary-11] an issue with nothing beyond its key gives no fields".
test("[boundary-11] an issue with one field set gives that field alone, with no subtasks, hasParent or links", () => {
  assert.deepEqual(jiraContextFields(bare("OPS-9", { votes: 1 })), { votes: 1 });
  assert.deepEqual(
    jiraContextFields(
      bare("OPS-10", {
        statusCategory: "done",
        updated: "2026-10-01T10:00:00.000+0000",
        watchers: 2,
      }),
    ),
    { watchers: 2 },
  );
});

// Extends "[boundary-12] blank strings and zero are kept, a link's key is left out".
test("[boundary-12] blank strings in every string field and zero in every number field are kept", () => {
  const issue = bare("OPS-4", {
    issueType: "",
    status: " ",
    priority: "",
    components: [" "],
    fixVersions: [""],
    dueDate: "",
    storyPoints: 0,
    originalEstimateSeconds: 0,
    remainingEstimateSeconds: 0,
    votes: 0,
    watchers: 0,
  });
  assert.equal(
    JSON.stringify(jiraContextFields(issue)),
    '{"issueType":"","status":" ","priority":"","components":[" "],"fixVersions":[""],"dueDate":"","storyPoints":0,"originalEstimateHours":0,"remainingEstimateHours":0,"votes":0,"watchers":0}',
  );
});

// Extends "[boundary-12] blank strings and zero are kept, a link's key is left out".
test("[boundary-12] no link's key is shown, whether set, null or blank", () => {
  const fields = jiraContextFields(
    bare("OPS-5", {
      links: [
        { type: "Blocks", direction: "outward", key: "SECRET-1", done: false },
        { type: "Relates", direction: "inward", key: null, done: true },
        { type: "", direction: "inward", key: "", done: false },
      ],
    }),
  );
  assert.equal(
    JSON.stringify(fields),
    '{"links":[{"type":"Blocks","direction":"outward","done":false},{"type":"Relates","direction":"inward","done":true},{"type":"","direction":"inward","done":false}]}',
  );
});

// Extends "[boundary-13] a half tenth of an hour rounds up and just under an hour rounds to 1".
test("[boundary-13] estimates round half up with Math.round, at small and large sizes", () => {
  const cases: [number, number][] = [
    [1260, 0.4],
    [900, 0.3],
    [1620, 0.5],
    [179, 0],
    [7200, 2],
    [86399, 24],
    [123456, 34.3],
    [360000, 100],
  ];
  for (const [seconds, hours] of cases) {
    assert.deepEqual(
      jiraContextFields(
        bare("OPS-6", {
          originalEstimateSeconds: seconds,
          remainingEstimateSeconds: seconds,
        }),
      ),
      { originalEstimateHours: hours, remainingEstimateHours: hours },
      String(seconds),
    );
  }
});
