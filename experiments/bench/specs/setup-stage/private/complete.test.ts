/**
 * Hidden tests for `setupComplete` (ticket #84) and for the purity of all
 * three functions. Each test starts from the spec's base facts and changes
 * only the fields it names.
 */

import { expect, test } from "vitest";

import {
  setupComplete,
  setupStage,
  setupSteps,
  type SetupFacts,
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

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Whether the spec's definitions make every listed step done. */
const expectedComplete = (input: SetupFacts): boolean =>
  (!input.jira.available || input.jira.connected > 0) &&
  (!input.github.available || input.github.repositories > 0) &&
  input.proposals > 0;

// Extends "[happy-6] the checklist is complete only when jira, github and
// size are all done": larger and fractional counts, a member, and every
// single step missing in turn.
test("[happy-6] a member with every step done by large or fractional counts is complete", () => {
  expect(
    setupComplete(
      facts({
        canManage: false,
        jira: { connected: 1 },
        github: { repositories: 1 },
        proposals: 1,
      }),
    ),
  ).toBe(true);
  expect(
    setupComplete(
      facts({
        jira: { connected: 9, broken: 2 },
        github: { connected: 3, repositories: 14 },
        proposals: 40,
        bounties: 7,
      }),
    ),
  ).toBe(true);
  expect(
    setupComplete(
      facts({
        jira: { connected: 0.5 },
        github: { repositories: 0.5 },
        proposals: 0.5,
      }),
    ),
  ).toBe(true);
});

test("[happy-6] two of three steps done is never complete, whichever is missing", () => {
  expect(
    setupComplete(facts({ github: { repositories: 1 }, proposals: 1 })),
  ).toBe(false);
  expect(
    setupComplete(facts({ jira: { connected: 1 }, proposals: 1 })),
  ).toBe(false);
  expect(
    setupComplete(
      facts({ jira: { connected: 1 }, github: { repositories: 1 } }),
    ),
  ).toBe(false);
});

// Extends "[happy-6] completion only needs the steps listed, and ignores
// canManage": a listed step stays required, wherever the order puts it.
test("[happy-6] a listed step left undone keeps the checklist incomplete when another tool is not offered", () => {
  expect(
    setupComplete(
      facts({ jira: { available: false }, proposals: 1 }),
    ),
  ).toBe(false);
  expect(
    setupComplete(
      facts({ github: { available: false }, proposals: 1 }),
    ),
  ).toBe(false);
  expect(
    setupComplete(
      facts({
        jira: { available: false },
        github: { connected: 1, repositories: 0 },
        proposals: 1,
      }),
    ),
  ).toBe(false);
  // The github stage without a GitHub App lists size, jira: Jira is required.
  expect(
    setupComplete(
      facts({
        github: { available: false, connected: 1, repositories: 1 },
        proposals: 1,
      }),
    ),
  ).toBe(false);
});

test("[happy-6] canManage false gives the completion canManage true would", () => {
  const cases: Changes[] = [
    { jira: { connected: 1 }, github: { repositories: 1 }, proposals: 1 },
    { jira: { available: false }, github: { available: false }, proposals: 1 },
    { jira: { connected: 1 }, github: { available: false }, proposals: 1 },
    { jira: { connected: 1 }, github: { repositories: 1 } },
    { github: { repositories: 1 }, proposals: 1 },
  ];
  for (const changes of cases) {
    expect(setupComplete(facts({ ...changes, canManage: false }))).toBe(
      setupComplete(facts({ ...changes, canManage: true })),
    );
    expect(setupComplete(facts({ ...changes, canManage: false }))).toBe(
      expectedComplete(facts(changes)),
    );
  }
});

// Extends "[boundary-12] a GitHub connection without a repository leaves the
// checklist incomplete": many connections, and odd repository counts.
test("[boundary-12] many GitHub connections with no, negative or NaN repositories leave the checklist incomplete", () => {
  for (const repositories of [0, -1, NaN, -Infinity]) {
    expect(
      setupComplete(
        facts({
          jira: { connected: 1 },
          github: { connected: 10, repositories },
          proposals: 1,
        }),
      ),
    ).toBe(false);
  }
});

// Extends "[boundary-12] one repository on that connection completes the
// checklist": a fractional repository count, and repositories without a
// connection.
test("[boundary-12] a fractional repository count, or repositories without a connection, complete the checklist", () => {
  expect(
    setupComplete(
      facts({
        jira: { connected: 1 },
        github: { connected: 1, repositories: 0.5 },
        proposals: 1,
      }),
    ),
  ).toBe(true);
  expect(
    setupComplete(
      facts({
        jira: { connected: 1 },
        github: { connected: 0, repositories: 2 },
        proposals: 1,
      }),
    ),
  ).toBe(true);
});

// Extends "[boundary-13] a hand-written bounty does not complete the size
// step" and "[boundary-13] many bounties still do not, and one proposal
// does": where size is the only step listed, and with an infinite count.
test("[boundary-13] bounties do not complete a checklist whose only step is size", () => {
  expect(
    setupComplete(
      facts({
        jira: { available: false },
        github: { available: false },
        bounties: 1,
      }),
    ),
  ).toBe(false);
  expect(
    setupComplete(
      facts({
        jira: { connected: 1 },
        github: { repositories: 1 },
        proposals: -1,
        bounties: Infinity,
      }),
    ),
  ).toBe(false);
});

const ODD = [-1, 0, 0.5, 1, NaN];

// Extends "[boundary-14] setupComplete agrees with setupSteps across ordinary
// facts" and "[boundary-14] setupComplete agrees with setupSteps for odd
// counts and unoffered tools": every combination of odd counts, offered
// tools and canManage, checked both against setupSteps and against the
// spec's definitions (so an implementation cannot agree by being wrong in
// both functions the same way).
test("[boundary-14] setupComplete agrees with setupSteps and the definitions for every combination of facts", () => {
  const wrong: string[] = [];
  let i = 0;
  for (const jira of ODD)
    for (const github of ODD)
      for (const repositories of ODD)
        for (const proposals of ODD)
          for (const jiraAvailable of [true, false])
            for (const githubAvailable of [true, false]) {
              i += 1;
              const input = facts({
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
              });
              const steps = setupSteps(input);
              const complete = setupComplete(input);
              const allDone = steps.every((step) => step.done);
              if (
                complete !== allDone ||
                complete !== expectedComplete(input) ||
                (complete && steps.some((step) => step.current))
              )
                wrong.push(
                  `${JSON.stringify(input)} -> ${String(complete)} with ${JSON.stringify(steps)}`,
                );
            }
  expect(wrong).toEqual([]);
});

// Extends "[boundary-15] the facts are left as they were": facts at the
// github stage with every step done, and facts with no tool offered.
test("[boundary-15] frozen github-stage facts are left as they were", () => {
  const changes: Changes = {
    jira: { available: false, broken: 3, boards: 2 },
    github: { connected: 2, repositories: 4 },
    proposals: 5,
    bounties: 1,
  };
  const input = deepFreeze(facts(changes));
  expect(() => setupStage(input)).not.toThrow();
  expect(() => setupSteps(input)).not.toThrow();
  expect(() => setupComplete(input)).not.toThrow();
  expect(setupStage(input)).toBe("github");
  expect(setupSteps(input)).toEqual([
    { id: "github", done: true, current: false },
    { id: "size", done: true, current: false },
  ]);
  expect(setupComplete(input)).toBe(true);
  expect(input).toEqual(facts(changes));
});

test("[boundary-15] facts called many times, in any order, are left as they were and give the same answers", () => {
  const changes: Changes = {
    jira: { connected: 1, broken: 2 },
    github: { available: false, connected: 1 },
    proposals: 2,
    canManage: false,
  };
  const input = facts(changes);
  const stage = setupStage(input);
  const steps = setupSteps(input);
  const complete = setupComplete(input);
  for (let round = 0; round < 3; round += 1) {
    expect(setupComplete(input)).toBe(complete);
    expect(setupSteps(input)).toEqual(steps);
    expect(setupStage(input)).toBe(stage);
  }
  expect(stage).toBe("both");
  expect(steps).toEqual([
    { id: "jira", done: true, current: false },
    { id: "size", done: true, current: false },
  ]);
  expect(complete).toBe(true);
  expect(input).toEqual(facts(changes));
});

// Extends "[boundary-16] each setupSteps call returns a new, equal array": a
// caller changing one result does not change the next.
test("[boundary-16] changing one returned array leaves the next call's result as it was", () => {
  const input = facts({ jira: { connected: 1 } });
  const first = setupSteps(input);
  first.reverse();
  first.pop();
  first.push({ id: "size", done: true, current: true });
  const second = setupSteps(input);
  expect(second).not.toBe(first);
  expect(second).toEqual([
    { id: "jira", done: true, current: false },
    { id: "github", done: false, current: true },
    { id: "size", done: false, current: false },
  ]);
});

// Extends "[boundary-16] equal facts in separate objects give equal, separate
// arrays, even of one step": many calls, all distinct.
test("[boundary-16] every one of many setupSteps calls returns its own array", () => {
  const input = facts({ github: { repositories: 1 }, proposals: 1 });
  const results = Array.from({ length: 5 }, () => setupSteps(input));
  expect(new Set(results).size).toBe(5);
  for (const result of results)
    expect(result).toEqual([
      { id: "github", done: true, current: false },
      { id: "size", done: true, current: false },
      { id: "jira", done: false, current: true },
    ]);
});
