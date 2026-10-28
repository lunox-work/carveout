import assert from "node:assert/strict";
import { test } from "node:test";
import { recentReads } from "../../src/jira/recent.js";

// The spec's Background: a clock "now" returning the number held in "t",
// starting at 1000000.
function fakeClock() {
  const clock = { t: 1000000, now: () => clock.t };
  return clock;
}

// Extends "[happy-1] a value just written is returned as the same object".
test("[happy-1] arrays, nested objects and functions are returned by reference for each of several keys", () => {
  const clock = fakeClock();
  const store = recentReads<unknown>({ now: clock.now, ttlMs: 60000 });
  const nested = { issue: { fields: { summary: "Fix login" } } };
  const list = [{ id: "10001" }, { id: "10002" }];
  const fn = () => "read";
  store.set("org_1\njcn_1\n10001", nested);
  store.set("org_1\njcn_1\n10002", list);
  store.set("org_1\njcn_1\n10003", fn);
  clock.t = 1030000;
  assert.equal(store.get("org_1\njcn_1\n10001"), nested);
  assert.equal(store.get("org_1\njcn_1\n10002"), list);
  assert.equal(store.get("org_1\njcn_1\n10003"), fn);
  assert.equal(store.get("org_1\njcn_1\n10002"), store.get("org_1\njcn_1\n10002"));
});

// Extends "[happy-1] a value read at the last fresh millisecond is still the written object".
test("[happy-1] a value written with a ttl other than one minute is the same object until just before it expires", () => {
  const clock = fakeClock();
  clock.t = 7000000;
  const store = recentReads<{ summary: string }>({ now: clock.now, ttlMs: 2500 });
  const issue = { summary: "Fix login" };
  store.set("k", issue);
  clock.t = 7002499;
  assert.equal(store.get("k"), issue);
});

// Extends "[happy-2] a key never written is a miss": a store backed by a plain
// object would answer for inherited property names.
test("[happy-2] keys named like built-in object properties are misses when never written", () => {
  const clock = fakeClock();
  const store = recentReads<unknown>({ now: clock.now });
  store.set("k", "v");
  for (const key of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "prototype",
    "size",
    "length",
  ]) {
    assert.equal(store.get(key), undefined, key);
  }
});

// Extends "[happy-2] a key never written is a miss even beside written keys".
test("[happy-2] a key never written is a miss in a store holding many other keys", () => {
  const clock = fakeClock();
  const store = recentReads<number>({ now: clock.now });
  for (let i = 0; i < 50; i++) store.set(`k${i}`, i);
  assert.equal(store.get("k50"), undefined);
  assert.equal(store.get("k"), undefined);
  assert.equal(store.get("k00"), undefined);
});

// Extends "[boundary-1] freshness is measured from the write and excludes ttlMs itself".
test("[boundary-1] freshness uses the configured ttlMs and the write time, not one minute or the store's creation", () => {
  const examples: Array<[number, string | undefined]> = [
    [3000000, "v"],
    [3004999, "v"],
    [3005000, undefined],
    [3005001, undefined],
    [3060000, undefined],
  ];
  for (const [t, result] of examples) {
    const clock = fakeClock();
    const store = recentReads<string>({ now: clock.now, ttlMs: 5000 });
    clock.t = 3000000;
    store.set("k", "v");
    clock.t = t;
    assert.equal(store.get("k"), result, `at t = ${t}`);
  }
});

test("[boundary-1] each key expires exactly ttlMs after its own write", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 60000 });
  store.set("a", "A");
  clock.t = 1010000;
  store.set("b", "B");
  clock.t = 1020000;
  store.set("c", "C");
  clock.t = 1060000;
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("b"), "B");
  assert.equal(store.get("c"), "C");
  clock.t = 1069999;
  assert.equal(store.get("b"), "B");
  clock.t = 1070000;
  assert.equal(store.get("b"), undefined);
  assert.equal(store.get("c"), "C");
  clock.t = 1079999;
  assert.equal(store.get("c"), "C");
  clock.t = 1080000;
  assert.equal(store.get("c"), undefined);
});

