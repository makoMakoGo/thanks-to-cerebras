/**
 * Tests for api-keys.ts
 *
 * Note: These tests focus on pure functions that don't require KV.
 * Functions like getNextApiKeyFast depend on global state and are tested
 * via integration tests.
 */

import { assertEquals } from "@std/assert";
import { state } from "../state.ts";
import { getNextApiKeyFast, rebuildActiveKeyIds } from "../api-keys.ts";
import { createMockApiKey } from "./test_utils.ts";

function resetState() {
  state.cachedKeysById = new Map();
  state.cachedActiveKeyIds = [];
  state.cachedCursor = 0;
  state.keyCooldownUntil.clear();
}

Deno.test("rebuildActiveKeyIds - builds sorted list of active keys", () => {
  resetState();

  const key1 = createMockApiKey({
    id: "key-1",
    status: "active",
    createdAt: 1000,
  });
  const key2 = createMockApiKey({
    id: "key-2",
    status: "active",
    createdAt: 2000,
  });
  const key3 = createMockApiKey({
    id: "key-3",
    status: "invalid",
    createdAt: 1500,
  });

  state.cachedKeysById = new Map([
    ["key-1", key1],
    ["key-2", key2],
    ["key-3", key3],
  ]);

  rebuildActiveKeyIds();

  assertEquals(state.cachedActiveKeyIds, ["key-1", "key-2"]);
});

Deno.test("rebuildActiveKeyIds - handles empty key set", () => {
  resetState();
  rebuildActiveKeyIds();
  assertEquals(state.cachedActiveKeyIds, []);
});

Deno.test("rebuildActiveKeyIds - excludes inactive keys", () => {
  resetState();

  const key1 = createMockApiKey({
    id: "key-1",
    status: "inactive" as "active",
    createdAt: 1000,
  });

  state.cachedKeysById = new Map([["key-1", key1]]);
  rebuildActiveKeyIds();

  assertEquals(state.cachedActiveKeyIds, []);
});

Deno.test("getNextApiKeyFast - returns null when no keys available", () => {
  resetState();
  const result = getNextApiKeyFast(Date.now());
  assertEquals(result, null);
});

Deno.test("getNextApiKeyFast - returns key and increments cursor", () => {
  resetState();

  const key1 = createMockApiKey({
    id: "key-1",
    key: "api-key-1",
    status: "active",
    createdAt: 1000,
  });
  const key2 = createMockApiKey({
    id: "key-2",
    key: "api-key-2",
    status: "active",
    createdAt: 2000,
  });

  state.cachedKeysById = new Map([
    ["key-1", key1],
    ["key-2", key2],
  ]);
  rebuildActiveKeyIds();

  const now = Date.now();
  const result1 = getNextApiKeyFast(now);
  assertEquals(result1?.key, "api-key-1");

  const result2 = getNextApiKeyFast(now);
  assertEquals(result2?.key, "api-key-2");

  // Should wrap around
  const result3 = getNextApiKeyFast(now);
  assertEquals(result3?.key, "api-key-1");
});

Deno.test("getNextApiKeyFast - skips keys in cooldown", () => {
  resetState();

  const key1 = createMockApiKey({
    id: "key-1",
    key: "api-key-1",
    status: "active",
    createdAt: 1000,
  });
  const key2 = createMockApiKey({
    id: "key-2",
    key: "api-key-2",
    status: "active",
    createdAt: 2000,
  });

  state.cachedKeysById = new Map([
    ["key-1", key1],
    ["key-2", key2],
  ]);
  rebuildActiveKeyIds();

  const now = Date.now();
  state.keyCooldownUntil.set("key-1", now + 10000);

  const result = getNextApiKeyFast(now);
  assertEquals(result?.key, "api-key-2");
});

Deno.test("getNextApiKeyFast - returns null when all keys in cooldown", () => {
  resetState();

  const key1 = createMockApiKey({
    id: "key-1",
    key: "api-key-1",
    status: "active",
    createdAt: 1000,
  });

  state.cachedKeysById = new Map([["key-1", key1]]);
  rebuildActiveKeyIds();

  const now = Date.now();
  state.keyCooldownUntil.set("key-1", now + 10000);

  const result = getNextApiKeyFast(now);
  assertEquals(result, null);
});

Deno.test("getNextApiKeyFast - increments useCount", () => {
  resetState();

  const key1 = createMockApiKey({
    id: "key-1",
    key: "api-key-1",
    status: "active",
    useCount: 5,
    createdAt: 1000,
  });

  state.cachedKeysById = new Map([["key-1", key1]]);
  rebuildActiveKeyIds();

  getNextApiKeyFast(Date.now());

  const updatedKey = state.cachedKeysById.get("key-1");
  assertEquals(updatedKey?.useCount, 6);
});
