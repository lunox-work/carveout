/**
 * Hidden suite for the package entry point (`src/index.ts`).
 *
 * The table, its constraint, index and foreign key, the barrel and
 * `authSchema` are already fixed by the seam, so tests of those alone could
 * not fail any implementation; only the entry point's new exports are pinned
 * here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { authSchema } from "../../src/auth-schema.js";
import * as cipherModule from "../../src/cipher.js";
import * as emails from "../../src/emails.js";
import * as index from "../../src/index.js";
import * as storeModule from "../../src/jira-connections.js";
import * as mapping from "../../src/mapping.js";
import * as organizations from "../../src/organizations.js";
import * as schema from "../../src/schema.js";
import * as store from "../../src/store.js";

const K2 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";

// Extends "[happy-13] the entry point exports the cipher and the store": the
// four new values sit beside every export the entry point already had.
test("[happy-13] the entry point's new exports sit beside every existing export, unchanged", () => {
  const exported = index as Record<string, unknown>;
  const expected: Record<string, unknown> = {
    createTokenCipher: cipherModule.createTokenCipher,
    sameKeyId: cipherModule.sameKeyId,
    TokenCipherError: cipherModule.TokenCipherError,
    createJiraConnectionStore: storeModule.createJiraConnectionStore,
    authSchema,
    createEmailStore: emails.createEmailStore,
    createProfileStore: emails.createProfileStore,
    USERNAME_MAX_LENGTH: emails.USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH: emails.USERNAME_MIN_LENGTH,
    generateId: mapping.generateId,
    ID_PREFIXES: mapping.ID_PREFIXES,
    newTodoRow: mapping.newTodoRow,
    rowToTodo: mapping.rowToTodo,
    createOrganizationStore: organizations.createOrganizationStore,
    createPostgresStore: store.createPostgresStore,
    NotFoundError: store.NotFoundError,
    account: schema.account,
    invitation: schema.invitation,
    member: schema.member,
    organization: schema.organization,
    session: schema.session,
    todos: schema.todos,
    user: schema.user,
    userEmail: schema.userEmail,
    verification: schema.verification,
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.ok(name in exported, `index.ts does not export ${name}`);
    assert.equal(exported[name], value, `index.ts ${name} is not the module's value`);
  }
});

test("[happy-13] the entry point's cipher factory and error class are the working ones", () => {
  const exported = index as Record<string, unknown>;
  const create = exported["createTokenCipher"] as typeof cipherModule.createTokenCipher;
  const ErrorClass = exported["TokenCipherError"] as typeof cipherModule.TokenCipherError;
  const same = exported["sameKeyId"] as typeof cipherModule.sameKeyId;
  assert.equal(typeof create, "function");
  const cipher = create(K2);
  assert.equal(cipher.keyId, "e32ee159945f");
  assert.equal(same(cipher.keyId, "e32ee159945f"), true);
  assert.throws(
    () => create("AAEC"),
    (error: unknown) => {
      assert.ok(error instanceof ErrorClass);
      assert.equal(error.name, "TokenCipherError");
      assert.equal(error.message, "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded; got 3.");
      return true;
    },
  );
});
