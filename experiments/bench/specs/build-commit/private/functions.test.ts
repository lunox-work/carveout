import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BuildInfoDto,
  buildBanner,
  commitUrl,
  formatVersion,
  isIdentified,
  sameBuild,
  unknownBuildInfo,
} from "../../src/build-info.js";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "https://github.com/lunox-work/sandbox-factory";
const TIME = "2026-11-04T12:00:00.000Z";
const SEP = " · ";

const known: BuildInfoDto = {
  version: "0.3.0",
  gitSha: SHA,
  gitShortSha: "a1b2c3d",
  buildTime: TIME,
  gitRef: "main",
  dirty: false,
};

function knownWith(changes: Partial<BuildInfoDto>): BuildInfoDto {
  return { ...known, ...changes };
}

function unknownWith(changes: Partial<BuildInfoDto>): BuildInfoDto {
  return { ...unknownBuildInfo, ...changes };
}

function frozen(info: BuildInfoDto): BuildInfoDto {
  return Object.freeze({ ...info });
}

// ---------------------------------------------------------------- happy-8

// Extends "[happy-8] formatting a version": other versions and short SHAs, kept verbatim.
test("[happy-8] formatVersion uses version and gitShortSha verbatim for other values", () => {
  const examples: Array<[string, string, boolean, string]> = [
    ["1.4.2", "0123456", false, "1.4.2+0123456"],
    ["1.4.2", "0123456", true, "1.4.2+0123456-dirty"],
    ["v1", "fffffff", false, "v1+fffffff"],
    ["0.3.0-rc.1+build.7", "a1b2c3d", false, "0.3.0-rc.1+build.7+a1b2c3d"],
    ["0.3.0-rc.1+build.7", "a1b2c3d", true, "0.3.0-rc.1+build.7+a1b2c3d-dirty"],
    ["0.3.0", SHA, false, `0.3.0+${SHA}`],
    ["0.3.0", "A1B2C3D", true, "0.3.0+A1B2C3D-dirty"],
    ["2.0.0", "unknown", false, "2.0.0"],
    ["2.0.0", "unknown", true, "2.0.0-dirty"],
  ];
  for (const [version, gitShortSha, dirty, text] of examples) {
    assert.equal(
      formatVersion(knownWith({ version, gitShortSha, dirty })),
      text,
      `${version} ${gitShortSha} ${dirty}`,
    );
  }
});

// Extends "[happy-8] unknown version and short SHA on a dirty build format as "unknown-dirty"":
// only the exact string "unknown" drops the short SHA.
test("[happy-8] a gitShortSha that only resembles \"unknown\" is kept in the formatted version", () => {
  assert.equal(formatVersion(knownWith({ gitShortSha: "Unknown" })), "0.3.0+Unknown");
  assert.equal(formatVersion(knownWith({ gitShortSha: "UNKNOWN", dirty: true })), "0.3.0+UNKNOWN-dirty");
  assert.equal(formatVersion(knownWith({ gitShortSha: "unknown1" })), "0.3.0+unknown1");
});

// The short SHA comes from gitShortSha, not from a prefix of gitSha.
test("[happy-8] formatVersion reads gitShortSha, not the first characters of gitSha", () => {
  assert.equal(formatVersion(knownWith({ gitSha: OTHER_SHA, gitShortSha: "a1b2c3d" })), "0.3.0+a1b2c3d");
  assert.equal(formatVersion(knownWith({ gitSha: SHA, gitShortSha: "unknown" })), "0.3.0");
  assert.equal(formatVersion(knownWith({ gitSha: "unknown", gitShortSha: "0123456" })), "0.3.0+0123456");
});

// ---------------------------------------------------------------- happy-9

// Extends "[happy-9] identifying a build": other identified gitSha values.
test("[happy-9] any gitSha other than \"unknown\" identifies the build", () => {
  for (const gitSha of [OTHER_SHA, "a1b2c3d", SHA.toUpperCase(), " unknown", "unknown ", "unknown1", "x"]) {
    assert.equal(isIdentified(knownWith({ gitSha })), true, gitSha);
  }
});

