export const PBKDF2_ITERATIONS = 100000;
export const PBKDF2_KEY_LENGTH = 32;

/**
 * Constant-time string comparison for short secret tokens (e.g. SETUP_TOKEN).
 *
 * Avoids leaking secret length / matched-prefix length through CPU-time
 * side channels. Encodes both inputs as UTF-8 bytes and walks the longer
 * of the two buffers so that the loop count never depends on equality of
 * earlier bytes. Always returns false when lengths differ.
 */
export function safeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  // Mismatched length is itself a non-match; we still walk the longer
  // buffer to keep the loop count independent of `a`.
  const len = Math.max(aBuf.length, bBuf.length);
  let diff = aBuf.length ^ bBuf.length;
  for (let i = 0; i < len; i++) {
    const ai = i < aBuf.length ? aBuf[i] : 0;
    const bi = i < bBuf.length ? bBuf[i] : 0;
    diff |= ai ^ bi;
  }
  return diff === 0;
}

export async function hashPassword(
  password: string,
  salt?: Uint8Array,
): Promise<string> {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: actualSalt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    PBKDF2_KEY_LENGTH * 8,
  );

  const derivedKey = new Uint8Array(derivedBits);
  const saltB64 = btoa(String.fromCharCode(...actualSalt));
  const keyB64 = btoa(String.fromCharCode(...derivedKey));
  return `v1$pbkdf2$${PBKDF2_ITERATIONS}$${saltB64}$${keyB64}`;
}

export async function verifyPbkdf2Password(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");

  if (!(parts.length === 5 && parts[0] === "v1" && parts[1] === "pbkdf2")) {
    return false;
  }

  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  let storedKey: Uint8Array;
  try {
    salt = Uint8Array.from(atob(parts[3]), (c) => c.charCodeAt(0));
    storedKey = Uint8Array.from(atob(parts[4]), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }

  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    storedKey.length * 8,
  );

  const computedKey = new Uint8Array(derivedBits);
  if (computedKey.length !== storedKey.length) return false;

  let diff = 0;
  for (let i = 0; i < computedKey.length; i++) {
    diff |= computedKey[i] ^ storedKey[i];
  }
  return diff === 0;
}
