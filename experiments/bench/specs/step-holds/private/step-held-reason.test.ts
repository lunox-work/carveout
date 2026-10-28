import assert from "node:assert/strict";
import { test } from "node:test";

import { stepHeldBy, stepHeldReason } from "../../src/stages.js";

const PRICE_REASON = "Approve the scope before changing the price.";
const SANDBOX_SCOPE_REASON =
  "Approve the scope and the price before changing the sandbox.";
const SANDBOX_PRICE_REASON = "Approve the price before changing the sandbox.";

// Extends "[happy-4] each hold has its own words": the words are the same on
// every call, in any order, and are plain strings.
test("[happy-4] each hold has its own words, whatever order they are asked in", () => {
  const pairs: ["price" | "sandbox", "scope" | "price", string][] = [
    ["sandbox", "price", SANDBOX_PRICE_REASON],
    ["price", "scope", PRICE_REASON],
    ["sandbox", "scope", SANDBOX_SCOPE_REASON],
    ["sandbox", "price", SANDBOX_PRICE_REASON],
    ["sandbox", "scope", SANDBOX_SCOPE_REASON],
    ["price", "scope", PRICE_REASON],
  ];
  for (const [step, heldBy, reason] of pairs) {
    const got = stepHeldReason(step, heldBy);
    assert.equal(typeof got, "string");
    assert.equal(got, reason, JSON.stringify({ step, heldBy }));
  }
});

// Shortcut: the sandbox's reason chosen by the step alone.
test("[happy-4] the sandbox's reason depends on the step holding it", () => {
  assert.notEqual(stepHeldReason("sandbox", "scope"), stepHeldReason("sandbox", "price"));
  assert.equal(stepHeldReason("sandbox", "scope"), SANDBOX_SCOPE_REASON);
  assert.equal(stepHeldReason("sandbox", "price"), SANDBOX_PRICE_REASON);
});

// Extends "[happy-5] each hold stepHeldBy can return maps to its own reason":
// every hold over a grid of bounties and proposals has its reason.
test("[happy-5] every hold stepHeldBy returns over a grid has the reason for it", () => {
  const approvals = [null, { version: 2 }, { version: 3 }, { version: 4 }];
  const proposals = [
    null,
    { status: "approved" },
    { status: "proposed" },
    { status: "rejected" },
    { status: "Approved" },
  ];
  const seen = new Set<string>();
  for (const approval of approvals) {
    for (const proposal of proposals) {
      const bounty = { version: 3, approval };
      const scopeOk = approval !== null && approval.version === 3;
      const priceOk = proposal !== null && proposal.status === "approved";

      const priceHeld = stepHeldBy("price", bounty, proposal);
      assert.equal(priceHeld, scopeOk ? null : "scope");
      if (priceHeld !== null) {
        assert.equal(stepHeldReason("price", priceHeld), PRICE_REASON);
        seen.add(`price:${priceHeld}`);
      }

      const sandboxHeld = stepHeldBy("sandbox", bounty, proposal);
      assert.equal(sandboxHeld, !scopeOk ? "scope" : !priceOk ? "price" : null);
      if (sandboxHeld !== null) {
        assert.equal(
          stepHeldReason("sandbox", sandboxHeld),
          sandboxHeld === "scope" ? SANDBOX_SCOPE_REASON : SANDBOX_PRICE_REASON,
        );
        seen.add(`sandbox:${sandboxHeld}`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["price:scope", "sandbox:price", "sandbox:scope"]);
});

// Extends "[unhappy-4] unknown steps and holders still get one of the three
// sentences": values that trimming or case folding would turn into a known
// step, and values that are not strings.
test("[unhappy-4] a step that only resembles \"price\" does not get the price's sentence", () => {
  const rows: [unknown, unknown, string][] = [
    ["price ", "scope", SANDBOX_SCOPE_REASON],
    [" price", "scope", SANDBOX_SCOPE_REASON],
    ["PRICE", "scope", SANDBOX_SCOPE_REASON],
    ["Price", "price", SANDBOX_PRICE_REASON],
    ["prices", "sandbox", SANDBOX_PRICE_REASON],
    ["price\n", "price", SANDBOX_PRICE_REASON],
  ];
  for (const [step, heldBy, reason] of rows) {
    assert.equal(
      stepHeldReason(step as never, heldBy as never),
      reason,
      JSON.stringify({ step, heldBy }),
    );
  }
});

// Shortcut: a heldBy compared loosely, so near misses of "scope" get the
// scope-and-price sentence.
test("[unhappy-4] only the exact holder \"scope\" gives a step other than the price the scope-and-price sentence", () => {
  const rows: [unknown, unknown, string][] = [
    ["sandbox", "SCOPE", SANDBOX_PRICE_REASON],
    ["sandbox", "scope ", SANDBOX_PRICE_REASON],
    ["sandbox", " scope", SANDBOX_PRICE_REASON],
    ["sandbox", "scopes", SANDBOX_PRICE_REASON],
    ["sandbox", "", SANDBOX_PRICE_REASON],
    ["scope", "price", SANDBOX_PRICE_REASON],
    ["scope", "sandbox", SANDBOX_PRICE_REASON],
    ["SANDBOX", "scope", SANDBOX_SCOPE_REASON],
    ["sandbox ", "scope", SANDBOX_SCOPE_REASON],
  ];
  for (const [step, heldBy, reason] of rows) {
    assert.equal(
      stepHeldReason(step as never, heldBy as never),
      reason,
      JSON.stringify({ step, heldBy }),
    );
  }
});

test("[unhappy-4] a step or holder that is not a string is not refused", () => {
  const rows: [unknown, unknown, string][] = [
    ["price", undefined, PRICE_REASON],
    ["price", null, PRICE_REASON],
    ["price", 0, PRICE_REASON],
    ["sandbox", undefined, SANDBOX_PRICE_REASON],
    ["sandbox", null, SANDBOX_PRICE_REASON],
    [undefined, "scope", SANDBOX_SCOPE_REASON],
    [null, "scope", SANDBOX_SCOPE_REASON],
    [undefined, "price", SANDBOX_PRICE_REASON],
    [null, null, SANDBOX_PRICE_REASON],
    [undefined, undefined, SANDBOX_PRICE_REASON],
    [1, "scope", SANDBOX_SCOPE_REASON],
  ];
  for (const [step, heldBy, reason] of rows) {
    assert.equal(
      stepHeldReason(step as never, heldBy as never),
      reason,
      String(step) + " " + String(heldBy),
    );
  }
});