// Extends "[happy-9] gitSha is compared case-sensitively with "unknown"":
// isIdentified depends on gitSha alone, whatever the other fields hold.
test("[happy-9] gitSha \"unknown\" is unidentified whatever the other fields hold", () => {
  assert.equal(isIdentified(knownWith({ gitSha: "unknown", dirty: true })), false);
  assert.equal(isIdentified(knownWith({ gitSha: "unknown", gitShortSha: "a1b2c3d", version: "9.9.9" })), false);
  assert.equal(isIdentified(knownWith({ dirty: true })), true);
  assert.equal(isIdentified(knownWith({ gitShortSha: "unknown", dirty: true })), true);
});

// ---------------------------------------------------------------- happy-10

// Extends "[happy-10] URL for a known commit": other commits.
test("[happy-10] commitUrl builds the URL from the fixed repository and the given gitSha", () => {
  assert.equal(commitUrl(knownWith({ gitSha: OTHER_SHA })), `${REPO}/commit/${OTHER_SHA}`);
  assert.equal(
    commitUrl(knownWith({ gitSha: OTHER_SHA, gitShortSha: "0123456" })),
    "https://github.com/lunox-work/sandbox-factory/commit/0123456789abcdef0123456789abcdef01234567",
  );
});

// Extends "[happy-10] the commit URL uses gitSha verbatim": short and look-alike values.
test("[happy-10] commitUrl uses short and look-alike gitSha values verbatim", () => {
  assert.equal(commitUrl(knownWith({ gitSha: "a1b2c3d" })), `${REPO}/commit/a1b2c3d`);
  assert.equal(commitUrl(knownWith({ gitSha: "Unknown" })), `${REPO}/commit/Unknown`);
  assert.equal(commitUrl(knownWith({ gitSha: "UNKNOWN" })), `${REPO}/commit/UNKNOWN`);
});

// ---------------------------------------------------------------- happy-11

// Extends "[happy-11] same commit with different build details is the same build":
// every other field differs, on another commit.
test("[happy-11] the same full commit with every other field different is the same build", () => {
  const a = knownWith({ gitSha: OTHER_SHA });
  const b: BuildInfoDto = {
    version: "unknown",
    gitSha: OTHER_SHA,
    gitShortSha: "unknown",
    buildTime: "unknown",
    gitRef: "unknown",
    dirty: true,
  };
  assert.equal(sameBuild(a, b), true);
  assert.equal(sameBuild(b, a), true);
});

// Extends "[happy-11] same full commit with a different short SHA is the same build":
// a short gitSha matches only itself.
test("[happy-11] two builds with the same short gitSha are the same build", () => {
  assert.equal(
    sameBuild(knownWith({ gitSha: "a1b2c3d" }), unknownWith({ gitSha: "a1b2c3d", version: "1.0.0" })),
    true,
  );
});

// ---------------------------------------------------------------- happy-12

// Extends "[happy-12] different commits are not the same build": same details, different commit.
test("[happy-12] different commits with identical other fields are not the same build", () => {
  const a = unknownWith({ gitSha: SHA });
  const b = unknownWith({ gitSha: OTHER_SHA });
  assert.equal(sameBuild(a, b), false);
  assert.equal(sameBuild(b, a), false);
});

// Extends "[happy-12] different commits are not the same build in either order":
// a prefix, a look-alike of "unknown" and padding are different commits.
test("[happy-12] a prefix, a padded SHA or \"Unknown\" is a different commit", () => {
  assert.equal(sameBuild(known, knownWith({ gitSha: "a1b2c3d" })), false);
  assert.equal(sameBuild(knownWith({ gitSha: "a1b2c3d" }), known), false);
  assert.equal(sameBuild(known, knownWith({ gitSha: `${SHA} ` })), false);
  assert.equal(sameBuild(known, knownWith({ gitSha: "Unknown" })), false);
  assert.equal(sameBuild(knownWith({ gitSha: "UNKNOWN" }), known), false);
});

// ---------------------------------------------------------------- happy-13

// Extends "[happy-13] banners": other names, commits and build times.
test("[happy-13] banners for other names, commits and build times", () => {
  assert.equal(
    buildBanner("extension", knownWith({ gitSha: OTHER_SHA, gitShortSha: "0123456", buildTime: "yesterday" })),
    `extension 0.3.0+0123456${SEP}commit ${OTHER_SHA}${SEP}built yesterday`,
  );
  assert.equal(
    buildBanner("web", knownWith({ version: "1.4.2", buildTime: "2026-11-04T12:00:00+01:00" })),
    `web 1.4.2+a1b2c3d${SEP}commit ${SHA}${SEP}built 2026-11-04T12:00:00+01:00`,
  );
  assert.equal(
    buildBanner("api", knownWith({ gitSha: "Unknown" })),
    `api 0.3.0+a1b2c3d${SEP}commit Unknown${SEP}built ${TIME}`,
  );
});

