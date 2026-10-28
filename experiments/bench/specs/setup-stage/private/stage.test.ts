/**
 * Hidden tests for `setupStage` (ticket #84): which home the facts put a
 * workspace at. Each test starts from the spec's base facts and changes only
 * the fields it names.
 */

import { expect, test } from "vitest";

import {
  setupStage,
  type SetupFacts,
  type SetupStage,
} from "../../src/features/onboarding/setup";

type Changes = {
  readonly jira?: Partial<SetupFacts["jira"]>;
  readonly github?: Partial<SetupFacts["github"]>;
  readonly proposals?: number;
  readonly bounties?: number;
  readonly canManage?: boolean;
};

/** The spec's base facts, with only the named fields changed. */
const facts = (changes: Changes = {}): SetupFacts => ({
  jira: {
    available: true,
    connected: 0,
    broken: 0,
    boards: 0,
    ...changes.jira,
  },
  github: {
    available: true,
    connected: 0,
    repositories: 0,
    ...changes.github,
  },
  proposals: changes.proposals ?? 0,
  bounties: changes.bounties ?? 0,
  canManage: changes.canManage ?? true,
});

// Extends "[happy-1] the stage names the tools with healthy connections" and
// "[happy-1] several connections of each tool are still the both stage":
// counts other than 0 and 1, and lopsided pairs.
test("[happy-1] many connections of one tool alone name only that tool", () => {
  expect(setupStage(facts({ jira: { connected: 50 } }))).toBe("jira");
  expect(setupStage(facts({ github: { connected: 9 } }))).toBe("github");
  expect(
    setupStage(facts({ jira: { connected: 1 }, github: { connected: 100 } })),
  ).toBe("both");
  expect(
    setupStage(facts({ jira: { connected: 40 }, github: { connected: 1 } })),
  ).toBe("both");
});

// Extends "[boundary-1] boards, proposals and bounties leave a Jira workspace
// at the jira stage": larger values, and boards without a Jira connection.
test("[boundary-1] boards never make Jira count, however many there are", () => {
  expect(setupStage(facts({ jira: { boards: 4 } }))).toBe("barebone");
  expect(setupStage(facts({ jira: { boards: 1000 } }))).toBe("barebone");
  expect(
    setupStage(facts({ jira: { boards: 3 }, github: { connected: 1 } })),
  ).toBe("github");
  expect(
    setupStage(
      facts({
        jira: { connected: 2, boards: 1000 },
        proposals: 1,
        bounties: 50,
      }),
    ),
  ).toBe("jira");
});

test("[boundary-1] proposals and bounties alone never move a workspace off barebone", () => {
  expect(setupStage(facts({ proposals: 12, bounties: 3 }))).toBe("barebone");
  expect(setupStage(facts({ proposals: 1 }))).toBe("barebone");
  expect(setupStage(facts({ bounties: 1 }))).toBe("barebone");
});

// Extends "[boundary-1] repositories add GitHub to a Jira workspace's stage":
// one repository, and a fractional count.
test("[boundary-1] a single or fractional repository count adds GitHub to a Jira stage", () => {
  expect(
    setupStage(facts({ jira: { connected: 3 }, github: { repositories: 1 } })),
  ).toBe("both");
  expect(
    setupStage(
      facts({ jira: { connected: 1 }, github: { repositories: 0.5 } }),
    ),
  ).toBe("both");
});

// Extends "[boundary-2] repositories without a GitHub connection are the
// github stage": odd connection counts beside repositories.
test("[boundary-2] repositories make the github stage even beside a negative or NaN connection count", () => {
  expect(
    setupStage(facts({ github: { connected: -1, repositories: 1 } })),
  ).toBe("github");
  expect(
    setupStage(facts({ github: { connected: NaN, repositories: 2 } })),
  ).toBe("github");
  expect(
    setupStage(
      facts({ github: { available: false, connected: 0, repositories: 5 } }),
    ),
  ).toBe("github");
});

// Extends "[boundary-2] one repository is enough for the github stage, none
// is not": negative, NaN and fractional repository counts.
test("[boundary-2] negative or NaN repositories are none, a fractional one counts", () => {
  expect(setupStage(facts({ github: { repositories: -2 } }))).toBe("barebone");
  expect(setupStage(facts({ github: { repositories: NaN } }))).toBe(
    "barebone",
  );
  expect(setupStage(facts({ github: { repositories: 0.5 } }))).toBe("github");
});

// Extends "[boundary-3] a member who cannot manage sees the both stage when
// both are connected": both via repositories, and with tools not offered.
test("[boundary-3] canManage false gives the stage repositories and unoffered tools would", () => {
  expect(
    setupStage(facts({ canManage: false, github: { repositories: 3 } })),
  ).toBe("github");
  expect(
    setupStage(
      facts({
        canManage: false,
        jira: { connected: 1 },
        github: { repositories: 3 },
      }),
    ),
  ).toBe("both");
  expect(
    setupStage(
      facts({
        canManage: false,
        jira: { available: false, connected: 2 },
        github: { available: false, connected: 2 },
      }),
    ),
  ).toBe("both");
});

// Extends "[boundary-4] negative and NaN connection counts are read as none,
// without throwing": other odd values.
test("[boundary-4] -Infinity, -0 and negative GitHub counts are none, without throwing", () => {
  expect(setupStage(facts({ jira: { connected: -Infinity } }))).toBe(
    "barebone",
  );
  expect(setupStage(facts({ jira: { connected: -0 } }))).toBe("barebone");
  expect(setupStage(facts({ github: { connected: NaN } }))).toBe("barebone");
  expect(
    setupStage(
      facts({
        jira: { connected: NaN },
        github: { connected: -Infinity, repositories: -1 },
      }),
    ),
  ).toBe("barebone");
});

