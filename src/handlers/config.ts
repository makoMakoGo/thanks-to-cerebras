import { MIN_KV_FLUSH_INTERVAL_MS } from "../constants.ts";
import { jsonResponse, problemResponse } from "../http.ts";
import {
  maskKey,
  normalizeKvFlushIntervalMs,
} from "../utils.ts";
import { state } from "../state.ts";
import {
  applyKvFlushInterval,
  kvGetAllKeys,
  kvGetConfig,
  kvUpdateConfig,
  resolveKvFlushIntervalMs,
} from "../kv.ts";
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
  return jsonResponse(stats);
}

async function updateConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const raw = body.kvFlushIntervalMs;

    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return problemResponse("kvFlushIntervalMs 必须为数字", {
        status: 400,
        instance: "/api/config",
      });
    }

    const normalized = normalizeKvFlushIntervalMs(raw);
    const next = await kvUpdateConfig((config) => ({
      ...config,
      kvFlushIntervalMs: normalized,
    }));

    applyKvFlushInterval(next);

    return jsonResponse({
      success: true,
      kvFlushIntervalMs: normalized,
      effectiveKvFlushIntervalMs: state.kvFlushIntervalMsEffective,
      kvFlushIntervalMinMs: MIN_KV_FLUSH_INTERVAL_MS,
    });
  } catch (error) {
    console.error("[CONFIG] update error:", error);
    return problemResponse("配置更新失败", {
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

  return jsonResponse({
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
