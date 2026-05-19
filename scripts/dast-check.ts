const DEFAULT_BASE_URL = "http://127.0.0.1:8339";
const DEFAULT_TIMEOUT_MS = 5_000;
const SENSITIVE_PATTERNS = [
  /ci-dast-(setup-token|key-encryption-secret)/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\bAuthorization\b/i,
  /\bcpk_[A-Za-z0-9_-]+/i,
  /\bsk-[A-Za-z0-9_-]+/i,
  /\bv1\$(aes-gcm|hmac-sha256)\$/i,
  /\bat\s+file:\/\//i,
];

type Probe = {
  name: string;
  path: string;
  method?: string;
  headers?: HeadersInit;
  body?: string;
  expectedStatus: number;
  expectCorsOrigin?: string | null;
  expectContentType?: string;
  expectBodyIncludes?: string;
};

const probes: Probe[] = [
  {
    name: "health check",
    path: "/healthz",
    expectedStatus: 200,
    expectBodyIncludes: "ok",
  },
  {
    name: "readiness check",
    path: "/readyz",
    expectedStatus: 200,
    expectBodyIncludes: '"ready":true',
  },
  {
    name: "admin page is reachable",
    path: "/",
    expectedStatus: 200,
    expectContentType: "text/html",
  },
  {
    name: "auth status is public and unauthenticated",
    path: "/api/auth/status",
    expectedStatus: 200,
    expectBodyIncludes: '"isLoggedIn":false',
  },
  {
    name: "admin metrics require auth",
    path: "/api/metrics",
    expectedStatus: 401,
    expectCorsOrigin: null,
  },
  {
    name: "models endpoint is public",
    path: "/v1/models",
    expectedStatus: 200,
    expectCorsOrigin: "*",
    expectBodyIncludes: "cerebras-translator",
  },
  {
    name: "proxy preflight allows browser clients",
    path: "/v1/chat/completions",
    method: "OPTIONS",
    expectedStatus: 204,
    expectCorsOrigin: "*",
  },
  {
    name: "admin preflight stays same-origin",
    path: "/api/keys",
    method: "OPTIONS",
    expectedStatus: 204,
    expectCorsOrigin: null,
  },
  {
    name: "proxy rejects unauthenticated chat",
    path: "/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "cerebras-translator",
      messages: [{ role: "user", content: "hello" }],
    }),
    expectedStatus: 401,
    expectCorsOrigin: "*",
  },
  {
    name: "unknown API route does not crash",
    path: "/api/does-not-exist",
    expectedStatus: 401,
    expectCorsOrigin: null,
  },
  {
    name: "malicious-looking path does not crash",
    path: "/%2e%2e/%2e%2e/etc/passwd",
    expectedStatus: 404,
  },
];

function parseArgs(args: string[]): { baseUrl: string; timeoutMs: number } {
  let baseUrl = Deno.env.get("DAST_BASE_URL") ?? DEFAULT_BASE_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base-url") {
      baseUrl = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      timeoutMs = value;
      index += 1;
      continue;
    }
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), timeoutMs };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function assertNoSensitiveLeak(probe: Probe, body: string): void {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(body)) {
      throw new Error(`${probe.name}: response matched ${pattern}`);
    }
  }
}

function assertProbe(
  probe: Probe,
  response: Response,
  body: string,
): void {
  if (response.status !== probe.expectedStatus) {
    throw new Error(
      `${probe.name}: expected ${probe.expectedStatus}, got ${response.status}`,
    );
  }

  if (probe.expectCorsOrigin !== undefined) {
    const actual = response.headers.get("access-control-allow-origin");
    if (actual !== probe.expectCorsOrigin) {
      throw new Error(
        `${probe.name}: expected access-control-allow-origin ${
          String(probe.expectCorsOrigin)
        }, got ${String(actual)}`,
      );
    }
  }

  if (probe.expectContentType) {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes(probe.expectContentType)) {
      throw new Error(
        `${probe.name}: expected content-type ${probe.expectContentType}, got ${contentType}`,
      );
    }
  }

  if (probe.expectBodyIncludes && !body.includes(probe.expectBodyIncludes)) {
    throw new Error(
      `${probe.name}: response body did not include ${probe.expectBodyIncludes}`,
    );
  }

  assertNoSensitiveLeak(probe, body);
}

const { baseUrl, timeoutMs } = parseArgs(Deno.args);

for (const probe of probes) {
  const response = await fetchWithTimeout(
    `${baseUrl}${probe.path}`,
    {
      method: probe.method ?? "GET",
      headers: probe.headers,
      body: probe.body,
    },
    timeoutMs,
  );
  const body = await response.text();
  assertProbe(probe, response, body);
}

console.log(`DAST check passed: ${probes.length} probes checked.`);
