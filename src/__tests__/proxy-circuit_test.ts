import { assertEquals } from "@std/assert";
import {
  API_KEY_PREFIX,
  CEREBRAS_API_URL,
  UPSTREAM_CIRCUIT_FAILURE_THRESHOLD,
} from "../constants.ts";
import { encryptApiKey } from "../secrets.ts";
import { createHandler, createRouter } from "../app.ts";
import { rebuildActiveKeyIds } from "../api-keys.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { metrics } from "../metrics.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { AppState, state } from "../state.ts";
import { setLogSinkForTests } from "../logger.ts";

const BASE = "http://localhost";

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) clearInterval(state.kvFlushTimerId);
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("SETUP_TOKEN", "test-setup-token");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  await bootstrapCache();
  await resetKvRateLimitsForTests();
  await resetProxyStreamCountersForTests();
  metrics.reset();
  setLogSinkForTests(() => {});
  return kv;
}

function makeReq(body: unknown): Request {
  return new Request(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function addActiveApiKey(key: string): Promise<void> {
  const apiKey = {
    id: crypto.randomUUID(),
    key,
    encryptedKey: await encryptApiKey(key),
    useCount: 0,
    status: "active" as const,
    createdAt: Date.now(),
  };
  await state.kv.set([...API_KEY_PREFIX, apiKey.id], {
    id: apiKey.id,
    encryptedKey: apiKey.encryptedKey,
    useCount: apiKey.useCount,
    status: apiKey.status,
    createdAt: apiKey.createdAt,
  });
  state.cachedKeysById.set(apiKey.id, apiKey);
  rebuildActiveKeyIds();
}

function installUpstreamResponse(response: () => Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
    assertEquals(String(input), CEREBRAS_API_URL);
    return Promise.resolve(response());
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

Deno.test("proxy circuit: opens after repeated 5xx responses", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());
  state.cachedConfig = { ...state.cachedConfig!, proxyPublicAccess: true };
  await addActiveApiKey("sk-upstream-test");
  let fetchCount = 0;
  const restoreFetch = installUpstreamResponse(() => {
    fetchCount += 1;
    return new Response(JSON.stringify({ error: "temporary outage" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    for (let i = 0; i < UPSTREAM_CIRCUIT_FAILURE_THRESHOLD; i++) {
      const res = await handler(
        makeReq({ messages: [{ role: "user", content: "hi" }] }),
      );
      assertEquals(res.status, 503);
      await res.body?.cancel();
    }

    const openRes = await handler(
      makeReq({ messages: [{ role: "user", content: "hi" }] }),
    );
    assertEquals(openRes.status, 503);
    assertEquals(openRes.headers.has("Retry-After"), true);
    const body = await openRes.json();
    assertEquals(body.error.code, "upstream_circuit_open");
    assertEquals(fetchCount, UPSTREAM_CIRCUIT_FAILURE_THRESHOLD);
  } finally {
    setLogSinkForTests(null);
    restoreFetch();
    kv.close();
  }
});

Deno.test("proxy circuit: ignores key errors", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());
  state.cachedConfig = { ...state.cachedConfig!, proxyPublicAccess: true };
  for (let i = 0; i < UPSTREAM_CIRCUIT_FAILURE_THRESHOLD; i++) {
    await addActiveApiKey(`sk-upstream-test-${i}`);
  }
  let fetchCount = 0;
  const restoreFetch = installUpstreamResponse(() => {
    fetchCount += 1;
    return new Response(JSON.stringify({ error: "bad key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    for (let i = 0; i < UPSTREAM_CIRCUIT_FAILURE_THRESHOLD; i++) {
      const res = await handler(
        makeReq({ messages: [{ role: "user", content: "hi" }] }),
      );
      assertEquals(res.status, 401);
      await res.body?.cancel();
    }
    assertEquals(fetchCount, UPSTREAM_CIRCUIT_FAILURE_THRESHOLD);
    assertEquals(state.upstreamCircuitOpenedUntil, 0);
  } finally {
    setLogSinkForTests(null);
    restoreFetch();
    kv.close();
  }
});
