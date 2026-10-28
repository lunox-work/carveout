import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CATEGORIES,
  UNCATEGORIZED,
  all,
  any,
  classify,
  createClassifier,
  evaluate,
  resolveCategories,
  signal,
  silent,
  type Category,
  type CategoryConfig,
  type IssueFacts,
  type Rule,
  type Thresholds,
} from "../../src/selection/index.js";

/**
 * Hidden cases for the registry, `resolveCategories`, `createClassifier`
 * and `classify`, beyond the public categories suite.
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

const REGISTRY = [
  {
    id: "left-behind",
    label: "Left behind",
    why: "The team has shown it won't reach this, so outsourcing takes nothing off the roadmap.",
    defaults: { minAgeDays: 180, minQuietDays: 90 },
  },
  {
    id: "always-next-sprint",
    label: "Always next sprint",
    why: "Already planned and wanted; the only blocker is capacity.",
    defaults: { minSprints: 2 },
  },
  {
    id: "quietly-wanted",
    label: "Quietly wanted",
    why: "Shows demand that the priority field hides, which justifies a higher bounty.",
    defaults: { minVotes: 3, minWatchers: 5, minDuplicates: 1, minComments: 5 },
  },
  {
    id: "holding-others-up",
    label: "Holding others up",
    why: "One bounty unblocks several tickets the team will do in-house.",
    defaults: { minBlocked: 1 },
  },
  {
    id: "paper-cuts",
    label: "Paper cuts",
    why: "Small, self-contained bugs are what agents fix most reliably, and users notice when they're gone.",
    defaults: { minAgeDays: 90 },
  },
  {
    id: "deadline-exposed",
    label: "Deadline exposed",
    why: "The deadline justifies paying now rather than waiting for capacity.",
    defaults: { withinDays: 30 },
  },
];

const DEFAULT_RESOLVED = REGISTRY.map((entry) => ({
  id: entry.id,
  label: entry.label,
  why: entry.why,
  enabled: true,
  thresholds: entry.defaults,
}));

function registryCategory(id: string): Category {
  const found = CATEGORIES.find((c) => c.id === id);
  assert.ok(found, `no category ${id}`);
  return found;
}

function resolvedById(
  config: CategoryConfig,
  id: string,
  categories: readonly Category[] = CATEGORIES,
) {
  const found = resolveCategories(config, categories).find((c) => c.id === id);
  assert.ok(found, `no resolved category ${id}`);
  return found;
}

/** The rule tree with each signal replaced by its id. */
function shape(rule: Rule): unknown {
  if ("all" in rule) return { all: rule.all.map(shape) };
  if ("any" in rule) return { any: rule.any.map(shape) };
  return rule.id;
}

function match(id: string, reason: string) {
  const entry = REGISTRY.find((e) => e.id === id);
  assert.ok(entry, `no registry entry ${id}`);
  return { id, label: entry.label, reason };
}

function custom(
  id: string,
  label: string,
  rule: (thresholds: Thresholds) => Rule,
  defaults: Thresholds = {},
): Category {
  return { id, label, why: `${label}.`, defaults, rule };
}

const always = (clause: string | null) => signal("always", () => true, () => clause);

// Extends "[happy-9] the registry lists six categories ...": the rule compositions as tabled.
test("[happy-9] each shipped rule is composed of the tabled signals in the tabled order", () => {
  const expected: Record<string, unknown> = {
    "left-behind": {
      all: ["open-at-least", "never-in-sprint", "unassigned", "quiet-at-least"],
    },
    "always-next-sprint": "carried-at-least",
    "quietly-wanted": {
      all: [
        {
          any: [
            "votes-at-least",
            "watchers-at-least",
            "comments-at-least",
            "duplicates-at-least",
          ],
        },
        "priority-at-most-low",
      ],
    },
    "holding-others-up": { all: ["blocks-at-least", "unassigned"] },
    "paper-cuts": { all: ["bug", "priority-at-most-medium", "open-at-least"] },
    "deadline-exposed": {
      all: ["deadline-within", "unassigned", "not-in-sprint"],
    },
  };
  assert.deepEqual(
    CATEGORIES.map((c) => ({ id: c.id, label: c.label, why: c.why, defaults: c.defaults })),
    REGISTRY,
  );
  for (const category of CATEGORIES) {
    assert.deepEqual(shape(category.rule(category.defaults)), expected[category.id], category.id);
    assert.notEqual(category.id, UNCATEGORIZED);
  }
});

