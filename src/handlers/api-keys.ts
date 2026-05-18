import { adminJsonResponse, adminProblemResponse } from "../http.ts";
import { maskKey, parseBatchInput } from "../utils.ts";
import {
  kvAddKey,
  kvDeleteKey,
  kvGetAllKeys,
  kvGetApiKeyById,
} from "../kv/api-keys.ts";
import { testKey } from "../services/api-keys.ts";
import type { Router } from "../router.ts";

async function listApiKeys(): Promise<Response> {
  const keys = await kvGetAllKeys();
  keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: maskKey(k.key),
  }));
  return adminJsonResponse({ keys: maskedKeys });
}

async function addApiKey(req: Request): Promise<Response> {
  try {
    const { key } = await req.json();
    if (!key) {
      return adminProblemResponse("密钥不能为空", {
        status: 400,
        instance: "/api/keys",
      });
    }

    const result = await kvAddKey(key);
    if (!result.success) {
      return adminProblemResponse(result.error ?? "添加失败", {
        status: result.error === "密钥已存在" ? 409 : 400,
        instance: "/api/keys",
      });
    }

    return adminJsonResponse(result, { status: 201 });
  } catch (error) {
    console.error("[API-KEYS] add key error:", error);
    return adminProblemResponse("请求处理失败", {
      status: 400,
      instance: "/api/keys",
    });
  }
}

async function batchImportApiKeys(req: Request): Promise<Response> {
  try {
    const contentType = req.headers.get("Content-Type") || "";
    let input: string;

    if (contentType.includes("application/json")) {
      const body = await req.json();
      input = body.input || (typeof body === "string" ? body : "");
    } else {
      input = await req.text();
    }

    if (!input?.trim()) {
      return adminProblemResponse("输入不能为空", {
        status: 400,
        instance: "/api/keys/batch",
      });
    }

    const keys = parseBatchInput(input);
    const results = {
      success: [] as string[],
      failed: [] as { key: string; error: string }[],
    };

    for (const key of keys) {
      const result = await kvAddKey(key);
      if (result.success) {
        results.success.push(maskKey(key));
      } else {
        results.failed.push({
          key: maskKey(key),
          error: result.error || "未知错误",
        });
      }
    }

    return adminJsonResponse({
      summary: {
        total: keys.length,
        success: results.success.length,
        failed: results.failed.length,
      },
      results,
    });
  } catch (error) {
    console.error("[API-KEYS] batch import error:", error);
    return adminProblemResponse("请求处理失败", {
      status: 400,
      instance: "/api/keys/batch",
    });
  }
}

async function exportAllApiKeys(): Promise<Response> {
  const keys = await kvGetAllKeys();
  keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rawKeys = keys.map((k) => k.key);
  return adminJsonResponse({ keys: rawKeys });
}

async function exportApiKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const keyEntry = await kvGetApiKeyById(params.id);
  if (!keyEntry) {
    return adminProblemResponse("密钥不存在", {
      status: 404,
      instance: `/api/keys/${params.id}/export`,
    });
  }
  return adminJsonResponse({ key: keyEntry.key });
}

async function deleteApiKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const result = await kvDeleteKey(params.id);
  if (!result.success) {
    return adminProblemResponse(result.error ?? "删除失败", {
      status: result.error === "密钥不存在" ? 404 : 400,
      instance: `/api/keys/${params.id}`,
    });
  }
  return adminJsonResponse(result);
}

async function testApiKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  return adminJsonResponse(await testKey(params.id));
}

export function register(router: Router): void {
  router
    .get("/api/keys", listApiKeys)
    .post("/api/keys", addApiKey)
    .post("/api/keys/batch", batchImportApiKeys)
    .get("/api/keys/export", exportAllApiKeys)
    .get("/api/keys/:id/export", exportApiKey)
    .delete("/api/keys/:id", deleteApiKey)
    .post("/api/keys/:id/test", testApiKey);
}
