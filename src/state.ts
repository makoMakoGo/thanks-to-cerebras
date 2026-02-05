import type {
  ApiKey,
  ModelCatalog,
  ProxyAuthKey,
  ProxyConfig,
} from "./types.ts";
import { DEFAULT_KV_FLUSH_INTERVAL_MS } from "./constants.ts";

// Deno KV instance
export const isDenoDeployment = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));

function assertKvSupported(): void {
  const openKv = (Deno as unknown as { openKv?: unknown }).openKv;
  if (typeof openKv === "function") return;

  const message = [
    "[KV] Deno.openKv 不可用：需要启用 Deno KV（unstable）。",
    "",
    "可选修复：",
    '- 本地运行：使用 `--unstable-kv`，或在 `deno.json` 里添加 `"unstable": ["kv"]`',
    "- Deno Deploy：请使用 Git 部署并确保仓库根目录的 `deno.json` 被加载（本仓库已内置），必要时在 Build Config 启用 KV/unstable",
    "",
    "当前运行时给的报错：`Deno.openKv is not a function`",
  ].join("\n");

  throw new Error(message);
}

export const kv = await (() => {
  assertKvSupported();
  if (isDenoDeployment) return Deno.openKv();
  const kvDir = Deno.env.get("KV_PATH") ||
    `${import.meta.dirname}/.deno-kv-local`;
  try {
    Deno.mkdirSync(kvDir, { recursive: true });
  } catch (e) {
    if (
      e instanceof Deno.errors.AlreadyExists ||
      (typeof e === "object" && e !== null && "name" in e &&
        (e as { name?: string }).name === "AlreadyExists")
    ) {
      // Directory already exists
    } else {
      console.error("[KV] 无法创建本地 KV 目录：", e);
      throw e;
    }
  }
  return Deno.openKv(`${kvDir}/kv.sqlite3`);
})();

// Config cache
export let cachedConfig: ProxyConfig | null = null;
export function setCachedConfig(config: ProxyConfig | null): void {
  cachedConfig = config;
}

// API key caches
export let cachedKeysById = new Map<string, ApiKey>();
export function setCachedKeysById(keys: Map<string, ApiKey>): void {
  cachedKeysById = keys;
}

export let cachedActiveKeyIds: string[] = [];
export function setCachedActiveKeyIds(ids: string[]): void {
  cachedActiveKeyIds = ids;
}

export let cachedCursor = 0;
export function setCachedCursor(cursor: number): void {
  cachedCursor = cursor;
}

export const keyCooldownUntil = new Map<string, number>();
export const dirtyKeyIds = new Set<string>();

export let dirtyConfig = false;
export function setDirtyConfig(dirty: boolean): void {
  dirtyConfig = dirty;
}

export let flushInProgress = false;
export function setFlushInProgress(inProgress: boolean): void {
  flushInProgress = inProgress;
}

// Model pool cache
export let cachedModelPool: string[] = [];
export function setCachedModelPool(pool: string[]): void {
  cachedModelPool = pool;
}

export let modelCursor = 0;
export function setModelCursor(cursor: number): void {
  modelCursor = cursor;
}

// Model catalog cache
export let cachedModelCatalog: ModelCatalog | null = null;
export function setCachedModelCatalog(catalog: ModelCatalog | null): void {
  cachedModelCatalog = catalog;
}

export let modelCatalogFetchInFlight: Promise<ModelCatalog> | null = null;
export function setModelCatalogFetchInFlight(
  promise: Promise<ModelCatalog> | null,
): void {
  modelCatalogFetchInFlight = promise;
}

// Proxy auth key cache
export let cachedProxyKeys = new Map<string, ProxyAuthKey>();
export function setCachedProxyKeys(keys: Map<string, ProxyAuthKey>): void {
  cachedProxyKeys = keys;
}

export const dirtyProxyKeyIds = new Set<string>();

// KV flush timer
export let kvFlushTimerId: number | null = null;
export function setKvFlushTimerId(id: number | null): void {
  kvFlushTimerId = id;
}

export let kvFlushIntervalMsEffective = DEFAULT_KV_FLUSH_INTERVAL_MS;
export function setKvFlushIntervalMsEffective(ms: number): void {
  kvFlushIntervalMsEffective = ms;
}

export let pendingTotalRequests = 0;
export function addPendingTotalRequests(delta: number): void {
  if (!Number.isFinite(delta) || delta <= 0) return;
  pendingTotalRequests += Math.trunc(delta);
}
export function subtractPendingTotalRequests(delta: number): void {
  if (!Number.isFinite(delta) || delta <= 0) return;
  pendingTotalRequests = Math.max(0, pendingTotalRequests - Math.trunc(delta));
}
