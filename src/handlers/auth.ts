import { jsonResponse, problemResponse } from "../http.ts";
import {
  createAdminToken,
  deleteAdminToken,
  getAdminPassword,
  setAdminPasswordIfUnset,
  verifyAdminPassword,
  verifyAdminToken,
} from "../auth.ts";
import { loginLimiter } from "../rate-limit.ts";
import { metrics } from "../metrics.ts";
import type { Router } from "../router.ts";

/**
 * Uses one fail-closed auth bucket because forwarded IP headers are not trusted here.
 */
function getRateLimitKey(_req: Request): string {
  return "admin-auth";
}

/**
 * Reports whether setup is complete and the supplied admin token is valid.
 */
async function getAuthStatus(req: Request): Promise<Response> {
  const hasPassword = (await getAdminPassword()) !== null;
  const token = req.headers.get("X-Admin-Token");
  const isLoggedIn = await verifyAdminToken(token);
  return jsonResponse({ hasPassword, isLoggedIn });
}

/**
 * Handles first-run password setup while preserving the single-admin invariant.
 */
async function setupAuth(req: Request): Promise<Response> {
  const key = getRateLimitKey(req);
  const limit = loginLimiter.check(key);
  if (!limit.allowed) {
    metrics.inc("rate_limit_hits_total", "setup");
    const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
    return problemResponse("请求过于频繁", {
      status: 429,
      instance: "/api/auth/setup",
      headers: { "Retry-After": String(retryAfter) },
    });
  }

  const hasPassword = (await getAdminPassword()) !== null;
  if (hasPassword) {
    return problemResponse("密码已设置", {
      status: 400,
      instance: "/api/auth/setup",
    });
  }
  try {
    const { password } = await req.json();
    if (!password || password.length < 4) {
      return problemResponse("密码至少 4 位", {
        status: 400,
        instance: "/api/auth/setup",
      });
    }
    const created = await setAdminPasswordIfUnset(password);
    if (!created) {
      return problemResponse("密码已设置", {
        status: 400,
        instance: "/api/auth/setup",
      });
    }
    const token = await createAdminToken();
    return jsonResponse({ success: true, token });
  } catch (error) {
    console.error("[AUTH] setup error:", error);
    return problemResponse("请求处理失败", {
      status: 400,
      instance: "/api/auth/setup",
    });
  }
}

/**
 * Handles admin login under the same non-spoofable bucket as setup.
 */
async function loginAuth(req: Request): Promise<Response> {
  const key = getRateLimitKey(req);
  const limit = loginLimiter.check(key);
  if (!limit.allowed) {
    metrics.inc("rate_limit_hits_total", "login");
    const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
    return problemResponse("请求过于频繁", {
      status: 429,
      instance: "/api/auth/login",
      headers: { "Retry-After": String(retryAfter) },
    });
  }

  try {
    const { password } = await req.json();
    const valid = await verifyAdminPassword(password);
    if (!valid) {
      return problemResponse("密码错误", {
        status: 401,
        instance: "/api/auth/login",
      });
    }
    const token = await createAdminToken();
    return jsonResponse({ success: true, token });
  } catch (error) {
    console.error("[AUTH] login error:", error);
    return problemResponse("请求处理失败", {
      status: 400,
      instance: "/api/auth/login",
    });
  }
}

/**
 * Logs out the current admin token; missing tokens are treated as already logged out.
 */
async function logoutAuth(req: Request): Promise<Response> {
  const token = req.headers.get("X-Admin-Token");
  if (token) {
    await deleteAdminToken(token);
  }
  return jsonResponse({ success: true });
}

/**
 * Registers the admin authentication routes on the shared router.
 */
export function register(router: Router): void {
  router
    .get("/api/auth/status", getAuthStatus)
    .post("/api/auth/setup", setupAuth)
    .post("/api/auth/login", loginAuth)
    .post("/api/auth/logout", logoutAuth);
}
