import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blocksAtLeast,
  bug,
  carriedAtLeast,
  commentsAtLeast,
  deadlineWithin,
  duplicatesAtLeast,
  evaluate,
  neverInSprint,
  notInSprint,
  openAtLeast,
  priorityAtMost,
  quietAtLeast,
  unassigned,
  votesAtLeast,
  watchersAtLeast,
  type IssueFacts,
  type Signal,
} from "../../src/selection/index.js";

/**
 * Hidden cases for the named signals, beyond the public signals suite.
 */

const BASE_FACTS: IssueFacts = {
  ageDays: 0,
  daysSinceUpdate: 0,
  assigned: false,
  inSprint: false,
  closedSprintCount: 0,
  carriedSince: null,
  votes: 0,
  watchers: 0,
  duplicateLinks: 0,
  blocksOpenCount: 0,
  commentCount: null,
  priorityName: null,
  priorityRank: "none",
  isBug: false,
  dueInDays: null,
  release: null,
};

function factsWith(changes: Partial<IssueFacts>): IssueFacts {
  return { ...BASE_FACTS, ...changes };
}

type Example = [string, () => Signal, Partial<IssueFacts>, boolean, string];

function check(examples: Example[]): void {
  for (const [name, make, changes, matches, description] of examples) {
    const facts = factsWith(changes);
    const label = `${name} with ${JSON.stringify(changes)}`;
    assert.equal(make().test(facts), matches, label);
    assert.equal(make().describe(facts), description, label);
  }
}

// Extends "[happy-8] signal ids do not include the threshold": every factory at other thresholds.
test("[happy-8] every factory keeps its id at other thresholds", () => {
  const examples: [string, () => Signal, string][] = [
    ["openAtLeast(7)", () => openAtLeast(7), "open-at-least"],
    ["quietAtLeast(0)", () => quietAtLeast(0), "quiet-at-least"],
    ["quietAtLeast(365)", () => quietAtLeast(365), "quiet-at-least"],
    ["carriedAtLeast(10)", () => carriedAtLeast(10), "carried-at-least"],
    ["votesAtLeast(100)", () => votesAtLeast(100), "votes-at-least"],
    ["watchersAtLeast(0)", () => watchersAtLeast(0), "watchers-at-least"],
    ["duplicatesAtLeast(5)", () => duplicatesAtLeast(5), "duplicates-at-least"],
    ["commentsAtLeast(0)", () => commentsAtLeast(0), "comments-at-least"],
    ["blocksAtLeast(99)", () => blocksAtLeast(99), "blocks-at-least"],
    ["deadlineWithin(365)", () => deadlineWithin(365), "deadline-within"],
    ["openAtLeast(-3)", () => openAtLeast(-3), "open-at-least"],
  ];
  for (const [name, make, id] of examples) {
    assert.equal(make().id, id, name);
  }
  assert.equal(unassigned.id, "unassigned");
  assert.equal(neverInSprint.id, "never-in-sprint");
  assert.equal(notInSprint.id, "not-in-sprint");
  assert.equal(bug.id, "bug");
  assert.equal(priorityAtMost("low").id, "priority-at-most-low");
  assert.equal(priorityAtMost("medium").id, "priority-at-most-medium");
});

