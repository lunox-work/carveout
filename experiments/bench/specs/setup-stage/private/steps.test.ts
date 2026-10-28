/**
 * Hidden tests for `setupSteps` (ticket #84): which checklist steps are
 * listed, in which order, which are done and which one is current. Each test
 * starts from the spec's base facts and changes only the fields it names.
 */

import { expect, test } from "vitest";

import {
  setupSteps,
  type SetupFacts,
  type SetupStep,
  type SetupStepId,
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

/** The listed step ids, in order. */
const ids = (input: SetupFacts): SetupStepId[] =>
  setupSteps(input).map((step) => step.id);

/** Each listed step's done value, by id. */
const done = (input: SetupFacts): Partial<Record<SetupStepId, boolean>> =>
  Object.fromEntries(setupSteps(input).map((step) => [step.id, step.done]));

/** The ids of the steps marked current. */
const current = (input: SetupFacts): SetupStepId[] =>
  setupSteps(input)
    .filter((step) => step.current)
    .map((step) => step.id);

/** The steps the spec says the facts list, worked out from its definitions. */
const expectedSteps = (input: SetupFacts): SetupStep[] => {
  const pos = (count: number) => count > 0;
  const githubStage =
    !pos(input.jira.connected) &&
    (pos(input.github.connected) || pos(input.github.repositories));
  const order: SetupStepId[] = githubStage
    ? ["github", "size", "jira"]
    : ["jira", "github", "size"];
  const isDone: Record<SetupStepId, boolean> = {
    jira: pos(input.jira.connected),
    github: pos(input.github.repositories),
    size: pos(input.proposals),
  };
  const listed = order.filter(
    (id) =>
      id === "size" ||
      (id === "jira" ? input.jira.available : input.github.available),
  );
  const first = listed.find((id) => !isDone[id]);
  return listed.map((id) => ({
    id,
    done: isDone[id],
    current: id === first,
  }));
};

const ODD = [-1, 0, 0.5, 1, NaN];

/** Every combination of odd counts, offered tools and canManage. */
const everyFacts = (): SetupFacts[] => {
  const all: SetupFacts[] = [];
  let i = 0;
  for (const jira of ODD)
    for (const github of ODD)
      for (const repositories of ODD)
        for (const proposals of ODD)
          for (const jiraAvailable of [true, false])
            for (const githubAvailable of [true, false]) {
              i += 1;
              all.push(
                facts({
                  jira: {
                    available: jiraAvailable,
                    connected: jira,
                    broken: ODD[i % ODD.length] as number,
                    boards: ODD[(i * 3) % ODD.length] as number,
                  },
                  github: {
                    available: githubAvailable,
                    connected: github,
                    repositories,
                  },
                  proposals,
                  bounties: ODD[(i * 7) % ODD.length] as number,
                  canManage: i % 2 === 0,
                }),
              );
            }
  return all;
};

// Extends "[happy-2] a fresh workspace lists jira, github and size with jira
// current" and "[happy-2] a fresh workspace without Jira offered starts at the
// github step": the other offered combinations.
test("[happy-2] a fresh workspace without GitHub offered lists jira then size, jira current", () => {
  expect(setupSteps(facts({ github: { available: false } }))).toEqual([
    { id: "jira", done: false, current: true },
    { id: "size", done: false, current: false },
  ]);
});

test("[happy-2] a fresh workspace offered neither tool lists only size, current", () => {
  expect(
    setupSteps(
      facts({ jira: { available: false }, github: { available: false } }),
    ),
  ).toEqual([{ id: "size", done: false, current: true }]);
});

// Extends "[boundary-6] with both tools offered every step is listed": counts
// do not decide listing, even when every step is done.
test("[boundary-6] a tool's step is listed whether or not its counts are positive", () => {
  expect(
    ids(
      facts({
        jira: { connected: 5, broken: 2, boards: 3 },
        github: { connected: 2, repositories: 4 },
        proposals: 3,
        bounties: 1,
      }),
    ),
  ).toEqual(["jira", "github", "size"]);
  expect(ids(facts({ jira: { connected: -1 }, proposals: NaN }))).toEqual([
    "jira",
    "github",
    "size",
  ]);
});

// Extends "[boundary-6] a tool the server does not offer has no step, and
// size is always listed": positive counts on an unoffered tool do not bring
// its step back.
test("[boundary-6] an unoffered tool has no step even when its counts are positive", () => {
  expect(ids(facts({ jira: { available: false, connected: 3 } }))).toEqual([
    "github",
    "size",
  ]);
  expect(
    ids(facts({ github: { available: false, connected: 1, repositories: 2 } })),
  ).toEqual(["size", "jira"]);
  expect(
    setupSteps(
      facts({
        jira: { available: false, connected: 2 },
        github: { available: false, connected: 1, repositories: 1 },
        proposals: 1,
      }),
    ),
  ).toEqual([{ id: "size", done: true, current: false }]);
});

test("[boundary-6] across every combination of facts a tool is listed exactly when offered, and size always", () => {
  const wrong: string[] = [];
  for (const input of everyFacts()) {
    const listed = ids(input);
    const expected = expectedSteps(input).map((step) => step.id);
    if (JSON.stringify(listed) !== JSON.stringify(expected))
      wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(listed)}`);
  }
  expect(wrong).toEqual([]);
});

// Extends "[happy-3] at the github stage sizing comes before Jira": larger
// counts, fractional counts, and other facts beside them.
test("[happy-3] the github-stage order holds for any GitHub counts and other facts", () => {
  expect(
    ids(facts({ github: { connected: 5, repositories: 9 }, proposals: 3 })),
  ).toEqual(["github", "size", "jira"]);
  expect(ids(facts({ github: { connected: 0.5 } }))).toEqual([
    "github",
    "size",
    "jira",
  ]);
  expect(
    ids(
      facts({
        jira: { connected: NaN, broken: 2, boards: 4 },
        github: { repositories: 1 },
        bounties: 2,
      }),
    ),
  ).toEqual(["github", "size", "jira"]);
});

// Extends "[happy-3] at the github stage without Jira offered the list is
// github, size": the github stage is the stage, not the github step being
// listed, so with no GitHub App the order is still size then jira.
test("[happy-3] at the github stage without a GitHub App the list is size, jira", () => {
  expect(
    setupSteps(facts({ github: { available: false, connected: 1 } })),
  ).toEqual([
    { id: "size", done: false, current: true },
    { id: "jira", done: false, current: false },
  ]);
  expect(
    ids(
      facts({
        jira: { available: false },
        github: { available: false, repositories: 3 },
      }),
    ),
  ).toEqual(["size"]);
});

// The shortcut "GitHub first whenever GitHub counts" is wrong: only the
// github stage reorders, so jira and both stages keep jira, github, size.
test("[happy-3] the both stage reached through repositories keeps jira, github, size", () => {
  expect(
    ids(facts({ jira: { connected: 1 }, github: { repositories: 3 } })),
  ).toEqual(["jira", "github", "size"]);
  expect(
    ids(
      facts({
        jira: { connected: 0.5 },
        github: { connected: 4, repositories: 4 },
      }),
    ),
  ).toEqual(["jira", "github", "size"]);
  expect(ids(facts({ jira: { connected: 2 } }))).toEqual([
    "jira",
    "github",
    "size",
  ]);
});

// Extends "[boundary-7] a member who cannot manage is listed every step":
// canManage false beside unoffered tools.
test("[boundary-7] a member who cannot manage loses only the steps of unoffered tools", () => {
  expect(
    ids(facts({ canManage: false, github: { available: false } })),
  ).toEqual(["jira", "size"]);
  expect(ids(facts({ canManage: false, jira: { available: false } }))).toEqual(
    ["github", "size"],
  );
  expect(
    ids(
      facts({
        canManage: false,
        jira: { available: false },
        github: { available: false },
      }),
    ),
  ).toEqual(["size"]);
});

// Extends "[boundary-7] a member who cannot manage gets the github-stage order
// and the both-stage order": those stages reached through repositories.
test("[boundary-7] a member's order follows stages reached through repositories", () => {
  expect(
    ids(facts({ canManage: false, github: { repositories: 2 } })),
  ).toEqual(["github", "size", "jira"]);
  expect(
    ids(
      facts({
        canManage: false,
        jira: { connected: 3 },
        github: { repositories: 2 },
      }),
    ),
  ).toEqual(["jira", "github", "size"]);
});

// Extends "[unhappy-3] a member with only broken Jira sites still sees the
// Jira step, undone": many broken sites, beside boards and proposals.
test("[unhappy-3] a member with many broken Jira sites and proposals keeps the Jira step current, undone", () => {
  expect(
    setupSteps(
      facts({
        canManage: false,
        jira: { connected: 0, broken: 9, boards: 2 },
        proposals: 3,
      }),
    ),
  ).toEqual([
    { id: "jira", done: false, current: true },
    { id: "github", done: false, current: false },
    { id: "size", done: true, current: false },
  ]);
});

// Extends "[unhappy-3] a member with broken Jira sites at the github stage
// keeps the Jira step last, undone": with the GitHub step and sizing done.
test("[unhappy-3] a member with broken Jira sites and everything else done has the Jira step last and current", () => {
  expect(
    setupSteps(
      facts({
        canManage: false,
        jira: { connected: 0, broken: 2 },
        github: { connected: 1, repositories: 1 },
        proposals: 2,
      }),
    ),
  ).toEqual([
    { id: "github", done: true, current: false },
    { id: "size", done: true, current: false },
    { id: "jira", done: false, current: true },
  ]);
});

// Extends "[happy-4] each step is done on its own fact": larger counts and
// pairs of facts.
test("[happy-4] pairs of facts complete exactly their own steps", () => {
  expect(done(facts({ jira: { connected: 1 }, proposals: 1 }))).toEqual({
    jira: true,
    github: false,
    size: true,
  });
  expect(
    done(facts({ github: { connected: 3, repositories: 0 }, proposals: 2 })),
  ).toEqual({ jira: false, github: false, size: true });
  expect(
    done(facts({ jira: { connected: 7 }, github: { repositories: 12 } })),
  ).toEqual({ jira: true, github: true, size: false });
  expect(done(facts({ github: { repositories: 3 }, proposals: 9 }))).toEqual({
    jira: false,
    github: true,
    size: true,
  });
});

// Extends "[happy-4] a GitHub connection alone or a bounty alone completes no
// step": many connections, many bounties, broken sites and boards together.
test("[happy-4] many GitHub connections, bounties, boards and broken sites complete no step", () => {
  expect(
    done(
      facts({
        jira: { broken: 4, boards: 8 },
        github: { connected: 50, repositories: 0 },
        bounties: 100,
      }),
    ),
  ).toEqual({ jira: false, github: false, size: false });
});

test("[happy-4] across every combination of facts each step is done exactly on its own fact", () => {
  const wrong: string[] = [];
  for (const input of everyFacts()) {
    const actual = setupSteps(input).map((step) => [step.id, step.done]);
    const expected = expectedSteps(input).map((step) => [step.id, step.done]);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(actual)}`);
  }
  expect(wrong).toEqual([]);
});

