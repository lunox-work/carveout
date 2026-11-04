import assert from "node:assert/strict";
import { test } from "node:test";

import * as buildInfo from "../../src/build-info.js";
import {
  type BuildInfoDto,
  buildInfoSchema,
  UNKNOWN_BUILD,
  unknownBuildInfo,
  versionResponseSchema,
} from "../../src/build-info.js";
import * as shared from "../../src/index.js";

// Consumers import from `@sandbox-factory/shared`, whose entry point is
// `src/index.ts`; the spec says it re-exports everything from build-info.
// The schema scenarios are asserted through that entry point.
const entry = shared as unknown as Record<string, unknown>;

const BUILD_INFO_EXPORTS = [
  "UNKNOWN_BUILD",
  "buildInfoSchema",
  "versionResponseSchema",
  "unknownBuildInfo",
  "formatVersion",
  "isIdentified",
  "commitUrl",
  "sameBuild",
  "buildBanner",
] as const;

function viaEntry(): {
  buildInfoSchema: typeof buildInfoSchema;
  versionResponseSchema: typeof versionResponseSchema;
  unknownBuildInfo: BuildInfoDto;
  UNKNOWN_BUILD: string;
} {
  const own = buildInfo as unknown as Record<string, unknown>;
  for (const name of BUILD_INFO_EXPORTS) {
    assert.equal(entry[name], own[name], `src/index.ts re-exports ${name}`);
  }
  return {
    buildInfoSchema: entry.buildInfoSchema as typeof buildInfoSchema,
    versionResponseSchema: entry.versionResponseSchema as typeof versionResponseSchema,
    unknownBuildInfo: entry.unknownBuildInfo as BuildInfoDto,
    UNKNOWN_BUILD: entry.UNKNOWN_BUILD as string,
  };
}

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "https://github.com/lunox-work/sandbox-factory";

const known: BuildInfoDto = {
  version: "0.3.0",
  gitSha: SHA,
  gitShortSha: "a1b2c3d",
  buildTime: "2026-11-04T12:00:00.000Z",
  gitRef: "main",
  dirty: false,
};

const stringFields = ["version", "gitSha", "gitShortSha", "buildTime", "gitRef"] as const;
const allFields = [...stringFields, "dirty"] as const;
type Field = (typeof allFields)[number];

function knownWith(changes: Partial<BuildInfoDto>): BuildInfoDto {
  return { ...known, ...changes };
}

function knownWithout(...fields: Field[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...known };
  for (const field of fields) delete copy[field];
  return copy;
}

// ---------------------------------------------------------------- happy-1

// Extends "[happy-1] UNKNOWN_BUILD is "unknown" and unknownBuildInfo uses it ...":
// the same constants are what consumers get from the package entry point.
test("[happy-1] the package entry point exposes UNKNOWN_BUILD and unknownBuildInfo with the specified values", () => {
  const api = viaEntry();
  assert.equal(api.UNKNOWN_BUILD, "unknown");
  assert.equal(api.unknownBuildInfo, unknownBuildInfo);
  assert.deepEqual(api.unknownBuildInfo, {
    version: "0.0.0",
    gitSha: UNKNOWN_BUILD,
    gitShortSha: UNKNOWN_BUILD,
    buildTime: UNKNOWN_BUILD,
    gitRef: UNKNOWN_BUILD,
    dirty: false,
  });
  assert.deepEqual(api.buildInfoSchema.parse(api.unknownBuildInfo), api.unknownBuildInfo);
});

// Extends "[happy-1] unknownBuildInfo is a plain object that is not frozen".
test("[happy-1] unknownBuildInfo from the entry point is unfrozen and survives a JSON round trip through the schema", () => {
  const api = viaEntry();
  assert.equal(Object.isFrozen(api.unknownBuildInfo), false);
  const wire: unknown = JSON.parse(JSON.stringify(api.unknownBuildInfo));
  assert.deepEqual(api.buildInfoSchema.parse(wire), api.unknownBuildInfo);
});

// ---------------------------------------------------------------- happy-2

// Extends "[happy-2] a fully known build info parses to itself": other known values.
test("[happy-2] other fully known build infos parse to themselves", () => {
  const { buildInfoSchema: schema } = viaEntry();
  const infos: BuildInfoDto[] = [
    known,
    knownWith({ gitSha: OTHER_SHA, gitShortSha: "0123456", gitRef: "v1.4.2", version: "1.4.2" }),
    knownWith({ dirty: true, buildTime: "2026-01-01T00:00:00.000Z", gitRef: "feature/build-info" }),
  ];
  for (const info of infos) {
    assert.deepEqual(schema.parse(info), info, JSON.stringify(info));
  }
});

