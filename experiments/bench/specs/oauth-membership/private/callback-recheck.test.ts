import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  JiraConnectionInput,
  JiraConnectionStore,
  JiraConnectionSummary,
  OrganizationStore,
} from "@sandbox-factory/db";

import type { Auth } from "../../src/auth.js";
import { signState } from "../../src/jira/state.js";
import { createApp, type AppOptions } from "../../src/routes.js";
import { createInMemoryStore } from "../../src/store.js";

/**
 * Hidden suite: the Jira OAuth callback re-checks membership, through the
 * organization store `createApp` was given, before it spends the code.
 */

const dana = { id: "user_1", email: "dana@example.test", name: "Dana" };

const SECRET = "0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "a-different-secret-that-is-long-enough";
const API_URL = "https://api.test";
const APP_URL = "https://app.test";

/** The fixed clock: every state is issued at it, and the routes read it. */
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const TEN_MINUTES = 10 * 60 * 1000;

const FULL_SCOPE =
  "read:jira-work read:jira-user read:board-scope:jira-software read:sprint:jira-software offline_access";

const signedIn = { cookie: "session=1" };

type User = typeof dana;

function fakeAuth(user: User = dana): Auth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) =>
        Promise.resolve(
          headers.get("cookie") !== null
            ? { user, session: { id: `session_${user.id}` } }
            : null,
        ),
    },
    handler: () => Promise.resolve(new Response(null, { status: 404 })),
  } as unknown as Auth;
}

function stateFor(
  organizationId: string,
  options: {
    userId?: string;
    returnTo?: string;
    secret?: string;
    issuedAt?: number;
  } = {},
): string {
  return signState(options.secret ?? SECRET, {
    organizationId,
    userId: options.userId ?? dana.id,
    returnTo: options.returnTo ?? "/settings/jira",
    issuedAt: options.issuedAt ?? NOW,
    nonce: "nonce-1",
  });
}

function callback(query: string): string {
  return `/api/v1/jira/callback?${query}`;
}

function withState(state: string): string {
  return `state=${encodeURIComponent(state)}`;
}

type RoleTable = Record<string, string>;

