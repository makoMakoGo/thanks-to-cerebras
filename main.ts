// main.ts - Cerebras API 代理与密钥管理系统

import { ADMIN_CORS_HEADERS, CORS_HEADERS } from "./src/constants.ts";
import { problemResponse } from "./src/http.ts";
import { cachedConfig, initKv, isDenoDeployment } from "./src/state.ts";
import { isAdminAuthorized } from "./src/auth.ts";
import {
  applyKvFlushInterval,
  bootstrapCache,
  flushDirtyToKv,
} from "./src/kv.ts";
import { resolvePort } from "./src/utils.ts";

// Handlers
import { handleAuthRoutes } from "./src/handlers/auth.ts";
import { handleProxyKeyRoutes } from "./src/handlers/proxy-keys.ts";
import { handleApiKeyRoutes } from "./src/handlers/api-keys.ts";
import { handleModelRoutes } from "./src/handlers/models.ts";
import { handleConfigRoutes } from "./src/handlers/config.ts";
import {
  handleModelsEndpoint,
  handleProxyEndpoint,
} from "./src/handlers/proxy.ts";
import { renderAdminPage } from "./src/ui/admin.ts";

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    const isProxyPath = path.startsWith("/v1/");
    const headers = isProxyPath ? CORS_HEADERS : ADMIN_CORS_HEADERS;
    return new Response(null, { status: 204, headers });
  }

  // Auth routes (no login required)
  if (path.startsWith("/api/auth/")) {
    const response = await handleAuthRoutes(req, path);
    if (response) return response;
    return problemResponse("Not Found", { status: 404, instance: path });
  }

  // Protected admin API routes
  if (path.startsWith("/api/")) {
    if (!(await isAdminAuthorized(req))) {
      return problemResponse("未登录", { status: 401, instance: path });
    }

    // Proxy keys management
    const proxyKeyResponse = await handleProxyKeyRoutes(req, path);
    if (proxyKeyResponse) return proxyKeyResponse;

    // API keys management
    const apiKeyResponse = await handleApiKeyRoutes(req, path);
    if (apiKeyResponse) return apiKeyResponse;

    // Model management
    const modelResponse = await handleModelRoutes(req, path);
    if (modelResponse) return modelResponse;

    // Config and stats
    const configResponse = await handleConfigRoutes(req, path);
    if (configResponse) return configResponse;

    return problemResponse("Not Found", { status: 404, instance: path });
  }

  // GET /v1/models - OpenAI compatible
  if (req.method === "GET" && path === "/v1/models") {
    return handleModelsEndpoint(req);
  }

  // POST /v1/chat/completions - Proxy
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return await handleProxyEndpoint(req);
  }

  // Health check
  if (req.method === "GET" && path === "/healthz") {
    return new Response("ok", { status: 200 });
  }

  // Admin panel
  if (path === "/" && req.method === "GET") {
    return await renderAdminPage();
  }

  return new Response("Not Found", { status: 404 });
}

// ================================
// 启动服务器
// ================================
console.log(`Cerebras Proxy 启动`);
console.log(`- 管理面板: /`);
console.log(`- API 代理: /v1/chat/completions`);
console.log(`- 模型接口: /v1/models`);
console.log(`- 存储: Deno KV`);

if (import.meta.main) {
  await initKv();
  await bootstrapCache();
  applyKvFlushInterval(cachedConfig);

  if (!isDenoDeployment) {
    const FLUSH_TIMEOUT_MS = 5000;

    const shutdown = async (signal: string) => {
      console.log(`\n[SHUTDOWN] ${signal} received, flushing dirty data...`);
      try {
        await Promise.race([
          flushDirtyToKv(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("flush timeout")), FLUSH_TIMEOUT_MS)
          ),
        ]);
        console.log("[SHUTDOWN] flush complete.");
      } catch (e) {
        console.error("[SHUTDOWN] flush failed:", e);
      }
      Deno.exit(0);
    };

    try {
      Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
      Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
    } catch {
      // signal listeners not supported on this platform
    }
  }

  if (isDenoDeployment) {
    Deno.serve(handler);
  } else {
    const port = resolvePort(Deno.env.get("PORT"), 8339);
    Deno.serve({ port }, handler);
  }
}
