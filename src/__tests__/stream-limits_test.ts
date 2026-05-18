import { assertEquals, assertRejects } from "@std/assert";
import { AppState, state } from "../state.ts";
import {
  acquireProxyStreamSlots,
  boundProxyResponseBody,
  resetProxyStreamCountersForTests,
} from "../stream-limits.ts";

async function setupKv(): Promise<Deno.Kv> {
  const kv = await Deno.openKv(":memory:");
  Deno.env.set("KEY_ENCRYPTION_SECRET", "test-key-encryption-secret");
  Object.assign(state, new AppState());
  state.kv = kv;
  await resetProxyStreamCountersForTests();
  return kv;
}

Deno.test("boundProxyResponseBody - cancels upstream on downstream cancel", async () => {
  let canceled = false;
  let released = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
    },
    cancel(reason) {
      canceled = reason === "client gone";
    },
  });

  const reader = boundProxyResponseBody(
    source,
    () => {
      released = true;
      return Promise.resolve();
    },
    { maxBytes: 1024, totalTimeoutMs: 1000, idleTimeoutMs: 1000 },
  ).getReader();

  assertEquals((await reader.read()).done, false);
  await reader.cancel("client gone");

  assertEquals(canceled, true);
  assertEquals(released, true);
});

Deno.test("boundProxyResponseBody - rejects response body over byte limit", async () => {
  let released = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2));
    },
    cancel() {
      throw new Error(
        "source cancel should not be required after controller error",
      );
    },
  });

  const reader = boundProxyResponseBody(
    source,
    () => {
      released = true;
      return Promise.resolve();
    },
    { maxBytes: 1, totalTimeoutMs: 1000, idleTimeoutMs: 1000 },
  ).getReader();

  await assertRejects(
    () => reader.read(),
    Error,
    "upstream stream body too large",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(released, true);
});

Deno.test("boundProxyResponseBody - releases when source cancel rejects", async () => {
  let released = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      throw new Error("cancel failed");
    },
  });

  const reader = boundProxyResponseBody(
    source,
    () => {
      released = true;
      return Promise.resolve();
    },
    { maxBytes: 1024, totalTimeoutMs: 1000, idleTimeoutMs: 1000 },
  ).getReader();

  assertEquals((await reader.read()).done, false);
  await assertRejects(
    () => reader.cancel("client gone"),
    Error,
    "cancel failed",
  );

  assertEquals(released, true);
});

Deno.test("boundProxyResponseBody - releases when timeout races with pull error", async () => {
  let readRejected = false;
  let released = false;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      readRejected = true;
      throw new Error("read failed");
    },
    cancel() {
      throw new Error("cancel failed");
    },
  });

  const reader = boundProxyResponseBody(
    source,
    () => {
      released = true;
      return Promise.resolve();
    },
    { maxBytes: 1024, totalTimeoutMs: 0, idleTimeoutMs: 1000 },
  ).getReader();

  await assertRejects(() => reader.read(), Error);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(readRejected, true);
  assertEquals(released, true);
});
Deno.test("acquireProxyStreamSlots - enforces public bucket concurrency", async () => {
  const kv = await setupKv();

  try {
    const slots = [];
    for (let i = 0; i < 4; i++) {
      const slot = await acquireProxyStreamSlots(undefined);
      assertEquals(slot.acquired, true);
      if (!slot.release) throw new Error("stream release missing");
      slots.push(slot);
    }

    const limited = await acquireProxyStreamSlots(undefined);
    assertEquals(limited.acquired, false);
    assertEquals(limited.retryAfterSec !== undefined, true);

    await slots[0].release!();
    const afterRelease = await acquireProxyStreamSlots(undefined);
    assertEquals(afterRelease.acquired, true);
    if (!afterRelease.release) throw new Error("stream release missing");
    await afterRelease.release();

    await Promise.all(slots.slice(1).map((slot) => slot.release!()));
  } finally {
    kv.close();
  }
});