function key(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

type RoleCalls = Array<[string, string]>;

function organizationStore(
  roleOf: OrganizationStore["roleOf"],
  overrides: Partial<OrganizationStore> = {},
): OrganizationStore {
  return {
    roleOf,
    listForUser: () => Promise.resolve([]),
    get: () => Promise.resolve({ id: "org_1", name: "Acme", slug: "acme" }),
    findBySlug: () => Promise.resolve(undefined),
    slugOwner: () => Promise.resolve(undefined),
    listMembers: () => Promise.resolve([]),
    pendingFor: () => Promise.resolve([]),
    findUserByHandle: () => Promise.resolve(undefined),
    touch: () => Promise.resolve(),
    ...overrides,
  };
}

function fakeOrganizations(
  roles: RoleTable,
  calls: RoleCalls,
  events?: string[],
) {
  return organizationStore((userId, organizationId) => {
    calls.push([userId, organizationId]);
    events?.push("roleOf");
    return Promise.resolve(roles[key(userId, organizationId)]);
  });
}

/** A store whose roleOf only works when called as a method. */
class ThisBoundOrganizations implements OrganizationStore {
  readonly calls: RoleCalls = [];
  constructor(private readonly roles: RoleTable) {}

  roleOf(userId: string, organizationId: string): Promise<string | undefined> {
    this.calls.push([userId, organizationId]);
    return Promise.resolve(this.roles[key(userId, organizationId)]);
  }
  listForUser() {
    return Promise.resolve([]);
  }
  get() {
    return Promise.resolve({ id: "org_1", name: "Acme", slug: "acme" });
  }
  findBySlug() {
    return Promise.resolve(undefined);
  }
  slugOwner() {
    return Promise.resolve(undefined);
  }
  listMembers() {
    return Promise.resolve([]);
  }
  pendingFor() {
    return Promise.resolve([]);
  }
  findUserByHandle() {
    return Promise.resolve(undefined);
  }
  touch() {
    return Promise.resolve();
  }
}

function fakeConnections(
  options: {
    events?: string[] | undefined;
    onUpsert?: ((organizationId: string) => void) | undefined;
  } = {},
): JiraConnectionStore & {
  upserts: Array<[string, JiraConnectionInput]>;
  removed: string[];
} {
  const upserts: Array<[string, JiraConnectionInput]> = [];
  const removed: string[] = [];
  const summary: JiraConnectionSummary = {
    id: "jrc_1",
    cloudId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    email: null,
    healthy: true,
    scopes: ["read:jira-work"],
    createdAt: "2026-09-21T00:00:00.000Z",
  };
  return {
    upserts,
    removed,
    list: () => Promise.resolve([summary]),
    get: () => Promise.resolve(summary),
    upsert: (organizationId, input) => {
      upserts.push([organizationId, input]);
      options.events?.push("upsert");
      options.onUpsert?.(organizationId);
      return Promise.resolve(summary);
    },
    tokens: () => Promise.resolve(null),
    saveTokens: () => Promise.resolve(),
    markUnhealthy: () => Promise.resolve(),
    remove: (_organizationId, id) => {
      removed.push(id);
      return Promise.resolve(id === "jrc_1");
    },
  };
}

function site(cloudId: string) {
  return {
    id: cloudId,
    url: `https://${cloudId}.atlassian.net`,
    name: cloudId,
    scopes: ["read:jira-work"],
  };
}

interface AtlassianOptions {
  sites?: string[] | undefined;
  scope?: string | undefined;
  tokenStatus?: number | undefined;
  onRequest?: ((href: string) => void) | undefined;
  events?: string[] | undefined;
}

function fakeAtlassian(options: AtlassianOptions = {}) {
  const requests: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const href = url instanceof Request ? url.url : String(url);
    requests.push(href);
    options.onRequest?.(href);
    if (href.endsWith("/accessible-resources")) {
      options.events?.push("sites");
      return new Response(
        JSON.stringify((options.sites ?? ["cloud-1"]).map(site)),
        { status: 200 },
      );
    }
    if (href.endsWith("/oauth/token")) {
      options.events?.push("token");
      if (options.tokenStatus !== undefined && options.tokenStatus !== 200) {
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Bad code",
          }),
          { status: options.tokenStatus },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope: options.scope ?? FULL_SCOPE,
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected request to ${href}`);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function jiraOptions(
  connections: JiraConnectionStore,
  fetch: typeof globalThis.fetch,
): NonNullable<AppOptions["jira"]> {
  return {
    connections,
    clientId: "jira-client-id",
    clientSecret: "jira-client-secret",
    secret: SECRET,
    apiUrl: API_URL,
    appUrl: APP_URL,
    fetch,
    now: () => NOW,
  };
}

function appWith(
  options: {
    roles?: RoleTable;
    sites?: string[];
    scope?: string;
    tokenStatus?: number;
    user?: User;
    onRequest?: (href: string, roles: RoleTable) => void;
    onUpsert?: (organizationId: string, roles: RoleTable) => void;
    organizations?: OrganizationStore;
  } = {},
) {
  const roles: RoleTable = options.roles ?? {};
  const roleCalls: RoleCalls = [];
  const events: string[] = [];
  const connections = fakeConnections({
    events,
    onUpsert: (organizationId) => options.onUpsert?.(organizationId, roles),
  });
  const atlassian = fakeAtlassian({
    sites: options.sites,
    scope: options.scope,
    tokenStatus: options.tokenStatus,
    events,
    onRequest: (href) => options.onRequest?.(href, roles),
  });
  const app = createApp({
    store: createInMemoryStore(),
    corsOrigins: [APP_URL],
    auth: fakeAuth(options.user ?? dana),
    organizations:
      options.organizations ?? fakeOrganizations(roles, roleCalls, events),
    jira: jiraOptions(connections, atlassian.fetch),
  });
  return { app, roles, roleCalls, events, connections, atlassian };
}

function get(app: ReturnType<typeof createApp>, path: string) {
  return app.request(path, { headers: signedIn });
}

function locationOf(response: Response): URL {
  return new URL(response.headers.get("location") ?? "");
}

function jiraParam(response: Response): string | null {
  return locationOf(response).searchParams.get("jira");
}

function roleFor(role: string, organizationId = "org_1"): RoleTable {
  return { [key(dana.id, organizationId)]: role };
}

const owner = (organizationId = "org_1"): RoleTable =>
  roleFor("owner", organizationId);

/**
 * Proves a "no roleOf call" assertion is not vacuous: on the same app, a
 * valid callback for org_1 consults the store exactly once more.
 */
async function assertStoreConsultedByValidCallback(
  app: ReturnType<typeof createApp>,
  roleCalls: RoleCalls,
): Promise<Response> {
  const before = roleCalls.length;
  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );
  assert.deepEqual(roleCalls.slice(before), [["user_1", "org_1"]]);
  return response;
}

/** Waits, without a clock, until `condition` holds or the loop gives up. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The state Atlassian would hand back, read from a connect redirect. */
function stateFromConnect(response: Response): string {
  const state = locationOf(response).searchParams.get("state");
  assert.ok(state !== null && state !== "", "connect carried a state");
  return state;
}

// ===========================================================================
// [happy-1] The callback asks the organization store about the state's
// organization.

// Extends public "[happy-1] the callback asks the organization store about
// the state's organization": a different session user, so a hard-coded id
// would show.
test("[happy-1] the store is asked about the session user, whoever that is", async () => {
  const user = { id: "user_7", email: "eve@example.test", name: "Eve" };
  const { app, roleCalls, connections } = appWith({
    user,
    roles: { [key("user_7", "org_4")]: "owner" },
  });

  const response = await get(
    app,
    callback(`code=code-1&${withState(stateFor("org_4", { userId: "user_7" }))}`),
  );

  assert.deepEqual(roleCalls, [["user_7", "org_4"]]);
  assert.equal(
    response.headers.get("location"),
    "https://app.test/settings/jira?jira=connected",
  );
  assert.deepEqual(
    connections.upserts.map(([organizationId]) => organizationId),
    ["org_4"],
  );
});

// Extends public "[happy-1] ...": the lookup happens before the code is spent,
// not merely before the upsert.
test("[happy-1] the store is asked before any request reaches Atlassian", async () => {
  const { app, events } = appWith({ roles: owner() });

  const response = await get(
    app,
    callback(`code=code-1&${withState(stateFor("org_1"))}`),
  );

  assert.equal(jiraParam(response), "connected");
  assert.deepEqual(events, ["roleOf", "token", "sites", "upsert"]);
});

// Extends public "[happy-1] the store is asked about whichever organization
// the state names": other ids, including look-alikes.
for (const organizationId of ["org_10", "org_1_staging", "ORG_1"]) {
  test(`[happy-1] the store is asked about ${organizationId} when the state names it`, async () => {
    const { app, roleCalls, connections } = appWith({
      roles: {
        [key(dana.id, "org_1")]: "owner",
        [key(dana.id, organizationId)]: "admin",
      },
    });

    const response = await get(
      app,
      callback(`code=c&${withState(stateFor(organizationId))}`),
    );

    assert.deepEqual(roleCalls, [["user_1", organizationId]]);
    assert.equal(jiraParam(response), "connected");
    assert.deepEqual(
      connections.upserts.map(([id]) => id),
      [organizationId],
    );
  });
}

// Extends public "[happy-1] ...": the lookup is awaited, not raced.
test("[happy-1] a store that answers several ticks later is awaited before connecting", async () => {
  const roleCalls: RoleCalls = [];
  const organizations = organizationStore(async (userId, organizationId) => {
    roleCalls.push([userId, organizationId]);
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return organizationId === "org_1" ? "admin" : undefined;
  });
  const { app, connections } = appWith({ organizations });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(jiraParam(response), "connected");
  assert.equal(connections.upserts.length, 1);
});

test("[happy-1] a slow store answering no membership is awaited and forbids", async () => {
  const roleCalls: RoleCalls = [];
  const organizations = organizationStore(async (userId, organizationId) => {
    roleCalls.push([userId, organizationId]);
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return undefined;
  });
  const { app, connections, atlassian } = appWith({ organizations });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(jiraParam(response), "forbidden");
  assert.equal(connections.upserts.length, 0);
  assert.deepEqual(atlassian.requests, []);
});

// The exchange's other outcomes are as today, and still preceded by one check.
test("[happy-1] the store is asked once before a grant with no Jira site", async () => {
  const { app, roleCalls, connections } = appWith({
    roles: owner(),
    sites: [],
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1", { returnTo: "/orgs/acme/jira" }))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(
    response.headers.get("location"),
    "https://app.test/orgs/acme/jira?jira=no-sites",
  );
  assert.equal(connections.upserts.length, 0);
});

test("[happy-1] the store is asked once before a grant missing scopes", async () => {
  const { app, roleCalls, connections } = appWith({
    roles: owner(),
    scope: "read:jira-work read:jira-user offline_access",
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(jiraParam(response), "partial-scopes");
  assert.equal(connections.upserts.length, 1);
});

test("[happy-1] the store is asked once before an exchange Atlassian refuses", async () => {
  const { app, roleCalls, connections } = appWith({
    roles: owner(),
    tokenStatus: 400,
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1", { returnTo: "/orgs/acme/jira" }))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(
    response.headers.get("location"),
    "https://app.test/orgs/acme/jira?jira=denied",
  );
  assert.equal(connections.upserts.length, 0);
});

// ===========================================================================
// [happy-2] The organization id comes from the state even when the query
// names another.

// Extends public "[happy-2] the organization id comes from the state even
// when the query names another": other parameter names and a third org.
test("[happy-2] organization-like query parameters of every spelling are ignored", async () => {
  const { app, roleCalls, connections } = appWith({
    roles: { ...owner("org_3"), ...roleFor("member", "org_evil") },
  });

  const response = await get(
    app,
    callback(
      `orgId=org_evil&organizationId=org_evil&org=org_evil&org_id=org_evil&organization=org_evil&code=c&${withState(stateFor("org_3"))}`,
    ),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_3"]]);
  assert.deepEqual(
    connections.upserts.map(([id]) => id),
    ["org_3"],
  );
  assert.equal(jiraParam(response), "connected");
});

// Extends public "[happy-2] a query naming an organization the caller owns
// does not rescue a state for one they do not": the state's org holds a
// plain membership rather than none.
test("[happy-2] a query naming an owned organization does not lift a plain membership in the state's", async () => {
  const { app, roleCalls, connections, atlassian } = appWith({
    roles: { ...owner("org_2"), ...roleFor("member", "org_1") },
  });

  const response = await get(
    app,
    callback(
      `code=c&orgId=org_2&organizationId=org_2&${withState(stateFor("org_1"))}`,
    ),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(jiraParam(response), "forbidden");
  assert.equal(connections.upserts.length, 0);
  assert.deepEqual(atlassian.requests, []);
});

// ===========================================================================
// [happy-3] A role that still allows connecting finishes the flow.

// Extends public "[happy-3] role ... still allows connecting": more shapes of
// a role string with an owner or admin entry. "toString"/"constructor"/
// "__proto__" catch a lookup table that inherits from Object.prototype
// (rankAtLeast would turn those into NaN and refuse).
for (const role of [
  "member,owner,billing",
  "billing,admin",
  "member,,admin",
  ",owner",
  "owner,",
  "admin ,member",
  "member ,   owner   ",
  "owner,owner",
  "Owner,owner",
  "ADMIN,admin",
  "administrator,admin",
  "toString,owner",
  "constructor,admin",
  "__proto__,owner",
  "admin,owner",
]) {
  test(`[happy-3] role ${JSON.stringify(role)} allows connecting`, async () => {
    const { app, connections, roleCalls } = appWith({
      roles: roleFor(role),
    });

    const response = await get(
      app,
      callback(`code=c&${withState(stateFor("org_1"))}`),
    );

    assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "https://app.test/settings/jira?jira=connected",
    );
    assert.equal(connections.upserts.length, 1);
    const [organizationId, input] = connections.upserts[0] ?? [];
    assert.equal(organizationId, "org_1");
    assert.equal(input?.cloudId, "cloud-1");
    assert.equal(input?.refreshToken, "refresh-1");
  });
}

// Extends public "[happy-3] role ... still allows connecting": the outline's
// own examples, with the lookup asserted too.
for (const role of ["owner", "admin", "member,admin", "admin,member", "member, owner"]) {
  test(`[happy-3] outline role ${JSON.stringify(role)} connects after exactly one lookup`, async () => {
    const { app, connections, roleCalls } = appWith({ roles: roleFor(role) });

    const response = await get(
      app,
      callback(`code=c&${withState(stateFor("org_1"))}`),
    );

    assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
    assert.equal(
      response.headers.get("location"),
      "https://app.test/settings/jira?jira=connected",
    );
    assert.deepEqual(
      connections.upserts.map(([id, input]) => [id, input.cloudId, input.refreshToken]),
      [["org_1", "cloud-1", "refresh-1"]],
    );
  });
}

test("[happy-3] an allowed role connects back to the signed returnTo", async () => {
  const { app, connections, roleCalls } = appWith({
    roles: roleFor("member, admin"),
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1", { returnTo: "/orgs/acme/jira" }))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(
    response.headers.get("location"),
    "https://app.test/orgs/acme/jira?jira=connected",
  );
  assert.equal(connections.upserts.length, 1);
});

// ===========================================================================
// [happy-4] Connect still consults the store once, through the membership
// guard.

// Extends public "[happy-4] connect still consults the store once": the
// state connect issues is then redeemed, and only the callback adds a lookup.
test("[happy-4] connect consults the store once, and its own state's callback once more", async () => {
  const { app, roleCalls, connections } = appWith({ roles: roleFor("admin") });

  const started = await get(app, "/api/v1/orgs/org_1/jira/connect");

  assert.equal(started.status, 302);
  assert.equal(locationOf(started).origin, "https://auth.atlassian.com");
  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);

  const finished = await get(
    app,
    callback(`code=c&${withState(stateFromConnect(started))}`),
  );

  assert.deepEqual(roleCalls, [
    ["user_1", "org_1"],
    ["user_1", "org_1"],
  ]);
  assert.equal(jiraParam(finished), "connected");
  assert.deepEqual(
    connections.upserts.map(([id]) => id),
    ["org_1"],
  );
});

test("[happy-4] connect for another organization consults the store once about that one", async () => {
  const { app, roleCalls } = appWith({ roles: owner("org_5") });

  const started = await app.request(
    "/api/v1/orgs/org_5/jira/connect?returnTo=/orgs/five/jira",
    { headers: signedIn },
  );

  assert.equal(started.status, 302);
  assert.equal(locationOf(started).origin, "https://auth.atlassian.com");
  assert.deepEqual(roleCalls, [["user_1", "org_5"]]);

  const finished = await get(
    app,
    callback(`code=c&${withState(stateFromConnect(started))}`),
  );

  assert.deepEqual(roleCalls.slice(1), [["user_1", "org_5"]]);
  assert.equal(
    finished.headers.get("location"),
    "https://app.test/orgs/five/jira?jira=connected",
  );
});

// ===========================================================================
// [boundary-1] A store whose roleOf relies on `this` is called as a method.

// Extends public "[boundary-1] a store whose roleOf relies on `this`": a
// multi-role answer, and the call recorded through `this`.
test("[boundary-1] a `this`-bound store with a multi-role owner connects", async () => {
  const organizations = new ThisBoundOrganizations(roleFor("member, owner"));
  const { app, connections } = appWith({ organizations });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.notEqual(response.status, 500);
  assert.equal(response.status, 302);
  assert.equal(jiraParam(response), "connected");
  assert.deepEqual(organizations.calls, [["user_1", "org_1"]]);
  assert.equal(connections.upserts.length, 1);
});

test("[boundary-1] a `this`-bound store with a demoted member forbids rather than failing", async () => {
  const organizations = new ThisBoundOrganizations(roleFor("member"));
  const { app, connections, atlassian } = appWith({ organizations });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.equal(response.status, 302);
  assert.equal(jiraParam(response), "forbidden");
  assert.deepEqual(organizations.calls, [["user_1", "org_1"]]);
  assert.equal(connections.upserts.length, 0);
  assert.deepEqual(atlassian.requests, []);
});

test("[boundary-1] a `this`-bound store serves both connect and the callback it leads to", async () => {
  const organizations = new ThisBoundOrganizations(roleFor("admin"));
  const { app } = appWith({ organizations });

  const started = await get(app, "/api/v1/orgs/org_1/jira/connect");
  assert.equal(started.status, 302);

  const finished = await get(
    app,
    callback(`code=c&${withState(stateFromConnect(started))}`),
  );

  assert.notEqual(finished.status, 500);
  assert.equal(jiraParam(finished), "connected");
  assert.deepEqual(organizations.calls, [
    ["user_1", "org_1"],
    ["user_1", "org_1"],
  ]);
});

// ===========================================================================
// [boundary-2] A roleOf on the jira options is ignored in favour of the
// store's.

function appWithSmuggledRoleOf(
  roles: RoleTable,
  smuggled: (userId: string, organizationId: string) => Promise<string | undefined>,
) {
  const roleCalls: RoleCalls = [];
  const smuggledCalls: RoleCalls = [];
  const connections = fakeConnections();
  const atlassian = fakeAtlassian();
  const app = createApp({
    store: createInMemoryStore(),
    corsOrigins: [APP_URL],
    auth: fakeAuth(),
    organizations: fakeOrganizations(roles, roleCalls),
    jira: {
      ...jiraOptions(connections, atlassian.fetch),
      roleOf: (userId: string, organizationId: string) => {
        smuggledCalls.push([userId, organizationId]);
        return smuggled(userId, organizationId);
      },
    } as AppOptions["jira"],
  });
  return { app, roleCalls, smuggledCalls, connections, atlassian };
}

// Extends public "[boundary-2] a roleOf on the jira options is ignored": the
// store says "member" rather than nothing.
test("[boundary-2] a smuggled owner answer does not lift the store's plain membership", async () => {
  const { app, roleCalls, smuggledCalls, connections, atlassian } =
    appWithSmuggledRoleOf(roleFor("member"), () => Promise.resolve("owner"));

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(smuggledCalls, []);
  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(response.status, 302);
  assert.equal(jiraParam(response), "forbidden");
  assert.equal(connections.upserts.length, 0);
  assert.deepEqual(atlassian.requests, []);
});

test("[boundary-2] a smuggled roleOf that would reject is never reached", async () => {
  const { app, roleCalls, smuggledCalls, connections } = appWithSmuggledRoleOf(
    owner(),
    () => Promise.reject(new Error("smuggled roleOf was called")),
  );

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(smuggledCalls, []);
  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(response.status, 302);
  assert.equal(jiraParam(response), "connected");
  assert.equal(connections.upserts.length, 1);
});

test("[boundary-2] a smuggled owner answer does not turn a missing code from forbidden into error", async () => {
  const { app, roleCalls, smuggledCalls } = appWithSmuggledRoleOf(
    {},
    () => Promise.resolve("owner"),
  );

  const response = await get(app, callback(withState(stateFor("org_1"))));

  assert.deepEqual(smuggledCalls, []);
  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(jiraParam(response), "forbidden");
});

test("[boundary-2] a smuggled roleOf is not called by connect either", async () => {
  const { app, roleCalls, smuggledCalls } = appWithSmuggledRoleOf(
    {},
    () => Promise.resolve("owner"),
  );

  const started = await get(app, "/api/v1/orgs/org_1/jira/connect");
  const finished = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.equal(started.status, 404);
  assert.equal(jiraParam(finished), "forbidden");
  assert.deepEqual(smuggledCalls, []);
  assert.deepEqual(roleCalls, [
    ["user_1", "org_1"],
    ["user_1", "org_1"],
  ]);
});

// ===========================================================================
// [boundary-3] An empty role string is not a role.

// Extends public "[boundary-3] an empty role string is not a role": other
// role strings with no entry in them.
for (const role of ["", " ", "   ", ",", ",,,", " , , "]) {
  test(`[boundary-3] role ${JSON.stringify(role)} with a code is forbidden`, async () => {
    const { app, connections, atlassian, roleCalls } = appWith({
      roles: roleFor(role),
    });

    const response = await get(
      app,
      callback(`code=c&${withState(stateFor("org_1"))}`),
    );

    assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
    assert.equal(
      response.headers.get("location"),
      "https://app.test/settings/jira?jira=forbidden",
    );
    assert.equal(connections.upserts.length, 0);
    assert.deepEqual(atlassian.requests, []);
  });
}

test("[boundary-3] an empty role with no code is forbidden, not error", async () => {
  const { app, connections, roleCalls } = appWith({ roles: roleFor("") });

  const response = await get(app, callback(withState(stateFor("org_1"))));

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(jiraParam(response), "forbidden");
  assert.equal(connections.upserts.length, 0);
});

test("[boundary-3] an empty role's forbidden redirect honours the signed returnTo", async () => {
  const { app } = appWith({ roles: roleFor("") });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1", { returnTo: "/orgs/acme/jira" }))}`),
  );

  assert.equal(
    response.headers.get("location"),
    "https://app.test/orgs/acme/jira?jira=forbidden",
  );
});