test("[happy-9] the silent clauses of the shipped rules are the tabled ones", () => {
  const facts = factsWith({
    ageDays: 400,
    daysSinceUpdate: 200,
    isBug: true,
    priorityName: "Low",
    priorityRank: "low",
    dueInDays: 3,
  });
  const describedChildren = (id: string) => {
    const category = registryCategory(id);
    const rule = category.rule(category.defaults);
    assert.ok("all" in rule, id);
    return rule.all.map((child) => ("all" in child || "any" in child ? "rule" : child.describe(facts)));
  };
  assert.deepEqual(describedChildren("left-behind"), [
    "open 400 days",
    "never in a sprint",
    "unassigned",
    null,
  ]);
  assert.deepEqual(describedChildren("paper-cuts"), [
    "Low-priority bug",
    null,
    "open 400 days",
  ]);
  assert.deepEqual(describedChildren("deadline-exposed"), [
    "due in 3 days",
    null,
    "not in any sprint",
  ]);
  assert.deepEqual(describedChildren("holding-others-up"), [
    "blocks 0 open tickets",
    "unassigned",
  ]);
});

test("[happy-9] each shipped rule is built from the thresholds it is given", () => {
  const leftBehind = registryCategory("left-behind").rule({ minAgeDays: 10, minQuietDays: 5 });
  assert.deepEqual(evaluate(leftBehind, factsWith({ ageDays: 10, daysSinceUpdate: 5 })), {
    matched: true,
    clauses: ["open 10 days", "never in a sprint", "unassigned"],
  });
  assert.equal(evaluate(leftBehind, factsWith({ ageDays: 9, daysSinceUpdate: 5 })).matched, false);
  assert.equal(evaluate(leftBehind, factsWith({ ageDays: 10, daysSinceUpdate: 4 })).matched, false);

  const nextSprint = registryCategory("always-next-sprint").rule({ minSprints: 7 });
  assert.equal(evaluate(nextSprint, factsWith({ closedSprintCount: 7 })).matched, true);
  assert.equal(evaluate(nextSprint, factsWith({ closedSprintCount: 6 })).matched, false);

  const wanted = registryCategory("quietly-wanted").rule({
    minVotes: 10,
    minWatchers: 20,
    minDuplicates: 3,
    minComments: 8,
  });
  const low = { priorityName: "Low", priorityRank: "low" as const };
  assert.equal(evaluate(wanted, factsWith({ ...low, votes: 9, watchers: 19, duplicateLinks: 2, commentCount: 7 })).matched, false);
  assert.deepEqual(evaluate(wanted, factsWith({ ...low, watchers: 20 })), {
    matched: true,
    clauses: ["20 watchers", "priority Low"],
  });
  assert.deepEqual(evaluate(wanted, factsWith({ ...low, duplicateLinks: 3 })), {
    matched: true,
    clauses: ["3 duplicates linked", "priority Low"],
  });

  const holding = registryCategory("holding-others-up").rule({ minBlocked: 3 });
  assert.equal(evaluate(holding, factsWith({ blocksOpenCount: 2 })).matched, false);
  assert.equal(evaluate(holding, factsWith({ blocksOpenCount: 3 })).matched, true);

  const paper = registryCategory("paper-cuts").rule({ minAgeDays: 5 });
  assert.equal(evaluate(paper, factsWith({ isBug: true, priorityRank: "medium", ageDays: 5 })).matched, true);
  assert.equal(evaluate(paper, factsWith({ isBug: true, priorityRank: "medium", ageDays: 4 })).matched, false);

  const deadline = registryCategory("deadline-exposed").rule({ withinDays: 60 });
  assert.equal(evaluate(deadline, factsWith({ dueInDays: 60 })).matched, true);
  assert.equal(evaluate(deadline, factsWith({ dueInDays: 61 })).matched, false);
});

