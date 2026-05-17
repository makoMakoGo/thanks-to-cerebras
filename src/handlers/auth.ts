import { adminJsonResponse, adminProblemResponse } from "../http.ts";
import {
  ADMIN_AUTH_RATE_LIMIT_MAX,
  ADMIN_AUTH_RATE_LIMIT_WINDOW_MS,
} from "../constants.ts";
import {
  createAdminToken,
  deleteAdminToken,
  getAdminPassword,
  setAdminPasswordIfUnset,
  verifyAdminPassword,
  verifyAdminToken,
} from "../auth.ts";
import { checkKvRateLimit } from "../rate-limit.ts";
import { metrics } from "../metrics.ts";
import type { Router } from "../router.ts";

const ADMIN_AUTH_LIMIT = {
  namespace: "admin-auth",
  maxRequests: ADMIN_AUTH_RATE_LIMIT_MAX,
  windowMs: ADMIN_AUTH_RATE_LIMIT_WINDOW_MS,
};

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
  return adminJsonResponse({ hasPassword, isLoggedIn });
}

/**
 * Handles first-run password setup while preserving the single-admin invariant.
 */
async function setupAuth(req: Request): Promise<Response> {
  const key = getRateLimitKey(req);
  const limit = await checkKvRateLimit(ADMIN_AUTH_LIMIT, key);
  if (!limit.allowed) {
    metrics.inc("rate_limit_hits_total", "setup");
    const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
    return adminProblemResponse("请求过于频繁", {
      status: 429,
      instance: "/api/auth/setup",
      headers: { "Retry-After": String(retryAfter) },
    });
  }

  const hasPassword = (await getAdminPassword()) !== null;
  if (hasPassword) {
    return adminProblemResponse("密码已设置", {
      status: 400,
      instance: "/api/auth/setup",
    });
  }
  const contentType = req.headers.get("Content-Type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return adminProblemResponse("请求体必须是 application/json", {
      status: 415,
      instance: "/api/auth/setup",
    });
  }

  const setupToken = Deno.env.get("SETUP_TOKEN");
  if (!setupToken) {
    return adminProblemResponse("SETUP_TOKEN 未配置，禁止首次初始化", {
      status: 503,
      instance: "/api/auth/setup",
    });
  }
  if (req.headers.get("X-Setup-Token") !== setupToken) {
    return adminProblemResponse("初始化令牌错误", {
      status: 403,
      instance: "/api/auth/setup",
    });
  }

  try {
    const { password } = await req.json();
    if (typeof password !== "string" || password.length < 4) {
      return adminProblemResponse("密码至少 4 位", {
        status: 400,
        instance: "/api/auth/setup",
      });
    }
    const created = await setAdminPasswordIfUnset(password);
    if (!created) {
      return adminProblemResponse("密码已设置", {
        status: 400,
        instance: "/api/auth/setup",
      });
    }
    const token = await createAdminToken();
    return adminJsonResponse({ success: true, token });
  } catch (error) {
    console.error("[AUTH] setup error:", error);
    return adminProblemResponse("请求处理失败", {
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
  const limit = await checkKvRateLimit(ADMIN_AUTH_LIMIT, key);
  if (!limit.allowed) {
    metrics.inc("rate_limit_hits_total", "login");
    const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
    return adminProblemResponse("请求过于频繁", {
      status: 429,
      instance: "/api/auth/login",
      headers: { "Retry-After": String(retryAfter) },
    });
  }

  const contentType = req.headers.get("Content-Type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return adminProblemResponse("请求体必须是 application/json", {
      status: 415,
      instance: "/api/auth/login",
    });
  }
  try {
    const { password } = await req.json();
    const valid = await verifyAdminPassword(password);
    if (!valid) {
      return adminProblemResponse("密码错误", {
        status: 401,
        instance: "/api/auth/login",
      });
    }
    const token = await createAdminToken();
    return adminJsonResponse({ success: true, token });
  } catch (error) {
    console.error("[AUTH] login error:", error);
    return adminProblemResponse("请求处理失败", {
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
  return adminJsonResponse({ success: true });
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
