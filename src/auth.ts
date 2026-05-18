import {
  ADMIN_PASSWORD_KEY,
  ADMIN_TOKEN_EXPIRY_MS,
  ADMIN_TOKEN_PREFIX,
  PROXY_KEY_AUTH_REFRESH_INTERVAL_MS,
} from "./constants.ts";
import { hashPassword, verifyPbkdf2Password } from "./crypto.ts";
import { state } from "./state.ts";
import { findProxyKeyIdBySecret, kvGetAllProxyKeys } from "./kv/proxy-keys.ts";
import type { ProxyAuthKey } from "./types.ts";

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
  await state.kv.set([...ADMIN_TOKEN_PREFIX, token], expiry, {
    expireIn: ADMIN_TOKEN_EXPIRY_MS,
  });
  return token;
}

/**
 * Checks that an admin session token exists and has not expired.
 */
export async function verifyAdminToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  const entry = await state.kv.get<number>([...ADMIN_TOKEN_PREFIX, token]);
  if (!entry.value) return false;
  if (Date.now() > entry.value) {
    await state.kv.delete([...ADMIN_TOKEN_PREFIX, token]);
    return false;
  }
  return true;
}

/**
 * Deletes an admin session token; missing tokens are already logged out.
 */
export async function deleteAdminToken(token: string): Promise<void> {
  await state.kv.delete([...ADMIN_TOKEN_PREFIX, token]);
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
