import assert from "node:assert/strict";
import { test } from "node:test";

import { envKeys, jiraOAuthConfig, parseEnv } from "../../src/env.js";

/**
 * Hidden suite for the second Atlassian app's two optional variables and
 * `jiraOAuthConfig`. See spec.md.
 */

const DATABASE_URL = "postgres://postgres:postgres@localhost:5432/test";
/** Exactly the 32-character minimum. */
const SECRET = "0123456789abcdef0123456789abcdef";
/** Every required var, as in test/env.test.ts. */
const required = {
  DATABASE_URL,
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "http://localhost:4000",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  ATLASSIAN_CLIENT_ID: "atlassian-client-id",
  ATLASSIAN_CLIENT_SECRET: "atlassian-client-secret",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const jira = {
  JIRA_CLIENT_ID: "jira-client-id",
  JIRA_CLIENT_SECRET: "jira-client-secret",
};

/** The list pinned in test/env-surface.test.ts before this change. */
const keysBefore = [
  "PORT",
  "CORS_ORIGINS",
  "ORIGIN_VERIFY",
  "DATABASE_URL",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_REGION",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "APP_URL",
  "AUTH_COOKIE_DOMAIN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "ATLASSIAN_CLIENT_ID",
  "ATLASSIAN_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "BUILD_VERSION",
  "BUILD_SHA",
  "BUILD_TIME",
  "BUILD_REF",
  "BUILD_DIRTY",
];

// ---- @happy 1 ---------------------------------------------------------------

// Extends "[happy-1] jiraOAuthConfig returns exactly the pair when both Jira
// variables are set": other values, including ones that look like the sign-in
// app's and characters a parser might touch.
test("[happy-1] jiraOAuthConfig returns other credential pairs exactly as given", () => {
  const pairs: Array<[string, string]> = [
    ["atlassian-client-id", "atlassian-client-secret"],
    ["a", "b"],
    ["Zm9vYmFy==", "s3cr3t/+=="],
    ["клиент-🔑", "секрет-ü"],
    ["x".repeat(2048), "y".repeat(4096)],
  ];
  for (const [clientId, clientSecret] of pairs) {
    const env = parseEnv({
      ...required,
      ATLASSIAN_CLIENT_ID: "signin-id",
      ATLASSIAN_CLIENT_SECRET: "signin-secret",
      JIRA_CLIENT_ID: clientId,
      JIRA_CLIENT_SECRET: clientSecret,
    });
    assert.equal(env.JIRA_CLIENT_ID, clientId);
    assert.equal(env.JIRA_CLIENT_SECRET, clientSecret);
    assert.deepEqual(jiraOAuthConfig(env), { clientId, clientSecret });
  }
});

// Extends "[happy-1] jiraOAuthConfig reads the pair of the env it is given":
// the id and the secret are not swapped, and the pair is read from the env
// argument even when it differs from anything parseEnv produced.
test("[happy-1] jiraOAuthConfig maps id to clientId and secret to clientSecret, not the other way", () => {
  const env = parseEnv({
    ...required,
    JIRA_CLIENT_ID: "the-id",
    JIRA_CLIENT_SECRET: "the-secret",
  });
  const result = jiraOAuthConfig(env);
  assert.deepEqual(result, { clientId: "the-id", clientSecret: "the-secret" });
  assert.deepEqual(
    jiraOAuthConfig({
      ...env,
      JIRA_CLIENT_ID: "edited-id",
      JIRA_CLIENT_SECRET: "edited-secret",
    }),
    { clientId: "edited-id", clientSecret: "edited-secret" },
  );
});

// ---- @happy 2 ---------------------------------------------------------------

// Extends "[happy-2] the API boots without the Jira variables": other optional
// variables (S3, cookie domain, build vars) set does not configure Jira.
test("[happy-2] other optional variables set still leave Jira unconfigured", () => {
  const env = parseEnv({
    ...required,
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY_ID: "access",
    S3_SECRET_ACCESS_KEY: "secret",
    AUTH_COOKIE_DOMAIN: "lunox.work",
    ORIGIN_VERIFY: "verify",
    BUILD_SHA: "0123456789abcdef",
  });
  assert.equal(env.JIRA_CLIENT_ID, undefined);
  assert.equal(env.JIRA_CLIENT_SECRET, undefined);
  assert.equal(jiraOAuthConfig(env), undefined);
});

// Extends "[happy-2] Jira variables present as undefined count as unset": a
// lookalike variable name is not read as the Jira app.
test("[happy-2] lookalike variable names do not configure Jira", () => {
  const env = parseEnv({
    ...required,
    ATLASSIAN_JIRA_CLIENT_ID: "jira-client-id",
    ATLASSIAN_JIRA_CLIENT_SECRET: "jira-client-secret",
    jira_client_id: "jira-client-id",
    jira_client_secret: "jira-client-secret",
  });
  assert.equal(env.JIRA_CLIENT_ID, undefined);
  assert.equal(env.JIRA_CLIENT_SECRET, undefined);
  assert.equal(jiraOAuthConfig(env), undefined);
});

// ---- @boundary 1 ------------------------------------------------------------

// Extends "[boundary-1] only JIRA_CLIENT_ID set ...": the set half is empty.
// An empty value counts as set, but its partner is still missing.
test("[boundary-1] an empty half next to a missing half is not configured", () => {
  for (const vars of [
    { JIRA_CLIENT_ID: "" },
    { JIRA_CLIENT_SECRET: "" },
    { JIRA_CLIENT_ID: "", JIRA_CLIENT_SECRET: undefined },
    { JIRA_CLIENT_ID: undefined, JIRA_CLIENT_SECRET: "" },
  ]) {
    let env: ReturnType<typeof parseEnv> | undefined;
    assert.doesNotThrow(() => {
      env = parseEnv({ ...required, ...vars });
    });
    assert.ok(env);
    assert.equal(jiraOAuthConfig(env), undefined, JSON.stringify(vars));
  }
});

// Extends "[boundary-1] only JIRA_CLIENT_SECRET set ...": the half that is set
// is kept on env, even though the pair is not configured.
test("[boundary-1] the set half is kept on env while jiraOAuthConfig is undefined", () => {
  const idOnly = parseEnv({ ...required, JIRA_CLIENT_ID: "only-id" });
  assert.equal(idOnly.JIRA_CLIENT_ID, "only-id");
  assert.equal(idOnly.JIRA_CLIENT_SECRET, undefined);
  assert.equal(jiraOAuthConfig(idOnly), undefined);

  const secretOnly = parseEnv({ ...required, JIRA_CLIENT_SECRET: "only-secret" });
  assert.equal(secretOnly.JIRA_CLIENT_ID, undefined);
  assert.equal(secretOnly.JIRA_CLIENT_SECRET, "only-secret");
  assert.equal(jiraOAuthConfig(secretOnly), undefined);
});

// ---- @boundary 2 ------------------------------------------------------------

// Extends "[boundary-2] one empty Jira variable next to a set one": the empty
// half is kept as "" on env itself, not dropped to undefined.
test("[boundary-2] an empty half is kept on env as an empty string", () => {
  const emptySecret = parseEnv({
    ...required,
    JIRA_CLIENT_ID: "jira-client-id",
    JIRA_CLIENT_SECRET: "",
  });
  assert.equal(emptySecret.JIRA_CLIENT_ID, "jira-client-id");
  assert.equal(emptySecret.JIRA_CLIENT_SECRET, "");
  assert.deepEqual(jiraOAuthConfig(emptySecret), {
    clientId: "jira-client-id",
    clientSecret: "",
  });

  const emptyId = parseEnv({
    ...required,
    JIRA_CLIENT_ID: "",
    JIRA_CLIENT_SECRET: "jira-client-secret",
  });
  assert.equal(emptyId.JIRA_CLIENT_ID, "");
  assert.equal(emptyId.JIRA_CLIENT_SECRET, "jira-client-secret");
  assert.deepEqual(jiraOAuthConfig(emptyId), {
    clientId: "",
    clientSecret: "jira-client-secret",
  });
});

// ---- @boundary 3 ------------------------------------------------------------

// Extends "[boundary-3] Jira credentials are returned verbatim": other
// characters at the edges and inside.
test("[boundary-3] newlines, quotes and padding characters are kept verbatim", () => {
  const cases: Array<[string, string]> = [
    ["\nid\n", "\r\nsecret\r\n"],
    ['"quoted"', "'single'"],
    ["==id==", "secret==="],
    ["undefined", "null"],
    ["  leading", "trailing  "],
    ["a b\tc", " nbsp "],
  ];
  for (const [clientId, clientSecret] of cases) {
    const env = parseEnv({
      ...required,
      JIRA_CLIENT_ID: clientId,
      JIRA_CLIENT_SECRET: clientSecret,
    });
    assert.equal(env.JIRA_CLIENT_ID, clientId);
    assert.equal(env.JIRA_CLIENT_SECRET, clientSecret);
    assert.deepEqual(jiraOAuthConfig(env), { clientId, clientSecret });
  }
});

// ---- @boundary 4 ------------------------------------------------------------

// Extends "[boundary-4] jiraOAuthConfig does not fall back to ATLASSIAN_CLIENT_*":
// other sign-in values, including ones equal to the Jira defaults.
test("[boundary-4] no fallback whatever the sign-in app's values are", () => {
  for (const [id, secret] of [
    ["jira-client-id", "jira-client-secret"],
    ["x", "y"],
  ]) {
    const env = parseEnv({
      ...required,
      ATLASSIAN_CLIENT_ID: id,
      ATLASSIAN_CLIENT_SECRET: secret,
    });
    assert.equal(env.ATLASSIAN_CLIENT_ID, id);
    assert.equal(jiraOAuthConfig(env), undefined);
  }
});

// Extends "[boundary-4] a missing Jira half is not filled in from the sign-in
// app": the Jira pair, when set, wins over the sign-in pair rather than mixing.
test("[boundary-4] a configured Jira pair contains no sign-in value", () => {
  const result = jiraOAuthConfig(
    parseEnv({ ...required, JIRA_CLIENT_ID: "j-id", JIRA_CLIENT_SECRET: "" }),
  );
  assert.deepEqual(result, { clientId: "j-id", clientSecret: "" });
});

// ---- @happy 3 ---------------------------------------------------------------

// Extends "[happy-3] the sign-in app keeps its own credentials when the Jira
// app is set": different sign-in values, a half-set Jira app, and no copying
// in either direction.
test("[happy-3] sign-in and Jira credentials stay apart in both directions", () => {
  const env = parseEnv({
    ...required,
    ATLASSIAN_CLIENT_ID: "signin-id",
    ATLASSIAN_CLIENT_SECRET: "signin-secret",
    JIRA_CLIENT_ID: "connect-id",
    JIRA_CLIENT_SECRET: "connect-secret",
  });
  assert.equal(env.ATLASSIAN_CLIENT_ID, "signin-id");
  assert.equal(env.ATLASSIAN_CLIENT_SECRET, "signin-secret");
  assert.equal(env.JIRA_CLIENT_ID, "connect-id");
  assert.equal(env.JIRA_CLIENT_SECRET, "connect-secret");
  assert.deepEqual(jiraOAuthConfig(env), {
    clientId: "connect-id",
    clientSecret: "connect-secret",
  });
});

test("[happy-3] a half-set Jira app leaves the sign-in credentials untouched", () => {
  const env = parseEnv({ ...required, JIRA_CLIENT_SECRET: "connect-secret" });
  assert.equal(env.ATLASSIAN_CLIENT_ID, "atlassian-client-id");
  assert.equal(env.ATLASSIAN_CLIENT_SECRET, "atlassian-client-secret");
  assert.equal(env.JIRA_CLIENT_SECRET, "connect-secret");
  assert.equal(jiraOAuthConfig(env), undefined);
});

// ---- @unhappy 1 -------------------------------------------------------------

// Extends "[unhappy-1] an empty ATLASSIAN_CLIENT_ID is rejected even with the
// Jira app set": the variable missing entirely, rather than empty. The control
// call shows the same input with the sign-in id present is a configured Jira
// app, so the error is about the sign-in id alone.
test("[unhappy-1] a missing ATLASSIAN_CLIENT_ID is rejected even with the Jira app set", () => {
  const { ATLASSIAN_CLIENT_ID: _omitted, ...rest } = required;
  assert.deepEqual(jiraOAuthConfig(parseEnv({ ...required, ...jira })), {
    clientId: "jira-client-id",
    clientSecret: "jira-client-secret",
  });
  assert.throws(
    () => parseEnv({ ...rest, ...jira }),
    (error: unknown) =>
      error instanceof Error && /ATLASSIAN_CLIENT_ID/.test(error.message),
  );
});

// Extends "[unhappy-1] an empty ATLASSIAN_CLIENT_SECRET keeps its message":
// both sign-in values empty, with empty Jira values too; each keeps its message.
test("[unhappy-1] empty sign-in id and secret both keep their messages next to empty Jira values", () => {
  assert.deepEqual(
    jiraOAuthConfig(
      parseEnv({ ...required, JIRA_CLIENT_ID: "", JIRA_CLIENT_SECRET: "" }),
    ),
    { clientId: "", clientSecret: "" },
  );
  assert.throws(
    () =>
      parseEnv({
        ...required,
        JIRA_CLIENT_ID: "",
        JIRA_CLIENT_SECRET: "",
        ATLASSIAN_CLIENT_ID: "",
        ATLASSIAN_CLIENT_SECRET: "",
      }),
    (error: unknown) =>
      error instanceof Error &&
      /ATLASSIAN_CLIENT_ID is required\./.test(error.message) &&
      /ATLASSIAN_CLIENT_SECRET is required\./.test(error.message),
  );
});

// The sign-in secret missing entirely, with the Jira app set.
test("[unhappy-1] a missing ATLASSIAN_CLIENT_SECRET is rejected even with the Jira app set", () => {
  const { ATLASSIAN_CLIENT_SECRET: _omitted, ...rest } = required;
  assert.equal(parseEnv({ ...required, ...jira }).JIRA_CLIENT_SECRET, "jira-client-secret");
  assert.throws(
    () => parseEnv({ ...rest, ...jira }),
    (error: unknown) =>
      error instanceof Error && /ATLASSIAN_CLIENT_SECRET/.test(error.message),
  );
});

// ---- @happy 4 ---------------------------------------------------------------

// Extends "[happy-4] envKeys is the previous list plus exactly the two Jira
// variables": every previous key is still there, once, and no alternative name
// for the Jira app or a state-signing secret was added.
test("[happy-4] envKeys keeps every previous key once and adds no other Jira name", () => {
  for (const key of keysBefore) {
    assert.equal(
      envKeys.filter((k) => k === key).length,
      1,
      `${key} appears exactly once`,
    );
  }
  assert.equal(envKeys.filter((k) => k === "JIRA_CLIENT_ID").length, 1);
  assert.equal(envKeys.filter((k) => k === "JIRA_CLIENT_SECRET").length, 1);
  for (const key of [
    "ATLASSIAN_JIRA_CLIENT_ID",
    "ATLASSIAN_JIRA_CLIENT_SECRET",
    "JIRA_STATE_SECRET",
  ]) {
    assert.ok(!envKeys.includes(key), `${key} is not read`);
  }
  assert.equal(new Set(envKeys).size, envKeys.length);
});

// The parsed env carries the two new fields and nothing outside envKeys.
test("[happy-4] a parsed env with the Jira app set has no field outside envKeys", () => {
  const env = parseEnv({ ...required, ...jira, JIRA_STATE_SECRET: SECRET });
  assert.equal(env.JIRA_CLIENT_ID, "jira-client-id");
  assert.equal(env.JIRA_CLIENT_SECRET, "jira-client-secret");
  for (const key of Object.keys(env)) {
    assert.ok(envKeys.includes(key), `${key} is in envKeys`);
  }
  assert.ok(!Object.keys(env).includes("JIRA_STATE_SECRET"));
});