// Extends "[boundary-5] negative proposals and NaN bounties do not size the
// workspace": other non-positive proposals beside positive bounties.
test("[boundary-5] -Infinity, -0 or negative proposals do not size the workspace, whatever the bounties", () => {
  expect(done(facts({ proposals: -Infinity, bounties: 5 })).size).toBe(false);
  expect(done(facts({ proposals: -0, bounties: Infinity })).size).toBe(false);
  expect(done(facts({ proposals: -3, bounties: 1 })).size).toBe(false);
});

// Extends "[boundary-5] NaN proposals are not sized and fractional proposals
// above zero are": the smallest positive number and Infinity.
test("[boundary-5] the smallest positive and an infinite proposal count size the workspace", () => {
  expect(done(facts({ proposals: Number.MIN_VALUE })).size).toBe(true);
  expect(done(facts({ proposals: Infinity })).size).toBe(true);
});

// Extends "[boundary-8] repositories complete the github step and boards
// complete none": at the both stage, with many boards.
test("[boundary-8] at the both stage many boards still complete nothing, repositories complete github", () => {
  expect(
    setupSteps(
      facts({
        jira: { connected: 1, boards: 100 },
        github: { repositories: 1 },
      }),
    ),
  ).toEqual([
    { id: "jira", done: true, current: false },
    { id: "github", done: true, current: false },
    { id: "size", done: false, current: true },
  ]);
});

