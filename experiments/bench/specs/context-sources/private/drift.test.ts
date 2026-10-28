import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_CONTEXT, contextDrift } from "../../src/sources.js";

// Extends "[happy-12] drift per source".
test("[happy-12] each source is compared on its own", () => {
  const cases = [
    {
      current: { jira: 10, github: 3 },
      used: { jira: 2, github: 3 },
      drift: { jira: { uses: 2, current: 10 }, github: null },
    },
    {
      current: { jira: 5, github: 100 },
      used: { jira: 7, github: 99 },
      drift: { jira: null, github: { uses: 99, current: 100 } },
    },
    {
      current: { jira: null, github: 3 },
      used: { jira: 1, github: null },
      drift: { jira: null, github: { uses: null, current: 3 } },
    },
    {
      current: { jira: 2, github: null },
      used: { jira: null, github: 8 },
      drift: { jira: { uses: null, current: 2 }, github: null },
    },
    {
      current: { jira: 1000, github: 1 },
      used: { jira: 0, github: 0 },
      drift: { jira: { uses: 0, current: 1000 }, github: { uses: 0, current: 1 } },
    },
  ];
  for (const { current, used, drift } of cases) {
    assert.deepEqual(
      contextDrift(current, used),
      drift,
      JSON.stringify({ current, used }),
    );
  }
});

// Extends "[boundary-16] one source with no version and the other a step ahead gives no drift".
test("[boundary-16] a step far ahead, at the same version, or of a source the overview lacks, is not behind", () => {
  const cases = [
    { current: { jira: 0, github: 1 }, used: { jira: 1000, github: 2 } },
    { current: { jira: null, github: 0 }, used: { jira: 0, github: 0 } },
    { current: { jira: 0, github: null }, used: { jira: 0, github: 50 } },
    { current: { jira: 77, github: 78 }, used: { jira: 77, github: 78 } },
  ];
  for (const { current, used } of cases) {
    assert.deepEqual(
      contextDrift(current, used),
      { jira: null, github: null },
      JSON.stringify({ current, used }),
    );
  }
});

// Extends "[boundary-17] NO_CONTEXT against itself".
test("[boundary-17] NO_CONTEXT against a copy of itself, either way round, leaves it unchanged", () => {
  assert.deepEqual(contextDrift({ ...NO_CONTEXT }, NO_CONTEXT), {
    jira: null,
    github: null,
  });
  assert.deepEqual(contextDrift(NO_CONTEXT, { ...NO_CONTEXT }), {
    jira: null,
    github: null,
  });
  assert.deepEqual(NO_CONTEXT, { jira: null, github: null });
});
