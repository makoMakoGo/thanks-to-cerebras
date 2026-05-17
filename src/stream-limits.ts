import {
  KV_ATOMIC_MAX_RETRIES,
  KV_PREFIX,
  MAX_PROXY_RESPONSE_BODY_BYTES,
  PROXY_GLOBAL_STREAM_CONCURRENCY_MAX,
  PROXY_KEY_STREAM_CONCURRENCY_MAX,
  PROXY_STREAM_IDLE_TIMEOUT_MS,
  PROXY_STREAM_SLOT_LEASE_MS,
  PROXY_STREAM_TOTAL_TIMEOUT_MS,
} from "./constants.ts";
import { metrics } from "./metrics.ts";
import { state } from "./state.ts";

const STREAM_PREFIX = [KV_PREFIX, "stream"] as const;
const GLOBAL_STREAM_KEY = "global";
const PUBLIC_STREAM_KEY = "public";

type StreamRelease = () => Promise<void>;

interface StreamCounter {
  count: number;
}

export interface ProxyStreamLimits {
  maxBytes: number;
  totalTimeoutMs: number;
  idleTimeoutMs: number;
}

const DEFAULT_PROXY_STREAM_LIMITS: ProxyStreamLimits = {
  maxBytes: MAX_PROXY_RESPONSE_BODY_BYTES,
  totalTimeoutMs: PROXY_STREAM_TOTAL_TIMEOUT_MS,
  idleTimeoutMs: PROXY_STREAM_IDLE_TIMEOUT_MS,
};

export interface StreamConcurrencyResult {
  acquired: boolean;
  retryAfterSec?: number;
  release?: StreamRelease;
}

interface StreamSlot {
  namespace: string;
  bucket: string;
  limit: number;
}

function streamKey(namespace: string, bucket: string): string[] {
  return [...STREAM_PREFIX, namespace, bucket];
}

async function acquireSlot(slot: StreamSlot): Promise<StreamConcurrencyResult> {
  const key = streamKey(slot.namespace, slot.bucket);
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const entry = await state.kv.get<StreamCounter>(key);
    const current = entry.value?.count ?? 0;
    if (current >= slot.limit) {
      return {
        acquired: false,
        retryAfterSec: Math.ceil(PROXY_STREAM_SLOT_LEASE_MS / 1000),
      };
    }

    const next = { count: current + 1 };
    const result = await state.kv.atomic()
      .check(entry)
      .set(key, next, { expireIn: PROXY_STREAM_SLOT_LEASE_MS })
      .commit();
    if (result.ok) {
      let released = false;
      return {
        acquired: true,
        release: async () => {
          if (released) return;
          released = true;
          await releaseSlot(key);
        },
      };
    }
  }

  throw new Error("KV stream concurrency update failed after retries");
}

async function releaseSlot(key: string[]): Promise<void> {
  for (let attempt = 0; attempt < KV_ATOMIC_MAX_RETRIES; attempt++) {
    const entry = await state.kv.get<StreamCounter>(key);
    if (!entry.value || entry.value.count <= 1) {
      const result = await state.kv.atomic()
        .check(entry)
        .delete(key)
        .commit();
      if (result.ok) return;
      continue;
    }

    const result = await state.kv.atomic()
      .check(entry)
      .set(key, { count: entry.value.count - 1 }, {
        expireIn: PROXY_STREAM_SLOT_LEASE_MS,
      })
      .commit();
    if (result.ok) return;
  }

  throw new Error("KV stream concurrency release failed after retries");
}

export async function acquireProxyStreamSlots(
  proxyKeyId: string | undefined,
): Promise<StreamConcurrencyResult> {
  const keyBucket = proxyKeyId ?? PUBLIC_STREAM_KEY;
  const global = await acquireSlot({
    namespace: "global",
    bucket: GLOBAL_STREAM_KEY,
    limit: PROXY_GLOBAL_STREAM_CONCURRENCY_MAX,
  });
  if (!global.acquired) return global;
  if (!global.release) throw new Error("Global stream slot release missing");

  const key = await acquireSlot({
    namespace: "proxy-key",
    bucket: keyBucket,
    limit: PROXY_KEY_STREAM_CONCURRENCY_MAX,
  });
  if (!key.acquired) {
    await global.release();
    return key;
  }
  if (!key.release) throw new Error("Proxy stream slot release missing");

  let released = false;
  return {
    acquired: true,
    release: async () => {
      if (released) return;
      released = true;
      await Promise.all([key.release!(), global.release!()]);
    },
  };
}

export function boundProxyResponseBody(
  body: ReadableStream<Uint8Array>,
  release: StreamRelease,
  limits: ProxyStreamLimits = DEFAULT_PROXY_STREAM_LIMITS,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let totalBytes = 0;
  let finished = false;
  let idleTimer: number | undefined;
  let totalTimer: number | undefined;
  let releasePromise: Promise<void> | null = null;

  function scheduleIdle(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void fail(
        controller,
        "upstream stream idle timeout",
        "stream_idle_timeout",
      );
    }, limits.idleTimeoutMs);
  }

  function clearTimers() {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
  }

  function releaseOnce(): Promise<void> {
    if (releasePromise) return releasePromise;
    clearTimers();
    releasePromise = release();
    return releasePromise;
  }

  function finish(): Promise<void> {
    if (finished) return releaseOnce();
    finished = true;
    return releaseOnce();
  }

  async function fail(
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: string,
    metricLabel: string,
  ): Promise<void> {
    finished = true;
    clearTimers();
    metrics.inc("proxy_requests_total", metricLabel);
    controller.error(new Error(message));
    try {
      await reader.cancel(message);
    } finally {
      await releaseOnce();
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      totalTimer = setTimeout(() => {
        void fail(
          controller,
          "upstream stream total timeout",
          "stream_total_timeout",
        );
      }, limits.totalTimeoutMs);
      scheduleIdle(controller);
    },
    async pull(controller) {
      if (finished) return;
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          await finish();
          controller.close();
          return;
        }

        totalBytes += value.byteLength;
        if (totalBytes > limits.maxBytes) {
          await fail(
            controller,
            "upstream stream body too large",
            "stream_too_large",
          );
          return;
        }

        controller.enqueue(value);
        scheduleIdle(controller);
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await finish();
    },
  });
}

export async function resetProxyStreamCountersForTests(): Promise<void> {
  const iter = state.kv.list({ prefix: STREAM_PREFIX });
  const deletes: Promise<void>[] = [];
  for await (const entry of iter) {
    deletes.push(state.kv.delete(entry.key));
  }
  await Promise.all(deletes);
}