// Extends "[boundary-13] signal tests are inclusive ...": descriptions use the facts, not the threshold.
test("[boundary-13] counting signals describe the facts' count, whatever the threshold", () => {
  check([
    ["openAtLeast(10)", () => openAtLeast(10), { ageDays: 400 }, true, "open 400 days"],
    ["openAtLeast(10)", () => openAtLeast(10), { ageDays: 1 }, false, "open 1 day"],
    ["openAtLeast(1)", () => openAtLeast(1), { ageDays: 0 }, false, "open 0 days"],
    ["openAtLeast(2)", () => openAtLeast(2), { ageDays: 2 }, true, "open 2 days"],
    ["quietAtLeast(90)", () => quietAtLeast(90), { daysSinceUpdate: 90 }, true, "no update in 90 days"],
    ["quietAtLeast(90)", () => quietAtLeast(90), { daysSinceUpdate: 89 }, false, "no update in 89 days"],
    ["quietAtLeast(5)", () => quietAtLeast(5), { daysSinceUpdate: 1 }, false, "no update in 1 day"],
    ["quietAtLeast(0)", () => quietAtLeast(0), { daysSinceUpdate: 0 }, true, "no update in 0 days"],
    ["votesAtLeast(5)", () => votesAtLeast(5), { votes: 0 }, false, "0 votes"],
    ["votesAtLeast(5)", () => votesAtLeast(5), { votes: 1000 }, true, "1000 votes"],
    ["votesAtLeast(5)", () => votesAtLeast(5), { votes: 1 }, false, "1 vote"],
    ["watchersAtLeast(5)", () => watchersAtLeast(5), { watchers: 4 }, false, "4 watchers"],
    ["watchersAtLeast(5)", () => watchersAtLeast(5), { watchers: 0 }, false, "0 watchers"],
    ["watchersAtLeast(2)", () => watchersAtLeast(2), { watchers: 2 }, true, "2 watchers"],
    ["watchersAtLeast(3)", () => watchersAtLeast(3), { watchers: 1 }, false, "1 watcher"],
    ["duplicatesAtLeast(1)", () => duplicatesAtLeast(1), { duplicateLinks: 0 }, false, "0 duplicates linked"],
    ["duplicatesAtLeast(3)", () => duplicatesAtLeast(3), { duplicateLinks: 7 }, true, "7 duplicates linked"],
    ["duplicatesAtLeast(3)", () => duplicatesAtLeast(3), { duplicateLinks: 1 }, false, "1 duplicate linked"],
    ["blocksAtLeast(3)", () => blocksAtLeast(3), { blocksOpenCount: 12 }, true, "blocks 12 open tickets"],
    ["blocksAtLeast(3)", () => blocksAtLeast(3), { blocksOpenCount: 2 }, false, "blocks 2 open tickets"],
    ["blocksAtLeast(5)", () => blocksAtLeast(5), { blocksOpenCount: 1 }, false, "blocks 1 open ticket"],
  ]);
});

test("[boundary-13] carriedAtLeast describes the count and adds carriedSince whenever it is set", () => {
  check([
    ["carriedAtLeast(2)", () => carriedAtLeast(2), { closedSprintCount: 5, carriedSince: "November 2025" }, true, "carried over 5 sprints since November 2025"],
    ["carriedAtLeast(2)", () => carriedAtLeast(2), { closedSprintCount: 1, carriedSince: "May" }, false, "carried over 1 sprint since May"],
    ["carriedAtLeast(1)", () => carriedAtLeast(1), { closedSprintCount: 1, carriedSince: "January" }, true, "carried over 1 sprint since January"],
    ["carriedAtLeast(1)", () => carriedAtLeast(1), { closedSprintCount: 0 }, false, "carried over 0 sprints"],
    ["carriedAtLeast(2)", () => carriedAtLeast(2), { closedSprintCount: 2 }, true, "carried over 2 sprints"],
  ]);
});

test("[boundary-13] commentsAtLeast never matches a null count but matches a zero one", () => {
  check([
    ["commentsAtLeast(0)", () => commentsAtLeast(0), { commentCount: 0 }, true, "0 comments"],
    ["commentsAtLeast(5)", () => commentsAtLeast(5), { commentCount: 4 }, false, "4 comments"],
    ["commentsAtLeast(5)", () => commentsAtLeast(5), { commentCount: 5 }, true, "5 comments"],
    ["commentsAtLeast(5)", () => commentsAtLeast(5), { commentCount: null }, false, "0 comments"],
    ["commentsAtLeast(-1)", () => commentsAtLeast(-1), { commentCount: null }, false, "0 comments"],
    ["commentsAtLeast(3)", () => commentsAtLeast(3), { commentCount: 1 }, false, "1 comment"],
  ]);
});

