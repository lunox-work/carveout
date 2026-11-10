/**
 * What a slice shows and what it tests, in words a maintainer and a
 * contributor read before trusting a pass in the folder.
 *
 * Exposure counts the files and lines a cut copies, by why each is there,
 * so the cost of `--whole-package`, `--with-tests` and `--copy-pure` in code
 * shown is a number before anything is handed out. The tests account names
 * every test that runs the slice's code and stays in the repository: a
 * change one of them would catch passes in the folder unseen.
 */

import type { ReachResult, SliceOrigin, SliceTestLeft } from "./reach.js";

export interface SliceExposure {
  readonly files: number;
  readonly lines: number;
  /** By origin, in `ORIGIN_ORDER`, origins with no file left out. */
  readonly byOrigin: readonly {
    readonly origin: SliceOrigin;
    readonly files: number;
    readonly lines: number;
  }[];
}

const ORIGIN_ORDER: readonly SliceOrigin[] = [
  "entry",
  "walk",
  "package",
  "pure",
  "test",
  "helper",
  "barrel",
  "test-code",
];

const ORIGIN_LABEL: Readonly<Record<SliceOrigin, string>> = {
  entry: "entry points",
  walk: "within the depth",
  package: "the rest of the package (--whole-package)",
  pure: "pure code (--copy-pure)",
  test: "tests (--with-tests)",
  helper: "the tests' helpers",
  barrel: "barrels the tests import through",
  "test-code": "code the tests run",
};

/** Lines and files the walk's included files hold, by origin. */
export function exposureOf(
  walk: Pick<ReachResult, "included" | "originOf">,
  read: (path: string) => string | null,
): SliceExposure {
  const totals = new Map<SliceOrigin, { files: number; lines: number }>();
  let lines = 0;
  for (const path of walk.included) {
    const origin = walk.originOf[path] ?? "walk";
    const text = read(path);
    const count = text === null ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    lines += count;
    const total = totals.get(origin) ?? { files: 0, lines: 0 };
    total.files += 1;
    total.lines += count;
    totals.set(origin, total);
  }
  return {
    files: walk.included.length,
    lines,
    byOrigin: ORIGIN_ORDER.flatMap((origin) => {
      const total = totals.get(origin);
      return total === undefined ? [] : [{ origin, ...total }];
    }),
  };
}

const number = (value: number) => value.toLocaleString("en-US");

/** One line: `24 files, 3,410 lines: 1 entry point (180), ...`. */
export function renderExposure(exposure: SliceExposure): string {
  return `${number(exposure.files)} files, ${number(exposure.lines)} lines: ${exposure.byOrigin
    .map(({ origin, files, lines }) => `${number(files)} ${ORIGIN_LABEL[origin]} (${number(lines)} lines)`)
    .join(", ")}.`;
}

export const TEST_LEFT_REASON: Readonly<Record<SliceTestLeft["reason"], string>> = {
  "not-asked": "not brought: cut with --with-tests",
  "other-package": "tests another package: runs only in the repository",
  runner: "runs on no runner a slice runs (node:test, Vitest): Jest, say",
  unreadable: "reads a path or a module no slice carries",
  budget: "past the file limit: raise --max-files",
};

/** What a pass in the folder says, given the tests it holds and leaves. */
export function testsVerdict(walk: Pick<ReachResult, "tests" | "testsLeft">): string {
  const left = walk.testsLeft.length;
  const plural = (n: number, word: string) => `${number(n)} ${word}${n === 1 ? "" : "s"}`;
  if (walk.tests.length === 0 && left === 0)
    return "No test in the repository runs this code: a pass in the folder says it builds and keeps its exports, nothing more.";
  if (walk.tests.length === 0)
    return `No test in the folder runs this code, and ${plural(left, "test")} in the repository ${left === 1 ? "does" : "do"}: a pass in the folder says it builds and keeps its exports, nothing more.`;
  if (left === 0) return `${plural(walk.tests.length, "test")} that run this code ${walk.tests.length === 1 ? "is" : "are"} in the folder, and none stays behind.`;
  return `${plural(walk.tests.length, "test")} that run this code ${walk.tests.length === 1 ? "is" : "are"} in the folder; ${number(left)} more stay${left === 1 ? "s" : ""} in the repository, and a change only they would catch passes here.`;
}

/**
 * The tests section of BOUNDARY.md. `name` writes a path outside the slice
 * as the folder may show it (a public cut names only its package).
 */
export function renderTestsMarkdown(
  walk: Pick<ReachResult, "tests" | "testsLeft">,
  name: (path: string) => string,
): string[] {
  const lines = ["## Tests", "", testsVerdict(walk), ""];
  if (walk.tests.length > 0) {
    lines.push("In the folder:", "");
    for (const test of walk.tests) lines.push(`- \`${test}\``);
    lines.push("");
  }
  if (walk.testsLeft.length > 0) {
    lines.push("Left in the repository, which runs them on the change after the merge:", "");
    const grouped = new Map<string, number>();
    for (const { file, reason } of walk.testsLeft) {
      const key = `\`${name(file)}\`: ${TEST_LEFT_REASON[reason]}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    for (const [key, count] of grouped) lines.push(`- ${key}${count > 1 ? ` (${count} tests)` : ""}`);
    lines.push("");
  }
  return lines;
}
