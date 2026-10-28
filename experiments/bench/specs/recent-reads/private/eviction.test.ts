import assert from "node:assert/strict";
import { test } from "node:test";
import { recentReads } from "../../src/jira/recent.js";

// The spec's Background: a clock "now" returning the number held in "t",
// starting at 1000000.
function fakeClock() {
  const clock = { t: 1000000, now: () => clock.t };
  return clock;
}

// Extends "[boundary-8] max defaults to 1000".
test("[boundary-8] several new keys past the default max drop the same number of oldest writes", () => {
  const clock = fakeClock();
  const store = recentReads<number>({ now: clock.now });
  for (let i = 0; i < 1005; i++) store.set(`k${i}`, i);
  for (let i = 0; i < 5; i++) assert.equal(store.get(`k${i}`), undefined, `k${i}`);
  for (let i = 5; i < 1005; i++) assert.equal(store.get(`k${i}`), i, `k${i}`);
});

test("[boundary-8] max still defaults to 1000 when ttlMs is given", () => {
  const clock = fakeClock();
  const store = recentReads<number>({ now: clock.now, ttlMs: 3600000 });
  for (let i = 0; i < 1000; i++) store.set(`k${i}`, i);
  assert.equal(store.get("k0"), 0);
  assert.equal(store.get("k999"), 999);
  store.set("k1000", 1000);
  assert.equal(store.get("k0"), undefined);
  assert.equal(store.get("k1"), 1);
});

test("[boundary-8] at the default max, rewrites spread through the store move those keys behind the rest", () => {
  const clock = fakeClock();
  const store = recentReads<number>({ now: clock.now });
  for (let i = 0; i < 1000; i++) store.set(`k${i}`, i);
  store.set("k0", -0.5);
  store.set("k2", -2);
  for (let i = 1000; i < 1002; i++) store.set(`k${i}`, i);
  assert.equal(store.get("k1"), undefined);
  assert.equal(store.get("k3"), undefined);
  assert.equal(store.get("k0"), -0.5);
  assert.equal(store.get("k2"), -2);
  assert.equal(store.get("k4"), 4);
  assert.equal(store.get("k1001"), 1001);
});

// Extends "[boundary-9] the oldest write is dropped when a new key exceeds max".
test("[boundary-9] with max 5, twelve new keys leave only the last five", () => {
  const clock = fakeClock();
  const store = recentReads<number>({ now: clock.now, max: 5 });
  for (let i = 0; i < 12; i++) store.set(`k${i}`, i);
  for (let i = 0; i < 7; i++) assert.equal(store.get(`k${i}`), undefined, `k${i}`);
  for (let i = 7; i < 12; i++) assert.equal(store.get(`k${i}`), i, `k${i}`);
});

test("[boundary-9] a store below max drops nothing", () => {
  const clock = fakeClock();
  const store = recentReads<number>({ now: clock.now, max: 4 });
  for (let i = 0; i < 4; i++) store.set(`k${i}`, i);
  for (let i = 0; i < 4; i++) assert.equal(store.get(`k${i}`), i, `k${i}`);
});

test("[boundary-9] the dropped entry is the oldest write, not the first key in sort order", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, max: 3 });
  store.set("z", "Z");
  store.set("a", "A");
  store.set("m", "M");
  store.set("b", "B");
  assert.equal(store.get("z"), undefined);
  assert.equal(store.get("a"), "A");
  assert.equal(store.get("m"), "M");
  assert.equal(store.get("b"), "B");
  store.set("c", "C");
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("m"), "M");
});

test("[boundary-9] a dropped key written again is a new key and drops the then-oldest write", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, max: 2 });
  store.set("a", "A1");
  store.set("b", "B");
  store.set("c", "C");
  assert.equal(store.get("a"), undefined);
  store.set("a", "A2");
  assert.equal(store.get("b"), undefined);
  assert.equal(store.get("c"), "C");
  assert.equal(store.get("a"), "A2");
});

// Extends "[boundary-10] rewriting an existing key in a full store drops nothing and makes it the newest".
test("[boundary-10] rewriting a middle key in a larger full store drops nothing and makes it the newest", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, max: 4 });
  for (const key of ["a", "b", "c", "d"]) store.set(key, key.toUpperCase());
  store.set("b", "B2");
  for (const [key, value] of [["a", "A"], ["b", "B2"], ["c", "C"], ["d", "D"]] as const) {
    assert.equal(store.get(key), value, key);
  }
  store.set("e", "E");
  store.set("f", "F");
  store.set("g", "G");
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("c"), undefined);
  assert.equal(store.get("d"), undefined);
  assert.equal(store.get("b"), "B2");
  assert.equal(store.get("e"), "E");
  assert.equal(store.get("f"), "F");
  assert.equal(store.get("g"), "G");
  store.set("h", "H");
  assert.equal(store.get("b"), undefined);
  assert.equal(store.get("e"), "E");
});