// Extends "[happy-13] a dirty build with an unknown commit has only name and version in its banner":
// the banner follows formatVersion when the short SHA is unknown but the commit is known.
test("[happy-13] an identified build with an unknown short SHA shows the bare version and the full commit", () => {
  assert.equal(
    buildBanner("api", knownWith({ gitShortSha: "unknown" })),
    `api 0.3.0${SEP}commit ${SHA}${SEP}built ${TIME}`,
  );
  assert.equal(
    buildBanner("web", knownWith({ gitShortSha: "unknown", dirty: true, buildTime: "unknown" })),
    `web 0.3.0-dirty${SEP}commit ${SHA}${SEP}built unknown`,
  );
});

// The banner is one line with the exact " · " separator (U+00B7) and no URL.
test("[happy-13] the banner is a single line using U+00B7 separators and no commit URL", () => {
  const banner = buildBanner("api", known);
  assert.equal(banner, `api 0.3.0+a1b2c3d · commit ${SHA} · built ${TIME}`);
  assert.equal(banner.includes("\n"), false);
  assert.equal(banner.includes(REPO), false);
  assert.equal(banner.split(SEP).length, 3);
});

// An unidentified build drops the commit and time, whatever they hold.
test("[happy-13] an unidentified build's banner omits the build time even when it is known", () => {
  assert.equal(
    buildBanner("web", knownWith({ gitSha: "unknown", gitShortSha: "0123456", version: "2.0.0" })),
    "web 2.0.0+0123456",
  );
});

// ---------------------------------------------------------------- boundary-3

// Extends "[boundary-3] gitSha, buildTime and gitRef do not affect the formatted version":
// each of them changed alone, to several values.
test("[boundary-3] changing gitSha, buildTime or gitRef alone leaves the formatted version unchanged", () => {
  const changes: Array<Partial<BuildInfoDto>> = [
    { gitSha: OTHER_SHA },
    { gitSha: "unknown" },
    { gitSha: "Unknown" },
    { buildTime: "yesterday" },
    { buildTime: "unknown" },
    { gitRef: "v1.4.2" },
    { gitRef: "unknown" },
  ];
  for (const change of changes) {
    assert.equal(formatVersion(knownWith(change)), "0.3.0+a1b2c3d", JSON.stringify(change));
    assert.equal(
      formatVersion(knownWith({ ...change, gitShortSha: "unknown" })),
      "0.3.0",
      JSON.stringify(change),
    );
  }
});

// Extends "[boundary-3] ... of a dirty build": an unknown build info given a short SHA only.
test("[boundary-3] an otherwise unknown build with a short SHA formats from version and short SHA", () => {
  assert.equal(formatVersion(unknownWith({ gitShortSha: "a1b2c3d" })), "0.0.0+a1b2c3d");
  assert.equal(formatVersion(unknownWith({ gitShortSha: "a1b2c3d", dirty: true })), "0.0.0+a1b2c3d-dirty");
});

// ---------------------------------------------------------------- boundary-4

// Extends "[boundary-4] the unknown build info formats as "0.0.0"".
test("[boundary-4] the unknown build info formats as \"0.0.0\" with any gitSha, buildTime and gitRef", () => {
  assert.equal(formatVersion(unknownBuildInfo), "0.0.0");
  assert.equal(formatVersion(unknownWith({ gitSha: SHA, buildTime: TIME, gitRef: "main" })), "0.0.0");
});

// Extends "[boundary-4] the unknown build info marked dirty formats as "0.0.0-dirty"":
// the version is read from the info, not fixed to "0.0.0".
test("[boundary-4] an unknown build info with another version formats as that version", () => {
  assert.equal(formatVersion(unknownWith({ version: "1.2.3" })), "1.2.3");
  assert.equal(formatVersion(unknownWith({ version: "unknown" })), "unknown");
  assert.equal(formatVersion(unknownWith({ version: "1.2.3", dirty: true })), "1.2.3-dirty");
});

// ---------------------------------------------------------------- boundary-5

