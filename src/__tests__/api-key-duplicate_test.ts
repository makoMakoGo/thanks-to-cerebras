/**
 * Regression tests for issue #139: kvAddKey must reject same-value
 * duplicates even when the in-memory cache is stale (multi-instance
 * deploy / cold-start window). The detection relies on a sha256(value)
 * → id secondary index, which kvBackfillApiKeyValueIndex backfills for
 * records persisted before the index existed.
 */

import { assertEquals } from "@std/assert";
import { API_KEY_PREFIX, API_KEY_VALUE_INDEX_PREFIX } from "../constants.ts";
import { sha256Hex } from "../crypto.ts";
import { encryptApiKey } from "../secrets.ts";
import { kvAddKey, kvDeleteKey } from "../kv/api-keys.ts";
import { kvBackfillApiKeyValueIndex } from "../kv/api-keys-index.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { rebuildActiveKeyIds } from "../api-keys.ts";
import { metrics } from "../metrics.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { AppState, state } from "../state.ts";
import { setLogSinkForTests } from "../logger.ts";

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
  setLogSinkForTests(() => {});
  return kv;
}

/**
 * Persists an api-key record at the given id WITHOUT going through
 * kvAddKey — i.e. without creating a value-index entry. Mimics records
 * created on a deployment that pre-dates the index.
 */
async function persistLegacyApiKey(id: string, key: string): Promise<void> {
  await state.kv.set([...API_KEY_PREFIX, id], {
    id,
    encryptedKey: await encryptApiKey(key),
    useCount: 0,
    status: "active" as const,
    createdAt: Date.now(),
  });
}

