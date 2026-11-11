#!/usr/bin/env node
// The repository's agent skills (skills/<name>/SKILL.md) as the Agent Skills
// format (agentskills.io/specification).
//
//   node scripts/skill.mjs check            the rules below; exit 1 on any
//   node scripts/skill.mjs sync             write package.json's version into
//                                           the pins (npm `version` hook)
//   node scripts/skill.mjs pack [--offline] one zip per skill in dist-skills/
//   node scripts/skill.mjs plugin-branch [--push]
//                                           commit the plugin's files to the
//                                           claude-plugin branch
//
// check: `name` matches its folder (lowercase, digits, single hyphens, at
// most 64), `description` 1 to 1024 characters without < or >,
// `compatibility` at most 500, the body at most 500 lines, no symlinks,
// every relative link resolves inside the skill's folder, and every
// `<package>@x.y.z` pin and both .claude-plugin/ manifests carry
// package.json's version.
//
// pack: a zip holding one top-level folder named after the skill, with
// SKILL.md at its root. It refuses a pin that npm does not serve yet
// (publish first), unless --offline.
//
// plugin-branch: the Claude plugin directory scans every file in the plugin
// folder, and on main that folder is the whole repository (CLI source,
// lockfile, tests, experiments). The directory tracks the claude-plugin
// branch instead, which holds only PLUGIN_FILES and plugin.json (less
// LISTING_LINKS) as of HEAD, and a README.md
// written from plugin.json, each skill's frontmatter and .claude-plugin/data.md
// (what is sent where, for the directory's data-handling review; the
// directory requires a README), one commit per change on top of origin's branch. Builds the commit without touching the
// working tree or index; --push sends it to origin. CI runs it on push to main.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PIN = new RegExp(`\\b${PKG.name}@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)`, "g");
const MANIFESTS = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];

/** Top-level YAML keys of the frontmatter, folded the way YAML folds plain and `>` scalars. */
function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const fields = {};
  let key = null;
  for (const line of match[1].split("\n")) {
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      key = top[1];
      fields[key] = /^[>|][+-]?$/.test(top[2]) ? "" : top[2];
    } else if (key && /^\s/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  for (const k of Object.keys(fields)) fields[k] = fields[k].replace(/^(["'])(.*)\1$/, "$2");
  return { fields, body: text.slice(match[0].length) };
}

function skills() {
  return existsSync(SKILLS) ? readdirSync(SKILLS).filter((name) => existsSync(join(SKILLS, name, "SKILL.md"))) : [];
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? walk(path) : [path];
  });
}

function check() {
  const problems = [];
  const names = skills();
  if (names.length === 0) problems.push("skills/: no <name>/SKILL.md");
  for (const name of names) {
    const dir = join(SKILLS, name);
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");
    const parsed = frontmatter(text);
    const at = `skills/${name}/SKILL.md`;
    if (!parsed) {
      problems.push(`${at}: no frontmatter`);
      continue;
    }
    const { fields, body } = parsed;
    if (fields.name !== name) problems.push(`${at}: name "${fields.name}" is not its folder's name`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) problems.push(`${at}: folder name breaks the name rule`);
    const description = fields.description ?? "";
    if (description.length < 1 || description.length > 1024) problems.push(`${at}: description is ${description.length} characters (1 to 1024)`);
    if (/[<>]/.test(description)) problems.push(`${at}: description holds < or >`);
    if ((fields.compatibility ?? "").length > 500) problems.push(`${at}: compatibility is over 500 characters`);
    const lines = body.split("\n").length;
    if (lines > 500) problems.push(`${at}: body is ${lines} lines (at most 500; move detail to references/)`);
    for (const path of walk(dir)) {
      if (lstatSync(path).isSymbolicLink()) problems.push(`${relative(ROOT, path)}: a symlink`);
    }
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const path = resolve(dir, target);
      if (!path.startsWith(dir + "/")) problems.push(`${at}: link ${target} leaves the skill's folder`);
      else if (!existsSync(path)) problems.push(`${at}: link ${target} does not exist`);
    }
    for (const [pin, version] of text.matchAll(PIN)) {
      if (version !== PKG.version) problems.push(`${at}: ${pin} is not package.json's ${PKG.version} (npm run skill:sync)`);
    }
  }
  const plugin = readJson(MANIFESTS[0]);
  const market = readJson(MANIFESTS[1]);
  if (!plugin) problems.push(`${MANIFESTS[0]}: missing`);
  else if (plugin.name !== PKG.name || plugin.version !== PKG.version) problems.push(`${MANIFESTS[0]}: name and version are not package.json's`);
  const listed = market?.plugins?.find((p) => p.name === PKG.name);
  if (!listed) problems.push(`${MANIFESTS[1]}: no plugin named ${PKG.name}`);
  else if (listed.version !== undefined && listed.version !== PKG.version) problems.push(`${MANIFESTS[1]}: version is not package.json's`);
  return problems;
}

