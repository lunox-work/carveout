import assert from "node:assert/strict";
import { test } from "node:test";
import { RECENT_JIRA_READ_MS, recentReads } from "../../src/jira/recent.js";

// The spec's Background: a clock "now" returning the number held in "t",
// starting at 1000000.
function fakeClock() {
  const clock = { t: 1000000, now: () => clock.t };
  return clock;
}

// Extends "[happy-5] RECENT_JIRA_READ_MS passed as ttlMs keeps an entry exactly one minute".
test("[happy-5] RECENT_JIRA_READ_MS is 60000, one minute of ttl for a write made at any time", () => {
  assert.equal(RECENT_JIRA_READ_MS, 60000);
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: RECENT_JIRA_READ_MS });
  clock.t = 2500000;
  store.set("k", "v");
  clock.t = 2559999;
  assert.equal(store.get("k"), "v");
  clock.t = 2560000;
  assert.equal(store.get("k"), undefined);
});

// Extends "[happy-6] called with no options, the store reads back a value immediately on Date.now".
test("[happy-6] called with no options, several values read back immediately", (t) => {
  t.mock.method(Date, "now", () => 1000000);
  const store = recentReads<unknown>();
  const issue = { summary: "Fix login" };
  store.set("org_1\njcn_1\n10001", issue);
  store.set("", null);
  store.set("k", 0);
  assert.equal(store.get("org_1\njcn_1\n10001"), issue);
  assert.equal(store.get(""), null);
  assert.equal(store.get("k"), 0);
  assert.equal(store.get("missing"), undefined);
});

test("[happy-6] called with an empty options object, the store reads back a value immediately", (t) => {
  t.mock.method(Date, "now", () => 1000000);
  const store = recentReads<string>({});
  store.set("k", "v");
  assert.equal(store.get("k"), "v");
});

test("[happy-6] two stores called with no options are each usable and independent", (t) => {
  t.mock.method(Date, "now", () => 1000000);
  const first = recentReads<string>();
  const second = recentReads<string>();
  first.set("k", "one");
  assert.equal(second.get("k"), undefined);
  second.set("k", "two");
  assert.equal(first.get("k"), "one");
  assert.equal(second.get("k"), "two");
});

// Extends "[boundary-6] ttlMs defaults to RECENT_JIRA_READ_MS".
test("[boundary-6] the default ttl runs from each write, not from the store's creation", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now });
  clock.t = 3000000;
  store.set("a", "A");
  clock.t = 3030000;
  store.set("b", "B");
  clock.t = 3059999;
  assert.equal(store.get("a"), "A");
  clock.t = 3060000;
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("b"), "B");
  clock.t = 3089999;
  assert.equal(store.get("b"), "B");
  clock.t = 3090000;
  assert.equal(store.get("b"), undefined);
});

test("[boundary-6] with the default ttl a rewrite restarts a full minute", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, max: 1000 });
  store.set("k", "old");
  clock.t = 1059999;
  store.set("k", "new");
  clock.t = 1119998;
  assert.equal(store.get("k"), "new");
  clock.t = 1119999;
  assert.equal(store.get("k"), undefined);
});

// Extends "[boundary-7] options given as undefined take their defaults for ttlMs".
test("[boundary-7] ttlMs given as undefined alone takes the one-minute default for a later write", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: undefined });
  clock.t = 2000000;
  store.set("k", "v");
  clock.t = 2059999;
  assert.equal(store.get("k"), "v");
  clock.t = 2060000;
  assert.equal(store.get("k"), undefined);
});

// Extends "[boundary-7] max given as undefined takes its default of 1000 entries".
test("[boundary-7] max given as undefined beside an explicit ttlMs still holds 1000 entries", () => {
  const clock = fakeClock();
  const store = recentReads<number>({ now: clock.now, ttlMs: 5000, max: undefined });
  for (let i = 0; i < 1000; i++) store.set(`k${i}`, i);
  assert.equal(store.get("k0"), 0);
  store.set("k1000", 1000);
  store.set("k1001", 1001);
  assert.equal(store.get("k0"), undefined);
  assert.equal(store.get("k1"), undefined);
  assert.equal(store.get("k2"), 2);
  assert.equal(store.get("k1001"), 1001);
  clock.t = 1004999;
  assert.equal(store.get("k2"), 2);
  clock.t = 1005000;
  assert.equal(store.get("k2"), undefined);
});

test("[boundary-7] now given as undefined takes the Date.now default", (t) => {
  t.mock.method(Date, "now", () => 1000000);
  const store = recentReads<string>({ now: undefined });
  store.set("k", "v");
  assert.equal(store.get("k"), "v");
});

test("[boundary-7] every option given as undefined behaves like no options", (t) => {
  t.mock.method(Date, "now", () => 1000000);
  const store = recentReads<number>({ now: undefined, ttlMs: undefined, max: undefined });
  for (let i = 0; i < 1001; i++) store.set(`k${i}`, i);
  assert.equal(store.get("k0"), undefined);
  assert.equal(store.get("k1"), 1);
  assert.equal(store.get("k1000"), 1000);
});

// Extends "[unhappy-1] unusual options do not throw".
test("[unhappy-1] unusual options with a fake clock do not throw and return a store", () => {
  const examples: Array<[number, number]> = [
    [1, 1],
    [0.5, 1],
    [0, 0],
    [-1, -1],
    [NaN, 1.5],
    [Infinity, NaN],
    [-Infinity, Infinity],
    [-1, NaN],
    [NaN, NaN],
    [Infinity, -Infinity],
    [-60000, 0.5],
  ];
  for (const [ttlMs, max] of examples) {
    const clock = fakeClock();
    let store: ReturnType<typeof recentReads<string>> | undefined;
    assert.doesNotThrow(() => {
      store = recentReads<string>({ now: clock.now, ttlMs, max });
    }, `ttlMs ${ttlMs}, max ${max}`);
    assert.equal(typeof store?.get, "function");
    assert.equal(typeof store?.set, "function");
  }
});

test("[unhappy-1] unusual options given one at a time do not throw", () => {
  const examples: Array<{ ttlMs?: number; max?: number }> = [
    { ttlMs: NaN },
    { ttlMs: -Infinity },
    { ttlMs: -1 },
    { max: NaN },
    { max: -1 },
    { max: 1.5 },
    { max: Infinity },
    { ttlMs: 0.5 },
  ];
  for (const options of examples) {
    let store: ReturnType<typeof recentReads> | undefined;
    assert.doesNotThrow(() => {
      store = recentReads(options);
    }, String(options.ttlMs ?? options.max));
    assert.equal(typeof store?.get, "function");
    assert.equal(typeof store?.set, "function");
  }
});

test("[unhappy-1] a ttlMs of 1 and max of 1 is a working store", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 1, max: 1 });
  store.set("a", "A");
  assert.equal(store.get("a"), "A");
  store.set("b", "B");
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("b"), "B");
  clock.t = 1000001;
  assert.equal(store.get("b"), undefined);
});