// ===========================================================================
// [boundary-4] Atlassian's own refusal is reported without asking the store.

// Extends public "[boundary-4] Atlassian's own refusal is reported ...":
// other error values, alongside valid and invalid states, an owner in the
// table, and a signed returnTo the refusal must not use. Each is followed by
// a valid callback so the zero is not vacuous.
for (const [label, query, outcome] of [
  [
    "access_denied with an owner's valid state and a returnTo",
    `error=access_denied&code=c&${withState(stateFor("org_1", { returnTo: "/orgs/acme/jira" }))}`,
    "cancelled",
  ],
  [
    "server_error with a description, a valid state and a returnTo",
    `error=server_error&error_description=Oops&code=c&${withState(stateFor("org_1", { returnTo: "/orgs/acme/jira" }))}`,
    "error",
  ],
  [
    "an empty error with a valid state and code",
    `error=&code=c&${withState(stateFor("org_1"))}`,
    "error",
  ],
  [
    "access_denied with a state from another secret",
    `error=access_denied&code=c&${withState(stateFor("org_1", { secret: OTHER_SECRET }))}`,
    "cancelled",
  ],
  [
    "invalid_request with a valid state for another organization",
    `error=invalid_request&${withState(stateFor("org_2"))}`,
    "error",
  ],
  ["Access_Denied, which is not the cancel value", "error=Access_Denied", "error"],
] as const) {
  test(`[boundary-4] ${label} is ${outcome} and asks nothing`, async () => {
    const { app, roleCalls, connections, atlassian } = appWith({
      roles: { ...owner("org_1"), ...owner("org_2") },
    });

    const response = await get(app, callback(query));

    assert.equal(
      response.headers.get("location"),
      `https://app.test/settings/jira?jira=${outcome}`,
    );
    assert.deepEqual(roleCalls, []);
    assert.deepEqual(atlassian.requests, []);
    assert.equal(connections.upserts.length, 0);

    await assertStoreConsultedByValidCallback(app, roleCalls);
  });
}

