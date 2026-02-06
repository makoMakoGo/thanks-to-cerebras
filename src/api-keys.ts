import { state } from "./state.ts";

export function rebuildActiveKeyIds(): void {
  const keys = Array.from(state.cachedKeysById.values());
  keys.sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  state.cachedActiveKeyIds = keys.filter((k) => k.status === "active").map(
    (k) => k.id,
  );
  if (state.cachedActiveKeyIds.length === 0) {
    state.cachedCursor = 0;
    return;
  }
  state.cachedCursor = state.cachedCursor % state.cachedActiveKeyIds.length;
}

export function getNextApiKeyFast(
  now: number,
): { key: string; id: string } | null {
  if (state.cachedActiveKeyIds.length === 0) return null;

  for (let offset = 0; offset < state.cachedActiveKeyIds.length; offset++) {
    const idx = (state.cachedCursor + offset) % state.cachedActiveKeyIds.length;
    const id = state.cachedActiveKeyIds[idx];
    const cooldownUntil = state.keyCooldownUntil.get(id) ?? 0;
    if (cooldownUntil > now) continue;

    const keyEntry = state.cachedKeysById.get(id);
    if (!keyEntry || keyEntry.status !== "active") continue;

    state.cachedCursor = (idx + 1) % state.cachedActiveKeyIds.length;

    keyEntry.useCount += 1;
    keyEntry.lastUsed = now;
    state.dirtyKeyIds.add(id);

    if (state.cachedConfig) {
      state.addPendingTotalRequests(1);
      state.dirtyConfig = true;
    }

    return { key: keyEntry.key, id };
  }

  return null;
}

export function markKeyCooldownFrom429(id: string, response: Response): void {
  const retryAfter = response.headers.get("retry-after")?.trim();
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
    ? Number.parseInt(retryAfter, 10) * 1000
    : 2000;
  state.keyCooldownUntil.set(id, Date.now() + Math.max(0, retryAfterMs));
}

export function markKeyInvalid(id: string): void {
  const keyEntry = state.cachedKeysById.get(id);
  if (!keyEntry) return;
  if (keyEntry.status === "invalid") return;
  keyEntry.status = "invalid";
  state.dirtyKeyIds.add(id);
  state.keyCooldownUntil.delete(id);
  rebuildActiveKeyIds();
}
