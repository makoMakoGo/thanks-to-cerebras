import type { ModelCatalog } from "../types.ts";
import {
  CEREBRAS_PUBLIC_MODELS_URL,
  MODEL_CATALOG_FETCH_TIMEOUT_MS,
  MODEL_CATALOG_KEY,
  MODEL_CATALOG_TTL_MS,
} from "../constants.ts";
import { fetchWithTimeout } from "../utils.ts";
import { normalizeModelPool, rebuildModelPoolCache } from "../models.ts";
import { state } from "../state.ts";
import { kvUpdateConfig } from "./config.ts";

/**
 * Returns whether a model catalog is within the configured cache TTL.
 */
export function isModelCatalogFresh(
  catalog: ModelCatalog,
  now: number,
): boolean {
  return (
    now >= catalog.fetchedAt && now - catalog.fetchedAt < MODEL_CATALOG_TTL_MS
  );
}

/**
 * Reads the cached model catalog from KV without refreshing upstream data.
 */
export async function kvGetModelCatalog(): Promise<ModelCatalog | null> {
  const entry = await state.kv.get<ModelCatalog>(MODEL_CATALOG_KEY);
  return entry.value ?? null;
}

/**
 * Fetches and caches the upstream model catalog only after strict payload validation.
 */
export async function refreshModelCatalog(): Promise<ModelCatalog> {
  if (state.modelCatalogFetchInFlight) {
    return await state.modelCatalogFetchInFlight;
  }

  const promise = (async () => {
    const response = await fetchWithTimeout(
      CEREBRAS_PUBLIC_MODELS_URL,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      MODEL_CATALOG_FETCH_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const suffix = text && text.length <= 200 ? `: ${text}` : "";
      throw new Error(`模型目录拉取失败：HTTP ${response.status}${suffix}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(
        `模型目录响应不是有效 JSON：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Guard against valid JSON primitives (null, scalar) before property access.
    if (typeof data !== "object" || data === null) {
      throw new Error("模型目录响应格式错误");
    }

    const rawModels = (data as { data?: unknown }).data;
    if (!Array.isArray(rawModels)) {
      throw new Error("模型目录响应缺少 data 数组");
    }

    const ids = rawModels
      .map((m) => {
        if (!m || typeof m !== "object") return "";
        if (!("id" in m)) return "";
        const id = (m as { id?: unknown }).id;
        return typeof id === "string" ? id.trim() : "";
      })
      .filter((id) => id.length > 0);

    const seen = new Set<string>();
    const models: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }

    const catalog: ModelCatalog = {
      source: "cerebras-public",
      fetchedAt: Date.now(),
      models,
    };

    state.cachedModelCatalog = catalog;

    try {
      await state.kv.set(MODEL_CATALOG_KEY, catalog);
    } catch (error) {
      console.error(`[KV] model catalog save failed:`, error);
    }

    return catalog;
  })().finally(() => {
    state.modelCatalogFetchInFlight = null;
  });

  state.modelCatalogFetchInFlight = promise;
  return await promise;
}

/**
 * Removes an unavailable model from the configured pool and resets rotation.
 */
export async function removeModelFromPool(
  model: string,
  reason: string,
): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;

  const existed = state.cachedModelPool.includes(trimmed);

  await kvUpdateConfig((config) => {
    const pool = normalizeModelPool(config.modelPool);
    const nextPool = pool.filter((m) => m !== trimmed);

    if (nextPool.length === pool.length) {
      return config;
    }

    return {
      ...config,
      modelPool: nextPool,
      currentModelIndex: 0,
    };
  });

  rebuildModelPoolCache();

  if (existed) {
    console.warn(`[MODEL] removed (${reason}): ${trimmed}`);
  }
}