// Extends "[boundary-5] the unknown build info is not identified":
// knowing every field except gitSha does not identify it.
test("[boundary-5] the unknown build info with every field but gitSha known is not identified", () => {
  assert.equal(
    isIdentified(unknownWith({ version: "0.3.0", gitShortSha: "a1b2c3d", buildTime: TIME, gitRef: "main", dirty: true })),
    false,
  );
  assert.equal(isIdentified({ ...unknownBuildInfo }), false);
});

// Extends "[boundary-5] the unknown build info with only gitSha known is identified": other gitSha values.
test("[boundary-5] the unknown build info with a short or look-alike gitSha is identified", () => {
  assert.equal(isIdentified(unknownWith({ gitSha: "a1b2c3d" })), true);
  assert.equal(isIdentified(unknownWith({ gitSha: "Unknown" })), true);
});

// ---------------------------------------------------------------- boundary-6

// Extends "[boundary-6] other fields do not matter to the commit URL": on another commit.
test("[boundary-6] other fields do not matter to the commit URL of another commit", () => {
  const url = `${REPO}/commit/${OTHER_SHA}`;
  assert.equal(commitUrl(knownWith({ gitSha: OTHER_SHA })), url);
  assert.equal(commitUrl(unknownWith({ gitSha: OTHER_SHA })), url);
  assert.equal(commitUrl(unknownWith({ gitSha: OTHER_SHA, dirty: true, gitRef: "v1.4.2" })), url);
});

// Extends "[boundary-6] the commit URL reads gitSha, not gitShortSha": short SHA is unknown.
test("[boundary-6] the commit URL is built when gitShortSha is unknown", () => {
  assert.equal(commitUrl(knownWith({ gitShortSha: "unknown" })), `${REPO}/commit/${SHA}`);
});

// ---------------------------------------------------------------- boundary-7

// Extends "[boundary-7] same short SHA but different full SHA is not the same build":
// even when gitShortSha is equal on both sides and the other side's gitShortSha matches.
test("[boundary-7] equal gitShortSha on both sides does not make different full SHAs the same build", () => {
  const b = knownWith({ gitSha: "a1b2c3dffffffffffffffffffffffffffffffff0", gitShortSha: "a1b2c3d" });
  assert.equal(sameBuild(known, b), false);
  assert.equal(sameBuild(b, known), false);
});

// Extends "[boundary-7] full SHAs differing only in the last character are not the same build":
// they differ only in the first character, or only in case.
test("[boundary-7] full SHAs differing only in the first character are not the same build", () => {
  const b = knownWith({ gitSha: "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678" });
  assert.equal(sameBuild(known, b), false);
  assert.equal(sameBuild(b, known), false);
});

// ---------------------------------------------------------------- boundary-8

// Extends "[boundary-8] an unknown commit is not reported as a mismatch": the reverse order of the
// spec's last example, and unknown against several known commits.
test("[boundary-8] an unknown commit against any known commit, in either order, is not a mismatch", () => {
  const unknownCommit = knownWith({ gitSha: "unknown" });
  for (const gitSha of [SHA, OTHER_SHA, "a1b2c3d", "Unknown"]) {
    const other = knownWith({ gitSha });
    assert.equal(sameBuild(unknownCommit, other), true, gitSha);
    assert.equal(sameBuild(other, unknownCommit), true, gitSha);
    assert.equal(sameBuild(unknownBuildInfo, other), true, gitSha);
    assert.equal(sameBuild(other, unknownBuildInfo), true, gitSha);
  }
});

// Extends "[boundary-8] two unknown commits with otherwise different details are not a mismatch":
// an unknown commit with a known short SHA that differs from the other side's.
test("[boundary-8] an unknown commit with a conflicting short SHA is not a mismatch", () => {
  const a = knownWith({ gitSha: "unknown", gitShortSha: "0123456" });
  assert.equal(sameBuild(a, known), true);
  assert.equal(sameBuild(known, a), true);
});

// ---------------------------------------------------------------- boundary-9

// Extends "[boundary-9] a build is the same as itself": other builds, including unidentified and dirty ones.
test("[boundary-9] every build is the same as itself", () => {
  const infos: BuildInfoDto[] = [
    knownWith({ gitSha: OTHER_SHA }),
    knownWith({ dirty: true }),
    knownWith({ gitSha: "a1b2c3d" }),
    knownWith({ gitSha: "Unknown" }),
    unknownBuildInfo,
    knownWith({ gitSha: "unknown" }),
  ];
  for (const info of infos) {
    assert.equal(sameBuild(info, info), true, info.gitSha);
    assert.equal(sameBuild(info, { ...info }), true, info.gitSha);
  }
});