// Extends "[happy-10] with no config every category is enabled at its defaults": a custom list and undefined config.
test("[happy-10] a custom category list resolves in its own order with its own defaults", () => {
  const b = custom("b", "Bee", () => all(), { x: 1 });
  const a = custom("a", "Ay", () => all(), { y: 2, z: 3 });
  assert.deepEqual(resolveCategories({}, [b, a]), [
    { id: "b", label: "Bee", why: "Bee.", enabled: true, thresholds: { x: 1 } },
    { id: "a", label: "Ay", why: "Ay.", enabled: true, thresholds: { y: 2, z: 3 } },
  ]);
  assert.deepEqual(resolveCategories({}, []), []);
  assert.deepEqual(resolveCategories(undefined), DEFAULT_RESOLVED);
  assert.deepEqual(
    resolveCategories({}, [...CATEGORIES].reverse()),
    [...DEFAULT_RESOLVED].reverse(),
  );
});

// Extends "[happy-11] a threshold override replaces only that threshold": several categories and keys at once.
test("[happy-11] overrides in several categories each replace only their own thresholds", () => {
  const resolved = resolveCategories({
    "left-behind": { thresholds: { minQuietDays: 30 } },
    "quietly-wanted": { thresholds: { minVotes: 1, minComments: 20 } },
    "deadline-exposed": { thresholds: { withinDays: 7 } },
  });
  assert.deepEqual(
    resolved.map((c) => c.thresholds),
    [
      { minAgeDays: 180, minQuietDays: 30 },
      { minSprints: 2 },
      { minVotes: 1, minWatchers: 5, minDuplicates: 1, minComments: 20 },
      { minBlocked: 1 },
      { minAgeDays: 90 },
      { withinDays: 7 },
    ],
  );
  assert.deepEqual(
    resolved.map((c) => c.enabled),
    [true, true, true, true, true, true],
  );
  assert.deepEqual(
    resolvedById(
      { "quietly-wanted": { thresholds: { minVotes: 9, minWatchers: 8, minDuplicates: 7, minComments: 6 } } },
      "quietly-wanted",
    ).thresholds,
    { minVotes: 9, minWatchers: 8, minDuplicates: 7, minComments: 6 },
  );
});

// Extends "[boundary-16] an override that is null, undefined or not finite keeps the default ...": other values and keys.
test("[boundary-16] -Infinity keeps the default, and large or tiny finite numbers replace it", () => {
  const examples: [number | null | undefined, number][] = [
    [Number.NEGATIVE_INFINITY, 2],
    [Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MIN_VALUE, Number.MIN_VALUE],
    [1e9, 1e9],
    [-250.75, -250.75],
  ];
  for (const [value, resolved] of examples) {
    assert.deepEqual(
      resolvedById(
        { "always-next-sprint": { thresholds: { minSprints: value } } },
        "always-next-sprint",
      ).thresholds,
      { minSprints: resolved },
      `minSprints ${value}`,
    );
  }
});

test("[boundary-16] each threshold of one category is resolved on its own", () => {
  assert.deepEqual(
    resolvedById(
      {
        "quietly-wanted": {
          thresholds: {
            minVotes: null,
            minWatchers: Number.NEGATIVE_INFINITY,
            minDuplicates: 0,
            minComments: Number.NaN,
          },
        },
      },
      "quietly-wanted",
    ).thresholds,
    { minVotes: 3, minWatchers: 5, minDuplicates: 0, minComments: 5 },
  );
  assert.deepEqual(
    resolvedById(
      { "left-behind": { thresholds: { minAgeDays: undefined, minQuietDays: -1 } } },
      "left-behind",
    ).thresholds,
    { minAgeDays: 180, minQuietDays: -1 },
  );
});

// Extends "[boundary-17] unknown thresholds and unknown categories are ignored": inherited names and custom lists.
test("[boundary-17] threshold names inherited from Object are unknown too", () => {
  assert.deepEqual(
    resolvedById(
      { "paper-cuts": { thresholds: { toString: 5, constructor: 6, hasOwnProperty: 7 } } },
      "paper-cuts",
    ).thresholds,
    { minAgeDays: 90 },
  );
});

