import {
  CEREBRAS_API_URL,
  FALLBACK_MODEL,
  UPSTREAM_TEST_TIMEOUT_MS,
} from "../constants.ts";
import { jsonResponse, problemResponse } from "../http.ts";
import {
  fetchWithTimeout,
  getErrorMessage,
  isAbortError,
  maskKey,
  parseBatchInput,
  safeJsonParse,
} from "../utils.ts";
import { state } from "../state.ts";
import {
  kvAddKey,
  kvDeleteKey,
  kvGetAllKeys,
  kvGetApiKeyById,
  kvUpdateKey,
} from "../kv/api-keys.ts";
import { removeModelFromPool } from "../kv/model-catalog.ts";
import { isModelNotFoundPayload, isModelNotFoundText } from "../models.ts";
import type { Router } from "../router.ts";

export async function testKey(
  id: string,
): Promise<{ success: boolean; status: string; error?: string }> {
  const apiKey = await kvGetApiKeyById(id);

  if (!apiKey) {
    return { success: false, status: "invalid", error: "密钥不存在" };
  }

  const testModel = state.cachedModelPool.length > 0
    ? state.cachedModelPool[0]
    : FALLBACK_MODEL;

  try {
    const response = await fetchWithTimeout(
      CEREBRAS_API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.key}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1,
        }),
      },
      UPSTREAM_TEST_TIMEOUT_MS,
    );

    if (response.ok) {
      await kvUpdateKey(id, { status: "active" });
      return { success: true, status: "active" };
    }

    if (response.status === 401 || response.status === 403) {
      await kvUpdateKey(id, { status: "invalid" });
      return {
        success: false,
        status: "invalid",
        error: `HTTP ${response.status}`,
      };
    }

    if (response.status === 404) {
      const clone = response.clone();
      const bodyText = await clone.text().catch(() => "");
      const payload = safeJsonParse(bodyText);
      const modelNotFound = isModelNotFoundPayload(payload) ||
        isModelNotFoundText(bodyText);

      if (modelNotFound) {
        await removeModelFromPool(testModel, "model_not_found");
        await kvUpdateKey(id, { status: "active" });
        return { success: true, status: "active" };
      }
    }

    await kvUpdateKey(id, { status: "inactive" });
    return {
      success: false,
      status: "inactive",
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    const msg = isAbortError(error) ? "请求超时" : getErrorMessage(error);
    await kvUpdateKey(id, { status: "inactive" });
    return { success: false, status: "inactive", error: msg };
  }
}

async function listApiKeys(): Promise<Response> {
  const keys = await kvGetAllKeys();
  keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: maskKey(k.key),
  }));
  return jsonResponse({ keys: maskedKeys });
}

async function addApiKey(req: Request): Promise<Response> {
  try {
    const { key } = await req.json();
    if (!key) {
      return problemResponse("密钥不能为空", {
        status: 400,
        instance: "/api/keys",
      });
    }

    const result = await kvAddKey(key);
    if (!result.success) {
      return problemResponse(result.error ?? "添加失败", {
        status: result.error === "密钥已存在" ? 409 : 400,
        instance: "/api/keys",
      });
    }

    return jsonResponse(result, { status: 201 });
  } catch (error) {
    console.error("[API-KEYS] add key error:", error);
    return problemResponse("请求处理失败", {
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
      return problemResponse("输入不能为空", {
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

    return jsonResponse({
      summary: {
        total: keys.length,
        success: results.success.length,
        failed: results.failed.length,
      },
      results,
    });
  } catch (error) {
    console.error("[API-KEYS] batch import error:", error);
    return problemResponse("请求处理失败", {
      status: 400,
      instance: "/api/keys/batch",
    });
  }
}

async function exportAllApiKeys(): Promise<Response> {
  const keys = await kvGetAllKeys();
  keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rawKeys = keys.map((k) => k.key);
  return jsonResponse({ keys: rawKeys });
}

async function exportApiKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const keyEntry = await kvGetApiKeyById(params.id);
  if (!keyEntry) {
    return problemResponse("密钥不存在", {
      status: 404,
      instance: `/api/keys/${params.id}/export`,
    });
  }
  return jsonResponse({ key: keyEntry.key });
}

async function deleteApiKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const result = await kvDeleteKey(params.id);
  if (!result.success) {
    return problemResponse(result.error ?? "删除失败", {
      status: result.error === "密钥不存在" ? 404 : 400,
      instance: `/api/keys/${params.id}`,
    });
  }
  return jsonResponse(result);
}

async function testApiKey(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const result = await testKey(params.id);
  return jsonResponse(result);
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
