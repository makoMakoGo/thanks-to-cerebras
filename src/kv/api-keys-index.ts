/**
 * Secondary index for api-key plaintext values: sha256(value) → id.
 * The index lets `kvAddKey` reject same-value duplicates even when the
 * caller's in-memory cache is stale (e.g. another instance just added
 * the same value, or the local revision check has not caught up).
 *
 * Issue #139.
 */

import { API_KEY_PREFIX, API_KEY_VALUE_INDEX_PREFIX } from "../constants.ts";
import { assertCurrentApiKey } from "../api-key-record.ts";
import { sha256Hex } from "../crypto.ts";
import { decryptApiKey } from "../secrets.ts";
import { logger } from "../logger.ts";
import { state } from "../state.ts";

export function valueIndexKey(digest: string): Deno.KvKey {
  return [...API_KEY_VALUE_INDEX_PREFIX, digest];
}

/**
 * Walks the api-keys KV prefix and ensures every record has a matching
 * value-index entry. Idempotent — safe to run on every cold start.
 *
 * Behaviour:
 * - Missing index → atomically create it pointing at the record's id.
 * - Existing index points at this id → no-op.
 * - Existing index points at a different id → log warn but do not
 *   overwrite or delete either record. A backfill path repairs missing
 *   indexes; it must not choose which user data to discard.
 *
 * Concurrency: a CAS conflict means another instance won the race for
 * the same digest; treat as success (the entry is now there). Any other
 * error is surfaced so the caller can decide whether to fail bootstrap.
 */
export async function kvBackfillApiKeyValueIndex(): Promise<{
  created: number;
  preExistingDuplicates: number;
}> {
  let created = 0;
  let preExistingDuplicates = 0;
  const iter = state.kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    const persisted = assertCurrentApiKey(entry.value);
    const plaintext = await decryptApiKey(persisted.encryptedKey);
    const digest = await sha256Hex(plaintext);
    const indexKey = valueIndexKey(digest);
    const indexEntry = await state.kv.get<string>(indexKey);
    if (indexEntry.value === persisted.id) continue;
    if (indexEntry.value !== null && indexEntry.value !== persisted.id) {
      preExistingDuplicates++;
      logger.warn("api_key_value_index_pre_existing_duplicate", {
        keptId: indexEntry.value,
        duplicateId: persisted.id,
      });
      continue;
    }
    const result = await state.kv.atomic()
      .check(entry)
      .check(indexEntry)
      .set(indexKey, persisted.id)
      .commit();
    if (result.ok) created++;
    // CAS lost: either another instance set the index for this digest
    // first (idempotent if it points at our id; surfaced next iteration
    // if at a duplicate), or the main record was concurrently modified
    // / deleted (in which case writing the index would have produced a
    // dangling pointer). The current run does not need to retry —
    // `entry` is now stale anyway.
  }
  return { created, preExistingDuplicates };
}