test("[boundary-17] unknown categories never add entries, whatever their settings", () => {
  const resolved = resolveCategories({
    "no-such-category": { enabled: true, thresholds: { minAgeDays: 1 } },
    uncategorized: { enabled: true },
    other: {},
    "left-behind": { thresholds: { minAgeDays: 200, minVotes: 3 } },
  });
  assert.deepEqual(resolved, [
    { ...DEFAULT_RESOLVED[0], thresholds: { minAgeDays: 200, minQuietDays: 90 } },
    ...DEFAULT_RESOLVED.slice(1),
  ]);
  const only = custom("only", "Only", () => all(), { n: 1 });
  assert.deepEqual(
    resolveCategories({ "left-behind": { enabled: false }, only: { thresholds: { m: 4 } } }, [only]),
    [{ id: "only", label: "Only", why: "Only.", enabled: true, thresholds: { n: 1 } }],
  );
});

// Extends "[happy-12] only false switches a category off ...": other categories, several at once.
test("[happy-12] switching several categories off keeps them all, in order, with resolved thresholds", () => {
  const resolved = resolveCategories({
    "left-behind": { enabled: false },
    "holding-others-up": { enabled: false, thresholds: { minBlocked: 4 } },
    "paper-cuts": { enabled: true, thresholds: { minAgeDays: 30 } },
    "deadline-exposed": { enabled: undefined },
  });
  assert.deepEqual(
    resolved.map((c) => [c.id, c.enabled]),
    [
      ["left-behind", false],
      ["always-next-sprint", true],
      ["quietly-wanted", true],
      ["holding-others-up", false],
      ["paper-cuts", true],
      ["deadline-exposed", true],
    ],
  );
  assert.deepEqual(resolved[3]?.thresholds, { minBlocked: 4 });
  assert.deepEqual(resolved[4]?.thresholds, { minAgeDays: 30 });

  const allOff: Record<string, { enabled: false }> = {};
  for (const entry of REGISTRY) allOff[entry.id] = { enabled: false };
  assert.deepEqual(
    resolveCategories(allOff),
    DEFAULT_RESOLVED.map((c) => ({ ...c, enabled: false })),
  );
});

// Extends "[boundary-18] resolving returns fresh objects ...": every category, and the thresholds objects too.
test("[boundary-18] resolving returns fresh thresholds for every category and leaves every default alone", () => {
  const before = structuredClone(REGISTRY.map((e) => e.defaults));
  const resolved = resolveCategories({
    "paper-cuts": { thresholds: { minAgeDays: 1 } },
    "deadline-exposed": { thresholds: { withinDays: 2 } },
    "quietly-wanted": { enabled: false, thresholds: { minVotes: 0 } },
  });
  assert.deepEqual(resolved[4]?.thresholds, { minAgeDays: 1 });
  assert.deepEqual(
    CATEGORIES.map((c) => c.defaults),
    before,
  );
  assert.deepEqual(resolveCategories(), DEFAULT_RESOLVED);
  const first = resolveCategories();
  const second = resolveCategories();
  first.forEach((entry, i) => {
    assert.notEqual(entry, second[i]);
    assert.notEqual(entry.thresholds, CATEGORIES[i]?.defaults);
  });
});

test("[boundary-18] a custom category's defaults are not changed by resolving it", () => {
  const defaults = { x: 1, y: 2 };
  const own = custom("own", "Own", () => all(), defaults);
  assert.deepEqual(resolvedById({ own: { thresholds: { x: 5 } } }, "own", [own]).thresholds, { x: 5, y: 2 });
  assert.deepEqual(defaults, { x: 1, y: 2 });
  assert.deepEqual(resolvedById({}, "own", [own]).thresholds, { x: 1, y: 2 });
});

