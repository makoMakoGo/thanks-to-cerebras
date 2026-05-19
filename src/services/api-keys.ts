import { CEREBRAS_API_URL, UPSTREAM_TEST_TIMEOUT_MS } from "../constants.ts";
import { fetchWithTimeout, isAbortError, safeJsonParse } from "../utils.ts";
import { state } from "../state.ts";
import { kvGetApiKeyById, kvUpdateKey } from "../kv/api-keys.ts";
import { removeModelFromPool } from "../kv/model-catalog.ts";
import { isModelNotFoundPayload, isModelNotFoundText } from "../models.ts";
import { logger } from "../logger.ts";

/**
 * Tests an API key against the configured model pool; an empty pool is a config error.
 */
export async function testKey(
  id: string,
): Promise<{ success: boolean; status: string; error?: string }> {
  const apiKey = await kvGetApiKeyById(id);

  if (!apiKey) {
    return { success: false, status: "invalid", error: "密钥不存在" };
  }

  if (state.cachedModelPool.length === 0) {
    return { success: false, status: "error", error: "模型池为空" };
  }
  const testModel = state.cachedModelPool[0];

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
      await response.body?.cancel();
      await kvUpdateKey(id, { status: "active" });
      return { success: true, status: "active" };
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      await kvUpdateKey(id, { status: "invalid" });
      return {
        success: false,
        status: "invalid",
        error: `HTTP ${response.status}`,
      };
    }

    if (response.status === 404) {
      const bodyText = await response.clone().text().catch(() => "");
      const payload = safeJsonParse(bodyText);
      const modelNotFound = isModelNotFoundPayload(payload) ||
        isModelNotFoundText(bodyText);

      if (modelNotFound) {
        await response.body?.cancel();
        await removeModelFromPool(testModel, "model_not_found");
        await kvUpdateKey(id, { status: "active" });
        return { success: true, status: "active" };
      }
    }

    await response.body?.cancel();
    await kvUpdateKey(id, { status: "inactive" });
    return {
      success: false,
      status: "inactive",
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    logger.error("api_key_test_failed", { keyId: id }, error);
    await kvUpdateKey(id, { status: "inactive" });
    return {
      success: false,
      status: "inactive",
      error: isAbortError(error) ? "请求超时" : "密钥测试失败",
    };
  }
}
