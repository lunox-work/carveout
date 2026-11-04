import assert from "node:assert/strict";
import { test } from "node:test";

import * as root from "../../src/index.js";
import {
  generateId,
  ID_PREFIXES,
  type IdPrefix,
  newTodoRow,
  rowToTodo,
} from "../../src/mapping.js";

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_V4_ONLY = new RegExp(`^${UUID_V4}$`);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function idPattern(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}_${UUID_V4}$`);
}

/** Everything after the first "_". */
function suffixOf(id: string): string {
  return id.slice(id.indexOf("_") + 1);
}

const EXPECTED_PREFIXES = ["todo", "jrc", "jrb", "jri", "brn", "bpr"];

// `src/index.ts` is not part of the fixed interface, so its new export is read
// untyped.
const rootExports = root as unknown as Record<string, unknown>;

// ---- ID_PREFIXES ------------------------------------------------------------

// Extends "[happy-1] ID_PREFIXES holds exactly the six prefixes in declaration order":
// index by index, and no extra own properties beyond the six entries.
test("[happy-1] hidden: each position holds its prefix and the array has no extra own keys", () => {
  EXPECTED_PREFIXES.forEach((prefix, i) => {
    assert.equal(ID_PREFIXES[i], prefix, `index ${i}`);
    assert.equal(ID_PREFIXES.indexOf(prefix as IdPrefix), i);
  });
  assert.deepEqual(Object.keys(ID_PREFIXES), ["0", "1", "2", "3", "4", "5"]);
  assert.equal(ID_PREFIXES.length, 6);
});

// Extends "[boundary-1] every generated id splits at its first underscore back into its prefix":
// many ids per prefix, and the part after the first "_" contains no further "_".
test("[boundary-1] hidden: twenty ids per prefix split at the first underscore into prefix and a bare uuid", () => {
  for (const prefix of ID_PREFIXES) {
    assert.match(prefix, /^[a-z]+$/);
    for (let i = 0; i < 20; i += 1) {
      const id = generateId(prefix);
      const [head, ...rest] = id.split("_");
      assert.equal(head, prefix);
      assert.equal(rest.length, 1, id);
      assert.match(rest[0]!, UUID_V4_ONLY);
    }
  }
});

// Extends "[boundary-1] every prefix is lowercase letters only and none repeats":
// no prefix is a prefix of another, so splitting is unambiguous both ways.
test("[boundary-1] hidden: prefixes are pairwise distinct across all pairs", () => {
  for (let i = 0; i < ID_PREFIXES.length; i += 1) {
    for (let j = 0; j < ID_PREFIXES.length; j += 1) {
      if (i !== j) {
        assert.notEqual(ID_PREFIXES[i], ID_PREFIXES[j]);
      }
    }
  }
  assert.equal(generateId("jrb").startsWith("jrb_"), true);
  assert.equal(generateId("jrc").startsWith("jrc_"), true);
});

// Extends "[boundary-2] ID_PREFIXES is not frozen": also not sealed.
test("[boundary-2] hidden: ID_PREFIXES is neither frozen nor sealed", () => {
  assert.equal(Object.isFrozen(ID_PREFIXES), false);
  assert.equal(Object.isSealed(ID_PREFIXES), false);
  assert.equal(Object.isExtensible(ID_PREFIXES), true);
});

// Extends "[happy-2] the package root re-exports the same ID_PREFIXES object".
test("[happy-2] hidden: the root's ID_PREFIXES is the mapping list, with all six entries", () => {
  assert.equal(rootExports.ID_PREFIXES, ID_PREFIXES);
  assert.deepEqual(
    [...(rootExports.ID_PREFIXES as readonly string[])],
    EXPECTED_PREFIXES,
  );
});

// Extends "[happy-2] the package root's generateId is the same function as mapping's":
// every entry of the root's list, not only the fourth.
test("[happy-2] hidden: every prefix from the root's list yields its own id through the root's generateId", () => {
  const prefixes = rootExports.ID_PREFIXES as readonly IdPrefix[];
  assert.equal(Array.isArray(prefixes), true);
  for (const prefix of prefixes) {
    assert.match(root.generateId(prefix), idPattern(prefix));
  }
});

// ---- generateId with a listed prefix ----------------------------------------

// Extends "[happy-3] each listed prefix produces an id carrying that prefix":
// reverse order, many calls each, exact lengths.
test("[happy-3] hidden: fifty ids per prefix in reverse order carry their prefix and length", () => {
  const lengths: Record<string, number> = {
    todo: 41,
    jrc: 40,
    jrb: 40,
    jri: 40,
    brn: 40,
    bpr: 40,
  };
  for (const prefix of [...ID_PREFIXES].reverse()) {
    for (let i = 0; i < 50; i += 1) {
      const id = generateId(prefix);
      assert.match(id, idPattern(prefix));
      assert.equal(id.length, lengths[prefix]);
    }
  }
});

// Extends "[happy-3] the uuid part is exactly 36 lowercase characters for every prefix":
// version nibble and variant nibble across many ids.
test("[happy-3] hidden: the uuid part has version 4 and an RFC 4122 variant every time", () => {
  for (const prefix of ["bpr", "jrb", "brn", "jrc"] as const) {
    for (let i = 0; i < 200; i += 1) {
      const uuid = generateId(prefix).slice(prefix.length + 1);
      assert.equal(uuid.length, 36);
      assert.equal(uuid[14], "4", uuid);
      assert.match(uuid[19]!, /^[89ab]$/, uuid);
      assert.deepEqual(
        uuid.split("-").map((part) => part.length),
        [8, 4, 4, 4, 12],
      );
      assert.match(uuid, /^[0-9a-f-]+$/);
    }
  }
});

test("[happy-3] hidden: a non-default prefix is used verbatim, not replaced by todo", () => {
  for (const prefix of ["jrc", "jrb", "jri", "brn", "bpr"] as const) {
    const id = generateId(prefix);
    assert.equal(id.startsWith(`${prefix}_`), true, id);
    assert.equal(id.startsWith("todo_"), false, id);
  }
});

// Extends "[happy-4] generateId with no argument uses the todo prefix":
// the default does not stick to whatever prefix was used last.
test("[happy-4] hidden: generateId() is still todo-prefixed right after calls with other prefixes", () => {
  for (const prefix of ["bpr", "jrc", "brn"] as const) {
    const other = generateId(prefix);
    assert.match(other, idPattern(prefix));
    assert.match(generateId(), idPattern("todo"));
  }
});

// Extends "[boundary-3] generateId(undefined) falls back to the todo prefix":
// after another prefix, through apply and an empty spread.
test("[boundary-3] hidden: undefined falls back to todo even right after a non-default prefix", () => {
  const before = generateId("jri");
  assert.match(before, idPattern("jri"));
  assert.match(generateId(undefined), idPattern("todo"));
  assert.match(generateId(void 0), idPattern("todo"));
  assert.match(generateId.apply(null, [undefined]), idPattern("todo"));
  const none: IdPrefix[] = [];
  assert.match(generateId(...none), idPattern("todo"));
});

// ---- uniqueness ---------------------------------------------------------------

// Extends "[happy-5] 1000 calls to generateId(jri) are pairwise distinct and jri-prefixed":
// five times as many, with full pattern checks and distinct suffixes.
test("[happy-5] hidden: 5000 jri ids are pairwise distinct, well formed, and so are their suffixes", () => {
  const ids = Array.from({ length: 5000 }, () => generateId("jri"));
  assert.equal(new Set(ids).size, 5000);
  assert.equal(new Set(ids.map(suffixOf)).size, 5000);
  for (const id of ids) {
    assert.match(id, idPattern("jri"));
  }
});

// Extends "[boundary-4] 100 ids per listed prefix are pairwise distinct, and so are their suffixes":
// round-robin order instead of grouped, so a uuid reused across prefixes shows.
test("[boundary-4] hidden: ids generated round-robin across prefixes never share a uuid suffix", () => {
  const ids: string[] = [];
  for (let round = 0; round < 300; round += 1) {
    for (const prefix of ID_PREFIXES) {
      const id = generateId(prefix);
      assert.match(id, idPattern(prefix));
      ids.push(id);
    }
  }
  assert.equal(ids.length, 1800);
  assert.equal(new Set(ids).size, 1800);
  assert.equal(new Set(ids.map(suffixOf)).size, 1800);
});

test("[boundary-4] hidden: alternating two prefixes gives distinct suffixes in each pair", () => {
  for (let i = 0; i < 200; i += 1) {
    const a = generateId("jrc");
    const b = generateId("jrb");
    assert.match(a, idPattern("jrc"));
    assert.match(b, idPattern("jrb"));
    assert.notEqual(suffixOf(a), suffixOf(b));
  }
});

// ---- generateId with an unlisted value --------------------------------------

// Extends "[unhappy-1] a value cast past IdPrefix is stringified into the id without an error":
// other values, including falsy ones that `||` would replace and objects that
// the template literal stringifies.
test("[unhappy-1] hidden: other cast values are stringified as a template literal would", () => {
  const cases: Array<[unknown, string]> = [
    [0, "0_"],
    [false, "false_"],
    [true, "true_"],
    [-1, "-1_"],
    [3.5, "3.5_"],
    [Number.NaN, "NaN_"],
    [10n, "10_"],
    ["   ", "   _"],
    ["Todo", "Todo_"],
    ["JRI", "JRI_"],
    ["bpr ", "bpr _"],
    ["a_b", "a_b_"],
    ["_", "__"],
    ["ünï", "ünï_"],
    ["todo-1", "todo-1_"],
    [["a", "b"], "a,b_"],
    [{ toString: () => "obj" }, "obj_"],
    [{}, "[object Object]_"],
  ];
  for (const [input, start] of cases) {
    let id = "";
    assert.doesNotThrow(() => {
      id = generateId(input as IdPrefix);
    }, `${start}`);
    assert.equal(id.startsWith(start), true, `${start} -> ${id}`);
    assert.match(id.slice(start.length), UUID_V4_ONLY);
    assert.equal(id.length, start.length + 36);
  }
});

test("[unhappy-1] hidden: a long unlisted prefix is kept whole", () => {
  const prefix = "x".repeat(1000);
  const id = generateId(prefix as IdPrefix);
  assert.equal(id.length, 1000 + 1 + 36);
  assert.equal(id.startsWith(`${prefix}_`), true);
  assert.match(id.slice(1001), UUID_V4_ONLY);
});

test("[unhappy-1] hidden: unlisted values are neither lower-cased nor trimmed nor mapped to todo", () => {
  const upper = generateId("TODO" as IdPrefix);
  assert.equal(upper.startsWith("TODO_"), true);
  assert.equal(upper.startsWith("todo_"), false);
  const padded = generateId("  jri  " as IdPrefix);
  assert.equal(padded.startsWith("  jri  _"), true);
  const empty = generateId("" as IdPrefix);
  assert.equal(empty[0], "_");
  assert.match(empty.slice(1), UUID_V4_ONLY);
  assert.equal(empty.length, 37);
});

// Extends "[unhappy-1] null does not trigger the default prefix": null right
// after a default call, and repeated null ids are distinct.
test("[unhappy-1] hidden: null gives distinct null-prefixed ids, also right after a default call", () => {
  assert.match(generateId(), idPattern("todo"));
  const ids = Array.from({ length: 50 }, () =>
    generateId(null as unknown as IdPrefix),
  );
  for (const id of ids) {
    assert.match(id, idPattern("null"));
  }
  assert.equal(new Set(ids).size, 50);
});

// ---- concurrency ------------------------------------------------------------

// Extends "[concurrency-1] interleaved async tasks each receive distinct brn ids":
// tasks with different prefixes interleave, and each keeps its own prefix.
test("[concurrency-1] hidden: interleaved tasks with mixed prefixes each get their own prefix and distinct ids", async () => {
  const tasks = Array.from({ length: 120 }, (_, t) => {
    const prefix = ID_PREFIXES[t % ID_PREFIXES.length]!;
    return (async () => {
      const ids: Array<[IdPrefix, string]> = [];
      for (let i = 0; i < 25; i += 1) {
        await Promise.resolve();
        ids.push([prefix, generateId(prefix)]);
      }
      return ids;
    })();
  });
  const results = (await Promise.all(tasks)).flat();
  assert.equal(results.length, 3000);
  for (const [prefix, id] of results) {
    assert.match(id, idPattern(prefix));
  }
  const ids = results.map(([, id]) => id);
  assert.equal(new Set(ids).size, 3000);
  assert.equal(new Set(ids.map(suffixOf)).size, 3000);
});

test("[concurrency-1] hidden: 200 tasks of 20 brn ids with uneven yields are all distinct", async () => {
  const batches = await Promise.all(
    Array.from({ length: 200 }, async (_, t) => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        for (let y = 0; y < (t + i) % 3; y += 1) {
          await Promise.resolve();
        }
        ids.push(generateId("brn"));
      }
      return ids;
    }),
  );
  const ids = batches.flat();
  assert.equal(ids.length, 4000);
  assert.equal(new Set(ids).size, 4000);
  for (const id of ids) {
    assert.match(id, idPattern("brn"));
  }
});

// ---- newTodoRow and rowToTodo -----------------------------------------------

// Extends "[happy-6] newTodoRow defaults to a todo-prefixed id": other owner and
// title, after other prefixes were used, and many rows.
test("[happy-6] hidden: newTodoRow's default id stays todo after generateId is called with other prefixes", () => {
  for (const prefix of ["bpr", "jri", "brn"] as const) {
    assert.match(generateId(prefix), idPattern(prefix));
    const row = newTodoRow("user_42", "  walk the dog  ");
    assert.match(String(row.id), idPattern("todo"));
    assert.equal(row.userId, "user_42");
    assert.equal(row.title, "walk the dog");
    assert.equal(row.done, false);
  }
});

// Extends "[happy-7] newTodoRow uses a given id verbatim": other ids, including
// one made by generateId with another prefix.
test("[happy-7] hidden: newTodoRow keeps other given ids verbatim", () => {
  const generated = generateId("bpr");
  assert.match(generated, idPattern("bpr"));
  for (const id of ["bpr_custom", "todo_1", "x", "JRI_UPPER", generated]) {
    const row = newTodoRow("user_2", "read", id);
    assert.equal(row.id, id);
    assert.equal(row.userId, "user_2");
    assert.equal(row.title, "read");
    assert.equal(row.done, false);
  }
});

// Extends "[happy-8] rowToTodo maps a row to the domain todo": other values.
test("[happy-8] hidden: rowToTodo maps other rows, dropping userId", () => {
  const cases: Array<[string, string, boolean, string]> = [
    ["bpr_9", "ship it", true, "1970-01-01T00:00:00.000Z"],
    ["todo_x", "a title with  spaces", false, "2031-02-28T12:34:56.789Z"],
    [generateId("jrc"), "t", true, "2026-11-04T08:00:00.001Z"],
  ];
  for (const [id, title, done, iso] of cases) {
    assert.deepEqual(
      rowToTodo({ id, userId: "user_9", title, done, createdAt: new Date(iso) }),
      { id, title, done, createdAt: iso },
    );
  }
});