function readJson(path) {
  const full = join(ROOT, path);
  return existsSync(full) ? JSON.parse(readFileSync(full, "utf8")) : null;
}

function sync() {
  for (const name of skills()) {
    const path = join(SKILLS, name, "SKILL.md");
    const text = readFileSync(path, "utf8");
    const next = text.replace(PIN, `${PKG.name}@${PKG.version}`);
    if (next !== text) writeFileSync(path, next);
  }
  for (const path of MANIFESTS) {
    const json = readJson(path);
    if (!json) continue;
    if (json.version !== undefined) json.version = PKG.version;
    for (const plugin of json.plugins ?? []) if (plugin.name === PKG.name) plugin.version = PKG.version;
    writeFileSync(join(ROOT, path), `${JSON.stringify(json, null, 2)}\n`);
  }
}

function pack(offline) {
  const problems = check();
  if (problems.length > 0) return problems;
  if (!offline) {
    const view = spawnSync("npm", ["view", `${PKG.name}@${PKG.version}`, "version"], { encoding: "utf8" });
    if (view.status !== 0 || view.stdout.trim() !== PKG.version) {
      return [`${PKG.name}@${PKG.version} is not on npm yet: publish it first, or pass --offline`];
    }
  }
  const out = join(ROOT, "dist-skills");
  mkdirSync(out, { recursive: true });
  for (const name of skills()) {
    const zip = join(out, `${name}-${PKG.version}.zip`);
    rmSync(zip, { force: true });
    const result = spawnSync("zip", ["-r", "-X", "-q", zip, name, "-x", "*.DS_Store", "-x", "*/Thumbs.db"], {
      cwd: SKILLS,
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) return [`zip failed for ${name}${result.error ? `: ${result.error.message}` : ""}`];
    console.log(relative(ROOT, zip));
  }
  return [];
}

const PLUGIN_BRANCH = "claude-plugin";
const PLUGIN_FILES = [".claude-plugin/icon.png", "LICENSE", "skills"];
// plugin.json fields only the directory's listing reads. Claude Code warns on
// them as unknown keys, so the branch's plugin.json drops them and its README
// carries them as links, which the directory also reads.
const LISTING_LINKS = { privacyPolicyUrl: "Privacy", documentationUrl: "Documentation", supportUrl: "Support" };

function git(args, env = {}) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${(result.stderr || "").trim()}`);
  return result.stdout.trim();
}

/** The plugin branch's README: what the plugin does, its skills, how to install and what each needs. */
function pluginReadme() {
  const plugin = JSON.parse(git(["show", "HEAD:.claude-plugin/plugin.json"]));
  const market = JSON.parse(git(["show", "HEAD:.claude-plugin/marketplace.json"]));
  const names = git(["ls-tree", "--name-only", "HEAD:skills"]).split("\n").filter(Boolean);
  const lines = [`# ${plugin.name}`, "", plugin.description, "", "## Skills", ""];
  const needs = [];
  for (const name of names) {
    const { fields } = frontmatter(git(["show", `HEAD:skills/${name}/SKILL.md`]));
    lines.push(`- **${fields.name}**: ${fields.description}`, "");
    if (fields.compatibility) needs.push(`- **${fields.name}**: ${fields.compatibility}`, "");
  }
  lines.push("## Install", "", "```sh", `claude plugin marketplace add ${plugin.repository.replace(/^https:\/\/github\.com\//, "")}`);
  lines.push(`claude plugin install ${plugin.name}@${market.name}`, "```", "");
  if (needs.length > 0) lines.push("## Requirements", "", ...needs);
  const data = spawnSync("git", ["show", "HEAD:.claude-plugin/data.md"], { cwd: ROOT, encoding: "utf8" });
  if (data.status === 0) lines.push("## Data", "", data.stdout.trim(), "");
  const links = Object.entries(LISTING_LINKS).filter(([key]) => plugin[key]);
  if (links.length > 0) lines.push("## Links", "", ...links.map(([key, label]) => `- [${label}](${plugin[key]})`), "");
  lines.push("## Source", "", `This branch holds only the plugin's files. The CLI, its documentation and the`);
  lines.push(`skills' source are on the main branch of ${plugin.repository}. License: ${plugin.license}.`, "");
  return lines.join("\n");
}

