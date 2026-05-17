import {
  EXTERNAL_MODEL_ID,
  PROXY_GLOBAL_RATE_LIMIT_MAX,
  PROXY_GLOBAL_RATE_LIMIT_WINDOW_MS,
  PROXY_KEY_RATE_LIMIT_MAX,
  PROXY_KEY_RATE_LIMIT_WINDOW_MS,
  PROXY_UNAUTHORIZED_RATE_LIMIT_MAX,
  PROXY_UNAUTHORIZED_RATE_LIMIT_WINDOW_MS,
} from "../constants.ts";
import { jsonError, jsonResponse } from "../http.ts";
import { isProxyAuthorized, recordProxyKeyUsage } from "../auth.ts";
import { forwardChatCompletion } from "../services/proxy.ts";
import { readAndValidateChatRequest } from "../proxy-validation.ts";
import { metrics } from "../metrics.ts";
import { checkKvRateLimit, type RateLimitRule } from "../rate-limit.ts";
import {
  acquireProxyStreamSlots,
  boundProxyResponseBody,
} from "../stream-limits.ts";
import type { Router } from "../router.ts";

const PROXY_PUBLIC_KEY = "public";

const PROXY_GLOBAL_LIMIT = {
  namespace: "proxy-global",
  maxRequests: PROXY_GLOBAL_RATE_LIMIT_MAX,
  windowMs: PROXY_GLOBAL_RATE_LIMIT_WINDOW_MS,
};

const PROXY_KEY_LIMIT = {
  namespace: "proxy-key",
  maxRequests: PROXY_KEY_RATE_LIMIT_MAX,
  windowMs: PROXY_KEY_RATE_LIMIT_WINDOW_MS,
};

const PROXY_UNAUTHORIZED_LIMIT = {
  namespace: "proxy-unauthorized",
  maxRequests: PROXY_UNAUTHORIZED_RATE_LIMIT_MAX,
  windowMs: PROXY_UNAUTHORIZED_RATE_LIMIT_WINDOW_MS,
};

async function enforceRateLimit(
  rule: RateLimitRule,
  key: string,
  metricLabel: string,
): Promise<Response | null> {
  const limit = await checkKvRateLimit(rule, key);
  if (limit.allowed) return null;
  metrics.inc("rate_limit_hits_total", metricLabel);
  return jsonError("请求过于频繁", 429, {
    "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
  });
}
function handleModelsEndpoint(): Response {
  const now = Math.floor(Date.now() / 1000);
  return jsonResponse({
    object: "list",
    data: [
      {
        id: EXTERNAL_MODEL_ID,
        object: "model",
        created: now,
        owned_by: "cerebras",
      },
    ],
  });
}

async function handleProxyEndpoint(req: Request): Promise<Response> {
  const authResult = await isProxyAuthorized(req);
  if (!authResult.authorized) {
    const limited = await enforceRateLimit(
      PROXY_UNAUTHORIZED_LIMIT,
      "proxy-unauthorized",
      "proxy_unauthorized",
    );
    if (limited) return limited;
    metrics.inc("proxy_requests_total", "unauthorized");
    return jsonError("Unauthorized", 401);
  }

  const globalLimited = await enforceRateLimit(
    PROXY_GLOBAL_LIMIT,
    "proxy-global",
    "proxy_global",
  );
  if (globalLimited) return globalLimited;

  const proxyLimitKey = authResult.keyId ?? PROXY_PUBLIC_KEY;
  const keyLimited = await enforceRateLimit(
    PROXY_KEY_LIMIT,
    proxyLimitKey,
    "proxy_key",
  );
  if (keyLimited) return keyLimited;

  if (authResult.keyId) {
    recordProxyKeyUsage(authResult.keyId);
  }

  const validation = await readAndValidateChatRequest(req);
  if (!validation.ok) {
    metrics.inc("proxy_requests_total", "bad_request");
    return jsonError(validation.message, validation.status);
  }

  const streamSlots = await acquireProxyStreamSlots(authResult.keyId);
  if (!streamSlots.acquired) {
    metrics.inc("rate_limit_hits_total", "proxy_stream_concurrency");
    return jsonError("并发流式请求过多", 429, {
      "Retry-After": String(streamSlots.retryAfterSec),
    });
  }
  if (!streamSlots.release) {
    throw new Error("Proxy stream slot release missing");
  }

  let result;
  try {
    result = await forwardChatCompletion(validation.body);
  } catch (error) {
    await streamSlots.release();
    throw error;
  }

  if (result.kind === "error") {
    await streamSlots.release();
    return jsonError(
      result.message,
      result.status,
      result.headers ??
        (result.retryAfterSec
          ? { "Retry-After": String(result.retryAfterSec) }
          : undefined),
    );
  }

  if (!result.body) {
    await streamSlots.release();
    return new Response(null, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }

  return new Response(
    boundProxyResponseBody(result.body, streamSlots.release),
    {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    },
  );
}

export function register(router: Router): void {
  router
    .get("/v1/models", handleModelsEndpoint)
    .post("/v1/chat/completions", handleProxyEndpoint);
}
