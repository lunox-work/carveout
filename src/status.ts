/**
 * `carveout status`: whether a cut folder still matches its repository.
 *
 * The cut is made again in memory, with the request `carveout.json`
 * records, against the repository as it stands (HEAD and the working
 * tree), and every file it would write is compared with what the folder's
 * record says was written. The folder is current when no file would differ;
 * otherwise each difference is named with its cause: a slice file that
 * changed, a cut module whose declarations changed (by symbol), a file the
 * walk now reaches or no longer reaches, or generated configuration. A
 * change to a cut module's bodies alone leaves its stub, and so the
 * folder, as it was. The lockfile the cut resolved from the registry is not
 * compared: it is the registry's answer, not the repository's.
 *
 * Nothing is written; the package types a cut reads come from the cache
 * when the set is the same.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { computeCut, readRecord, type CarveoutRecord } from "./carve.js";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

export type StaleCause =
  | "source_changed"
  | "source_added"
  | "source_removed"
  | "stub_changed"
  | "stub_added"
  | "stub_removed"
  | "surface_changed"
  | "generated_changed"
  | "cut_failed";

export interface StaleItem {
  readonly cause: StaleCause;
  readonly path: string | null;
  readonly detail: string;
}

export interface Status {
  readonly current: boolean;
  readonly stale: readonly StaleItem[];
  /** Resolution inputs that changed, whatever they did to the cut. */
  readonly inputsChanged: readonly string[];
  /** Files outside the slice that import it now and did not, or the reverse. */
  readonly importers: { readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly commit: string | null;
}

/** Each exported name a declaration file declares, with its text. */
export function declaredSymbols(text: string): Map<string, string> {
  const source = ts.createSourceFile("s.d.ts", text, ts.ScriptTarget.Latest, true);
  const symbols = new Map<string, string>();
  const put = (name: string, statement: ts.Node) => {
    const text = statement.getText(source).replace(/\s+/g, " ").trim();
    symbols.set(name, symbols.has(name) ? `${symbols.get(name)}\n${text}` : text);
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const from = statement.moduleSpecifier?.getText(source) ?? "";
      if (statement.exportClause === undefined) put(`* from ${from}`, statement);
      else if (ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements)
          put(element.name.text, statement);
      else put(`* as ${statement.exportClause.name.text}`, statement);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      put("default", statement);
      continue;
    }
    const named = (
      statement as ts.Statement & { name?: ts.Identifier | ts.StringLiteral }
    ).name;
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) put(declaration.name.text, statement);
    if (named !== undefined && (ts.isIdentifier(named) || ts.isStringLiteral(named)))
      put(named.text, statement);
    // Unexported helpers a stub keeps for its exports' types.
  }
  return symbols;
}