// Extends "[boundary-9] a build is the same as a separate copy of itself": a JSON round trip.
test("[boundary-9] a build is the same as its JSON round trip", () => {
  const copy = JSON.parse(JSON.stringify(known)) as BuildInfoDto;
  assert.equal(sameBuild(known, copy), true);
  assert.equal(sameBuild(copy, known), true);
});

// ---------------------------------------------------------------- boundary-10

// Extends "[boundary-10] sameBuild does not depend on argument order": many pairs, both orders.
test("[boundary-10] sameBuild gives the same result in both orders for every pair", () => {
  const infos: BuildInfoDto[] = [
    known,
    knownWith({ gitSha: OTHER_SHA }),
    knownWith({ gitSha: "a1b2c3dffffffffffffffffffffffffffffffff0" }),
    knownWith({ gitSha: "a1b2c3d" }),
    knownWith({ gitSha: "Unknown" }),
    knownWith({ gitSha: "unknown" }),
    knownWith({ dirty: true, version: "0.4.0" }),
    unknownBuildInfo,
    unknownWith({ gitSha: OTHER_SHA }),
  ];
  for (const a of infos) {
    for (const b of infos) {
      assert.equal(sameBuild(a, b), sameBuild(b, a), `${a.gitSha} ${b.gitSha}`);
    }
  }
});

// Extends "[boundary-10] ... for the same commit with different details": the order-independent
// values themselves.
test("[boundary-10] sameBuild is false in both orders for different commits and true for the unknown build", () => {
  const b = knownWith({ gitSha: OTHER_SHA });
  assert.deepEqual([sameBuild(known, b), sameBuild(b, known)], [false, false]);
  assert.deepEqual([sameBuild(known, unknownBuildInfo), sameBuild(unknownBuildInfo, known)], [true, true]);
});

// ---------------------------------------------------------------- boundary-11

// Extends "[boundary-11] banner for the unknown build info": other names.
test("[boundary-11] banners for the unknown build info under every deployable name", () => {
  assert.equal(buildBanner("api", unknownBuildInfo), "api 0.0.0");
  assert.equal(buildBanner("web", unknownBuildInfo), "web 0.0.0");
  assert.equal(buildBanner("extension", unknownBuildInfo), "extension 0.0.0");
});

// Extends "[boundary-11] banner for the unknown build info marked dirty": known build time and short SHA
// are not enough to add the commit part.
test("[boundary-11] an unknown build with a known build time and short SHA has no commit part", () => {
  assert.equal(
    buildBanner("extension", unknownWith({ buildTime: TIME, gitShortSha: "a1b2c3d", gitRef: "main" })),
    "extension 0.0.0+a1b2c3d",
  );
  assert.equal(buildBanner("extension", unknownWith({ version: "1.0.0" })), "extension 1.0.0");
});

// ---------------------------------------------------------------- boundary-12

// Extends "[boundary-12] a known gitRef is not part of the banner either": refs that look like other parts.
test("[boundary-12] no gitRef value appears in the banner", () => {
  const expected = `api 0.3.0+a1b2c3d${SEP}commit ${SHA}${SEP}built ${TIME}`;
  for (const gitRef of ["feature/build-info", "v0.3.0", "refs/heads/main", "HEAD"]) {
    assert.equal(buildBanner("api", knownWith({ gitRef })), expected, gitRef);
  }
});

// Extends "[boundary-12] gitRef "unknown" is not part of the banner": on a dirty build of another commit.
test("[boundary-12] gitRef is not part of the banner of a dirty build of another commit", () => {
  assert.equal(
    buildBanner("web", knownWith({ gitRef: "release/1.4", gitSha: OTHER_SHA, gitShortSha: "0123456", dirty: true })),
    `web 0.3.0+0123456-dirty${SEP}commit ${OTHER_SHA}${SEP}built ${TIME}`,
  );
});

// ---------------------------------------------------------------- boundary-13