Deno.test(
  "kvAddKey: duplicate same-value rejected when cache is stale (cross-instance)",
  async () => {
    const kv = await setupKv();
    try {
      const first = await kvAddKey("sk-cross-instance-dup");
      assertEquals(first.success, true);

      // Simulate the multi-instance scenario: instance B's in-memory cache
      // has not yet caught up to the revision bump from instance A. The
      // value is already in KV (with its index entry) but this instance
      // still reports an empty cache.
      state.cachedKeysById.clear();
      state.cachedActiveKeyIds = [];

      const second = await kvAddKey("sk-cross-instance-dup");
      assertEquals(second.success, false);
      assertEquals(second.error, "密钥已存在");

      // KV must still hold exactly one record under the api-key prefix.
      // Filtering by first.id would silently miss a duplicate written
      // under a different id — which is exactly the regression #139
      // guards against. Count every record instead.
      let total = 0;
      const iter = state.kv.list({ prefix: API_KEY_PREFIX });
      for await (const entry of iter) {
        void entry;
        total += 1;
      }
      assertEquals(total, 1);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvAddKey + kvDeleteKey: re-adding the same value after delete works",
  async () => {
    const kv = await setupKv();
    try {
      const first = await kvAddKey("sk-cycle");
      assertEquals(first.success, true);

      const del = await kvDeleteKey(first.id!);
      assertEquals(del.success, true);

      // Index entry must be gone after delete.
      const digest = await sha256Hex("sk-cycle");
      const indexEntry = await state.kv.get<string>([
        ...API_KEY_VALUE_INDEX_PREFIX,
        digest,
      ]);
      assertEquals(indexEntry.value, null);

      // Re-adding the same value succeeds with a fresh id.
      const second = await kvAddKey("sk-cycle");
      assertEquals(second.success, true);
      assertEquals(second.id !== first.id, true);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvDeleteKey: tolerates legacy record with no value-index entry",
  async () => {
    const kv = await setupKv();
    try {
      const id = "legacy-no-index";
      await persistLegacyApiKey(id, "sk-legacy");
      // Cache is intentionally not refreshed — exercise the path where
      // kvDeleteKey must decrypt the persisted record to compute the
      // digest itself.

      const result = await kvDeleteKey(id);
      assertEquals(result.success, true);

      // After deletion the record is gone and there is no index entry
      // either (because none existed in the first place).
      const stored = await state.kv.get([...API_KEY_PREFIX, id]);
      assertEquals(stored.value, null);
      const digest = await sha256Hex("sk-legacy");
      const indexEntry = await state.kv.get<string>([
        ...API_KEY_VALUE_INDEX_PREFIX,
        digest,
      ]);
      assertEquals(indexEntry.value, null);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvBackfillApiKeyValueIndex: creates missing index entries idempotently",
  async () => {
    const kv = await setupKv();
    try {
      await persistLegacyApiKey("legacy-a", "sk-legacy-a");
      await persistLegacyApiKey("legacy-b", "sk-legacy-b");

      const first = await kvBackfillApiKeyValueIndex();
      assertEquals(first.created, 2);
      assertEquals(first.preExistingDuplicates, 0);

      // Index entries now point at the right ids.
      for (
        const [id, key] of [
          ["legacy-a", "sk-legacy-a"],
          ["legacy-b", "sk-legacy-b"],
        ] as const
      ) {
        const digest = await sha256Hex(key);
        const indexEntry = await state.kv.get<string>([
          ...API_KEY_VALUE_INDEX_PREFIX,
          digest,
        ]);
        assertEquals(indexEntry.value, id);
      }

      // Second call is a no-op.
      const second = await kvBackfillApiKeyValueIndex();
      assertEquals(second.created, 0);
      assertEquals(second.preExistingDuplicates, 0);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvBackfillApiKeyValueIndex: leaves pre-existing duplicate alone and logs warn",
  async () => {
    const kv = await setupKv();
    const logs = captureLogs();
    try {
      // Two records with the same plaintext value but different ids
      // (the exact scenario issue #139 was about: written by separate
      // instances before the index existed).
      await persistLegacyApiKey("dup-keep", "sk-shared-value");
      await persistLegacyApiKey("dup-other", "sk-shared-value");

      const result = await kvBackfillApiKeyValueIndex();
      // Exactly one record gets the index slot; the other is reported.
      assertEquals(result.created, 1);
      assertEquals(result.preExistingDuplicates, 1);

      const digest = await sha256Hex("sk-shared-value");
      const indexEntry = await state.kv.get<string>([
        ...API_KEY_VALUE_INDEX_PREFIX,
        digest,
      ]);
      // The index points at one of the two records (whichever the list
      // iteration visited first); the other record is left intact in KV
      // for an admin to clean up.
      const winnerId = indexEntry.value;
      assertEquals(typeof winnerId, "string");
      const both = ["dup-keep", "dup-other"];
      assertEquals(both.includes(winnerId as string), true);

      const stored = await Promise.all(
        both.map((id) => state.kv.get([...API_KEY_PREFIX, id])),
      );
      assertEquals(stored.every((entry) => entry.value !== null), true);

      const warns = logs.records.filter(
        (r) =>
          r.level === "warn" &&
          r.record.event === "api_key_value_index_pre_existing_duplicate",
      );
      assertEquals(warns.length, 1);
      assertEquals(warns[0].record.keptId, winnerId);
    } finally {
      logs.restore();
      kv.close();
    }
  },
);

Deno.test(
  "kvAddKey: detects duplicate even after cache cleared but only after backfill",
  async () => {
    // Belt-and-braces variant: even when the legacy duplicate scenario
    // has happened, once kvBackfillApiKeyValueIndex has run the index
    // protects subsequent adds. A new same-value add must be rejected.
    const kv = await setupKv();
    try {
      await persistLegacyApiKey("legacy-protected", "sk-protected");
      await kvBackfillApiKeyValueIndex();

      // Stale cache: this instance has no in-memory copy.
      state.cachedKeysById.clear();
      state.cachedActiveKeyIds = [];
      rebuildActiveKeyIds();

      const result = await kvAddKey("sk-protected");
      assertEquals(result.success, false);
      assertEquals(result.error, "密钥已存在");
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "bootstrapCache: backfills index entries for pre-existing records",
  async () => {
    const kv = await setupKv();
    try {
      await persistLegacyApiKey("bootstrap-legacy", "sk-bootstrap");

      // Re-run bootstrap so the backfill path executes against the
      // newly-inserted legacy record.
      await bootstrapCache();

      const digest = await sha256Hex("sk-bootstrap");
      const indexEntry = await state.kv.get<string>([
        ...API_KEY_VALUE_INDEX_PREFIX,
        digest,
      ]);
      assertEquals(indexEntry.value, "bootstrap-legacy");
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "assertCurrentApiKey: defensive type guard rejects non-object values",
  async () => {
    // assertCurrentApiKey runs against arbitrary KV payloads — pre-#145
    // a null / non-object value tripped a TypeError instead of the
    // expected "格式不兼容" error. Lock the defensive shape down.
    const { assertCurrentApiKey } = await import("../api-key-record.ts");
    for (const value of [null, undefined, 42, "string", true]) {
      try {
        assertCurrentApiKey(value);
        throw new Error(
          `assertCurrentApiKey accepted ${JSON.stringify(value)}`,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        assertEquals(
          error.message.startsWith("API key 存储格式不兼容"),
          true,
          `unexpected error for ${JSON.stringify(value)}: ${error.message}`,
        );
      }
    }
  },
);

Deno.test(
  "kvDeleteKey: blocks dangling index from concurrent backfill (CAS)",
  async () => {
    // Race scenario: kvDeleteKey reads a null indexEntry for a legacy
    // record, then a concurrent backfill writes the index for that
    // record's digest before kvDeleteKey commits. Pre-fix the delete
    // proceeded anyway and left a dangling index pointing at the just-
    // deleted id, permanently locking that plaintext out of future
    // kvAddKey. Post-fix the delete CASes the indexEntry slot itself
    // and must fail (returns 密钥删除失败) so the caller can retry.
    const kv = await setupKv();
    try {
      const id = "race-legacy";
      await persistLegacyApiKey(id, "sk-race");
      const digest = await sha256Hex("sk-race");
      const indexKey = [...API_KEY_VALUE_INDEX_PREFIX, digest];

      // Inject the race: monkey-patch state.kv.atomic so that just before
      // kvDeleteKey commits, we slip an index write into KV. The atomic
      // commit's CAS on the (formerly null) indexEntry must now fail.
      const originalAtomic = state.kv.atomic.bind(state.kv);
      let raced = false;
      state.kv.atomic = (() => {
        const tx = originalAtomic();
        const originalCommit = tx.commit.bind(tx);
        tx.commit = async () => {
          if (!raced) {
            raced = true;
            await state.kv.set(indexKey, id);
          }
          return originalCommit();
        };
        return tx;
      }) as typeof state.kv.atomic;

      try {
        const result = await kvDeleteKey(id);
        assertEquals(result.success, false);
        assertEquals(result.error, "密钥删除失败，请重试");
      } finally {
        state.kv.atomic = originalAtomic;
      }

      // Main record AND index must still both exist — nothing got
      // deleted because the CAS conflict aborted the atomic.
      const stored = await state.kv.get([...API_KEY_PREFIX, id]);
      assertEquals(stored.value !== null, true);
      const indexEntry = await state.kv.get<string>(indexKey);
      assertEquals(indexEntry.value, id);
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "kvAddKey: concurrent same-value race loser returns 密钥已存在 (not save-failed)",
  async () => {
    // Race scenario: kvAddKey reads a null indexEntry for a fresh
    // plaintext, then another instance commits the same plaintext before
    // this caller's atomic lands. The atomic CAS on indexEntry fails. Pre-
    // fix the loser returned "密钥保存失败，请重试" → HTTP 400 generic
    // conflict. Post-fix it re-reads indexKey; if non-null it returns
    // "密钥已存在" → HTTP 409, matching the actual situation.
    const kv = await setupKv();
    try {
      const plaintext = "sk-race-add";
      const digest = await sha256Hex(plaintext);
      const indexKey = [...API_KEY_VALUE_INDEX_PREFIX, digest];

      // Inject the race: monkey-patch state.kv.atomic so that just before
      // kvAddKey commits, a competing write lands on indexKey. The atomic
      // CAS on the (formerly null) indexEntry must now fail, and the post-
      // CAS re-read must trigger the duplicate-error branch.
      const originalAtomic = state.kv.atomic.bind(state.kv);
      let raced = false;
      state.kv.atomic = (() => {
        const tx = originalAtomic();
        const originalCommit = tx.commit.bind(tx);
        tx.commit = async () => {
          if (!raced) {
            raced = true;
            await state.kv.set(indexKey, "race-winner-id");
          }
          return originalCommit();
        };
        return tx;
      }) as typeof state.kv.atomic;

      try {
        const result = await kvAddKey(plaintext);
        assertEquals(result.success, false);
        assertEquals(result.error, "密钥已存在");
      } finally {
        state.kv.atomic = originalAtomic;
      }
    } finally {
      setLogSinkForTests(null);
      kv.close();
    }
  },
);
