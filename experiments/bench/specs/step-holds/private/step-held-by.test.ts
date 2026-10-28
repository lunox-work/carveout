import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bountyStatus,
  scopeApproved,
  stageDrift,
  stepHeldBy,
} from "../../src/stages.js";

type Bounty = {
  readonly version: number;
  readonly approval: { readonly version: number } | null;
};

/** A proposal that fails on any look inside it. */
function untouchableProposal(): { readonly status: string } {
  return new Proxy({} as { readonly status: string }, {
    get() {
      throw new Error("proposal read");
    },
    has() {
      throw new Error("proposal read");
    },
    ownKeys() {
      throw new Error("proposal read");
    },
    getOwnPropertyDescriptor() {
      throw new Error("proposal read");
    },
    getPrototypeOf() {
      throw new Error("proposal read");
    },
  });
}

/** Wraps a value, deeply, so every write to it is recorded. */
function watched<T extends object>(value: T, writes: string[], path = "$"): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      const inner = Reflect.get(target, key, receiver) as unknown;
      return inner !== null && typeof inner === "object"
        ? watched(inner, writes, `${path}.${String(key)}`)
        : inner;
    },
    set(_target, key) {
      writes.push(`set ${path}.${String(key)}`);
      return true;
    },
    defineProperty(_target, key) {
      writes.push(`define ${path}.${String(key)}`);
      return true;
    },
    deleteProperty(_target, key) {
      writes.push(`delete ${path}.${String(key)}`);
      return true;
    },
    setPrototypeOf() {
      writes.push(`setPrototypeOf ${path}`);
      return true;
    },
    preventExtensions(target) {
      writes.push(`preventExtensions ${path}`);
      return Reflect.preventExtensions(target);
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// Extends "[happy-1] a price over an approved scope is not held": other
// versions, and an approval that is its own object, not the bounty's number.
test("[happy-1] a price over a scope approved at its version is not held, at any version", () => {
  for (const version of [1, 3, 7, 42, 2 ** 31, Number.MAX_SAFE_INTEGER, 2.5]) {
    assert.equal(
      stepHeldBy("price", { version, approval: { version } }, null),
      null,
      String(version),
    );
  }
});

// Shortcut: a price that answers by reading the proposal's status.
test("[happy-1] a price over an approved scope is not held whatever the proposal is", () => {
  const bounty = { version: 2, approval: { version: 2 } };
  for (const proposal of [
    null,
    { status: "approved" },
    { status: "proposed" },
    { status: "rejected" },
    { status: "superseded" },
    { status: "" },
  ]) {
    assert.equal(stepHeldBy("price", bounty, proposal), null, JSON.stringify(proposal));
  }
});

// Extends "[unhappy-1] a price over a scope not approved at its version is held
// by the scope": wider gaps, either direction, and versions far apart.
test("[unhappy-1] a price over a scope approved at any other version is held by the scope", () => {
  const rows: [number, number | null][] = [
    [1, null],
    [7, null],
    [10, 9],
    [10, 11],
    [10, 1],
    [10, 100],
    [2, 0],
    [1, 0],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1],
    [3, 2.999],
  ];
  for (const [version, approved] of rows) {
    assert.equal(
      stepHeldBy(
        "price",
        { version, approval: approved === null ? null : { version: approved } },
        null,
      ),
      "scope",
      JSON.stringify({ version, approved }),
    );
  }
});

// Shortcut: an approval at or past the version counted as approved.
test("[unhappy-1] an approval at a later version does not approve an earlier scope", () => {
  for (const version of [0, 1, 2, 5]) {
    assert.equal(
      stepHeldBy("price", { version, approval: { version: version + 1 } }, null),
      "scope",
      String(version),
    );
    assert.equal(
      stepHeldBy("price", { version, approval: { version: version + 10 } }, null),
      "scope",
      String(version),
    );
  }
});

// The scope is approved exactly when approval.version === bounty.version: NaN
// is never equal to itself.
test("[unhappy-1] a scope at version NaN is never approved", () => {
  assert.equal(
    stepHeldBy("price", { version: NaN, approval: { version: NaN } }, null),
    "scope",
  );
  assert.equal(
    stepHeldBy(
      "sandbox",
      { version: NaN, approval: { version: NaN } },
      { status: "approved" },
    ),
    "scope",
  );
});