// ===========================================================================
// [boundary-5] A refused state is reported without asking the store.

function swappedPayload(): string {
  const forOrg1 = stateFor("org_1");
  const forOrg2 = stateFor("org_2");
  const signature = forOrg1.slice(forOrg1.lastIndexOf(".") + 1);
  const body = forOrg2.slice(0, forOrg2.lastIndexOf("."));
  return `${body}.${signature}`;
}

// Extends public "[boundary-5] a refused state is reported without asking the
// store": other ways a state fails, with a non-member table too (the answer
// must be "state", not "forbidden"), and a follow-up valid callback.
for (const [label, statePart, roles] of [
  ["a garbage state", "&state=not-a-state", owner()],
  ["a state of only a separator", "&state=.", owner()],
  ["a payload swapped under another state's signature", `&${withState(swappedPayload())}`, owner()],
  [
    "a state issued exactly ten minutes and one millisecond ago",
    `&${withState(stateFor("org_1", { issuedAt: NOW - TEN_MINUTES - 1 }))}`,
    owner(),
  ],
  [
    "a state issued more than a minute in the future",
    `&${withState(stateFor("org_1", { issuedAt: NOW + 60_001 }))}`,
    owner(),
  ],
  [
    "a state for another user who does own the organization",
    `&${withState(stateFor("org_1", { userId: "user_2" }))}`,
    { ...owner(), [key("user_2", "org_1")]: "owner" },
  ],
  [
    "a state from another secret, for a caller with no membership",
    `&${withState(stateFor("org_1", { secret: OTHER_SECRET }))}`,
    {},
  ],
  ["no state, for a caller with no membership", "", {}],
] as const) {
  test(`[boundary-5] ${label} is refused as state without asking the store`, async () => {
    const { app, roleCalls, connections, atlassian } = appWith({
      roles: { ...roles },
    });

    const response = await get(app, callback(`code=c${statePart}`));

    assert.equal(
      response.headers.get("location"),
      "https://app.test/settings/jira?jira=state",
    );
    assert.deepEqual(roleCalls, []);
    assert.equal(connections.upserts.length, 0);
    assert.deepEqual(atlassian.requests, []);

    await assertStoreConsultedByValidCallback(app, roleCalls);
  });
}

