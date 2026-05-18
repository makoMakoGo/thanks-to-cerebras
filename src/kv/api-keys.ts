import type { ApiKey } from "../types.ts";
import { type PersistedApiKey, toPersistedApiKey } from "../api-key-record.ts";
import { API_KEY_PREFIX } from "../constants.ts";
import { generateId } from "../utils.ts";
import { rebuildActiveKeyIds } from "../api-keys.ts";
import { decryptApiKey, encryptApiKey, isEncryptedApiKey } from "../secrets.ts";
import { state } from "../state.ts";
import { bumpApiKeyCacheRevision } from "./revisions.ts";

type LegacyApiKey = Omit<ApiKey, "encryptedKey"> & { key: string };

function assertCurrentApiKey(value: unknown): PersistedApiKey {
  const raw = value as Record<string, unknown>;
  if (typeof raw.encryptedKey !== "string") {
    throw new Error("API key 存储格式不兼容：需要先运行密钥迁移");
  }
  if (!isEncryptedApiKey(raw.encryptedKey)) {
    throw new Error("API key 密文格式错误");
  }
  return raw as unknown as PersistedApiKey;
}

async function hydrateApiKey(value: unknown): Promise<ApiKey> {
  const persisted = assertCurrentApiKey(value);
  return {
    ...persisted,
    key: await decryptApiKey(persisted.encryptedKey),
  };
}

export async function kvGetAllKeys(): Promise<ApiKey[]> {
  const keys: ApiKey[] = [];
  const iter = state.kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    keys.push(await hydrateApiKey(entry.value));
  }
  return keys;
}

export async function kvMergeAllApiKeysIntoCache(): Promise<void> {
  const keys = await kvGetAllKeys();
  const loadedIds = new Set(keys.map((key) => key.id));
  for (const id of state.cachedKeysById.keys()) {
    if (!loadedIds.has(id)) {
      state.cachedKeysById.delete(id);
      state.keyCooldownUntil.delete(id);
      state.dirtyKeyIds.delete(id);
    }
  }
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
    local.encryptedKey = key.encryptedKey;
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

  const entry = await state.kv.get<PersistedApiKey>([...API_KEY_PREFIX, id]);
  if (!entry.value) return null;

  const hydrated = await hydrateApiKey(entry.value);
  state.cachedKeysById.set(id, hydrated);
  rebuildActiveKeyIds();
  return hydrated;
}

export async function kvMigrateApiKeysToEncrypted(): Promise<number> {
  let migrated = 0;
  const iter = state.kv.list({ prefix: API_KEY_PREFIX });
  for await (const entry of iter) {
    const value = entry.value as Partial<LegacyApiKey> & Partial<ApiKey>;
    if (typeof value.encryptedKey === "string") continue;
    if (typeof value.key !== "string") {
      throw new Error("API key 迁移失败：旧记录缺少明文 key");
    }

    const encryptedKey = await encryptApiKey(value.key);
    const migratedValue = {
      id: value.id,
      useCount: value.useCount,
      lastUsed: value.lastUsed,
      status: value.status,
      createdAt: value.createdAt,
      encryptedKey,
    };
    if (
      typeof migratedValue.id !== "string" ||
      typeof migratedValue.useCount !== "number" ||
      typeof migratedValue.status !== "string" ||
      typeof migratedValue.createdAt !== "number"
    ) {
      throw new Error("API key 迁移失败：旧记录结构不完整");
    }
    const result = await state.kv.atomic()
      .check(entry)
      .set(entry.key, migratedValue)
      .commit();
    if (!result.ok) throw new Error("API key 迁移失败：KV 写入冲突");
    state.cachedKeysById.delete(migratedValue.id);
    migrated++;
  }
  if (migrated > 0) {
    state.cachedKeysById = new Map(
      (await kvGetAllKeys()).map((key) => [key.id, key]),
    );
    rebuildActiveKeyIds();
  }
  return migrated;
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
  const encryptedKey = await encryptApiKey(key);
  const newKey: ApiKey = {
    id,
    encryptedKey,
    key,
    useCount: 0,
    status: "active",
    createdAt,
  };

  await state.kv.set([...API_KEY_PREFIX, id], toPersistedApiKey(newKey));
  state.cachedKeysById.set(id, newKey);
  rebuildActiveKeyIds();
  await bumpApiKeyCacheRevision();

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
  await bumpApiKeyCacheRevision();
  return { success: true };
}

export async function kvUpdateKey(
  id: string,
  updates: Partial<ApiKey>,
): Promise<void> {
  const key = [...API_KEY_PREFIX, id];
  const existing = state.cachedKeysById.get(id) ??
    (await kvGetApiKeyById(id));
  if (!existing) return;
  const updated = { ...existing, ...updates };
  await state.kv.set(key, toPersistedApiKey(updated));
  state.cachedKeysById.set(id, updated);
  rebuildActiveKeyIds();
  await bumpApiKeyCacheRevision();
}
