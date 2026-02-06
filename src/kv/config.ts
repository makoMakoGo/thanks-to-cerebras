import type { ProxyConfig } from "../types.ts";
import {
  CONFIG_KEY,
  DEFAULT_KV_FLUSH_INTERVAL_MS,
  DEFAULT_MODEL_POOL,
  KV_ATOMIC_MAX_RETRIES,
} from "../constants.ts";
import { normalizeKvFlushIntervalMs } from "../utils.ts";
import { normalizeModelPool } from "../models.ts";
import { state } from "../state.ts";

export function resolveKvFlushIntervalMs(config: ProxyConfig | null): number {
  const ms = config?.kvFlushIntervalMs ?? DEFAULT_KV_FLUSH_INTERVAL_MS;
  return normalizeKvFlushIntervalMs(ms);
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