test("[boundary-13] bug names its priority, and its test reads only isBug", () => {
  check([
    ["bug", () => bug, { isBug: true, priorityName: "P2", priorityRank: "high" }, true, "P2-priority bug"],
    ["bug", () => bug, { isBug: true, priorityName: "Highest", priorityRank: "high" }, true, "Highest-priority bug"],
    ["bug", () => bug, { isBug: false, priorityName: "High", priorityRank: "high" }, false, "High-priority bug"],
    ["bug", () => bug, { isBug: true, priorityName: null, priorityRank: "none" }, true, "bug"],
  ]);
});

test("[boundary-13] priorityAtMost tests the rank, not the name", () => {
  check([
    ['priorityAtMost("low")', () => priorityAtMost("low"), { priorityName: "Medium", priorityRank: "low" }, true, "priority Medium"],
    ['priorityAtMost("low")', () => priorityAtMost("low"), { priorityName: "Low", priorityRank: "high" }, false, "priority Low"],
    ['priorityAtMost("low")', () => priorityAtMost("low"), { priorityName: "Critical", priorityRank: "high" }, false, "priority Critical"],
    ['priorityAtMost("low")', () => priorityAtMost("low"), { priorityName: "Trivial", priorityRank: "low" }, true, "priority Trivial"],
    ['priorityAtMost("medium")', () => priorityAtMost("medium"), { priorityName: null, priorityRank: "none" }, false, "priority unset"],
    ['priorityAtMost("medium")', () => priorityAtMost("medium"), { priorityName: "Medium", priorityRank: "medium" }, true, "priority Medium"],
    ['priorityAtMost("medium")', () => priorityAtMost("medium"), { priorityName: "Low", priorityRank: "high" }, false, "priority Low"],
  ]);
});

test("[boundary-13] the sprint and assignee signals read only their own facts", () => {
  check([
    ["neverInSprint", () => neverInSprint, { inSprint: true, closedSprintCount: 3 }, false, "never in a sprint"],
    ["neverInSprint", () => neverInSprint, { assigned: true, ageDays: 900 }, true, "never in a sprint"],
    ["notInSprint", () => notInSprint, { closedSprintCount: 0 }, true, "not in any sprint"],
    ["notInSprint", () => notInSprint, { inSprint: true, closedSprintCount: 0 }, false, "not in any sprint"],
    ["unassigned", () => unassigned, { assigned: false, inSprint: true, closedSprintCount: 7 }, true, "unassigned"],
    ["unassigned", () => unassigned, { assigned: true, inSprint: false }, false, "unassigned"],
  ]);
});

test("[boundary-13] evaluating a named signal yields its description as the only clause", () => {
  assert.deepEqual(evaluate(openAtLeast(30), factsWith({ ageDays: 31 })), {
    matched: true,
    clauses: ["open 31 days"],
  });
  assert.deepEqual(evaluate(votesAtLeast(3), factsWith({ votes: 2 })), {
    matched: false,
    clauses: [],
  });
});

// Extends "[boundary-14] deadlineWithin matches ...": other windows, mixed due dates and releases.
test("[boundary-14] deadlineWithin at other windows describes the facts' days", () => {
  const examples: [number, Partial<IssueFacts>, boolean, string][] = [
    [30, { dueInDays: 30 }, true, "due in 30 days"],
    [30, { dueInDays: 31 }, false, "due today"],
    [30, { dueInDays: 7 }, true, "due in 7 days"],
    [0, { dueInDays: 1 }, false, "due today"],
    [0, { dueInDays: 0 }, true, "due today"],
    [-1, { dueInDays: 0 }, false, "due today"],
    [30, { release: { name: "3.0", inDays: 30 } }, true, "release 3.0 in 30 days"],
    [30, { release: { name: "2.4", inDays: 1 } }, true, "release 2.4 in 1 day"],
    [30, { release: { name: "Q4 launch", inDays: 3 } }, true, "release Q4 launch in 3 days"],
    [1, { release: { name: "9", inDays: 2 } }, false, "due today"],
  ];
  for (const [days, changes, matches, description] of examples) {
    const facts = factsWith(changes);
    const label = `deadlineWithin(${days}) with ${JSON.stringify(changes)}`;
    assert.equal(deadlineWithin(days).test(facts), matches, label);
    assert.equal(deadlineWithin(days).describe(facts), description, label);
  }
});

