import assert from "node:assert/strict";
import { test } from "node:test";

import { contextDocuments } from "../../src/sources.js";

/** The listing the ranking scenarios share. */
const LISTING = [
  { path: "src/index.ts", size: 900 },
  { path: "packages/api/README.md", size: 1500 },
  { path: "docs/billing/invoices.md", size: 3000 },
  { path: "docs/setup.md", size: 2000 },
  { path: "CONTRIBUTING.md", size: 1200 },
  { path: "CHANGELOG.md", size: 50000 },
  { path: "node_modules/x/README.md", size: 100 },
  { path: "docs/empty.md", size: 0 },
  { path: "docs/huge.md", size: 300000 },
  { path: "README.md", size: 4000 },
];

/** Each path as a file of size 100. */
function sized(paths: readonly string[]): { path: string; size: number }[] {
  return paths.map((path) => ({ path, size: 100 }));
}

/** Twelve documents of every tier, in rank order. */
const MIXED = [
  "README.md",
  "readme.mdx",
  "AGENTS.md",
  "CLAUDE.md",
  "adr/0002.md",
  "docs/a.md",
  "Documentation/guide/b.md",
  "./README.md",
  "test/README.md",
  "GUIDE.md",
  "README.ja.md",
  "src/notes/x.md",
];

const SKIPPED = [
  "node_modules",
  "bower_components",
  "vendor",
  "third_party",
  "Pods",
  ".venv",
  "venv",
  "dist",
  "build",
  "out",
  "target",
  "fixtures",
  "__fixtures__",
  "testdata",
  "examples",
  "example",
];

const BOILERPLATE = [
  "changelog",
  "changes",
  "history",
  "license",
  "licence",
  "copying",
  "code_of_conduct",
  "security",
  "notice",
  "authors",
  "contributors",
  "codeowners",
];

// Extends "[happy-4] which files count as documents".
test("[happy-4] any Markdown ending in any case counts, under hidden, test or differently-cased skipped directories", () => {
  for (const path of [
    "Guide.Md",
    "notes.MDX",
    "docs/Intro.MarkDown",
    ".hidden/notes.md",
    "tests/README.md",
    "Node_Modules/x.md",
    "pods/notes.md",
    "Build/notes.md",
    "DIST/a.md",
    "Examples/a.md",
    ".GitHub/README.md",
    "github/README.md",
    ".github.md",
    "docs/build.md",
    "examples.md",
  ]) {
    assert.deepEqual(
      contextDocuments([{ path, size: 100 }]),
      { paths: [path], omitted: 0 },
      path,
    );
  }
});

// Extends "[happy-4] a skipped directory's name as a file name, and a deep path, still count".
test("[happy-4] a stem that only starts or ends like boilerplate still counts", () => {
  for (const path of [
    "changelog.ja.md",
    "CHANGELOG-2024.md",
    "my-license.md",
    "docs/security-model.md",
    "authorship.md",
    "notices/a.md",
    "history/2024.md",
  ]) {
    assert.deepEqual(
      contextDocuments([{ path, size: 100 }]),
      { paths: [path], omitted: 0 },
      path,
    );
  }
});

// Extends "[happy-4] which files count as documents".
test("[happy-4] paths are returned as given, a path listed twice is returned twice", () => {
  assert.deepEqual(
    contextDocuments(sized(["./docs/a.md", "docs/a.md", "docs/a.md"])),
    { paths: ["docs/a.md", "docs/a.md", "./docs/a.md"], omitted: 0 },
  );
});

// Extends "[unhappy-1] code, other text and excluded files are not documents".
test("[unhappy-1] every skipped directory at any depth excludes its files", () => {
  for (const directory of SKIPPED) {
    for (const path of [
      `${directory}/README.md`,
      `pkg/${directory}/notes.md`,
      `a/b/${directory}/c/guide.mdx`,
    ]) {
      assert.deepEqual(
        contextDocuments([{ path, size: 100 }]),
        { paths: [], omitted: 0 },
        path,
      );
    }
  }
});

// Extends "[unhappy-1] exclusions apply at any depth and boilerplate stems ignore case".
test("[unhappy-1] every boilerplate stem is excluded with any Markdown ending, in any case, at any depth", () => {
  for (const stem of BOILERPLATE) {
    for (const path of [
      `${stem.toUpperCase()}.md`,
      `docs/${stem}.mdx`,
      `a/b/${stem[0]!.toUpperCase()}${stem.slice(1)}.MARKDOWN`,
    ]) {
      assert.deepEqual(
        contextDocuments([{ path, size: 100 }]),
        { paths: [], omitted: 0 },
        path,
      );
    }
  }
});

