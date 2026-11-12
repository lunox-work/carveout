/**
 * The platform's renaming and vocabulary scan as they were before carveout
 * 0.3.0 (sandbox-factory's packages/core/src/sandbox `aliases.ts` and
 * `vocabulary.ts`, commit f31d780), frozen under a V1 suffix, for one reason
 * each:
 *
 * - A version the platform already built was renamed by `applyAliasesV1`,
 *   and carries back only under the same renaming: `ALIASES_V1` to
 *   `reverseSubmission`, `forwardChange` or `projectPathOf` (`carry.ts`).
 *   carveout's renaming matches a path rule after a `/` too, and lets a
 *   path hold any character but a NUL, a backslash, a quote or a newline.
 * - carveout's scan (`scanVocabulary`) leaves out a found name of one word
 *   too common to scan for alone (`tooCommonAlone`), and joins a term's
 *   words across a space, `_`, `-` or `.` but never a `/`; the old one
 *   scanned for every name and joined across `/`. For one release a
 *   platform can block on both: `unionVocabularyLeaks` of `vocabularyLeaks`
 *   and `vocabularyLeaksV1`.
 *
 * `organizationNames`, `privatePackageNames`, `emailNames`, `termWords`
 * and `workspaceVocabulary` are the same in both; the V1 workspace
 * vocabulary is exported for a caller that keeps the old scan whole.
 */

import type { AliasImplementation } from "./carry.js";
import { invertAliasRules, renameFile } from "./legacy/aliases-v1.js";
import type { VocabularyLeak } from "./vocabulary.js";

export {
  applyAliases as applyAliasesV1,
  invertAliasRules as invertAliasRulesV1,
  renameFile as renameFileV1,
  validateAliasRules as validateAliasRulesV1,
} from "./legacy/aliases-v1.js";
export {
  termMatches as termMatchesV1,
  vocabularyBlockers as vocabularyBlockersV1,
  vocabularyLeaks as vocabularyLeaksV1,
  workspaceVocabulary as workspaceVocabularyV1,
} from "./legacy/vocabulary-v1.js";

/** The renaming of versions built before carveout 0.3.0, for `carry.ts`. */
export const ALIASES_V1: AliasImplementation = { renameFile, invertAliasRules };

/**
 * Leaks under either scan, by term: carveout's first in its order, then
 * the terms only the other found. A term both found counts the larger
 * number of occurrences, in the files either named.
 */
export function unionVocabularyLeaks(
  current: readonly VocabularyLeak[],
  legacy: readonly VocabularyLeak[],
): VocabularyLeak[] {
  const merged = new Map<string, VocabularyLeak>();
  for (const leak of [...current, ...legacy]) {
    const known = merged.get(leak.term);
    merged.set(
      leak.term,
      known === undefined
        ? { term: leak.term, occurrences: leak.occurrences, files: [...leak.files] }
        : {
            term: leak.term,
            occurrences: Math.max(known.occurrences, leak.occurrences),
            files: [...new Set([...known.files, ...leak.files])],
          },
    );
  }
  return [...merged.values()];
}
