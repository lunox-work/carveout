import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson } from "../../src/analysis.js";

/**
 * The canonical JSON used as cache-key input, on values the public suite does
 * not use: larger and deeper structures, keys that integer-key enumeration,
 * code-point order or a copy into a fresh object would put elsewhere, and
 * objects JSON.stringify would write differently.
 */

// Ordered by UTF-16 code unit, as the default Array.prototype.sort orders them.
const ORDERED_KEYS = [
  "",
  "-1",
  "01",
  "1",
  "1.5",
  "10",
  "2",
  "4294967295",
  "9",
  "B",
  "a",
  "b",
  "\ud800",
  "😀",
  "\udc00",
  "",
  "￿",
];

function trickyObject(): Record<string, number> {
  // Inserted in an order unrelated to the expected one.
  const insertion = [8, 3, 16, 0, 12, 5, 1, 14, 9, 6, 11, 2, 15, 4, 13, 7, 10];
  const value: Record<string, number> = {};
  for (const index of insertion) {
    value[ORDERED_KEYS[index] as string] = index;
  }
  return value;
}

const TRICKY_JSON = `{${ORDERED_KEYS.map((key, index) => `${JSON.stringify(key)}:${index}`).join(",")}}`;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [items.slice()];
  }
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      result.push([item, ...tail]);
    }
  });
  return result;
}

