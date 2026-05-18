import { ADMIN_CORS_HEADERS, CORS_HEADERS } from "./constants.ts";
import {
  adminJsonResponse,
  adminProblemResponse,
  problemResponse,
} from "./http.ts";
import { isAdminAuthorized } from "./auth.ts";
import { Router } from "./router.ts";
import { renderAdminPage } from "./ui/admin.ts";
import { metrics } from "./metrics.ts";

import { register as registerAuth } from "./handlers/auth.ts";
import { register as registerProxyKeys } from "./handlers/proxy-keys.ts";
import { register as registerApiKeys } from "./handlers/api-keys.ts";
import { register as registerModels } from "./handlers/models.ts";
import { register as registerConfig } from "./handlers/config.ts";
import { register as registerProxy } from "./handlers/proxy.ts";

export function createRouter(): Router {
  const router = new Router();
  registerAuth(router);
  registerProxyKeys(router);
  registerApiKeys(router);
  registerModels(router);
  registerConfig(router);
  registerProxy(router);
  router
    .get("/healthz", () => new Response("ok", { status: 200 }))
    .get("/api/metrics", () => adminJsonResponse(metrics.snapshot()))
    .get("/", () => renderAdminPage());
  return router;
}

export function createHandler(
  router: Router,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
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
        return adminProblemResponse("未登录", { status: 401, instance: path });
      }
    }

    const matched = router.match(req.method, req.url);
    if (matched) return matched.handler(req, matched.params);

    return problemResponse("Not Found", { status: 404, instance: path });
  };
}
