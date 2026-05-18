import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { AppState, state } from "../state.ts";
import { createHandler, createRouter } from "../app.ts";
import { bootstrapCache, flushDirtyToKv } from "../kv/flush.ts";
import { loginLimiter } from "../rate-limit.ts";
import { metrics } from "../metrics.ts";
import {
  ADMIN_CORS_HEADERS,
  API_KEY_PREFIX,
  CORS_HEADERS,
  DEFAULT_KV_FLUSH_INTERVAL_MS,
  DEFAULT_MODEL_POOL,
  PROXY_KEY_PREFIX,
} from "../constants.ts";

const BASE = "http://localhost";

type Handler = (req: Request) => Promise<Response>;

function buildHandler(): Handler {
  return createHandler(createRouter());
}

function makeReq(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const init: RequestInit = {
    method,
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers ?? {}),
    },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  return new Request(`${BASE}${path}`, init);
}

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
  }
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("SETUP_TOKEN", "test-setup-token");
  Object.assign(state, new AppState());
  state.kv = kv;
  await bootstrapCache();
  loginLimiter.reset();
  metrics.reset();
  return kv;
}

async function setupAuth(handler: Handler): Promise<string> {
  const res = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "test1234" },
    }),
  );
  const { token } = await res.json();
  return token;
}

async function enableProxyPublicAccess(handler: Handler): Promise<string> {
  const token = await setupAuth(handler);
  const res = await handler(
    makeReq("PATCH", "/api/config", {
      headers: { "X-Admin-Token": token },
      body: { proxyPublicAccess: true },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.proxyPublicAccess, true);
  return token;
}

// ─── Auth Flow ───

Deno.test("integration: auth setup → login → logout", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const status1 = await (await handler(
    makeReq("GET", "/api/auth/status"),
  )).json();
  assertEquals(status1.hasPassword, false);
  assertEquals(status1.isLoggedIn, false);

  const setupRes = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "test1234" },
    }),
  );
  assertEquals(setupRes.status, 200);
  const setupBody = await setupRes.json();
  assertEquals(setupBody.success, true);
  assertMatch(setupBody.token, /^[0-9a-f-]{36}$/);
  const setupToken = setupBody.token;

  const status2 = await (await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": setupToken },
    }),
  )).json();
  assertEquals(status2.isLoggedIn, true);

  const dupRes = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "other" },
    }),
  );
  assertEquals(dupRes.status, 400);

  const loginRes = await handler(
    makeReq("POST", "/api/auth/login", { body: { password: "test1234" } }),
  );
  assertEquals(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assertEquals(loginBody.success, true);
  assertMatch(loginBody.token, /^[0-9a-f-]{36}$/);
  const loginToken = loginBody.token;

  const loginStatus = await (await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": loginToken },
    }),
  )).json();
  assertEquals(loginStatus.isLoggedIn, true);

  const badLogin = await handler(
    makeReq("POST", "/api/auth/login", { body: { password: "wrong" } }),
  );
  assertEquals(badLogin.status, 401);

  await handler(
    makeReq("POST", "/api/auth/logout", {
      headers: { "X-Admin-Token": loginToken },
    }),
  );
  const status3 = await (await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": loginToken },
    }),
  )).json();
  assertEquals(status3.isLoggedIn, false);

  kv.close();
});

Deno.test("integration: first-time auth setup requires JSON and bootstrap token", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  Deno.env.delete("SETUP_TOKEN");
  const missingEnv = await handler(
    makeReq("POST", "/api/auth/setup", { body: { password: "first-pass" } }),
  );
  assertEquals(missingEnv.status, 503);

  Deno.env.set("SETUP_TOKEN", "test-setup-token");
  const wrongToken = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "wrong-token" },
      body: { password: "first-pass" },
    }),
  );
  assertEquals(wrongToken.status, 403);

  const wrongContentType = await handler(
    new Request(`${BASE}/api/auth/setup`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Setup-Token": "test-setup-token",
      },
      body: JSON.stringify({ password: "first-pass" }),
    }),
  );
  assertEquals(wrongContentType.status, 415);

  const setupRes = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "first-pass" },
    }),
  );
  assertEquals(setupRes.status, 200);
  const body = await setupRes.json();
  assertEquals(body.success, true);
  assertMatch(body.token, /^[0-9a-f-]{36}$/);

  kv.close();
});

Deno.test("integration: login rejects non-JSON request bodies", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await setupAuth(handler);

  const res = await handler(
    new Request(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ password: "test1234" }),
    }),
  );
  assertEquals(res.status, 415);

  kv.close();
});