// Extends "[happy-6] values are written compactly": a long array and a wide
// object, compared with JSON.stringify where the input is already in order.
test("[happy-6] a long array and a wide nested structure are written compactly", () => {
  const long = Array.from({ length: 1000 }, (_, index) => (index * 7919) % 1001);
  assert.equal(canonicalJson(long), JSON.stringify(long));
  const records = Array.from({ length: 50 }, (_, index) => ({
    active: index % 2 === 0,
    id: index,
    name: `item ${index}`,
    tags: ["x", null, index / 4],
  }));
  const value = { count: 50, records };
  assert.equal(canonicalJson(value), JSON.stringify(value));
  assert.equal(/\s/.test(canonicalJson(value).replace(/"[^"]*"/g, "")), false);
});

// Extends "[happy-6] empty containers nested at depth are written with no
// whitespace": a hundred levels deep, alternating objects and arrays.
test("[happy-6] a structure a hundred levels deep is written compactly", () => {
  let value: unknown = 0;
  let expected = "0";
  for (let depth = 0; depth < 100; depth += 1) {
    if (depth % 2 === 0) {
      value = { z: value, a: depth };
      expected = `{"a":${depth},"z":${expected}}`;
    } else {
      value = [value, depth];
      expected = `[${expected},${depth}]`;
    }
  }
  assert.equal(canonicalJson(value), expected);
});

// Extends "[happy-6] values are written compactly": own keys named after
// Object.prototype members, which a copy into a fresh object would lose.
test("[happy-6] own keys named __proto__, constructor and hasOwnProperty are written like any other", () => {
  const parsed = JSON.parse('{"z":1,"__proto__":{"y":2,"x":3},"constructor":4,"hasOwnProperty":5}') as unknown;
  assert.equal(
    canonicalJson(parsed),
    '{"__proto__":{"x":3,"y":2},"constructor":4,"hasOwnProperty":5,"z":1}',
  );
});

// Extends "[happy-7] key order in the input does not change the output":
// every insertion order of five keys that sort differently by code unit.
test("[happy-7] all 120 insertion orders of five keys give the same output", () => {
  const entries: [string, unknown][] = [
    ["é", 1],
    ["10", [2]],
    ["9", { y: 1, x: 2 }],
    ["B", null],
    ["a", "s"],
  ];
  const expected = '{"10":[2],"9":{"x":2,"y":1},"B":null,"a":"s","é":1}';
  const orders = permutations(entries);
  assert.equal(orders.length, 120);
  for (const order of orders) {
    assert.equal(canonicalJson(Object.fromEntries(order)), expected);
  }
});

// Extends "[happy-7] key order does not matter at any depth, including inside
// arrays": a key deleted and added back moves to the end of insertion order.
test("[happy-7] a key deleted and added back, at any depth, does not move in the output", () => {
  const a: Record<string, unknown> = { a: 1, b: { c: 1, d: 2 }, e: [{ f: 1, g: 2 }] };
  const b: Record<string, unknown> = { a: 1, b: { c: 1, d: 2 }, e: [{ f: 1, g: 2 }] };
  delete b["a"];
  b["a"] = 1;
  const inner = b["b"] as Record<string, unknown>;
  delete inner["c"];
  inner["c"] = 1;
  const element = (b["e"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  delete element["f"];
  element["f"] = 1;
  const expected = '{"a":1,"b":{"c":1,"d":2},"e":[{"f":1,"g":2}]}';
  assert.equal(canonicalJson(a), expected);
  assert.equal(canonicalJson(b), expected);
});

// Extends "[happy-8] the input is not modified": arrays of strings and of
// objects, holes, nested objects at every level, and a second call.
test("[happy-8] a larger input keeps its key order, array order and holes after two calls", () => {
  const list = ["b", "a", "c"];
  const sparse = [3, , 1];
  const input = {
    z: list,
    y: [{ q: 1, p: 2 }, { o: { n: 1, m: 2 } }],
    x: sparse,
    w: { "9": 1, "10": 2, b: 3, a: 4 },
  };
  const before = JSON.stringify(input);
  const first = canonicalJson(input);
  const second = canonicalJson(input);
  assert.equal(first, second);
  assert.equal(first, '{"w":{"10":2,"9":1,"a":4,"b":3},"x":[3,,1],"y":[{"p":2,"q":1},{"o":{"m":2,"n":1}}],"z":["b","a","c"]}');
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(Object.keys(input), ["z", "y", "x", "w"]);
  assert.deepEqual(list, ["b", "a", "c"]);
  assert.equal(sparse.length, 3);
  assert.equal(1 in sparse, false);
  assert.deepEqual(Object.keys(input.w), ["9", "10", "b", "a"]);
  assert.deepEqual(Object.keys(input.y[0] as object), ["q", "p"]);
});

// Extends "[happy-8] the input is not modified": no keys are added to the
// input or its parts, not even non-enumerable or symbol ones.
test("[happy-8] the input gains no own properties of any kind", () => {
  const inner = { d: 1, c: 2 };
  const list = [inner, 2, 1];
  const input = { b: list, a: inner };
  canonicalJson(input);
  assert.deepEqual(Reflect.ownKeys(input), ["b", "a"]);
  assert.deepEqual(Reflect.ownKeys(inner), ["d", "c"]);
  assert.deepEqual(Reflect.ownKeys(list), ["0", "1", "2", "length"]);
  assert.equal(Object.isExtensible(input), true);
  assert.equal(Object.isFrozen(inner), false);
});

// Extends "[boundary-4] keys sort by UTF-16 code unit, not numerically or by
// code point": more keys, including lone surrogates and keys above the
// surrogate range, which code-point order puts before "😀".
test("[boundary-4] seventeen keys sort by code unit, including lone surrogates and private-use keys", () => {
  assert.equal(canonicalJson(trickyObject()), TRICKY_JSON);
});

// Extends "[boundary-4] keys sort by UTF-16 code unit": the same order at
// depth, inside objects inside arrays inside objects.
test("[boundary-4] keys sort by code unit at every depth", () => {
  const value = { z: [trickyObject(), { w: trickyObject() }], a: trickyObject() };
  assert.equal(
    canonicalJson(value),
    `{"a":${TRICKY_JSON},"z":[${TRICKY_JSON},{"w":${TRICKY_JSON}}]}`,
  );
});

// Extends "[boundary-4] the empty key sorts first and a prefix sorts before
// its extensions": two hundred keys, where numeric order and code-unit order
// disagree on most of them.
test("[boundary-4] two hundred keys inserted in reverse sort by code unit", () => {
  const names = Array.from({ length: 200 }, (_, index) => `k${index}`);
  const value: Record<string, number> = {};
  for (const name of [...names].reverse()) {
    value[name] = Number(name.slice(1));
  }
  const expected = `{${[...names].sort().map((name) => `"${name}":${name.slice(1)}`).join(",")}}`;
  assert.equal(canonicalJson(value), expected);
  assert.equal(canonicalJson(value).startsWith('{"k0":0,"k1":1,"k10":10,"k100":100,"k101":101'), true);
});

// Extends "[boundary-5] numbers and strings follow JSON.stringify": the
// special numbers inside arrays and objects, not only at the top level.
test("[boundary-5] special numbers inside arrays and objects follow JSON.stringify", () => {
  const numbers = [
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e21,
    -1e-7,
    2 ** 53,
    Number.EPSILON,
    123456789012345680000,
    0.000001,
    1e300 * 10,
  ];
  assert.equal(canonicalJson(numbers), JSON.stringify(numbers));
  assert.equal(canonicalJson([-0]), "[0]");
  assert.equal(canonicalJson({ b: -0, a: Number.NaN }), '{"a":null,"b":0}');
  assert.equal(canonicalJson({ big: 1e21, small: 1e-7 }), '{"big":1e+21,"small":1e-7}');
});

// Extends "[boundary-5] other numbers and strings match JSON.stringify
// exactly": every control character, the line and paragraph separators, and
// surrogates paired, reversed and alone.
test("[boundary-5] every control character and every surrogate arrangement follows JSON.stringify", () => {
  const strings: string[] = [];
  for (let code = 0; code < 0x20; code += 1) {
    strings.push(String.fromCharCode(code), `a${String.fromCharCode(code)}b`);
  }
  strings.push(
    " ",
    " ",
    "\u007f",
    "\u0080",
    "日本語",
    "😀\ud800",
    "\ude00\ud83d",
    "\udbff",
    "\udfff",
    "x\ud83d",
    "\\u0041",
    "'",
  );
  for (const value of strings) {
    assert.equal(canonicalJson(value), JSON.stringify(value), JSON.stringify(value));
  }
  assert.equal(canonicalJson(strings), JSON.stringify(strings));
  assert.equal(canonicalJson("\udfff"), '"\\udfff"');
  assert.equal(canonicalJson(" "), '" "');
});

// Extends "[boundary-5] numbers and strings follow JSON.stringify": object
// keys are strings too, and are escaped the same way.
test("[boundary-5] object keys that need escaping are written as JSON.stringify writes them", () => {
  const value = { "new\nline": 4, "back\\slash": 3, 'a"b': 2, "\u0000": 1, "\ud800": 5 };
  assert.equal(
    canonicalJson(value),
    String.raw`{"\u0000":1,"a\"b":2,"back\\slash":3,"new\nline":4,"\ud800":5}`,
  );
});

// Extends "[boundary-6] an object with no prototype is accepted": nested in
// another, with keys an implementation calling value.hasOwnProperty or
// copying into a fresh object would mishandle.
test("[boundary-6] objects with no prototype nest and keep keys named after Object.prototype members", () => {
  const inner = Object.create(null) as Record<string, unknown>;
  inner["hasOwnProperty"] = 1;
  inner["__proto__"] = 2;
  inner["10"] = 3;
  inner["9"] = 4;
  const outer = Object.create(null) as Record<string, unknown>;
  outer["toString"] = inner;
  outer["a"] = [inner];
  const expectedInner = '{"10":3,"9":4,"__proto__":2,"hasOwnProperty":1}';
  assert.equal(canonicalJson(outer), `{"a":[${expectedInner}],"toString":${expectedInner}}`);
});

// Extends "[boundary-7] any other object is written as its own enumerable
// string keys": wrapper objects, collections, regular expressions and typed
// arrays, which JSON.stringify writes differently or which are not arrays.
test("[boundary-7] wrappers, collections, regular expressions and typed arrays are written as their own keys", () => {
  assert.equal(canonicalJson(new Number(5)), "{}");
  assert.equal(canonicalJson(new Boolean(false)), "{}");
  assert.equal(canonicalJson(new String("ab")), '{"0":"a","1":"b"}');
  assert.equal(canonicalJson(new Set([1, 2])), "{}");
  assert.equal(canonicalJson(/x/g), "{}");
  assert.equal(canonicalJson(new Uint8Array([7, 8])), '{"0":7,"1":8}');
  assert.equal(
    canonicalJson([new Number(1), { s: new String("z") }]),
    '[{},{"s":{"0":"z"}}]',
  );
});

// Extends "[boundary-7] inherited and non-enumerable properties are left
// out": a toJSON method on the prototype is inherited and is never called,
// and a Date's own properties are written.
test("[boundary-7] an inherited toJSON is not called and a Date is written as its own keys", () => {
  class Report {
    z = 1;
    m = "m";
    a = [2];
    toJSON(): string {
      return "called";
    }
  }
  const date = Object.assign(new Date(86_400_000), { label: "day", count: 1 });
  assert.equal(canonicalJson(new Report()), '{"a":[2],"m":"m","z":1}');
  assert.equal(canonicalJson(date), '{"count":1,"label":"day"}');
  assert.equal(canonicalJson({ when: [new Date(0), new Date(1)] }), '{"when":[{},{}]}');
});

// Extends "[boundary-8] an array hole is written as nothing between the
// commas": runs of holes, a trailing hole, an array made of holes and holes
// inside nested structures.
test("[boundary-8] runs of holes, trailing holes and nested holes are written as nothing", () => {
  assert.equal(canonicalJson([1, , , 2]), "[1,,,2]");
  assert.equal(canonicalJson([, , 1]), "[,,1]");
  assert.equal(canonicalJson([1, ,]), "[1,]");
  assert.equal(canonicalJson(new Array(3)), "[,,]");
  const late: number[] = [];
  late[4] = 1;
  assert.equal(canonicalJson(late), "[,,,,1]");
  assert.equal(canonicalJson({ b: [, "x"], a: [[1, , 2]] }), '{"a":[[1,,2]],"b":[,"x"]}');
});

// Extends "[boundary-9] ignored keys are ignored even when their values are
// not JSON": nested symbol keys, non-index array keys that look numeric, and
// ignored values that are bigints or cycles.
test("[boundary-9] symbol keys and non-index array keys are ignored at every depth, whatever they hold", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const inner = { b: 2, [Symbol("big")]: 10n, [Symbol("loop")]: cyclic, a: 1 };
  const list = Object.assign([inner, 3], {
    "-1": 1,
    "1.5": 2,
    "01": 3,
    "4294967295": 4,
    big: 5n,
    loop: cyclic,
  });
  assert.equal(canonicalJson({ list, [Symbol("top")]: list }), '{"list":[{"a":1,"b":2},3]}');
  assert.equal(list.length, 2);
});

// Extends "[boundary-10] an array shared by sibling elements is written at
// each place": one object at many depths and fifty times in one array.
test("[boundary-10] a value shared at many depths and many times is written at every place", () => {
  const shared = { k: [1] };
  const value = { d: [[shared]], c: { b: { a: shared } }, e: shared.k, f: shared };
  assert.equal(
    canonicalJson(value),
    '{"c":{"b":{"a":{"k":[1]}}},"d":[[{"k":[1]}]],"e":[1],"f":{"k":[1]}}',
  );
  const many = Array.from({ length: 50 }, () => shared);
  assert.equal(canonicalJson(many), `[${Array.from({ length: 50 }, () => '{"k":[1]}').join(",")}]`);
});

// Extends "[boundary-10] a value shared by two branches but not cyclic is
// written at both places": the same input written on a later call, which a
// record of visited values kept between calls would refuse.
test("[boundary-10] the same shared input is written the same on repeated calls", () => {
  const shared = Object.create(null) as Record<string, number>;
  shared["k"] = 1;
  const value = { x: shared, y: [shared] };
  const expected = '{"x":{"k":1},"y":[{"k":1}]}';
  for (let call = 0; call < 3; call += 1) {
    assert.equal(canonicalJson(value), expected);
    assert.equal(canonicalJson(shared), '{"k":1}');
  }
});
