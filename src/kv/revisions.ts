import {
  API_KEY_CACHE_REVISION_KEY,
  AUTH_CACHE_REVISION_KEY,
  KV_ATOMIC_MAX_RETRIES,
} from "../constants.ts";
import { state } from "../state.ts";

async function getRevision(key: readonly string[]): Promise<number> {
  const entry = await state.kv.get<number>(key);
  return getRevisionValue(entry);
}

export function getRevisionValue(entry: Deno.KvEntryMaybe<number>): number {
  return typeof entry.value === "number" && Number.isFinite(entry.value)
    ? entry.value
    : 0;
}

export function getNextRevisionValue(entry: Deno.KvEntryMaybe<number>): number {
  return Math.max(Date.now(), getRevisionValue(entry) + 1);
}

async function bumpRevision(key: readonly string[]): Promise<number> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const entry = await state.kv.get<number>(key);
    const next = getNextRevisionValue(entry);
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
  recordAuthCacheRevision(await bumpRevision(AUTH_CACHE_REVISION_KEY));
  return state.authCacheRevision;
}

export function getApiKeyCacheRevision(): Promise<number> {
  return getRevision(API_KEY_CACHE_REVISION_KEY);
}

export function recordAuthCacheRevision(revision: number): void {
  state.authCacheRevision = revision;
  state.authCacheRevisionLastCheckedAt = Date.now();
}

export async function bumpApiKeyCacheRevision(): Promise<number> {
  recordApiKeyCacheRevision(await bumpRevision(API_KEY_CACHE_REVISION_KEY));
  return state.apiKeyCacheRevision;
}

export function recordApiKeyCacheRevision(revision: number): void {
  state.apiKeyCacheRevision = revision;
  state.apiKeyCacheRevisionLastCheckedAt = Date.now();
}