test("[boundary-5] a state issued exactly ten minutes ago is still accepted and checked", async () => {
  const { app, roleCalls } = appWith({ roles: {} });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1", { issuedAt: NOW - TEN_MINUTES }))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(jiraParam(response), "forbidden");
});

// ===========================================================================
// [boundary-6] With a valid state and no code, membership decides the
// outcome first.

// Extends public "[boundary-6] with a valid state and no code, membership
// decides first": other roles and code parts, and the signed returnTo.
for (const [label, roles, codePart, outcome] of [
  ['"billing", no code', roleFor("billing"), "", "forbidden"],
  ['"", an empty code', roleFor(""), "&code=", "forbidden"],
  ['"ADMIN", an empty code', roleFor("ADMIN"), "&code=", "forbidden"],
  ['"administrator", no code', roleFor("administrator"), "", "forbidden"],
  ["owner of another org only, no code", owner("org_2"), "", "forbidden"],
  ['"admin", no code', roleFor("admin"), "", "error"],
  ['"member,admin", an empty code', roleFor("member,admin"), "&code=", "error"],
  ['"member, owner", no code', roleFor("member, owner"), "", "error"],
] as const) {
  test(`[boundary-6] no code: ${label} is ${outcome}`, async () => {
    const { app, roleCalls, atlassian, connections } = appWith({
      roles: { ...roles },
    });

    const response = await get(
      app,
      callback(`${withState(stateFor("org_1"))}${codePart}`),
    );

    assert.equal(
      response.headers.get("location"),
      `https://app.test/settings/jira?jira=${outcome}`,
    );
    assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
    assert.deepEqual(atlassian.requests, []);
    assert.equal(connections.upserts.length, 0);
  });
}

test("[boundary-6] a non-member with no code is forbidden at the signed returnTo", async () => {
  const { app, roleCalls } = appWith({ roles: {} });

  const response = await get(
    app,
    callback(withState(stateFor("org_1", { returnTo: "/orgs/acme/jira" }))),
  );

  assert.equal(
    response.headers.get("location"),
    "https://app.test/orgs/acme/jira?jira=forbidden",
  );
  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
});

test("[boundary-6] an owner with no code is an error at the signed returnTo, after one lookup", async () => {
  const { app, roleCalls } = appWith({ roles: owner() });

  const response = await get(
    app,
    callback(`code=&${withState(stateFor("org_1", { returnTo: "/orgs/acme/jira" }))}`),
  );

  assert.equal(
    response.headers.get("location"),
    "https://app.test/orgs/acme/jira?jira=error",
  );
  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
});

test("[boundary-6] a `this`-bound store decides a missing code as a method", async () => {
  const organizations = new ThisBoundOrganizations(owner());
  const { app, atlassian } = appWith({ organizations });

  const response = await get(app, callback(withState(stateFor("org_1"))));

  assert.equal(jiraParam(response), "error");
  assert.deepEqual(organizations.calls, [["user_1", "org_1"]]);
  assert.deepEqual(atlassian.requests, []);
});

// ===========================================================================
// [boundary-7] A grant covering two sites checks membership once and stores
// both.

// Extends public "[boundary-7] a grant covering two sites ...": more sites, a
// multi-role caller, and the order of the upserts.
test("[boundary-7] a grant covering five sites checks membership once and stores all in order", async () => {
  const cloudIds = ["cloud-1", "cloud-2", "cloud-3", "cloud-4", "cloud-5"];
  const { app, roleCalls, connections, events } = appWith({
    roles: roleFor("member,owner"),
    sites: cloudIds,
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.deepEqual(
    connections.upserts.map(([id, input]) => [id, input.cloudId]),
    cloudIds.map((cloudId) => ["org_1", cloudId]),
  );
  assert.equal(events.filter((event) => event === "roleOf").length, 1);
  assert.equal(events[0], "roleOf");
  assert.equal(jiraParam(response), "connected");
});

test("[boundary-7] a grant covering two sites for another organization checks that one once", async () => {
  const { app, roleCalls, connections } = appWith({
    roles: roleFor("admin", "org_8"),
    sites: ["cloud-b", "cloud-a"],
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_8"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_8"]]);
  assert.deepEqual(
    connections.upserts.map(([id, input]) => [id, input.cloudId]),
    [
      ["org_8", "cloud-b"],
      ["org_8", "cloud-a"],
    ],
  );
  assert.equal(jiraParam(response), "connected");
});

// ===========================================================================
// [boundary-8] Without both stores the callback is not mounted.

function appMissing(absent: "jira" | "organizations") {
  const roleCalls: RoleCalls = [];
  const connections = fakeConnections();
  const atlassian = fakeAtlassian();
  const app = createApp({
    store: createInMemoryStore(),
    corsOrigins: [APP_URL],
    auth: fakeAuth(),
    ...(absent === "organizations"
      ? {}
      : { organizations: fakeOrganizations(owner(), roleCalls) }),
    ...(absent === "jira"
      ? {}
      : { jira: jiraOptions(connections, atlassian.fetch) }),
  });
  return { app, connections, atlassian };
}

// Extends public "[boundary-8] with ... the callback is not mounted": other
// callback queries, and a control app with both that refuses the same
// non-member by redirect rather than 404.
for (const absent of ["jira", "organizations"] as const) {
  test(`[boundary-8] without ${absent}, every callback query is a 404 while an app with both redirects`, async () => {
    const { app, connections, atlassian } = appMissing(absent);

    for (const query of [
      `code=c&${withState(stateFor("org_1"))}`,
      withState(stateFor("org_1")),
      "error=access_denied",
      "",
    ]) {
      const response = await get(app, callback(query));
      assert.equal(response.status, 404, query);
      assert.deepEqual(await response.json(), { error: "Not found." });
    }
    assert.equal(connections.upserts.length, 0);
    assert.deepEqual(atlassian.requests, []);

    const both = appWith({ roles: {} });
    const control = await get(
      both.app,
      callback(`code=c&${withState(stateFor("org_1"))}`),
    );
    assert.equal(control.status, 302);
    assert.equal(jiraParam(control), "forbidden");
  });
}

test("[boundary-8] without organizations, connect and list are 404 too, while an app with both forbids at the callback", async () => {
  const { app } = appMissing("organizations");

  for (const path of [
    "/api/v1/orgs/org_1/jira/connect",
    "/api/v1/orgs/org_1/jira/connections",
  ]) {
    const response = await get(app, path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "Not found." });
  }

  const both = appWith({ roles: roleFor("member") });
  const control = await get(
    both.app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );
  assert.equal(jiraParam(control), "forbidden");
});

// ===========================================================================
// [unhappy-1] Removed from the organization after starting the flow.

// Extends public "[unhappy-1] a caller removed from the organization after
// starting the flow is forbidden": the flow is really started by connect,
// then the membership row is deleted.
test("[unhappy-1] a caller removed between connect and the callback is forbidden", async () => {
  const { app, roles, roleCalls, connections, atlassian } = appWith({
    roles: owner(),
  });

  const started = await get(app, "/api/v1/orgs/org_1/jira/connect");
  assert.equal(started.status, 302);
  delete roles[key(dana.id, "org_1")];

  const response = await get(
    app,
    callback(`code=code-1&${withState(stateFromConnect(started))}`),
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://app.test/settings/jira?jira=forbidden",
  );
  assert.deepEqual(roleCalls, [
    ["user_1", "org_1"],
    ["user_1", "org_1"],
  ]);
  assert.deepEqual(atlassian.requests, []);
  assert.equal(connections.upserts.length, 0);
});

