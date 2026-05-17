const API_KEY_PREFIX = "v1$aes-gcm$";
const PROXY_KEY_PREFIX = "v1$hmac-sha256$";

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function bytesSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function secretMaterial(): Uint8Array {
  const secret = Deno.env.get("KEY_ENCRYPTION_SECRET")?.trim();
  if (!secret) {
    throw new Error("KEY_ENCRYPTION_SECRET 未配置，禁止写入或读取密钥");
  }
  return new TextEncoder().encode(secret);
}

export function assertKeyEncryptionSecretConfigured(): void {
  secretMaterial();
}

async function deriveAesKey(): Promise<CryptoKey> {
  const material = secretMaterial();
  const digest = await crypto.subtle.digest("SHA-256", bytesSource(material));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function deriveHmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bytesSource(secretMaterial()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export function isEncryptedApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX);
}

export function isHashedProxyKey(value: string): boolean {
  return value.startsWith(PROXY_KEY_PREFIX);
}

export async function encryptApiKey(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey();
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      bytesSource(new TextEncoder().encode(plaintext)),
    ),
  );
  return `${API_KEY_PREFIX}${encodeBase64Url(iv)}$${
    encodeBase64Url(ciphertext)
  }`;
}

export async function decryptApiKey(stored: string): Promise<string> {
  if (!isEncryptedApiKey(stored)) {
    throw new Error("API key 存储格式不兼容：需要先运行密钥迁移");
  }

  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "v1" || parts[1] !== "aes-gcm") {
    throw new Error("API key 密文格式错误");
  }

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesSource(decodeBase64Url(parts[2])) },
    await deriveAesKey(),
    bytesSource(decodeBase64Url(parts[3])),
  );
  return new TextDecoder().decode(plaintext);
}

export async function hashProxyKey(secret: string): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await deriveHmacKey(),
      bytesSource(new TextEncoder().encode(secret)),
    ),
  );
  return `${PROXY_KEY_PREFIX}${encodeBase64Url(signature)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLength; i++) {
    const left = i < a.length ? a.charCodeAt(i) : 0;
    const right = i < b.length ? b.charCodeAt(i) : 0;
    diff |= left ^ right;
  }
  return diff === 0;
}

export async function verifyProxyKey(
  secret: string,
  storedHash: string,
): Promise<boolean> {
  if (!isHashedProxyKey(storedHash)) {
    throw new Error("proxy key 存储格式不兼容：需要先运行密钥迁移");
  }
  const expected = await hashProxyKey(secret);
  return constantTimeEqual(expected, storedHash);
}