test("[boundary-10] many rewrites of every key in a full store drop nothing", () => {
  const clock = fakeClock();
  const store = recentReads<number>({ now: clock.now, max: 3 });
  for (let round = 0; round < 4; round++) {
    for (const key of ["a", "b", "c"]) store.set(key, round);
  }
  assert.equal(store.get("a"), 3);
  assert.equal(store.get("b"), 3);
  assert.equal(store.get("c"), 3);
  store.set("c", 4);
  store.set("a", 4);
  store.set("d", 0);
  assert.equal(store.get("b"), undefined);
  assert.equal(store.get("c"), 4);
  assert.equal(store.get("a"), 4);
  store.set("e", 0);
  assert.equal(store.get("c"), undefined);
  assert.equal(store.get("a"), 4);
});

// Extends "[boundary-11] reading an entry does not protect it from eviction".
test("[boundary-11] reading every entry newest first does not change which is dropped", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, max: 4 });
  for (const key of ["a", "b", "c", "d"]) store.set(key, key);
  for (const key of ["d", "c", "b", "a", "a", "b"]) assert.equal(store.get(key), key);
  store.set("e", "e");
  assert.equal(store.get("a"), undefined);
  store.set("f", "f");
  assert.equal(store.get("b"), undefined);
  assert.equal(store.get("c"), "c");
  assert.equal(store.get("d"), "d");
});

test("[boundary-11] reading the oldest entry later in time does not protect it from eviction", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, max: 2 });
  store.set("a", "A");
  clock.t = 1000500;
  store.set("b", "B");
  clock.t = 1001000;
  assert.equal(store.get("a"), "A");
  store.set("c", "C");
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("b"), "B");
  assert.equal(store.get("c"), "C");
});

// Extends "[boundary-12] a max of 1 keeps only the latest key".
test("[boundary-12] a max of 1 across many keys keeps only the last one written", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, max: 1 });
  for (const key of ["a", "b", "c", "d", "e"]) store.set(key, key.toUpperCase());
  for (const key of ["a", "b", "c", "d"]) assert.equal(store.get(key), undefined, key);
  assert.equal(store.get("e"), "E");
  store.set("e", "E2");
  assert.equal(store.get("e"), "E2");
  store.set("a", "A2");
  assert.equal(store.get("e"), undefined);
  assert.equal(store.get("a"), "A2");
});

// Extends "[unhappy-3] a max of 0 still keeps the latest key".
test("[unhappy-3] a max of 0 keeps the latest key, including after reads, and that key still expires", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, max: 0, ttlMs: 1000 });
  store.set("a", "A");
  assert.equal(store.get("a"), "A");
  store.set("b", "B");
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("b"), "B");
  for (const key of ["c", "d", "e"]) store.set(key, key.toUpperCase());
  assert.equal(store.get("b"), undefined);
  assert.equal(store.get("d"), undefined);
  assert.equal(store.get("e"), "E");
  clock.t = 1000999;
  assert.equal(store.get("e"), "E");
  clock.t = 1001000;
  assert.equal(store.get("e"), undefined);
});

test("[unhappy-3] a max of 0 keeps a single falsy value", () => {
  const clock = fakeClock();
  const store = recentReads<unknown>({ now: clock.now, max: 0 });
  store.set("a", "A");
  store.set("b", null);
  assert.equal(store.get("b"), null);
  assert.equal(store.get("a"), undefined);
});

// Extends "[happy-8] two stores with the same key do not see each other's writes".
test("[happy-8] stores with different ttls on one clock expire their own entries independently", () => {
  const clock = fakeClock();
  const short = recentReads<string>({ now: clock.now, ttlMs: 1000 });
  const long = recentReads<string>({ now: clock.now, ttlMs: 3600000 });
  short.set("k", "short");
  long.set("k", "long");
  clock.t = 1001000;
  assert.equal(short.get("k"), undefined);
  assert.equal(long.get("k"), "long");
  short.set("k", "short again");
  clock.t = 4599999;
  assert.equal(long.get("k"), "long");
  assert.equal(short.get("k"), undefined);
});

test("[happy-8] stores on different clocks each read their own clock", () => {
  const first = fakeClock();
  const second = fakeClock();
  const a = recentReads<string>({ now: first.now, ttlMs: 60000 });
  const b = recentReads<string>({ now: second.now, ttlMs: 60000 });
  a.set("k", "one");
  b.set("k", "two");
  first.t = 1060000;
  assert.equal(a.get("k"), undefined);
  assert.equal(b.get("k"), "two");
});

test("[happy-8] writes to one store do not count toward another store's max", () => {
  const clock = fakeClock();
  const first = recentReads<number>({ now: clock.now, max: 2 });
  const second = recentReads<number>({ now: clock.now, max: 2 });
  const third = recentReads<number>({ now: clock.now });
  first.set("a", 1);
  first.set("b", 2);
  for (let i = 0; i < 10; i++) second.set(`s${i}`, i);
  for (let i = 0; i < 10; i++) third.set(`a`, i);
  assert.equal(first.get("a"), 1);
  assert.equal(first.get("b"), 2);
  assert.equal(second.get("a"), undefined);
  assert.equal(second.get("s9"), 9);
  assert.equal(third.get("a"), 9);
  assert.equal(third.get("b"), undefined);
});
