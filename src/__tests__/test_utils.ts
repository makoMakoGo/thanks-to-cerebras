/**
 * Test utilities and mock helpers
 */

import type { ApiKey, ProxyAuthKey, ProxyConfig } from "../types.ts";

/**
 * Create a mock ApiKey for testing
 */
export function createMockApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: crypto.randomUUID(),
    key: `test-key-${Date.now()}`,
    useCount: 0,
    status: "active",
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Create a mock ProxyAuthKey for testing
 */
export function createMockProxyKey(
  overrides: Partial<ProxyAuthKey> = {},
): ProxyAuthKey {
  return {
    id: crypto.randomUUID(),
    key: `pk-test-${Date.now()}`,
    name: "Test Proxy Key",
    useCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Create a mock ProxyConfig for testing
 */
export function createMockConfig(
  overrides: Partial<ProxyConfig> = {},
): ProxyConfig {
  return {
    modelPool: ["model-a", "model-b"],
    currentModelIndex: 0,
    totalRequests: 0,
    kvFlushIntervalMs: 15000,
    ...overrides,
  };
}

/**
 * Create a mock Request for testing
 */
export function createMockRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Request {
  const { method = "GET", headers = {}, body } = options;
  return new Request(url, {
    method,
    headers: new Headers(headers),
    body,
  });
}

/**
 * Create a mock Response for testing
 */
export function createMockResponse(
  body: string | null,
  options: {
    status?: number;
    headers?: Record<string, string>;
  } = {},
): Response {
  const { status = 200, headers = {} } = options;
  return new Response(body, {
    status,
    headers: new Headers(headers),
  });
}

/**
 * Wait for a specified number of milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
