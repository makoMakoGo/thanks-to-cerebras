import type { ProxyAuthKey } from "../types.ts";
import { MAX_PROXY_KEYS, PROXY_KEY_PREFIX } from "../constants.ts";
import { generateProxyKey } from "../keys.ts";
import { generateId } from "../utils.ts";
import { hashProxyKey, isHashedProxyKey } from "../secrets.ts";
import { state } from "../state.ts";

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
    state.cachedProxyKeys.delete(migratedValue.id);
    migrated++;
  }
  if (migrated > 0) {
    state.cachedProxyKeys = new Map(
      (await kvGetAllProxyKeys()).map((key) => [key.id, key]),
    );
  }
  return migrated;
}

export async function findProxyKeyIdBySecret(
  secret: string,
): Promise<string | null> {
  const keyHash = await hashProxyKey(secret);
  for (const [id, pk] of state.cachedProxyKeys) {
    if (pk.keyHash === keyHash) return id;
  }
  return null;
}

export async function kvAddProxyKey(
  name: string,
): Promise<{ success: boolean; id?: string; key?: string; error?: string }> {
  if (state.cachedProxyKeys.size >= MAX_PROXY_KEYS) {
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
    name: name || `密钥 ${state.cachedProxyKeys.size + 1}`,
    useCount: 0,
    createdAt: Date.now(),
  };

  await state.kv.set([...PROXY_KEY_PREFIX, id], newKey);
  state.cachedProxyKeys.set(id, newKey);

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
  state.cachedProxyKeys.delete(id);
  state.dirtyProxyKeyIds.delete(id);
  return { success: true };
}
