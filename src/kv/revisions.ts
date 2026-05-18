import {
  API_KEY_CACHE_REVISION_KEY,
  AUTH_CACHE_REVISION_KEY,
  KV_ATOMIC_MAX_RETRIES,
} from "../constants.ts";
import { state } from "../state.ts";

async function getRevision(key: readonly string[]): Promise<number> {
  const entry = await state.kv.get<number>(key);
  return typeof entry.value === "number" && Number.isFinite(entry.value)
    ? entry.value
    : 0;
}

async function bumpRevision(key: readonly string[]): Promise<number> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const entry = await state.kv.get<number>(key);
    const current = typeof entry.value === "number" &&
        Number.isFinite(entry.value)
      ? entry.value
      : 0;
    const next = Math.max(Date.now(), current + 1);
    const result = await state.kv.atomic()
      .check(entry)
      .set(key, next)
      .commit();
    if (result.ok) return next;
  }
  throw new Error("KV revision update failed after retries");
}

export function getAuthCacheRevision(): Promise<number> {
  return getRevision(AUTH_CACHE_REVISION_KEY);
}

export async function bumpAuthCacheRevision(): Promise<number> {
  state.authCacheRevision = await bumpRevision(AUTH_CACHE_REVISION_KEY);
  state.authCacheRevisionLastCheckedAt = Date.now();
  return state.authCacheRevision;
}

export function getApiKeyCacheRevision(): Promise<number> {
  return getRevision(API_KEY_CACHE_REVISION_KEY);
}

export async function bumpApiKeyCacheRevision(): Promise<number> {
  state.apiKeyCacheRevision = await bumpRevision(API_KEY_CACHE_REVISION_KEY);
  state.apiKeyCacheRevisionLastCheckedAt = Date.now();
  return state.apiKeyCacheRevision;
}
