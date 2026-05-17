import { MODEL_CATALOG_TTL_MS } from "../constants.ts";
import { adminJsonResponse, adminProblemResponse } from "../http.ts";
import {
  forceRefreshCatalog,
  getCatalogData,
  getModelPool,
  testModelAvailability,
  updateModelPool,
  validateAndDeduplicateModels,
} from "../services/models.ts";
import type { Router } from "../router.ts";

async function getModelCatalog(): Promise<Response> {
  try {
    const { catalog, stale, lastError } = await getCatalogData();
    if (lastError) console.error("[MODELS] stale catalog error:", lastError);
    return adminJsonResponse({
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      ttlMs: MODEL_CATALOG_TTL_MS,
      stale,
      ...(lastError ? { lastError: "获取模型目录时发生错误" } : {}),
      models: catalog.models,
    });
  } catch (error) {
    console.error("[MODELS] catalog fetch error:", error);
    return adminProblemResponse("无法获取模型目录", {
      status: 502,
      instance: "/api/models/catalog",
    });
  }
}

async function refreshCatalog(): Promise<Response> {
  try {
    const { catalog, stale, lastError } = await forceRefreshCatalog();
    if (lastError) console.error("[MODELS] stale refresh error:", lastError);
    return adminJsonResponse({
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      ttlMs: MODEL_CATALOG_TTL_MS,
      stale,
      ...(lastError ? { lastError: "刷新模型目录时发生错误" } : {}),
      models: catalog.models,
    });
  } catch (error) {
    console.error("[MODELS] catalog refresh error:", error);
    return adminProblemResponse("目录刷新失败", {
      status: 502,
      instance: "/api/models/catalog/refresh",
    });
  }
}

async function getModels(): Promise<Response> {
  return adminJsonResponse({ models: await getModelPool() });
}

async function updateModels(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const raw = (body as { models?: unknown }).models;
    if (!Array.isArray(raw)) {
      return adminProblemResponse("models 必须为字符串数组", {
        status: 400,
        instance: "/api/models",
      });
    }

    const models = validateAndDeduplicateModels(raw);
    if (!models) {
      return adminProblemResponse("模型池不能为空", {
        status: 400,
        instance: "/api/models",
      });
    }

    await updateModelPool(models);
    return adminJsonResponse({ success: true, models });
  } catch (error) {
    console.error("[MODELS] update pool error:", error);
    return adminProblemResponse("模型池更新失败", {
      status: 500,
      instance: "/api/models",
    });
  }
}

async function testModel(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  let modelName: string;
  try {
    modelName = decodeURIComponent(params.name);
  } catch {
    return adminProblemResponse("模型名称 URL 编码非法", {
      status: 400,
      instance: `/api/models/${params.name}/test`,
    });
  }

  const result = await testModelAvailability(modelName);
  if (result.error === "没有可用的 API 密钥") {
    return adminProblemResponse(result.error, {
      status: 400,
      instance: `/api/models/${params.name}/test`,
    });
  }
  return adminJsonResponse(result);
}

export function register(router: Router): void {
  router
    .get("/api/models/catalog", getModelCatalog)
    .post("/api/models/catalog/refresh", refreshCatalog)
    .get("/api/models", getModels)
    .put("/api/models", updateModels)
    .post("/api/models/:name/test", testModel);
}