// Extends public "[unhappy-1] ...": the store's other methods claim the
// caller belongs, but roleOf is what decides.
test("[unhappy-1] other store methods vouching for the caller do not override roleOf's undefined", async () => {
  const roleCalls: RoleCalls = [];
  const organizations = organizationStore(
    (userId, organizationId) => {
      roleCalls.push([userId, organizationId]);
      return Promise.resolve(undefined);
    },
    {
      listForUser: () =>
        Promise.resolve([
          { id: "org_1", name: "Acme", slug: "acme", role: "owner" },
        ]) as ReturnType<OrganizationStore["listForUser"]>,
      listMembers: () =>
        Promise.resolve([
          { userId: "user_1", role: "owner" },
        ]) as unknown as ReturnType<OrganizationStore["listMembers"]>,
    },
  );
  const { app, connections, atlassian } = appWith({ organizations });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(
    response.headers.get("location"),
    "https://app.test/settings/jira?jira=forbidden",
  );
  assert.deepEqual(atlassian.requests, []);
  assert.equal(connections.upserts.length, 0);
});

test("[unhappy-1] a removed caller with a long code is forbidden without spending it", async () => {
  const { app, connections, atlassian } = appWith({
    roles: { [key("user_10", "org_1")]: "owner", [key(dana.id, "org_10")]: "owner" },
  });

  const response = await get(
    app,
    callback(`code=${"x".repeat(512)}&${withState(stateFor("org_1"))}`),
  );

  assert.equal(
    response.headers.get("location"),
    "https://app.test/settings/jira?jira=forbidden",
  );
  assert.deepEqual(atlassian.requests, []);
  assert.equal(connections.upserts.length, 0);
});

// ===========================================================================
// [unhappy-2] The forbidden redirect honours the signed returnTo.

// Extends public "[unhappy-2] the forbidden redirect honours the signed
// returnTo": other paths, and other reasons for the refusal.
for (const [label, roles, returnTo] of [
  ["removed", {}, "/orgs/globex/settings/integrations"],
  ["removed", {}, "/"],
  ["demoted to billing", roleFor("billing"), "/a/b/c/d/e"],
  ["case-mismatched", roleFor("ADMIN"), "/orgs/acme/jira"],
  ["owner elsewhere", owner("org_2"), "/orgs/acme/jira"],
] as const) {
  test(`[unhappy-2] a ${label} caller is forbidden at returnTo ${returnTo}`, async () => {
    const { app, roleCalls } = appWith({ roles: { ...roles } });

    const response = await get(
      app,
      callback(`code=c&${withState(stateFor("org_1", { returnTo }))}`),
    );

    assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
    assert.equal(response.status, 302);
    const location = locationOf(response);
    assert.equal(location.origin, "https://app.test");
    assert.equal(location.pathname, returnTo);
    assert.equal(location.search, "?jira=forbidden");
    assert.equal(location.searchParams.has("missing"), false);
  });
}

test("[unhappy-2] a returnTo chosen at connect is where a later removal is reported", async () => {
  const { app, roles } = appWith({ roles: owner() });

  const started = await get(
    app,
    "/api/v1/orgs/org_1/jira/connect?returnTo=/orgs/acme/jira",
  );
  delete roles[key(dana.id, "org_1")];

  const response = await get(
    app,
    callback(`code=c&${withState(stateFromConnect(started))}`),
  );

  assert.equal(
    response.headers.get("location"),
    "https://app.test/orgs/acme/jira?jira=forbidden",
  );
});

// ===========================================================================
// [unhappy-3] A member of another organization only cannot complete a flow
// for this one.

// Extends public "[unhappy-3] a member of another organization only ...":
// several other organizations, and only the state's is asked about.
test("[unhappy-3] owning and administering several other organizations does not reach this one", async () => {
  const { app, roleCalls, connections, atlassian } = appWith({
    roles: {
      ...owner("org_2"),
      ...roleFor("admin", "org_3"),
      ...roleFor("owner,admin", "org_10"),
      [key(dana.id, "org_1 ")]: "owner",
    },
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(jiraParam(response), "forbidden");
  assert.equal(connections.upserts.length, 0);
  assert.deepEqual(atlassian.requests, []);
});

test("[unhappy-3] an owner of org_1 holding a state for org_2 cannot complete it", async () => {
  const { app, roleCalls, connections } = appWith({ roles: owner("org_1") });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_2"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_2"]]);
  assert.equal(jiraParam(response), "forbidden");
  assert.equal(connections.upserts.length, 0);
});

// ===========================================================================
// [unhappy-4] A role that does not allow connecting is forbidden.

// Extends public "[unhappy-4] role ... is forbidden": more roles a shortcut
// would admit — substring and word-boundary matches, other separators,
// other casings, and keys inherited from Object.prototype.
for (const role of [
  "guest",
  "owners",
  "admins",
  "superadmin",
  "co-owner",
  "admin-readonly",
  "owner:read",
  "owner.",
  "Admin",
  "OWNER",
  "oWnEr",
  "member,Admin",
  "member,OWNER",
  "member;owner",
  "owner|admin",
  "owner/admin",
  "admin member",
  "member , billing",
  "member,administrator",
  "readonly-owner",
  "toString",
  "constructor",
  "__proto__",
  "hasOwnProperty,valueOf",
  "\"owner\"",
  "[owner]",
]) {
  test(`[unhappy-4] role ${JSON.stringify(role)} is forbidden`, async () => {
    const { app, connections, atlassian, roleCalls } = appWith({
      roles: roleFor(role),
    });

    const response = await get(
      app,
      callback(`code=c&${withState(stateFor("org_1"))}`),
    );

    assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "https://app.test/settings/jira?jira=forbidden",
    );
    assert.deepEqual(atlassian.requests, []);
    assert.equal(connections.upserts.length, 0);
  });
}

// Extends public "[unhappy-4] ...": a demotion after a real connect.
test("[unhappy-4] an owner demoted to member between connect and the callback is forbidden", async () => {
  const { app, roles, connections, atlassian } = appWith({ roles: owner() });

  const started = await get(app, "/api/v1/orgs/org_1/jira/connect");
  assert.equal(started.status, 302);
  roles[key(dana.id, "org_1")] = "member";

  const response = await get(
    app,
    callback(`code=c&${withState(stateFromConnect(started))}`),
  );

  assert.equal(
    response.headers.get("location"),
    "https://app.test/settings/jira?jira=forbidden",
  );
  assert.deepEqual(atlassian.requests, []);
  assert.equal(connections.upserts.length, 0);
});

// ===========================================================================
// [unhappy-5] roleOf rejects.

function appWithStore(roleOf: OrganizationStore["roleOf"]) {
  const connections = fakeConnections();
  const atlassian = fakeAtlassian();
  const app = createApp({
    store: createInMemoryStore(),
    corsOrigins: [APP_URL],
    auth: fakeAuth(),
    organizations: organizationStore(roleOf),
    jira: jiraOptions(connections, atlassian.fetch),
  });
  return { app, connections, atlassian };
}