// Extends "[boundary-2] a clock that moves backwards keeps the entry fresh".
test("[boundary-2] a backwards clock keeps an entry fresh under a short ttl too", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 10 });
  store.set("k", "v");
  clock.t = 1;
  assert.equal(store.get("k"), "v");
  clock.t = 1000009;
  assert.equal(store.get("k"), "v");
  clock.t = 1000010;
  assert.equal(store.get("k"), undefined);
});

test("[boundary-2] a key rewritten after the clock moved back is timed from the earlier clock reading", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 60000 });
  store.set("k", "old");
  clock.t = 900000;
  store.set("k", "new");
  assert.equal(store.get("k"), "new");
  clock.t = 959999;
  assert.equal(store.get("k"), "new");
  clock.t = 960000;
  assert.equal(store.get("k"), undefined);
});

// Extends "[boundary-3] falsy values are stored and returned, not treated as misses".
test("[boundary-3] falsy values stay readable until the last fresh millisecond and then expire", () => {
  const empty: unknown[] = [];
  const values: unknown[] = [null, 0, "", false, empty, 0n];
  const clock = fakeClock();
  const store = recentReads<unknown>({ now: clock.now, ttlMs: 60000 });
  values.forEach((value, i) => store.set(`k${i}`, value));
  clock.t = 1059999;
  values.forEach((value, i) => assert.equal(store.get(`k${i}`), value, `k${i}`));
  clock.t = 1060000;
  values.forEach((_, i) => assert.equal(store.get(`k${i}`), undefined, `k${i}`));
});

test("[boundary-3] a falsy value replaces a truthy one and a truthy one replaces a falsy one", () => {
  const clock = fakeClock();
  const store = recentReads<unknown>({ now: clock.now });
  store.set("k", "v");
  store.set("k", null);
  assert.equal(store.get("k"), null);
  store.set("k", 0);
  assert.equal(store.get("k"), 0);
  store.set("k", false);
  assert.equal(store.get("k"), false);
  store.set("k", "again");
  assert.equal(store.get("k"), "again");
});

test("[boundary-3] a stored falsy value counts as an entry for eviction", () => {
  const clock = fakeClock();
  const store = recentReads<unknown>({ now: clock.now, max: 2 });
  store.set("a", null);
  store.set("b", 0);
  assert.equal(store.get("a"), null);
  assert.equal(store.get("b"), 0);
  store.set("c", false);
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("b"), 0);
  assert.equal(store.get("c"), false);
});

// Extends "[boundary-4] keys match exactly, are case-sensitive, and the empty string is a key".
test("[boundary-4] keys named like built-in object properties are stored and returned like any other", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now });
  const keys = ["__proto__", "constructor", "toString", "hasOwnProperty"];
  for (const key of keys) store.set(key, `value of ${key}`);
  for (const key of keys) assert.equal(store.get(key), `value of ${key}`, key);
  assert.equal(store.get("__PROTO__"), undefined);
});

test("[boundary-4] a __proto__ key is the oldest write like any other key and expires like any other", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 60000, max: 2 });
  store.set("__proto__", "P");
  store.set("a", "A");
  assert.equal(store.get("__proto__"), "P");
  store.set("b", "B");
  assert.equal(store.get("__proto__"), undefined);
  assert.equal(store.get("a"), "A");
  assert.equal(store.get("b"), "B");
  store.set("__proto__", "P2");
  assert.equal(store.get("a"), undefined);
  clock.t = 1059999;
  assert.equal(store.get("__proto__"), "P2");
  clock.t = 1060000;
  assert.equal(store.get("__proto__"), undefined);
});

