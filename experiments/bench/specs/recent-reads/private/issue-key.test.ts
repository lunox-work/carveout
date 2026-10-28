import assert from "node:assert/strict";
import { test } from "node:test";
import { issueKey, recentReads } from "../../src/jira/recent.js";

// The spec's Background: a clock "now" returning the number held in "t",
// starting at 1000000.
function fakeClock() {
  const clock = { t: 1000000, now: () => clock.t };
  return clock;
}

// Extends "[happy-9] issueKey builds the key from organization, connection and issue".
test("[happy-9] issueKey joins other organization, connection and issue ids with newlines", () => {
  const examples: Array<[string, string, string]> = [
    ["org_42", "jcn_7", "99999"],
    ["org_a", "jcn_b", "ABC-123"],
    ["o", "c", "i"],
    ["org_1", "jcn_1", ""],
    ["", "jcn_1", "10001"],
    ["org_ü", "jcn_日本", "PROJ-😀"],
    ["org:1", "jcn/1", "a,b|c"],
    ["org\t1", "jcn\r1", "10001 "],
  ];
  for (const [organizationId, connectionId, issueId] of examples) {
    assert.equal(
      issueKey(organizationId, connectionId, issueId),
      `${organizationId}\n${connectionId}\n${issueId}`,
    );
  }
});

test("[happy-9] issueKey keeps long parts whole", () => {
  const organizationId = "o".repeat(500);
  const connectionId = "c".repeat(1000);
  const issueId = "PROJ-" + "9".repeat(2000);
  const key = issueKey(organizationId, connectionId, issueId);
  assert.equal(key, [organizationId, connectionId, issueId].join("\n"));
  assert.equal(key.length, 500 + 1000 + 2005 + 2);
});

test("[happy-9] issueKey gives the same key for the same parts every time", () => {
  assert.equal(issueKey("org_1", "jcn_1", "10001"), issueKey("org_1", "jcn_1", "10001"));
  assert.equal(issueKey("org_3", "jcn_3", "X-1"), "org_3\njcn_3\nX-1");
  assert.equal(issueKey("org_3", "jcn_3", "X-1"), "org_3\njcn_3\nX-1");
});

// Extends "[boundary-15] the same issue under different organizations or connections is a different key".
test("[boundary-15] every combination of two organizations, connections and issues is its own entry", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now });
  const orgs = ["org_1", "org_2"];
  const connections = ["jcn_1", "jcn_2"];
  const issues = ["10001", "PROJ-7"];
  for (const o of orgs) for (const c of connections) for (const i of issues) {
    store.set(issueKey(o, c, i), `${o} ${c} ${i}`);
  }
  for (const o of orgs) for (const c of connections) for (const i of issues) {
    assert.equal(store.get(issueKey(o, c, i)), `${o} ${c} ${i}`);
  }
  assert.equal(store.get(issueKey("org_3", "jcn_1", "10001")), undefined);
});

test("[boundary-15] an issue key is distinct from a field-list key and from keys with shifted parts", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now });
  store.set(issueKey("org_1", "jcn_1", "10001"), "issue");
  assert.equal(store.get("org_1\njcn_1"), undefined);
  assert.equal(store.get(issueKey("org_1", "jcn_11", "0001")), undefined);
  assert.equal(store.get(issueKey("org_1j", "cn_1", "10001")), undefined);
  assert.equal(store.get(issueKey("org_1", "jcn_1", "10001 ")), undefined);
  assert.equal(store.get(issueKey("ORG_1", "jcn_1", "10001")), undefined);
  assert.equal(store.get(issueKey("org_1", "jcn_1", "10001")), "issue");
});

test("[boundary-15] the same issue under two organizations expires and evicts as two entries", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 60000, max: 2 });
  store.set(issueKey("org_1", "jcn_1", "10001"), "org_1");
  clock.t = 1030000;
  store.set(issueKey("org_2", "jcn_1", "10001"), "org_2");
  clock.t = 1060000;
  assert.equal(store.get(issueKey("org_1", "jcn_1", "10001")), undefined);
  assert.equal(store.get(issueKey("org_2", "jcn_1", "10001")), "org_2");
});

// Extends "[unhappy-4] parts containing a newline are not rejected and can collide".
test("[unhappy-4] newline-bearing parts are joined as given and collide wherever the joined text matches", () => {
  const cases: Array<[[string, string, string], [string, string, string], string]> = [
    [["a\n", "b", "c"], ["a", "\nb", "c"], "a\n\nb\nc"],
    [["", "", "\n"], ["\n", "", ""], "\n\n\n"],
    [["x", "y\nz\nw", "v"], ["x\ny", "z\nw", "v"], "x\ny\nz\nw\nv"],
    [["org\n1", "jcn", "1\n2"], ["org", "1\njcn\n1", "2"], "org\n1\njcn\n1\n2"],
  ];
  for (const [left, right, key] of cases) {
    let leftKey = "";
    assert.doesNotThrow(() => {
      leftKey = issueKey(...left);
    });
    assert.equal(leftKey, key);
    assert.equal(issueKey(...right), key);
  }
});

test("[unhappy-4] parts that are only newlines are accepted", () => {
  let key = "";
  assert.doesNotThrow(() => {
    key = issueKey("\n", "\n\n", "\n");
  });
  assert.equal(key, "\n".repeat(6));
  assert.equal(key.split("\n").length, 7);
});

test("[unhappy-4] a colliding key written by one caller is overwritten by the other and keeps one ttl", () => {
  const clock = fakeClock();
  const store = recentReads<string>({ now: clock.now, ttlMs: 60000, max: 1 });
  store.set(issueKey("a\nb", "c", "d"), "first");
  clock.t = 1030000;
  store.set(issueKey("a", "b\nc", "d"), "second");
  assert.equal(store.get(issueKey("a\nb", "c", "d")), "second");
  clock.t = 1089999;
  assert.equal(store.get("a\nb\nc\nd"), "second");
  clock.t = 1090000;
  assert.equal(store.get("a\nb\nc\nd"), undefined);
});
