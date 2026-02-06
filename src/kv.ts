import type {
  ApiKey,
  ModelCatalog,
  ProxyAuthKey,
  ProxyConfig,
} from "./types.ts";
import {
  API_KEY_PREFIX,
  CEREBRAS_PUBLIC_MODELS_URL,
  CONFIG_KEY,
  DEFAULT_KV_FLUSH_INTERVAL_MS,
  DEFAULT_MODEL_POOL,
  KV_ATOMIC_MAX_RETRIES,
  MAX_PROXY_KEYS,
  MODEL_CATALOG_FETCH_TIMEOUT_MS,
  MODEL_CATALOG_KEY,
  MODEL_CATALOG_TTL_MS,
  PROXY_KEY_PREFIX,
} from "./constants.ts";
import { generateProxyKey } from "./keys.ts";
import {
  fetchWithTimeout,
  generateId,
  normalizeKvFlushIntervalMs,
} from "./utils.ts";
import { rebuildActiveKeyIds } from "./api-keys.ts";
import { normalizeModelPool, rebuildModelPoolCache } from "./models.ts";
import { state } from "./state.ts";

// KV flush interval management
export function resolveKvFlushIntervalMs(config: ProxyConfig | null): number {
  const ms = config?.kvFlushIntervalMs ?? DEFAULT_KV_FLUSH_INTERVAL_MS;
  return normalizeKvFlushIntervalMs(ms);
}

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

// Flush dirty data to KV
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

// Bootstrap cache from KV
export async function bootstrapCache(): Promise<void> {
  state.cachedConfig = await kvGetConfig();
  const keys = await kvGetAllKeys();
  state.cachedKeysById = new Map(keys.map((k) => [k.id, k]));
  rebuildActiveKeyIds();
  rebuildModelPoolCache();

  const proxyKeys = await kvGetAllProxyKeys();
  state.cachedProxyKeys = new Map(proxyKeys.map((k) => [k.id, k]));
}

function throwIncompatibleConfig(detail: string): never {
  throw new Error(
    `[KV] 配置结构不兼容：${detail}。请清空 KV 后重启（Deno CLI/Docker 删除 kv.sqlite3，Deno Deploy 清空项目 KV 数据）。`,
  );
}

export function validateProxyConfig(rawValue: unknown): ProxyConfig {
  if (!rawValue || typeof rawValue !== "object") {
    throwIncompatibleConfig("config 不是对象");
  }

  const raw = rawValue as Record<string, unknown>;

  if ("schemaVersion" in raw || "disabledModels" in raw) {
    throwIncompatibleConfig("检测到旧字段 schemaVersion/disabledModels");
  }

  if (!Array.isArray(raw.modelPool)) {
    throwIncompatibleConfig("缺少 modelPool 或类型错误");
  }

  if (
    typeof raw.currentModelIndex !== "number" ||
    !Number.isFinite(raw.currentModelIndex) ||
    !Number.isInteger(raw.currentModelIndex) ||
    raw.currentModelIndex < 0
  ) {
    throwIncompatibleConfig("缺少 currentModelIndex 或类型错误");
  }

  if (
    typeof raw.totalRequests !== "number" ||
    !Number.isFinite(raw.totalRequests) ||
    !Number.isInteger(raw.totalRequests) ||
    raw.totalRequests < 0
  ) {
    throwIncompatibleConfig("缺少 totalRequests 或类型错误");
  }

  if (
    typeof raw.kvFlushIntervalMs !== "number" ||
    !Number.isFinite(raw.kvFlushIntervalMs) ||
    !Number.isInteger(raw.kvFlushIntervalMs) ||
    raw.kvFlushIntervalMs < 0
  ) {
    throwIncompatibleConfig("缺少 kvFlushIntervalMs 或类型错误");
  }

  return {
    modelPool: normalizeModelPool(raw.modelPool),
    currentModelIndex: raw.currentModelIndex,
    totalRequests: raw.totalRequests,
    kvFlushIntervalMs: raw.kvFlushIntervalMs,
  };
}

// Config operations
export async function kvEnsureConfigEntry(): Promise<
  Deno.KvEntry<ProxyConfig>