// Shortcut: a price held by the scope that still consults the proposal.
test("[unhappy-1] a price over an unapproved scope is held by the scope even with an approved price", () => {
  assert.equal(
    stepHeldBy("price", { version: 3, approval: { version: 2 } }, { status: "approved" }),
    "scope",
  );
  assert.equal(
    stepHeldBy("price", { version: 1, approval: null }, { status: "approved" }),
    "scope",
  );
});

// Extends "[boundary-1] the price's hold never touches the proposal's status":
// no part of the proposal is looked at, at other versions too.
test("[boundary-1] the price's hold looks at no part of the proposal", () => {
  const rows: [Bounty, "scope" | null][] = [
    [{ version: 2, approval: null }, "scope"],
    [{ version: 2, approval: { version: 2 } }, null],
    [{ version: 5, approval: { version: 4 } }, "scope"],
    [{ version: 0, approval: { version: 0 } }, null],
    [{ version: 9, approval: { version: 9 } }, null],
  ];
  for (const [bounty, heldBy] of rows) {
    assert.equal(
      stepHeldBy("price", bounty, untouchableProposal()),
      heldBy,
      JSON.stringify(bounty),
    );
  }
});

// Shortcut: a price whose hold is null only when the price is unapproved, or
// "price" when the price is rejected.
test("[boundary-1] the price's hold is the same for every proposal", () => {
  const proposals = [
    null,
    { status: "approved" },
    { status: "rejected" },
    { status: "proposed" },
    { status: "Approved" },
  ];
  for (const proposal of proposals) {
    assert.equal(
      stepHeldBy("price", { version: 4, approval: { version: 4 } }, proposal),
      null,
      JSON.stringify(proposal),
    );
    assert.equal(
      stepHeldBy("price", { version: 4, approval: { version: 3 } }, proposal),
      "scope",
      JSON.stringify(proposal),
    );
    assert.equal(
      stepHeldBy("price", { version: 4, approval: null }, proposal),
      "scope",
      JSON.stringify(proposal),
    );
  }
});

// Extends "[boundary-2] version 0 approved at version 0 is approved": the
// sandbox at version 0, held by the price and by the scope.
test("[boundary-2] the sandbox over a scope at version 0 approved at version 0 waits only on the price", () => {
  assert.equal(
    stepHeldBy("sandbox", { version: 0, approval: { version: 0 } }, null),
    "price",
  );
  assert.equal(
    stepHeldBy("sandbox", { version: 0, approval: { version: 0 } }, { status: "proposed" }),
    "price",
  );
  assert.equal(
    stepHeldBy("sandbox", { version: 0, approval: null }, { status: "approved" }),
    "scope",
  );
});

// Shortcut: a truthiness test on the approval's version, or Object.is, which
// tells 0 from -0 where === does not.
test("[boundary-2] an approval at -0 approves a scope at version 0", () => {
  assert.equal(stepHeldBy("price", { version: 0, approval: { version: -0 } }, null), null);
  assert.equal(stepHeldBy("price", { version: -0, approval: { version: 0 } }, null), null);
  assert.equal(
    stepHeldBy("sandbox", { version: 0, approval: { version: -0 } }, { status: "approved" }),
    null,
  );
});

test("[boundary-2] version 0 is not approved by an approval at another version", () => {
  for (const approved of [1, -1, 2]) {
    assert.equal(
      stepHeldBy("price", { version: 0, approval: { version: approved } }, null),
      "scope",
      String(approved),
    );
    assert.equal(
      stepHeldBy("sandbox", { version: 0, approval: { version: approved } }, { status: "approved" }),
      "scope",
      String(approved),
    );
  }
});

// Extends "[happy-2] a sandbox over an approved scope and an approved price is
// not held": other versions.
test("[happy-2] a sandbox over both approved is not held, at any version", () => {
  for (const version of [1, 2, 3, 17, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      stepHeldBy("sandbox", { version, approval: { version } }, { status: "approved" }),
      null,
      String(version),
    );
  }
});

test("[happy-2] a proposal without a prototype that says approved approves the price", () => {
  const proposal = Object.assign(Object.create(null) as { status: string }, {
    status: "approved",
  });
  assert.equal(
    stepHeldBy("sandbox", { version: 6, approval: { version: 6 } }, proposal),
    null,
  );
});

