import { MAX_PROXY_KEYS } from "../constants.ts";
import { adminJsonResponse, adminProblemResponse } from "../http.ts";
import {
  kvAddProxyKey,
  kvDeleteProxyKey,
  kvGetAllProxyKeys,
  kvMigrateProxyKeysToHashed,
} from "../kv/proxy-keys.ts";
import { kvGetConfig } from "../kv/config.ts";
import { logger } from "../logger.ts";
import type { Router } from "../router.ts";

async function listProxyKeys(): Promise<Response> {
  try {
    const [keys, config] = await Promise.all([
      kvGetAllProxyKeys(),
      kvGetConfig(),
    ]);
    keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const keyMetadata = keys.map((k) => ({
      id: k.id,
      name: k.name,
      useCount: k.useCount,
      lastUsed: k.lastUsed,
      createdAt: k.createdAt,
    }));
    return adminJsonResponse({
      keys: keyMetadata,
      maxKeys: MAX_PROXY_KEYS,
      authEnabled: true,
      proxyPublicAccess: config.proxyPublicAccess,
    });
  } catch (error) {
    logger.error("proxy_key_list_failed", {}, error);
    return adminProblemResponse("获取代理密钥列表失败", {
      status: 500,
      instance: "/api/proxy-keys",
    });
  }
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
    logger.error("proxy_key_create_failed", {}, error);
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

function exportProxyKey(
  _req: Request,
  params: Record<string, string>,
): Response {
  return adminProblemResponse("代理密钥只在创建时显示一次", {
    status: 403,
    instance: `/api/proxy-keys/${params.id}/export`,
  });
}

async function migrateProxyKeys(): Promise<Response> {
  const migrated = await kvMigrateProxyKeysToHashed();
  return adminJsonResponse({ success: true, migrated });
}

export function register(router: Router): void {
  router
    .get("/api/proxy-keys", listProxyKeys)
    .post("/api/proxy-keys", createProxyKey)
    .post("/api/proxy-keys/migrate", migrateProxyKeys)
    .delete("/api/proxy-keys/:id", deleteProxyKey)
    .get("/api/proxy-keys/:id/export", exportProxyKey);
}