test("[boundary-4] numeric-looking, newline and whitespace keys are distinct", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now });
  store.set("1", "one");
  store.set("\n", "newline");
  store.set("\r\n", "crlf");
  store.set(" ", "space");
  assert.equal(store.get("1"), "one");
  assert.equal(store.get("01"), undefined);
  assert.equal(store.get("1.0"), undefined);
  assert.equal(store.get("\n"), "newline");
  assert.equal(store.get("\r\n"), "crlf");
  assert.equal(store.get("\r"), undefined);
  assert.equal(store.get(" "), "space");
  assert.equal(store.get("  "), undefined);
  assert.equal(store.get(""), undefined);
});

test("[boundary-4] the empty-string key expires and can be rewritten like any other", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 1000 });
  store.set("", "first");
  clock.t = 1000999;
  assert.equal(store.get(""), "first");
  clock.t = 1001000;
  assert.equal(store.get(""), undefined);
  store.set("", "second");
  assert.equal(store.get(""), "second");
});

// Extends "[boundary-5] reading an entry does not refresh its expiry".
test("[boundary-5] reads under a short ttl at every millisecond do not refresh the expiry", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 20 });
  store.set("k", "v");
  for (let t = 1000000; t < 1000020; t++) {
    clock.t = t;
    assert.equal(store.get("k"), "v", `at t = ${t}`);
  }
  clock.t = 1000020;
  assert.equal(store.get("k"), undefined);
});

test("[boundary-5] reading one key does not refresh another key's expiry", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 60000 });
  store.set("a", "A");
  store.set("b", "B");
  clock.t = 1059999;
  assert.equal(store.get("a"), "A");
  clock.t = 1060000;
  assert.equal(store.get("b"), undefined);
  assert.equal(store.get("a"), undefined);
});

// Extends "[happy-3] writing a key again replaces its value and restarts its ttl".
test("[happy-3] several rewrites each restart the ttl from their own write", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 1000 });
  store.set("k", "v0");
  for (let i = 1; i <= 5; i++) {
    clock.t = 1000000 + i * 900;
    assert.equal(store.get("k"), `v${i - 1}`);
    store.set("k", `v${i}`);
  }
  clock.t = 1004500 + 999;
  assert.equal(store.get("k"), "v5");
  clock.t = 1004500 + 1000;
  assert.equal(store.get("k"), undefined);
});

test("[happy-3] rewriting one key leaves another key's value and expiry alone", () => {
  const clock = fakeClock();
  const store = recentReads<unknown>({ now: clock.now, ttlMs: 60000 });
  const other = { summary: "other" };
  store.set("k", "old");
  store.set("other", other);
  clock.t = 1030000;
  const replacement = { summary: "new" };
  store.set("k", replacement);
  assert.equal(store.get("k"), replacement);
  assert.equal(store.get("other"), other);
  clock.t = 1060000;
  assert.equal(store.get("other"), undefined);
  assert.equal(store.get("k"), replacement);
  clock.t = 1090000;
  assert.equal(store.get("k"), undefined);
});

// Extends "[happy-4] an expired key can be written again and is fresh".
test("[happy-4] a key expired long ago under a short ttl is fresh again for a full ttl after rewrite", () => {
  const clock = fakeClock();
  const store = recentReads<{ id: string }>({ now: clock.now, ttlMs: 300 });
  store.set("k", { id: "first" });
  clock.t = 5000000;
  assert.equal(store.get("k"), undefined);
  const second = { id: "second" };
  store.set("k", second);
  assert.equal(store.get("k"), second);
  clock.t = 5000299;
  assert.equal(store.get("k"), second);
  clock.t = 5000300;
  assert.equal(store.get("k"), undefined);
});

test("[happy-4] a key written again after expiry without being read first is fresh", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 60000 });
  store.set("k", "v1");
  clock.t = 1060000;
  store.set("k", "v2");
  assert.equal(store.get("k"), "v2");
  clock.t = 1119999;
  assert.equal(store.get("k"), "v2");
});

