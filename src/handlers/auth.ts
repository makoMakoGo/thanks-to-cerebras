import { jsonResponse, problemResponse } from "../http.ts";
import {
  createAdminToken,
  deleteAdminToken,
  getAdminPassword,
  setAdminPassword,
  verifyAdminPassword,
  verifyAdminToken,
} from "../auth.ts";
import { loginLimiter } from "../rate-limit.ts";
import type { Router } from "../router.ts";

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

async function getAuthStatus(req: Request): Promise<Response> {
  const hasPassword = (await getAdminPassword()) !== null;
  const token = req.headers.get("X-Admin-Token");
  const isLoggedIn = await verifyAdminToken(token);
  return jsonResponse({ hasPassword, isLoggedIn });
}

async function setupAuth(req: Request): Promise<Response> {
  const ip = getClientIp(req);
  const limit = loginLimiter.check(ip);
  if (!limit.allowed) {
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
    await setAdminPassword(password);
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

async function loginAuth(req: Request): Promise<Response> {
  const ip = getClientIp(req);
  const limit = loginLimiter.check(ip);
  if (!limit.allowed) {
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

async function logoutAuth(req: Request): Promise<Response> {
  const token = req.headers.get("X-Admin-Token");
  if (token) {
    await deleteAdminToken(token);
  }
  return jsonResponse({ success: true });
}

export function register(router: Router): void {
  router
    .get("/api/auth/status", getAuthStatus)
    .post("/api/auth/setup", setupAuth)
    .post("/api/auth/login", loginAuth)
    .post("/api/auth/logout", logoutAuth);
}
