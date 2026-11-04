# Store Jira connections with encrypted tokens (#29)

An organization connects one or more Atlassian sites. Each connection is a row
in a new `jira_connection` table (the table `packages/jira/src/credentials.ts`
already names as the `TokenSource` backing store), owned by an organization and
holding the OAuth access/refresh pair. The tokens are bearer credentials, so
they are never stored in plaintext: a new `TokenCipher` (AES-256-GCM, in
`packages/db/src/cipher.ts`) encrypts them on the way in and decrypts them on
the way out, and a new `JiraConnectionStore` (`packages/db/src/jira-connections.ts`)
is the only code that reads or writes the table. Listing a connection never
decrypts anything; only `tokens()` does.

## Exports

### `packages/db/src/cipher.ts` (new)

```ts
export class TokenCipherError extends Error {
    constructor(message: string);
}

export interface TokenCipher {
    encrypt(plaintext: string | null): string | null;
    decrypt(ciphertext: string | null): string | null;
    readonly keyId: string;
}

export function createTokenCipher(key: string, options: {
    keyId?: string;
} = {}): TokenCipher;

export function sameKeyId(left: string, right: string): boolean;
```

- `TokenCipherError` sets `this.name = "TokenCipherError"` and keeps the message
  it is given, as `JiraCredentialError` and `NotFoundError` do. It is the only
  error type `cipher.ts` throws.
- **Key.** `key` is 32 bytes in base64, which is what
  `openssl rand -base64 32` prints. The key is accepted when it decodes as
  base64 to exactly 32 bytes. Decoding is lenient: the standard (`+`, `/`) and
  URL-safe (`-`, `_`) alphabets are both accepted, padding may be missing or
  doubled, and surrounding whitespace is ignored. Any key that decodes to
  another length (the empty string, hex, base64 of 31 or 33 bytes) makes
  `createTokenCipher` throw
  `TokenCipherError("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded; got <n>.")`,
  where `<n>` is the decoded byte length.
- **Key id.** `options.keyId` is not checked: any string, including `""`, is
  used as given. If `keyId` is omitted (or `undefined`), it defaults to a
  12-character lowercase hex fingerprint that is fixed for a given key, so a
  different key gets a different default id (see the Background for the
  values for K1 and K2).
- **Ciphertext format.** `v1:<body>`, where `<body>` is standard, padded
  base64 of `iv ‖ tag ‖ data`. `iv` is a fresh random 12-byte nonce for every
  call. `tag` is the 16-byte GCM authentication tag. `data` is the AES-256-GCM
  encryption of the UTF-8 bytes of the plaintext, so it is as long as those
  bytes. The key id is not part of the ciphertext.
- `encrypt(null)` returns `null`. `decrypt(null)` returns `null`. Plaintext has
  no length limit, and `""` is a valid plaintext.
- `decrypt` runs its checks in this order and throws at the first one that
  fails:
  1. **Scheme.** The text before the first `:` must be exactly `v1`. If it is
     not, or there is no `:`, it throws
     `TokenCipherError("Unrecognised token encoding; expected v1.")`.
  2. **Length.** The text after the first `:` is decoded as base64 (with the
     same leniency as the key). If that gives fewer than 28 bytes, it throws
     `TokenCipherError("Encrypted token is truncated.")`.
  3. **Authentication.** If GCM verification fails, it throws
     `TokenCipherError("Encrypted token could not be authenticated; the key may have changed.")`.
  `decrypt` does not look at the key id: a cipher with the same key and any
  key id decrypts the value. No message contains the key or the plaintext.
- `sameKeyId(left, right)` is `true` exactly when the two strings are
  identical, compared case-sensitively. Any strings are allowed, so
  `sameKeyId("", "")` is `true`.
- A cipher keeps no mutable state. Calls on one cipher do not affect each
  other.

### `packages/db/src/schema/jira.ts` (new)

```ts
export const jiraConnection = pgTable("jira_connection", { … }, (table) => [ … ]);
export type JiraConnectionRow = typeof jiraConnection.$inferSelect;
export type NewJiraConnectionRow = typeof jiraConnection.$inferInsert;
```

| Property       | Column          | Type                            | Null     | Default            |
|----------------|-----------------|---------------------------------|----------|--------------------|
| `id`           | `id`            | `text`, primary key             | not null | —                  |
| `organizationId` | `organization_id` | `text` → `organization.id`, `on delete cascade` | not null | — |
| `cloudId`      | `cloud_id`      | `text`                          | not null | —                  |
| `siteUrl`      | `site_url`      | `text`                          | not null | —                  |
| `siteName`     | `site_name`     | `text`                          | not null | —                  |
| `kind`         | `kind`          | `text`                          | not null | `'oauth'`          |
| `accessTokenEnc`  | `access_token_enc`  | `text` (ciphertext only)    | nullable | —                  |
| `refreshTokenEnc` | `refresh_token_enc` | `text` (ciphertext only)    | nullable | —                  |
| `keyId`        | `key_id`        | `text`                          | nullable | —                  |
| `expiresAt`    | `expires_at`    | `timestamp with time zone`      | nullable | —                  |
| `scopes`       | `scopes`        | `text`, space-separated         | not null | `''`               |
| `email`        | `email`         | `text`                          | nullable | —                  |
| `healthy`      | `healthy`       | `boolean`                       | not null | `true`             |
| `createdAt`    | `created_at`    | `timestamp with time zone`      | not null | `now()`            |
| `updatedAt`    | `updated_at`    | `timestamp with time zone`      | not null | `now()`            |

