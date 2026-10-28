// The co-change hints E3 measured. Dropped from carveout when E3 failed;
// kept here so the experiment runs again as it ran (compiled from what was
// src/cochange.ts).
/**
 * Files that change with a slice in the repository's history but that no
 * import reaches: a migration and its schema, a route and its client, a
 * fixture and its test. Read from `git log`, first-parent, skipping a
 * commit that touches more than `maxCommitFiles` files (a rename sweep or a
 * formatting pass says nothing about coupling). A hint is never walked or
 * copied; it is something to look at.
 */
import { execFileSync } from "node:child_process";
/** Placeholder values; E3 chose its own, see results/e3.json. */
export const CO_CHANGE_DEFAULTS = {
    commits: 300,
    minCount: 2,
    minShare: 0.3,
    max: 5,
    maxCommitFiles: 50,
};
/** Files whose change says nothing of coupling: they change with anything. */
const NEVER_HINTS = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG\.md)$/;
/** First-parent commits of HEAD with the files each changed, newest first. */
export function history(repo, options) {
    let text;
    try {
        text = execFileSync("git", [
            "log",
            "--first-parent",
            "--diff-merges=first-parent",
            "--no-renames",
            "--name-only",
            "--format=%x00%H %cI",
            `-n${options.commits}`,
            ...(options.before === undefined ? [] : [`--before=${options.before}`]),
            "HEAD",
        ], { cwd: repo, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024 }).toString("utf8");
    }
    catch {
        return [];
    }
    return text
        .split("\0")
        .filter((chunk) => chunk.trim() !== "")
        .map((chunk) => {
        const [header = "", ...files] = chunk.split("\n");
        const [sha = "", date = ""] = header.split(" ");
        return { sha, date, files: files.filter(Boolean) };
    });
}
/** The hints for a slice's files from commits read with `history`. */
export function coChangeHints(commits, included, options) {
    const inside = new Set(included);
    const touching = commits.filter((commit) => commit.files.length <= options.maxCommitFiles &&
        commit.files.some((file) => inside.has(file)));
    if (touching.length === 0)
        return [];
    const counts = new Map();
    for (const commit of touching)
        for (const file of new Set(commit.files))
            if (!inside.has(file) && !NEVER_HINTS.test(file))
                counts.set(file, (counts.get(file) ?? 0) + 1);
    return [...counts.entries()]
        .map(([path, count]) => ({ path, count, share: count / touching.length }))
        .filter((hint) => hint.count >= options.minCount && hint.share >= options.minShare)
        .sort((a, b) => b.count - a.count ||
        b.share - a.share ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .slice(0, options.max);
}
