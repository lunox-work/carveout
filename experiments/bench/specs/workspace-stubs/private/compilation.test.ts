import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundarySummary,
  renderBoundaryMarkdown,
  renderPublicSurfaceMarkdown,
  sliceReadiness,
} from "../../src/slice/manifest.js";
import type {
  BoundaryContract,
  CompilationResult,
  SliceManifest,
} from "../../src/slice/manifest.js";

const manifest: Pick<
  SliceManifest,
  "included" | "entryPoints" | "budget" | "externals" | "meta"
> = {
  entryPoints: ["src/app.ts"],
  budget: { maxFiles: 40, maxDepth: 3 },
  included: [
    {
      path: "src/app.ts",
      blobId: "c".repeat(40),
      sha256: "d".repeat(64),
      mode: "100644",
      sizeBytes: 10,
      operations: ["edit"],
    },
  ],
  externals: { packages: [], environment: [] },
  meta: {
    includedFiles: 1,
    includedBytes: 10,
    outboundCuts: 0,
    inboundCuts: 0,
    stubCoverage: "full",
    externals: 0,
    blockers: 0,
    ready: true,
  },
};

const contractWith = (compilation: CompilationResult): BoundaryContract => ({
  schemaVersion: 1,
  toolVersion: "slice@4",
  extractorVersion: "typescript@5.9.3",
  sourceSnapshotId: "rsn_1",
  sourceCommitSha: "a".repeat(40),
  graphRunId: "arn_graph",
  language: "typescript",
  outbound: [],
  inbound: [],
  stubCoverage: "full",
  compilation,
  blockers: [],
});

const render = (compilation: CompilationResult) =>
  renderBoundaryMarkdown(contractWith(compilation), manifest);

const TAIL =
  "the source has too, with its packages untyped, is not counted; the sandbox build checks them against the packages it installs.";
const uncounted = (count: number) =>
  count === 1
    ? `1 more error ${TAIL}`
    : `${count} more errors ${TAIL.replace("is not counted", "are not counted")}`;

const error = (index: number) => ({
  file: `src/u${index}.ts`,
  line: index + 1,
  code: `TS9${String(index).padStart(3, "0")}`,
  message: `Uncounted message ${index}.`,
});

// Extends "[happy-11] a slice@3 compilation result is still a
// CompilationResult": the same object, read where a CompilationResult is
// read, renders as a result with both fields absent, and adding them to it
// adds only their lines.
test("[happy-11] a slice@3 result is read as one with both new fields absent", () => {
  const slice3: CompilationResult = {
    attempted: true,
    ok: true,
    diagnostics: [],
    shimmedPackages: ["pg"],
  };
  assert.equal(slice3.untypedPackageErrors, undefined);
  assert.equal(slice3.typedPackages, undefined);
  const plain = render(slice3);
  assert.equal(
    render({ ...slice3, typedPackages: undefined, untypedPackageErrors: undefined }),
    plain,
  );
  assert.equal(
    render({ ...slice3, typedPackages: [{ name: "zod", version: "3.22.4" }] }),
    `${plain}\nChecked against the published types of \`zod@3.22.4\`.\n`,
  );
});

// Extends "[happy-12] a slice@4 result carries typed packages and
// untyped-package errors": the scenario's own result, rendered, names its
// typed package and counts its one error without showing it.
test("[happy-12] the slice@4 result's typed package is named and its untyped-package error counted, not shown", () => {
  const result: CompilationResult = {
    attempted: true,
    ok: true,
    diagnostics: [],
    shimmedPackages: ["@acme/shared"],
    untypedPackageErrors: [
      {
        file: "src/app.ts",
        line: 4,
        code: "TS2347",
        message: "Untyped function calls may not accept type arguments.",
      },
    ],
    typedPackages: [{ name: "zod", version: "3.22.4" }],
  };
  assert.deepEqual(result.typedPackages, [{ name: "zod", version: "3.22.4" }]);
  const markdown = render(result);
  assert.ok(
    markdown.endsWith(
      [
        "## Compilation",
        "",
        "The included files and stubs type-check together, with `@acme/shared` declared as untyped packages.",
        "",
        "Checked against the published types of `zod@3.22.4`.",
        "",
        uncounted(1),
        "",
      ].join("\n"),
    ),
    markdown,
  );
  assert.equal(markdown.includes("TS2347"), false);
  assert.equal(markdown.includes("Untyped function calls"), false);
});

