import type { ProxyAuthKey } from "../types.ts";
import { MAX_PROXY_KEYS, PROXY_KEY_PREFIX } from "../constants.ts";
import { generateProxyKey } from "../keys.ts";
import { generateId } from "../utils.ts";
import { state } from "../state.ts";

export async function kvGetAllProxyKeys(): Promise<ProxyAuthKey[]> {
  const keys: ProxyAuthKey[] = [];
  const iter = state.kv.list({ prefix: PROXY_KEY_PREFIX });
  for await (const entry of iter) {
    keys.push(entry.value as ProxyAuthKey);
  }
  return keys;
}

export async function kvGetProxyKeyById(
  id: string,
): Promise<ProxyAuthKey | null> {
  const cached = state.cachedProxyKeys.get(id);
  if (cached) return cached;

  const entry = await state.kv.get<ProxyAuthKey>([...PROXY_KEY_PREFIX, id]);
  if (!entry.value) return null;

  state.cachedProxyKeys.set(id, entry.value);
  return entry.value;
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
    key,
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
