/**
 * The map's names for sharing: every path and the repository's own name in
 * pseudonyms, under the same vocabulary and drafting a public cut uses
 * (`workspaceNames`, `workspaceVocabulary`, `pseudonymize`), with the
 * looser scan a public cut blocks on (`looseLeaks`) run over the result. A
 * path segment the table could not rename is replaced whole, so the share
 * card never holds a name of the repository's.
 */

import { basename, relative } from "node:path";
import { readRepoConfig } from "../carve.js";
import { workspacePackages } from "../extract/compiler-config.js";
import { looseLeaks, pseudonymize, workspaceNames, wordsToFolder } from "../pseudonyms/folder.js";
import { workspaceVocabulary } from "../pseudonyms/vocabulary.js";

export interface ShareNames {
  /** The terms hidden: the repository's names, as a public cut scans for them. */
  readonly vocabulary: readonly string[];
  /** The repository's name in pseudonyms. */
  readonly repo: string;
  /** Each mapped path in pseudonyms, in the order given. */
  readonly paths: readonly string[];
}

/** Whether a text holds any of the terms, read as loosely as a public cut's blocker scan. */
export const leaksIn = (text: string, vocabulary: readonly string[]) =>
  vocabulary.length > 0 && looseLeaks([{ path: "", text }], vocabulary).length > 0;

/** The repository's vocabulary: its packages', its remote's, its owner's and the configuration's names. */
export function repoVocabulary(root: string): string[] {
  const config = readRepoConfig(root);
  const packageDirs = [...workspacePackages(root).values()].map((dir) => relative(root, dir)).filter((dir) => !dir.startsWith(".."));
  const names = workspaceNames(root, packageDirs, [...(config.names ?? [])]);
  const kept = new Set((config.keepNames ?? []).map((name) => workspaceVocabulary([name])[0] ?? name.toLowerCase()));
  // A package's name is a name the repository goes by, whatever its folder.
  return workspaceVocabulary([...names, ...workspacePackages(root).keys()]).filter((term) => !kept.has(term));
}

/** The paths and the repository's name in pseudonyms. */
export function shareNames(root: string, paths: readonly string[], vocabulary: readonly string[] = repoVocabulary(root)): ShareNames {
  if (vocabulary.length === 0) return { vocabulary, repo: "this repo", paths };
  const config = readRepoConfig(root);
  // Each folder and file name once: the table is drafted over names, not texts.
  const segments = [...new Set(paths.flatMap((path) => path.split("/")))];
  const renamed = new Map<string, string>();
  const result = pseudonymize({
    files: segments.map((segment) => ({ path: segment, text: "" })),
    binaries: [],
    vocabulary,
    owner: config.pseudonyms ?? [],
    kept: [],
  });
  let generic = 0;
  for (const segment of segments) {
    let out = result.ok ? result.pathOf(segment) : segment;
    if (result.ok) out = wordsToFolder(result.table, out);
    if (out.includes("/") || leaksIn(out, vocabulary)) {
      // Renamed whole: its words say whose code it is.
      const dot = segment.lastIndexOf(".");
      generic++;
      out = dot > 0 ? `file-${generic}${segment.slice(dot)}` : `dir-${generic}`;
    }
    renamed.set(segment, out);
  }
  const name = basename(root);
  let repo = result.ok ? wordsToFolder(result.table, result.pathOf(name)) : name;
  if (repo === name || leaksIn(repo, vocabulary)) repo = "a private repo";
  return {
    vocabulary,
    repo,
    paths: paths.map((path) => path.split("/").map((segment) => renamed.get(segment) ?? segment).join("/")),
  };
}
