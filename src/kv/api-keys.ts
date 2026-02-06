import type { ApiKey } from "../types.ts";
import { API_KEY_PREFIX } from "../constants.ts";
import { generateId } from "../utils.ts";
import { rebuildActiveKeyIds } from "../api-keys.ts";
import { state } from "../state.ts";

export async function kvGetAllKeys(): Promise<ApiKey[]> {
  const keys: ApiKey[] = [];
  const iter = state.kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    keys.push(entry.value as ApiKey);
  }
  return keys;
}

export async function kvMergeAllApiKeysIntoCache(): Promise<void> {
  const keys = await kvGetAllKeys();
  for (const key of keys) {
    const local = state.cachedKeysById.get(key.id);
    if (!local) {
      state.cachedKeysById.set(key.id, key);
      continue;
    }

    const isDirty = state.dirtyKeyIds.has(key.id);
    if (!isDirty) {
      state.cachedKeysById.set(key.id, key);
      continue;
    }

    local.key = key.key;
    local.createdAt = key.createdAt;
    if (!(local.status === "invalid" && key.status !== "invalid")) {
      local.status = key.status;
    }
    local.useCount = Math.max(local.useCount, key.useCount);
    local.lastUsed = Math.max(local.lastUsed ?? 0, key.lastUsed ?? 0) ||
      undefined;
  }
  rebuildActiveKeyIds();
}

export async function kvGetApiKeyById(id: string): Promise<ApiKey | null> {
  const cached = state.cachedKeysById.get(id);
  if (cached) return cached;

  const entry = await state.kv.get<ApiKey>([...API_KEY_PREFIX, id]);
  if (!entry.value) return null;

  state.cachedKeysById.set(id, entry.value);
  rebuildActiveKeyIds();
  return entry.value;
}

let lastApiKeyCreatedAtMs = 0;
export async function kvAddKey(
  key: string,
): Promise<{ success: boolean; id?: string; error?: string }> {
  const allKeys = Array.from(state.cachedKeysById.values());
  const existingKey = allKeys.find((k) => k.key === key);
  if (existingKey) {
    return { success: false, error: "密钥已存在" };
  }

  const id = generateId();
  const now = Date.now();
  const createdAt = now <= lastApiKeyCreatedAtMs
    ? lastApiKeyCreatedAtMs + 1
    : now;
  lastApiKeyCreatedAtMs = createdAt;
  const newKey: ApiKey = {
    id,
    key,
    useCount: 0,
    status: "active",
    createdAt,
  };

  await state.kv.set([...API_KEY_PREFIX, id], newKey);
  state.cachedKeysById.set(id, newKey);
  rebuildActiveKeyIds();

  return { success: true, id };
}

export async function kvDeleteKey(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const key = [...API_KEY_PREFIX, id];
  const result = await state.kv.get(key);
  if (!result.value) {
    return { success: false, error: "密钥不存在" };
  }

  await state.kv.delete(key);
  state.cachedKeysById.delete(id);
  state.keyCooldownUntil.delete(id);
  state.dirtyKeyIds.delete(id);
  rebuildActiveKeyIds();
  return { success: true };
}

export async function kvUpdateKey(
  id: string,
  updates: Partial<ApiKey>,
): Promise<void> {
  const key = [...API_KEY_PREFIX, id];
  const existing = state.cachedKeysById.get(id) ??
    (await state.kv.get<ApiKey>(key)).value;
  if (!existing) return;
  const updated = { ...existing, ...updates };
  await state.kv.set(key, updated);
  state.cachedKeysById.set(id, updated);
  rebuildActiveKeyIds();
}
