import { MIN_KV_FLUSH_INTERVAL_MS } from "../constants.ts";
import { adminJsonResponse, adminProblemResponse } from "../http.ts";
import { maskKey, normalizeKvFlushIntervalMs } from "../utils.ts";
import { state } from "../state.ts";
import { kvGetAllKeys } from "../kv/api-keys.ts";
import {
  kvGetConfig,
  kvUpdateConfig,
  resolveKvFlushIntervalMs,
} from "../kv/config.ts";
import { applyKvFlushInterval } from "../kv/flush.ts";
import type { Router } from "../router.ts";

async function getStats(): Promise<Response> {
  const [keys, config] = await Promise.all([kvGetAllKeys(), kvGetConfig()]);
  const stats = {
    totalKeys: keys.length,
    activeKeys: keys.filter((k) => k.status === "active").length,
    totalRequests: config.totalRequests,
    keyUsage: keys.map((k) => ({
      id: k.id,
      maskedKey: maskKey(k.key),
      useCount: k.useCount,
      status: k.status,
    })),
  };
  return adminJsonResponse(stats);
}

async function updateConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const kvFlushIntervalMs = body?.kvFlushIntervalMs;
    const proxyPublicAccess = body?.proxyPublicAccess;

    if (
      kvFlushIntervalMs !== undefined &&
      (typeof kvFlushIntervalMs !== "number" ||
        !Number.isFinite(kvFlushIntervalMs))
    ) {
      return adminProblemResponse("kvFlushIntervalMs 必须为数字", {
        status: 400,
        instance: "/api/config",
      });
    }

    if (
      proxyPublicAccess !== undefined && typeof proxyPublicAccess !== "boolean"
    ) {
      return adminProblemResponse("proxyPublicAccess 必须为布尔值", {
        status: 400,
        instance: "/api/config",
      });
    }

    if (kvFlushIntervalMs === undefined && proxyPublicAccess === undefined) {
      return adminProblemResponse("缺少可更新配置", {
        status: 400,
        instance: "/api/config",
      });
    }

    const normalized = kvFlushIntervalMs === undefined
      ? undefined
      : normalizeKvFlushIntervalMs(kvFlushIntervalMs);
    const next = await kvUpdateConfig((config) => ({
      ...config,
      ...(normalized === undefined ? {} : { kvFlushIntervalMs: normalized }),
      ...(proxyPublicAccess === undefined ? {} : { proxyPublicAccess }),
    }));

    if (normalized !== undefined) applyKvFlushInterval(next);

    return adminJsonResponse({
      success: true,
      kvFlushIntervalMs: next.kvFlushIntervalMs,
      effectiveKvFlushIntervalMs: state.kvFlushIntervalMsEffective,
      kvFlushIntervalMinMs: MIN_KV_FLUSH_INTERVAL_MS,
      proxyPublicAccess: next.proxyPublicAccess,
    });
  } catch (error) {
    console.error("[CONFIG] update error:", error);
    return adminProblemResponse("配置更新失败", {
      status: 400,
      instance: "/api/config",
    });
  }
}

async function getConfig(): Promise<Response> {
  const config = await kvGetConfig();
  const configured = normalizeKvFlushIntervalMs(
    config.kvFlushIntervalMs ?? MIN_KV_FLUSH_INTERVAL_MS,
  );

  const effective = resolveKvFlushIntervalMs({
    ...config,
    kvFlushIntervalMs: configured,
  });

  return adminJsonResponse({
    ...config,
    kvFlushIntervalMs: configured,
    effectiveKvFlushIntervalMs: effective,
    kvFlushIntervalMinMs: MIN_KV_FLUSH_INTERVAL_MS,
  });
}

export function register(router: Router): void {
  router
    .get("/api/stats", getStats)
    .get("/api/config", getConfig)
    .patch("/api/config", updateConfig);
}
