/**
 * Integration tests for the SETUP_TOKEN-guarded password reset endpoint.
 *
 * Kept as a separate file to leave the main integration_test.ts under the
 * large-file gate while still exercising the full request pipeline.
 */

import { assertEquals, assertMatch } from "@std/assert";
import { AppState, state } from "../state.ts";
import { createHandler, createRouter } from "../app.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { metrics } from "../metrics.ts";
import { setLogSinkForTests } from "../logger.ts";

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

Deno.test("integration: reset-password rotates password and revokes all sessions", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  const oldToken = await setupAuth(handler);

  // Old token is currently valid.
  const before = await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": oldToken },
    }),
  );
  assertEquals((await before.json()).isLoggedIn, true);

  const resetRes = await handler(
    makeReq("POST", "/api/auth/reset-password", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "brand-new-secret" },
    }),
  );
  assertEquals(resetRes.status, 200);
  const resetBody = await resetRes.json();
  assertEquals(resetBody.success, true);
  assertMatch(resetBody.token, /^[0-9a-f-]{36}$/);

  // Old token must be revoked.
  const after = await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": oldToken },
    }),
  );
  assertEquals((await after.json()).isLoggedIn, false);

  // The fresh token returned by reset must work immediately.
  const usable = await handler(
    makeReq("GET", "/api/auth/status", {
      headers: { "X-Admin-Token": resetBody.token },
    }),
  );
  assertEquals((await usable.json()).isLoggedIn, true);

  // Old password no longer works.
  const oldLogin = await handler(
    makeReq("POST", "/api/auth/login", { body: { password: "test1234" } }),
  );
  assertEquals(oldLogin.status, 401);

  // New password works.
  const newLogin = await handler(
    makeReq("POST", "/api/auth/login", {
      body: { password: "brand-new-secret" },
    }),
  );
  assertEquals(newLogin.status, 200);

  kv.close();
});

Deno.test("integration: reset-password requires JSON, SETUP_TOKEN env and matching header", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await setupAuth(handler);

  // Wrong Content-Type.
  const wrongType = await handler(
    new Request(`${BASE}/api/auth/reset-password`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Setup-Token": "test-setup-token",
      },
      body: JSON.stringify({ password: "brand-new-secret" }),
    }),
  );
  assertEquals(wrongType.status, 415);

  // SETUP_TOKEN env unset.
  Deno.env.delete("SETUP_TOKEN");
  const missingEnv = await handler(
    makeReq("POST", "/api/auth/reset-password", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "brand-new-secret" },
    }),
  );
  assertEquals(missingEnv.status, 503);
  Deno.env.set("SETUP_TOKEN", "test-setup-token");

  // Missing X-Setup-Token header.
  const missingHeader = await handler(
    makeReq("POST", "/api/auth/reset-password", {
      body: { password: "brand-new-secret" },
    }),
  );
  assertEquals(missingHeader.status, 403);

  // Wrong X-Setup-Token header.
  const wrongHeader = await handler(
    makeReq("POST", "/api/auth/reset-password", {
      headers: { "X-Setup-Token": "wrong-token" },
      body: { password: "brand-new-secret" },
    }),
  );
  assertEquals(wrongHeader.status, 403);

  kv.close();
});

Deno.test("integration: reset-password rejects passwords shorter than 8", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await setupAuth(handler);

  const tooShort = await handler(
    makeReq("POST", "/api/auth/reset-password", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "short7c" },
    }),
  );
  assertEquals(tooShort.status, 400);

  // Wrong type for password.
  const wrongType = await handler(
    makeReq("POST", "/api/auth/reset-password", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: 12345678 },
    }),
  );
  assertEquals(wrongType.status, 400);

  kv.close();
});

Deno.test("integration: reset-password wrong-token requests do not consume rate-limit bucket", async () => {
  const kv = await setupKv();
  const handler = buildHandler();
  await setupAuth(handler);

  // Saturate the global admin-auth bucket (5 / 60s) with bogus
  // X-Setup-Token requests. Cheap-checks-before-rate-limit ordering
  // keeps these out of the bucket so the legitimate reset still succeeds.
  for (let i = 0; i < 20; i++) {
    const res = await handler(
      makeReq("POST", "/api/auth/reset-password", {
        headers: { "X-Setup-Token": `bogus-${i}` },
        body: { password: "brand-new-secret" },
      }),
    );
    assertEquals(res.status, 403);
  }

  const resetRes = await handler(
    makeReq("POST", "/api/auth/reset-password", {
      headers: { "X-Setup-Token": "test-setup-token" },
      body: { password: "brand-new-secret" },
    }),
  );
  assertEquals(resetRes.status, 200);

  kv.close();
});
