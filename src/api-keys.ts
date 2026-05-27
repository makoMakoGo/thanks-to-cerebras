import {
  API_KEY_CACHE_REVISION_KEY,
  API_KEY_PREFIX,
  PROXY_KEY_AUTH_REFRESH_INTERVAL_MS,
} from "./constants.ts";
import { toPersistedApiKey } from "./api-key-record.ts";
import { state } from "./state.ts";
import {
  getApiKeyCacheRevision,
  getNextRevisionValue,
  recordApiKeyCacheRevision,
} from "./kv/revisions.ts";
import { kvMergeAllApiKeysIntoCache } from "./kv/api-keys.ts";
import { logger } from "./logger.ts";

export function rebuildActiveKeyIds(): void {
  const keys = Array.from(state.cachedKeysById.values());
  keys.sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  state.cachedActiveKeyIds = keys.filter((k) => k.status === "active").map(
    (k) => k.id,
  );
  if (state.cachedActiveKeyIds.length === 0) {
    state.cachedCursor = 0;
    return;
  }
  state.cachedCursor = state.cachedCursor % state.cachedActiveKeyIds.length;
}

export function getNextApiKeyFast(
  now: number,
): { key: string; id: string } | null {
  if (state.cachedActiveKeyIds.length === 0) return null;

  for (let offset = 0; offset < state.cachedActiveKeyIds.length; offset++) {
    const idx = (state.cachedCursor + offset) % state.cachedActiveKeyIds.length;
    const id = state.cachedActiveKeyIds[idx];
    const cooldownUntil = state.keyCooldownUntil.get(id) ?? 0;
    if (cooldownUntil > now) continue;

    const keyEntry = state.cachedKeysById.get(id);
    if (!keyEntry || keyEntry.status !== "active") continue;
    if (!keyEntry.key) {
      throw new Error(`API key ${id} 未解密`);
    }

    state.cachedCursor = (idx + 1) % state.cachedActiveKeyIds.length;

    keyEntry.useCount += 1;
    keyEntry.lastUsed = now;
    state.dirtyKeyIds.add(id);

    if (state.cachedConfig) {
      state.addPendingTotalRequests(1);
      state.dirtyConfig = true;
    }

    return { key: keyEntry.key, id };
  }

  return null;
}

export async function refreshApiKeyCacheIfChanged(): Promise<void> {
  if (state.apiKeyCacheRevisionRefreshInFlight) {
    return await state.apiKeyCacheRevisionRefreshInFlight;
  }
  const refresh = refreshApiKeyCacheRevision();
  state.apiKeyCacheRevisionRefreshInFlight = refresh;
  try {
    await refresh;
  } finally {
    state.apiKeyCacheRevisionRefreshInFlight = null;
  }
}

async function refreshApiKeyCacheRevision(): Promise<void> {
  const now = Date.now();
  if (
    now - state.apiKeyCacheRevisionLastCheckedAt <
      PROXY_KEY_AUTH_REFRESH_INTERVAL_MS
  ) {
    return;
  }
  // Bump the throttle clock first so a sustained KV outage cannot turn the
  // throttle window into a per-request retry storm. With this in place the
  // proxy keeps serving from its existing cache for up to
  // PROXY_KEY_AUTH_REFRESH_INTERVAL_MS without hitting KV again, even if
  // every refresh attempt fails. See issue #138.
  state.apiKeyCacheRevisionLastCheckedAt = now;
  try {
    const revision = await getApiKeyCacheRevision();
    if (revision === state.apiKeyCacheRevision) return;
    await kvMergeAllApiKeysIntoCache();
    recordApiKeyCacheRevision(revision);
  } catch (error) {
    // Swallow KV errors instead of failing the proxy request: the existing
    // in-memory cache is still valid for the throttle window. Without this,
    // a transient KV outage cascades to 500 responses on every proxy
    // request that happens to fall outside the throttle window.
    logger.warn("api_key_cache_refresh_failed", {}, error);
  }
}

export function markKeyCooldownFrom429(id: string, response: Response): void {
  const retryAfter = response.headers.get("retry-after")?.trim();
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
    ? Number.parseInt(retryAfter, 10) * 1000
    : 2000;
  state.keyCooldownUntil.set(id, Date.now() + Math.max(0, retryAfterMs));
}

export async function markKeyInvalid(id: string): Promise<void> {
  const keyEntry = state.cachedKeysById.get(id);
  if (!keyEntry) return;
  if (keyEntry.status === "invalid") return;
  keyEntry.status = "invalid";
  state.keyCooldownUntil.delete(id);
  state.dirtyKeyIds.delete(id);
  rebuildActiveKeyIds();
  try {
    const key = [...API_KEY_PREFIX, id];
    const [entry, revisionEntry] = await Promise.all([
      state.kv.get(key),
      state.kv.get<number>(API_KEY_CACHE_REVISION_KEY),
    ]);
    if (!entry.value) return;
    const revision = getNextRevisionValue(revisionEntry);
    const result = await state.kv.atomic()
      .check(entry)
      .check(revisionEntry)
      .set(key, toPersistedApiKey(keyEntry))
      .set(API_KEY_CACHE_REVISION_KEY, revision)
      .commit();
    if (!result.ok) throw new Error("API key invalidation write conflict");
    recordApiKeyCacheRevision(revision);
  } catch (error) {
    state.dirtyKeyIds.add(id);
    logger.error("api_key_invalidation_write_failed", { keyId: id }, error);
  }
}