// Extends "[unhappy-1] code, other text and excluded files are not documents".
test("[unhappy-1] .github at any depth and endings that only resemble Markdown are excluded", () => {
  for (const path of [
    ".github/README.md",
    "a/b/.github/ISSUE_TEMPLATE/bug.md",
    "notes.rmd",
    "notes.amd",
    "README.mdown",
    "README.mkd",
    "README.markdown.txt",
    "README.md~",
    "guide.mdxx",
  ]) {
    assert.deepEqual(
      contextDocuments([{ path, size: 100 }]),
      { paths: [], omitted: 0 },
      path,
    );
  }
});

// Extends "[unhappy-1] code, other text and excluded files are not documents".
test("[unhappy-1] excluded files among documents are neither returned nor counted", () => {
  const files = sized([
    "src/app.ts",
    "docs/a.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "LICENSE.md",
    "vendor/x/README.md",
    "README.md",
    "docs/logo.svg",
  ]);
  assert.deepEqual(contextDocuments(files, ["readme", "license", "github"]), {
    paths: ["README.md", "docs/a.md"],
    omitted: 0,
  });
});

// Extends "[boundary-2] the size limit".
test("[boundary-2] sizes around both limits among several documents", () => {
  const files = [
    { path: "docs/s1.md", size: 262143 },
    { path: "docs/s2.md", size: 262144 },
    { path: "docs/s3.md", size: 262145 },
    { path: "docs/s4.md", size: 1e9 },
    { path: "docs/s5.md", size: Number.MIN_VALUE },
    { path: "docs/s6.md", size: -0 },
    { path: "docs/s7.md", size: Number.NaN },
    { path: "docs/s8.md", size: Number.NEGATIVE_INFINITY },
    { path: "docs/s9.md", size: 2 },
  ];
  assert.deepEqual(contextDocuments(files), {
    paths: ["docs/s1.md", "docs/s2.md", "docs/s5.md", "docs/s9.md"],
    omitted: 0,
  });
});

// Extends "[boundary-2] a size just above 0 is read, one just above the cap or below zero is not".
test("[boundary-2] a root README of unusable size is ignored and does not count toward the cap", () => {
  for (const size of [0, 262145, Number.NaN, Number.POSITIVE_INFINITY]) {
    const files = [
      { path: "README.md", size },
      ...sized(
        Array.from({ length: 13 }, (_, index) => `docs/b${String(index).padStart(2, "0")}.md`),
      ),
    ];
    const result = contextDocuments(files);
    assert.equal(result.paths.includes("README.md"), false, String(size));
    assert.equal(result.paths.length, 12, String(size));
    assert.equal(result.omitted, 1, String(size));
  }
});

// Extends "[boundary-3] documents past the count cap are counted, not returned".
test("[boundary-3] thirty documents keep the twelve best ranked and count eighteen", () => {
  const docs = Array.from(
    { length: 25 },
    (_, index) => `docs/a${String(index + 1).padStart(2, "0")}.md`,
  );
  const files = sized([
    "zz/notes.md",
    ...docs.slice(12),
    "pkg/README.md",
    ...docs.slice(0, 12),
    "GUIDE.md",
    "CONTRIBUTING.md",
    "README.md",
  ]).reverse();
  assert.deepEqual(contextDocuments(files), {
    paths: ["README.md", "CONTRIBUTING.md", ...docs.slice(0, 10)],
    omitted: 18,
  });
  assert.deepEqual(contextDocuments(files, ["a25"]), {
    paths: [
      "README.md",
      "docs/a25.md",
      "CONTRIBUTING.md",
      ...docs.slice(0, 9),
    ],
    omitted: 18,
  });
});

// Extends "[boundary-3] one past the cap is omitted, and ignored files never count as omitted".
test("[boundary-3] duplicated paths count toward the cap and toward omitted", () => {
  const files = sized(Array.from({ length: 14 }, () => "docs/same.md"));
  assert.deepEqual(contextDocuments(files), {
    paths: Array.from({ length: 12 }, () => "docs/same.md"),
    omitted: 2,
  });
});

// Extends "[boundary-4] exactly CONTEXT_DOCUMENTS_MAX documents are all returned".
test("[boundary-4] twelve documents of mixed tiers and depths are all returned", () => {
  const result = contextDocuments(sized([...MIXED].reverse()), ["guide"]);
  assert.equal(result.paths.length, 12);
  assert.equal(result.omitted, 0);
  assert.deepEqual([...result.paths].sort(), [...MIXED].sort());
});

