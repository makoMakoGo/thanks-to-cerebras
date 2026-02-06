import { assertEquals } from "@std/assert";
import { state, AppState } from "../state.ts";
import { Router } from "../router.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { register as registerAuth } from "../handlers/auth.ts";
import { register as registerProxyKeys } from "../handlers/proxy-keys.ts";
import { register as registerApiKeys } from "../handlers/api-keys.ts";
import { register as registerConfig } from "../handlers/config.ts";
import { isAdminAuthorized } from "../auth.ts";
import { problemResponse } from "../http.ts";
import { loginLimiter } from "../rate-limit.ts";

const BASE = "http://localhost";

function buildRouter(): Router {
  const router = new Router();
  registerAuth(router);
  registerProxyKeys(router);
  registerApiKeys(router);
  registerConfig(router);
  return router;
}

async function dispatch(
  router: Router,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  if (
    path.startsWith("/api/") && !path.startsWith("/api/auth/")
  ) {
    const authReq = new Request(`${BASE}${path}`, { ...init });
    if (!(await isAdminAuthorized(authReq))) {
      return problemResponse("未登录", { status: 401, instance: path });
    }
  }

  const req = new Request(`${BASE}${path}`, init);
  const matched = router.match(method, req.url);
  if (!matched) return new Response("Not Found", { status: 404 });
  return matched.handler(req, matched.params);
}

async function setupKv(): Promise<Deno.Kv> {
  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
  }
  const kv = await Deno.openKv(":memory:");
  Object.assign(state, new AppState());
  state.kv = kv;
  await bootstrapCache();
  loginLimiter.reset();
  return kv;
}

// ─── Auth Flow ───

Deno.test("integration: auth setup → login → logout", async () => {
  const kv = await setupKv();
  const router = buildRouter();

  const status1 = await (await dispatch(router, "GET", "/api/auth/status"))
    .json();
  assertEquals(status1.hasPassword, false);
  assertEquals(status1.isLoggedIn, false);

  const setupRes = await dispatch(router, "POST", "/api/auth/setup", {
    body: { password: "test1234" },
  });
  assertEquals(setupRes.status, 200);
  const setupBody = await setupRes.json();
  assertEquals(setupBody.success, true);
  const token = setupBody.token;

  const status2 = await (
    await dispatch(router, "GET", "/api/auth/status", {
      headers: { "X-Admin-Token": token },
    })
  ).json();
  assertEquals(status2.isLoggedIn, true);

  const dupRes = await dispatch(router, "POST", "/api/auth/setup", {
    body: { password: "other" },
  });
  assertEquals(dupRes.status, 400);

  const loginRes = await dispatch(router, "POST", "/api/auth/login", {
    body: { password: "test1234" },
  });
  assertEquals(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assertEquals(loginBody.success, true);

  const badLogin = await dispatch(router, "POST", "/api/auth/login", {
    body: { password: "wrong" },
  });
  assertEquals(badLogin.status, 401);

  await dispatch(router, "POST", "/api/auth/logout", {
    headers: { "X-Admin-Token": token },
  });
  const status3 = await (
    await dispatch(router, "GET", "/api/auth/status", {
      headers: { "X-Admin-Token": token },
    })
  ).json();
  assertEquals(status3.isLoggedIn, false);

  kv.close();
});

// ─── Admin auth guard ───

Deno.test("integration: admin endpoints require auth", async () => {
  const kv = await setupKv();
  const router = buildRouter();

  const res = await dispatch(router, "GET", "/api/keys");
  assertEquals(res.status, 401);

  kv.close();
});

// ─── API Key CRUD ───

Deno.test("integration: API key add → list → delete", async () => {
  const kv = await setupKv();
  const router = buildRouter();

  await dispatch(router, "POST", "/api/auth/setup", {
    body: { password: "test1234" },
  });
  const loginRes = await dispatch(router, "POST", "/api/auth/login", {
    body: { password: "test1234" },
  });
  const { token } = await loginRes.json();
  const h = { "X-Admin-Token": token };

  const addRes = await dispatch(router, "POST", "/api/keys", {
    headers: h,
    body: { key: "sk-test-abc123" },
  });
  assertEquals(addRes.status, 201);
  const addBody = await addRes.json();
  assertEquals(addBody.success, true);
  const keyId = addBody.id;

  const dupRes = await dispatch(router, "POST", "/api/keys", {
    headers: h,
    body: { key: "sk-test-abc123" },
  });
  assertEquals(dupRes.status, 409);

  const listRes = await dispatch(router, "GET", "/api/keys", { headers: h });
  assertEquals(listRes.status, 200);
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 1);
  assertEquals(listBody.keys[0].id, keyId);

  const delRes = await dispatch(router, "DELETE", `/api/keys/${keyId}`, {
    headers: h,
  });
  assertEquals(delRes.status, 200);

  const listRes2 = await dispatch(router, "GET", "/api/keys", { headers: h });
  const listBody2 = await listRes2.json();
  assertEquals(listBody2.keys.length, 0);

  kv.close();
});