/** Symbols added, removed and changed between two versions of a stub. */
export function symbolDiff(before: string, after: string): string {
  const old = declaredSymbols(before);
  const now = declaredSymbols(after);
  const added = [...now.keys()].filter((name) => !old.has(name)).sort(compare);
  const removed = [...old.keys()].filter((name) => !now.has(name)).sort(compare);
  const changed = [...now.keys()]
    .filter((name) => old.has(name) && old.get(name) !== now.get(name))
    .sort(compare);
  const parts = [
    added.length > 0 ? `added ${added.join(", ")}` : "",
    removed.length > 0 ? `removed ${removed.join(", ")}` : "",
    changed.length > 0 ? `changed ${changed.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length === 0 ? "its declarations moved or were reformatted" : parts.join("; ");
}

/** The stub path a module's runtime or declaration file belongs to. */
const stubOf = (path: string) =>
  path.replace(/\.d\.([cm]?)ts$/, ".$1js");

export async function statusProject(
  dir: string,
  options: { readonly repo?: string } = {},
): Promise<Status> {
  const root = resolve(dir);
  const record: CarveoutRecord = readRecord(root);
  const repo = resolve(options.repo ?? record.repo);
  const request = record.request;
  let fresh;
  try {
    fresh = await computeCut({
      repo,
      entryPoints: request.entryPoints,
      budget: request.budget,
      choices: request.choices,
      offline: request.offline,
      widenLiterals: request.widenLiterals,
      tests: request.tests === true,
      ...(request.live === undefined ? {} : { live: request.live }),
    });
  } catch (error) {
    return {
      current: false,
      stale: [
        {
          cause: "cut_failed",
          path: null,
          detail: `The cut cannot be made again: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      inputsChanged: [],
      importers: { added: [], removed: [] },
      commit: null,
    };
  }
  // What the folder's record says was written, and what a cut would write.
  const before = new Map<string, { sha: string; kind: "source" | "generated" }>();
  for (const file of record.manifest.included)
    before.set(file.path, { sha: file.sha256, kind: "source" });
  for (const file of record.generated)
    if (file.path !== "package-lock.json")
      before.set(file.path, { sha: file.sha256, kind: "generated" });
  // Slice files by the bytes read, as the record has them; generated files
  // by the text a cut would write.
  const after = new Map<string, { sha: string; kind: "source" | "generated"; text: string | null }>();
  for (const file of fresh.record.manifest.included)
    after.set(file.path, { sha: file.sha256, kind: "source", text: null });
  for (const file of fresh.files)
    if (file.class !== "source")
      after.set(file.path, { sha: sha256(file.text), kind: "generated", text: file.text });
  const stale: StaleItem[] = [];
  const stubModules = new Set(
    [...before.keys(), ...after.keys()].filter((path) => /\.d\.[cm]?ts$/.test(path)),
  );
  const readFolder = (path: string) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(compare)) {
    const was = before.get(path);
    const now = after.get(path);
    if (was !== undefined && now !== undefined && was.sha === now.sha) continue;
    const kind = now?.kind ?? was?.kind ?? "generated";
    if (kind === "source") {
      stale.push(
        was === undefined
          ? { cause: "source_added", path, detail: "The walk now reaches it." }
          : now === undefined
            ? { cause: "source_removed", path, detail: "The walk no longer reaches it." }
            : { cause: "source_changed", path, detail: "It changed in the repository." },
      );
      continue;
    }
    if (stubModules.has(path)) {
      if (was === undefined)
        stale.push({ cause: "stub_added", path, detail: "A module the slice now cuts." });
      else if (now === undefined)
        stale.push({ cause: "stub_removed", path, detail: "A module the slice no longer cuts." });
      else {
        // The folder's copy is the old stub while its hash says so.
        const old = readFolder(path);
        stale.push({
          cause: "stub_changed",
          path,
          detail:
            old !== null && sha256(old) === was.sha && now.text !== null
              ? symbolDiff(old, now.text)
              : "Its declarations changed.",
        });
      }
      continue;
    }
    // A mock follows its stub, which is already named.
    const stub = [...stubModules].find((candidate) => stubOf(candidate) === path);
    if (stub !== undefined && stale.some((item) => item.path === stub)) continue;
    stale.push({
      cause: path === "carveout/contract.json" || path === "BOUNDARY.md" || path.startsWith("carveout/tests/")
        ? "surface_changed"
        : "generated_changed",
      path,
      detail: was === undefined ? "A cut would write it now." : now === undefined ? "A cut would not write it now." : "A cut would write it differently.",
    });
  }
  const inputs = new Map(fresh.record.inputs.map((input) => [input.path, input.sha256]));
  const inputsChanged = [
    ...new Set([...record.inputs.map((input) => input.path), ...inputs.keys()]),
  ]
    .filter(
      (path) =>
        (record.inputs.find((input) => input.path === path)?.sha256 ?? null) !==
        (inputs.get(path) ?? null),
    )
    .sort(compare);
  const importersOf = (cut: Pick<CarveoutRecord, "manifest">) =>
    new Set(cut.manifest.cuts.inbound.map((edge) => edge.from));
  const was = importersOf(record);
  const now = importersOf(fresh.record);
  return {
    current: stale.length === 0,
    stale,
    inputsChanged,
    importers: {
      added: [...now].filter((path) => !was.has(path)).sort(compare),
      removed: [...was].filter((path) => !now.has(path)).sort(compare),
    },
    commit: fresh.record.manifest.sourceCommitSha,
  };
}