// Extends public "[unhappy-5] a roleOf that rejects is a 500": other errors,
// a rejection after some ticks, and a signed returnTo that must not turn the
// failure into a redirect.
for (const [label, reject] of [
  ["a TypeError", () => Promise.reject(new TypeError("cannot read rows"))],
  ["an error with no message", () => Promise.reject(new Error())],
  [
    "a rejection several ticks later",
    async () => {
      for (let i = 0; i < 5; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error("connection reset");
    },
  ],
] as const) {
  test(`[unhappy-5] roleOf rejecting with ${label} is a 500 and nothing reaches Atlassian`, async () => {
    const calls: RoleCalls = [];
    const { app, connections, atlassian } = appWithStore((userId, organizationId) => {
      calls.push([userId, organizationId]);
      return reject();
    });

    const response = await get(
      app,
      callback(`code=c&${withState(stateFor("org_1", { returnTo: "/orgs/acme/jira" }))}`),
    );

    assert.deepEqual(calls, [["user_1", "org_1"]]);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("location"), null);
    assert.deepEqual(await response.json(), { error: "Internal server error." });
    assert.deepEqual(atlassian.requests, []);
    assert.equal(connections.upserts.length, 0);
  });
}

test("[unhappy-5] roleOf rejecting for one organization fails only that organization's callback", async () => {
  const { app, connections, atlassian } = appWithStore((_userId, organizationId) =>
    organizationId === "org_2"
      ? Promise.reject(new Error("database is on fire"))
      : Promise.resolve("owner"),
  );

  const failed = await get(
    app,
    callback(`code=c&${withState(stateFor("org_2"))}`),
  );
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "Internal server error." });
  assert.deepEqual(atlassian.requests, []);
  assert.equal(connections.upserts.length, 0);

  const succeeded = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );
  assert.equal(jiraParam(succeeded), "connected");
  assert.deepEqual(
    connections.upserts.map(([id]) => id),
    ["org_1"],
  );
});

test("[unhappy-5] roleOf rejecting with an empty code is a 500, not an error redirect", async () => {
  const { app, connections, atlassian } = appWithStore(() =>
    Promise.reject(new Error("database is on fire")),
  );

  const response = await get(
    app,
    callback(`code=&${withState(stateFor("org_1"))}`),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal server error." });
  assert.deepEqual(atlassian.requests, []);
  assert.equal(connections.upserts.length, 0);
});

// ===========================================================================
// [unhappy-6] Connect and disconnect refusals are unchanged.

// Extends public "[unhappy-6] a plain member's ... is still ...": other
// refused roles, the store and Atlassian untouched, the list body intact —
// and the same member's callback refused too, so the refusal is not only
// the guard's.
test("[unhappy-6] refused connect and disconnect leave Atlassian and the store untouched, and the callback agrees", async () => {
  const { app, roleCalls, connections, atlassian, roles } = appWith({
    roles: roleFor("member"),
  });

  for (const [method, path, status] of [
    ["GET", "/api/v1/orgs/org_1/jira/connect", 403],
    ["DELETE", "/api/v1/orgs/org_1/jira/connections/jrc_1", 403],
    ["GET", "/api/v1/orgs/org_2/jira/connect", 404],
    ["DELETE", "/api/v1/orgs/org_2/jira/connections/jrc_1", 404],
    ["GET", "/api/v1/orgs/org_1/jira/connections", 200],
  ] as const) {
    const response = await app.request(path, { method, headers: signedIn });
    assert.equal(response.status, status, `${method} ${path}`);
  }
  assert.deepEqual(connections.removed, []);
  assert.deepEqual(atlassian.requests, []);
  assert.equal(roleCalls.length, 5);

  roles[key(dana.id, "org_1")] = "billing";
  const refused = await get(app, "/api/v1/orgs/org_1/jira/connect");
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {
    error: "Only an owner or admin may connect Jira.",
  });

  const callbackResponse = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );
  assert.equal(jiraParam(callbackResponse), "forbidden");
  assert.deepEqual(roleCalls.slice(6), [["user_1", "org_1"]]);
  assert.equal(connections.upserts.length, 0);
});

test("[unhappy-6] a case-mismatched owner is refused at connect, list still works, and the callback agrees", async () => {
  const { app, roleCalls } = appWith({ roles: roleFor("Owner") });

  const connect = await get(app, "/api/v1/orgs/org_1/jira/connect");
  assert.equal(connect.status, 403);
  const disconnect = await app.request(
    "/api/v1/orgs/org_1/jira/connections/jrc_1",
    { method: "DELETE", headers: signedIn },
  );
  assert.equal(disconnect.status, 403);
  const list = await get(app, "/api/v1/orgs/org_1/jira/connections");
  assert.equal(list.status, 200);

  const callbackResponse = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );
  assert.equal(jiraParam(callbackResponse), "forbidden");
  assert.equal(roleCalls.length, 4);
});

// ===========================================================================
// [unhappy-7] A callback without a session is still a 401 and asks nothing.

// Extends public "[unhappy-7] a callback without a session is still a 401":
// other callback queries, and a follow-up signed-in request proving the
// store is otherwise consulted.
for (const [label, query] of [
  ["no code", withState(stateFor("org_1"))],
  ["a state for another organization", `code=c&${withState(stateFor("org_2"))}`],
  ["nothing at all", ""],
  ["an Atlassian error with a valid state", `error=server_error&${withState(stateFor("org_1"))}`],
] as const) {
  test(`[unhappy-7] a callback with ${label} and no session is a 401 and asks nothing`, async () => {
    const { app, roleCalls, connections, atlassian } = appWith({
      roles: { ...owner("org_1"), ...owner("org_2") },
    });

    const response = await app.request(callback(query));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Authentication required.",
    });
    assert.deepEqual(roleCalls, []);
    assert.deepEqual(atlassian.requests, []);
    assert.equal(connections.upserts.length, 0);

    const control = await assertStoreConsultedByValidCallback(app, roleCalls);
    assert.equal(jiraParam(control), "connected");
  });
}

// ===========================================================================
// [concurrency-1] Membership revoked while the token exchange is in flight
// does not stop the flow.

