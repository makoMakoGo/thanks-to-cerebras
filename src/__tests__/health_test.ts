import { assertEquals } from "@std/assert";
import { createHandler, createRouter } from "../app.ts";
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

function makeReq(path: string): Request {
  return new Request(`${BASE}${path}`);
}

Deno.test("health: GET /readyz returns ready when KV and secrets are configured", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());

  try {
    const res = await handler(makeReq("/readyz"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ready, true);
    assertEquals(body.checks.keyEncryptionSecret, true);
    assertEquals(body.checks.kv, true);
    assertEquals(body.checks.config, true);
  } finally {
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test("health: GET /readyz returns 503 when KV is unavailable", async () => {
  const kv = await setupKv();
  const handler = createHandler(createRouter());
  const originalKv = state.kv;
  state.kv = undefined as unknown as Deno.Kv;

  try {
    const res = await handler(makeReq("/readyz"));
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.ready, false);
    assertEquals(body.checks.kv, false);
    assertEquals(body.checks.config, false);
  } finally {
    state.kv = originalKv;
    setLogSinkForTests(null);
    kv.close();
  }
});
