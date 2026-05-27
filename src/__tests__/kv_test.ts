/**
 * Tests for kv.ts utility functions
 *
 * Note: Tests for KV operations that require actual KV access are in integration tests.
 * These tests focus on pure utility functions.
 */

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  kvEnsureConfigEntry,
  resolveKvFlushIntervalMs,
  validateProxyConfig,
} from "../kv/config.ts";
import { AppState, state } from "../state.ts";
import { checkKvRateLimit } from "../rate-limit.ts";
import {
  CONFIG_KEY,
  DEFAULT_KV_FLUSH_INTERVAL_MS,
  MIN_KV_FLUSH_INTERVAL_MS,
} from "../constants.ts";
import { normalizeKvFlushIntervalMs } from "../utils.ts";
import { createMockConfig } from "./test-utils.ts";

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

Deno.test("validateProxyConfig - accepts current structure", () => {
  const config = createMockConfig();
  const result = validateProxyConfig(config);
  assertEquals(result, config);
});

Deno.test("validateProxyConfig - fails fast on schemaVersion", () => {
  const legacy = { ...createMockConfig(), schemaVersion: "5.0" };
  assertThrows(
    () => validateProxyConfig(legacy),
    Error,
    "请清空 KV 后重启",
  );
});

Deno.test("validateProxyConfig - fails fast on disabledModels", () => {
  const legacy = { ...createMockConfig(), disabledModels: ["model-x"] };
  assertThrows(
    () => validateProxyConfig(legacy),
    Error,
    "请清空 KV 后重启",
  );
});

Deno.test("validateProxyConfig - fails fast when required field missing", () => {
  const { totalRequests: _removed, ...broken } = createMockConfig();
  assertThrows(
    () => validateProxyConfig(broken),
    Error,
    "请清空 KV 后重启",
  );
});
Deno.test("validateProxyConfig - treats missing proxyPublicAccess as closed", () => {
  const { proxyPublicAccess: _removed, ...legacy } = createMockConfig();
  const result = validateProxyConfig(legacy);
  assertEquals(result.proxyPublicAccess, false);
});

Deno.test("validateProxyConfig - fails fast on invalid kvFlushIntervalMs", () => {
  assertThrows(
    () => validateProxyConfig({ ...createMockConfig(), kvFlushIntervalMs: -1 }),
    Error,
    "请清空 KV 后重启",
  );

  assertThrows(
    () =>
      validateProxyConfig({
        ...createMockConfig(),
        kvFlushIntervalMs: 15000.5,
      }),
    Error,
    "请清空 KV 后重启",
  );
});

Deno.test("validateProxyConfig - returns same reference when canonical", () => {
  // Regression for the race that turned every concurrent /api/config call into
  // a 500 ("KV 配置迁移失败：写入冲突"): the validator used to allocate a new
  // object on every call, defeating the `config !== entry.value` short-circuit
  // in kvEnsureConfigEntry and forcing a CAS write on every single read.
  const config = createMockConfig();
  assertStrictEquals(validateProxyConfig(config), config);
});

Deno.test("validateProxyConfig - allocates new reference when modelPool needs dedupe", () => {
  const config = createMockConfig({
    modelPool: ["model-a", "model-a", "model-b"],
  });
  const result = validateProxyConfig(config);
  assertEquals(result.modelPool, ["model-a", "model-b"]);
  // Different reference => kvEnsureConfigEntry will perform the migration write.
  if (result === config) {
    throw new Error("expected new reference when normalization mutates pool");
  }
});

Deno.test("kvEnsureConfigEntry - canonical config does not write to KV", async () => {
  const kv = await Deno.openKv(":memory:");
  Object.assign(state, new AppState());
  state.kv = kv;
  try {
    const seed = createMockConfig();
    await kv.set(CONFIG_KEY, seed);
    const before = (await kv.get(CONFIG_KEY)).versionstamp;

    await kvEnsureConfigEntry();
    await kvEnsureConfigEntry();

    const after = (await kv.get(CONFIG_KEY)).versionstamp;
    // Same versionstamp proves no KV write happened on the hot path.
    assertEquals(after, before);
  } finally {
    kv.close();
  }
});

Deno.test("kvEnsureConfigEntry - concurrent migration retries instead of throwing", async () => {
  const kv = await Deno.openKv(":memory:");
  Object.assign(state, new AppState());
  state.kv = kv;
  try {
    // Seed a non-canonical config (proxyPublicAccess missing) so every call
    // first wants to migrate; only one CAS can win per round.
    const { proxyPublicAccess: _omit, ...legacy } = createMockConfig();
    await kv.set(CONFIG_KEY, legacy);

    const results = await Promise.all([
      kvEnsureConfigEntry(),
      kvEnsureConfigEntry(),
      kvEnsureConfigEntry(),
      kvEnsureConfigEntry(),
    ]);

    for (const entry of results) {
      assertEquals(entry.value.proxyPublicAccess, false);
    }
  } finally {
    kv.close();
  }
});

Deno.test("checkKvRateLimit - shares counters through KV and returns Retry-After", async () => {
  const kv = await Deno.openKv(":memory:");
  Object.assign(state, new AppState());
  state.kv = kv;

  try {
    const rule = { namespace: "unit", maxRequests: 2, windowMs: 60_000 };
    assertEquals(await checkKvRateLimit(rule, "same-key"), {
      allowed: true,
      retryAfterMs: 0,
    });
    assertEquals(await checkKvRateLimit(rule, "same-key"), {
      allowed: true,
      retryAfterMs: 0,
    });

    const limited = await checkKvRateLimit(rule, "same-key");
    assertEquals(limited.allowed, false);
    assertEquals(limited.retryAfterMs > 0, true);
  } finally {
    kv.close();
  }
});

Deno.test("checkKvRateLimit - resets expired windows", async () => {
  const kv = await Deno.openKv(":memory:");
  Object.assign(state, new AppState());
  state.kv = kv;

  try {
    const rule = { namespace: "unit-reset", maxRequests: 1, windowMs: 60_000 };
    assertEquals((await checkKvRateLimit(rule, "key")).allowed, true);
    assertEquals((await checkKvRateLimit(rule, "key")).allowed, false);

    await kv.set(["cerebras-proxy", "rate-limit", "unit-reset", "key"], {
      count: 1,
      resetAt: Date.now() - 1,
    });

    assertEquals(await checkKvRateLimit(rule, "key"), {
      allowed: true,
      retryAfterMs: 0,
    });
  } finally {
    kv.close();
  }
});
