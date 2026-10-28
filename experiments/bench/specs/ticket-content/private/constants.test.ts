import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_ISSUE_TYPE,
  TICKET_LIMITS,
  TICKET_ORIGINS,
  TICKET_SPEC_HASH_VERSION,
  clampTicketTitle,
  ticketSpecHash,
} from "../../src/ticket.js";

/**
 * The constants have one fixed definition, and the functions that depend on
 * them use that definition rather than a private copy.
 */

const FIX_IT = "cddb635f134a4d5762ecb6231a36db6d93e45e613c8fc8c2d19837e5aaf6c16c";

// Extends "[happy-1] the origins are manual then jira, in that order".
test("[happy-1] the origins are exactly manual then jira, and not jira then manual", () => {
  assert.deepEqual([...TICKET_ORIGINS], ["manual", "jira"]);
  assert.notDeepEqual([...TICKET_ORIGINS], ["jira", "manual"]);
  assert.equal(TICKET_ORIGINS.indexOf("manual"), 0);
  assert.equal(TICKET_ORIGINS.indexOf("jira"), 1);
});

// Extends "[happy-2] the default issue type is Task and the hash version is 1":
// the default is the very "Task" the known version-1 fingerprint was taken with.
test("[happy-2] the default issue type hashes as the version-1 Task fingerprint", async () => {
  assert.equal(DEFAULT_ISSUE_TYPE, "Task");
  assert.equal(TICKET_SPEC_HASH_VERSION, 1);
  assert.equal(await ticketSpecHash("Fix it", "", DEFAULT_ISSUE_TYPE), FIX_IT);
  assert.notEqual(await ticketSpecHash("Fix it", "", DEFAULT_ISSUE_TYPE.toLowerCase()), FIX_IT);
});

// Extends "[happy-3] the ticket limits have exactly these keys and values":
// the title limit is the one clampTicketTitle cuts at.
test("[happy-3] the ticket limits are these values and the title limit is the clamp length", () => {
  assert.deepEqual(
    { ...TICKET_LIMITS },
    {
      title: 255,
      description: 20000,
      issueType: 64,
      priority: 64,
      labels: 20,
      label: 64,
    },
  );
  assert.equal(clampTicketTitle("t".repeat(TICKET_LIMITS.description)).length, TICKET_LIMITS.title);
  assert.equal(
    clampTicketTitle("t".repeat(TICKET_LIMITS.title)),
    "t".repeat(TICKET_LIMITS.title),
  );
});
