import { ADMIN_CORS_HEADERS, CORS_HEADERS } from "./constants.ts";
import {
  adminJsonResponse,
  adminProblemResponse,
  problemResponse,
} from "./http.ts";
import { isAdminAuthorized } from "./auth.ts";
import { logger } from "./logger.ts";
import { Router } from "./router.ts";
import { renderAdminPage } from "./ui/admin.ts";
import { metrics } from "./metrics.ts";

import { register as registerAuth } from "./handlers/auth.ts";
import { register as registerProxyKeys } from "./handlers/proxy-keys.ts";
import { register as registerApiKeys } from "./handlers/api-keys.ts";
import { register as registerModels } from "./handlers/models.ts";
import { register as registerConfig } from "./handlers/config.ts";
import { register as registerProxy } from "./handlers/proxy.ts";
import { register as registerHealth } from "./handlers/health.ts";

const MAX_REQUEST_ID_LENGTH = 128;

export function createRouter(): Router {
  const router = new Router();
  registerAuth(router);
  registerProxyKeys(router);
  registerApiKeys(router);
  registerModels(router);
  registerConfig(router);
  registerProxy(router);
  registerHealth(router);
  router
    .get("/api/metrics", () => adminJsonResponse(metrics.snapshot()))
    .get("/", () => renderAdminPage());
  return router;
}

export function createHandler(
  router: Router,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const startedAt = performance.now();
    const requestId = resolveRequestId(req);
    const url = new URL(req.url);
    const path = url.pathname;
    const context = { requestId };
    let response: Response;

    if (req.method === "OPTIONS") {
      const headers = path.startsWith("/v1/")
        ? CORS_HEADERS
        : ADMIN_CORS_HEADERS;
      response = new Response(null, { status: 204, headers });
      return finalizeResponse(req, response, requestId, startedAt);
    }

    if (path.startsWith("/api/") && !path.startsWith("/api/auth/")) {
      if (!(await isAdminAuthorized(req))) {
        response = adminProblemResponse("未登录", {
          status: 401,
          instance: path,
        });
        return finalizeResponse(req, response, requestId, startedAt);
      }
    }

    const matched = router.match(req.method, req.url);
    if (matched) {
      response = await matched.handler(req, matched.params, context);
      return finalizeResponse(req, response, requestId, startedAt);
    }

    response = problemResponse("Not Found", { status: 404, instance: path });
    return finalizeResponse(req, response, requestId, startedAt);
  };
}

function resolveRequestId(req: Request): string {
  const provided = req.headers.get("x-request-id")?.trim();
  if (provided && provided.length <= MAX_REQUEST_ID_LENGTH) return provided;
  return crypto.randomUUID();
}

function finalizeResponse(
  req: Request,
  response: Response,
  requestId: string,
  startedAt: number,
): Response {
  response.headers.set("x-request-id", requestId);
  const url = new URL(req.url);
  logger.info("http_request", {
    requestId,
    method: req.method,
    path: url.pathname,
    status: response.status,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return response;
}
