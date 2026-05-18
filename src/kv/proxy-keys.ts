import type { ProxyAuthKey } from "../types.ts";
import { MAX_PROXY_KEYS, PROXY_KEY_PREFIX } from "../constants.ts";
import { generateProxyKey } from "../keys.ts";
import { generateId } from "../utils.ts";
import { hashProxyKey, isHashedProxyKey } from "../secrets.ts";
import { state } from "../state.ts";
import { bumpAuthCacheRevision } from "./revisions.ts";

type LegacyProxyAuthKey = Omit<ProxyAuthKey, "keyHash"> & { key: string };

function assertCurrentProxyKey(value: unknown): ProxyAuthKey {
  const raw = value as Record<string, unknown>;
  if (typeof raw.keyHash !== "string") {
    throw new Error("proxy key 存储格式不兼容：需要先运行密钥迁移");
  }
  if (!isHashedProxyKey(raw.keyHash)) {
    throw new Error("proxy key 哈希格式错误");
  }
  return raw as unknown as ProxyAuthKey;
}

export async function kvGetAllProxyKeys(): Promise<ProxyAuthKey[]> {
  const keys: ProxyAuthKey[] = [];
  const iter = state.kv.list({ prefix: PROXY_KEY_PREFIX });
  for await (const entry of iter) {
    keys.push(assertCurrentProxyKey(entry.value));
  }
  return keys;
}

async function ensureProxyKeyCache(): Promise<Map<string, ProxyAuthKey>> {
  const cached = state.cachedProxyKeys;
  if (cached !== null) return cached;

  const keys = await kvGetAllProxyKeys();
  const next = new Map(keys.map((key) => [key.id, key]));
  state.cachedProxyKeys = next;
  state.proxyKeyCacheLastLoadedAt = Date.now();
  return next;
}

export async function kvMigrateProxyKeysToHashed(): Promise<number> {
  let migrated = 0;
  const iter = state.kv.list({ prefix: PROXY_KEY_PREFIX });
  for await (const entry of iter) {
    const value = entry.value as
      & Partial<LegacyProxyAuthKey>
      & Partial<ProxyAuthKey>;
    if (typeof value.keyHash === "string") continue;
    if (typeof value.key !== "string") {
      throw new Error("proxy key 迁移失败：旧记录缺少明文 key");
    }

    const keyHash = await hashProxyKey(value.key);
    const migratedValue = {
      id: value.id,
      keyHash,
      name: value.name,
      useCount: value.useCount,
      lastUsed: value.lastUsed,
      createdAt: value.createdAt,
    };
    if (
      typeof migratedValue.id !== "string" ||
      typeof migratedValue.name !== "string" ||
      typeof migratedValue.useCount !== "number" ||
      typeof migratedValue.createdAt !== "number"
    ) {
      throw new Error("proxy key 迁移失败：旧记录结构不完整");
    }
    const result = await state.kv.atomic()
      .check(entry)
      .set(entry.key, migratedValue)
      .commit();
    if (!result.ok) throw new Error("proxy key 迁移失败：KV 写入冲突");
    state.cachedProxyKeys?.delete(migratedValue.id);
    migrated++;
  }
  if (migrated > 0) {
    state.cachedProxyKeys = new Map(
      (await kvGetAllProxyKeys()).map((key) => [key.id, key]),
    );
    state.proxyKeyCacheLastLoadedAt = Date.now();
  }
  return migrated;
}

export async function kvGetProxyKeyById(
  id: string,
): Promise<ProxyAuthKey | null> {
  const cachedKeys = await ensureProxyKeyCache();
  const cached = cachedKeys.get(id);
  if (cached) return cached;

  const entry = await state.kv.get<ProxyAuthKey>([...PROXY_KEY_PREFIX, id]);
  if (!entry.value) return null;

  const current = assertCurrentProxyKey(entry.value);
  cachedKeys.set(id, current);
  return current;
}

export async function findProxyKeyIdBySecret(
  secret: string,
): Promise<string | null> {
  const keyHash = await hashProxyKey(secret);
  const cachedKeys = await ensureProxyKeyCache();
  for (const [id, pk] of cachedKeys) {
    if (pk.keyHash === keyHash) return id;
  }
  return null;
}

export async function kvAddProxyKey(
  name: string,
): Promise<{ success: boolean; id?: string; key?: string; error?: string }> {
  const cachedKeys = await ensureProxyKeyCache();
  if (cachedKeys.size >= MAX_PROXY_KEYS) {
    return {
      success: false,
      error: `最多只能创建 ${MAX_PROXY_KEYS} 个代理密钥`,
    };
  }

  const id = generateId();
  const key = generateProxyKey();
  const newKey: ProxyAuthKey = {
    id,
    keyHash: await hashProxyKey(key),
    name: name || `密钥 ${cachedKeys.size + 1}`,
    useCount: 0,
    createdAt: Date.now(),
  };

  await state.kv.set([...PROXY_KEY_PREFIX, id], newKey);
  cachedKeys.set(id, newKey);
  await bumpAuthCacheRevision();

  return { success: true, id, key };
}

export async function kvDeleteProxyKey(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const key = [...PROXY_KEY_PREFIX, id];
  const result = await state.kv.get(key);
  if (!result.value) {
    return { success: false, error: "密钥不存在" };
  }

  await state.kv.delete(key);
  state.cachedProxyKeys?.delete(id);
  state.dirtyProxyKeyIds.delete(id);
  await bumpAuthCacheRevision();
  return { success: true };
}