Deno.test("integration: concurrent first-time auth setup creates one admin token", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const responses = await Promise.all([
    handler(
      makeReq("POST", "/api/auth/setup", {
        headers: { "X-Setup-Token": "test-setup-token" },
        body: { password: "first-pass" },
      }),
    ),
    handler(
      makeReq("POST", "/api/auth/setup", {
        headers: { "X-Setup-Token": "test-setup-token" },
        body: { password: "second-pass" },
      }),
    ),
  ]);
  const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
  assertEquals(statuses, [200, 400]);

  const bodies = await Promise.all(responses.map((res) => res.json()));
  const successBodies = bodies.filter((body) => body.success === true);
  assertEquals(successBodies.length, 1);
  assertMatch(successBodies[0].token, /^[0-9a-f-]{36}$/);

  kv.close();
});

Deno.test("integration: auth rate limit ignores spoofed forwarding headers", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "test1234" },
    }),
  );

  for (let i = 0; i < 4; i++) {
    const res = await handler(
      makeReq("POST", "/api/auth/login", {
        headers: { "x-forwarded-for": `203.0.113.${i}` },
        body: { password: "wrong" },
      }),
    );
    assertEquals(res.status, 401);
  }

  const limited = await handler(
    makeReq("POST", "/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.99" },
      body: { password: "wrong" },
    }),
  );
  assertEquals(limited.status, 429);

  kv.close();
});

// ─── Admin auth guard ───

Deno.test("integration: admin endpoints require auth", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(makeReq("GET", "/api/keys"));
  assertEquals(res.status, 401);

  kv.close();
});

// ─── API Key CRUD ───

Deno.test("integration: API key add → list → delete", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-test-abc123" },
    }),
  );
  assertEquals(addRes.status, 201);
  const addBody = await addRes.json();
  assertEquals(addBody.success, true);
  const keyId = addBody.id;

  const dupRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-test-abc123" },
    }),
  );
  assertEquals(dupRes.status, 409);

  const listRes = await handler(makeReq("GET", "/api/keys", { headers: h }));
  assertEquals(listRes.status, 200);
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 1);
  assertEquals(listBody.keys[0].id, keyId);

  const delRes = await handler(
    makeReq("DELETE", `/api/keys/${keyId}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);

  const listRes2 = await handler(makeReq("GET", "/api/keys", { headers: h }));
  const listBody2 = await listRes2.json();
  assertEquals(listBody2.keys.length, 0);

  kv.close();
});

Deno.test("integration: API key test errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-leak-test" },
    }),
  );
  const { id } = await addRes.json();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("POST", `/api/keys/${id}/test`, {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assertEquals(res.status, 200);
    assertEquals(body.success, false);
    assertEquals(body.status, "inactive");
    assertEquals(body.error, "密钥测试失败");
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

// ─── Proxy Key CRUD ───

Deno.test("integration: proxy key add → list → export → delete", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: h,
      body: { name: "Test Key" },
    }),
  );
  assertEquals(addRes.status, 201);
  const addBody = await addRes.json();
  assertEquals(addBody.success, true);
  const pkId = addBody.id;
  const rawKey = addBody.key;
  assertMatch(rawKey, /^cpk_[A-Za-z0-9_-]+$/);

  const listRes = await handler(
    makeReq("GET", "/api/proxy-keys", { headers: h }),
  );
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 1);
  assertEquals(listBody.keys[0].name, "Test Key");

  const exportRes = await handler(
    makeReq("GET", `/api/proxy-keys/${pkId}/export`, { headers: h }),
  );
  assertEquals(exportRes.status, 200);
  const exportBody = await exportRes.json();
  assertEquals(exportBody.key, rawKey);

  const delRes = await handler(
    makeReq("DELETE", `/api/proxy-keys/${pkId}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);

  const listRes2 = await handler(
    makeReq("GET", "/api/proxy-keys", { headers: h }),
  );
  const listBody2 = await listRes2.json();
  assertEquals(listBody2.keys.length, 0);

  kv.close();
});

Deno.test("integration: proxy key creation errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const originalSet = state.kv.set;
  state.kv.set = (() => {
    throw new Error("database password leaked");
  }) as typeof state.kv.set;

  try {
    const res = await handler(
      makeReq("POST", "/api/proxy-keys", {
        headers: { "X-Admin-Token": token },
        body: { name: "leak-check" },
      }),
    );
    const bodyText = await res.text();

    assertEquals(res.status, 400);
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    state.kv.set = originalSet;
    kv.close();
  }
});