// Extends "[happy-2] parsed values are kept as given, not trimmed or lowercased".
test("[happy-2] mixed-case and padded values in every string field are kept as given", () => {
  const { buildInfoSchema: schema } = viaEntry();
  const info = knownWith({
    version: "V0.3.0 ",
    gitSha: ` ${SHA.toUpperCase()} `,
    gitShortSha: "A1B2C3D\t",
    buildTime: " 2026-11-04T12:00:00.000Z",
    gitRef: "Main ",
  });
  assert.deepEqual(schema.parse(info), info);
});

// ---------------------------------------------------------------- happy-3

// Extends "[happy-3] any single string field may be "unknown"": each field alone, on a dirty build.
test("[happy-3] any single string field may be \"unknown\" on a dirty build, other fields kept", () => {
  const { buildInfoSchema: schema } = viaEntry();
  for (const field of stringFields) {
    const info = knownWith({ [field]: "unknown", dirty: true });
    assert.deepEqual(schema.parse(info), info, field);
  }
});

// Extends "[happy-3] every string field may be "unknown" at once": every pair of fields.
test("[happy-3] any two string fields may be \"unknown\" together", () => {
  const { buildInfoSchema: schema } = viaEntry();
  for (const a of stringFields) {
    for (const b of stringFields) {
      const info = knownWith({ [a]: UNKNOWN_BUILD, [b]: UNKNOWN_BUILD });
      assert.deepEqual(schema.parse(info), info, `${a} ${b}`);
    }
  }
});

// ---------------------------------------------------------------- happy-4

// Extends "[happy-4] a dirty build parses": a dirty build with every other field known parses to itself.
test("[happy-4] a dirty build parses to itself and keeps dirty true", () => {
  const { buildInfoSchema: schema } = viaEntry();
  const info = knownWith({ dirty: true });
  const result = schema.safeParse(info);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.dirty, true);
    assert.deepEqual(result.data, info);
  }
});

// Extends "[happy-4] a dirty build with an unknown commit parses".
test("[happy-4] the unknown build info marked dirty parses", () => {
  const { buildInfoSchema: schema, unknownBuildInfo: unknown } = viaEntry();
  const info = { ...unknown, dirty: true };
  assert.deepEqual(schema.parse(info), info);
});

// ---------------------------------------------------------------- happy-5

// Extends "[happy-5] versionResponseSchema is the same object as buildInfoSchema".
test("[happy-5] the entry point's versionResponseSchema is the same object as buildInfoSchema", () => {
  const api = viaEntry();
  assert.equal(api.versionResponseSchema, api.buildInfoSchema);
  assert.equal(api.versionResponseSchema, buildInfoSchema);
  assert.equal(versionResponseSchema, buildInfoSchema);
});

// Extends "[happy-5] versionResponseSchema has the same shape object as buildInfoSchema".
test("[happy-5] the entry point's versionResponseSchema shape has exactly the six build info fields", () => {
  const api = viaEntry();
  assert.equal(api.versionResponseSchema.shape, api.buildInfoSchema.shape);
  assert.deepEqual(Object.keys(api.versionResponseSchema.shape).sort(), [...allFields].sort());
});

// ---------------------------------------------------------------- happy-6

// Extends "[happy-6] a version response parses": other bodies, including one off the wire.
test("[happy-6] version responses for other builds parse, including a JSON body", () => {
  const { versionResponseSchema: schema } = viaEntry();
  const infos: BuildInfoDto[] = [
    knownWith({ gitSha: OTHER_SHA, gitShortSha: "0123456" }),
    knownWith({ gitRef: "v1.4.2", version: "1.4.2", dirty: true }),
  ];
  for (const info of infos) {
    const wire: unknown = JSON.parse(JSON.stringify(info));
    assert.deepEqual(schema.parse(wire), info, JSON.stringify(info));
  }
});

// Extends "[happy-6] a version response for a dirty build parses": extra keys on the body are dropped.
test("[happy-6] a version response with extra keys parses to the build info", () => {
  const { versionResponseSchema: schema } = viaEntry();
  assert.deepEqual(schema.parse({ ...known, status: "ok", uptime: 12 }), known);
});

