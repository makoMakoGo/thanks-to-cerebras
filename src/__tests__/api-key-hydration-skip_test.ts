/**
 * Regression tests for issue #144: kvGetAllKeys / kvMergeAllApiKeysIntoCache
 * must skip individual records that fail hydration rather than failing the
 * entire batch, and must not evict cached entries whose KV records were
 * present-but-unreadable.
 */

import { assertEquals } from "@std/assert";
import { API_KEY_PREFIX } from "../constants.ts";
import { encryptApiKey } from "../secrets.ts";
import { kvGetAllKeys, kvMergeAllApiKeysIntoCache } from "../kv/api-keys.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { metrics } from "../metrics.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { AppState, state } from "../state.ts";
import { setLogSinkForTests } from "../logger.ts";
import type { ApiKey } from "../types.ts";

interface CapturedLog {
  level: string;
  record: Record<string, unknown>;
}

function captureLogs(): { records: CapturedLog[]; restore: () => void } {
  const records: CapturedLog[] = [];
  setLogSinkForTests((level, line) => {
    records.push({ level, record: JSON.parse(line) });
  });
  return {
    records,
    restore: () => setLogSinkForTests(null),
  };
}

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) clearInterval(state.kvFlushTimerId);
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("SETUP_TOKEN", "test-setup-token");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  await bootstrapCache();
  await resetKvRateLimitsForTests();
  await resetProxyStreamCountersForTests();
  metrics.reset();
  return kv;
}

async function writeGoodRecord(id: string, plaintext: string): Promise<void> {
  await state.kv.set([...API_KEY_PREFIX, id], {
    id,
    encryptedKey: await encryptApiKey(plaintext),
    useCount: 0,
    status: "active",
    createdAt: Date.now(),
  });
}

Deno.test(
  "kvGetAllKeys: skips malformed structure (missing encryptedKey)",
  async () => {
    const kv = await setupKv();
    const logs = captureLogs();
    try {
      await writeGoodRecord("good", "sk-good-1");
      // Legacy-shaped record: has plaintext `key` but no `encryptedKey`.
      await state.kv.set([...API_KEY_PREFIX, "bad-missing-encrypted"], {
        id: "bad-missing-encrypted",
        key: "sk-legacy",
        useCount: 0,
        status: "active",
        createdAt: Date.now(),
      });

      const keys = await kvGetAllKeys();

      assertEquals(keys.length, 1);
      assertEquals(keys[0].id, "good");

      const warns = logs.records.filter(
        (r) =>
          r.level === "warn" && r.record.event === "api_key_hydrate_failed",
      );
      assertEquals(warns.length, 1);
      assertEquals(warns[0].record.keyId, "bad-missing-encrypted");

      assertEquals(
        metrics.snapshot().api_key_hydrate_failed_total?.skipped,
        1,
      );
    } finally {
      logs.restore();
      kv.close();
    }
  },
);

Deno.test(
  "kvGetAllKeys: skips invalid ciphertext format",
  async () => {
    const kv = await setupKv();
    const logs = captureLogs();
    try {
      await writeGoodRecord("good", "sk-good-2");
      await state.kv.set([...API_KEY_PREFIX, "bad-invalid-cipher"], {
        id: "bad-invalid-cipher",
        encryptedKey: "not-encrypted",
        useCount: 0,
        status: "active",
        createdAt: Date.now(),
      });

      const keys = await kvGetAllKeys();

      assertEquals(keys.length, 1);
      assertEquals(keys[0].id, "good");

      const warns = logs.records.filter(
        (r) =>
          r.level === "warn" && r.record.event === "api_key_hydrate_failed",
      );
      assertEquals(warns.length, 1);
      assertEquals(warns[0].record.keyId, "bad-invalid-cipher");
    } finally {
      logs.restore();
      kv.close();
    }
  },
);

