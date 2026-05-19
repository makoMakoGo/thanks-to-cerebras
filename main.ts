import { isDenoDeployment, state } from "./src/state.ts";
import {
  applyKvFlushInterval,
  bootstrapCache,
  flushDirtyToKv,
} from "./src/kv/flush.ts";
import { resolvePort } from "./src/utils.ts";
import { createHandler, createRouter } from "./src/app.ts";
import { assertKeyEncryptionSecretConfigured } from "./src/secrets.ts";
import { logger } from "./src/logger.ts";

if (import.meta.main) {
  const router = createRouter();
  const handler = createHandler(router);

  logger.info("server_starting", {
    adminPath: "/",
    proxyPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    storage: "Deno KV",
  });

  assertKeyEncryptionSecretConfigured();

  await state.initKv();
  await bootstrapCache();
  applyKvFlushInterval(state.cachedConfig);

  if (!isDenoDeployment()) {
    const FLUSH_TIMEOUT_MS = 5000;

    const shutdown = async (signal: string) => {
      logger.info("shutdown_started", { signal });
      try {
        await Promise.race([
          flushDirtyToKv(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("flush timeout")),
              FLUSH_TIMEOUT_MS,
            )
          ),
        ]);
        logger.info("shutdown_flush_complete", { signal });
      } catch (e) {
        logger.error("shutdown_flush_failed", { signal }, e);
      }
      Deno.exit(0);
    };

    try {
      Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
      Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
    } catch {
      // signal listeners not supported on this platform
    }
  }

  if (isDenoDeployment()) {
    Deno.serve(handler);
  } else {
    const port = resolvePort(Deno.env.get("PORT"), 8339);
    Deno.serve({ port }, handler);
  }
}