// Extends "[boundary-8] boards alone leave the checklist as fresh": many
// boards, with Jira not offered.
test("[boundary-8] boards alone leave the checklist as fresh without Jira offered too", () => {
  expect(
    setupSteps(facts({ jira: { available: false, boards: 50 } })),
  ).toEqual([
    { id: "github", done: false, current: true },
    { id: "size", done: false, current: false },
  ]);
  expect(setupSteps(facts({ jira: { boards: 50 } }))).toEqual([
    { id: "jira", done: false, current: true },
    { id: "github", done: false, current: false },
    { id: "size", done: false, current: false },
  ]);
});

// Extends "[unhappy-4] a broken Jira site leaves the Jira step undone for a
// manager": a broken site beside a negative healthy count, and beside sizing.
test("[unhappy-4] broken Jira sites beside a non-positive healthy count leave the Jira step undone", () => {
  expect(
    setupSteps(facts({ jira: { connected: -1, broken: 3 }, proposals: 1 })),
  ).toEqual([
    { id: "jira", done: false, current: true },
    { id: "github", done: false, current: false },
    { id: "size", done: true, current: false },
  ]);
});

// Extends "[unhappy-4] a broken Jira site is the one undone step when
// everything else is done": many broken sites, GitHub through a connection.
test("[unhappy-4] many broken Jira sites at the github stage leave Jira the current step", () => {
  expect(
    setupSteps(
      facts({
        jira: { connected: 0, broken: 4 },
        github: { connected: 2, repositories: 2 },
        proposals: 3,
      }),
    ),
  ).toEqual([
    { id: "github", done: true, current: false },
    { id: "size", done: true, current: false },
    { id: "jira", done: false, current: true },
  ]);
});

