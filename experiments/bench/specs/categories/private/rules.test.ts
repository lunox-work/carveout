import assert from "node:assert/strict";
import { test } from "node:test";

import {
  all,
  any,
  evaluate,
  signal,
  silent,
  type IssueFacts,
  type Rule,
  type Signal,
} from "../../src/selection/index.js";

/**
 * Hidden cases for `signal`, `all`, `any`, `silent` and `evaluate`, beyond
 * the public rules suite.
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

function background() {
  return {
    A: signal("a", () => true, () => "alpha"),
    B: signal("b", () => true, () => "beta"),
    N: signal("n", () => false, () => "never"),
    Q: signal("q", () => true, () => null),
  };
}

function counting(id: string, result: boolean, clause: string | null) {
  const calls = { test: [] as IssueFacts[], describe: [] as IssueFacts[] };
  const built: Signal = signal(
    id,
    (facts) => {
      calls.test.push(facts);
      return result;
    },
    (facts) => {
      calls.describe.push(facts);
      return clause;
    },
  );
  return { signal: built, calls };
}

// Extends "[happy-5] signal, all and any build plain values": more rules, nesting and a whole signal value.
test("[happy-5] signal builds a plain value with exactly its id, test and describe", () => {
  const t = (facts: IssueFacts) => facts.votes > 0;
  const d = (facts: IssueFacts) => `${facts.votes}`;
  assert.deepEqual(signal("votes-x", t, d), { id: "votes-x", test: t, describe: d });
  const other = signal("", t, d);
  assert.equal(other.id, "");
  assert.equal(other.test, t);
  assert.equal(other.describe, d);
});

test("[happy-5] all and any keep every rule in the order given, nested or not", () => {
  const { A, B, N, Q } = background();
  assert.deepEqual(all(N, Q, B, A), { all: [N, Q, B, A] });
  assert.deepEqual(any(Q, Q, A), { any: [Q, Q, A] });
  assert.deepEqual(all(A), { all: [A] });
  assert.deepEqual(any(B), { any: [B] });
  const inner = any(A, N);
  const outer = all(B, inner, Q);
  assert.deepEqual(outer, { all: [B, { any: [A, N] }, Q] });
  assert.ok("all" in outer && outer.all[1] === inner);
  const many = Array.from({ length: 20 }, (_, i) => signal(`s${i}`, () => true, () => `c${i}`));
  assert.deepEqual(all(...many), { all: many });
  assert.deepEqual(any(...many), { any: many });
});

// Extends "[happy-6] matching rules collect their clauses in rule order": other combinations.
test("[happy-6] clauses come from the children that matched, in rule order", () => {
  const { A, B, N, Q } = background();
  const examples: [string, Rule, boolean, string[]][] = [
    ["any(A, N, B)", any(A, N, B), true, ["alpha", "beta"]],
    ["any(B, A)", any(B, A), true, ["beta", "alpha"]],
    ["any(all(A, N), B)", any(all(A, N), B), true, ["beta"]],
    ["any(N, all(A, N))", any(N, all(A, N)), false, []],
    ["all(any(N), A)", all(any(N), A), false, []],
    ["all(silent(A), B)", all(silent(A), B), true, ["beta"]],
    ["any(Q, A)", any(Q, A), true, ["alpha"]],
    ["all(B, Q, A)", all(B, Q, A), true, ["beta", "alpha"]],
    ["all(A, all(B, any(N, A)), B)", all(A, all(B, any(N, A)), B), true, ["alpha", "beta", "alpha", "beta"]],
    ["all(A, all(B, any(N)))", all(A, all(B, any(N))), false, []],
    ["any(any(any(B)))", any(any(any(B))), true, ["beta"]],
  ];
  for (const [name, rule, matched, clauses] of examples) {
    assert.deepEqual(evaluate(rule, BASE_FACTS), { matched, clauses }, name);
  }
});

test("[happy-6] evaluate hands the facts to test and describe", () => {
  const votes = signal(
    "votes",
    (facts) => facts.votes >= 3,
    (facts) => `${facts.votes} votes seen`,
  );
  const blocked = signal(
    "blocked",
    (facts) => facts.blocksOpenCount > 0,
    (facts) => `blocking ${facts.blocksOpenCount}`,
  );
  assert.deepEqual(evaluate(votes, factsWith({ votes: 5 })), {
    matched: true,
    clauses: ["5 votes seen"],
  });
  assert.deepEqual(evaluate(votes, factsWith({ votes: 2 })), {
    matched: false,
    clauses: [],
  });
  assert.deepEqual(
    evaluate(any(votes, blocked), factsWith({ votes: 1, blocksOpenCount: 4 })),
    { matched: true, clauses: ["blocking 4"] },
  );
  assert.deepEqual(
    evaluate(all(votes, blocked), factsWith({ votes: 9, blocksOpenCount: 4 })),
    { matched: true, clauses: ["9 votes seen", "blocking 4"] },
  );
  const facts = factsWith({ votes: 7 });
  const spy = counting("spy", true, "spied");
  evaluate(spy.signal, facts);
  assert.equal(spy.calls.test[0], facts);
  assert.equal(spy.calls.describe[0], facts);
});

test("[happy-6] only null clauses are dropped; an empty string is kept", () => {
  const E = signal("e", () => true, () => "");
  const { A } = background();
  assert.deepEqual(evaluate(all(E, A), BASE_FACTS), {
    matched: true,
    clauses: ["", "alpha"],
  });
});

test("[happy-6] a long rule keeps every clause in order", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    signal(`s${i}`, () => i % 3 !== 0, () => `c${i}`),
  );
  const expected = many.flatMap((_, i) => (i % 3 !== 0 ? [`c${i}`] : []));
  assert.deepEqual(evaluate(any(...many), BASE_FACTS), {
    matched: true,
    clauses: expected,
  });
  assert.deepEqual(evaluate(all(...many), BASE_FACTS), {
    matched: false,
    clauses: [],
  });
});

// Extends "[boundary-10] empty combinators follow every and some": nested empties.
test("[boundary-10] nested empty combinators follow every and some", () => {
  const { A } = background();
  const examples: [string, Rule, boolean, string[]][] = [
    ["all(all())", all(all()), true, []],
    ["any(all())", any(all()), true, []],
    ["all(any())", all(any()), false, []],
    ["any(any())", any(any()), false, []],
    ["all(A, all())", all(A, all()), true, ["alpha"]],
    ["any(any(), A)", any(any(), A), true, ["alpha"]],
    ["all(A, any())", all(A, any()), false, []],
  ];
  for (const [name, rule, matched, clauses] of examples) {
    assert.deepEqual(evaluate(rule, BASE_FACTS), { matched, clauses }, name);
  }
});

// Extends "[boundary-11] all and any evaluate every child": longer lists and nesting, each test exactly once.
test("[boundary-11] every child of all and any is tested exactly once, nested or after a decided result", () => {
  const first = counting("first", false, "first");
  const second = counting("second", true, "second");
  const third = counting("third", false, "third");
  assert.deepEqual(
    evaluate(all(first.signal, second.signal, third.signal), BASE_FACTS),
    { matched: false, clauses: [] },
  );
  assert.equal(first.calls.test.length, 1);
  assert.equal(second.calls.test.length, 1);
  assert.equal(third.calls.test.length, 1);

  const p = counting("p", true, "p");
  const q = counting("q", true, "q");
  const r = counting("r", false, "r");
  assert.deepEqual(evaluate(any(p.signal, q.signal, r.signal), BASE_FACTS), {
    matched: true,
    clauses: ["p", "q"],
  });
  assert.equal(p.calls.test.length, 1);
  assert.equal(q.calls.test.length, 1);
  assert.equal(r.calls.test.length, 1);
  assert.equal(p.calls.describe.length, 1);
  assert.equal(q.calls.describe.length, 1);

  const { N } = background();
  const deep = counting("deep", false, "deep");
  evaluate(all(N, any(all(deep.signal))), BASE_FACTS);
  assert.equal(deep.calls.test.length, 1);
});

// Extends "[boundary-12] describe runs only for a signal whose test matched": inside combinators.
test("[boundary-12] describe is never called for a failing signal inside all or any", () => {
  const { A } = background();
  const inAny = counting("s", false, "s");
  assert.deepEqual(evaluate(any(inAny.signal, A), BASE_FACTS), {
    matched: true,
    clauses: ["alpha"],
  });
  assert.equal(inAny.calls.describe.length, 0);

  const inAll = counting("s", false, "s");
  evaluate(all(A, inAll.signal), BASE_FACTS);
  assert.equal(inAll.calls.describe.length, 0);

  const nested = counting("s", false, "s");
  evaluate(any(all(nested.signal), any(nested.signal)), BASE_FACTS);
  assert.equal(nested.calls.test.length, 2);
  assert.equal(nested.calls.describe.length, 0);
});

// Extends "[happy-7] silent keeps the id and test ...": facts-reading signals, any facts, and silencing twice.
test("[happy-7] silent never describes whatever the facts, and silencing twice is still silent", () => {
  const votes = signal(
    "votes",
    (facts) => facts.votes >= 3,
    (facts) => `${facts.votes} votes`,
  );
  const quiet = silent(votes);
  assert.equal(quiet.id, "votes");
  assert.equal(quiet.test, votes.test);
  assert.notEqual(quiet, votes);
  assert.equal(quiet.describe(factsWith({ votes: 10 })), null);
  assert.equal(votes.describe(factsWith({ votes: 10 })), "10 votes");
  assert.deepEqual(evaluate(quiet, factsWith({ votes: 10 })), {
    matched: true,
    clauses: [],
  });
  assert.deepEqual(evaluate(quiet, factsWith({ votes: 1 })), {
    matched: false,
    clauses: [],
  });
  const twice = silent(quiet);
  assert.equal(twice.id, "votes");
  assert.equal(twice.test, votes.test);
  assert.equal(twice.describe(factsWith({ votes: 10 })), null);
  assert.deepEqual(evaluate(all(twice, votes), factsWith({ votes: 4 })), {
    matched: true,
    clauses: ["4 votes"],
  });
});
