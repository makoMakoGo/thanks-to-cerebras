import { MAX_PROXY_KEYS } from "../constants.ts";
import { adminJsonResponse, adminProblemResponse } from "../http.ts";
import { maskKey } from "../utils.ts";
import {
  kvAddProxyKey,
  kvDeleteProxyKey,
  kvGetAllProxyKeys,
  kvGetProxyKeyById,
} from "../kv/proxy-keys.ts";
import { kvGetConfig } from "../kv/config.ts";
import type { Router } from "../router.ts";

async function listProxyKeys(): Promise<Response> {
  const [keys, config] = await Promise.all([
    kvGetAllProxyKeys(),
    kvGetConfig(),
  ]);
  keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const masked = keys.map((k) => ({
    id: k.id,
    key: maskKey(k.key),
    name: k.name,
    useCount: k.useCount,
    lastUsed: k.lastUsed,
    createdAt: k.createdAt,
  }));
  return adminJsonResponse({
    keys: masked,
    maxKeys: MAX_PROXY_KEYS,
    authEnabled: true,
    proxyPublicAccess: config.proxyPublicAccess,
  });
}

async function createProxyKey(req: Request): Promise<Response> {
  try {
    const { name } = await req.json().catch(() => ({ name: "" }));
    const result = await kvAddProxyKey(name);
    if (!result.success) {
      return adminProblemResponse(result.error ?? "创建失败", {
        status: 400,
        instance: "/api/proxy-keys",
      });
    }
    return adminJsonResponse(result, { status: 201 });
  } catch (error) {
    console.error("[PROXY-KEYS] create key error:", error);
    return adminProblemResponse("创建失败", {
      status: 400,
      instance: "/api/proxy-keys",
    });
  }
}

async function deleteProxyKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const result = await kvDeleteProxyKey(params.id);
  if (!result.success) {
    return adminProblemResponse(result.error ?? "删除失败", {
      status: result.error === "密钥不存在" ? 404 : 400,
      instance: `/api/proxy-keys/${params.id}`,
    });
  }
  return adminJsonResponse(result);
}

async function exportProxyKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const pk = await kvGetProxyKeyById(params.id);
  if (!pk) {
    return adminProblemResponse("密钥不存在", {
      status: 404,
      instance: `/api/proxy-keys/${params.id}/export`,
    });
  }
  return adminJsonResponse({ key: pk.key });
}

export function register(router: Router): void {
  router
    .get("/api/proxy-keys", listProxyKeys)
    .post("/api/proxy-keys", createProxyKey)
    .delete("/api/proxy-keys/:id", deleteProxyKey)
    .get("/api/proxy-keys/:id/export", exportProxyKey);
}
