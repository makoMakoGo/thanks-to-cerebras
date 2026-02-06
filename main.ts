import { ADMIN_CORS_HEADERS, CORS_HEADERS } from "./src/constants.ts";
import { problemResponse } from "./src/http.ts";
import { isDenoDeployment, state } from "./src/state.ts";
import { isAdminAuthorized } from "./src/auth.ts";
import {
  applyKvFlushInterval,
  bootstrapCache,
  flushDirtyToKv,
} from "./src/kv.ts";
import { resolvePort } from "./src/utils.ts";
import { Router } from "./src/router.ts";
import { renderAdminPage } from "./src/ui/admin.ts";

import { register as registerAuth } from "./src/handlers/auth.ts";
import { register as registerProxyKeys } from "./src/handlers/proxy-keys.ts";
import { register as registerApiKeys } from "./src/handlers/api-keys.ts";
import { register as registerModels } from "./src/handlers/models.ts";
import { register as registerConfig } from "./src/handlers/config.ts";
import { register as registerProxy } from "./src/handlers/proxy.ts";

const router = new Router();
registerAuth(router);
registerProxyKeys(router);
registerApiKeys(router);
registerModels(router);
registerConfig(router);
registerProxy(router);
router
  .get("/healthz", () => new Response("ok", { status: 200 }))
  .get("/", () => renderAdminPage());

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    const headers = path.startsWith("/v1/")
      ? CORS_HEADERS
      : ADMIN_CORS_HEADERS;
    return new Response(null, { status: 204, headers });
  }

  if (path.startsWith("/api/") && !path.startsWith("/api/auth/")) {
    if (!(await isAdminAuthorized(req))) {
      return problemResponse("未登录", { status: 401, instance: path });
    }
  }

  const matched = router.match(req.method, req.url);
  if (matched) return matched.handler(req, matched.params);

  return problemResponse("Not Found", { status: 404, instance: path });
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
  await state.initKv();
  await bootstrapCache();
  applyKvFlushInterval(state.cachedConfig);

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