// Extends public "[concurrency-1] membership revoked while the token
// exchange is in flight": an admin demoted mid-exchange, a revocation during
// the site list with several sites, and one during the first upsert.
test("[concurrency-1] an admin demoted to member during the token exchange still connects", async () => {
  const { app, roleCalls, connections } = appWith({
    roles: roleFor("admin"),
    onRequest: (href, roles) => {
      if (href.endsWith("/oauth/token")) {
        roles[key(dana.id, "org_1")] = "member";
      }
    },
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.deepEqual(
    connections.upserts.map(([id]) => id),
    ["org_1"],
  );
  assert.equal(jiraParam(response), "connected");
});

test("[concurrency-1] a removal while three sites are listed still stores all three", async () => {
  const { app, roleCalls, connections } = appWith({
    roles: owner(),
    sites: ["cloud-1", "cloud-2", "cloud-3"],
    onRequest: (href, roles) => {
      if (href.endsWith("/accessible-resources")) {
        delete roles[key(dana.id, "org_1")];
      }
    },
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.deepEqual(
    connections.upserts.map(([id, input]) => [id, input.cloudId]),
    [
      ["org_1", "cloud-1"],
      ["org_1", "cloud-2"],
      ["org_1", "cloud-3"],
    ],
  );
  assert.equal(jiraParam(response), "connected");
});

test("[concurrency-1] a removal landing during the first upsert does not stop the second", async () => {
  const { app, roleCalls, connections } = appWith({
    roles: owner(),
    sites: ["cloud-1", "cloud-2"],
    onUpsert: (_organizationId, roles) => {
      delete roles[key(dana.id, "org_1")];
    },
  });

  const response = await get(
    app,
    callback(`code=c&${withState(stateFor("org_1"))}`),
  );

  assert.deepEqual(roleCalls, [["user_1", "org_1"]]);
  assert.equal(connections.upserts.length, 2);
  assert.equal(jiraParam(response), "connected");
});

// ===========================================================================
// [concurrency-2] Overlapping callbacks for two organizations are each
// decided by their own organization.

/**
 * A store whose answers are held until released, so a test can choose the
 * order in which overlapping lookups resolve. The answer is read from the
 * table at release time.
 */
function gatedOrganizations(roles: RoleTable) {
  const calls: RoleCalls = [];
  const pending: Array<{ organizationId: string; resolve: () => void }> = [];
  const store = organizationStore(
    (userId, organizationId) =>
      new Promise<string | undefined>((resolve) => {
        calls.push([userId, organizationId]);
        pending.push({
          organizationId,
          resolve: () => resolve(roles[key(userId, organizationId)]),
        });
      }),
  );
  const release = (organizationId: string) => {
    for (const entry of pending.filter((p) => p.organizationId === organizationId)) {
      pending.splice(pending.indexOf(entry), 1);
      entry.resolve();
    }
  };
  const releaseOne = () => {
    pending.shift()?.resolve();
  };
  const releaseAll = () => {
    for (const entry of pending.splice(0)) entry.resolve();
  };
  return { store, calls, release, releaseOne, releaseAll };
}

function sortedCalls(calls: RoleCalls): RoleCalls {
  return [...calls].sort((a, b) => a.join(":").localeCompare(b.join(":")));
}

// Extends public "[concurrency-2] overlapping callbacks for two
// organizations": the lookups resolve in the reverse of the request order.
test("[concurrency-2] overlapping callbacks resolved out of order are each decided by their own organization", async () => {
  const gated = gatedOrganizations(owner("org_1"));
  const { app, connections } = appWith({ organizations: gated.store });

  const first = get(app, callback(`code=c1&${withState(stateFor("org_1"))}`));
  const second = get(app, callback(`code=c2&${withState(stateFor("org_2"))}`));
  await until(() => gated.calls.length >= 2);
  gated.release("org_2");
  // Let the org_2 request run on before org_1's answer arrives.
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  gated.release("org_1");
  gated.releaseAll();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(jiraParam(firstResponse), "connected");
  assert.equal(jiraParam(secondResponse), "forbidden");
  assert.deepEqual(
    connections.upserts.map(([id]) => id),
    ["org_1"],
  );
  assert.deepEqual(sortedCalls(gated.calls), [
    ["user_1", "org_1"],
    ["user_1", "org_2"],
  ]);
});

test("[concurrency-2] three overlapping callbacks are each decided by their own organization", async () => {
  const gated = gatedOrganizations({
    ...owner("org_1"),
    ...roleFor("member", "org_2"),
    ...roleFor("admin", "org_3"),
  });
  const { app, connections, atlassian } = appWith({ organizations: gated.store });

  const pendingResponses = ["org_1", "org_2", "org_3"].map((organizationId, i) =>
    get(app, callback(`code=c${i + 1}&${withState(stateFor(organizationId))}`)),
  );
  await until(() => gated.calls.length >= 3);
  gated.release("org_3");
  gated.release("org_2");
  gated.release("org_1");
  gated.releaseAll();
  const responses = await Promise.all(pendingResponses);

  assert.deepEqual(responses.map(jiraParam), [
    "connected",
    "forbidden",
    "connected",
  ]);
  assert.deepEqual(
    connections.upserts.map(([id]) => id).sort(),
    ["org_1", "org_3"],
  );
  assert.deepEqual(sortedCalls(gated.calls), [
    ["user_1", "org_1"],
    ["user_1", "org_2"],
    ["user_1", "org_3"],
  ]);
  // Two exchanges, each a token request and a site list.
  assert.equal(atlassian.requests.length, 4);
});

// ===========================================================================
// [concurrency-3] The same state redeemed twice in parallel is checked on
// each request.

// Extends public "[concurrency-3] the same state redeemed twice in parallel":
// three redemptions.
test("[concurrency-3] the same state redeemed three times in parallel is checked on each request", async () => {
  const { app, roleCalls, connections } = appWith({ roles: owner() });
  const path = callback(`code=c&${withState(stateFor("org_1"))}`);

  const responses = await Promise.all([get(app, path), get(app, path), get(app, path)]);

  assert.deepEqual(responses.map(jiraParam), ["connected", "connected", "connected"]);
  assert.deepEqual(roleCalls, [
    ["user_1", "org_1"],
    ["user_1", "org_1"],
    ["user_1", "org_1"],
  ]);
  assert.deepEqual(
    connections.upserts.map(([id]) => id),
    ["org_1", "org_1", "org_1"],
  );
});

// Each request's own check decides it: no answer is cached for the state.
test("[concurrency-3] the same state redeemed again after a removal is refused on the second request", async () => {
  const { app, roles, roleCalls, connections } = appWith({ roles: owner() });
  const path = callback(`code=c&${withState(stateFor("org_1"))}`);

  const first = await get(app, path);
  delete roles[key(dana.id, "org_1")];
  const second = await get(app, path);

  assert.equal(jiraParam(first), "connected");
  assert.equal(jiraParam(second), "forbidden");
  assert.deepEqual(roleCalls, [
    ["user_1", "org_1"],
    ["user_1", "org_1"],
  ]);
  assert.equal(connections.upserts.length, 1);
});

test("[concurrency-3] the same state refused once is accepted after the caller is promoted", async () => {
  const { app, roles, roleCalls, connections } = appWith({
    roles: roleFor("member"),
  });
  const path = callback(`code=c&${withState(stateFor("org_1"))}`);

  const first = await get(app, path);
  roles[key(dana.id, "org_1")] = "admin";
  const second = await get(app, path);

  assert.equal(jiraParam(first), "forbidden");
  assert.equal(jiraParam(second), "connected");
  assert.deepEqual(roleCalls, [
    ["user_1", "org_1"],
    ["user_1", "org_1"],
  ]);
  assert.deepEqual(
    connections.upserts.map(([id]) => id),
    ["org_1"],
  );
});

test("[concurrency-3] two parallel redemptions whose lookups see different roles are each decided by their own", async () => {
  const roles = owner();
  const gated = gatedOrganizations(roles);
  const { app, connections } = appWith({ organizations: gated.store });
  const path = callback(`code=c&${withState(stateFor("org_1"))}`);

  const first = get(app, path);
  const second = get(app, path);
  await until(() => gated.calls.length >= 2);
  // Release one lookup while the caller is owner, the other after removal.
  gated.releaseOne();
  delete roles[key(dana.id, "org_1")];
  gated.releaseAll();
  const responses = await Promise.all([first, second]);

  assert.deepEqual(
    responses.map(jiraParam).sort(),
    ["connected", "forbidden"],
  );
  assert.deepEqual(gated.calls, [
    ["user_1", "org_1"],
    ["user_1", "org_1"],
  ]);
  assert.equal(connections.upserts.length, 1);
});