// ─── Config ───

Deno.test("integration: config get → update", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const getRes = await handler(makeReq("GET", "/api/config", { headers: h }));
  assertEquals(getRes.status, 200);
  const getBody = await getRes.json();
  assertEquals(getBody.kvFlushIntervalMs, DEFAULT_KV_FLUSH_INTERVAL_MS);
  assertEquals(getBody.totalRequests, 0);
  assertEquals(getBody.proxyPublicAccess, false);

  const updateRes = await handler(
    makeReq("PATCH", "/api/config", {
      headers: h,
      body: { kvFlushIntervalMs: 5000, proxyPublicAccess: true },
    }),
  );
  assertEquals(updateRes.status, 200);
  const updateBody = await updateRes.json();
  assertEquals(updateBody.success, true);
  assertEquals(updateBody.kvFlushIntervalMs, 5000);
  assertEquals(updateBody.proxyPublicAccess, true);

  const persistedRes = await handler(
    makeReq("GET", "/api/config", { headers: h }),
  );
  assertEquals(persistedRes.status, 200);
  const persistedBody = await persistedRes.json();
  assertEquals(persistedBody.kvFlushIntervalMs, 5000);
  assertEquals(persistedBody.proxyPublicAccess, true);

  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
    state.kvFlushTimerId = null;
  }

  kv.close();
});

