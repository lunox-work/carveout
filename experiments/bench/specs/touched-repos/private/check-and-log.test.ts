import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { starterProblems } from "sandbox-factory";
import type { StarterSubmission } from "sandbox-factory";
import { checkStarter } from "../../src/tools/starter-check.js";
import { refusedCheckLog } from "../../src/tools/starter.js";

/** The cart starter, as in starter.test.ts. */
const submission: StarterSubmission = {
  files: [
    {
      path: "src/cart.ts",
      text: [
        "export interface AcmeLine { readonly price: number; readonly quantity: number }",
        "/** What the cart comes to. TODO: the bounty: sum each line's price times quantity. */",
        "export function acmeTotal(lines: readonly AcmeLine[]): number {",
        "  return lines.length === 0 ? 0 : Number.NaN;",
        "}",
        "",
      ].join("\n"),
    },
  ],
  publicTests: [
    {
      path: "tests/public/cart.test.ts",
      text: [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { acmeTotal } from "../../src/cart.js";',
        'test("an empty cart is free", () => assert.equal(acmeTotal([]), 0));',
        "",
      ].join("\n"),
    },
  ],
  hiddenTests: [
    {
      path: "tests/private/total.test.ts",
      text: [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { acmeTotal } from "../../src/cart.js";',
        'test("lines add up", () => assert.equal(acmeTotal([{ price: 2, quantity: 3 }]), 6));',
        "",
      ].join("\n"),
      expectedBaseline: "fail",
    },
  ],
  packages: [],
  scenario:
    'import { acmeTotal } from "../src/cart.js";\nconsole.log(acmeTotal([]));\n',
  aliases: [
    { before: "AcmeLine", after: "Line", kind: "identifier", paths: [] },
    { before: "acmeTotal", after: "total", kind: "identifier", paths: [] },
  ],
  summary: "A cart whose total is left to write.",
};
const [lineAlias, totalAlias] = submission.aliases as [
  StarterSubmission["aliases"][number],
  StarterSubmission["aliases"][number],
];
const projectVersion = {
  sandboxId: "sbx_1",
  versionId: "sbv_1",
  version: 1,
  title: "Sum a cart",
  specSummary: "The cart adds up its lines.",
  complexity: "S",
  tags: [],
};
const missingImport = 'import "../src/missing.js";\n';
const MISSING =
  "sandbox/run.ts: ../src/missing.js does not resolve to a file in the project.";
const NAME_TABLE =
  "A starter needs a name table: at least one name from the bounty's own vocabulary, and the neutral name contributors read instead.";
/** The leak the cart starter shows when only acmeTotal is renamed. */
const ACME_IN_CART =
  'src/cart.ts: "acme" names the workspace and appears 2 times in 1 public file: src/cart.ts. Give it a pseudonym.';
const badType = { path: "src/a.ts", text: "export const a: number = 'x';" };
const hiddenSum = {
  path: "tests/private/total.test.ts",
  text: [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { sum } from "../../src/cart.js";',
    'test("lines add up", () => assert.equal(sum([{ price: 2, quantity: 3 }]), 6));',
    "",
  ].join("\n"),
  expectedBaseline: "fail" as const,
};

function check(
  change: Partial<StarterSubmission> = {},
  vocabulary: readonly string[] = ["acme"],
) {
  return checkStarter({
    root: join(tmpdir(), "hidden-touched-repos-confirmed-root"),
    version: projectVersion,
    starter: { ...submission, ...change },
    spec: null,
    vocabulary,
  });
}
function refused(result: ReturnType<typeof check>) {
  assert.equal(result.ok, false, JSON.stringify(result.problems));
  if (result.ok) throw new Error("unreachable");
  return result;
}

// --- checkStarter: the stage of a refused check ---

// Extends "[unhappy-1] a starter with no name table is refused at the rules stage":
// two rules problems at once, and the log names the stage it carries.
test("[unhappy-1] two rules problems at once are refused at rules, in the rules' order, and logged under rules", () => {
  const result = refused(
    check({ files: [{ path: "lib/cart.ts", text: "" }], aliases: [] }),
  );
  assert.equal(result.stage, "rules");
  assert.deepEqual(result.problems, [
    "lib/cart.ts: source files live under src/.",
    NAME_TABLE,
  ]);
  assert.equal(
    refusedCheckLog("check_starter", result.stage, result.problems),
    `check_starter refused (rules): 2 problems.\n  lib/cart.ts: source files live under src/.\n  ${NAME_TABLE}`,
  );
});