// Extends "[happy-7] a field list is kept for an hour".
test("[happy-7] a field list written later is kept for an hour from its write and is the same array", () => {
  const clock = fakeClock();
  const fields = recentReads<string[]>({ now: clock.now, ttlMs: 3600000 });
  clock.t = 9000000;
  const list = ["summary", "priority", "labels"];
  fields.set("org_9\njcn_9", list);
  clock.t = 9000000 + 60000;
  assert.equal(fields.get("org_9\njcn_9"), list);
  clock.t = 12599999;
  assert.equal(fields.get("org_9\njcn_9"), list);
  clock.t = 12600000;
  assert.equal(fields.get("org_9\njcn_9"), undefined);
});

// Extends "[boundary-13] a ttlMs of Infinity never expires".
test("[boundary-13] a ttlMs of Infinity keeps every key fresh, from a write at time zero to the largest number", () => {
  const clock = fakeClock();
  clock.t = 0;
  const store = recentReads<string>({ now: clock.now, ttlMs: Infinity });
  store.set("a", "A");
  clock.t = 5;
  store.set("b", "B");
  clock.t = Number.MAX_VALUE;
  assert.equal(store.get("a"), "A");
  assert.equal(store.get("b"), "B");
});

// Extends "[boundary-14] a fractional ttlMs keeps the exclusive boundary".
test("[boundary-14] a ttlMs of 2.5 is fresh two whole milliseconds later and gone at two and a half", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 2.5 });
  store.set("k", "v");
  clock.t = 1000002;
  assert.equal(store.get("k"), "v");
  clock.t = 1000002.25;
  assert.equal(store.get("k"), "v");
  clock.t = 1000002.5;
  assert.equal(store.get("k"), undefined);
  clock.t = 1000003;
  assert.equal(store.get("k"), undefined);
});

test("[boundary-14] a fractional ttlMs measured from a fractional write time", () => {
  const clock = fakeClock();
  clock.t = 1000000.25;
  const store = recentReads<string>({ now: clock.now, ttlMs: 1.5 });
  store.set("k", "v");
  clock.t = 1000001.5;
  assert.equal(store.get("k"), "v");
  clock.t = 1000001.75;
  assert.equal(store.get("k"), undefined);
});

// Extends "[unhappy-2] a ttlMs of 0 makes every read a miss".
test("[unhappy-2] a ttlMs of 0 misses every key, after rewrites and at later times", () => {
  const clock = fakeClock();
  const store = recentReads<unknown>({ now: clock.now, ttlMs: 0 });
  store.set("a", "A");
  store.set("b", 0);
  store.set("a", "A2");
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("b"), undefined);
  clock.t = 1000001;
  assert.equal(store.get("a"), undefined);
  store.set("c", { id: "c" });
  assert.equal(store.get("c"), undefined);
});

// Extends "[concurrency-1] two callers that both miss both write, and the later write is kept".
test("[concurrency-1] three callers that all miss all write, and the last write and its ttl are kept", () => {
  const clock = fakeClock();
  const store = recentReads<{ from: string }>({ now: clock.now, ttlMs: 60000 });
  for (let i = 0; i < 3; i++) assert.equal(store.get("k"), undefined);
  clock.t = 1000050;
  store.set("k", { from: "C" });
  clock.t = 1000300;
  store.set("k", { from: "A" });
  clock.t = 1000900;
  const fromB = { from: "B" };
  store.set("k", fromB);
  assert.equal(store.get("k"), fromB);
  clock.t = 1060899;
  assert.equal(store.get("k"), fromB);
  clock.t = 1060900;
  assert.equal(store.get("k"), undefined);
});

test("[concurrency-1] overlapping callers on the same key in a full store keep the last write and drop nothing else", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 60000, max: 2 });
  store.set("other", "O");
  assert.equal(store.get("k"), undefined);
  assert.equal(store.get("k"), undefined);
  clock.t = 1000100;
  store.set("k", "from B");
  clock.t = 1000200;
  store.set("k", "from A");
  assert.equal(store.get("k"), "from A");
  assert.equal(store.get("other"), "O");
});