test("[boundary-14] deadlineWithin uses whichever of the due date and release is inside the window", () => {
  const examples: [Partial<IssueFacts>, boolean, string][] = [
    [{ dueInDays: 3, release: { name: "2.4", inDays: -1 } }, true, "due in 3 days"],
    [{ dueInDays: -3, release: { name: "2.4", inDays: 4 } }, true, "release 2.4 in 4 days"],
    [{ dueInDays: -3, release: { name: "2.4", inDays: 40 } }, false, "due today"],
    [{ dueInDays: 15, release: { name: "2.4", inDays: 15 } }, false, "due today"],
    [{ dueInDays: 0, release: { name: "2.4", inDays: 0 } }, true, "due today"],
    [{ dueInDays: 2, release: { name: "2.4", inDays: 0 } }, true, "release 2.4 today"],
    [{ dueInDays: 0, release: { name: "2.4", inDays: 2 } }, true, "due today"],
    [{ dueInDays: null, release: { name: "2.4", inDays: 14 } }, true, "release 2.4 in 14 days"],
    [{ dueInDays: 14, release: null }, true, "due in 14 days"],
    [{ dueInDays: 9, release: { name: "2.4", inDays: 1 } }, true, "release 2.4 in 1 day"],
    [{ dueInDays: 1, release: { name: "2.4", inDays: 9 } }, true, "due in 1 day"],
  ];
  for (const [changes, matches, description] of examples) {
    const facts = factsWith(changes);
    const label = JSON.stringify(changes);
    assert.equal(deadlineWithin(14).test(facts), matches, label);
    assert.equal(deadlineWithin(14).describe(facts), description, label);
  }
});

// Extends "[boundary-15] signal factories take any number as a threshold without refusing it".
test("[boundary-15] infinite, NaN, negative and fractional thresholds are used as given", () => {
  assert.equal(openAtLeast(Number.POSITIVE_INFINITY).test(factsWith({ ageDays: 1e6 })), false);
  assert.equal(openAtLeast(Number.NEGATIVE_INFINITY).test(BASE_FACTS), true);
  assert.equal(votesAtLeast(Number.NaN).test(factsWith({ votes: 100 })), false);
  assert.equal(carriedAtLeast(-5).test(BASE_FACTS), true);
  assert.equal(blocksAtLeast(0.5).test(factsWith({ blocksOpenCount: 1 })), true);
  assert.equal(blocksAtLeast(0.5).test(BASE_FACTS), false);
  assert.equal(watchersAtLeast(-1).test(BASE_FACTS), true);
  assert.equal(duplicatesAtLeast(1.5).test(factsWith({ duplicateLinks: 1 })), false);
  assert.equal(commentsAtLeast(Number.NEGATIVE_INFINITY).test(BASE_FACTS), false);
  assert.equal(commentsAtLeast(Number.NEGATIVE_INFINITY).test(factsWith({ commentCount: 0 })), true);
  assert.equal(deadlineWithin(2.5).test(factsWith({ dueInDays: 2 })), true);
  assert.equal(deadlineWithin(2.5).test(factsWith({ dueInDays: 3 })), false);
  assert.equal(deadlineWithin(Number.NaN).test(factsWith({ dueInDays: 0 })), false);
  assert.equal(deadlineWithin(Number.POSITIVE_INFINITY).test(factsWith({ dueInDays: 10000 })), true);
  assert.equal(deadlineWithin(-1).test(factsWith({ dueInDays: -1 })), false);
  assert.equal(quietAtLeast(-0.5).id, "quiet-at-least");
});
