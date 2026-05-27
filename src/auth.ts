import {
  ADMIN_PASSWORD_KEY,
  ADMIN_TOKEN_EXPIRY_MS,
  ADMIN_TOKEN_PREFIX,
  PROXY_KEY_AUTH_REFRESH_INTERVAL_MS,
} from "./constants.ts";
import { hashPassword, verifyPbkdf2Password } from "./crypto.ts";
import { state } from "./state.ts";
import { kvGetConfig } from "./kv/config.ts";
import { getAuthCacheRevision } from "./kv/revisions.ts";
import { findProxyKeyIdBySecret, kvGetAllProxyKeys } from "./kv/proxy-keys.ts";
import type { ProxyAuthKey } from "./types.ts";
import { hashProxyKey } from "./secrets.ts";

// Admin password management
/**
 * Reads the stored admin password hash; null means first-run setup is still available.
 */
export async function getAdminPassword(): Promise<string | null> {
  const entry = await state.kv.get<string>(ADMIN_PASSWORD_KEY);
  return entry.value;
}

/**
 * Atomically stores the first admin password hash.
 * Returns false when setup already happened or a concurrent setup won the race.
 */
export async function setAdminPasswordIfUnset(
  password: string,
): Promise<boolean> {
  const hash = await hashPassword(password);
  const existing = await state.kv.get<string>(ADMIN_PASSWORD_KEY);
  if (existing.value !== null) return false;

  const result = await state.kv.atomic()
    .check(existing)
    .set(ADMIN_PASSWORD_KEY, hash)
    .commit();

  return result.ok;
}

/**
 * Replaces the stored admin password hash unconditionally.
 *
 * Used by the SETUP_TOKEN-guarded reset flow: callers MUST verify the
 * setup token before invoking this, since this function intentionally
 * does not check the previous value (so a forgotten/compromised password
 * can be recovered without touching KV directly).
 */
export async function resetAdminPassword(password: string): Promise<void> {
  const hash = await hashPassword(password);
  await state.kv.set(ADMIN_PASSWORD_KEY, hash);
}

/**
 * Verifies a submitted admin password against the stored PBKDF2 hash.
 */
export async function verifyAdminPassword(password: string): Promise<boolean> {
  const stored = await getAdminPassword();
  if (!stored) return false;
  return await verifyPbkdf2Password(password, stored);
}

// Admin token management
/**
 * Creates a short-lived admin session token stored in KV with expiry.
 */
export async function createAdminToken(): Promise<string> {
  const token = crypto.randomUUID();
  const expiry = Date.now() + ADMIN_TOKEN_EXPIRY_MS;
  await state.kv.set(
    [...ADMIN_TOKEN_PREFIX, await hashProxyKey(token)],
    expiry,
    {
      expireIn: ADMIN_TOKEN_EXPIRY_MS,
    },
  );
  return token;
}

/**
 * Checks that an admin session token exists and has not expired.
 */
export async function verifyAdminToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  const tokenKey = [...ADMIN_TOKEN_PREFIX, await hashProxyKey(token)];
  const entry = await state.kv.get<number>(tokenKey);
  if (!entry.value) return false;
  if (Date.now() > entry.value) {
    await state.kv.delete(tokenKey);
    return false;
  }
  return true;
}

/**
 * Deletes an admin session token; missing tokens are already logged out.
 */
export async function deleteAdminToken(token: string): Promise<void> {
  await state.kv.delete([...ADMIN_TOKEN_PREFIX, await hashProxyKey(token)]);
}

/**
 * Revokes every existing admin session token.
 *
 * Called from the password reset flow so a recovered account cannot be
 * silently kept open through previously issued tokens (including ones
 * stolen alongside the old password). Returns the number of tokens
 * actually removed for logging/metrics.
 */
export async function deleteAllAdminTokens(): Promise<number> {
  let count = 0;
  const iter = state.kv.list<number>({ prefix: [...ADMIN_TOKEN_PREFIX] });
  for await (const entry of iter) {
    await state.kv.delete(entry.key);
    count++;
  }
  return count;
}

