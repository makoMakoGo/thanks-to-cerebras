export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export type LogSink = (level: LogLevel, line: string) => void;

const MAX_LOG_STRING_LENGTH = 1000;
const TRUNCATED_SUFFIX = "...[TRUNCATED]";
const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [
    /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    "Authorization: Bearer [REDACTED]",
  ],
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
  [
    /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"',\s}]+["']?/gi,
    "$1=[REDACTED]",
  ],
  [/\bsk-[A-Za-z0-9._-]+/gi, "sk-[REDACTED]"],
  [/\bcpk_[A-Za-z0-9._-]+/gi, "cpk_[REDACTED]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED]"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[REDACTED]"],
];

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

let sink: LogSink = defaultSink;

function sanitizeSensitiveString(input: string): string {
  let sanitized = input;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  if (sanitized.length <= MAX_LOG_STRING_LENGTH) return sanitized;
  return `${
    sanitized.slice(
      0,
      MAX_LOG_STRING_LENGTH - TRUNCATED_SUFFIX.length,
    )
  }${TRUNCATED_SUFFIX}`;
}

function sanitizeLogFields(fields: LogFields): LogFields {
  const sanitized: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    sanitized[key] = typeof value === "string"
      ? sanitizeSensitiveString(value)
      : value;
  }
  return sanitized;
}

function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    const fields: LogFields = {
      errorName: error.name,
      errorMessage: sanitizeSensitiveString(error.message),
    };
    if (error.stack) fields.errorStack = sanitizeSensitiveString(error.stack);
    return fields;
  }
  return { errorMessage: sanitizeSensitiveString(String(error)) };
}

function writeLog(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
  error?: unknown,
): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeLogFields(fields),
    ...(error === undefined ? {} : serializeError(error)),
  };
  const line = JSON.stringify(record);
  sink(level, line);
}

export const logger = {
  info(event: string, fields?: LogFields): void {
    writeLog("info", event, fields);
  },
  warn(event: string, fields?: LogFields, error?: unknown): void {
    writeLog("warn", event, fields, error);
  },
  error(event: string, fields?: LogFields, error?: unknown): void {
    writeLog("error", event, fields, error);
  },
};

export function setLogSinkForTests(nextSink: LogSink | null): void {
  sink = nextSink ?? defaultSink;
}