// Extends "[happy-13] each shipped category matches at its defaults with its reason": other facts per category.
test("[happy-13] each shipped category matches other facts at its defaults", () => {
  const examples: [Partial<IssueFacts>, string, string][] = [
    [{ ageDays: 1000, daysSinceUpdate: 90 }, "left-behind", "Open 1000 days, never in a sprint, unassigned"],
    [{ closedSprintCount: 5, carriedSince: "November 2025" }, "always-next-sprint", "Carried over 5 sprints since November 2025"],
    [{ commentCount: 6, priorityName: "Lowest", priorityRank: "low" }, "quietly-wanted", "6 comments, priority Lowest"],
    [{ duplicateLinks: 2, priorityName: "Minor", priorityRank: "low", assigned: true }, "quietly-wanted", "2 duplicates linked, priority Minor"],
    [{ votes: 10, watchers: 1, commentCount: 2, priorityName: "Trivial", priorityRank: "low" }, "quietly-wanted", "10 votes, priority Trivial"],
    [{ watchers: 5, priorityName: "Low", priorityRank: "low", inSprint: true }, "quietly-wanted", "5 watchers, priority Low"],
    [{ blocksOpenCount: 5 }, "holding-others-up", "Blocks 5 open tickets, unassigned"],
    [{ isBug: true, priorityName: "Normal", priorityRank: "medium", ageDays: 95, assigned: true }, "paper-cuts", "Normal-priority bug, open 95 days"],
    [{ release: { name: "2.4", inDays: 12 } }, "deadline-exposed", "Release 2.4 in 12 days, not in any sprint"],
    [{ dueInDays: 0, closedSprintCount: 1 }, "deadline-exposed", "Due today, not in any sprint"],
  ];
  for (const [changes, id, reason] of examples) {
    assert.deepEqual(classify(factsWith(changes)), [match(id, reason)], JSON.stringify(changes));
  }
});

test("[happy-13] facts just outside each shipped rule match nothing", () => {
  const examples: Partial<IssueFacts>[] = [
    { ageDays: 400, daysSinceUpdate: 200, closedSprintCount: 1 },
    { ageDays: 400, daysSinceUpdate: 200, inSprint: true },
    { ageDays: 179, daysSinceUpdate: 200 },
    { closedSprintCount: 1, carriedSince: "May" },
    { votes: 4, watchers: 7, priorityName: "Medium", priorityRank: "medium" },
    { votes: 4, priorityName: null, priorityRank: "none" },
    { votes: 2, watchers: 4, commentCount: 4, priorityName: "Low", priorityRank: "low" },
    { blocksOpenCount: 3, assigned: true },
    { isBug: true, priorityName: "High", priorityRank: "high", ageDays: 120, assigned: true },
    { isBug: true, priorityName: null, priorityRank: "none", ageDays: 120, assigned: true },
    { isBug: true, priorityName: "Low", priorityRank: "low", ageDays: 89, assigned: true },
    { dueInDays: 31 },
    { dueInDays: -1 },
    { dueInDays: 5, inSprint: true },
    { release: { name: "2.4", inDays: -3 } },
  ];
  for (const changes of examples) {
    assert.deepEqual(classify(factsWith(changes)), [], JSON.stringify(changes));
  }
});

// Extends "[happy-14] an issue can fit several categories ...": another five-way match and custom order.
test("[happy-14] a different five categories match together, in registry order", () => {
  const facts = factsWith({
    ageDays: 400,
    daysSinceUpdate: 200,
    votes: 3,
    priorityName: "Low",
    priorityRank: "low",
    blocksOpenCount: 1,
    isBug: true,
    dueInDays: 0,
  });
  assert.deepEqual(classify(facts), [
    match("left-behind", "Open 400 days, never in a sprint, unassigned"),
    match("quietly-wanted", "3 votes, priority Low"),
    match("holding-others-up", "Blocks 1 open ticket, unassigned"),
    match("paper-cuts", "Low-priority bug, open 400 days"),
    match("deadline-exposed", "Due today, not in any sprint"),
  ]);
});

