import assert from "node:assert/strict";
import { test } from "node:test";

import {
  githubInstallationSettingsUrl,
  handleSchema,
  membershipSchema,
  organizationSummarySchema,
  registerBoardSchema,
} from "../../src/index.js";

/*
 * Hidden checks on the settings URL helper and on the existing exports.
 */

// Extends "[happy-19] githubInstallationSettingsUrl builds the page for the
// account type": other logins and ids on the organization page.
test("[happy-19] the organization page uses the given login and id", () => {
  for (const [login, id] of [
    ["acme", "1"],
    ["Big-Co", "9999999999999999999"],
    ["octo-org", "7"],
    ["a1", "123456789"],
  ] as const) {
    assert.equal(
      githubInstallationSettingsUrl("Organization", login, id),
      `https://github.com/organizations/${login}/settings/installations/${id}`,
    );
  }
});

// Extends "[happy-19] any account type other than Organization gets the
// personal settings page": other casings and spellings of Organization, and
// the login never appears on the personal page.
test("[happy-19] every other spelling of the account type gets the personal page with that id", () => {
  for (const [accountType, id] of [
    ["ORGANIZATION", "42"],
    ["Organization ", "42"],
    [" Organization", "5"],
    ["Organizations", "6"],
    ["Org", "8"],
    ["User", "9007199254740993"],
    ["Bot", "3"],
  ] as const) {
    const url = githubInstallationSettingsUrl(accountType, "octo-org", id);
    assert.equal(url, `https://github.com/settings/installations/${id}`, accountType);
    assert.equal(url.includes("octo-org"), false);
  }
});

test("[happy-19] the helper's result depends only on its arguments, call after call", () => {
  const first = githubInstallationSettingsUrl("Organization", "acme", "11");
  githubInstallationSettingsUrl("User", "someone", "12");
  assert.equal(githubInstallationSettingsUrl("Organization", "acme", "11"), first);
  assert.equal(first, "https://github.com/organizations/acme/settings/installations/11");
  assert.equal(
    githubInstallationSettingsUrl("User", "acme", "11"),
    "https://github.com/settings/installations/11",
  );
});

// Extends "[happy-20] the organization and Jira contracts still parse as
// before": other values through the same existing schemas.
test("[happy-20] existing organization, membership, board and handle schemas behave as before", () => {
  const personal = organizationSummarySchema.parse({
    id: "org_2",
    name: "Dana",
    slug: "dana",
    kind: "personal",
  });
  assert.equal(personal.kind, "personal");
  assert.equal(
    organizationSummarySchema.safeParse({ id: "", name: "Acme", slug: "acme" }).success,
    false,
  );
  assert.equal(
    membershipSchema.parse({ id: "org_1", name: "Acme", slug: "acme", role: "owner" }).role,
    "owner",
  );
  assert.deepEqual(
    registerBoardSchema.parse({ connectionId: "c1", externalId: "abc", other: 1 }),
    { connectionId: "c1", externalId: "abc" },
  );
  assert.equal(
    registerBoardSchema.safeParse({ connectionId: "", externalId: "10" }).success,
    false,
  );
  assert.equal(handleSchema.parse("Dana"), "dana");
  assert.equal(handleSchema.safeParse("has space").success, false);
});
