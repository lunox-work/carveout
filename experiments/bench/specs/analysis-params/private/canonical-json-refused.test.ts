import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson } from "../../src/analysis.js";

/**
 * What canonicalJson refuses, in places and shapes the public suite does not
 * use: undefined, functions and symbols with the fixed message, bigints with a
 * TypeError and cycles with a RangeError.
 */

const NOT_JSON = "Cache parameters must be JSON values.";

function assertRefused(value: unknown): void {
  assert.throws(
    () => canonicalJson(value),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TypeError, false);
      assert.equal(error instanceof RangeError, false);
      assert.equal(error.message, NOT_JSON);
      return true;
    },
  );
}

// Extends "[unhappy-1] undefined, functions and symbols are refused":
// undefined wherever a key sorts, and wherever an element sits, including
// beside a hole, which is accepted.
test("[unhappy-1] undefined is refused as the first, last or only element and under any key", () => {
  assertRefused([undefined]);
  assertRefused([undefined, 1]);
  assertRefused([1, 2, undefined]);
  assertRefused([, undefined]);
  assertRefused({ a: 1, z: undefined });
  assertRefused({ m: undefined });
  assertRefused({ z: 1, a: undefined, b: 2 });
});

// Extends "[unhappy-1] undefined, functions and symbols are refused": every
// kind of function, not only arrows.
test("[unhappy-1] classes, async and generator functions, bound and built-in functions are refused", () => {
  class Job {}
  async function later(): Promise<void> {}
  function* steps(): Generator<number> {
    yield 1;
  }
  const values: unknown[] = [
    Job,
    later,
    steps,
    later.bind(null),
    Math.max,
    { job: Job },
    [1, Math.max],
    { method(): number { return 1; } },
  ];
  for (const value of values) {
    assertRefused(value);
  }
});

// Extends "[unhappy-1] undefined, functions and symbols are refused": well
// known and registered symbols as values, at the top and nested.
test("[unhappy-1] well-known and registered symbols are refused as values anywhere", () => {
  assertRefused(Symbol.iterator);
  assertRefused(Symbol.for("registered"));
  assertRefused([Symbol.for("registered")]);
  assertRefused({ a: 1, s: Symbol.iterator });
});

// Extends "[unhappy-1] values that are not JSON are refused deep inside the
// structure": inside objects with no prototype, class instances and Dates,
// and an own toJSON nested in an array.
test("[unhappy-1] values that are not JSON are refused inside any kind of object", () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare["a"] = 1;
  bare["b"] = undefined;
  class Holder {
    value: unknown = () => 1;
  }
  const date = Object.assign(new Date(0), { s: Symbol("s") });
  assertRefused(bare);
  assertRefused({ x: [bare] });
  assertRefused(new Holder());
  assertRefused(date);
  assertRefused([{ toJSON: () => "x" }]);
  assertRefused({ z: { y: { x: { w: [[[undefined]]] } } } });
});

// Extends "[unhappy-2] a bigint deep inside an array is refused with a
// TypeError": bigints of any value, at the top of an array, under a key that
// sorts last and inside objects with no prototype.
test("[unhappy-2] a bigint of any value is refused with a TypeError wherever it is", () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare["n"] = -1n;
  const values: unknown[] = [
    0n,
    -1n,
    2n ** 64n,
    [10n],
    [1, 2, 3n],
    { a: 1, z: 0n },
    bare,
    { deep: [{ deeper: [bare] }] },
  ];
  for (const value of values) {
    assert.throws(() => canonicalJson(value), TypeError);
  }
});

// Extends "[unhappy-3] a cycle through an intermediate object is refused with
// a RangeError": a long cycle, a cycle reached only down a deep branch, and
// cycles through objects with no prototype and class instances.
test("[unhappy-3] long cycles and cycles through any kind of object are refused with a RangeError", () => {
  const head: Record<string, unknown> = { id: 0 };
  let tail = head;
  for (let index = 1; index < 6; index += 1) {
    const next: Record<string, unknown> = { id: index };
    tail["next"] = next;
    tail = next;
  }
  tail["next"] = head;
  assert.throws(() => canonicalJson(head), RangeError);

  const loop: Record<string, unknown> = {};
  loop["again"] = { inner: loop };
  assert.throws(() => canonicalJson({ a: 1, b: { c: { d: loop } } }), RangeError);

  const bare = Object.create(null) as Record<string, unknown>;
  bare["self"] = bare;
  assert.throws(() => canonicalJson(bare), RangeError);

  class Node {
    next: Node | null = null;
  }
  const node = new Node();
  node.next = node;
  assert.throws(() => canonicalJson({ node }), RangeError);
});

// Extends "[unhappy-3] a cyclic structure is refused with a RangeError": a
// refused cycle leaves nothing behind, so the same objects are written once
// the cycle is broken.
test("[unhappy-3] a cycle is refused on every call and its objects are written once it is broken", () => {
  const o: Record<string, unknown> = { a: 1 };
  const child: Record<string, unknown> = { back: o };
  o["child"] = child;
  assert.throws(() => canonicalJson(o), RangeError);
  assert.throws(() => canonicalJson(o), RangeError);
  child["back"] = null;
  assert.equal(canonicalJson(o), '{"a":1,"child":{"back":null}}');
  assert.equal(canonicalJson({ x: child, y: child }), '{"x":{"back":null},"y":{"back":null}}');
});

// Extends "[unhappy-4] a cycle from an array through an object element is
// refused with a RangeError": deeper array nesting and the cycle at a later
// index.
test("[unhappy-4] cycles through nested arrays and at later indexes are refused with a RangeError", () => {
  const deep: unknown[] = [];
  deep.push([[deep]]);
  assert.throws(() => canonicalJson(deep), RangeError);

  const later: unknown[] = [1, 2];
  later.push(later);
  assert.throws(() => canonicalJson(later), RangeError);

  const holder: Record<string, unknown> = { a: 1 };
  holder["list"] = [0, [holder]];
  assert.throws(() => canonicalJson(holder), RangeError);

  const list: unknown[] = [];
  list.push({ b: { c: [list] } });
  assert.throws(() => canonicalJson({ top: list }), RangeError);
});
