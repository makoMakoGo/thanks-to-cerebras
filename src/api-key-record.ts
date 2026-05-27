import type { ApiKey } from "./types.ts";
import { isEncryptedApiKey } from "./secrets.ts";

export type PersistedApiKey = Omit<ApiKey, "key">;

export function toPersistedApiKey(key: ApiKey): PersistedApiKey {
  const { key: _plaintext, ...persisted } = key;
  return persisted;
}

/**
 * Runtime-validates a value read out of KV against the current persisted
 * api-key shape. Lifted out of `src/kv/api-keys.ts` so migration helpers
 * in sibling files can reuse it without an import cycle.
 */
export function assertCurrentApiKey(value: unknown): PersistedApiKey {
  const raw = value as Record<string, unknown>;
  if (typeof raw.encryptedKey !== "string") {
    throw new Error("API key 存储格式不兼容：需要先运行密钥迁移");
  }
  if (!isEncryptedApiKey(raw.encryptedKey)) {
    throw new Error("API key 密文格式错误");
  }
  return raw as unknown as PersistedApiKey;
}
