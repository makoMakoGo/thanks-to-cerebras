import { adminJsonResponse, adminProblemResponse } from "../http.ts";
import {
  ADMIN_AUTH_RATE_LIMIT_MAX,
  ADMIN_AUTH_RATE_LIMIT_WINDOW_MS,
} from "../constants.ts";
import {
  createAdminToken,
  deleteAdminToken,
  deleteAllAdminTokens,
  getAdminPassword,
  resetAdminPassword,
  setAdminPasswordIfUnset,
  verifyAdminPassword,
  verifyAdminToken,
} from "../auth.ts";
import { compareSecret } from "../crypto.ts";
import { checkKvRateLimit } from "../rate-limit.ts";
import { metrics } from "../metrics.ts";
import { logger } from "../logger.ts";
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
 *
 * Cheap, side-effect-free checks (Content-Type, SETUP_TOKEN configuration,
 * X-Setup-Token match) run BEFORE the rate-limit bucket is consumed. This
 * prevents an unauthenticated attacker from filling the global setup
 * bucket with bogus requests and DoS-ing the legitimate admin during the
 * first-run window.
 */
async function setupAuth(req: Request): Promise<Response> {
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
  const providedToken = req.headers.get("X-Setup-Token") ?? "";
  if (!(await compareSecret(providedToken, setupToken))) {
    return adminProblemResponse("初始化令牌错误", {
      status: 403,
      instance: "/api/auth/setup",
    });
  }

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
    logger.error("admin_setup_failed", {}, error);
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
    if (typeof password !== "string") {
      return adminProblemResponse("密码格式错误", {
        status: 400,
        instance: "/api/auth/login",
      });
    }
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
    logger.error("admin_login_failed", {}, error);
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
 * Resets the admin password using the SETUP_TOKEN as the only credential.
 *
 * The threat model here is "old password leaked / forgotten":
 * - We deliberately do NOT accept the previous password as a second
 *   factor. If it leaked, an attacker could lock the legitimate operator
 *   out and there'd be no recovery.
 * - SETUP_TOKEN lives in the deploy environment variables, which only
 *   the deploy operator controls. Treat it as the recovery key.
 *
 * Cheap, side-effect-free checks (Content-Type, SETUP_TOKEN configured,
 * X-Setup-Token match) run BEFORE the rate-limit bucket is consumed —
 * same pattern as setupAuth — so unauthenticated traffic cannot fill the
 * shared admin-auth bucket and DoS the legitimate operator during
 * recovery.
 */
async function resetPasswordAuth(req: Request): Promise<Response> {
  const contentType = req.headers.get("Content-Type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return adminProblemResponse("请求体必须是 application/json", {
      status: 415,
      instance: "/api/auth/reset-password",
    });
  }

  const setupToken = Deno.env.get("SETUP_TOKEN");
  if (!setupToken) {
    return adminProblemResponse("SETUP_TOKEN 未配置，禁止重置密码", {
      status: 503,
      instance: "/api/auth/reset-password",
    });
  }
  const providedToken = req.headers.get("X-Setup-Token") ?? "";
  if (!(await compareSecret(providedToken, setupToken))) {
    return adminProblemResponse("初始化令牌错误", {
      status: 403,
      instance: "/api/auth/reset-password",
    });
  }

  const key = getRateLimitKey(req);
  const limit = await checkKvRateLimit(ADMIN_AUTH_LIMIT, key);
  if (!limit.allowed) {
    metrics.inc("rate_limit_hits_total", "reset-password");
    const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
    return adminProblemResponse("请求过于频繁", {
      status: 429,
      instance: "/api/auth/reset-password",
      headers: { "Retry-After": String(retryAfter) },
    });
  }

  try {
    const { password } = await req.json();
    if (typeof password !== "string" || password.length < 8) {
      return adminProblemResponse("密码至少 8 位", {
        status: 400,
        instance: "/api/auth/reset-password",
      });
    }
    await resetAdminPassword(password);
    const revokedTokens = await deleteAllAdminTokens();
    const token = await createAdminToken();
    logger.info("admin_password_reset", { revokedTokens });
    return adminJsonResponse({ success: true, token });
  } catch (error) {
    logger.error("admin_password_reset_failed", {}, error);
    return adminProblemResponse("请求处理失败", {
      status: 400,
      instance: "/api/auth/reset-password",
    });
  }
}

/**
 * Registers the admin authentication routes on the shared router.
 */
export function register(router: Router): void {
  router
    .get("/api/auth/status", getAuthStatus)
    .post("/api/auth/setup", setupAuth)
    .post("/api/auth/login", loginAuth)
    .post("/api/auth/logout", logoutAuth)
    .post("/api/auth/reset-password", resetPasswordAuth);
}
