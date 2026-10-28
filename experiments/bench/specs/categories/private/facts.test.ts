import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUG_ISSUE_TYPES,
  PRIORITY_RANKS,
  factsFor,
  type IssueFacts,
  type SelectionIssue,
} from "../../src/selection/index.js";

/**
 * Hidden cases for `factsFor` and its lookup tables, beyond the public
 * facts suite.
 */

const NOW = new Date("2026-10-25T12:00:00.000Z");

const BASE_ISSUE: SelectionIssue = {
  assignee: null,
  priority: "Medium",
  issueType: "Story",
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-10-01T00:00:00.000Z",
  dueDate: null,
  sprint: null,
  closedSprints: [],
  votes: 0,
  watchers: 0,
  links: [],
  releases: [],
};

const BASE_ISSUE_FACTS: IssueFacts = {
  ageDays: 297,
  daysSinceUpdate: 24,
  assigned: false,
  inSprint: false,
  closedSprintCount: 0,
  carriedSince: null,
  votes: 0,
  watchers: 0,
  duplicateLinks: 0,
  blocksOpenCount: 0,
  commentCount: null,
  priorityName: "Medium",
  priorityRank: "medium",
  isBug: false,
  dueInDays: null,
  release: null,
};

function factsWith(changes: Partial<SelectionIssue>, now: Date = NOW): IssueFacts {
  return factsFor({ ...BASE_ISSUE, ...changes }, now);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// Extends "[happy-1] the base issue becomes facts and is not modified": every field set at once.
test("[happy-1] an issue with every field set becomes the matching facts", () => {
  const issue: SelectionIssue = {
    assignee: "Dana",
    priority: " Low ",
    issueType: "Bug",
    created: "2025-09-20T00:00:00.000Z",
    updated: "2026-04-01T00:00:00.000Z",
    dueDate: "2026-11-08",
    sprint: { state: "active" },
    closedSprints: [
      { startDate: "2026-03-02T09:00:00.000Z", endDate: null },
      { startDate: "2025-11-10T09:00:00.000Z", endDate: null },
    ],
    votes: 4,
    watchers: 7,
    commentCount: 12,
    links: [
      { type: "Duplicate", direction: "inward", statusCategory: "done" },
      { type: "Blocks", direction: "outward", statusCategory: "new" },
      { type: "Blocks", direction: "outward", statusCategory: "done" },
    ],
    releases: [{ name: "2.4", releaseDate: "2026-11-01", released: false }],
  };
  assert.deepEqual(factsFor(issue, NOW), {
    ageDays: 400,
    daysSinceUpdate: 207,
    assigned: true,
    inSprint: true,
    closedSprintCount: 2,
    carriedSince: "November 2025",
    votes: 4,
    watchers: 7,
    duplicateLinks: 1,
    blocksOpenCount: 1,
    commentCount: 12,
    priorityName: "Low",
    priorityRank: "low",
    isBug: true,
    dueInDays: 14,
    release: { name: "2.4", inDays: 7 },
  });
});

// Extends "[happy-1] a deeply frozen base issue ...": unordered sprints and releases must not be sorted in place.
test("[happy-1] a deeply frozen issue with unordered sprints and releases is read without being modified", () => {
  const source: SelectionIssue = {
    ...BASE_ISSUE,
    closedSprints: [
      { startDate: "2026-06-01T00:00:00.000Z", endDate: null },
      { startDate: "2026-02-01T00:00:00.000Z", endDate: null },
      { startDate: "2026-04-01T00:00:00.000Z", endDate: null },
    ],
    releases: [
      { name: "C", releaseDate: "2026-12-01", released: false },
      { name: "A", releaseDate: "2026-11-02", released: false },
      { name: "B", releaseDate: "2026-11-15", released: false },
    ],
  };
  const issue = deepFreeze(structuredClone(source));
  const facts = factsFor(issue, NOW);
  assert.equal(facts.carriedSince, "February");
  assert.equal(facts.closedSprintCount, 3);
  assert.deepEqual(facts.release, { name: "A", inDays: 8 });
  assert.deepEqual(issue, source);
  assert.deepEqual(factsFor(issue, NOW), facts);
});

// Extends "[happy-1]": a different now moves every elapsed count.
test("[happy-1] the base issue measured from another now", () => {
  const later = new Date("2027-01-01T00:00:00.000Z");
  assert.deepEqual(factsFor(BASE_ISSUE, later), {
    ...BASE_ISSUE_FACTS,
    ageDays: 365,
    daysSinceUpdate: 92,
  });
});

// Extends "[boundary-1] ageDays is whole elapsed days ...": floor, not round or calendar days.
test("[boundary-1] ageDays floors elapsed time rather than rounding or counting calendar days", () => {
  const examples: [string | null, number][] = [
    ["2026-10-24T00:00:00.000Z", 1],
    ["2026-10-24T23:00:00.000Z", 0],
    ["2026-10-24T13:00:00.000+01:00", 1],
    ["2026-10-20", 5],
    ["2026-10-25T12:00:00.000Z", 0],
    ["2026-10-25T11:59:59.999Z", 0],
    ["2026-10-18T12:00:00.000Z", 7],
    ["2016-10-25T12:00:00.000Z", 3652],
    ["2099-01-01T00:00:00.000Z", 0],
    ["", 0],
  ];
  for (const [created, ageDays] of examples) {
    assert.equal(factsWith({ created }).ageDays, ageDays, `created ${created}`);
  }
});

test("[boundary-1] ageDays measures from the now it is given", () => {
  assert.equal(
    factsWith(
      { created: "2024-02-01T00:00:00.000Z" },
      new Date("2024-03-01T00:00:00.000Z"),
    ).ageDays,
    29,
  );
  assert.equal(
    factsWith(
      { created: "2026-03-01T00:00:00.000Z" },
      new Date("2027-03-01T00:00:00.000Z"),
    ).ageDays,
    365,
  );
});

// Extends "[boundary-2] daysSinceUpdate measures from updated ...".
test("[boundary-2] daysSinceUpdate floors elapsed time and does not depend on created", () => {
  const examples: [string | null, number][] = [
    ["2026-10-24T00:00:00.000Z", 1],
    ["2026-10-24T23:00:00.000Z", 0],
    ["2026-10-24T12:00:00.000Z", 1],
    ["2026-10-24T12:00:00.001Z", 0],
    ["2026-10-18T12:00:00.000Z", 7],
    ["", 0],
  ];
  for (const [updated, days] of examples) {
    assert.equal(
      factsWith({ updated, created: "2020-01-01T00:00:00.000Z" }).daysSinceUpdate,
      days,
      `updated ${updated}`,
    );
  }
  const swapped = factsWith({
    created: "2026-10-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(swapped.ageDays, 24);
  assert.equal(swapped.daysSinceUpdate, 297);
  assert.equal(
    factsWith({ created: "2020-01-01T00:00:00.000Z", updated: "garbage" })
      .daysSinceUpdate,
    0,
  );
});

// Extends "[boundary-3] assigned is true for any assignee that is not null".
test("[boundary-3] assigned is true for odd assignee strings too", () => {
  for (const assignee of ["null", "0", "\t", "unassigned"]) {
    assert.equal(factsWith({ assignee }).assigned, true, JSON.stringify(assignee));
  }
});

// Extends "[boundary-4] inSprint is true for any current sprint whose state is not exactly "closed"".
test('[boundary-4] only the exact state "closed" means not in a sprint', () => {
  const examples: [{ state: string } | null, boolean][] = [
    [{ state: "Closed" }, true],
    [{ state: " closed" }, true],
    [{ state: "closed " }, true],
    [{ state: "" }, true],
    [{ state: "closed" }, false],
  ];
  for (const [sprint, inSprint] of examples) {
    assert.equal(factsWith({ sprint }).inSprint, inSprint, JSON.stringify(sprint));
  }
});

// Extends "[happy-2] closed sprints are counted ...": earliest by date, endDate only when startDate does not parse.
test("[happy-2] carriedSince takes the earliest sprint by date, using endDate only when startDate does not parse", () => {
  const facts = factsWith({
    closedSprints: [
      { startDate: null, endDate: "2026-06-01T00:00:00.000Z" },
      { startDate: "2026-05-01T00:00:00.000Z", endDate: null },
      { startDate: "2026-07-01T00:00:00.000Z", endDate: "2026-03-01T00:00:00.000Z" },
    ],
  });
  assert.equal(facts.closedSprintCount, 3);
  assert.equal(facts.carriedSince, "May");
});

test("[happy-2] carriedSince names every month in English", () => {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  months.forEach((name, index) => {
    const month = String(index + 1).padStart(2, "0");
    const facts = factsWith({
      closedSprints: [
        { startDate: `2026-${month}-15T12:00:00.000Z`, endDate: null },
      ],
    });
    assert.equal(facts.carriedSince, name, month);
    assert.equal(facts.closedSprintCount, 1);
  });
});

test("[happy-2] carriedSince uses the UTC month and year", () => {
  assert.equal(
    factsWith({
      closedSprints: [{ startDate: "2026-03-01T00:30:00.000+02:00", endDate: null }],
    }).carriedSince,
    "February",
  );
  assert.equal(
    factsWith({
      closedSprints: [{ startDate: "2026-01-01T01:00:00.000+05:00", endDate: null }],
    }).carriedSince,
    "December 2025",
  );
});

test("[happy-2] the year is compared with the year of the now it is given", () => {
  const sprints = {
    closedSprints: [
      { startDate: "2026-02-10T09:00:00.000Z", endDate: null },
      { startDate: "2026-04-10T09:00:00.000Z", endDate: null },
      { startDate: "2026-03-10T09:00:00.000Z", endDate: null },
    ],
  };
  const nextYear = factsWith(sprints, new Date("2027-03-01T00:00:00.000Z"));
  assert.equal(nextYear.closedSprintCount, 3);
  assert.equal(nextYear.carriedSince, "February 2026");
  const lateUtc = factsWith(
    { closedSprints: [{ startDate: "2025-06-10T00:00:00.000Z", endDate: null }] },
    new Date("2026-01-01T00:30:00.000+02:00"),
  );
  assert.equal(lateUtc.carriedSince, "June");
});

test("[happy-2] many closed sprints are all counted", () => {
  const closedSprints = Array.from({ length: 9 }, (_, i) => ({
    startDate: `2026-0${9 - i}-01T00:00:00.000Z`,
    endDate: null,
  }));
  const facts = factsWith({ closedSprints });
  assert.equal(facts.closedSprintCount, 9);
  assert.equal(facts.carriedSince, "January");
});

// Extends "[boundary-5] missing votes and watchers become 0 ...": zeroes are kept, not turned into null.
test("[boundary-5] a zero comment count stays 0, and zero votes and watchers stay 0", () => {
  const zeroes = factsWith({ votes: 0, watchers: 0, commentCount: 0 });
  assert.equal(zeroes.commentCount, 0);
  assert.equal(zeroes.votes, 0);
  assert.equal(zeroes.watchers, 0);

  const mixed = factsWith({ votes: null, watchers: 250, commentCount: 1 });
  assert.equal(mixed.votes, 0);
  assert.equal(mixed.watchers, 250);
  assert.equal(mixed.commentCount, 1);
});

// Extends "[happy-3] duplicates count only inward links ...": substring matching and more links.
test("[happy-3] link types match as case-insensitive substrings", () => {
  const facts = factsWith({
    links: [
      { type: "Duplicate", direction: "inward", statusCategory: "new" },
      { type: "Duplicated", direction: "inward", statusCategory: "done" },
      { type: "Duplicates", direction: "inward", statusCategory: "indeterminate" },
      { type: "DUPLICATE", direction: "outward", statusCategory: "new" },
      { type: "Blocking", direction: "outward", statusCategory: "new" },
      { type: "Blocker", direction: "outward", statusCategory: "indeterminate" },
      { type: "Blocks", direction: "outward", statusCategory: "DONE" },
      { type: "Blocks", direction: "outward", statusCategory: "" },
      { type: "Blocks", direction: "inward", statusCategory: "new" },
      { type: "Cloners", direction: "outward", statusCategory: "new" },
      { type: "Relates", direction: "inward", statusCategory: "new" },
    ],
  });
  assert.equal(facts.duplicateLinks, 3);
  assert.equal(facts.blocksOpenCount, 4);
});

test("[happy-3] many blocking and duplicate links are all counted", () => {
  const links = [
    ...Array.from({ length: 7 }, () => ({
      type: "Blocks",
      direction: "outward" as const,
      statusCategory: "new",
    })),
    ...Array.from({ length: 5 }, () => ({
      type: "Duplicate",
      direction: "inward" as const,
      statusCategory: "new",
    })),
    ...Array.from({ length: 3 }, () => ({
      type: "Blocks",
      direction: "outward" as const,
      statusCategory: "done",
    })),
  ];
  const facts = factsWith({ links });
  assert.equal(facts.blocksOpenCount, 7);
  assert.equal(facts.duplicateLinks, 5);
});

// Extends "[boundary-6] priority ranks by its trimmed lowercase name ...".
test("[boundary-6] other priority names rank by exact key after trimming and lowercasing", () => {
  const examples: [string | null, string | null, string][] = [
    ["LOWEST", "LOWEST", "low"],
    [" Normal ", "Normal", "medium"],
    ["\tMinor\n", "Minor", "low"],
    ["MEDIUM", "MEDIUM", "medium"],
    ["trivial", "trivial", "low"],
    ["  High  ", "High", "high"],
    ["Med", "Med", "high"],
    ["lowish", "lowish", "high"],
    ["Very Low", "Very Low", "high"],
    ["constructor", "constructor", "high"],
    ["toString", "toString", "high"],
    ["hasOwnProperty", "hasOwnProperty", "high"],
    ["", null, "none"],
    ["\t\n", null, "none"],
  ];
  for (const [priority, name, rank] of examples) {
    const facts = factsWith({ priority });
    const label = `priority ${JSON.stringify(priority)}`;
    assert.equal(facts.priorityName, name, label);
    assert.equal(facts.priorityRank, rank, label);
  }
});

// Extends "[boundary-7] isBug matches BUG_ISSUE_TYPES ...".
test("[boundary-7] isBug needs an exact bug type after trimming and lowercasing", () => {
  const examples: [string, boolean][] = [
    ["DEFECT", true],
    ["\tBug\n", true],
    ["BUG", true],
    ["defects", false],
    ["Sub-bug", false],
    ["Bug Report", false],
    ["bugs", false],
    ["", false],
    ["Task", false],
  ];
  for (const [issueType, isBug] of examples) {
    assert.equal(factsWith({ issueType }).isBug, isBug, JSON.stringify(issueType));
  }
});

// Extends "[boundary-8] dueInDays counts UTC calendar days ...": other nows and offsets.
test("[boundary-8] dueInDays counts calendar days, not elapsed time, from late and early in now's day", () => {
  const late = new Date("2026-10-25T23:00:00.000Z");
  assert.equal(factsWith({ dueDate: "2026-10-26T00:30:00.000Z" }, late).dueInDays, 1);
  assert.equal(factsWith({ dueDate: "2026-10-25T00:00:00.000Z" }, late).dueInDays, 0);
  assert.equal(factsWith({ dueDate: "2026-10-26" }, late).dueInDays, 1);

  const early = new Date("2026-10-25T00:30:00.000Z");
  assert.equal(factsWith({ dueDate: "2026-10-25T23:30:00.000Z" }, early).dueInDays, 0);
  assert.equal(factsWith({ dueDate: "2026-10-24T23:59:00.000Z" }, early).dueInDays, -1);
  assert.equal(
    factsWith({ dueDate: "2026-10-26T01:00:00.000+05:00" }, early).dueInDays,
    0,
  );
});

test("[boundary-8] dueInDays over longer spans and offsets", () => {
  const examples: [string | null, number | null][] = [
    ["2026-12-25", 61],
    ["2027-10-25", 365],
    ["2025-10-25", -365],
    ["2026-10-25T23:59:59.999Z", 0],
    ["2026-10-24T23:59:59.999-01:00", 0],
    ["", null],
  ];
  for (const [dueDate, dueInDays] of examples) {
    assert.equal(factsWith({ dueDate }).dueInDays, dueInDays, `dueDate ${dueDate}`);
  }
  assert.equal(
    factsWith({ dueDate: "2028-03-01" }, new Date("2028-02-28T12:00:00.000Z"))
      .dueInDays,
    2,
  );
});

// Extends "[happy-4] release is the unreleased version with the earliest releaseDate ...": not array order.
test("[happy-4] the earliest release wins wherever it sits in the list", () => {
  assert.deepEqual(
    factsWith({
      releases: [
        { name: "C", releaseDate: "2026-12-01", released: false },
        { name: "B", releaseDate: "2026-11-15", released: false },
        { name: "A", releaseDate: "2026-11-02", released: false },
      ],
    }).release,
    { name: "A", inDays: 8 },
  );
  assert.deepEqual(
    factsWith({
      releases: [
        { name: "X", releaseDate: "2026-11-10", released: false },
        { name: "Y", releaseDate: "2026-11-05", released: false },
        { name: "Z", releaseDate: "2026-11-05", released: false },
      ],
    }).release,
    { name: "Y", inDays: 11 },
  );
});

// Extends "[happy-4] a release due today counts ...": skips every kind of ignored version before a real one.
test("[happy-4] overdue, released, undated and unparseable versions are skipped for a later real one", () => {
  assert.deepEqual(
    factsWith({
      releases: [
        { name: "Old", releaseDate: "2026-10-24", released: false },
        { name: "Shipped", releaseDate: "2026-10-26", released: true },
        { name: "Null", releaseDate: null, released: false },
        { name: "Tbd", releaseDate: "tbd", released: false },
        { name: "Real", releaseDate: "2026-12-25", released: false },
      ],
    }).release,
    { name: "Real", inDays: 61 },
  );
  assert.equal(
    factsWith({
      releases: [
        { name: "Old", releaseDate: "2026-10-24", released: false },
        { name: "Shipped", releaseDate: "2026-11-26", released: true },
      ],
    }).release,
    null,
  );
});

test("[happy-4] a release earlier today still counts as today, and offsets apply", () => {
  assert.deepEqual(
    factsWith({
      releases: [
        { name: "Later", releaseDate: "2026-10-26", released: false },
        { name: "Morning", releaseDate: "2026-10-25T01:00:00.000Z", released: false },
      ],
    }).release,
    { name: "Morning", inDays: 0 },
  );
  assert.deepEqual(
    factsWith({
      releases: [
        { name: "Off", releaseDate: "2026-11-01T23:30:00.000-05:00", released: false },
      ],
    }).release,
    { name: "Off", inDays: 8 },
  );
  assert.deepEqual(
    factsWith(
      { releases: [{ name: "Leap", releaseDate: "2028-03-01", released: false }] },
      new Date("2028-02-28T12:00:00.000Z"),
    ).release,
    { name: "Leap", inDays: 2 },
  );
});

test("[happy-4] the earliest of many releases is found", () => {
  const releases = Array.from({ length: 12 }, (_, i) => ({
    name: `v${i}`,
    releaseDate: `2027-${String(12 - i).padStart(2, "0")}-01`,
    released: false,
  }));
  releases.splice(5, 0, { name: "soonest", releaseDate: "2026-11-05", released: false });
  assert.deepEqual(factsWith({ releases }).release, { name: "soonest", inDays: 11 });
});

// Extends "[boundary-9] the priority and bug lookup tables": factsFor agrees with every entry, and the tables are not frozen.
test("[boundary-9] factsFor ranks every PRIORITY_RANKS key and recognises every BUG_ISSUE_TYPES entry", () => {
  assert.deepEqual(Object.keys(PRIORITY_RANKS).sort(), [
    "low",
    "lowest",
    "medium",
    "minor",
    "normal",
    "trivial",
  ]);
  assert.equal(Object.isFrozen(PRIORITY_RANKS), false);
  assert.equal(Object.isFrozen(BUG_ISSUE_TYPES), false);
  for (const [key, rank] of Object.entries(PRIORITY_RANKS)) {
    const upper = key.toUpperCase();
    const facts = factsWith({ priority: upper });
    assert.equal(facts.priorityRank, rank, key);
    assert.equal(facts.priorityName, upper, key);
  }
  for (const type of BUG_ISSUE_TYPES) {
    assert.equal(factsWith({ issueType: type.toUpperCase() }).isBug, true, type);
  }
});