// Extends "[unhappy-2] the earliest step not approved holds the sandbox": other
// versions and other statuses.
test("[unhappy-2] the earliest step not approved holds the sandbox, at other versions and statuses", () => {
  const rows: [Bounty, { readonly status: string } | null, "scope" | "price"][] = [
    [{ version: 9, approval: null }, { status: "rejected" }, "scope"],
    [{ version: 9, approval: null }, { status: "proposed" }, "scope"],
    [{ version: 9, approval: { version: 8 } }, null, "scope"],
    [{ version: 9, approval: { version: 8 } }, { status: "superseded" }, "scope"],
    [{ version: 9, approval: { version: 10 } }, null, "scope"],
    [{ version: 9, approval: { version: 1 } }, { status: "approved" }, "scope"],
    [{ version: 1, approval: { version: 9 } }, { status: "approved" }, "scope"],
    [{ version: 9, approval: { version: 9 } }, null, "price"],
    [{ version: 9, approval: { version: 9 } }, { status: "draft" }, "price"],
    [{ version: 9, approval: { version: 9 } }, { status: "pending" }, "price"],
    [{ version: 9, approval: { version: 9 } }, { status: "withdrawn" }, "price"],
    [{ version: 9, approval: { version: 9 } }, { status: "rejected" }, "price"],
    [{ version: 1, approval: { version: 1 } }, { status: "superseded" }, "price"],
  ];
  for (const [bounty, proposal, heldBy] of rows) {
    assert.equal(
      stepHeldBy("sandbox", bounty, proposal),
      heldBy,
      JSON.stringify({ bounty, proposal }),
    );
  }
});

// Shortcut: the price checked before the scope, so a sandbox with neither
// approved reports the price.
test("[unhappy-2] with neither the scope nor the price approved the sandbox is held by the scope", () => {
  for (const proposal of [null, { status: "proposed" }, { status: "rejected" }, { status: "" }]) {
    assert.equal(
      stepHeldBy("sandbox", { version: 2, approval: null }, proposal),
      "scope",
      JSON.stringify(proposal),
    );
    assert.equal(
      stepHeldBy("sandbox", { version: 2, approval: { version: 1 } }, proposal),
      "scope",
      JSON.stringify(proposal),
    );
  }
});

// Shortcut: a sandbox that copies the price's rule, never returning "price".
test("[unhappy-2] a sandbox over an approved scope and a null proposal is held by the price", () => {
  for (const version of [0, 1, 2, 5, 100]) {
    assert.equal(
      stepHeldBy("sandbox", { version, approval: { version } }, null),
      "price",
      String(version),
    );
  }
});

// Extends "[boundary-3] near misses of \"approved\"": statuses that contain,
// start with or end with "approved", or are it in another case.
test("[boundary-3] statuses that only contain or resemble \"approved\" leave the sandbox held by the price", () => {
  for (const status of [
    "unapproved",
    "disapproved",
    "not approved",
    "pre-approved",
    "approved_",
    "approvedx",
    "aPPROVED",
    "Approved ",
    "\tapproved",
    "approved\t",
    " approved",
    "approved\u0000",
    "appr oved",
    "approved!",
    "approve",
    "accepted",
    "true",
  ]) {
    assert.equal(
      stepHeldBy("sandbox", { version: 1, approval: { version: 1 } }, { status }),
      "price",
      JSON.stringify(status),
    );
  }
});

test("[boundary-3] the exact status \"approved\" approves the price at any scope version", () => {
  for (const version of [0, 2, 10]) {
    assert.equal(
      stepHeldBy("sandbox", { version, approval: { version } }, { status: "approved" }),
      null,
      String(version),
    );
    assert.equal(
      stepHeldBy("sandbox", { version, approval: { version } }, { status: "APPROVED" }),
      "price",
      String(version),
    );
  }
});

// Extends "[boundary-4] a price behind the scope does not hold the sandbox once
// both are approved": a sandbox behind the price, and steps that are not behind
// but not approved.
test("[boundary-4] a sandbox behind the price is not held once the scope and the price are approved", () => {
  const drift = stageDrift({
    scope: { version: 5 },
    price: { version: 4, scopeVersion: 5 },
    sandbox: { version: 2, priceVersion: 3 },
  });
  assert.equal(drift.price, null);
  assert.deepEqual(drift.sandbox, { uses: 3, current: 4 });
  assert.equal(
    stepHeldBy("sandbox", { version: 5, approval: { version: 5 } }, { status: "approved" }),
    null,
  );
});

