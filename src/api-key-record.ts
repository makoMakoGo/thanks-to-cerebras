import type { ApiKey } from "./types.ts";

export type PersistedApiKey = Omit<ApiKey, "key">;

export function toPersistedApiKey(key: ApiKey): PersistedApiKey {
  const { key: _plaintext, ...persisted } = key;
  return persisted;
}
