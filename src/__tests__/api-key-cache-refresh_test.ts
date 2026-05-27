/**
 * Regression tests for issue #138: refreshApiKeyCacheRevision must not
 * cascade KV failures into per-request 500 responses, and must not turn
 * the throttle window into a per-request KV retry loop.
 */

import { assertEquals } from "@std/assert";
import {
  API_KEY_CACHE_REVISION_KEY,
  API_KEY_PREFIX,
  CEREBRAS_API_URL,
  PROXY_KEY_AUTH_REFRESH_INTERVAL_MS,
} from "../constants.ts";
import { encryptApiKey } from "../secrets.ts";
import { createHandler, createRouter } from "../app.ts";
import {
  rebuildActiveKeyIds,
  refreshApiKeyCacheIfChanged,
} from "../api-keys.ts";
import { bootstrapCache } from "../kv/flush.ts";
import { metrics } from "../metrics.ts";
import { resetKvRateLimitsForTests } from "../rate-limit.ts";
import { resetProxyStreamCountersForTests } from "../stream-limits.ts";
import { AppState, state } from "../state.ts";
import { setLogSinkForTests } from "../logger.ts";

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

function isRevisionKey(key: Deno.KvKey): boolean {
  if (key.length !== API_KEY_CACHE_REVISION_KEY.length) return false;
  for (let i = 0; i < key.length; i++) {
    if (key[i] !== API_KEY_CACHE_REVISION_KEY[i]) return false;
  }
  return true;
}

/**
 * Wraps state.kv so reads of API_KEY_CACHE_REVISION_KEY reject with the
 * provided error, while every other KV operation passes through unchanged.
 * Returns a function that restores the original state.kv and the count of
 * intercepted reads.
 *
 * Note: Deno.Kv methods access private slots, so the Proxy must rebind
 * methods to the underlying target rather than letting them run with the
 * Proxy as the receiver.
 */