// ---------------------------------------------------------------- happy-7

// Extends "[happy-7] a version response for an unknown build parses".
test("[happy-7] a version response for the entry point's unknownBuildInfo parses", () => {
  const api = viaEntry();
  assert.deepEqual(api.versionResponseSchema.parse(api.unknownBuildInfo), unknownBuildInfo);
});

// Extends "[happy-7] parsing unknownBuildInfo as a version response leaves it unchanged".
test("[happy-7] a JSON version response for an unknown build parses to unknownBuildInfo", () => {
  const api = viaEntry();
  const wire: unknown = JSON.parse(JSON.stringify(unknownBuildInfo));
  assert.deepEqual(api.versionResponseSchema.parse(wire), unknownBuildInfo);
  assert.equal(unknownBuildInfo.version, "0.0.0");
});

// ---------------------------------------------------------------- boundary-1

// Extends "[boundary-1] unknown keys are dropped".
test("[boundary-1] the key \"branch\" is dropped from the parse result", () => {
  const { buildInfoSchema: schema } = viaEntry();
  const result = schema.safeParse({ ...known, branch: "main" });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(Object.hasOwn(result.data, "branch"), false);
    assert.deepEqual(result.data, known);
  }
});

// Extends "[boundary-1] several unknown keys ... are dropped": the rejected alternative field names.
test("[boundary-1] commit, builtAt, repository and other unknown keys of any type are dropped", () => {
  const { buildInfoSchema: schema } = viaEntry();
  const result = schema.safeParse({
    ...known,
    commit: SHA,
    builtAt: "2026-11-04T12:00:00.000Z",
    repository: REPO,
    build: { ...known },
    extra: null,
    count: 3,
    flags: [true, false],
  });
  assert.equal(result.success, true);
  if (result.success) {
    for (const key of ["commit", "builtAt", "repository", "build", "extra", "count", "flags"]) {
      assert.equal(Object.hasOwn(result.data, key), false, key);
    }
    assert.deepEqual(result.data, known);
  }
});

// ---------------------------------------------------------------- boundary-2

// Extends "[boundary-2] accepted edge values are kept unchanged": the spec's examples.
test("[boundary-2] the spec's accepted edge values are kept unchanged", () => {
  const { buildInfoSchema: schema } = viaEntry();
  const examples: Array<[(typeof stringFields)[number], string]> = [
    ["version", "v1"],
    ["version", "0.3.0-rc.1+build.7"],
    ["gitSha", "a1b2c3d"],
    ["gitSha", "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678"],
    ["gitSha", "Unknown"],
    ["gitShortSha", "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"],
    ["buildTime", "2026-11-04T12:00:00+01:00"],
    ["buildTime", "yesterday"],
    ["gitRef", "v1.4.2"],
  ];
  for (const [field, value] of examples) {
    const info = knownWith({ [field]: value });
    assert.deepEqual(schema.parse(info), info, `${field} ${value}`);
  }
});

// Extends "[boundary-2] a single-character string is accepted in every string field":
// no format, length cap or trimming applies.
test("[boundary-2] whitespace-only, very long, non-hex and non-ASCII strings are accepted unchanged", () => {
  const { buildInfoSchema: schema } = viaEntry();
  const values = [
    " ",
    "\t",
    "x".repeat(10_000),
    "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    "ünïcødé · 版本",
    "0",
    "UNKNOWN",
    "null",
  ];
  for (const field of stringFields) {
    for (const value of values) {
      const result = schema.safeParse(knownWith({ [field]: value }));
      assert.equal(result.success, true, `${field} ${value.slice(0, 20)}`);
      if (result.success) {
        assert.equal(result.data[field], value, `${field} ${value.slice(0, 20)}`);
      }
    }
  }
});

// ---------------------------------------------------------------- unhappy-1

// Extends "[unhappy-1] a missing required field is rejected".
test("[unhappy-1] each missing required field is rejected, also when the rest are unknown", () => {
  const { buildInfoSchema: schema, unknownBuildInfo: unknown } = viaEntry();
  for (const field of allFields) {
    assert.equal(schema.safeParse(knownWithout(field)).success, false, field);
    const copy: Record<string, unknown> = { ...unknown };
    delete copy[field];
    assert.equal(schema.safeParse(copy).success, false, `unknown without ${field}`);
  }
});