// Extends "[unhappy-1] a name that renames nothing is refused at the names stage":
// more than one unused name.
test("[unhappy-1] two names that rename nothing are both refused at the names stage", () => {
  const result = refused(
    check({
      aliases: [
        { before: "Globex", after: "Vendor", kind: "identifier", paths: [] },
        { before: "Initech", after: "Firm", kind: "identifier", paths: [] },
      ],
    }),
  );
  assert.equal(result.stage, "names");
  assert.deepEqual(result.problems, [
    "Name 1: Globex does not occur in the starter, so it renames nothing.",
    "Name 2: Initech does not occur in the starter, so it renames nothing.",
  ]);
  assert.equal(
    refusedCheckLog("run_starter", result.stage, result.problems),
    [
      "run_starter refused (names): 2 problems.",
      "  Name 1: Globex does not occur in the starter, so it renames nothing.",
      "  Name 2: Initech does not occur in the starter, so it renames nothing.",
    ].join("\n"),
  );
});

// Extends "[unhappy-1] a project blocker with a workspace leak is refused at the
// project stage": a project blocker with no leak at all is still "project".
test("[unhappy-1] a project blocker with every name renamed is refused at project with the blocker alone", () => {
  const result = refused(check({ scenario: missingImport }));
  assert.equal(result.stage, "project");
  assert.deepEqual(result.problems, [MISSING]);
  assert.equal(
    refusedCheckLog("check_starter", result.stage, result.problems),
    `check_starter refused (project): 1 problem.\n  ${MISSING}`,
  );
});

// Extends the project row with the other alias left out: the blocker still comes first.
test("[unhappy-1] a blocker with a leak from the other alias left out is project, blocker then leak", () => {
  const result = refused(check({ aliases: [totalAlias], scenario: missingImport }));
  assert.equal(result.stage, "project");
  assert.deepEqual(result.problems, [MISSING, ACME_IN_CART]);
  assert.equal(
    refusedCheckLog("submit_starter", result.stage, result.problems),
    `submit_starter refused (project): 2 problems.\n  ${MISSING}\n  ${ACME_IN_CART}`,
  );
});

// Extends "[unhappy-1] a starter that does not type-check is refused at the types stage":
// the only diagnostic is a hidden test's.
test("[unhappy-1] a hidden test that does not compile is refused at types, and its log only counts it", () => {
  const result = refused(check({ hiddenTests: [hiddenSum] }));
  assert.equal(result.stage, "types");
  assert.deepEqual(result.problems, [
    "tests/private/total.test.ts:3 TS2305 Module '\"../../src/cart.js\"' has no exported member 'sum'.",
  ]);
  assert.equal(
    refusedCheckLog("check_starter", result.stage, result.problems),
    "check_starter refused (types): 1 problem.\n  and 1 in hidden tests, not shown",
  );
});

// Extends "[unhappy-2] a workspace name left in a public file ... stops at names":
// the other alias left out, and the exact problem.
test("[unhappy-2] leaving out the acmeTotal alias leaks acme and stops at names with exactly that leak", () => {
  const result = refused(check({ aliases: [totalAlias] }));
  assert.equal(result.stage, "names");
  assert.deepEqual(result.problems, [ACME_IN_CART]);
});

test("[unhappy-2] a workspace word the whole project carries stops at names, not project", () => {
  const result = refused(check({}, ["cart"]));
  assert.equal(result.stage, "names");
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? "", /^\.gitignore: "cart" names the workspace/);
});

test("[unhappy-2] two leaked workspace words, and no blocker, give names with one problem per word in order", () => {
  const result = refused(check({ aliases: [lineAlias] }, ["acme", "cart"]));
  assert.equal(result.stage, "names");
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0] ?? "", /^sandbox\/run\.ts: "acme" names the workspace/);
  assert.match(result.problems[1] ?? "", /^\.gitignore: "cart" names the workspace/);
});

// A leak and a type error, but no project blocker: the check stops at names
// and never type-checks.
test("[unhappy-2] a leak with a type error elsewhere stops at names, with no compiler diagnostic", () => {
  const result = refused(
    check({ aliases: [totalAlias], files: [...submission.files, badType] }),
  );
  assert.equal(result.stage, "names");
  assert.deepEqual(result.problems, [ACME_IN_CART]);
  for (const problem of result.problems)
    assert.doesNotMatch(problem, /^\S+:\d+ TS\d+ /);
});