> {
  let entry = await state.kv.get<ProxyConfig>(CONFIG_KEY);

  if (!entry.value) {
    const defaultConfig: ProxyConfig = {
      modelPool: [...DEFAULT_MODEL_POOL],
      currentModelIndex: 0,
      totalRequests: 0,
      kvFlushIntervalMs: DEFAULT_KV_FLUSH_INTERVAL_MS,
    };
    await state.kv.set(CONFIG_KEY, defaultConfig);
    entry = await state.kv.get<ProxyConfig>(CONFIG_KEY);
  }

  if (!entry.value) {
    throw new Error("KV 配置初始化失败");
  }
  const config = validateProxyConfig(entry.value);
  return { ...entry, value: config } as Deno.KvEntry<ProxyConfig>;
}

export async function kvGetConfig(): Promise<ProxyConfig> {
  const entry = await kvEnsureConfigEntry();
  return entry.value;
}

export async function kvUpdateConfig(
  updater: (config: ProxyConfig) => ProxyConfig | Promise<ProxyConfig>,
): Promise<ProxyConfig> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const entry = await kvEnsureConfigEntry();
    const nextConfig = await updater(entry.value);
    if (nextConfig === entry.value) {
      state.cachedConfig = entry.value;
      return entry.value;
    }
    const validatedConfig = validateProxyConfig(nextConfig);
    const result = await state.kv
      .atomic()
      .check(entry)
      .set(CONFIG_KEY, validatedConfig)
      .commit();
    if (result.ok) {
      state.cachedConfig = validatedConfig;
      return validatedConfig;
    }
    const baseMs = Math.min(10 * 2 ** attempt, 500);
    const jitter = Math.random() * baseMs;
    await new Promise((r) => setTimeout(r, baseMs + jitter));
  }
  throw new Error("配置更新失败：达到最大重试次数");
}

// Model catalog operations
export function isModelCatalogFresh(
  catalog: ModelCatalog,
  now: number,
): boolean {
  return (
    now >= catalog.fetchedAt && now - catalog.fetchedAt < MODEL_CATALOG_TTL_MS
  );
}

export async function kvGetModelCatalog(): Promise<ModelCatalog | null> {
  const entry = await state.kv.get<ModelCatalog>(MODEL_CATALOG_KEY);
  return entry.value ?? null;
}

export async function refreshModelCatalog(): Promise<ModelCatalog> {
  if (state.modelCatalogFetchInFlight) {
    return await state.modelCatalogFetchInFlight;
  }

  const promise = (async () => {
    const response = await fetchWithTimeout(
      CEREBRAS_PUBLIC_MODELS_URL,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      MODEL_CATALOG_FETCH_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const suffix = text && text.length <= 200 ? `: ${text}` : "";
      throw new Error(`模型目录拉取失败：HTTP ${response.status}${suffix}`);
    }

    const data = await response.json().catch(() => ({}));
    const rawModels = (data as { data?: unknown })?.data;

    const ids = Array.isArray(rawModels)
      ? rawModels
        .map((m) => {
          if (!m || typeof m !== "object") return "";
          if (!("id" in m)) return "";
          const id = (m as { id?: unknown }).id;
          return typeof id === "string" ? id.trim() : "";
        })
        .filter((id) => id.length > 0)
      : [];

    const seen = new Set<string>();
    const models: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }

    const catalog: ModelCatalog = {
      source: "cerebras-public",
      fetchedAt: Date.now(),
      models,
    };

    state.cachedModelCatalog = catalog;

    try {
      await state.kv.set(MODEL_CATALOG_KEY, catalog);
    } catch (error) {
      console.error(`[KV] model catalog save failed:`, error);
    }

    return catalog;
  })().finally(() => {
    state.modelCatalogFetchInFlight = null;
  });

  state.modelCatalogFetchInFlight = promise;
  return await promise;
}

// Remove model from pool
export async function removeModelFromPool(
  model: string,
  reason: string,
): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;

  const existed = state.cachedModelPool.includes(trimmed);

  await kvUpdateConfig((config) => {
    const pool = normalizeModelPool(config.modelPool);
    const nextPool = pool.filter((m) => m !== trimmed);

    if (nextPool.length === pool.length) {
      return config;
    }

    return {
      ...config,
      modelPool: nextPool,
      currentModelIndex: 0,
    };
  });

  rebuildModelPoolCache();

  if (existed) {
    console.warn(`[MODEL] removed (${reason}): ${trimmed}`);
  }
}

// API key operations
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

// Proxy key operations
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