// Extends "[boundary-13] the banner name is used verbatim": other names.
test("[boundary-13] names with tabs, case, separators and non-ASCII characters are used verbatim", () => {
  const names = ["\tapi", "API", "my api", "api · web", "ëxtension", "  ", "api\n"];
  for (const name of names) {
    assert.equal(buildBanner(name, unknownBuildInfo), `${name} 0.0.0`, JSON.stringify(name));
  }
});

// Extends "[boundary-13] an empty name is used verbatim on an identified build": a padded name.
test("[boundary-13] a padded name is used verbatim on an identified, dirty build", () => {
  assert.equal(
    buildBanner("  api ", knownWith({ dirty: true })),
    `  api  0.3.0+a1b2c3d-dirty${SEP}commit ${SHA}${SEP}built ${TIME}`,
  );
});

// ---------------------------------------------------------------- boundary-14

// Extends "[boundary-14] the functions leave their arguments as they were and repeat their results":
// frozen arguments, so any write would throw in strict mode.
test("[boundary-14] the functions work on frozen arguments and return the specified results", () => {
  const a = frozen(known);
  const b = frozen(knownWith({ gitSha: OTHER_SHA, gitShortSha: "0123456", dirty: true }));
  const u = frozen(unknownBuildInfo);
  assert.equal(formatVersion(a), "0.3.0+a1b2c3d");
  assert.equal(formatVersion(b), "0.3.0+0123456-dirty");
  assert.equal(isIdentified(a), true);
  assert.equal(isIdentified(u), false);
  assert.equal(commitUrl(b), `${REPO}/commit/${OTHER_SHA}`);
  assert.equal(commitUrl(u), undefined);
  assert.equal(buildBanner("api", a), `api 0.3.0+a1b2c3d${SEP}commit ${SHA}${SEP}built ${TIME}`);
  assert.equal(buildBanner("web", u), "web 0.0.0");
  assert.equal(sameBuild(a, b), false);
  assert.equal(sameBuild(a, u), true);
});

// Extends "[boundary-14] the functions leave unknownBuildInfo as it was and repeat their results":
// two different arguments, called repeatedly and interleaved.
test("[boundary-14] repeated interleaved calls leave both arguments unchanged and repeat their results", () => {
  const a = knownWith({ dirty: true });
  const b = knownWith({ gitSha: OTHER_SHA, gitShortSha: "unknown" });
  const copyA = structuredClone(a);
  const copyB = structuredClone(b);
  const run = (): unknown[] => [
    formatVersion(a),
    formatVersion(b),
    isIdentified(b),
    commitUrl(a),
    commitUrl(b),
    buildBanner("api", b),
    sameBuild(a, b),
    sameBuild(b, a),
    buildBanner("web", a),
  ];
  const first = run();
  assert.deepEqual(first, [
    "0.3.0+a1b2c3d-dirty",
    "0.3.0",
    true,
    `${REPO}/commit/${SHA}`,
    `${REPO}/commit/${OTHER_SHA}`,
    `api 0.3.0${SEP}commit ${OTHER_SHA}${SEP}built ${TIME}`,
    false,
    false,
    `web 0.3.0+a1b2c3d-dirty${SEP}commit ${SHA}${SEP}built ${TIME}`,
  ]);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(run(), first);
  }
  assert.deepEqual(a, copyA);
  assert.deepEqual(b, copyB);
  assert.deepEqual(Object.keys(a), Object.keys(copyA));
});

// ---------------------------------------------------------------- unhappy-4

// Extends "[unhappy-4] no URL without a commit": whatever the other fields hold.
test("[unhappy-4] no URL for an unknown gitSha whatever the other fields hold", () => {
  assert.equal(commitUrl(knownWith({ gitSha: "unknown", dirty: true })), undefined);
  assert.equal(commitUrl(unknownWith({ version: "0.3.0", buildTime: TIME, gitRef: "main", dirty: true })), undefined);
  assert.equal(commitUrl({ ...unknownBuildInfo }), undefined);
});

// Extends "[unhappy-4] no URL without a commit even when the short SHA is known":
// the result is undefined itself, not an empty string or a URL ending in "unknown".
test("[unhappy-4] commitUrl returns exactly undefined, not an empty string or an \"unknown\" URL", () => {
  const url = commitUrl(knownWith({ gitSha: "unknown" }));
  assert.equal(typeof url, "undefined");
  assert.notEqual(url, "");
  assert.notEqual(url, `${REPO}/commit/unknown`);
});