/** 45 source files, each exporting a name only it carries: 45 leaks at once. */
const leakyFiles = Array.from({ length: 45 }, (_, index) => {
  const word = `qz${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
  return { word, file: { path: `src/${word}.ts`, text: `export const ${word} = 1;\n` } };
});

// Extends "[boundary-1] a stage's problems are still capped at 40": the cap at names.
test("[boundary-1] 45 leaked words with no blocker are refused at names, capped at 40 problems", () => {
  const result = refused(
    check(
      { files: [...submission.files, ...leakyFiles.map((item) => item.file)] },
      ["acme", ...leakyFiles.map((item) => item.word)],
    ),
  );
  assert.equal(result.stage, "names");
  assert.equal(result.problems.length, 40);
  for (const problem of result.problems)
    assert.match(problem, /names the workspace/);
});

// The cap at project: blockers first, then leaks, 40 in all.
test("[boundary-1] a blocker with 45 leaks is refused at project, the blocker first, capped at 40", () => {
  const result = refused(
    check(
      {
        files: [...submission.files, ...leakyFiles.map((item) => item.file)],
        scenario: missingImport,
      },
      ["acme", ...leakyFiles.map((item) => item.word)],
    ),
  );
  assert.equal(result.stage, "project");
  assert.equal(result.problems.length, 40);
  assert.equal(result.problems[0], MISSING);
  for (const problem of result.problems.slice(1))
    assert.match(problem, /names the workspace/);
  const lines = refusedCheckLog("run_starter", result.stage, result.problems).split("\n");
  assert.equal(lines[0], "run_starter refused (project): 40 problems.");
  assert.equal(lines[1], `  ${MISSING}`);
  assert.equal(lines.at(-1), "  and 30 more");
});

// The cap at rules, with the name-table problem the 46th, and the log of the 40.
test("[boundary-1] 45 misplaced files and no name table keep the first 40 rules problems, logged as 40", () => {
  const files = Array.from({ length: 45 }, (_, index) => ({
    path: `lib/b${index + 1}.ts`,
    text: "",
  }));
  const result = refused(check({ files, aliases: [] }));
  assert.equal(result.stage, "rules");
  assert.deepEqual(
    result.problems,
    starterProblems({ ...submission, files, aliases: [] }).slice(0, 40),
  );
  assert.equal(result.problems.includes(NAME_TABLE), false);
  const log = refusedCheckLog("check_starter", result.stage, result.problems);
  const lines = log.split("\n");
  assert.equal(lines[0], "check_starter refused (rules): 40 problems.");
  assert.equal(lines.length, 12);
  assert.equal(lines[10], "  lib/b10.ts: source files live under src/.");
  assert.equal(lines[11], "  and 30 more");
});

// --- refusedCheckLog ---

// Extends "[happy-2] a rules refusal with one problem": the other stages and tools.
test("[happy-2] one problem at each stage, under each tool, is a singular header then the problem", () => {
  for (const tool of ["check_starter", "run_starter", "submit_starter"])
    for (const stage of ["rules", "names", "project", "types"] as const)
      assert.equal(
        refusedCheckLog(tool, stage, ["src/x.ts: something is wrong."]),
        `${tool} refused (${stage}): 1 problem.\n  src/x.ts: something is wrong.`,
      );
});

test("[happy-2] the tool name is written as given, even one that is no tool", () => {
  assert.equal(
    refusedCheckLog("Some Tool (v2)", "names", ["x"]),
    "Some Tool (v2) refused (names): 1 problem.\n  x",
  );
  assert.equal(
    refusedCheckLog("", "project", ["y"]),
    " refused (project): 1 problem.\n  y",
  );
});

test("[happy-2] two shown problems keep their order and have no trailing newline", () => {
  const log = refusedCheckLog("check_starter", "rules", [
    "z: last alphabetically",
    "a: first alphabetically",
  ]);
  assert.equal(
    log,
    "check_starter refused (rules): 2 problems.\n  z: last alphabetically\n  a: first alphabetically",
  );
  assert.equal(log.endsWith("\n"), false);
});

// Extends "[happy-3] a hidden test's problem is counted ... but not shown":
// hidden problems first, last and in between, several of them.
test("[happy-3] several hidden problems anywhere in the list are left out and counted together", () => {
  assert.equal(
    refusedCheckLog("run_starter", "types", [
      "tests/private/a.test.ts:1 TS2304 Cannot find name 'a'.",
      "src/one.ts:1 TS2322 one",
      "tests/private/b.test.ts:2 TS2304 Cannot find name 'b'.",
      "tests/private/c.test.ts:3 TS2304 Cannot find name 'c'.",
      "src/two.ts:2 TS2322 two",
      "tests/private/d.test.ts:4 TS2304 Cannot find name 'd'.",
    ]),
    [
      "run_starter refused (types): 6 problems.",
      "  src/one.ts:1 TS2322 one",
      "  src/two.ts:2 TS2322 two",
      "  and 4 in hidden tests, not shown",
    ].join("\n"),
  );
});

test("[happy-3] with no hidden problem there is no hidden line at all", () => {
  const log = refusedCheckLog("submit_starter", "types", [
    "src/one.ts:1 TS2322 one",
    "(project) TS5023 Unknown compiler option 'x'.",
  ]);
  assert.equal(
    log,
    "submit_starter refused (types): 2 problems.\n  src/one.ts:1 TS2322 one\n  (project) TS5023 Unknown compiler option 'x'.",
  );
  assert.equal(log.includes("hidden"), false);
});

// Extends "[boundary-2] a problem is a hidden test's only when it starts with tests/private/".
test("[boundary-2] near misses of the hidden mark are shown", () => {
  for (const shown of [
    "tests/private",
    "tests/privateer.test.ts: x",
    " tests/private/total.test.ts: x",
    "Tests/private/total.test.ts: x",
    "./tests/private/total.test.ts: x",
    "tests\\private\\total.test.ts: x",
    "tests/public/private/x.test.ts: x",
    "(project) see tests/private/total.test.ts",
  ])
    assert.equal(
      refusedCheckLog("check_starter", "rules", [shown]),
      `check_starter refused (rules): 1 problem.\n  ${shown}`,
      shown,
    );
});

test("[boundary-2] the hidden mark alone, or with anything after it, is a hidden test's", () => {
  for (const hidden of [
    "tests/private/",
    "tests/private/x",
    "tests/private/nested/deep.test.ts:9 TS1005 ';' expected.",
  ])
    assert.equal(
      refusedCheckLog("check_starter", "rules", [hidden]),
      "check_starter refused (rules): 1 problem.\n  and 1 in hidden tests, not shown",
      hidden,
    );
});

// Extends "[boundary-3] when every problem is a hidden test's": one, and more than 10.
test("[boundary-3] a single hidden problem gives the singular header and the hidden count", () => {
  assert.equal(
    refusedCheckLog("submit_starter", "types", [
      "tests/private/a.test.ts:1 TS2304 Cannot find name 'x'.",
    ]),
    "submit_starter refused (types): 1 problem.\n  and 1 in hidden tests, not shown",
  );
});

test("[boundary-3] twelve hidden problems and nothing else give no 'more' line", () => {
  assert.equal(
    refusedCheckLog(
      "check_starter",
      "types",
      Array.from({ length: 12 }, (_, index) => `tests/private/t${index}.test.ts:1 TS2304 x`),
    ),
    "check_starter refused (types): 12 problems.\n  and 12 in hidden tests, not shown",
  );
});

// Extends "[boundary-4] no problems gives the header alone": other stages and tools.
test("[boundary-4] no problems gives the plural header alone at every stage", () => {
  for (const stage of ["rules", "names", "project", "types"] as const)
    assert.equal(
      refusedCheckLog("submit_starter", stage, []),
      `submit_starter refused (${stage}): 0 problems.`,
    );
});

// Extends "[boundary-5] a problem of 300 characters is shown whole ...".
test("[boundary-5] a problem of 299 characters is shown whole", () => {
  const problem = "b".repeat(299);
  assert.equal(
    refusedCheckLog("check_starter", "rules", [problem]),
    `check_starter refused (rules): 1 problem.\n  ${problem}`,
  );
});

test("[boundary-5] a long problem keeps its first 300 characters, not its last", () => {
  const problem = Array.from({ length: 1000 }, (_, index) => String(index % 10)).join("");
  const line = refusedCheckLog("check_starter", "rules", [problem]).split("\n")[1];
  assert.equal(line, `  ${problem.slice(0, 300)}…`);
  assert.equal(line?.length, 2 + 300 + 1);
});

test("[boundary-5] 301 characters drop exactly the 301st", () => {
  const problem = `${"c".repeat(300)}Z`;
  assert.equal(
    refusedCheckLog("check_starter", "rules", [problem]),
    `check_starter refused (rules): 1 problem.\n  ${"c".repeat(300)}…`,
  );
});

test("[boundary-5] each long problem among several is cut alone, and a long hidden one is not shown", () => {
  assert.equal(
    refusedCheckLog("check_starter", "types", [
      "x".repeat(400),
      "short",
      `tests/private/${"h".repeat(400)}`,
      "y".repeat(301),
    ]),
    [
      "check_starter refused (types): 4 problems.",
      `  ${"x".repeat(300)}…`,
      "  short",
      `  ${"y".repeat(300)}…`,
      "  and 1 in hidden tests, not shown",
    ].join("\n"),
  );
});

// Extends "[boundary-6] at most 10 problems are shown, then how many more".
test("[boundary-6] exactly 10 shown problems give no 'more' line", () => {
  const problems = Array.from({ length: 10 }, (_, index) => `q${index + 1}`);
  assert.equal(
    refusedCheckLog("check_starter", "rules", problems),
    [
      "check_starter refused (rules): 10 problems.",
      ...problems.map((problem) => `  ${problem}`),
    ].join("\n"),
  );
});

test("[boundary-6] 11 shown problems leave 1 more, and 40 leave 30 more", () => {
  const eleven = Array.from({ length: 11 }, (_, index) => `q${index + 1}`);
  assert.equal(
    refusedCheckLog("run_starter", "project", eleven),
    [
      "run_starter refused (project): 11 problems.",
      ...eleven.slice(0, 10).map((problem) => `  ${problem}`),
      "  and 1 more",
    ].join("\n"),
  );
  const forty = Array.from({ length: 40 }, (_, index) => `r${index + 1}`);
  assert.equal(
    refusedCheckLog("run_starter", "project", forty),
    [
      "run_starter refused (project): 40 problems.",
      ...forty.slice(0, 10).map((problem) => `  ${problem}`),
      "  and 30 more",
    ].join("\n"),
  );
});

test("[boundary-6] hidden problems take no shown place: the first 10 shown are those not hidden", () => {
  const shown = Array.from({ length: 10 }, (_, index) => `s${index + 1}`);
  assert.equal(
    refusedCheckLog("check_starter", "types", [
      ...Array.from({ length: 5 }, (_, index) => `tests/private/h${index}.test.ts: x`),
      ...shown,
    ]),
    [
      "check_starter refused (types): 15 problems.",
      ...shown.map((problem) => `  ${problem}`),
      "  and 5 in hidden tests, not shown",
    ].join("\n"),
  );
});

test("[boundary-6] hidden problems among more than 10 shown ones are not counted in 'more'", () => {
  const problems = [
    "tests/private/a.test.ts: 1",
    ...Array.from({ length: 6 }, (_, index) => `s${index + 1}`),
    "tests/private/b.test.ts: 2",
    ...Array.from({ length: 7 }, (_, index) => `s${index + 7}`),
    "tests/private/c.test.ts: 3",
  ];
  assert.equal(
    refusedCheckLog("check_starter", "types", problems),
    [
      "check_starter refused (types): 16 problems.",
      ...Array.from({ length: 10 }, (_, index) => `  s${index + 1}`),
      "  and 3 more",
      "  and 3 in hidden tests, not shown",
    ].join("\n"),
  );
});

test("[boundary-6] problems are not deduplicated, in what is shown or what is counted", () => {
  assert.equal(
    refusedCheckLog("check_starter", "rules", [
      ...Array.from({ length: 12 }, () => "src/cart.ts is given twice."),
      "tests/private/a.test.ts: x",
      "tests/private/a.test.ts: x",
    ]),
    [
      "check_starter refused (rules): 14 problems.",
      ...Array.from({ length: 10 }, () => "  src/cart.ts is given twice."),
      "  and 2 more",
      "  and 2 in hidden tests, not shown",
    ].join("\n"),
  );
});
