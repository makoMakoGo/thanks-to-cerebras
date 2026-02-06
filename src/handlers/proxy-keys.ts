import { MAX_PROXY_KEYS } from "../constants.ts";
import { jsonResponse, problemResponse } from "../http.ts";
import { getErrorMessage, maskKey } from "../utils.ts";
import {
  kvAddProxyKey,
  kvDeleteProxyKey,
  kvGetAllProxyKeys,
  kvGetProxyKeyById,
} from "../kv/proxy-keys.ts";
import type { Router } from "../router.ts";

async function listProxyKeys(): Promise<Response> {
  const keys = await kvGetAllProxyKeys();
  keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const masked = keys.map((k) => ({
    id: k.id,
    key: maskKey(k.key),
    name: k.name,
    useCount: k.useCount,
    lastUsed: k.lastUsed,
    createdAt: k.createdAt,
  }));
  return jsonResponse({
    keys: masked,
    maxKeys: MAX_PROXY_KEYS,
    authEnabled: keys.length > 0,
  });
}

async function createProxyKey(req: Request): Promise<Response> {
  try {
    const { name } = await req.json().catch(() => ({ name: "" }));
    const result = await kvAddProxyKey(name);
    if (!result.success) {
      return problemResponse(result.error ?? "创建失败", {
        status: 400,
        instance: "/api/proxy-keys",
      });
    }
    return jsonResponse(result, { status: 201 });
  } catch (error) {
    return problemResponse(getErrorMessage(error), {
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
    return problemResponse(result.error ?? "删除失败", {
      status: result.error === "密钥不存在" ? 404 : 400,
      instance: `/api/proxy-keys/${params.id}`,
    });
  }
  return jsonResponse(result);
}

async function exportProxyKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const pk = await kvGetProxyKeyById(params.id);
  if (!pk) {
    return problemResponse("密钥不存在", {
      status: 404,
      instance: `/api/proxy-keys/${params.id}/export`,
    });
  }
  return jsonResponse({ key: pk.key });
}

export function register(router: Router): void {
  router
    .get("/api/proxy-keys", listProxyKeys)
    .post("/api/proxy-keys", createProxyKey)
    .delete("/api/proxy-keys/:id", deleteProxyKey)
    .get("/api/proxy-keys/:id/export", exportProxyKey);
}