// Shortcut: holding a step only when something is behind.
test("[boundary-4] steps with nothing behind are still held while unapproved", () => {
  const drift = stageDrift({
    scope: { version: 3 },
    price: { version: 2, scopeVersion: 3 },
    sandbox: { version: 1, priceVersion: 2 },
  });
  assert.deepEqual(drift, { price: null, sandbox: null });
  assert.equal(stepHeldBy("price", { version: 3, approval: null }, null), "scope");
  assert.equal(
    stepHeldBy("sandbox", { version: 3, approval: { version: 2 } }, { status: "approved" }),
    "scope",
  );
  assert.equal(
    stepHeldBy("sandbox", { version: 3, approval: { version: 3 } }, { status: "proposed" }),
    "price",
  );
});

// Extends "[boundary-5] fields beside the version, approval and status do not
// approve a step": fields that say approved, or published, beside an
// unapproved step, and fields that say otherwise beside an approved one.
test("[boundary-5] fields that say a step is approved do not approve it", () => {
  const unapprovedScope = {
    version: 4,
    approval: { version: 3, approved: true, current: true },
    approved: true,
    scopeApproved: true,
    status: "priced",
    sandbox: { status: "published", expiresAt: null },
  };
  assert.equal(stepHeldBy("price", unapprovedScope, null), "scope");
  assert.equal(stepHeldBy("sandbox", unapprovedScope, { status: "approved" }), "scope");

  const approvedScope = {
    version: 4,
    approval: { version: 4 },
    proposal: { status: "approved" },
    priceApproved: true,
  };
  for (const proposal of [
    { status: "proposed", approved: true, approvedAt: "2026-10-01T00:00:00Z" },
    { status: "rejected", previous: { status: "approved" } },
    { status: "Approved", revision: 9 },
  ]) {
    assert.equal(
      stepHeldBy("sandbox", approvedScope, proposal),
      "price",
      JSON.stringify(proposal),
    );
  }
});

// Shortcut: refusing on a sandbox that is published, lapsed or in draft.
test("[boundary-5] the bounty's own sandbox and status fields do not hold a step", () => {
  for (const sandbox of [
    null,
    { status: "draft", expiresAt: null },
    { status: "published", expiresAt: null },
    { status: "published", expiresAt: "2000-01-01T00:00:00Z" },
    { status: "unpublished", expiresAt: null },
  ]) {
    const bounty = {
      version: 7,
      approval: { version: 7, by: "usr_2", at: "2026-10-01T00:00:00Z" },
      title: "Fix login",
      description: "Users cannot sign in.",
      status: "new",
      sandbox,
    };
    const proposal = { status: "approved", revision: 2, scopeVersion: 1 };
    assert.equal(stepHeldBy("price", bounty, proposal), null, JSON.stringify(sandbox));
    assert.equal(stepHeldBy("sandbox", bounty, proposal), null, JSON.stringify(sandbox));
  }
});

// Extends "[happy-3] the functions do not change their arguments": every step
// and every outcome, with each write recorded rather than refused.
test("[happy-3] stepHeldBy writes nothing to its arguments, for any step or outcome", () => {
  const cases: [string, Bounty, { readonly status: string } | null][] = [
    ["price", { version: 2, approval: { version: 2 } }, { status: "approved" }],
    ["price", { version: 2, approval: null }, { status: "proposed" }],
    ["sandbox", { version: 2, approval: { version: 1 } }, { status: "proposed" }],
    ["sandbox", { version: 2, approval: { version: 2 } }, { status: "rejected" }],
    ["sandbox", { version: 2, approval: { version: 2 } }, { status: "approved" }],
    ["scope", { version: 2, approval: { version: 2 } }, { status: "approved" }],
  ];
  for (const [step, bounty, proposal] of cases) {
    const writes: string[] = [];
    const before = JSON.stringify({ bounty, proposal });
    stepHeldBy(
      step as never,
      watched(bounty, writes),
      proposal === null ? null : watched(proposal, writes),
    );
    assert.deepEqual(writes, [], step);
    assert.equal(JSON.stringify({ bounty, proposal }), before, step);
    assert.equal(Object.isFrozen(bounty), false, step);
  }
});

test("[happy-3] frozen arguments give the same answers as unfrozen ones", () => {
  const rows: [Bounty, { readonly status: string } | null, "scope" | "price" | null][] = [
    [{ version: 5, approval: null }, null, "scope"],
    [{ version: 5, approval: { version: 5 } }, { status: "proposed" }, "price"],
    [{ version: 5, approval: { version: 5 } }, { status: "approved" }, null],
  ];
  for (const [bounty, proposal, heldBy] of rows) {
    const frozenBounty = deepFreeze(structuredClone(bounty));
    const frozenProposal = deepFreeze(structuredClone(proposal));
    assert.equal(stepHeldBy("sandbox", frozenBounty, frozenProposal), heldBy);
    assert.equal(stepHeldBy("sandbox", bounty, proposal), heldBy);
    assert.deepEqual(frozenBounty, bounty);
    assert.deepEqual(frozenProposal, proposal);
  }
});

