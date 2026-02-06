import { MAX_PROXY_KEYS, NO_CACHE_HEADERS } from "../constants.ts";
import { kvGetAllKeys, kvGetAllProxyKeys, kvGetConfig } from "../kv.ts";

const FAVICON_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzA2YjZkNCIgZD0iTTIyIDRoLTkuNzdMMTEgLjM0YS41LjUgMCAwIDAtLjUtLjM0SDJhMiAyIDAgMCAwLTIgMnYxNmEyIDIgMCAwIDAgMiAyaDkuNjVMMTMgMjMuNjhhLjUuNSAwIDAgMCAuNDcuMzJIMjJhMiAyIDAgMCAwIDItMlY2YTIgMiAwIDAgMC0yLTJaTTcuNSAxNWE0LjUgNC41IDAgMSAxIDIuOTItNy45Mi41LjUgMCAxIDEtLjY1Ljc2QTMuNSAzLjUgMCAxIDAgMTEgMTFINy41YS41LjUgMCAwIDEgMC0xaDRhLjUuNSAwIDAgMSAuNS41QTQuNSA0LjUgMCAwIDEgNy41IDE1Wm0xMS45LTRhMTEuMjYgMTEuMjYgMCAwIDEtMS44NiAzLjI5IDYuNjcgNi42NyAwIDAgMS0xLjA3LTEuNDguNS41IDAgMCAwLS45My4zOCA4IDggMCAwIDAgMS4zNCAxLjg3IDguOSA4LjkgMCAwIDEtLjY1LjYyTDE0LjYyIDExWk0yMyAyMmExIDEgMCAwIDEtMSAxaC03LjRsMi43Ny0zLjE3YS40OS40OSAwIDAgMCAuMDktLjQ4bC0uOTEtMi42NmE5LjM2IDkuMzYgMCAwIDAgMS0uODljMSAxIDEuOTMgMS45MSAyLjEyIDIuMDhhLjUuNSAwIDAgMCAuNjgtLjc0IDQzLjQ4IDQzLjQ4IDAgMCAxLTIuMTMtMi4xIDExLjQ5IDExLjQ5IDAgMCAwIDIuMjItNGgxLjA2YS41LjUgMCAwIDAgMC0xSDE4VjkuNWEuNS41IDAgMCAwLTEgMHYuNWgtMi41YS40OS40OSAwIDAgMC0uMjEgMGwtMS43Mi01SDIyYTEgMSAwIDAgMSAxIDFaIi8+PC9zdmc+";

let cachedTemplate: string | null = null;

async function getTemplate(): Promise<string> {
  if (cachedTemplate) return cachedTemplate;
  cachedTemplate = await Deno.readTextFile(
    new URL("./admin.html", import.meta.url),
  );
  return cachedTemplate;
}

export async function renderAdminPage(): Promise<Response> {
  const [keys, config, proxyKeys] = await Promise.all([
    kvGetAllKeys(),
    kvGetConfig(),
    kvGetAllProxyKeys(),
  ]);
  const proxyKeyCount = proxyKeys.length;
  const stats = {
    totalKeys: keys.length,
    activeKeys: keys.filter((k) => k.status === "active").length,
    totalRequests: config.totalRequests,
    proxyAuthEnabled: proxyKeyCount > 0,
    proxyKeyCount,
  };

  const template = await getTemplate();
  const html = template
    .replaceAll("{{FAVICON_DATA_URI}}", FAVICON_DATA_URI)
    .replaceAll("{{STATS_TOTAL_KEYS}}", String(stats.totalKeys))
    .replaceAll("{{STATS_ACTIVE_KEYS}}", String(stats.activeKeys))
    .replaceAll("{{STATS_TOTAL_REQUESTS}}", String(stats.totalRequests))
    .replaceAll(
      "{{AUTH_BADGE_CLASS}}",
      stats.proxyAuthEnabled ? "auth-on" : "auth-off",
    )
    .replaceAll(
      "{{AUTH_BADGE_TEXT}}",
      stats.proxyAuthEnabled ? "鉴权已开启" : "公开访问",
    )
    .replaceAll("{{PROXY_KEY_COUNT}}", String(stats.proxyKeyCount))
    .replaceAll("{{MAX_PROXY_KEYS}}", String(MAX_PROXY_KEYS));

  return new Response(html, {
    headers: { ...NO_CACHE_HEADERS, "Content-Type": "text/html" },
  });
}