- The table has one unique constraint, `jira_connection_organization_site_unique`,
  on (`organization_id`, `cloud_id`). This means one connection per site per
  organization. It also has one index, `jira_connection_organization_id_idx`,
  on `organization_id`.
- `key_id` records the `keyId` of the cipher that wrote the token columns.
- The module imports `organization` from `./organizations.js` and uses it only
  inside the foreign-key thunk. `organizations.ts` does not import it back.

### `packages/db/src/schema.ts` (changed)

- The barrel also re-exports `jiraConnection`, the type `JiraConnectionRow` and
  the type `NewJiraConnectionRow` from `./schema/jira.js`.
- Its header comment lists `schema/jira.ts` among the modules.
- Every existing export keeps its value and behaviour.
- `authSchema` (`auth-schema.ts`) is unchanged and does not include
  `jiraConnection`.
- `ID_PREFIXES` is unchanged. `"jrc"` is already declared there.
- `src/index.ts` also exports `createTokenCipher`, `sameKeyId`,
  `TokenCipherError` and `createJiraConnectionStore`, and the types
  `TokenCipher`, `JiraConnectionInput`, `JiraConnectionStore`,
  `JiraConnectionSummary` and `JiraConnectionTokens`. Its other exports are
  unchanged.
- The SQL migration is generated with `drizzle-kit generate` from this table.
  This spec does not cover it.

### `packages/db/src/jira-connections.ts` (new)

The interfaces `JiraConnectionSummary`, `JiraConnectionTokens`,
`JiraConnectionInput` and `JiraConnectionStore`, plus
`createJiraConnectionStore(db: Database, cipher: TokenCipher): JiraConnectionStore`,
are exactly as the ticket gives them. `Database` is the type from `./store.js`.

**Mapping a row to a `JiraConnectionSummary`:**

- `id`, `cloudId`, `siteUrl`, `siteName`, `email` and `healthy` are copied
  from the row.
- `scopes` is the row's `scopes` split on a single space, and `[]` when the
  column is `""`.
- `createdAt` is `row.createdAt.toISOString()`.
- The object has exactly these eight keys. It has no `organizationId`, no
  tokens, no `keyId`, no `kind`, no `expiresAt` and no `updatedAt`.

**Mapping a row to `JiraConnectionTokens`:**

- `accessToken` is `cipher.decrypt(row.accessTokenEnc)` and `refreshToken` is
  `cipher.decrypt(row.refreshTokenEnc)`.
- `expiresAt` is `row.expiresAt?.toISOString() ?? null`.
- `scopes` is split as for the summary.
- The object has exactly these four keys.

**Input (`upsert` and `saveTokens`):**

The store does not validate its input. Strings are stored exactly as given,
with no trimming or case folding, and blank strings are stored too. `email`
that is omitted or `undefined` is stored as `null`. `expiresAt` is stored as
`null` when it is `null`, and as `new Date(expiresAt)` otherwise, whatever the
string is. `scopes` is stored joined with a single space, in the given order,
with duplicates kept. Tokens are passed through `cipher.encrypt` and only the
result is written, together with `keyId: cipher.keyId`.

**Query shapes.** The store issues only the Drizzle calls below, one per
method call. Tests can therefore use an in-memory fake in the style of
`test/fake-organization-db.ts`. `select()` with no projection resolves to
`JiraConnectionRow` objects.

| Method          | Call                                                                                                                                                                  | Result used                          |
|-----------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------|
| `list`          | `db.select().from(jiraConnection).where(eq(jiraConnection.organizationId, organizationId)).orderBy(desc(jiraConnection.createdAt))`                                  | all rows, in the order returned      |
| `get`, `tokens` | `db.select().from(jiraConnection).where(and(eq(jiraConnection.organizationId, organizationId), eq(jiraConnection.id, connectionId)))`                                 | first row, or none                   |
| `upsert`        | `db.insert(jiraConnection).values({ id: generateId("jrc"), ...values }).onConflictDoUpdate({ target: [jiraConnection.organizationId, jiraConnection.cloudId], set: values }).returning()` | first row          |
| `saveTokens`    | `db.update(jiraConnection).set(set).where(eq(jiraConnection.id, connectionId))`                                                                                       | nothing                              |
| `markUnhealthy` | `db.update(jiraConnection).set({ healthy: false, updatedAt: <a Date> }).where(eq(jiraConnection.id, connectionId))`                                                   | nothing                              |
| `remove`        | `db.delete(jiraConnection).where(and(eq(jiraConnection.organizationId, organizationId), eq(jiraConnection.id, connectionId))).returning()`                             | whether any row came back            |