Deno.test("integration: dirty stats flush does not resurrect deleted API keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-race-delete-api" },
    }),
  );
  const { id } = await addRes.json();
  const cached = state.cachedKeysById.get(id);
  if (cached === undefined) throw new Error("added API key missing from cache");
  cached.useCount = 7;
  cached.lastUsed = 12345;
  state.dirtyKeyIds.add(id);

  const delRes = await handler(
    makeReq("DELETE", `/api/keys/${id}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);
  state.cachedKeysById.set(id, cached);
  state.dirtyKeyIds.add(id);

  await flushDirtyToKv();

  const entry = await state.kv.get([...API_KEY_PREFIX, id]);
  assertEquals(entry.value, null);

  kv.close();
});

Deno.test("integration: dirty stats flush does not resurrect deleted proxy keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const addRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: h,
      body: { name: "race delete" },
    }),
  );
  const { id } = await addRes.json();
  const cached = state.cachedProxyKeys!.get(id);
  if (cached === undefined) {
    throw new Error("added proxy key missing from cache");
  }
  cached.useCount = 4;
  cached.lastUsed = 12345;
  state.dirtyProxyKeyIds.add(id);

  const delRes = await handler(
    makeReq("DELETE", `/api/proxy-keys/${id}`, { headers: h }),
  );
  assertEquals(delRes.status, 200);
  state.cachedProxyKeys!.set(id, cached);
  state.dirtyProxyKeyIds.add(id);

  await flushDirtyToKv();

  const entry = await state.kv.get([...PROXY_KEY_PREFIX, id]);
  assertEquals(entry.value, null);

  kv.close();
});

// ─── Stats ───

Deno.test("integration: stats endpoint", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  await handler(
    makeReq("POST", "/api/keys", {
      headers: h,
      body: { key: "sk-stat-test" },
    }),
  );

  const statsRes = await handler(
    makeReq("GET", "/api/stats", { headers: h }),
  );
  assertEquals(statsRes.status, 200);
  const statsBody = await statsRes.json();
  assertEquals(statsBody.totalKeys, 1);
  assertEquals(statsBody.activeKeys, 1);

  kv.close();
});

// ─── Batch import ───

Deno.test("integration: batch import API keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const batchRes = await handler(
    makeReq("POST", "/api/keys/batch", {
      headers: h,
      body: { input: "sk-batch-1\nsk-batch-2\nsk-batch-3" },
    }),
  );
  assertEquals(batchRes.status, 200);
  const batchBody = await batchRes.json();
  assertEquals(batchBody.summary.total, 3);
  assertEquals(batchBody.summary.success, 3);
  assertEquals(batchBody.summary.failed, 0);

  const listRes = await handler(makeReq("GET", "/api/keys", { headers: h }));
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 3);

  kv.close();
});

// ─── Proxy authorization ───

Deno.test("integration: proxy 401 when no proxy key exists by default", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 401);

  kv.close();
});

Deno.test("integration: proxy explicit public mode allows requests without keys", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "没有可用的 API 密钥");

  kv.close();
});

Deno.test("integration: proxy 401 when proxy key exists but token missing", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);

  const addProxyKeyRes = await handler(
    makeReq("POST", "/api/proxy-keys", {
      headers: { "X-Admin-Token": token },
      body: { name: "gate" },
    }),
  );
  const addProxyKeyBody = await addProxyKeyRes.json();
  const rawProxyKey = addProxyKeyBody.key;

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 401);

  const resInvalid = await handler(
    makeReq("POST", "/v1/chat/completions", {
      headers: { Authorization: "Bearer invalid-token" },
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(resInvalid.status, 401);

  const resValid = await handler(
    makeReq("POST", "/v1/chat/completions", {
      headers: { Authorization: `Bearer ${rawProxyKey}` },
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(resValid.status, 500);

  kv.close();
});

// ─── Proxy: 400 bad request body ───

Deno.test("integration: proxy 400 when messages missing or empty", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);

  const res1 = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { not_messages: true },
    }),
  );
  assertEquals(res1.status, 400);

  const res2 = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [] },
    }),
  );
  assertEquals(res2.status, 400);

  kv.close();
});

// ─── Proxy: 500 no API keys ───

Deno.test("integration: proxy 500 when no API keys available", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await enableProxyPublicAccess(handler);

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "没有可用的 API 密钥");

  kv.close();
});

// ─── Proxy: 429 all keys on cooldown ───

Deno.test("integration: proxy 429 when all API keys on cooldown", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await enableProxyPublicAccess(handler);

  const addRes = await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-cooldown-test" },
    }),
  );
  const { id } = await addRes.json();

  state.keyCooldownUntil.set(id, Date.now() + 600_000);

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 429);

  kv.close();
});

// ─── Proxy: 503 no models in pool ───

Deno.test("integration: proxy 503 when model pool is empty", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await enableProxyPublicAccess(handler);

  await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-model-test" },
    }),
  );

  state.cachedModelPool = [];

  const res = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error, "没有可用的模型");

  kv.close();
});

// ─── Models: GET + PUT ───

Deno.test("integration: models GET and PUT", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const h = { "X-Admin-Token": token };

  const getRes = await handler(makeReq("GET", "/api/models", { headers: h }));
  assertEquals(getRes.status, 200);
  const getBody = await getRes.json();
  assertEquals(getBody.models, DEFAULT_MODEL_POOL);

  const putRes = await handler(
    makeReq("PUT", "/api/models", {
      headers: h,
      body: { models: ["test-model-a", "test-model-b"] },
    }),
  );
  assertEquals(putRes.status, 200);
  const putBody = await putRes.json();
  assertEquals(putBody.success, true);
  assertEquals(putBody.models, ["test-model-a", "test-model-b"]);

  const getRes2 = await handler(
    makeReq("GET", "/api/models", { headers: h }),
  );
  const getBody2 = await getRes2.json();
  assertEquals(getBody2.models, ["test-model-a", "test-model-b"]);

  const badPut = await handler(
    makeReq("PUT", "/api/models", {
      headers: h,
      body: { models: [] },
    }),
  );
  assertEquals(badPut.status, 400);

  kv.close();
});

Deno.test("integration: model availability errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-model-leak-test" },
    }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("POST", "/api/models/cached-model/test", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assertEquals(res.status, 200);
    assertEquals(body.success, false);
    assertEquals(body.status, "error");
    assertEquals(body.error, "模型测试失败");
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("integration: model catalog errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("GET", "/api/models/catalog", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();

    assertEquals(res.status, 502);
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("integration: stale model catalog errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  state.cachedModelCatalog = {
    source: "cerebras-public",
    fetchedAt: Date.now() - 7 * 60 * 60 * 1000,
    models: ["cached-model"],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("GET", "/api/models/catalog", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assertEquals(res.status, 200);
    assertEquals(body.stale, true);
    assertEquals(body.lastError, "获取模型目录时发生错误");
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("integration: stale catalog refresh errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  state.cachedModelCatalog = {
    source: "cerebras-public",
    fetchedAt: Date.now() - 7 * 60 * 60 * 1000,
    models: ["cached-model"],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("POST", "/api/models/catalog/refresh", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assertEquals(res.status, 200);
    assertEquals(body.stale, true);
    assertEquals(body.lastError, "刷新模型目录时发生错误");
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

Deno.test("integration: catalog refresh errors do not expose stack traces", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("database password leaked");
  };

  try {
    const res = await handler(
      makeReq("POST", "/api/models/catalog/refresh", {
        headers: { "X-Admin-Token": token },
      }),
    );
    const bodyText = await res.text();

    assertEquals(res.status, 502);
    assertEquals(bodyText.includes("database password leaked"), false);
    assertEquals(bodyText.includes("Error:"), false);
    assertEquals(bodyText.includes("at "), false);
  } finally {
    globalThis.fetch = originalFetch;
    kv.close();
  }
});

// ─── CORS: OPTIONS preflight ───

Deno.test("integration: OPTIONS returns correct CORS headers", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const proxyOpts = await handler(makeReq("OPTIONS", "/v1/chat/completions"));
  assertEquals(proxyOpts.status, 204);
  assertEquals(
    proxyOpts.headers.get("Access-Control-Allow-Origin"),
    CORS_HEADERS["Access-Control-Allow-Origin"],
  );
  assertEquals(
    proxyOpts.headers.get("Access-Control-Allow-Methods"),
    CORS_HEADERS["Access-Control-Allow-Methods"],
  );

  const adminOpts = await handler(makeReq("OPTIONS", "/api/keys"));
  assertEquals(adminOpts.status, 204);
  assertEquals(adminOpts.headers.has("Access-Control-Allow-Origin"), false);
  assertEquals(
    adminOpts.headers.get("Access-Control-Allow-Methods"),
    ADMIN_CORS_HEADERS["Access-Control-Allow-Methods"],
  );

  kv.close();
});

Deno.test("integration: admin JSON responses do not expose open CORS", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const setupRes = await handler(
    makeReq("POST", "/api/auth/setup", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "test1234" },
    }),
  );
  assertEquals(setupRes.headers.has("Access-Control-Allow-Origin"), false);

  const { token } = await setupRes.json();
  const statsRes = await handler(
    makeReq("GET", "/api/stats", { headers: { "X-Admin-Token": token } }),
  );
  assertEquals(statsRes.status, 200);
  assertEquals(statsRes.headers.has("Access-Control-Allow-Origin"), false);

  const modelsRes = await handler(makeReq("GET", "/v1/models"));
  assertEquals(modelsRes.status, 200);
  assertEquals(
    modelsRes.headers.get("Access-Control-Allow-Origin"),
    CORS_HEADERS["Access-Control-Allow-Origin"],
  );

  kv.close();
});

Deno.test("integration: unauthenticated root HTML contains no KV-derived stats", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);

  await handler(
    makeReq("POST", "/api/keys", {
      headers: { "X-Admin-Token": token },
      body: { key: "sk-root-stats" },
    }),
  );

  const res = await handler(makeReq("GET", "/"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, 'id="statTotalKeys">—</div>');
  assertStringIncludes(html, 'id="statActiveKeys">—</div>');
  assertStringIncludes(html, 'id="statTotalRequests">—</div>');
  assertStringIncludes(
    html,
    'id="authBadge" class="auth-badge auth-unknown">登录后加载</span>',
  );
  assertStringIncludes(html, 'id="keyCountLabel">—/');
  assertEquals(html.includes("sk-root-stats"), false);
  assertEquals(
    html.includes('id="authBadge" class="auth-badge auth-on"'),
    false,
  );
  assertEquals(
    html.includes('id="authBadge" class="auth-badge auth-off"'),
    false,
  );

  const statsRes = await handler(
    makeReq("GET", "/api/stats", { headers: { "X-Admin-Token": token } }),
  );
  const stats = await statsRes.json();
  assertEquals(stats.totalKeys, 1);
  assertEquals(stats.activeKeys, 1);

  kv.close();
});

// ─── Healthz ───

Deno.test("integration: GET /healthz returns 200", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(makeReq("GET", "/healthz"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");

  kv.close();
});

// ─── 404 ───

Deno.test("integration: unknown path returns 404", async () => {
  const kv = await setupKv();
  const handler = buildHandler();

  const res = await handler(makeReq("GET", "/nonexistent"));
  assertEquals(res.status, 404);

  kv.close();
});

// ─── Metrics ───

Deno.test("integration: /api/metrics returns counters (requires auth)", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const token = await setupAuth(handler);
  await handler(
    makeReq("PATCH", "/api/config", {
      headers: { "X-Admin-Token": token },
      body: { proxyPublicAccess: true },
    }),
  );

  const proxyRes = await handler(
    makeReq("POST", "/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
  );
  assertEquals(proxyRes.status, 500);

  const res = await handler(
    makeReq("GET", "/api/metrics", {
      headers: { "X-Admin-Token": token },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.proxy_requests_total.no_key, 1);

  const noAuth = await handler(makeReq("GET", "/api/metrics"));
  assertEquals(noAuth.status, 401);

  kv.close();
});
