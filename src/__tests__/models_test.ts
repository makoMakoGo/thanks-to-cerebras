/**
 * Tests for models.ts
 */

import { assertEquals } from "@std/assert";
import {
  isModelNotFoundPayload,
  isModelNotFoundText,
  normalizeModelPool,
} from "../models.ts";

Deno.test("normalizeModelPool - returns empty array for undefined input", () => {
  const result = normalizeModelPool(undefined);
  assertEquals(result, []);
});

Deno.test("normalizeModelPool - returns empty array for non-array input", () => {
  const result = normalizeModelPool(null as unknown as undefined);
  assertEquals(result, []);
});

Deno.test("normalizeModelPool - filters out empty strings", () => {
  const result = normalizeModelPool(["model-a", "", "  ", "model-b"]);
  assertEquals(result, ["model-a", "model-b"]);
});

Deno.test("normalizeModelPool - trims whitespace", () => {
  const result = normalizeModelPool(["  model-a  ", "model-b"]);
  assertEquals(result, ["model-a", "model-b"]);
});

Deno.test("normalizeModelPool - removes duplicates", () => {
  const result = normalizeModelPool(["model-a", "model-b", "model-a"]);
  assertEquals(result, ["model-a", "model-b"]);
});

Deno.test("normalizeModelPool - handles non-string values", () => {
  const result = normalizeModelPool(
    [
      "model-a",
      123,
      null,
      undefined,
      "model-b",
    ] as unknown as readonly unknown[],
  );
  assertEquals(result, ["model-a", "model-b"]);
});

Deno.test("isModelNotFoundText - detects model_not_found", () => {
  assertEquals(isModelNotFoundText("model_not_found"), true);
  assertEquals(isModelNotFoundText("MODEL_NOT_FOUND"), true);
  assertEquals(isModelNotFoundText("Error: model_not_found"), true);
});

Deno.test("isModelNotFoundText - detects model not found", () => {
  assertEquals(isModelNotFoundText("model not found"), true);
  assertEquals(isModelNotFoundText("Model Not Found"), true);
});

Deno.test("isModelNotFoundText - detects no such model", () => {
  assertEquals(isModelNotFoundText("no such model"), true);
  assertEquals(isModelNotFoundText("No Such Model"), true);
});

Deno.test("isModelNotFoundText - returns false for unrelated text", () => {
  assertEquals(isModelNotFoundText("success"), false);
  assertEquals(isModelNotFoundText("rate limit exceeded"), false);
  assertEquals(isModelNotFoundText(""), false);
});

Deno.test("isModelNotFoundPayload - returns false for null/undefined", () => {
  assertEquals(isModelNotFoundPayload(null), false);
  assertEquals(isModelNotFoundPayload(undefined), false);
});

Deno.test("isModelNotFoundPayload - returns false for non-object", () => {
  assertEquals(isModelNotFoundPayload("string"), false);
  assertEquals(isModelNotFoundPayload(123), false);
});

Deno.test("isModelNotFoundPayload - returns false for object without error", () => {
  assertEquals(isModelNotFoundPayload({ message: "test" }), false);
});

Deno.test("isModelNotFoundPayload - detects error string", () => {
  assertEquals(isModelNotFoundPayload({ error: "model_not_found" }), true);
  assertEquals(isModelNotFoundPayload({ error: "Model not found" }), true);
});

Deno.test("isModelNotFoundPayload - detects error.code", () => {
  assertEquals(
    isModelNotFoundPayload({ error: { code: "model_not_found" } }),
    true,
  );
});

Deno.test("isModelNotFoundPayload - detects error.type", () => {
  assertEquals(
    isModelNotFoundPayload({ error: { type: "model_not_found" } }),
    true,
  );
});

Deno.test("isModelNotFoundPayload - detects error.message", () => {
  assertEquals(
    isModelNotFoundPayload({ error: { message: "model not found" } }),
    true,
  );
  assertEquals(
    isModelNotFoundPayload({ error: { message: "no such model: foo" } }),
    true,
  );
});

Deno.test("isModelNotFoundPayload - returns false for other errors", () => {
  assertEquals(isModelNotFoundPayload({ error: "rate limit exceeded" }), false);
  assertEquals(
    isModelNotFoundPayload({ error: { code: "invalid_api_key" } }),
    false,
  );
});