// Extends "[happy-13] the boundary markdown names the typed packages and
// counts the uncounted errors": more typed packages in an unsorted order,
// more errors, and no shimmed packages.
test("[happy-13] many typed packages are named in the order given, and many errors counted in the plural", () => {
  const typedPackages = [
    { name: "zod", version: "3.22.4" },
    { name: "@types/node", version: "20.11.5" },
    { name: "axios", version: "1.6.7" },
    { name: "@acme/ui", version: "0.0.1-beta.1" },
  ];
  const errors = Array.from({ length: 12 }, (_, index) => error(index));
  const result = render({
    attempted: true,
    ok: true,
    diagnostics: [],
    shimmedPackages: [],
    typedPackages,
    untypedPackageErrors: errors,
  });
  assert.ok(
    result.endsWith(
      [
        "## Compilation",
        "",
        "The included files and stubs type-check together.",
        "",
        "Checked against the published types of `zod@3.22.4`, `@types/node@20.11.5`, `axios@1.6.7`, `@acme/ui@0.0.1-beta.1`.",
        "",
        uncounted(12),
        "",
      ].join("\n"),
    ),
    result,
  );
  for (const item of errors) {
    assert.equal(result.includes(item.code), false, item.code);
    assert.equal(result.includes(item.message), false, item.message);
    assert.equal(result.includes(item.file), false, item.file);
  }
});

// The shortcut: put the count before the typed line, or render them on one
// line. With both a failed compilation's list and both fields, each comes
// after a blank line, typed packages first.
test("[happy-13] after a failed compilation's list, typed packages and then the count follow, each after a blank line", () => {
  const result = render({
    attempted: true,
    ok: false,
    diagnostics: [
      { file: "src/a.ts", line: 3, code: "TS2322", message: "Bad." },
      { file: null, line: null, code: "TS1", message: "x" },
    ],
    shimmedPackages: ["pg"],
    typedPackages: [
      { name: "b", version: "2.0.0" },
      { name: "a", version: "1.0.0" },
    ],
    untypedPackageErrors: [error(1), error(2), error(3)],
  });
  assert.ok(
    result.endsWith(
      "## Compilation\n\n- `src/a.ts`:3 TS2322: Bad.\n- TS1: x\n\nChecked against the published types of `b@2.0.0`, `a@1.0.0`.\n\n" +
        `${uncounted(3)}\n`,
    ),
    result,
  );
});

// The new fields are read only by renderBoundaryMarkdown: the readiness, the
// summary and the public surface stay what they are without them.
test("[happy-13] only the boundary markdown changes with the new fields; readiness, summary and public surface ignore them", () => {
  const plain: CompilationResult = {
    attempted: true,
    ok: false,
    diagnostics: [{ file: "src/a.ts", line: 3, code: "TS2322", message: "Bad." }],
    shimmedPackages: ["pg"],
  };
  const widened: CompilationResult = {
    ...plain,
    typedPackages: [{ name: "zod", version: "3.22.4" }],
    untypedPackageErrors: [error(0)],
  };
  assert.deepEqual(sliceReadiness(contractWith(widened)), sliceReadiness(contractWith(plain)));
  assert.deepEqual(
    boundarySummary(contractWith(widened), manifest),
    boundarySummary(contractWith(plain), manifest),
  );
  assert.equal(
    renderPublicSurfaceMarkdown(contractWith(widened)),
    renderPublicSurfaceMarkdown(contractWith(plain)),
  );
  assert.equal(
    render(widened),
    `${render(plain)}\nChecked against the published types of \`zod@3.22.4\`.\n\n${uncounted(1)}\n`,
  );
});

// Extends "[boundary-12] untyped-package errors are counted, not listed,
// after a failed compilation's list": a longer list and more errors, whose
// codes and messages also appear nowhere.
test("[boundary-12] many uncounted errors after a longer failed list are counted once, never listed", () => {
  const errors = Array.from({ length: 7 }, (_, index) => error(index));
  const result = render({
    attempted: true,
    ok: false,
    diagnostics: [
      { file: "src/a.ts", line: 3, code: "TS2322", message: "Bad." },
      { file: "src/c.ts", line: null, code: "TS2554", message: "Arity." },
      { file: null, line: null, code: "TS1", message: "x" },
    ],
    shimmedPackages: [],
    untypedPackageErrors: errors,
  });
  assert.ok(
    result.endsWith(
      `## Compilation\n\n- \`src/a.ts\`:3 TS2322: Bad.\n- \`src/c.ts\` TS2554: Arity.\n- TS1: x\n\n${uncounted(7)}\n`,
    ),
    result,
  );
  assert.equal(result.split("more errors").length, 2);
  for (const item of errors) {
    assert.equal(result.includes(item.code), false, item.code);
    assert.equal(result.includes(item.message), false, item.message);
  }
});