test("[happy-14] matches follow the order of the category list given", () => {
  const facts = factsWith({
    ageDays: 400,
    daysSinceUpdate: 200,
    isBug: true,
    priorityName: "Trivial",
    priorityRank: "low",
    dueInDays: 3,
  });
  assert.deepEqual(classify(facts, {}, [...CATEGORIES].reverse()), [
    match("deadline-exposed", "Due in 3 days, not in any sprint"),
    match("paper-cuts", "Trivial-priority bug, open 400 days"),
    match("left-behind", "Open 400 days, never in a sprint, unassigned"),
  ]);
  const zeta = custom("zeta", "Zeta", () => always("z"));
  const alpha = custom("alpha", "Alpha", () => always("a"));
  const mid = custom("mid", "Mid", () => always("m"));
  assert.deepEqual(classify(BASE_FACTS, {}, [zeta, alpha, mid]), [
    { id: "zeta", label: "Zeta", reason: "Z" },
    { id: "alpha", label: "Alpha", reason: "A" },
    { id: "mid", label: "Mid", reason: "M" },
  ]);
});

// Extends "[boundary-19] an issue that fits nothing gets an empty list ...".
test("[boundary-19] nothing to match gives an empty list, never UNCATEGORIZED", () => {
  assert.deepEqual(classify(BASE_FACTS), []);
  assert.deepEqual(classify(factsWith({ assigned: true, inSprint: true, ageDays: 1000 })), []);
  assert.deepEqual(classify(factsWith({ dueInDays: 3 }), {}, []), []);
  const allOff: Record<string, { enabled: false }> = {};
  for (const entry of REGISTRY) allOff[entry.id] = { enabled: false };
  assert.deepEqual(
    classify(factsWith({ ageDays: 400, daysSinceUpdate: 200, dueInDays: 3 }), allOff),
    [],
  );
  const never = custom("never", "Never", () => signal("n", () => false, () => "n"));
  const matches = createClassifier({}, [never])(BASE_FACTS);
  assert.ok(!matches.some((m) => m.id === UNCATEGORIZED));
  assert.deepEqual(matches, []);
});

// Extends "[boundary-20] a silent clause can make or break a match ...": the other silent clauses.
test("[boundary-20] the silent priority of paper cuts and quiet days of left behind decide without showing", () => {
  const bugFacts = { isBug: true, ageDays: 120, assigned: true };
  assert.deepEqual(
    classify(factsWith({ ...bugFacts, priorityName: "Medium", priorityRank: "medium" })),
    [match("paper-cuts", "Medium-priority bug, open 120 days")],
  );
  assert.deepEqual(
    classify(factsWith({ ...bugFacts, priorityName: "High", priorityRank: "high" })),
    [],
  );
  assert.deepEqual(
    classify(factsWith({ ageDays: 400, daysSinceUpdate: 90 })),
    [match("left-behind", "Open 400 days, never in a sprint, unassigned")],
  );
  assert.deepEqual(classify(factsWith({ ageDays: 400, daysSinceUpdate: 89 })), []);
  assert.deepEqual(
    classify(factsWith({ release: { name: "2.4", inDays: 2 }, closedSprintCount: 1 })),
    [match("deadline-exposed", "Release 2.4 in 2 days, not in any sprint")],
  );
  assert.deepEqual(
    classify(factsWith({ release: { name: "2.4", inDays: 2 }, closedSprintCount: 1, assigned: true })),
    [],
  );
});

// Extends "[happy-15] overrides change what matches": the other categories' thresholds.
test("[happy-15] threshold overrides of other categories change what matches", () => {
  const left = factsWith({ ageDays: 40, daysSinceUpdate: 0 });
  assert.deepEqual(classify(left), []);
  assert.deepEqual(
    classify(left, { "left-behind": { thresholds: { minAgeDays: 30, minQuietDays: 0 } } }),
    [match("left-behind", "Open 40 days, never in a sprint, unassigned")],
  );

  const wanted = factsWith({ votes: 1, priorityName: "Low", priorityRank: "low" });
  assert.deepEqual(classify(wanted), []);
  assert.deepEqual(
    classify(wanted, { "quietly-wanted": { thresholds: { minVotes: 1 } } }),
    [match("quietly-wanted", "1 vote, priority Low")],
  );

  const due = factsWith({ dueInDays: 45, inSprint: true, assigned: true });
  const dueOut = factsWith({ dueInDays: 45 });
  assert.deepEqual(classify(dueOut), []);
  assert.deepEqual(
    classify(dueOut, { "deadline-exposed": { thresholds: { withinDays: 60 } } }),
    [match("deadline-exposed", "Due in 45 days, not in any sprint")],
  );
  assert.deepEqual(classify(due, { "deadline-exposed": { thresholds: { withinDays: 60 } } }), []);

  const blocking = factsWith({ blocksOpenCount: 2 });
  assert.deepEqual(classify(blocking), [match("holding-others-up", "Blocks 2 open tickets, unassigned")]);
  assert.deepEqual(classify(blocking, { "holding-others-up": { thresholds: { minBlocked: 3 } } }), []);

  const youngBug = factsWith({ isBug: true, priorityName: "Low", priorityRank: "low", assigned: true });
  assert.deepEqual(
    classify(youngBug, { "paper-cuts": { thresholds: { minAgeDays: 0 } } }),
    [match("paper-cuts", "Low-priority bug, open 0 days")],
  );
});