function failRevisionReadsOnly(error: Error): {
  restore: () => void;
  callCount: () => number;
} {
  const original = state.kv;
  let count = 0;
  const proxy = new Proxy(original, {
    get(target, prop, _receiver) {
      if (prop === "get") {
        return (key: Deno.KvKey, ...rest: unknown[]) => {
          if (isRevisionKey(key)) {
            count++;
            return Promise.reject(error);
          }
          return (target.get as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>).call(target, key, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Deno.Kv;
  state.kv = proxy;
  return {
    restore: () => {
      state.kv = original;
    },
    callCount: () => count,
  };
}

function isApiKeyPrefixSelector(selector: Deno.KvListSelector): boolean {
  if (!("prefix" in selector)) return false;
  const prefix = selector.prefix;
  if (!Array.isArray(prefix) || prefix.length !== API_KEY_PREFIX.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== API_KEY_PREFIX[i]) return false;
  }
  return true;
}

/**
 * Same idea as failRevisionReadsOnly but for state.kv.list when called with
 * the api-keys prefix — i.e. the path kvMergeAllApiKeysIntoCache takes.
 * Lets us exercise the merge-phase failure path independently from the
 * revision-read path.
 */
function failApiKeyListOnly(error: Error): {
  restore: () => void;
  callCount: () => number;
} {
  const original = state.kv;
  let count = 0;
  const proxy = new Proxy(original, {
    get(target, prop, _receiver) {
      if (prop === "list") {
        return (selector: Deno.KvListSelector, ...rest: unknown[]) => {
          if (isApiKeyPrefixSelector(selector)) {
            count++;
            throw error;
          }
          return (target.list as unknown as (
            ...args: unknown[]
          ) => unknown).call(target, selector, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Deno.Kv;
  state.kv = proxy;
  return {
    restore: () => {
      state.kv = original;
    },
    callCount: () => count,
  };
}

interface CapturedLog {
  level: string;
  record: Record<string, unknown>;
}

/**
 * Replaces the logger sink with one that collects every emitted line as a
 * parsed JSON record. Returned `restore()` puts the default sink back.
 */
function captureLogs(): { records: CapturedLog[]; restore: () => void } {
  const records: CapturedLog[] = [];
  setLogSinkForTests((level, line) => {
    records.push({ level, record: JSON.parse(line) });
  });
  return {
    records,
    restore: () => setLogSinkForTests(null),
  };
}

Deno.test(
  "refreshApiKeyCacheIfChanged: persistent KV failure does not throw",
  async () => {
    const kv = await setupKv();
    await addActiveApiKey("sk-test-cache");
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    try {
      // Force the throttle to be expired so the next call hits KV.
      state.apiKeyCacheRevisionLastCheckedAt = 0;

      // Multiple sequential calls must all complete without bubbling errors.
      for (let i = 0; i < 5; i++) {
        await refreshApiKeyCacheIfChanged();
      }

      // The cache must still serve the previously loaded key.
      assertEquals(state.cachedActiveKeyIds.length, 1);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "refreshApiKeyCacheIfChanged: throttle prevents per-request KV retries",
  async () => {
    const kv = await setupKv();
    await addActiveApiKey("sk-test-throttle");
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    try {
      state.apiKeyCacheRevisionLastCheckedAt = 0;

      // Burst of refresh attempts: the first one bumps the throttle clock,
      // every subsequent one within the throttle window must short-circuit
      // before reaching KV.
      for (let i = 0; i < 100; i++) {
        await refreshApiKeyCacheIfChanged();
      }

      assertEquals(fail.callCount(), 1);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "refreshApiKeyCacheIfChanged: concurrent failing refreshes share one KV read",
  async () => {
    const kv = await setupKv();
    await addActiveApiKey("sk-test-concurrent");
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    try {
      state.apiKeyCacheRevisionLastCheckedAt = 0;

      // 50 concurrent calls: existing in-flight dedup should collapse them
      // into a single underlying KV read, and none should throw.
      await Promise.all(
        Array.from({ length: 50 }, () => refreshApiKeyCacheIfChanged()),
      );

      assertEquals(fail.callCount(), 1);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "refreshApiKeyCacheIfChanged: throttle re-arms after the window elapses",
  async () => {
    const kv = await setupKv();
    await addActiveApiKey("sk-test-rearm");
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    try {
      state.apiKeyCacheRevisionLastCheckedAt = 0;
      await refreshApiKeyCacheIfChanged();
      assertEquals(fail.callCount(), 1);

      // Simulate the throttle window having passed without changing wall
      // clock: pretend the last successful check was long ago.
      state.apiKeyCacheRevisionLastCheckedAt = Date.now() -
        PROXY_KEY_AUTH_REFRESH_INTERVAL_MS - 1;

      await refreshApiKeyCacheIfChanged();
      assertEquals(fail.callCount(), 2);

      // And it must throttle again afterwards.
      await refreshApiKeyCacheIfChanged();
      assertEquals(fail.callCount(), 2);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "proxy request still 200 when KV revision read fails (cache served)",
  async () => {
    const kv = await setupKv();
    const handler = createHandler(createRouter());
    state.cachedConfig = { ...state.cachedConfig!, proxyPublicAccess: true };
    await addActiveApiKey("sk-upstream-cache-fallback");

    const fail = failRevisionReadsOnly(new Error("kv outage"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
      assertEquals(String(input), CEREBRAS_API_URL);
      return Promise.resolve(
        new Response(JSON.stringify({ id: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    try {
      // Force a refresh attempt on the next proxy request.
      state.apiKeyCacheRevisionLastCheckedAt = 0;

      const res = await handler(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        }),
      );

      // Without the fix, the rejected revision read propagates to the
      // handler and the client sees a 500. With the fix the proxy serves
      // the request from its existing cache and returns 200.
      assertEquals(res.status, 200);
      await res.body?.cancel();

      // The KV outage should have been observed exactly once on this path.
      assertEquals(fail.callCount(), 1);
    } finally {
      globalThis.fetch = originalFetch;
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test("recovery: refresh resumes after transient KV list failure", async () => {
  const kv = await setupKv();
  await addActiveApiKey("sk-retry-secret");
  const [apiKeyId] = state.cachedActiveKeyIds;

  await kv.delete([...API_KEY_PREFIX, apiKeyId]);
  await kv.set(API_KEY_CACHE_REVISION_KEY, Date.now());
  state.apiKeyCacheRevision = 0;
  state.apiKeyCacheRevisionLastCheckedAt = 0;

  const originalList = state.kv.list.bind(state.kv);
  let failed = false;
  state.kv.list = ((
    selector: Deno.KvListSelector,
    options?: Deno.KvListOptions,
  ) => {
    if (!failed) {
      failed = true;
      throw new Error("transient list failure");
    }
    return originalList(selector, options);
  }) as typeof state.kv.list;

  try {
    // First refresh: kvMergeAllApiKeysIntoCache rejects via state.kv.list.
    // Per the #138 fix the error is swallowed; the in-memory revision is
    // not advanced and the cache is left intact — the proxy keeps serving
    // from the previously loaded keys.
    await refreshApiKeyCacheIfChanged();
    assertEquals(state.apiKeyCacheRevision, 0);
    assertEquals(state.cachedKeysById.has(apiKeyId), true);

    state.kv.list = originalList;

    // After the throttle window resets, the next refresh sees a healthy
    // KV, merges successfully and finally evicts the deleted key.
    state.apiKeyCacheRevisionLastCheckedAt = 0;
    await refreshApiKeyCacheIfChanged();
    assertEquals(state.cachedKeysById.has(apiKeyId), false);
  } finally {
    state.kv.list = originalList;
    setLogSinkForTests(null);
    kv.close();
  }
});

Deno.test(
  "refreshApiKeyCacheIfChanged: throttle prevents per-request KV merge retries",
  async () => {
    const kv = await setupKv();
    await addActiveApiKey("sk-test-list-throttle");

    // Force the in-memory revision to lag behind KV so refresh proceeds
    // past getApiKeyCacheRevision() into kvMergeAllApiKeysIntoCache(),
    // where state.kv.list() is invoked. Without this, refresh would
    // short-circuit at the revision-equality check and never reach the
    // merge path we want to exercise.
    await state.kv.set(API_KEY_CACHE_REVISION_KEY, Date.now());
    state.apiKeyCacheRevision = 0;
    state.apiKeyCacheRevisionLastCheckedAt = 0;

    const fail = failApiKeyListOnly(new Error("kv list outage"));

    try {
      // Burst of refresh attempts. The first one fails inside merge, but
      // because the throttle clock was bumped before the KV call, every
      // subsequent attempt within the throttle window must short-circuit
      // before re-entering merge — preventing the per-request retry storm
      // that issue #138 describes.
      for (let i = 0; i < 100; i++) {
        await refreshApiKeyCacheIfChanged();
      }

      assertEquals(fail.callCount(), 1);
    } finally {
      fail.restore();
      setLogSinkForTests(null);
      kv.close();
    }
  },
);

Deno.test(
  "refreshApiKeyCacheIfChanged: revision read failure logs phase=revision_read",
  async () => {
    const kv = await setupKv();
    await addActiveApiKey("sk-test-log-revision");

    const logs = captureLogs();
    const fail = failRevisionReadsOnly(new Error("kv outage"));

    try {
      state.apiKeyCacheRevisionLastCheckedAt = 0;
      await refreshApiKeyCacheIfChanged();

      const warns = logs.records.filter(
        (r) =>
          r.level === "warn" &&
          r.record.event === "api_key_cache_refresh_failed",
      );
      assertEquals(warns.length, 1);
      assertEquals(warns[0].record.phase, "revision_read");
      assertEquals(warns[0].record.errorMessage, "kv outage");
    } finally {
      fail.restore();
      logs.restore();
      kv.close();
    }
  },
);

Deno.test(
  "refreshApiKeyCacheIfChanged: merge failure logs phase=merge_keys",
  async () => {
    const kv = await setupKv();
    await addActiveApiKey("sk-test-log-merge");

    // Same setup as the merge-throttle test: bump revision so refresh
    // proceeds into the merge phase.
    await state.kv.set(API_KEY_CACHE_REVISION_KEY, Date.now());
    state.apiKeyCacheRevision = 0;
    state.apiKeyCacheRevisionLastCheckedAt = 0;

    const logs = captureLogs();
    const fail = failApiKeyListOnly(new Error("kv list outage"));

    try {
      await refreshApiKeyCacheIfChanged();

      const warns = logs.records.filter(
        (r) =>
          r.level === "warn" &&
          r.record.event === "api_key_cache_refresh_failed",
      );
      assertEquals(warns.length, 1);
      assertEquals(warns[0].record.phase, "merge_keys");
      assertEquals(warns[0].record.errorMessage, "kv list outage");
    } finally {
      fail.restore();
      logs.restore();
      kv.close();
    }
  },
);