- `upsert` `values` has exactly these properties: `organizationId`, `cloudId`,
  `siteUrl`, `siteName`, `email`, `accessTokenEnc` (ciphertext or `null`),
  `refreshTokenEnc` (ciphertext or `null`), `keyId` (`cipher.keyId`),
  `expiresAt` (`Date` or `null`), `scopes` (the joined string),
  `healthy: true` and `updatedAt` (a `Date`). The insert adds `id`. Neither
  the insert nor the conflict set has `createdAt` or `kind`.
- The `upsert` conflict `set` is that same `values` object, so it has no `id`
  and it does carry `organizationId` and `cloudId`.
- The `saveTokens` `set` has exactly these properties: `accessTokenEnc`,
  `refreshTokenEnc`, `keyId`, `expiresAt` (all converted as above), `scopes`
  (the joined string), `healthy: true` and `updatedAt` (a `Date`).
- `updatedAt` is written as `new Date()` taken when the method is called.
- `list` does not sort in JavaScript. It returns rows in the order the query
  resolves them, and the query asks for `createdAt` descending (newest
  first). The order of rows with the same `createdAt` is not specified.
- If `upsert`'s `returning()` resolves to no row, `upsert` rejects with
  `Error("Failed to record the Jira connection.")`.

```gherkin
Feature: Jira connections with encrypted tokens

  Background:
    Given K1 is "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" (bytes 0..31), whose default key id is "0ebcb5deb52c"
    And K2 is "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=" (bytes 32..63), whose default key id is "e32ee159945f"
    And "cipher" is createTokenCipher(K1)
    And "fake" is an in-memory Database that answers the query shapes above over a list of JiraConnectionRow
    And "store" is createJiraConnectionStore(fake, cipher)

  Rule: createTokenCipher accepts any key that decodes as base64 to 32 bytes, and any key id

    @happy
    Scenario Outline: An accepted key yields its default key id
      When createTokenCipher is called with key <key> and no options
      Then it returns a cipher whose keyId is "<keyId>"

      Examples:
        | key                                                  | keyId        |
        | "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="       | 0ebcb5deb52c |
        | "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"        | 0ebcb5deb52c |
        | "  AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n"   | 0ebcb5deb52c |
        | "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=="      | 0ebcb5deb52c |
        | "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8="       | e32ee159945f |
        | 43 × "_" (base64url alphabet)                        | c7c96dffcd9c |

    @unhappy
    Scenario Outline: A key of the wrong decoded length throws TokenCipherError
      When createTokenCipher is called with key <key>
      Then it throws a TokenCipherError named "TokenCipherError" with message "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded; got <n>."

      Examples:
        | key                                                                   | n  | why                     |
        | ""                                                                    | 0  | empty                   |
        | "   "                                                                 | 0  | whitespace only         |
        | "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHg=="                        | 31 | 31 bytes                |
        | "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g"                        | 33 | 33 bytes                |
        | "___________________________________________8"                        | 33 | 33 bytes in base64url   |
        | "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"    | 48 | hex                     |

    @happy
    Scenario: An explicit key id replaces the default
      When createTokenCipher(K1, { keyId: "2026-11_a" }) is called
      Then the cipher's keyId is "2026-11_a"

    @boundary
    Scenario Outline: The key id is used as given
      When createTokenCipher(K1, { keyId: <keyId> }) is called
      Then the cipher's keyId is <result>

      Examples:
        | keyId                | result                     |
        | "a"                  | "a"                        |
        | 65 × "k"             | the 65-character id        |
        | ""                   | ""                         |
        | "k:1"                | "k:1"                      |
        | "k 1"                | "k 1"                      |
        | undefined            | "0ebcb5deb52c"             |

    @unhappy
    Scenario: Only the key is checked
      When createTokenCipher("", { keyId: "" }) is called
      Then it throws TokenCipherError "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded; got 0."

  Rule: encrypt produces a fresh v1 ciphertext that decrypt turns back into the plaintext

    @happy
    Scenario Outline: Round trip
      When cipher.decrypt(cipher.encrypt(<plaintext>)) is called
      Then it returns <plaintext>

      Examples:
        | plaintext                     |
        | "eyJhbGciOiJIUzI1NiJ9.access" |
        | "tökén 🔑"                    |
        | ""                            |
        | 100000 × "x"                  |

    @happy
    Scenario: The ciphertext has the documented layout
      When cipher.encrypt("secret") is called
      Then the result starts with "v1:" and has 51 characters
      And the text after "v1:" is 48 characters of padded standard base64 that decode to 34 bytes (12 iv + 16 tag + 6 data)
      And the result does not contain "secret" or the key id

    @boundary
    Scenario: The empty plaintext has no data bytes
      When cipher.encrypt("") is called
      Then the text after "v1:" is 40 characters that decode to exactly 28 bytes

    @happy
    Scenario: Encrypting the same plaintext twice gives different ciphertexts
      When cipher.encrypt("secret") is called twice
      Then the two results differ
      And both decrypt to "secret"

    @happy
    Scenario: A ciphertext is readable by another cipher built from the same key
      Given "other" is createTokenCipher(" AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8 ")
      When other.decrypt(cipher.encrypt("secret")) is called
      Then it returns "secret"

    @happy
    Scenario: The key id does not affect decryption
      Given "a" is createTokenCipher(K1, { keyId: "old" }) and "b" is createTokenCipher(K1, { keyId: "new" })
      When b.decrypt(a.encrypt("secret")) is called
      Then it returns "secret"

    @boundary
    Scenario: null passes through both directions
      Then cipher.encrypt(null) returns null
      And cipher.decrypt(null) returns null

  Rule: decrypt rejects unrecognised, truncated and unauthenticated ciphertexts with TokenCipherError

    @unhappy
    Scenario Outline: An unrecognised encoding
      When cipher.decrypt(<ciphertext>) is called
      Then it throws TokenCipherError "Unrecognised token encoding; expected v1."

      Examples:
        | ciphertext                                          | why                         |
        | ""                                                  | empty string, not null      |
        | "plaintext-token"                                   | no ":"                      |
        | "v1"                                                | no ":"                      |
        | a valid ciphertext with "v1" changed to "v2"        | unknown version             |
        | a valid ciphertext with "v1" changed to "V1"        | scheme is case-sensitive    |
        | a valid ciphertext with a leading " "               | scheme is not trimmed       |

    @unhappy
    Scenario Outline: A truncated ciphertext
      When cipher.decrypt(<ciphertext>) is called
      Then it throws TokenCipherError "Encrypted token is truncated."

      Examples:
        | ciphertext                                  | why               |
        | "v1:"                                       | no bytes          |
        | "v1:" + base64 of 27 zero bytes             | one byte too few  |

    @unhappy
    Scenario: A ciphertext under another key fails authentication
      Given "k2" is createTokenCipher(K2)
      When cipher.decrypt(k2.encrypt("secret")) is called
      Then it throws TokenCipherError "Encrypted token could not be authenticated; the key may have changed."

    @unhappy
    Scenario: The same key id over a different key fails authentication
      Given "a" is createTokenCipher(K1, { keyId: "prod" }) and "b" is createTokenCipher(K2, { keyId: "prod" })
      When b.decrypt(a.encrypt("secret")) is called
      Then it throws TokenCipherError "Encrypted token could not be authenticated; the key may have changed."

    @boundary
    Scenario: 28 bytes that are not a ciphertext fail authentication
      When cipher.decrypt("v1:" + base64 of 28 zero bytes) is called
      Then it throws TokenCipherError "Encrypted token could not be authenticated; the key may have changed."

    @unhappy
    Scenario Outline: A tampered byte fails authentication
      Given c is "v1:" + the base64 of cipher.encrypt("secret")'s decoded body with one bit of byte <offset> flipped
      When cipher.decrypt(c) is called
      Then it throws TokenCipherError "Encrypted token could not be authenticated; the key may have changed."
      And the error message contains neither "secret" nor K1

      Examples:
        | offset | part |
        | 0      | iv   |
        | 12     | tag  |
        | 28     | data |

    @unhappy
    Scenario: The scheme is checked before the length, and the length before authentication
      Given "k2" is createTokenCipher(K2)
      When cipher.decrypt("v2:" + the body of k2.encrypt("secret")) is called
      Then it throws TokenCipherError "Unrecognised token encoding; expected v1."
      When cipher.decrypt("v1:" + base64 of the first 27 decoded bytes of k2.encrypt("secret")) is called
      Then it throws TokenCipherError "Encrypted token is truncated."

  Rule: sameKeyId is exact, case-sensitive equality of any two strings

    @happy
    @boundary
    Scenario Outline: Comparing key ids
      When sameKeyId(<left>, <right>) is called
      Then it returns <result>

      Examples:
        | left           | right          | result |
        | "0ebcb5deb52c" | "0ebcb5deb52c" | true   |
        | "prod"         | "prod"         | true   |
        | "prod"         | "Prod"         | false  |
        | "prod"         | "prod "        | false  |
        | "prod"         | "staging"      | false  |
        | ""             | ""             | true   |
        | "k:1"          | "k:1"          | true   |
        | 65 × "k"       | 65 × "k"       | true   |
        | "é"            | "e"            | false  |

  Rule: jira_connection has the documented columns, constraint, index and foreign key

    @happy
    Scenario: Table and columns
      When getTableConfig(jiraConnection) is read
      Then its name is "jira_connection"
      And its columns are, by name: id, organization_id, cloud_id, site_url, site_name, kind, access_token_enc, refresh_token_enc, key_id, expires_at, scopes, email, healthy, created_at, updated_at
      And exactly one column is primary, "id", with SQL type "text"
      And organization_id, cloud_id, site_url, site_name, kind, scopes, healthy, created_at and updated_at are notNull
      And email, access_token_enc, refresh_token_enc, key_id and expires_at are not notNull
      And scopes has SQL type "text" and default ""
      And kind has default "oauth"
      And healthy has default true
      And created_at and updated_at have hasDefault true

    @happy
    Scenario: One connection per site per organization
      When getTableConfig(jiraConnection).uniqueConstraints is read
      Then it contains exactly "jira_connection_organization_site_unique" whose columns are ["organization_id", "cloud_id"] in that order

    @happy
    Scenario: Connections are indexed by organization
      When getTableConfig(jiraConnection).indexes is read
      Then it contains exactly "jira_connection_organization_id_idx" on ["organization_id"]

    @happy
    Scenario: A connection cascades with its organization
      When getTableConfig(jiraConnection).foreignKeys is read
      Then there is exactly one foreign key
      And its reference().foreignTable is organization and its onDelete is "cascade"

    @happy
    Scenario: The barrel and the entry point re-export the new modules, and Better Auth does not see them
      Then every export of "src/schema/jira.ts" is the identical value exported by "src/schema.ts"
      And every table in "src/schema.ts" still has a distinct Postgres name, now ten of them
      And "jiraConnection" is not a key of authSchema
      And "src/index.ts" exports createTokenCipher, sameKeyId, TokenCipherError and createJiraConnectionStore as the identical values from "src/cipher.ts" and "src/jira-connections.ts"

  Rule: upsert writes one connection per (organization, cloudId) with encrypted tokens

    @happy
    Scenario: A new connection
      Given the fake holds no rows
      When store.upsert("org_1", { cloudId: "c-1", siteUrl: "https://acme.atlassian.net", siteName: "Acme", email: "ada@acme.test", accessToken: "AT-1", refreshToken: "RT-1", expiresAt: "2026-11-04T12:00:00.000Z", scopes: ["read:jira-work", "offline_access"] }) is called
      Then the insert values have an id matching /^jrc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      And the insert values have organizationId "org_1", cloudId "c-1", keyId "0ebcb5deb52c", healthy true, scopes "read:jira-work offline_access", updatedAt a Date and expiresAt equal to new Date("2026-11-04T12:00:00.000Z")
      And the insert values' accessTokenEnc is not "AT-1" and cipher.decrypt of it is "AT-1"
      And the insert values' refreshTokenEnc is not "RT-1" and cipher.decrypt of it is "RT-1"
      And the conflict target is [jiraConnection.organizationId, jiraConnection.cloudId]
      And the result is { id: <that id>, cloudId: "c-1", siteUrl: "https://acme.atlassian.net", siteName: "Acme", email: "ada@acme.test", healthy: true, scopes: ["read:jira-work", "offline_access"], createdAt: <the returned row's createdAt as ISO string> }
      And the result has exactly those eight keys

    @happy
    Scenario: Reconnecting the same site updates the existing row
      Given the fake holds a row { id: "jrc_a", organizationId: "org_1", cloudId: "c-1", healthy: false, createdAt: 2026-01-01T00:00:00.000Z, … }
      And the fake applies the conflict set to a row with the same (organizationId, cloudId)
      When store.upsert("org_1", { cloudId: "c-1", siteUrl: "https://acme.atlassian.net", siteName: "Acme Corp", accessToken: "AT-2", refreshToken: "RT-2", expiresAt: null, scopes: [] }) is called
      Then the result has id "jrc_a", siteName "Acme Corp", email null, healthy true, scopes [] and createdAt "2026-01-01T00:00:00.000Z"
      And the conflict set has no id or createdAt key, and has organizationId "org_1" and cloudId "c-1"
      And the conflict set has updatedAt a Date, keyId "0ebcb5deb52c" and healthy true

    @boundary
    Scenario Outline: Optional, nullable and unchecked fields
      When store.upsert("org_1", <input>) is called with otherwise valid fields
      Then it resolves and the insert values have <stored>

      Examples:
        | input                                                  | stored                                      |
        | email omitted                                          | email null                                  |
        | email: undefined                                       | email null                                  |
        | email: null                                            | email null                                  |
        | email: "Ada@ACME.test"                                 | email "Ada@ACME.test"                       |
        | accessToken: null, refreshToken: null                  | accessTokenEnc null, refreshTokenEnc null   |
        | accessToken: ""                                        | an accessTokenEnc ciphertext that decrypts to "" |
        | expiresAt: null                                        | expiresAt null                              |
        | expiresAt: "2026-11-04T12:00+01:00"                    | expiresAt new Date("2026-11-04T11:00:00.000Z") |
        | expiresAt: "2026-11-04T12:00:00.123456Z"               | expiresAt new Date("2026-11-04T12:00:00.123Z") |
        | expiresAt: "soon"                                      | expiresAt a Date whose getTime() is NaN     |
        | scopes: ["b", "a", "b"]                                | scopes "b a b"                              |
        | scopes: []                                             | scopes ""                                   |
        | siteName: " Acme "                                     | siteName " Acme "                           |
        | cloudId: ""                                            | cloudId ""                                  |
        | siteName: "\t"                                         | siteName "\t"                               |

    @unhappy
    Scenario: The insert returns no row
      Given the fake's insert … returning() resolves to []
      When store.upsert("org_1", a valid input) is called
      Then it rejects with an Error whose message is "Failed to record the Jira connection."

    @concurrency
    Scenario: Two overlapping upserts of the same site leave one connection
      Given the fake enforces the unique (organizationId, cloudId) constraint by applying the conflict set
      When store.upsert("org_1", { cloudId: "c-1", siteName: "A", … }) and store.upsert("org_1", { cloudId: "c-1", siteName: "B", … }) are started without awaiting either
      Then both resolve with the same id
      And the fake holds exactly one row for ("org_1", "c-1"), with siteName from whichever insert the fake applied last
      And each upsert issued exactly one insert and no select

    @happy
    Scenario: The same site in two organizations is two connections
      Given the fake enforces the unique (organizationId, cloudId) constraint
      When store.upsert("org_1", { cloudId: "c-1", … }) and then store.upsert("org_2", { cloudId: "c-1", … }) are called
      Then the two results have different ids and the fake holds two rows

  Rule: list and get return summaries scoped to the organization and never decrypt

    @happy
    Scenario: list asks for newest first and keeps the order it gets
      Given the fake holds rows for "org_1":
        | id    | createdAt                |
        | jrc_a | 2026-01-01T00:00:00.000Z |
        | jrc_b | 2026-02-01T00:00:00.000Z |
        | jrc_c | 2026-03-01T00:00:00.000Z |
      And a row "jrc_z" for "org_2"
      And the fake orders the result as orderBy asks
      When store.list("org_1") is called
      Then the query's orderBy is desc(jiraConnection.createdAt)
      And it returns summaries with ids ["jrc_c", "jrc_b", "jrc_a"]
      And each summary has exactly the keys id, cloudId, siteUrl, siteName, email, healthy, scopes, createdAt

    @boundary
    Scenario: list does not re-sort
      Given the fake ignores orderBy and returns the "org_1" rows in the order ["jrc_b", "jrc_a", "jrc_c"]
      When store.list("org_1") is called
      Then it returns summaries with ids ["jrc_b", "jrc_a", "jrc_c"]

    @boundary
    Scenario: An organization with no connections
      When store.list("org_empty") is called
      Then it returns []

    @happy
    Scenario: Summaries do not need the key
      Given the fake holds a row for "org_1" whose accessTokenEnc is "not-a-ciphertext"
      When store.list("org_1") and store.get("org_1", <its id>) are called
      Then both resolve without throwing

    @happy
    Scenario: get returns one summary
      Given the fake holds row "jrc_a" for "org_1" with createdAt 2026-01-01T00:00:00.000Z, healthy false, email null and scopes "read:jira-work write:jira-work"
      When store.get("org_1", "jrc_a") is called
      Then it returns the summary with id "jrc_a", healthy false, email null, scopes ["read:jira-work", "write:jira-work"] and createdAt "2026-01-01T00:00:00.000Z"

    @unhappy
    Scenario Outline: get misses return null
      Given the fake holds row "jrc_a" for "org_1"
      When store.get(<organizationId>, <connectionId>) is called
      Then it returns null

      Examples:
        | organizationId | connectionId |
        | "org_2"        | "jrc_a"      |
        | "org_1"        | "jrc_nope"   |
        | "org_1"        | ""           |

  Rule: tokens returns the decrypted pair, scoped to the organization

    @happy
    Scenario: Decrypted tokens
      Given the fake holds row "jrc_a" for "org_1" with accessTokenEnc cipher.encrypt("AT-1"), refreshTokenEnc cipher.encrypt("RT-1"), expiresAt 2026-11-04T12:00:00.000Z and scopes "read:jira-work"
      When store.tokens("org_1", "jrc_a") is called
      Then it returns exactly { accessToken: "AT-1", refreshToken: "RT-1", expiresAt: "2026-11-04T12:00:00.000Z", scopes: ["read:jira-work"] }

    @boundary
    Scenario: Absent tokens and expiry stay null
      Given the fake holds row "jrc_a" for "org_1" with accessTokenEnc null, refreshTokenEnc null, expiresAt null and scopes ""
      When store.tokens("org_1", "jrc_a") is called
      Then it returns { accessToken: null, refreshToken: null, expiresAt: null, scopes: [] }

    @unhappy
    Scenario: Another organization's connection
      Given the fake holds row "jrc_a" for "org_1"
      When store.tokens("org_2", "jrc_a") is called
      Then it returns null

    @unhappy
    Scenario: Tokens written under another key propagate the cipher error and write nothing
      Given the fake holds row "jrc_a" for "org_1" whose accessTokenEnc is createTokenCipher(K2).encrypt("AT-1")
      When store.tokens("org_1", "jrc_a") is called
      Then it rejects with TokenCipherError "Encrypted token could not be authenticated; the key may have changed."
      And the fake recorded no update

  Rule: saveTokens replaces the token set by connection id and marks the connection healthy

    @happy
    Scenario: A refreshed pair is stored encrypted
      Given the fake holds row "jrc_a" with healthy false
      When store.saveTokens("jrc_a", { accessToken: "AT-2", refreshToken: "RT-2", expiresAt: "2026-11-04T13:00:00.000Z", scopes: ["read:jira-work"] }) is called
      Then it resolves to undefined
      And the update set has exactly the keys accessTokenEnc, refreshTokenEnc, keyId, expiresAt, scopes, healthy, updatedAt
      And cipher.decrypt(set.accessTokenEnc) is "AT-2" and cipher.decrypt(set.refreshTokenEnc) is "RT-2"
      And set.keyId is "0ebcb5deb52c" and set.scopes is "read:jira-work"
      And set.expiresAt equals new Date("2026-11-04T13:00:00.000Z"), set.healthy is true and set.updatedAt is a Date
      And the update is filtered by jiraConnection.id = "jrc_a" only

    @boundary
    Scenario: A grant without offline_access saves a null refresh token
      When store.saveTokens("jrc_a", { accessToken: "AT-2", refreshToken: null, expiresAt: null, scopes: [] }) is called
      Then the update set has refreshTokenEnc null, expiresAt null and scopes ""

    @boundary
    Scenario: An unknown connection id is a no-op
      Given the fake holds no rows
      When store.saveTokens("jrc_gone", { accessToken: "AT", refreshToken: "RT", expiresAt: null, scopes: [] }) is called
      Then it resolves to undefined
      And exactly one update was issued

    @boundary
    Scenario: The expiry is not checked
      When store.saveTokens("jrc_a", { accessToken: "AT", refreshToken: "RT", expiresAt: "3600", scopes: [] }) is called
      Then it resolves to undefined
      And the update set has expiresAt equal to new Date("3600-01-01T00:00:00.000Z")

  Rule: markUnhealthy flags a connection by id and is idempotent

    @happy
    Scenario: Flagging a connection
      Given the fake holds row "jrc_a" with healthy true
      When store.markUnhealthy("jrc_a") is called
      Then it resolves to undefined
      And the update set has exactly the keys healthy (false) and updatedAt (a Date), filtered by jiraConnection.id = "jrc_a"
      And a following store.get(<its organization>, "jrc_a") returns healthy false

    @boundary
    Scenario: Flagging twice, or flagging an unknown id
      When store.markUnhealthy("jrc_a") is called twice and store.markUnhealthy("jrc_gone") once
      Then all three resolve to undefined and none rejects

    @concurrency
    Scenario: A refresh and a failure flag overlap
      Given the fake applies updates in the order their where() is called
      When store.saveTokens("jrc_a", …) and store.markUnhealthy("jrc_a") are started without awaiting either
      Then both resolve
      And the row's healthy is the value from whichever update the fake applied last

  Rule: remove deletes within the organization and reports whether anything was deleted

    @happy
    Scenario: Removing an existing connection
      Given the fake holds row "jrc_a" for "org_1"
      When store.remove("org_1", "jrc_a") is called
      Then it returns true
      And a following store.get("org_1", "jrc_a") returns null

    @unhappy
    Scenario Outline: Removing nothing
      Given the fake holds row "jrc_a" for "org_1"
      When store.remove(<organizationId>, <connectionId>) is called
      Then it returns false
      And the fake still holds row "jrc_a"

      Examples:
        | organizationId | connectionId |
        | "org_2"        | "jrc_a"      |
        | "org_1"        | "jrc_nope"   |

    @boundary
    Scenario: Removing twice
      Given the fake holds row "jrc_a" for "org_1"
      When store.remove("org_1", "jrc_a") is called twice
      Then the first returns true and the second returns false
```