test("[happy-15] disabling one of several matches drops only that one, and non-finite overrides keep defaults", () => {
  const facts = factsWith({
    ageDays: 400,
    daysSinceUpdate: 200,
    isBug: true,
    priorityName: "Trivial",
    priorityRank: "low",
    dueInDays: 3,
  });
  assert.deepEqual(classify(facts, { "left-behind": { enabled: false } }), [
    match("paper-cuts", "Trivial-priority bug, open 400 days"),
    match("deadline-exposed", "Due in 3 days, not in any sprint"),
  ]);
  assert.deepEqual(
    classify(facts, { "deadline-exposed": { enabled: false }, "paper-cuts": { enabled: false } }),
    [match("left-behind", "Open 400 days, never in a sprint, unassigned")],
  );
  const carried = factsWith({ closedSprintCount: 1, assigned: true });
  assert.deepEqual(
    classify(carried, { "always-next-sprint": { thresholds: { minSprints: Number.NaN } } }),
    [],
  );
  assert.deepEqual(
    classify(carried, { "always-next-sprint": { thresholds: { minSprints: null } } }),
    [],
  );
  assert.deepEqual(
    classify(factsWith({ closedSprintCount: 2, assigned: true }), {
      "always-next-sprint": { thresholds: { minSprints: Number.POSITIVE_INFINITY } },
    }),
    [match("always-next-sprint", "Carried over 2 sprints")],
  );
});

// Extends "[boundary-21] a rule that matches with no clauses gives the category's label as the reason".
test("[boundary-21] every rule that matches without clauses falls back to the label", () => {
  const { A } = { A: always("alpha") };
  const categories = [
    custom("silent", "Silent one", () => silent(A)),
    custom("nulls", "Null clause", () => any(always(null), always(null))),
    custom("nested", "Nested empty", () => all(all(), any(all()))),
    custom("spoken", "Spoken", () => all(A, always("beta"))),
  ];
  assert.deepEqual(classify(BASE_FACTS, {}, categories), [
    { id: "silent", label: "Silent one", reason: "Silent one" },
    { id: "nulls", label: "Null clause", reason: "Null clause" },
    { id: "nested", label: "Nested empty", reason: "Nested empty" },
    { id: "spoken", label: "Spoken", reason: "Alpha, beta" },
  ]);
});

test("[boundary-21] the reason upper-cases only its first character", () => {
  const categories = [
    custom("lower", "Lower", () => all(always("many words here"), always("second clause"))),
    custom("digit", "Digit", () => always("3 votes")),
    custom("upper", "Upper", () => always("Already Upper")),
    custom("one", "One", () => always("x")),
  ];
  assert.deepEqual(classify(BASE_FACTS, {}, categories), [
    { id: "lower", label: "Lower", reason: "Many words here, second clause" },
    { id: "digit", label: "Digit", reason: "3 votes" },
    { id: "upper", label: "Upper", reason: "Already Upper" },
    { id: "one", label: "One", reason: "X" },
  ]);
});

