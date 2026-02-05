/**
 * Tests for auth.ts
 *
 * Note: Functions that require KV access are tested via integration tests.
 * These tests focus on functions that can be tested with mocked state.
 */

import { assertEquals } from "@std/assert";
import {
  cachedProxyKeys,
  dirtyProxyKeyIds,
  setCachedProxyKeys,
} from "../state.ts";
import { recordProxyKeyUsage } from "../auth.ts";
import { createMockProxyKey } from "./test_utils.ts";

// Helper to reset state before each test
function resetState() {
  setCachedProxyKeys(new Map());
  dirtyProxyKeyIds.clear();
}

Deno.test("recordProxyKeyUsage - increments useCount", () => {
  resetState();

  const proxyKey = createMockProxyKey({
    id: "pk-1",
    useCount: 5,
  });
  setCachedProxyKeys(new Map([["pk-1", proxyKey]]));

  recordProxyKeyUsage("pk-1");

  const updatedKey = cachedProxyKeys.get("pk-1");
  assertEquals(updatedKey?.useCount, 6);
});

Deno.test("recordProxyKeyUsage - sets lastUsed timestamp", () => {
  resetState();

  const proxyKey = createMockProxyKey({
    id: "pk-1",
    lastUsed: undefined,
  });
  setCachedProxyKeys(new Map([["pk-1", proxyKey]]));

  const before = Date.now();
  recordProxyKeyUsage("pk-1");
  const after = Date.now();

  const updatedKey = cachedProxyKeys.get("pk-1");
  assertEquals(updatedKey?.lastUsed !== undefined, true);
  assertEquals(updatedKey!.lastUsed! >= before, true);
  assertEquals(updatedKey!.lastUsed! <= after, true);
});

Deno.test("recordProxyKeyUsage - marks key as dirty", () => {
  resetState();

  const proxyKey = createMockProxyKey({ id: "pk-1" });
  setCachedProxyKeys(new Map([["pk-1", proxyKey]]));

  assertEquals(dirtyProxyKeyIds.has("pk-1"), false);
  recordProxyKeyUsage("pk-1");
  assertEquals(dirtyProxyKeyIds.has("pk-1"), true);
});

Deno.test("recordProxyKeyUsage - does nothing for non-existent key", () => {
  resetState();

  // Should not throw
  recordProxyKeyUsage("non-existent");
  assertEquals(dirtyProxyKeyIds.has("non-existent"), false);
});

Deno.test("recordProxyKeyUsage - handles multiple calls", () => {
  resetState();

  const proxyKey = createMockProxyKey({
    id: "pk-1",
    useCount: 0,
  });
  setCachedProxyKeys(new Map([["pk-1", proxyKey]]));

  recordProxyKeyUsage("pk-1");
  recordProxyKeyUsage("pk-1");
  recordProxyKeyUsage("pk-1");

  const updatedKey = cachedProxyKeys.get("pk-1");
  assertEquals(updatedKey?.useCount, 3);
});