Decided:

- Key encoding and whitespace: any string that decodes as base64 (standard or URL-safe alphabet, padding missing or extra, surrounding whitespace ignored) to exactly 32 bytes; anything else throws `TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded; got <n>.`
  - Ticket: silent.
  - Instead: accept only strict standard base64, or derive a key from any passphrase with a KDF.
- Default key id: a 12-character lowercase hex fingerprint fixed per key (`0ebcb5deb52c` for K1, `e32ee159945f` for K2).
  - Ticket: "keyId?: string;"
  - Instead: a fixed default such as `"default"` or `"k1"`.
- Key id alphabet and length: not checked; any string, including `""`, is used as given.
  - Ticket: silent.
  - Instead: require `^[A-Za-z0-9_-]{1,64}$`.
- Algorithm and ciphertext format: AES-256-GCM, `v1:` followed by padded standard base64 of iv‖tag‖data, 12-byte random IV, no additional authenticated data; the key id is stored in the `key_id` column, not in the ciphertext.
  - Ticket: silent.
  - Instead: `v1:<keyId>:<iv>:<tag>:<data>` with the key id bound in as AAD.
- Null handling in the cipher: `null` maps to `null` both ways, and `""` encrypts and round-trips.
  - Ticket: "encrypt(plaintext: string | null): string | null;"
  - Instead: treat `""` like `null`.
