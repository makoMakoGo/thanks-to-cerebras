import type { ProxyConfig } from "../types.ts";
import { API_KEY_PREFIX, PROXY_KEY_PREFIX } from "../constants.ts";
import { rebuildActiveKeyIds } from "../api-keys.ts";
import { rebuildModelPoolCache } from "../models.ts";
import { state } from "../state.ts";
import { kvGetConfig, kvUpdateConfig, resolveKvFlushIntervalMs } from "./config.ts";
import { kvGetAllKeys } from "./api-keys.ts";
import { kvGetAllProxyKeys } from "./proxy-keys.ts";

export { resolveKvFlushIntervalMs } from "./config.ts";

export function applyKvFlushInterval(config: ProxyConfig | null): void {
  state.kvFlushIntervalMsEffective = resolveKvFlushIntervalMs(config);

  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
  }
  state.kvFlushTimerId = setInterval(
    flushDirtyToKv,
    state.kvFlushIntervalMsEffective,
  );
}

export async function flushDirtyToKv(): Promise<void> {
  const now = Date.now();
  for (const [id, until] of state.keyCooldownUntil) {
    if (until < now) {
      state.keyCooldownUntil.delete(id);
    }
  }

  if (state.flushInProgress) return;
  if (
    !state.dirtyConfig && state.dirtyKeyIds.size === 0 &&
    state.dirtyProxyKeyIds.size === 0
  ) {
    return;
  }
  if (!state.cachedConfig) return;

  state.flushInProgress = true;
  const keyIds = Array.from(state.dirtyKeyIds);
  state.dirtyKeyIds.clear();
  const proxyKeyIds = Array.from(state.dirtyProxyKeyIds);
  state.dirtyProxyKeyIds.clear();
  const flushConfig = state.dirtyConfig;
  state.dirtyConfig = false;
  const pendingRequestsSnapshot = state.pendingTotalRequests;

  try {
    try {
      const tasks: Promise<unknown>[] = [];
      for (const id of keyIds) {
        const keyEntry = state.cachedKeysById.get(id);
        if (!keyEntry) continue;
        tasks.push(state.kv.set([...API_KEY_PREFIX, id], keyEntry));
      }
      for (const id of proxyKeyIds) {
        const pk = state.cachedProxyKeys.get(id);
        if (!pk) continue;
        tasks.push(state.kv.set([...PROXY_KEY_PREFIX, id], pk));
      }
      await Promise.all(tasks);
    } catch (error) {
      for (const id of keyIds) state.dirtyKeyIds.add(id);
      for (const id of proxyKeyIds) state.dirtyProxyKeyIds.add(id);
      state.dirtyConfig = state.dirtyConfig || flushConfig;
      console.error(`[KV] flush failed:`, error);
      return;
    }

    if (!flushConfig || pendingRequestsSnapshot <= 0) {
      return;
    }

    try {
      await kvUpdateConfig((config) => ({
        ...config,
        totalRequests: (config.totalRequests ?? 0) + pendingRequestsSnapshot,
      }));
      state.subtractPendingTotalRequests(pendingRequestsSnapshot);
      rebuildModelPoolCache();
    } catch (error) {
      state.dirtyConfig = true;
      console.error(`[KV] config flush failed:`, error);
    }
  } finally {
    state.flushInProgress = false;
  }
}

export async function bootstrapCache(): Promise<void> {
  state.cachedConfig = await kvGetConfig();
  const keys = await kvGetAllKeys();
  state.cachedKeysById = new Map(keys.map((k) => [k.id, k]));
  rebuildActiveKeyIds();
  rebuildModelPoolCache();

  const proxyKeys = await kvGetAllProxyKeys();
  state.cachedProxyKeys = new Map(proxyKeys.map((k) => [k.id, k]));
}
