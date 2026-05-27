import {
  MAX_CHAT_COMPLETION_TOKENS,
  MAX_CHAT_MESSAGE_CONTENT_CHARS,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_TOTAL_CONTENT_CHARS,
  MAX_PROXY_REQUEST_BODY_BYTES,
  PROXY_REQUEST_BODY_IDLE_TIMEOUT_MS,
  PROXY_REQUEST_BODY_TOTAL_TIMEOUT_MS,
} from "./constants.ts";

const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);

export type ChatRequestValidation =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 408 | 413; message: string };

export type BodyReadTimeouts = { idleMs: number; totalMs: number };

export async function readAndValidateChatRequest(
  req: Request,
): Promise<ChatRequestValidation> {
  const contentLength = req.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return { ok: false, status: 400, message: "Content-Length 非法" };
    }
    if (Number(contentLength) > MAX_PROXY_REQUEST_BODY_BYTES) {
      return { ok: false, status: 413, message: "请求体过大" };
    }
  }

  const bodyText = await readBoundedTextForTests(
    req,
    MAX_PROXY_REQUEST_BODY_BYTES,
    {
      idleMs: PROXY_REQUEST_BODY_IDLE_TIMEOUT_MS,
      totalMs: PROXY_REQUEST_BODY_TOTAL_TIMEOUT_MS,
    },
  );
  if (!bodyText.ok) return bodyText;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText.text);
  } catch {
    return { ok: false, status: 400, message: "无效的 JSON 请求体" };
  }

  return validateChatRequest(parsed);
}

export async function readBoundedTextForTests(
  req: Request,
  maxBytes: number,
  timeouts: BodyReadTimeouts,
): Promise<
  { ok: true; text: string } | { ok: false; status: 408 | 413; message: string }
> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, text: "" };

  const chunks: Uint8Array[] = [];
  let total = 0;
  const startedAt = Date.now();
  try {
    while (true) {
      const remainingTotalMs = timeouts.totalMs - (Date.now() - startedAt);
      if (remainingTotalMs <= 0) {
        await reader.cancel("body total timeout");
        return { ok: false, status: 408, message: "请求体读取超时" };
      }
      const read = reader.read();
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timerId = setTimeout(
          () => resolve("timeout"),
          Math.min(timeouts.idleMs, remainingTotalMs),
        );
      });
      const result = await Promise.race([read, timeout]);
      if (timerId !== undefined) clearTimeout(timerId);
      if (result === "timeout") {
        read.catch(() => {});
        void reader.cancel("body read timeout");
        return { ok: false, status: 408, message: "请求体读取超时" };
      }
      const { done, value } = result;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, message: "请求体过大" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

function validateChatRequest(raw: unknown): ChatRequestValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, status: 400, message: "请求体必须是对象" };
  }

  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      ok: false,
      status: 400,
      message: "请求体必须包含非空的 messages 数组",
    };
  }
  if (body.messages.length > MAX_CHAT_MESSAGES) {
    return { ok: false, status: 400, message: "messages 数量超限" };
  }

  let totalContentChars = 0;
  for (const message of body.messages) {
    if (!message || typeof message !== "object") {
      return { ok: false, status: 400, message: "message 必须是对象" };
    }
    const item = message as Record<string, unknown>;
    if (typeof item.role !== "string" || !VALID_ROLES.has(item.role)) {
      return { ok: false, status: 400, message: "message.role 非法" };
    }

    const contentLength = chatContentLength(item.content);
    if (contentLength === null) {
      return { ok: false, status: 400, message: "message.content 非法" };
    }
    if (contentLength > MAX_CHAT_MESSAGE_CONTENT_CHARS) {
      return { ok: false, status: 400, message: "单条 message.content 超限" };
    }
    totalContentChars += contentLength;
    if (totalContentChars > MAX_CHAT_TOTAL_CONTENT_CHARS) {
      return { ok: false, status: 400, message: "messages 总内容超限" };
    }
  }

  if (
    body.max_tokens !== undefined &&
    body.max_tokens !== null &&
    (!Number.isInteger(body.max_tokens) ||
      (body.max_tokens as number) < 1 ||
      (body.max_tokens as number) > MAX_CHAT_COMPLETION_TOKENS)
  ) {
    return { ok: false, status: 400, message: "max_tokens 超限" };
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return { ok: false, status: 400, message: "stream 必须为布尔值" };
  }

  return { ok: true, body };
}

function chatContentLength(content: unknown): number | null {
  if (typeof content === "string") return content.length;
  if (content === null) return 0;
  if (!Array.isArray(content)) return null;

  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") return null;
    const value = part as Record<string, unknown>;
    if (typeof value.text === "string") total += value.text.length;
  }
  return total;
}
