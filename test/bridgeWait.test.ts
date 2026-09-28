import assert from "node:assert/strict";
import test from "node:test";

type RpcResult = {
  result?: {
    structuredContent?: Record<string, unknown>;
  };
};

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const { createHttpServer } = await import("../src/server.js");
  if (previous === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous;

  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function callTool(
  base: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<RpcResult> {
  const response = await fetch(base + "/mcp/music", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200, name);
  return await response.json() as RpcResult;
}

async function enqueue(base: string, eventId: string, source: string, text: string): Promise<void> {
  const response = await fetch(base + "/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId, source, text }),
  });
  assert.equal(response.status, 201);
}

test("long-wait returns an already pending Music event immediately", async () => {
  await withServer(async (base) => {
    await enqueue(base, "wait-immediate-1", "netease.playback", "playback changed");

    const startedAt = Date.now();
    const body = await callTool(base, "cove_bridge_wait", { timeoutSeconds: 2 }, 1);
    const elapsedMs = Date.now() - startedAt;
    const result = body.result?.structuredContent ?? {};

    assert.equal(result.hasEvent, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.eventId, "wait-immediate-1");
    assert.equal(result.source, "netease.playback");
    assert.ok(elapsedMs < 1000, "pending event should not wait for the full timeout");

    await callTool(base, "cove_bridge_wait_ack", { eventId: "wait-immediate-1" }, 2);
  });
});

test("long-wait times out cleanly when no Music event arrives", async () => {
  await withServer(async (base) => {
    const startedAt = Date.now();
    const body = await callTool(base, "cove_bridge_wait", { timeoutSeconds: 1 }, 3);
    const elapsedMs = Date.now() - startedAt;
    const result = body.result?.structuredContent ?? {};

    assert.equal(result.hasEvent, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.awaitingReply, false);
    assert.ok(elapsedMs >= 850, "wait should remain open close to the requested timeout");
    assert.ok(elapsedMs < 2500, "wait should not hang beyond the requested timeout");
  });
});

test("long-wait does not bypass required-reply backpressure", async () => {
  await withServer(async (base) => {
    await enqueue(base, "wait-required-1", "netease.chatroom", "hello from NetEase");

    const first = await callTool(base, "cove_bridge_wait", { timeoutSeconds: 2 }, 4);
    const firstResult = first.result?.structuredContent ?? {};
    assert.equal(firstResult.hasEvent, true);
    assert.equal(firstResult.eventId, "wait-required-1");
    assert.equal(firstResult.replyPolicy, "required");

    const secondStartedAt = Date.now();
    const second = await callTool(base, "cove_bridge_wait", { timeoutSeconds: 2 }, 5);
    const elapsedMs = Date.now() - secondStartedAt;
    const secondResult = second.result?.structuredContent ?? {};

    assert.equal(secondResult.hasEvent, false);
    assert.equal(secondResult.timedOut, false);
    assert.equal(secondResult.awaitingReply, true);
    assert.equal(secondResult.eventId, "wait-required-1");
    assert.ok(elapsedMs < 1000, "backpressure should be reported immediately");

    await callTool(base, "cove_bridge_dismissed", { eventId: "wait-required-1" }, 6);
  });
});
