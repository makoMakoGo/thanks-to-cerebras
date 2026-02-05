import { assert, assertEquals } from "@std/assert";

import {
  hashPassword,
  PBKDF2_ITERATIONS,
  verifyPbkdf2Password,
} from "../crypto.ts";

Deno.test("hashPassword - 版本化格式", async () => {
  const password = "test123";
  const hash = await hashPassword(password);

  const parts = hash.split("$");
  assertEquals(parts.length, 5, "哈希应包含 5 个部分");
  assertEquals(parts[0], "v1", "版本应为 v1");
  assertEquals(parts[1], "pbkdf2", "算法应为 pbkdf2");
  assertEquals(
    parts[2],
    String(PBKDF2_ITERATIONS),
    `迭代次数应为 ${PBKDF2_ITERATIONS}`,
  );

  assert(parts[3].length > 0, "盐不应为空");
  assert(parts[4].length > 0, "密钥不应为空");
});

Deno.test("hashPassword - 相同密码不同盐产生不同哈希", async () => {
  const password = "test123";
  const hash1 = await hashPassword(password);
  const hash2 = await hashPassword(password);

  assertEquals(hash1 !== hash2, true, "相同密码应产生不同哈希（不同盐）");
});

Deno.test("verifyPbkdf2Password - 正确密码验证成功", async () => {
  const password = "mypassword";
  const hash = await hashPassword(password);
  const result = await verifyPbkdf2Password(password, hash);

  assertEquals(result, true, "正确密码应验证成功");
});

Deno.test("verifyPbkdf2Password - 错误密码验证失败", async () => {
  const password = "mypassword";
  const hash = await hashPassword(password);
  const result = await verifyPbkdf2Password("wrongpassword", hash);

  assertEquals(result, false, "错误密码应验证失败");
});

Deno.test("verifyPbkdf2Password - 格式错误的哈希拒绝", async () => {
  const invalidHashes = [
    "invalid",
    "v1$pbkdf2$100000",
    "v2$pbkdf2$100000$salt$key",
    "v1$sha256$100000$salt$key",
  ];

  for (const hash of invalidHashes) {
    const result = await verifyPbkdf2Password("anypassword", hash);
    assertEquals(result, false, `格式错误的哈希应拒绝：${hash}`);
  }
});

Deno.test("verifyPbkdf2Password - 确定性验证（相同输入相同结果）", async () => {
  const password = "test123";
  const salt = new Uint8Array(16).fill(42);
  const hash = await hashPassword(password, salt);

  const result1 = await verifyPbkdf2Password(password, hash);
  const result2 = await verifyPbkdf2Password(password, hash);
  const result3 = await verifyPbkdf2Password(password, hash);

  assertEquals(result1, true);
  assertEquals(result2, true);
  assertEquals(result3, true);
});
