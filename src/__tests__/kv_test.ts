/**
 * Tests for kv.ts utility functions
 *
 * Note: Tests for KV operations that require actual KV access are in integration tests.
 * These tests focus on pure utility functions.
 */

import { assertEquals } from "@std/assert";
import { resolveKvFlushIntervalMs } from "../kv.ts";
import {
  DEFAULT_KV_FLUSH_INTERVAL_MS,
  MIN_KV_FLUSH_INTERVAL_MS,
} from "../constants.ts";
import { normalizeKvFlushIntervalMs } from "../utils.ts";
import { createMockConfig } from "./test_utils.ts";

Deno.test("resolveKvFlushIntervalMs - returns default for null config", () => {
  const result = resolveKvFlushIntervalMs(null);
  assertEquals(result, DEFAULT_KV_FLUSH_INTERVAL_MS);
});

Deno.test("resolveKvFlushIntervalMs - uses config value when set", () => {
  const config = createMockConfig({ kvFlushIntervalMs: 5000 });
  const result = resolveKvFlushIntervalMs(config);
  assertEquals(result, 5000);
});

Deno.test("resolveKvFlushIntervalMs - clamps to minimum", () => {
  const config = createMockConfig({ kvFlushIntervalMs: 100 });
  const result = resolveKvFlushIntervalMs(config);
  assertEquals(result, MIN_KV_FLUSH_INTERVAL_MS);
});

Deno.test("resolveKvFlushIntervalMs - clamps zero to minimum", () => {
  const config = createMockConfig({ kvFlushIntervalMs: 0 });
  const result = resolveKvFlushIntervalMs(config);
  assertEquals(result, MIN_KV_FLUSH_INTERVAL_MS);
});

Deno.test("normalizeKvFlushIntervalMs - returns default for NaN", () => {
  assertEquals(normalizeKvFlushIntervalMs(NaN), DEFAULT_KV_FLUSH_INTERVAL_MS);
});

Deno.test("normalizeKvFlushIntervalMs - returns default for Infinity", () => {
  assertEquals(
    normalizeKvFlushIntervalMs(Infinity),
    DEFAULT_KV_FLUSH_INTERVAL_MS,
  );
  assertEquals(
    normalizeKvFlushIntervalMs(-Infinity),
    DEFAULT_KV_FLUSH_INTERVAL_MS,
  );
});

Deno.test("normalizeKvFlushIntervalMs - truncates decimal values", () => {
  assertEquals(normalizeKvFlushIntervalMs(5000.7), 5000);
  assertEquals(normalizeKvFlushIntervalMs(5000.2), 5000);
});

Deno.test("normalizeKvFlushIntervalMs - clamps negative values to minimum", () => {
  assertEquals(normalizeKvFlushIntervalMs(-5000), MIN_KV_FLUSH_INTERVAL_MS);
});
