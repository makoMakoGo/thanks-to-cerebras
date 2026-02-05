import { assertEquals, assertMatch } from "@std/assert";

import { generateProxyKey } from "../keys.ts";

Deno.test("generateProxyKey - 格式和长度", () => {
  const key = generateProxyKey();

  assertEquals(key.startsWith("cpk_"), true, "密钥应以 cpk_ 开头");
  assertEquals(key.length, 36, "密钥长度应为 36 字符");
  assertMatch(key, /^cpk_[A-Za-z0-9_-]+$/, "密钥应只包含 base64url 字符");
});

Deno.test("generateProxyKey - 唯一性", () => {
  const keys = new Set<string>();
  const count = 1000;

  for (let i = 0; i < count; i++) {
    keys.add(generateProxyKey());
  }

  assertEquals(keys.size, count, "生成的密钥应该是唯一的");
});