// Extends "[happy-5] current is the first undone step in list order": the
// rows of the outline the public test leaves out, as full lists.
test("[happy-5] at the github stage an undone github step is current even when sizing is done", () => {
  expect(
    setupSteps(facts({ github: { connected: 1 }, proposals: 1 })),
  ).toEqual([
    { id: "github", done: false, current: true },
    { id: "size", done: true, current: false },
    { id: "jira", done: false, current: false },
  ]);
});

// Extends "[happy-5] current follows the github-stage order and skips steps
// done out of order": the github stage without a GitHub App.
test("[happy-5] at the github stage without a GitHub App current runs size then jira", () => {
  expect(
    current(facts({ github: { available: false, connected: 1 } })),
  ).toEqual(["size"]);
  expect(
    current(
      facts({ github: { available: false, repositories: 1 }, proposals: 1 }),
    ),
  ).toEqual(["jira"]);
});

test("[happy-5] across every combination of facts exactly the first undone listed step is current", () => {
  const wrong: string[] = [];
  for (const input of everyFacts()) {
    const actual = setupSteps(input).map((step) => [step.id, step.current]);
    const expected = expectedSteps(input).map((step) => [
      step.id,
      step.current,
    ]);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(actual)}`);
  }
  expect(wrong).toEqual([]);
});

// Extends "[boundary-9] sizing before connecting leaves jira current" and
// "[boundary-9] sizing after connecting Jira leaves github current": with one
// tool not offered.
test("[boundary-9] sizing before connecting leaves the first listed tool current when one is not offered", () => {
  expect(
    setupSteps(facts({ github: { available: false }, proposals: 4 })),
  ).toEqual([
    { id: "jira", done: false, current: true },
    { id: "size", done: true, current: false },
  ]);
  expect(
    setupSteps(facts({ jira: { available: false }, proposals: 4 })),
  ).toEqual([
    { id: "github", done: false, current: true },
    { id: "size", done: true, current: false },
  ]);
});

// Extends "[boundary-10] a member with nothing connected has the jira step
// current": boards, bounties and broken sites beside it.
test("[boundary-10] a member with only boards, bounties and broken sites has the jira step current", () => {
  expect(
    setupSteps(
      facts({
        canManage: false,
        jira: { boards: 2, broken: 1 },
        bounties: 3,
      }),
    ),
  ).toEqual([
    { id: "jira", done: false, current: true },
    { id: "github", done: false, current: false },
    { id: "size", done: false, current: false },
  ]);
});

// Extends "[boundary-10] a member who has sized but connected nothing still
// has jira current": without GitHub offered.
test("[boundary-10] a member with nothing connected and no GitHub App has the jira step current", () => {
  expect(
    setupSteps(facts({ canManage: false, github: { available: false } })),
  ).toEqual([
    { id: "jira", done: false, current: true },
    { id: "size", done: false, current: false },
  ]);
});

// Extends "[boundary-11] every step done leaves none current": larger and
// fractional counts, for a member.
test("[boundary-11] every step done with large or fractional counts leaves none current, for a member too", () => {
  const all: SetupStep[] = [
    { id: "jira", done: true, current: false },
    { id: "github", done: true, current: false },
    { id: "size", done: true, current: false },
  ];
  expect(
    setupSteps(
      facts({
        jira: { connected: 4 },
        github: { connected: 3, repositories: 20 },
        proposals: 15,
      }),
    ),
  ).toEqual(all);
  expect(
    setupSteps(
      facts({
        canManage: false,
        jira: { connected: 0.5 },
        github: { repositories: 0.5 },
        proposals: 0.5,
      }),
    ),
  ).toEqual(all);
});

// Extends "[boundary-11] every listed step done leaves none current when Jira
// is not offered": GitHub not offered, and neither offered.
test("[boundary-11] every listed step done leaves none current when GitHub or both tools are not offered", () => {
  expect(
    setupSteps(
      facts({
        jira: { connected: 1 },
        github: { available: false },
        proposals: 1,
      }),
    ),
  ).toEqual([
    { id: "jira", done: true, current: false },
    { id: "size", done: true, current: false },
  ]);
  expect(
    setupSteps(
      facts({
        jira: { available: false },
        github: { available: false },
        proposals: 2,
      }),
    ),
  ).toEqual([{ id: "size", done: true, current: false }]);
});
