import { CEREBRAS_API_URL, UPSTREAM_TEST_TIMEOUT_MS } from "../constants.ts";
import {
  fetchWithTimeout,
  getErrorMessage,
  isAbortError,
  safeJsonParse,
} from "../utils.ts";
import { state } from "../state.ts";
import type { ModelCatalog } from "../types.ts";
import { kvGetAllKeys, kvUpdateKey } from "../kv/api-keys.ts";
import { kvGetConfig, kvUpdateConfig } from "../kv/config.ts";
import {
  isModelCatalogFresh,
  kvGetModelCatalog,
  refreshModelCatalog,
  removeModelFromPool,
} from "../kv/model-catalog.ts";
import {
  isModelNotFoundPayload,
  isModelNotFoundText,
  normalizeModelPool,
  rebuildModelPoolCache,
} from "../models.ts";
import { metrics } from "../metrics.ts";
import { logger } from "../logger.ts";

export interface CatalogResult {
  catalog: ModelCatalog;
  stale: boolean;
  lastError?: string;
}

export async function getCatalogData(): Promise<CatalogResult> {
  const now = Date.now();

  let catalog = state.cachedModelCatalog;
  if (!catalog || !isModelCatalogFresh(catalog, now)) {
    const kvCatalog = await kvGetModelCatalog();
    if (kvCatalog) catalog = kvCatalog;
  }

  if (catalog && isModelCatalogFresh(catalog, now)) {
    return { catalog, stale: false };
  }

  try {
    catalog = await refreshModelCatalog();
    return { catalog, stale: false };
  } catch (error) {
    const lastError = getErrorMessage(error);
    if (catalog) return { catalog, stale: true, lastError };
    throw new Error(lastError);
  }
}

export async function forceRefreshCatalog(): Promise<CatalogResult> {
  const fallback = state.cachedModelCatalog ?? (await kvGetModelCatalog());

  try {
    const catalog = await refreshModelCatalog();
    return { catalog, stale: false };
  } catch (error) {
    const lastError = getErrorMessage(error);
    if (fallback) return { catalog: fallback, stale: true, lastError };
    throw new Error(lastError);
  }
}

export function validateAndDeduplicateModels(
  raw: unknown[],
): string[] | null {
  const seen = new Set<string>();
  const models = raw
    .map((m) => (typeof m === "string" ? m.trim() : ""))
    .filter((m) => m.length > 0)
    .filter((m) => {
      if (seen.has(m)) return false;
      seen.add(m);
      return true;
    });
  return models.length > 0 ? models : null;
}

export async function updateModelPool(models: string[]): Promise<void> {
  await kvUpdateConfig((config) => ({
    ...config,
    modelPool: models,
    currentModelIndex: 0,
  }));
  rebuildModelPoolCache();
}

export async function getModelPool(): Promise<string[]> {
  const config = state.cachedConfig;
  if (config) return normalizeModelPool(config.modelPool);
  const c = await kvGetConfig();
  return normalizeModelPool(c.modelPool);
}

export async function testModelAvailability(
  modelName: string,
): Promise<{ success: boolean; status: string; error?: string }> {
  let activeKey = Array.from(state.cachedKeysById.values()).find(
    (k) => k.status === "active",
  );
  if (!activeKey) {
    const keys = await kvGetAllKeys();
    activeKey = keys.find((k) => k.status === "active");
  }
  if (!activeKey) {
    return { success: false, status: "error", error: "没有可用的 API 密钥" };
  }

  try {
    const response = await fetchWithTimeout(
      CEREBRAS_API_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeKey.key}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1,
        }),
      },
      UPSTREAM_TEST_TIMEOUT_MS,
    );

    if (response.ok) {
      metrics.inc("upstream_responses_total", "2xx");
      await response.body?.cancel();
      return { success: true, status: "available" };
    }

    if (response.status === 404) {
      const clone = response.clone();
      const bodyText = await clone.text().catch(() => "");
      const payload = safeJsonParse(bodyText);
      const modelNotFound = isModelNotFoundPayload(payload) ||
        isModelNotFoundText(bodyText);

      if (modelNotFound) {
        metrics.inc("upstream_responses_total", "404_model_not_found");
        await response.body?.cancel();
        await removeModelFromPool(modelName, "model_not_found");
        return {
          success: false,
          status: "model_not_found",
          error: "model_not_found",
        };
      }
    }

    if (response.status === 401 || response.status === 403) {
      metrics.inc(
        "upstream_responses_total",
        response.status === 401 ? "401" : "403",
      );
      await kvUpdateKey(activeKey.id, { status: "invalid" });
    } else {
      metrics.inc("upstream_responses_total", "other");
    }

    await response.body?.cancel();
    return {
      success: false,
      status: "unavailable",
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    logger.error("model_test_failed", { model: modelName }, error);
    return {
      success: false,
      status: "error",
      error: isAbortError(error) ? "请求超时" : "模型测试失败",
    };
  }
}