// ─── Proxy Key CRUD ───

Deno.test("integration: proxy key add → list → export → delete", async () => {
  const kv = await setupKv();
  const router = buildRouter();

  await dispatch(router, "POST", "/api/auth/setup", {
    body: { password: "test1234" },
  });
  const { token } = await (
    await dispatch(router, "POST", "/api/auth/login", {
      body: { password: "test1234" },
    })
  ).json();
  const h = { "X-Admin-Token": token };

  const addRes = await dispatch(router, "POST", "/api/proxy-keys", {
    headers: h,
    body: { name: "Test Key" },
  });
  assertEquals(addRes.status, 201);
  const addBody = await addRes.json();
  assertEquals(addBody.success, true);
  const pkId = addBody.id;
  const rawKey = addBody.key;

  const listRes = await dispatch(router, "GET", "/api/proxy-keys", {
    headers: h,
  });
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 1);
  assertEquals(listBody.keys[0].name, "Test Key");

  const exportRes = await dispatch(
    router,
    "GET",
    `/api/proxy-keys/${pkId}/export`,
    { headers: h },
  );
  const exportBody = await exportRes.json();
  assertEquals(exportBody.key, rawKey);

  const delRes = await dispatch(router, "DELETE", `/api/proxy-keys/${pkId}`, {
    headers: h,
  });
  assertEquals(delRes.status, 200);

  const listRes2 = await dispatch(router, "GET", "/api/proxy-keys", {
    headers: h,
  });
  const listBody2 = await listRes2.json();
  assertEquals(listBody2.keys.length, 0);

  kv.close();
});

// ─── Config ───

Deno.test("integration: config get → update", async () => {
  const kv = await setupKv();
  const router = buildRouter();

  await dispatch(router, "POST", "/api/auth/setup", {
    body: { password: "test1234" },
  });
  const { token } = await (
    await dispatch(router, "POST", "/api/auth/login", {
      body: { password: "test1234" },
    })
  ).json();
  const h = { "X-Admin-Token": token };

  const getRes = await dispatch(router, "GET", "/api/config", { headers: h });
  assertEquals(getRes.status, 200);
  const getBody = await getRes.json();
  assertEquals(typeof getBody.kvFlushIntervalMs, "number");
  assertEquals(typeof getBody.totalRequests, "number");

  const updateRes = await dispatch(router, "PATCH", "/api/config", {
    headers: h,
    body: { kvFlushIntervalMs: 5000 },
  });
  assertEquals(updateRes.status, 200);
  const updateBody = await updateRes.json();
  assertEquals(updateBody.success, true);
  assertEquals(updateBody.kvFlushIntervalMs, 5000);

  if (state.kvFlushTimerId !== null) {
    clearInterval(state.kvFlushTimerId);
    state.kvFlushTimerId = null;
  }

  kv.close();
});

// ─── Stats ───

Deno.test("integration: stats endpoint", async () => {
  const kv = await setupKv();
  const router = buildRouter();

  await dispatch(router, "POST", "/api/auth/setup", {
    body: { password: "test1234" },
  });
  const { token } = await (
    await dispatch(router, "POST", "/api/auth/login", {
      body: { password: "test1234" },
    })
  ).json();
  const h = { "X-Admin-Token": token };

  await dispatch(router, "POST", "/api/keys", {
    headers: h,
    body: { key: "sk-stat-test" },
  });

  const statsRes = await dispatch(router, "GET", "/api/stats", { headers: h });
  assertEquals(statsRes.status, 200);
  const statsBody = await statsRes.json();
  assertEquals(statsBody.totalKeys, 1);
  assertEquals(statsBody.activeKeys, 1);

  kv.close();
});

// ─── Batch import ───

Deno.test("integration: batch import API keys", async () => {
  const kv = await setupKv();
  const router = buildRouter();

  await dispatch(router, "POST", "/api/auth/setup", {
    body: { password: "test1234" },
  });
  const { token } = await (
    await dispatch(router, "POST", "/api/auth/login", {
      body: { password: "test1234" },
    })
  ).json();
  const h = { "X-Admin-Token": token };

  const batchRes = await dispatch(router, "POST", "/api/keys/batch", {
    headers: h,
    body: { input: "sk-batch-1\nsk-batch-2\nsk-batch-3" },
  });
  assertEquals(batchRes.status, 200);
  const batchBody = await batchRes.json();
  assertEquals(batchBody.summary.total, 3);
  assertEquals(batchBody.summary.success, 3);
  assertEquals(batchBody.summary.failed, 0);

  const listRes = await dispatch(router, "GET", "/api/keys", { headers: h });
  const listBody = await listRes.json();
  assertEquals(listBody.keys.length, 3);

  kv.close();
});