// Extends "[unhappy-1] a required field explicitly set to undefined is rejected":
// several fields missing, and a missing field not replaced by a differently cased key.
test("[unhappy-1] several missing fields, or a field present only under another casing, are rejected", () => {
  const { buildInfoSchema: schema } = viaEntry();
  assert.equal(schema.safeParse(knownWithout("gitSha", "gitShortSha")).success, false);
  assert.equal(schema.safeParse(knownWithout("version", "buildTime", "gitRef")).success, false);
  assert.equal(schema.safeParse(knownWithout(...allFields)).success, false);
  assert.equal(schema.safeParse({ ...knownWithout("gitSha"), GitSha: SHA }).success, false);
  assert.equal(schema.safeParse({ ...knownWithout("gitSha"), commit: SHA }).success, false);
  assert.equal(schema.safeParse({ ...knownWithout("dirty"), Dirty: false }).success, false);
});

// ---------------------------------------------------------------- unhappy-2

// Extends "[unhappy-2] invalid field values are rejected": the spec's examples.
test("[unhappy-2] the spec's invalid field values are rejected", () => {
  const { buildInfoSchema: schema } = viaEntry();
  const examples: Array<[Field, unknown]> = [
    ["version", ""],
    ["version", 3],
    ["gitSha", ""],
    ["gitShortSha", ""],
    ["buildTime", ""],
    ["gitRef", ""],
    ["dirty", "false"],
    ["dirty", null],
  ];
  for (const [field, value] of examples) {
    assert.equal(schema.safeParse({ ...known, [field]: value }).success, false, `${field} ${String(value)}`);
  }
});

// Extends "[unhappy-2] a numeric dirty and a null string field are rejected":
// every string field against every wrong type, and dirty against non-booleans.
test("[unhappy-2] every string field rejects the empty string and non-string values, and dirty rejects non-booleans", () => {
  const { buildInfoSchema: schema } = viaEntry();
  const notStrings: unknown[] = ["", 0, 3, 1.5, true, false, null, [], ["a1b2c3d"], {}, { value: SHA }];
  for (const field of stringFields) {
    for (const value of notStrings) {
      assert.equal(
        schema.safeParse({ ...known, [field]: value }).success,
        false,
        `${field} ${JSON.stringify(value)}`,
      );
    }
  }
  const notBooleans: unknown[] = ["false", "true", "", 0, 1, null, [], {}, [false]];
  for (const value of notBooleans) {
    assert.equal(schema.safeParse({ ...known, dirty: value }).success, false, `dirty ${JSON.stringify(value)}`);
  }
});

// The invalid values from the spec are also rejected on an otherwise unknown build.
test("[unhappy-2] invalid values are rejected when every other field is unknown", () => {
  const { buildInfoSchema: schema, unknownBuildInfo: unknown } = viaEntry();
  assert.equal(schema.safeParse({ ...unknown, version: "" }).success, false);
  assert.equal(schema.safeParse({ ...unknown, gitSha: "" }).success, false);
  assert.equal(schema.safeParse({ ...unknown, dirty: "false" }).success, false);
  assert.equal(schema.safeParse({ ...unknown, dirty: null }).success, false);
});

// ---------------------------------------------------------------- unhappy-3

// Extends "[unhappy-3] malformed version responses are rejected": the spec's bodies.
test("[unhappy-3] the spec's malformed version responses are rejected", () => {
  const { versionResponseSchema: schema } = viaEntry();
  const bodies: unknown[] = [{}, { build: known }, { ...known, gitSha: "" }, null];
  for (const body of bodies) {
    assert.equal(schema.safeParse(body).success, false, JSON.stringify(body));
  }
});

// Extends "[unhappy-3] a version response that is undefined, a list or a JSON string is rejected":
// other wrappings and scalar bodies.
test("[unhappy-3] wrapped, partial and scalar version responses are rejected", () => {
  const { versionResponseSchema: schema } = viaEntry();
  const bodies: unknown[] = [
    { build: unknownBuildInfo },
    { data: known },
    { buildInfo: known, ...{ status: "ok" } },
    { version: "0.3.0" },
    { ...known, gitShortSha: "" },
    { ...known, dirty: "false" },
    "known",
    "0.3.0+a1b2c3d",
    42,
    true,
    [],
  ];
  for (const body of bodies) {
    assert.equal(schema.safeParse(body).success, false, JSON.stringify(body));
  }
});
