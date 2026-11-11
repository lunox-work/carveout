/**
 * Ported from sandbox-factory's packages/core/test with the modules it tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emailNames,
  organizationNames,
  privatePackageNames,
  termWords,
  vocabularyBlockers,
  vocabularyLeaks,
  workspaceVocabulary,
} from "../src/pseudonyms/index.js";

test("a name's words split at separators and case changes", () => {
  assert.deepEqual(termWords("sandbox-factory"), ["sandbox", "factory"]);
  assert.deepEqual(termWords("acmeOrders"), ["acme", "orders"]);
  assert.deepEqual(termWords("XMLParser"), ["xml", "parser"]);
  assert.deepEqual(termWords("web3Labs"), ["web3", "labs"]);
  assert.deepEqual(termWords("  Lunox Work "), ["lunox", "work"]);
  assert.deepEqual(termWords("--"), []);
});

test("the vocabulary drops short, generic and repeated names", () => {
  assert.deepEqual(
    workspaceVocabulary([
      "lunox-work",
      "Lunox Work",
      "sandbox-factory",
      "api",
      "monorepo",
      "web-app",
      "core-platform",
      "abc",
      "",
      "Feversoul",
    ]),
    ["lunox-work", "sandbox-factory", "feversoul"],
  );
});

test("a name is found whatever joins its words", () => {
  const leaks = vocabularyLeaks(
    [
      { path: "src/a.ts", text: "const sandboxFactory = 1;" },
      { path: "src/b.ts", text: "SANDBOX_FACTORY and sandbox factory" },
      { path: "src/sandbox-factory/c.ts", text: "" },
      { path: "src/d.ts", text: "nothing here" },
    ],
    ["sandbox-factory"],
  );
  assert.deepEqual(leaks, [
    {
      term: "sandbox-factory",
      occurrences: 4,
      files: ["src/a.ts", "src/b.ts", "src/sandbox-factory/c.ts"],
    },
  ]);
});

test("a match starts and ends on a word boundary", () => {
  const count = (text: string) =>
    vocabularyLeaks([{ path: "x.ts", text }], ["acme"])[0]?.occurrences ?? 0;
  assert.equal(count("acme"), 1);
  assert.equal(count("acmeOrders"), 1);
  assert.equal(count("MyAcme"), 1);
  assert.equal(count("ACME_KEY"), 1);
  assert.equal(count("acme2"), 1);
  assert.equal(count("acmes"), 0);
  assert.equal(count("pacme"), 0);
  assert.equal(count("ACMEs"), 0);
  assert.equal(count("Acmes"), 0);
  // A run of capitals ends a word at its last one before a lowercase.
  assert.equal(count("ACMEOrders"), 1);
  assert.equal(count("XMLAcme"), 1);
  assert.equal(count("PACME"), 0);
  assert.equal(count("ACMEs"), 0);
});

test("an organization's distinctive words are terms of their own", () => {
  const vocabulary = workspaceVocabulary([
    ...organizationNames(["Acme Corp", "acme-corp", "Payflow Labs"]),
    "billing-service",
  ]);
  assert.deepEqual(vocabulary, [
    "acme-corp",
    "acme",
    "payflow-labs",
    "payflow",
    "billing-service",
  ]);
  const count = (text: string) =>
    vocabularyLeaks([{ path: "x.ts", text }], vocabulary)
      .map((leak) => `${leak.term}:${leak.occurrences}`)
      .join(" ");
  assert.equal(count('import { post } from "@acme/ledger";'), "acme:1");
  assert.equal(count("const acmeOrders = AcmeOrders.load();"), "acme:2");
  assert.equal(count("process.env.ACME_ORDERS"), "acme:1");
  assert.equal(count("new PayflowClient()"), "payflow:1");
  // Generic and short words stay out, and other names stay whole.
  assert.equal(count("const corp = labs; billing.run(); service()"), "");
  assert.equal(count("acmes and payflows"), "");
  assert.deepEqual(
    workspaceVocabulary(organizationNames(["Open Source Labs", "Big Co"])),
    ["open-source-labs", "big-co"],
  );
});

test("an organization's everyday words are scanned only as its whole name", () => {
  const vocabulary = workspaceVocabulary(
    organizationNames([
      "First Choice Logistics",
      "Blue Harbor Inc",
      "PT Nusantara Tbk",
      "Acme LLC",
      "Zentrix Ltd",
    ]),
  );
  assert.deepEqual(vocabulary, [
    "first-choice-logistics",
    "blue-harbor-inc",
    "pt-nusantara-tbk",
    "nusantara",
    "acme-llc",
    "acme",
    "zentrix-ltd",
    "zentrix",
  ]);
  const count = (text: string) =>
    vocabularyLeaks([{ path: "x.ts", text }], vocabulary)
      .map((leak) => `${leak.term}:${leak.occurrences}`)
      .join(" ");
  assert.equal(
    count("user.firstName; choice(); blueButton; harbor.dock(); Inc.run()"),
    "",
  );
  assert.equal(count("const blueHarbor = firstChoice;"), "");
  assert.equal(
    count("FIRST_CHOICE_LOGISTICS and blue-harbor-inc"),
    "first-choice-logistics:1 blue-harbor-inc:1",
  );
  assert.equal(count("new ZentrixClient(); acmeOrders"), "acme:1 zentrix:1");
});

test("a private package gives its scope, or its whole name if unscoped", () => {
  const evidence = { source: "private" as const, evidence: ".npmrc" };
  const pkg = (name: string) => ({ name, version: null, declaredIn: null });
  const names = privatePackageNames([
    { ...pkg("@acmeinc/ledger"), workspace: true },
    { ...pkg("@payflow/core"), registry: evidence },
    { ...pkg("payflow-sdk"), registry: evidence },
    { ...pkg("@repo/ui"), workspace: true },
    { ...pkg("@internal/billing"), workspace: true },
    { ...pkg("logger"), workspace: true },
    // Mocked by default or installed, a public name names no one.
    pkg("lodash"),
    { ...pkg("@lunox/public"), registry: { ...evidence, source: "public" } },
  ]);
  assert.deepEqual(names, [
    { name: "acmeinc", kind: "organization" },
    { name: "payflow", kind: "organization" },
    { name: "payflow-sdk", kind: "name" },
    { name: "repo", kind: "organization" },
    { name: "internal", kind: "organization" },
  ]);
  const vocabulary = workspaceVocabulary(names);
  assert.deepEqual(vocabulary, ["acmeinc", "payflow", "payflow-sdk"]);
  const count = (text: string) =>
    vocabularyLeaks([{ path: "x.ts", text }], vocabulary)
      .map((leak) => `${leak.term}:${leak.occurrences}`)
      .join(" ");
  assert.equal(count('import { post } from "@acmeinc/ledger";'), "acmeinc:1");
  assert.equal(
    count('"@payflow/core": "file:mocks/@payflow/core"'),
    "payflow:2",
  );
  assert.equal(count("const ledger = logger(billing, ui);"), "");
});

test("a name or word without a letter is not a term, nor found inside a number", () => {
  assert.deepEqual(
    workspaceVocabulary([
      "12345",
      "2024-01",
      ...organizationNames(["4242 Holdings", "Web3 Studio"]),
    ]),
    ["4242-holdings", "web3-studio", "web3"],
  );
  const count = (text: string, term: string) =>
    vocabularyLeaks([{ path: "x.ts", text }], [term])[0]?.occurrences ?? 0;
  assert.equal(count("web3 web3Labs web30 aweb3", "web3"), 2);
  assert.equal(count("id 9912345 12345678", "12345"), 0);
  assert.equal(count("v12345 #12345 (12345)", "12345"), 2);
});

test("an author's address names them, and their organization unless public", () => {
  assert.deepEqual(emailNames("jane.doe+pkg@acmecorp.io"), [
    { name: "jane.doe", kind: "name" },
    { name: "acmecorp.io", kind: "organization" },
  ]);
  assert.deepEqual(emailNames("payflow.dev@Gmail.com"), [
    { name: "payflow.dev", kind: "name" },
  ]);
  assert.deepEqual(emailNames("12345+octocat@users.noreply.github.com"), [
    { name: "octocat", kind: "name" },
  ]);
  assert.deepEqual(emailNames("octocat@users.noreply.github.com"), [
    { name: "octocat", kind: "name" },
  ]);
  assert.deepEqual(emailNames("12345@acmecorp.io"), [
    { name: "acmecorp.io", kind: "organization" },
  ]);
  for (const role of ["support", "Info", "no-reply", "noreply", "dev", "team"])
    assert.deepEqual(emailNames(`${role}@acmecorp.io`), [
      { name: "acmecorp.io", kind: "organization" },
    ]);
  assert.deepEqual(emailNames("engineering+npm@gmail.com"), []);
  assert.deepEqual(emailNames("no-address"), []);
  assert.deepEqual(emailNames("@acme.io"), []);
  assert.deepEqual(workspaceVocabulary(emailNames("jane.doe@acmecorp.io")), [
    "jane-doe",
    "acmecorp-io",
    "acmecorp",
  ]);
});

test("non-Latin letters are words too", () => {
  assert.deepEqual(workspaceVocabulary(["Ångström Labs"]), ["ångström-labs"]);
  const leaks = vocabularyLeaks(
    [{ path: "x.ts", text: "// ÅngströmLabs" }],
    ["ångström-labs"],
  );
  assert.equal(leaks[0]?.occurrences, 1);
});

test("no leak, no blocker", () => {
  assert.deepEqual(
    vocabularyLeaks([{ path: "a.ts", text: "orders" }], ["acme"]),
    [],
  );
  assert.deepEqual(vocabularyBlockers([]), []);
});

test("a leak blocks, naming its first files", () => {
  assert.deepEqual(
    vocabularyBlockers([
      { term: "acme", occurrences: 1, files: ["a.ts"] },
      {
        term: "lunox-work",
        occurrences: 9,
        files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"],
      },
    ]),
    [
      {
        code: "vocabulary_leaked",
        file: "a.ts",
        detail:
          '"acme" names the workspace and appears 1 time in 1 public file: a.ts. Give it a pseudonym.',
      },
      {
        code: "vocabulary_leaked",
        file: "a.ts",
        detail:
          '"lunox-work" names the workspace and appears 9 times in 7 public files: a.ts, b.ts, c.ts, d.ts, e.ts, and 2 more. Give it a pseudonym.',
      },
    ],
  );
  assert.equal(
    vocabularyBlockers([{ term: "acme", occurrences: 1, files: [] }])[0]?.file,
    null,
  );
});