Deno.test(
  "kvGetAllKeys: skips decrypt failure (record encrypted with different secret)",
  async () => {
    const kv = await setupKv();
    const logs = captureLogs();
    try {
      await writeGoodRecord("good", "sk-good-3");

      // Generate a ciphertext under a different secret so isEncryptedApiKey()
      // passes but crypto.subtle.decrypt rejects under the active secret.
      Deno.env.set("KEY_ENCRYPTION_SECRET", "wrong-secret");
      const wrongCiphertext = await encryptApiKey("sk-bad");
      Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");

      await state.kv.set([...API_KEY_PREFIX, "bad-decrypt"], {
        id: "bad-decrypt",
        encryptedKey: wrongCiphertext,
        useCount: 0,
        status: "active",
        createdAt: Date.now(),
      });

      const keys = await kvGetAllKeys();

      assertEquals(keys.length, 1);
      assertEquals(keys[0].id, "good");

      const warns = logs.records.filter(
        (r) =>
          r.level === "warn" && r.record.event === "api_key_hydrate_failed",
      );
      assertEquals(warns.length, 1);
      assertEquals(warns[0].record.keyId, "bad-decrypt");
    } finally {
      logs.restore();
      kv.close();
    }
  },
);

Deno.test(
  "kvMergeAllApiKeysIntoCache: bad record no longer blocks good changes",
  async () => {
    const kv = await setupKv();
    const logs = captureLogs();
    try {
      // Seed the cache with an "old" key that has since been deleted from KV.
      const old: ApiKey = {
        id: "old",
        key: "sk-old",
        encryptedKey: await encryptApiKey("sk-old"),
        useCount: 0,
        status: "active",
        createdAt: Date.now(),
      };
      state.cachedKeysById.set(old.id, old);

      await writeGoodRecord("good-new", "sk-good-new");
      await state.kv.set([...API_KEY_PREFIX, "bad"], {
        id: "bad",
        encryptedKey: "not-encrypted",
        useCount: 0,
        status: "active",
        createdAt: Date.now(),
      });

      await kvMergeAllApiKeysIntoCache();

      assertEquals(state.cachedKeysById.has("good-new"), true);
      assertEquals(state.cachedKeysById.has("bad"), false);
      // "old" is genuinely absent from KV (not skipped) and must be evicted.
      assertEquals(state.cachedKeysById.has("old"), false);
      assertEquals(state.cachedActiveKeyIds.includes("good-new"), true);
    } finally {
      logs.restore();
      kv.close();
    }
  },
);

Deno.test(
  "kvMergeAllApiKeysIntoCache: skipped cached id is not evicted",
  async () => {
    const kv = await setupKv();
    const logs = captureLogs();
    try {
      const stable: ApiKey = {
        id: "cached-bad",
        key: "sk-stable",
        encryptedKey: await encryptApiKey("sk-stable"),
        useCount: 0,
        status: "active",
        createdAt: Date.now(),
      };
      state.cachedKeysById.set(stable.id, stable);

      // KV has the same id but the record is unreadable.
      await state.kv.set([...API_KEY_PREFIX, "cached-bad"], {
        id: "cached-bad",
        encryptedKey: "not-encrypted",
        useCount: 0,
        status: "active",
        createdAt: Date.now(),
      });

      await kvMergeAllApiKeysIntoCache();

      assertEquals(state.cachedKeysById.has("cached-bad"), true);
      assertEquals(state.cachedKeysById.get("cached-bad")?.key, "sk-stable");
    } finally {
      logs.restore();
      kv.close();
    }
  },
);

Deno.test(
  "bootstrapCache: bad record does not block startup",
  async () => {
    if (state.kvFlushTimerId !== null) clearInterval(state.kvFlushTimerId);
    Deno.env.set("SETUP_TOKEN", "test-setup-token");
    Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
    Object.assign(state, new AppState());
    const kv = await Deno.openKv(":memory:");
    state.kv = kv;
    metrics.reset();
    const logs = captureLogs();

    try {
      await writeGoodRecord("good", "sk-bootstrap");
      await state.kv.set([...API_KEY_PREFIX, "bad"], {
        id: "bad",
        encryptedKey: "not-encrypted",
        useCount: 0,
        status: "active",
        createdAt: Date.now(),
      });

      await bootstrapCache();

      assertEquals(state.cachedKeysById.has("good"), true);
      assertEquals(state.cachedKeysById.has("bad"), false);
    } finally {
      logs.restore();
      kv.close();
    }
  },
);