// Extends "[unhappy-3] a step outside \"price\" and \"sandbox\" waits on the
// scope only": other strings and values that are not strings.
test("[unhappy-3] other strings and non-strings as the step wait on the scope only", () => {
  const steps: unknown[] = [
    "SANDBOX",
    "price ",
    " price",
    "sandbox\n",
    "PRICE",
    "scope ",
    "sandboxes",
    undefined,
    null,
    0,
    1,
  ];
  for (const step of steps) {
    assert.equal(
      stepHeldBy(step as never, { version: 3, approval: { version: 3 } }, null),
      null,
      String(step),
    );
    assert.equal(
      stepHeldBy(step as never, { version: 3, approval: { version: 3 } }, { status: "rejected" }),
      null,
      String(step),
    );
    assert.equal(
      stepHeldBy(step as never, { version: 3, approval: { version: 2 } }, { status: "approved" }),
      "scope",
      String(step),
    );
    assert.equal(
      stepHeldBy(step as never, { version: 3, approval: null }, null),
      "scope",
      String(step),
    );
  }
});

// Shortcut: treating any step but "price" as the sandbox, which reads the
// proposal and can return "price".
test("[unhappy-3] a step outside \"price\" and \"sandbox\" looks at no part of the proposal", () => {
  for (const step of ["scope", "Sandbox", "", "SANDBOX", undefined]) {
    assert.equal(
      stepHeldBy(step as never, { version: 6, approval: { version: 6 } }, untouchableProposal()),
      null,
      String(step),
    );
    assert.equal(
      stepHeldBy(step as never, { version: 6, approval: { version: 0 } }, untouchableProposal()),
      "scope",
      String(step),
    );
    assert.equal(
      stepHeldBy(step as never, { version: 0, approval: { version: 0 } }, untouchableProposal()),
      null,
      String(step),
    );
  }
});

// Extends "[happy-6] scopeApproved and bountyStatus are unchanged": the
// scope's approval is scopeApproved's, over many bounties.
test("[happy-6] scopeApproved is unchanged and the price is held exactly when it is false", () => {
  const bounties: Bounty[] = [
    { version: 3, approval: { version: 2 } },
    { version: 3, approval: { version: 3 } },
    { version: 3, approval: { version: 4 } },
    { version: 3, approval: null },
    { version: 0, approval: { version: 0 } },
    { version: 0, approval: null },
    { version: 0, approval: { version: -0 } },
    { version: NaN, approval: { version: NaN } },
    { version: 12, approval: { version: 12 } },
  ];
  const expected = [false, true, false, false, true, false, true, false, true];
  bounties.forEach((bounty, i) => {
    assert.equal(scopeApproved(bounty), expected[i], JSON.stringify(bounty));
    assert.equal(
      stepHeldBy("price", bounty, null),
      expected[i] ? null : "scope",
      JSON.stringify(bounty),
    );
  });
});

test("[happy-6] bountyStatus is unchanged where the sandbox is held by the scope", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  const bounty = {
    version: 2,
    approval: null,
    proposal: { status: "approved" },
    sandbox: null,
  };
  assert.equal(bountyStatus(bounty, now), "priced");
  assert.equal(scopeApproved({ version: 3, approval: { version: 2 } }), false);
  assert.equal(stepHeldBy("sandbox", bounty, bounty.proposal), "scope");
  assert.equal(
    bountyStatus(
      {
        version: 2,
        approval: { version: 2 },
        proposal: null,
        sandbox: { status: "published", expiresAt: "2026-10-09T00:00:00Z" },
      },
      now,
    ),
    "scoped",
  );
  assert.equal(
    bountyStatus(
      {
        version: 2,
        approval: { version: 1 },
        proposal: { status: "proposed" },
        sandbox: { status: "published", expiresAt: null },
      },
      now,
    ),
    "live",
  );
  assert.equal(
    stepHeldBy("sandbox", { version: 2, approval: { version: 1 } }, { status: "proposed" }),
    "scope",
  );
});