// The uncounted errors are counted whatever they are: errors identical to the
// failed list's own are still counted, not merged with it.
test("[boundary-12] uncounted errors equal to the listed ones are still counted separately", () => {
  const listed = { file: "src/a.ts", line: 3, code: "TS2322", message: "Bad." };
  const result = render({
    attempted: true,
    ok: false,
    diagnostics: [listed],
    shimmedPackages: [],
    untypedPackageErrors: [listed, listed],
  });
  assert.ok(
    result.endsWith(`## Compilation\n\n- \`src/a.ts\`:3 TS2322: Bad.\n\n${uncounted(2)}\n`),
    result,
  );
  assert.equal(result.split("TS2322").length, 2);
});

// Extends "[boundary-13] absent or empty new fields render as before": one
// field empty and the other not. An empty field adds nothing; the other adds
// only its own line.
test("[boundary-13] an empty field adds nothing while the other field still adds its line", () => {
  const ok: CompilationResult = {
    attempted: true,
    ok: true,
    diagnostics: [],
    shimmedPackages: ["pg"],
  };
  const plain = render(ok);
  assert.equal(
    render({ ...ok, typedPackages: [], untypedPackageErrors: [error(0), error(1)] }),
    `${plain}\n${uncounted(2)}\n`,
  );
  assert.equal(
    render({ ...ok, typedPackages: [{ name: "zod", version: "3.22.4" }], untypedPackageErrors: [] }),
    `${plain}\nChecked against the published types of \`zod@3.22.4\`.\n`,
  );
  for (const result of [
    render({ ...ok, typedPackages: [] }),
    render({ ...ok, untypedPackageErrors: [] }),
    render({ ...ok, typedPackages: [], untypedPackageErrors: [] }),
  ]) {
    assert.equal(result, plain);
    assert.equal(result.includes("Checked against the published types"), false);
    assert.equal(result.includes("not counted"), false);
  }
});

// Extends "[boundary-13]" for a failed and an unattempted compilation: empty
// fields leave each as it was, while a non-empty one still shows.
test("[boundary-13] empty fields leave failed and unattempted sections as they were, beside non-empty ones", () => {
  const failed: CompilationResult = {
    attempted: true,
    ok: false,
    diagnostics: [{ file: "src/a.ts", line: 3, code: "TS2322", message: "Bad." }],
    shimmedPackages: [],
  };
  const skipped: CompilationResult = {
    attempted: false,
    ok: false,
    diagnostics: [],
    shimmedPackages: [],
  };
  for (const compilation of [failed, skipped]) {
    const plain = render(compilation);
    assert.equal(render({ ...compilation, typedPackages: [], untypedPackageErrors: [] }), plain);
    assert.equal(
      render({ ...compilation, typedPackages: [{ name: "pg", version: "8.11.3" }], untypedPackageErrors: [] }),
      `${plain}\nChecked against the published types of \`pg@8.11.3\`.\n`,
    );
  }
});

// Extends "[boundary-14] typed packages are named even when no compilation was
// attempted": several typed packages and uncounted errors too.
test("[boundary-14] with no compilation attempted, several typed packages are named and the errors counted", () => {
  const result = render({
    attempted: false,
    ok: false,
    diagnostics: [],
    shimmedPackages: ["pg"],
    typedPackages: [
      { name: "zod", version: "3.22.4" },
      { name: "@types/x", version: "1.0.0" },
      { name: "pg", version: "8.11.3" },
    ],
    untypedPackageErrors: [error(0), error(1)],
  });
  assert.ok(
    result.endsWith(
      "## Compilation\n\nNo compilation was attempted for this language.\n\nChecked against the published types of `zod@3.22.4`, `@types/x@1.0.0`, `pg@8.11.3`.\n\n" +
        `${uncounted(2)}\n`,
    ),
    result,
  );
});

// The shortcut: write the typed line only on the attempted branches. Even
// with ok true but attempted false, the unattempted text and the typed line
// both show.
test("[boundary-14] an unattempted compilation that says ok still says so, then names its typed package", () => {
  const result = render({
    attempted: false,
    ok: true,
    diagnostics: [],
    shimmedPackages: [],
    typedPackages: [{ name: "lodash", version: "4.17.21" }],
  });
  assert.ok(
    result.endsWith(
      "## Compilation\n\nNo compilation was attempted for this language.\n\nChecked against the published types of `lodash@4.17.21`.\n",
    ),
    result,
  );
});