- Errors from decrypt: always `TokenCipherError`, checked in the order scheme ("Unrecognised token encoding; expected v1."), then length under 28 bytes ("Encrypted token is truncated."), then authentication ("Encrypted token could not be authenticated; the key may have changed."). The key id is never compared, so a wrong key surfaces as an authentication failure.
  - Ticket: "export class TokenCipherError extends Error {"
  - Instead: return `null` for an undecryptable value, or reject a key-id mismatch before authenticating.
- `sameKeyId` semantics: exact, case-sensitive equality of any two strings (so `("", "")` is true).
  - Ticket: "export function sameKeyId(left: string, right: string): boolean;"
  - Instead: false unless both are well-formed key ids.
- Table shape: the columns in the table above, including `kind` (default `'oauth'`) and `key_id`; token columns named `access_token_enc` and `refresh_token_enc`; `scopes` as a space-separated `text` defaulting to `''`; `healthy` defaulting to true; cascade on organization delete; an index on `organization_id`.
  - Ticket: "export const jiraConnection = …;"
  - Instead: scopes as `text[]`, and no index beyond the unique constraint.
- Uniqueness: one connection per (organization, cloudId), constraint `jira_connection_organization_site_unique`, and `upsert` resolves conflicts on that pair.
  - Ticket: "upsert(organizationId: string, input: JiraConnectionInput): Promise<JiraConnectionSummary>;"
  - Instead: unique on `cloudId` alone, so a site belongs to only one organization.
