import { isDenoDeployment, state } from "./src/state.ts";
import {
  applyKvFlushInterval,
  bootstrapCache,
  flushDirtyToKv,
} from "./src/kv/flush.ts";
import { resolvePort } from "./src/utils.ts";
import { createHandler, createRouter } from "./src/app.ts";
import { assertKeyEncryptionSecretConfigured } from "./src/secrets.ts";

if (import.meta.main) {
  const router = createRouter();
  const handler = createHandler(router);

  // ================================
  // 启动服务器
  // ================================
  console.log(`Cerebras Proxy 启动`);
  console.log(`- 管理面板: /`);
  console.log(`- API 代理: /v1/chat/completions`);
  console.log(`- 模型接口: /v1/models`);
  console.log(`- 存储: Deno KV`);

  assertKeyEncryptionSecretConfigured();

  await state.initKv();
  await bootstrapCache();
  applyKvFlushInterval(state.cachedConfig);

  if (!isDenoDeployment()) {
    const FLUSH_TIMEOUT_MS = 5000;

    const shutdown = async (signal: string) => {
      console.log(`\n[SHUTDOWN] ${signal} received, flushing dirty data...`);
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
        console.log("[SHUTDOWN] flush complete.");
      } catch (e) {
        console.error("[SHUTDOWN] flush failed:", e);
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
