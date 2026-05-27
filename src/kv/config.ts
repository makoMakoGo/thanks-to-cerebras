import type { ProxyConfig } from "../types.ts";
import {
  AUTH_CACHE_REVISION_KEY,
  CONFIG_KEY,
  DEFAULT_KV_FLUSH_INTERVAL_MS,
  DEFAULT_MODEL_POOL,
  KV_ATOMIC_MAX_RETRIES,
} from "../constants.ts";
import { normalizeKvFlushIntervalMs } from "../utils.ts";
import { normalizeModelPool } from "../models.ts";
import { state } from "../state.ts";
import { getNextRevisionValue, recordAuthCacheRevision } from "./revisions.ts";

export function resolveKvFlushIntervalMs(config: ProxyConfig | null): number {
  const ms = config?.kvFlushIntervalMs ?? DEFAULT_KV_FLUSH_INTERVAL_MS;
  return normalizeKvFlushIntervalMs(ms);
}

function throwIncompatibleConfig(detail: string): never {
  throw new Error(
    `[KV] 配置结构不兼容：${detail}。请清空 KV 后重启（Deno CLI/Docker 删除 kv.sqlite3，Deno Deploy 清空项目 KV 数据）。`,
  );
}

function modelPoolUnchanged(
  rawPool: readonly unknown[],
  normalized: readonly string[],
): boolean {
  if (rawPool.length !== normalized.length) return false;
  for (let i = 0; i < rawPool.length; i++) {
    if (rawPool[i] !== normalized[i]) return false;
  }
  return true;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0;
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

  if (!isNonNegativeInteger(raw.currentModelIndex)) {
    throwIncompatibleConfig("缺少 currentModelIndex 或类型错误");
  }

  if (!isNonNegativeInteger(raw.totalRequests)) {
    throwIncompatibleConfig("缺少 totalRequests 或类型错误");
  }

  if (!isNonNegativeInteger(raw.kvFlushIntervalMs)) {
    throwIncompatibleConfig("缺少 kvFlushIntervalMs 或类型错误");
  }

  if (
    raw.proxyPublicAccess !== undefined &&
    typeof raw.proxyPublicAccess !== "boolean"
  ) {
    throwIncompatibleConfig("proxyPublicAccess 类型错误");
  }

  const normalizedPool = normalizeModelPool(raw.modelPool);
  // If every field is already canonical, return the original reference so
  // callers can detect "no migration needed" via reference equality and skip
  // the unnecessary KV write on the hot path of every kvGetConfig() call.
  if (
    modelPoolUnchanged(raw.modelPool, normalizedPool) &&
    typeof raw.proxyPublicAccess === "boolean"
  ) {
    return rawValue as ProxyConfig;
  }

  return {
    modelPool: normalizedPool,
    currentModelIndex: raw.currentModelIndex,
    totalRequests: raw.totalRequests,
    kvFlushIntervalMs: raw.kvFlushIntervalMs,
    proxyPublicAccess: raw.proxyPublicAccess ?? false,
  };
}

export async function kvEnsureConfigEntry(): Promise<
  Deno.KvEntry<ProxyConfig>
> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    let entry = await state.kv.get<ProxyConfig>(CONFIG_KEY);

    if (!entry.value) {
      const defaultConfig: ProxyConfig = {
        modelPool: [...DEFAULT_MODEL_POOL],
        currentModelIndex: 0,
        totalRequests: 0,
        kvFlushIntervalMs: DEFAULT_KV_FLUSH_INTERVAL_MS,
        proxyPublicAccess: false,
      };
      await state.kv.set(CONFIG_KEY, defaultConfig);
      entry = await state.kv.get<ProxyConfig>(CONFIG_KEY);
    }

    if (!entry.value) {
      throw new Error("KV 配置初始化失败");
    }
    const config = validateProxyConfig(entry.value);
    if (config === entry.value) {
      return { ...entry, value: config } as Deno.KvEntry<ProxyConfig>;
    }
    // Migration write needed. CAS may lose the race against a concurrent
    // request running the same migration; on conflict we re-read and retry
    // instead of failing the caller. On success we still loop once more so
    // we return an entry with the fresh versionstamp produced by the write
    // (callers like kvUpdateConfig pass it back into .check()).
    const result = await state.kv.atomic()
      .check(entry)
      .set(CONFIG_KEY, config)
      .commit();
    if (!result.ok) {
      const baseMs = Math.min(10 * 2 ** attempt, 500);
      const jitter = Math.random() * baseMs;
      await new Promise((r) => setTimeout(r, baseMs + jitter));
    }
  }
  throw new Error("KV 配置迁移失败：达到最大重试次数");
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
    let atomic = state.kv
      .atomic()
      .check(entry)
      .set(CONFIG_KEY, validatedConfig);
    let nextRevision: number | null = null;
    const shouldBumpAuthRevision =
      validatedConfig.proxyPublicAccess !== entry.value.proxyPublicAccess;
    if (shouldBumpAuthRevision) {
      const revisionEntry = await state.kv.get<number>(AUTH_CACHE_REVISION_KEY);
      nextRevision = getNextRevisionValue(revisionEntry);
      atomic = atomic
        .check(revisionEntry)
        .set(AUTH_CACHE_REVISION_KEY, nextRevision);
    }
    const result = await atomic.commit();
    if (result.ok) {
      state.cachedConfig = validatedConfig;
      if (nextRevision !== null) recordAuthCacheRevision(nextRevision);
      return validatedConfig;
    }
    const baseMs = Math.min(10 * 2 ** attempt, 500);
    const jitter = Math.random() * baseMs;
    await new Promise((r) => setTimeout(r, baseMs + jitter));
  }
  throw new Error("配置更新失败：达到最大重试次数");
}
