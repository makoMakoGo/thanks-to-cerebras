import { assertEquals } from "@std/assert";
import { resolvePort } from "../utils.ts";

Deno.test("resolvePort - returns fallback for undefined", () => {
  assertEquals(resolvePort(undefined, 8000), 8000);
});

Deno.test("resolvePort - returns fallback for empty string", () => {
  assertEquals(resolvePort("", 8000), 8000);
  assertEquals(resolvePort("   ", 8000), 8000);
});

Deno.test("resolvePort - parses valid port", () => {
  assertEquals(resolvePort("9001", 8000), 9001);
  assertEquals(resolvePort(" 9001 ", 8000), 9001);
  assertEquals(resolvePort("00080", 8000), 80);
});

Deno.test("resolvePort - rejects non-numeric", () => {
  assertEquals(resolvePort("abc", 8000), 8000);
  assertEquals(resolvePort("123abc", 8000), 8000);
  assertEquals(resolvePort("12.3", 8000), 8000);
  assertEquals(resolvePort("-1", 8000), 8000);
});

Deno.test("resolvePort - rejects out of range", () => {
  assertEquals(resolvePort("0", 8000), 8000);
  assertEquals(resolvePort("65536", 8000), 8000);
});