// Extends "[unhappy-2] a listing of only code, excluded and unusable files returns nothing".
test("[unhappy-2] a listing with no documents returns nothing whatever the keywords", () => {
  const files = [
    ...sized([
      "index.js",
      ".github/README.md",
      "SECURITY.md",
      "dist/README.md",
      "README",
      "docs/guide.rst",
    ]),
    { path: "docs/guide.md", size: Number.NaN },
    { path: "README.md", size: -10 },
  ];
  for (const keywords of [[], ["readme"], ["guide", "security", "github"]]) {
    assert.deepEqual(
      contextDocuments(files, keywords),
      { paths: [], omitted: 0 },
      JSON.stringify(keywords),
    );
  }
  assert.deepEqual(contextDocuments([], ["readme"]), { paths: [], omitted: 0 });
});

// Extends "[happy-5] without keywords the root README leads, then root guides, then docs, then other READMEs".
test("[happy-5] every root guide leads every docs file, docs files lead other READMEs whatever their depth", () => {
  const ranked = [
    "README.md",
    "Conventions.markdown",
    "DEVELOPMENT.md",
    "OVERVIEW.md",
    "design.mdx",
    "docs/CONTRIBUTING.md",
    "packages/web/docs/deep/guide.md",
    "a/README.md",
    "ROADMAP.md",
    "packages/x/ARCHITECTURE.md",
  ];
  const files = sized([
    "ROADMAP.md",
    "packages/web/docs/deep/guide.md",
    "a/README.md",
    "design.mdx",
    "README.md",
    "packages/x/ARCHITECTURE.md",
    "OVERVIEW.md",
    "docs/CONTRIBUTING.md",
    "DEVELOPMENT.md",
    "Conventions.markdown",
  ]);
  assert.deepEqual(contextDocuments(files), { paths: ranked, omitted: 0 });
});

// Extends "[happy-5] without keywords the root README leads, then root guides, then docs, then other READMEs".
test("[happy-5] docs directories and READMEs are recognized in any case", () => {
  const files = sized([
    "x/readme.MDX",
    "documentation/d.md",
    "adr/e.md",
    "Docs/c.md",
    "DOC/a.md",
    "ADRS/b.md",
    "Readme.markdown",
  ]);
  assert.deepEqual(contextDocuments(files, []), {
    paths: [
      "Readme.markdown",
      "ADRS/b.md",
      "DOC/a.md",
      "Docs/c.md",
      "adr/e.md",
      "documentation/d.md",
      "x/readme.MDX",
    ],
    omitted: 0,
  });
});

// Extends "[happy-6] a path matching a keyword moves ahead of the tier above its own".
test("[happy-6] a matched root guide moves ahead of an unmatched root guide", () => {
  const files = sized([
    "docs/setup.md",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
    "README.md",
  ]);
  assert.deepEqual(contextDocuments(files, []).paths, [
    "README.md",
    "ARCHITECTURE.md",
    "CONTRIBUTING.md",
    "docs/setup.md",
  ]);
  assert.deepEqual(contextDocuments(files, ["contributing"]).paths, [
    "README.md",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
    "docs/setup.md",
  ]);
});

// Extends "[happy-6] a path matching a keyword moves ahead of the tier above its own".
test("[happy-6] a matched root guide and a matched docs file share a rank, the shallower first", () => {
  assert.deepEqual(contextDocuments(LISTING, ["setup", "contributing"]).paths, [
    "README.md",
    "CONTRIBUTING.md",
    "docs/setup.md",
    "docs/billing/invoices.md",
    "packages/api/README.md",
  ]);
  assert.deepEqual(contextDocuments(LISTING, ["invoices", "contributing"]).paths, [
    "README.md",
    "CONTRIBUTING.md",
    "docs/billing/invoices.md",
    "docs/setup.md",
    "packages/api/README.md",
  ]);
});