- Upsert overwrite semantics: every input field replaces the stored one, an omitted `email` becomes `null`, and `id` and `createdAt` are kept. The conflict set is the same object as the insert values without `id`.
  - Ticket: "readonly email?: string | null;"
  - Instead: an omitted `email` keeps the stored value.
- Upsert, saveTokens and healthy: both set `healthy` back to `true`.
  - Ticket: silent.
  - Instead: leave `healthy` unchanged and require an explicit reset.
- Input validation: none. Blank strings are stored, and any `expiresAt` string is stored as `new Date(expiresAt)`, even an invalid one.
  - Ticket: silent.
  - Instead: reject blank `cloudId`, `siteUrl` or `siteName`, or a non-ISO `expiresAt`, with `RangeError` before any query.
- Scopes handling: stored joined with a space in the given order, duplicates kept, and returned split on a space (`""` gives `[]`).
  - Ticket: "readonly scopes: readonly string[];"
  - Instead: de-duplicate and sort.
- Timestamp formats: `createdAt` and `expiresAt` come out as `toISOString()` (UTC, milliseconds), and `updatedAt` is written as `new Date()` from the process clock.
  - Ticket: "readonly createdAt: string;"
  - Instead: return `Date` objects or epoch milliseconds, or set `updatedAt` with SQL `now()`.
