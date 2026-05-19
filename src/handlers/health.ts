import { jsonResponse } from "../http.ts";
import { kvGetConfig } from "../kv/config.ts";
import { state } from "../state.ts";
import type { Router } from "../router.ts";

type ReadinessChecks = {
  keyEncryptionSecret: boolean;
  kv: boolean;
  config: boolean;
};

function getHealthz(): Response {
  return new Response("ok", { status: 200 });
}

async function getReadyz(): Promise<Response> {
  const checks: ReadinessChecks = {
    keyEncryptionSecret: Boolean(Deno.env.get("KEY_ENCRYPTION_SECRET")?.trim()),
    kv: Boolean(state.kv),
    config: false,
  };

  if (checks.kv) {
    try {
      await kvGetConfig();
      checks.config = true;
    } catch {
      checks.config = false;
    }
  }

  const ready = Object.values(checks).every(Boolean);
  return jsonResponse({ ready, checks }, {
    status: ready ? 200 : 503,
    cors: "admin",
  });
}

export function register(router: Router): void {
  router
    .get("/healthz", getHealthz)
    .get("/readyz", getReadyz);
}
