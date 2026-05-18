import {
  API_KEY_CACHE_REVISION_KEY,
  AUTH_CACHE_REVISION_KEY,
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

export function getAuthCacheRevision(): Promise<number> {
  return getRevision(AUTH_CACHE_REVISION_KEY);
}

export function getApiKeyCacheRevision(): Promise<number> {
  return getRevision(API_KEY_CACHE_REVISION_KEY);
}

export function recordAuthCacheRevision(revision: number): void {
  state.authCacheRevision = revision;
  state.authCacheRevisionLastCheckedAt = Date.now();
}

export function recordApiKeyCacheRevision(revision: number): void {
  state.apiKeyCacheRevision = revision;
  state.apiKeyCacheRevisionLastCheckedAt = Date.now();
}