function countingCategories() {
  const calls: Record<string, Thresholds[]> = { one: [], two: [], three: [] };
  const counted =
    (id: string) =>
    (thresholds: Thresholds): Rule => {
      calls[id]?.push(thresholds);
      return signal(
        "s",
        (f) => f.votes >= (thresholds["votes"] ?? 1),
        (f) => `${id} ${f.votes}`,
      );
    };
  const one: Category = { id: "one", label: "One", why: "First.", defaults: { votes: 1 }, rule: counted("one") };
  const two: Category = { id: "two", label: "Two", why: "Second.", defaults: {}, rule: counted("two") };
  const three: Category = { id: "three", label: "Three", why: "Third.", defaults: { votes: 2, other: 0 }, rule: counted("three") };
  return { calls, one, two, three };
}

// Extends "[happy-16] createClassifier builds each enabled rule once and is reusable": resolved thresholds, three categories, many calls.
test("[happy-16] each enabled rule is built once, from its resolved thresholds, however often the classifier runs", () => {
  const { calls, one, two, three } = countingCategories();
  const C = createClassifier(
    {
      one: { thresholds: { votes: 3, extra: 9 } },
      two: { enabled: false },
      three: { thresholds: { votes: Number.NaN, other: 4 } },
    },
    [one, two, three],
  );
  assert.deepEqual(calls.one, [{ votes: 3 }]);
  assert.deepEqual(calls.two, []);
  assert.deepEqual(calls.three, [{ votes: 2, other: 4 }]);

  assert.deepEqual(C(factsWith({ votes: 2 })), [{ id: "three", label: "Three", reason: "Three 2" }]);
  assert.deepEqual(C(factsWith({ votes: 3 })), [
    { id: "one", label: "One", reason: "One 3" },
    { id: "three", label: "Three", reason: "Three 3" },
  ]);
  for (let votes = 0; votes < 20; votes += 1) {
    const expected = [
      ...(votes >= 3 ? [{ id: "one", label: "One", reason: `One ${votes}` }] : []),
      ...(votes >= 2 ? [{ id: "three", label: "Three", reason: `Three ${votes}` }] : []),
    ];
    assert.deepEqual(C(factsWith({ votes })), expected, `votes ${votes}`);
  }
  assert.equal(calls.one?.length, 1);
  assert.equal(calls.two?.length, 0);
  assert.equal(calls.three?.length, 1);
});

// Extends "[boundary-22] classify is createClassifier applied once ...": other configs, facts and thresholds.
test("[boundary-22] classify agrees with createClassifier for many configs and facts", () => {
  const configs: CategoryConfig[] = [
    {},
    { "left-behind": { enabled: false } },
    { "always-next-sprint": { thresholds: { minSprints: 1 } } },
    { "deadline-exposed": { thresholds: { withinDays: 2 } }, "paper-cuts": { thresholds: { minAgeDays: 500 } } },
  ];
  const factsList = [
    BASE_FACTS,
    factsWith({ ageDays: 400, daysSinceUpdate: 200, isBug: true, priorityName: "Trivial", priorityRank: "low", dueInDays: 3 }),
    factsWith({ closedSprintCount: 1, assigned: true }),
    factsWith({ blocksOpenCount: 4, votes: 9, priorityName: "Low", priorityRank: "low", closedSprintCount: 3 }),
  ];
  for (const config of configs) {
    const C = createClassifier(config);
    for (const facts of factsList) {
      assert.deepEqual(classify(facts, config), C(facts), JSON.stringify({ config, facts }));
    }
  }
  assert.deepEqual(
    classify(factsList[1] ?? BASE_FACTS, configs[3]).map((m) => m.id),
    ["left-behind"],
  );
});

test("[boundary-22] classify builds the enabled rules on every call, and classifiers with different thresholds stay apart", () => {
  const { calls, one, two } = countingCategories();
  const config: CategoryConfig = { two: { enabled: false } };
  classify(factsWith({ votes: 1 }), config, [one, two]);
  classify(BASE_FACTS, config, [one, two]);
  assert.equal(calls.one?.length, 2);
  assert.equal(calls.two?.length, 0);

  const facts = factsWith({ closedSprintCount: 1, assigned: true });
  const loose = createClassifier({ "always-next-sprint": { thresholds: { minSprints: 1 } } });
  const strict = createClassifier();
  const looseMatch = [match("always-next-sprint", "Carried over 1 sprint")];
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(loose(facts), looseMatch);
    assert.deepEqual(strict(facts), []);
  }
});
