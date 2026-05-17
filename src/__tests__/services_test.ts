import { assertEquals, assertRejects } from "@std/assert";
import { CEREBRAS_PUBLIC_MODELS_URL } from "../constants.ts";
import { AppState, state } from "../state.ts";
import { refreshModelCatalog } from "../kv/model-catalog.ts";
import { kvAddKey, kvGetApiKeyById } from "../kv/api-keys.ts";
import { testKey } from "../services/api-keys.ts";

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
  }
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  return kv;
}

Deno.test("refreshModelCatalog - rejects malformed JSON without caching empty catalog", async () => {
  const kv = await setupKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL) => {
    assertEquals(String(input), CEREBRAS_PUBLIC_MODELS_URL);
    return Promise.resolve(new Response("{not json", { status: 200 }));
  };

  try {
    await assertRejects(
      () => refreshModelCatalog(),
      Error,
      "模型目录响应不是有效 JSON",
    );
    assertEquals(state.cachedModelCatalog, null);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("refreshModelCatalog - rejects payloads without data array", async () => {
  const kv = await setupKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ models: [{ id: "wrong-shape" }] }), {
        status: 200,
      }),
    );

  try {
    await assertRejects(
      () => refreshModelCatalog(),
      Error,
      "模型目录响应缺少 data 数组",
    );
    assertEquals(state.cachedModelCatalog, null);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("testKey - does not mark keys active when configured model pool is empty", async () => {
  const kv = await setupKv();
  const addResult = await kvAddKey("sk-empty-model-pool");
  if (addResult.id === undefined) throw new Error("API key id missing");
  await kvGetApiKeyById(addResult.id);
  state.cachedModelPool = [];

  const result = await testKey(addResult.id);

  assertEquals(result, {
    success: false,
    status: "error",
    error: "模型池为空",
  });
  // Empty model configuration must not reclassify the key itself.
  const keyEntry = state.cachedKeysById.get(addResult.id);
  assertEquals(keyEntry?.status, "active");

  kv.close();
});

Deno.test("refreshModelCatalog - rejects null JSON body", async () => {
  const kv = await setupKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("null", { status: 200 }));

  try {
    await assertRejects(
      () => refreshModelCatalog(),
      Error,
      "模型目录响应格式错误",
    );
    assertEquals(state.cachedModelCatalog, null);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});
