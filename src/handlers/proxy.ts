import { EXTERNAL_MODEL_ID } from "../constants.ts";
import { jsonError, jsonResponse } from "../http.ts";
import { isProxyAuthorized, recordProxyKeyUsage } from "../auth.ts";
import { forwardChatCompletion } from "../services/proxy.ts";
import { readAndValidateChatRequest } from "../proxy-validation.ts";
import { metrics } from "../metrics.ts";
import type { Router } from "../router.ts";

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
    metrics.inc("proxy_requests_total", "unauthorized");
    return jsonError("Unauthorized", 401);
  }

  if (authResult.keyId) {
    recordProxyKeyUsage(authResult.keyId);
  }

  const validation = await readAndValidateChatRequest(req);
  if (!validation.ok) {
    metrics.inc("proxy_requests_total", "bad_request");
    return jsonError(validation.message, validation.status);
  }

  const result = await forwardChatCompletion(validation.body);

  if (result.kind === "error") {
    return jsonError(
      result.message,
      result.status,
      result.headers ??
        (result.retryAfterSec
          ? { "Retry-After": String(result.retryAfterSec) }
          : undefined),
    );
  }

  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

export function register(router: Router): void {
  router
    .get("/v1/models", handleModelsEndpoint)
    .post("/v1/chat/completions", handleProxyEndpoint);
}