// Extends "[happy-6] a keyword is not trimmed before it is matched".
test("[happy-6] keywords match the lower-cased path anywhere, but are not lower-cased themselves", () => {
  const files = sized(["AGENTS.md", "ARCHITECTURE.md", "README.md"]);
  assert.deepEqual(contextDocuments(files, ["architecture"]).paths, [
    "README.md",
    "ARCHITECTURE.md",
    "AGENTS.md",
  ]);
  assert.deepEqual(contextDocuments(files, ["ARCHITECTURE"]).paths, [
    "README.md",
    "AGENTS.md",
    "ARCHITECTURE.md",
  ]);
  assert.deepEqual(
    contextDocuments(LISTING, ["api/readme"]).paths,
    contextDocuments(LISTING, ["api"]).paths,
  );
  assert.deepEqual(contextDocuments(LISTING, ["API/README"]).paths, [
    "README.md",
    "CONTRIBUTING.md",
    "docs/setup.md",
    "docs/billing/invoices.md",
    "packages/api/README.md",
  ]);
});

// Extends "[happy-6] a path matching a keyword moves ahead of the tier above its own".
test("[happy-6] a matched other file moves ahead of other READMEs but stays behind docs", () => {
  const files = sized([
    "GUIDE.md",
    "src/billing.md",
    "pkg/README.md",
    "docs/z.md",
    "README.md",
  ]);
  assert.deepEqual(contextDocuments(files, ["billing"]).paths, [
    "README.md",
    "docs/z.md",
    "src/billing.md",
    "pkg/README.md",
    "GUIDE.md",
  ]);
});

// Extends "[boundary-5] matching more keywords does not rank a document higher than matching one".
test("[boundary-5] a path matching every keyword ranks with one matching a single keyword", () => {
  const files = sized([
    "src/billing-invoices-export.md",
    "docs/zzz.md",
    "docs/z-billing-invoices-export.md",
    "docs/a-billing.md",
  ]);
  assert.deepEqual(contextDocuments(files, ["billing", "invoices", "export"]).paths, [
    "docs/a-billing.md",
    "docs/z-billing-invoices-export.md",
    "docs/zzz.md",
    "src/billing-invoices-export.md",
  ]);
});

// Extends "[boundary-6] ranking does not depend on the order of the listing".
test("[boundary-6] every rotation of a listing past the cap gives the same result", () => {
  const listing = [
    ...sized(MIXED),
    ...sized(["docs/x.md", "pkg/notes.md", "zeta.md"]),
    { path: "src/main.ts", size: 10 },
    { path: "CHANGELOG.md", size: 10 },
  ];
  for (const keywords of [[], ["notes"], ["guide", "zeta"]]) {
    const expected = contextDocuments(listing, keywords);
    assert.equal(expected.paths.length, 12);
    assert.equal(expected.omitted, 3);
    for (let shift = 1; shift < listing.length; shift++) {
      const rotated = [...listing.slice(shift), ...listing.slice(0, shift)];
      assert.deepEqual(
        contextDocuments(rotated, keywords),
        expected,
        `${JSON.stringify(keywords)} ${shift}`,
      );
    }
    assert.deepEqual(
      contextDocuments([...listing].reverse(), keywords),
      expected,
      JSON.stringify(keywords),
    );
  }
});

// Extends "[boundary-7] every tier, with and without a match".
test("[boundary-7] only a root README is tier 0, only root guides tier 1, and READMEs elsewhere tier 3", () => {
  assert.deepEqual(contextDocuments(sized([...MIXED].reverse())), {
    paths: MIXED,
    omitted: 0,
  });
});

// Extends "[boundary-7] every tier, with and without a match".
test("[boundary-7] each tier lifted by a match lands in its place, never ahead of the root README", () => {
  const files = sized([
    "a.md",
    "pay.md",
    "a/README.md",
    "pay/README.md",
    "docs/a.md",
    "docs/pay.md",
    "DESIGN.md",
    "OVERVIEW.md",
    "README.md",
  ]);
  assert.deepEqual(contextDocuments(files, ["overview", "pay"]).paths, [
    "README.md",
    "OVERVIEW.md",
    "docs/pay.md",
    "DESIGN.md",
    "pay/README.md",
    "docs/a.md",
    "pay.md",
    "a/README.md",
    "a.md",
  ]);
});

// Extends "[boundary-7] within one tier the shallowest leads, then code-point path order".
test("[boundary-7] paths of one rank and depth sort by code point, not by locale", () => {
  const files = sized([
    "docs/é.md",
    "docs/z.md",
    "docs/a_b.md",
    "docs/a.md",
    "docs/a-b.md",
    "docs/a b.md",
    "docs/Z.md",
  ]);
  assert.deepEqual(contextDocuments(files).paths, [
    "docs/Z.md",
    "docs/a b.md",
    "docs/a-b.md",
    "docs/a.md",
    "docs/a_b.md",
    "docs/z.md",
    "docs/é.md",
  ]);
});