/**
 * Authorizes admin API requests using the X-Admin-Token header.
 */
export async function isAdminAuthorized(req: Request): Promise<boolean> {
  const token = req.headers.get("X-Admin-Token");
  return await verifyAdminToken(token);
}

/**
 * Finds the cached proxy-key id for an opaque bearer token.
 */
async function findProxyKeyByToken(token: string): Promise<string | null> {
  return await findProxyKeyIdBySecret(token);
}

async function loadProxyKeyCache(): Promise<Map<string, ProxyAuthKey>> {
  const loadedKeys = await kvGetAllProxyKeys();
  const keys = new Map(loadedKeys.map((k) => [k.id, k]));
  state.cachedProxyKeys = keys;
  state.proxyKeyCacheLastLoadedAt = Date.now();
  return keys;
}

async function refreshProxyKeyCache(): Promise<Map<string, ProxyAuthKey>> {
  if (state.proxyKeyCacheRefreshInFlight) {
    return await state.proxyKeyCacheRefreshInFlight;
  }
  const refresh = loadProxyKeyCache();
  state.proxyKeyCacheRefreshInFlight = refresh;
  try {
    return await refresh;
  } finally {
    state.proxyKeyCacheRefreshInFlight = null;
  }
}

async function refreshAuthCacheIfChanged(): Promise<void> {
  if (state.authCacheRevisionRefreshInFlight) {
    return await state.authCacheRevisionRefreshInFlight;
  }
  const refresh = refreshAuthCacheRevision();
  state.authCacheRevisionRefreshInFlight = refresh;
  try {
    await refresh;
  } finally {
    state.authCacheRevisionRefreshInFlight = null;
  }
}

async function refreshAuthCacheRevision(): Promise<void> {
  const now = Date.now();
  if (
    now - state.authCacheRevisionLastCheckedAt <
      PROXY_KEY_AUTH_REFRESH_INTERVAL_MS
  ) {
    return;
  }
  const revision = await getAuthCacheRevision();
  if (revision === state.authCacheRevision) {
    state.authCacheRevisionLastCheckedAt = now;
    return;
  }
  const [config] = await Promise.all([
    kvGetConfig(),
    refreshProxyKeyCache(),
  ]);
  state.cachedConfig = config;
  state.authCacheRevision = revision;
  state.authCacheRevisionLastCheckedAt = Date.now();
}

function shouldRefreshProxyKeyCache(): boolean {
  return Date.now() - state.proxyKeyCacheLastLoadedAt >=
    PROXY_KEY_AUTH_REFRESH_INTERVAL_MS;
}

// Proxy authorization
/**
 * Authorizes proxy requests with fail-closed default access.
 */
export async function isProxyAuthorized(
  req: Request,
): Promise<{ authorized: boolean; keyId?: string }> {
  await refreshAuthCacheIfChanged();
  if (state.cachedConfig?.proxyPublicAccess === true) {
    return { authorized: true };
  }
  let keys = state.cachedProxyKeys;
  if (keys === null) {
    keys = await refreshProxyKeyCache();
  }
  if (keys.size === 0) {
    return { authorized: false };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { authorized: false };
  }

  const token = authHeader.substring(7).trim();

  const match = await findProxyKeyByToken(token);
  if (match) return { authorized: true, keyId: match };

  if (shouldRefreshProxyKeyCache()) {
    await refreshProxyKeyCache();
    const retryMatch = await findProxyKeyByToken(token);
    if (retryMatch) return { authorized: true, keyId: retryMatch };
  }

  return { authorized: false };
}

/**
 * Records deferred usage stats for a proxy key after authorization succeeds.
 */
export function recordProxyKeyUsage(keyId: string): void {
  const pk = state.cachedProxyKeys?.get(keyId);
  if (!pk) return;
  pk.useCount++;
  pk.lastUsed = Date.now();
  state.dirtyProxyKeyIds.add(keyId);
}