function pluginBranch(push) {
  const scratch = mkdtempSync(join(tmpdir(), "plugin-branch-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    git(["read-tree", "--empty"], env);
    for (const path of PLUGIN_FILES) {
      const [mode, type, object] = git(["ls-tree", "HEAD", "--", path]).split(/\s+/);
      if (!object) return [`${path}: not in HEAD`];
      if (type === "tree") git(["read-tree", `--prefix=${path}/`, object], env);
      else git(["update-index", "--add", "--cacheinfo", `${mode},${object},${path}`], env);
    }
    const manifest = JSON.parse(git(["show", "HEAD:.claude-plugin/plugin.json"]));
    for (const key of Object.keys(LISTING_LINKS)) delete manifest[key];
    const json = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: ROOT, input: `${JSON.stringify(manifest, null, 2)}\n`, encoding: "utf8" });
    if (json.status !== 0) return [`git hash-object: ${json.stderr.trim()}`];
    git(["update-index", "--add", "--cacheinfo", `100644,${json.stdout.trim()},.claude-plugin/plugin.json`], env);
    const readme = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: ROOT, input: pluginReadme(), encoding: "utf8" });
    if (readme.status !== 0) return [`git hash-object: ${readme.stderr.trim()}`];
    git(["update-index", "--add", "--cacheinfo", `100644,${readme.stdout.trim()},README.md`], env);
    const tree = git(["write-tree"], env);
    const remote = spawnSync("git", ["fetch", "--quiet", "origin", PLUGIN_BRANCH], { cwd: ROOT }).status === 0;
    const parent = remote ? git(["rev-parse", "FETCH_HEAD"]) : null;
    if (parent && git(["rev-parse", `${parent}^{tree}`]) === tree) {
      console.log(`${PLUGIN_BRANCH}: up to date at ${parent.slice(0, 7)}`);
      return [];
    }
    const head = git(["rev-parse", "--short", "HEAD"]);
    const message = `Plugin files from main ${head}\n\n${PLUGIN_FILES.join(", ")}; built by scripts/skill.mjs plugin-branch.`;
    const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
    if (push) git(["push", "--quiet", "origin", `${commit}:refs/heads/${PLUGIN_BRANCH}`]);
    console.log(`${PLUGIN_BRANCH}: ${commit.slice(0, 7)} from main ${head}${push ? ", pushed" : " (not pushed; add --push)"}`);
    return [];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const [command, ...args] = process.argv.slice(2);
let problems;
if (command === "check") problems = check();
else if (command === "sync") (sync(), (problems = check()));
else if (command === "pack") problems = pack(args.includes("--offline"));
else if (command === "plugin-branch") problems = pluginBranch(args.includes("--push"));
else {
  console.error("usage: node scripts/skill.mjs check | sync | pack [--offline] | plugin-branch [--push]");
  process.exit(1);
}
for (const problem of problems) console.error(problem);
if (problems.length === 0 && command === "check") console.log(`skills: ${skills().join(", ")} ok`);
process.exit(problems.length > 0 ? 1 : 0);