- list ordering: newest first, asked of the database with `orderBy(desc(createdAt))`; the store does not re-sort, and ties are unspecified.
  - Ticket: "list(organizationId: string): Promise<JiraConnectionSummary[]>;"
  - Instead: oldest first, sorted in JavaScript with ties by `id`.
- Upsert with no returned row: rejects with `Error("Failed to record the Jira connection.")`.
  - Ticket: silent.
  - Instead: fall back to a select.
- Cross-organization access: `get`, `tokens` and `remove` return `null` or `false` for another organization's id, the same as for a missing one.
  - Ticket: "get(organizationId: string, connectionId: string): Promise<JiraConnectionSummary | null>;"
  - Instead: throw a not-found or forbidden error.
- Unscoped writes: `saveTokens` and `markUnhealthy` filter by connection id only and are a silent no-op for an unknown id.
  - Ticket: "saveTokens(connectionId: string, tokens: {"
  - Instead: reject when no row was updated.
- Undecryptable stored tokens: `tokens()` lets the `TokenCipherError` propagate and does not mark the connection unhealthy itself.
  - Ticket: "tokens(organizationId: string, connectionId: string): Promise<JiraConnectionTokens | null>;"
  - Instead: return `null`, or mark the connection unhealthy and return `null`.
- Overlapping upserts: one `insert … on conflict do update` statement, never select-then-insert, so concurrent calls converge on one row.
  - Ticket: silent.
  - Instead: read, then insert or update, inside a transaction.
- Overlapping saveTokens and markUnhealthy: last write wins, with no versioning.
  - Ticket: "markUnhealthy(connectionId: string): Promise<void>;"
  - Instead: optimistic concurrency on `updatedAt`.
- Public surface: `src/index.ts` re-exports the cipher and the store, with their types.
  - Ticket: silent.
  - Instead: leave the package entry point unchanged.