// Extends "[boundary-4] a fractional count above zero counts, and NaN beside a
// real one does not": the smallest positive number, Infinity, fractional
// GitHub counts.
test("[boundary-4] any count above zero counts, however small or large", () => {
  expect(setupStage(facts({ jira: { connected: Number.MIN_VALUE } }))).toBe(
    "jira",
  );
  expect(setupStage(facts({ jira: { connected: Infinity } }))).toBe("jira");
  expect(setupStage(facts({ github: { connected: 0.5 } }))).toBe("github");
  expect(setupStage(facts({ github: { connected: 1e-9 } }))).toBe("github");
  expect(
    setupStage(facts({ jira: { connected: 0.1 }, github: { connected: 0.1 } })),
  ).toBe("both");
  expect(
    setupStage(facts({ jira: { connected: 1 }, github: { connected: NaN } })),
  ).toBe("jira");
});

const pos = (count: number) => count > 0;

const expectedStage = (input: SetupFacts): SetupStage => {
  const jira = pos(input.jira.connected);
  const github = pos(input.github.connected) || pos(input.github.repositories);
  if (jira && github) return "both";
  if (jira) return "jira";
  if (github) return "github";
  return "barebone";
};

const ODD = [-Infinity, -1, -0, 0, Number.MIN_VALUE, 0.5, 1, 7, Infinity, NaN];

// Across every combination of odd counts and offered tools, the stage reads
// each count as positive only when it is above zero, and never throws.
test("[boundary-4] every combination of odd counts is read, not rejected", () => {
  const wrong: string[] = [];
  let i = 0;
  for (const jira of ODD)
    for (const github of ODD)
      for (const repositories of ODD)
        for (const jiraAvailable of [true, false])
          for (const githubAvailable of [true, false]) {
            i += 1;
            const other = ODD[i % ODD.length] as number;
            const input = facts({
              jira: {
                available: jiraAvailable,
                connected: jira,
                broken: other,
                boards: ODD[(i * 3) % ODD.length] as number,
              },
              github: {
                available: githubAvailable,
                connected: github,
                repositories,
              },
              proposals: ODD[(i * 7) % ODD.length] as number,
              bounties: other,
              canManage: i % 2 === 0,
            });
            let actual: unknown;
            try {
              actual = setupStage(input);
            } catch (error) {
              actual = `threw ${String(error)}`;
            }
            if (actual !== expectedStage(input))
              wrong.push(
                `${JSON.stringify(input)} -> ${String(actual)}, expected ${expectedStage(input)}`,
              );
          }
  expect(wrong).toEqual([]);
});

// Extends "[unhappy-1] a workspace whose Jira sites are all broken is
// barebone": many broken sites, and broken sites beside boards.
test("[unhappy-1] any number of broken Jira sites alone is barebone", () => {
  expect(setupStage(facts({ jira: { broken: 1 } }))).toBe("barebone");
  expect(setupStage(facts({ jira: { broken: 100 } }))).toBe("barebone");
  expect(setupStage(facts({ jira: { broken: Infinity } }))).toBe("barebone");
  expect(setupStage(facts({ jira: { broken: 2, boards: 5 } }))).toBe(
    "barebone",
  );
});

// Extends "[unhappy-1] broken Jira sites neither add Jira nor take it away":
// more broken than healthy, as many broken as healthy, beside repositories.
test("[unhappy-1] broken Jira sites outnumbering healthy ones do not take Jira away", () => {
  expect(setupStage(facts({ jira: { connected: 2, broken: 5 } }))).toBe(
    "jira",
  );
  expect(setupStage(facts({ jira: { connected: 1, broken: 1 } }))).toBe(
    "jira",
  );
  expect(
    setupStage(
      facts({ jira: { connected: 1, broken: 4 }, github: { connected: 1 } }),
    ),
  ).toBe("both");
  expect(
    setupStage(facts({ jira: { broken: 3 }, github: { repositories: 2 } })),
  ).toBe("github");
});

// Extends "[unhappy-2] Jira connections count for the stage even when the
// server does not offer Jira": the same for GitHub alone.
test("[unhappy-2] GitHub connections or repositories count even when the server has no GitHub App", () => {
  expect(
    setupStage(facts({ github: { available: false, connected: 3 } })),
  ).toBe("github");
  expect(
    setupStage(facts({ github: { available: false, repositories: 2 } })),
  ).toBe("github");
});

// Extends "[unhappy-2] available false on either tool never overrides its
// counts": combinations the public rows leave out.
test("[unhappy-2] available false with no counts adds nothing, and does not hide the other tool", () => {
  expect(
    setupStage(
      facts({ jira: { available: false }, github: { connected: 1 } }),
    ),
  ).toBe("github");
  expect(
    setupStage(
      facts({ jira: { connected: 1 }, github: { available: false } }),
    ),
  ).toBe("jira");
  expect(
    setupStage(
      facts({
        jira: { available: false, connected: 1 },
        github: { available: false, repositories: 1 },
      }),
    ),
  ).toBe("both");
  expect(setupStage(facts({ jira: { available: false } }))).toBe("barebone");
  expect(setupStage(facts({ github: { available: false } }))).toBe(
    "barebone",
  );
});
