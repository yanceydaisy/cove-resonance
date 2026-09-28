# Minimal Listener Protocol — 纯轮询基线

这份文件描述 **Cove Resonance 的 Widget / Host-injection Listener 最小协议**。

V2 正式部署现在有两条可选监听路线：

1. **Widget Listener**：`sync → Host 注入消息 → delivered / dismissed`
2. **Long-wait MCP**：`cove_bridge_wait → wait_ack → reply → next wait`

两条路线共用同一个 Bridge Queue，**正式使用时二选一，不要同时运行**。

本文件只讲第一条路线的最小可移植协议。Long-wait 的实现和边界见 [LONG_WAIT_MCP_EXPERIMENT.zh-CN.md](LONG_WAIT_MCP_EXPERIMENT.zh-CN.md)。

截至 2026-09-28 的 ChatGPT 实测：

- Widget Listener：网页端需要人工确认，桌面端当前不可用，手机端（iOS）可用；
- Long-wait MCP：网页 / 桌面 / 手机均已跑通。

如果你正在适配一个新的 Host，而且它不适合主动注入 `ui/message`，应优先评估 Long-wait，而不是强行复刻 Widget。

---

## 1. 最小目标

只要 Host 能周期性执行一次远程调用，并能把结果注入当前对话，就能实现 Cove Resonance Listener。

最小链路：

```text
timer / manual action
      ↓
cove_bridge_sync
      ↓
Bridge Queue.reserveNext()
      ↓
hidden context
      ↓
foreground user message
      ↓
cove_bridge_delivered
```

**SSE 不是正确性的前提。**

---

## 2. Host 最少需要的能力

推荐能力：

```text
A. 调 Bridge tool / HTTP RPC
B. 注入一条前台 user message
C. 最好能注入隐藏 context
D. 本地保存少量 eventId
E. 周期 timer 或用户手动触发
```

如果没有隐藏 context，也不要重写 Bridge Core；只替换 Host Adapter 的 context 映射。

---

## 3. 最小状态

Listener 本地只需要：

```ts
let running = false
let inFlight = false

recentlyDispatched: Set<eventId>
pendingAcks: Set<eventId>
```

其中：

- `recentlyDispatched`：已经真正显示给 Host 的事件；
- `pendingAcks`：已经显示，但 `delivered` ACK 还没成功的事件。

---

## 4. 最小轮询循环

伪代码：

```ts
async function tick() {
  if (!running || inFlight) return
  inFlight = true

  try {
    // 先补 ACK。已经显示过的事件，绝不重新显示。
    await flushPendingAcks()

    const result = await bridge.call("cove_bridge_sync", {})
    const event = result.meta?.event

    if (!event) {
      // awaitingReply=true 时，说明 required reply 锁仍然占用。
      return
    }

    const id = event.id

    // Host 侧第二层去重。
    if (recentlyDispatched.has(id)) {
      pendingAcks.add(id)
      await flushPendingAcks()
      return
    }

    try {
      await host.updateModelContext(event.modelContext)
      const result = await host.injectUserMessage(event.visibleText)

      if (result.outcome === "dismissed") {
        // Host 已经接管过这次投递，但用户/Host 明确取消。
        // 这是 terminal outcome，不能 release 后让事件复活。
        await bridge.call("cove_bridge_dismissed", { eventId: id })
        return
      }
    } catch (error) {
      // Host Adapter 只应在 ui/message 尚未 handoff 时从这里抛错。
      await bridge.call("cove_bridge_release", { eventId: id })
      throw error
    }

    // accepted：从这里开始，用户可见副作用已经发生。
    recentlyDispatched.add(id)
    pendingAcks.add(id)

    // ACK 失败只重试 ACK，绝对不能 release。
    await flushPendingAcks()
  } finally {
    inFlight = false
  }
}
```

---

## 5. 最简单的启动方式

### Level 0：手动 sync

最弱 Host 甚至不需要 timer。

```text
用户点击“同步”
→ tick()
```

这已经足够验证：

- Queue
- reservation
- Host dispatch
- ACK
- reply route

---

### Level 1：纯轮询

例如：

```ts
running = true
await tick()

setInterval(() => {
  void tick()
}, 3000)
```

3 秒只是示例，不是协议要求。

根据平台限制可以是：

- 1 秒
- 5 秒
- 30 秒
- 60 秒

**轮询间隔只影响延迟，不改变 Bridge 正确性。**

---

### Level 2：Wake + Pull

跑通 Level 1 后再优化：

```text
SSE / WebSocket / native push
        ↓
      wake
        ↓
      tick()
```

同时保留低频 fallback：

```ts
setInterval(() => void tick(), 60_000)
```

因此：

> push for latency, pull for correctness.

---

## 6. 为什么不能让 SSE 直接携带聊天正文

错误设计：

```text
SSE message
→ 直接 injectUserMessage(payload)
```

问题：

- SSE 可能重复；
- reconnect 可能重放；
- 多客户端可能收到同一 push；
- 会绕过 Queue reservation；
- required reply backpressure 会失效。

正确设计：

```text
SSE
→ “有东西了”
→ cove_bridge_sync
→ Queue 决定现在真正允许处理哪条
```

---

## 7. delivered / dismissed / release 的边界

这是移植时最容易写错的地方。不同 Host 可以直接接受 `ui/message`，也可以先要求人工确认；确认 UI 属于 Host 行为，不属于 Bridge 的正确性协议。

### Host 还没显示成功

可以：

```text
release(eventId)
```

让 Queue 稍后重试。

### Host 已接受并显示成功

只能：

```text
retry delivered ACK
```

不能：

```text
release
→ redispatch
```

否则用户会看到同一句被模型处理多次。

### Host 已接管，但用户明确取消

调用：

```text
cove_bridge_dismissed(eventId)
```

这是 terminal outcome。不要 `release`；required reply 的 backpressure 也应该随 dismiss 终结。

---

## 8. required reply 时为什么 sync 可能拿不到下一条

如果当前事件：

```text
replyPolicy=required
```

而 routed reply 还没完成：

```text
cove_bridge_sync
→ hasEvent=false
→ awaitingReply=true
```

这不是错误。

它表示 Conversation backpressure 正在工作。

Host 此时应等待当前回复完成，不要绕开 Queue 自己取下一条。

---

## 9. Host 不支持隐藏 context 时

优先级建议：

```text
1. 原生 hidden/system/context API
2. structured metadata
3. Bridge 服务端持有 route metadata
4. 最后才考虑把最少机器信息拼进可见文本
```

必须尽量保持：

```text
用户可见内容
≠
机器路由协议
```

---

## 10. Host Adapter 最小接口

移植时可以按这个抽象：

```ts
interface MinimalHostAdapter {
  updateModelContext(context: string): Promise<void>
  // Throw only if the message was never handed to the Host.
  injectUserMessage(text: string): Promise<{
    outcome: "accepted" | "dismissed"
  }>

  loadRecentEventIds(): Promise<string[]>
  saveRecentEventIds(ids: string[]): Promise<void>
}
```

Bridge 客户端：

```ts
interface BridgeClient {
  call(name: string, args: Record<string, unknown>): Promise<unknown>
}
```

SSE / WebSocket 不属于这两个接口的必要能力。

它只是一个可选：

```ts
interface WakeAdapter {
  start(onWake: () => void): Promise<void>
  stop(): Promise<void>
}
```

---

## 11. 新客户端适配顺序

给编码 Agent 的推荐顺序：

```text
1. 手动 tick()
2. 纯轮询 tick()
3. hidden context + visible message 分层
4. delivered / release 边界
5. 本地 eventId 去重
6. required reply backpressure
7. routed reply
8. 最后才加 SSE / WebSocket / native push
```

如果 Level 1 还没跑通，不要 debug Level 2。

---

## 12. 当前 ChatGPT MCP Apps Widget 实现

当前参考实现：

```text
src/listener-html.ts
```

启动监听后实际同时存在：

```text
立即 syncOnce()
+
60 秒 fallback polling
+
EventSource wake → syncOnce()
```

所以当前 SSE 版并没有取代轮询协议。

它只是把：

```text
最坏等待一个 polling interval
```

优化成：

```text
事件到达后立即 wake
```

Bridge Core 对两种模式完全相同。


---

## 13. 与 Long-wait MCP 的边界

Widget / Host-injection 路线：

```text
外部事件先发生
→ wake / sync
→ Host 注入一条新消息
→ 开启新的模型处理
```

Long-wait 路线：

```text
用户先开始一个模型 turn
→ cove_bridge_wait 挂起
→ 未来事件到达
→ tool result 返回
→ 同一个 turn 继续
```

所以两者不是“同一个 Listener 的两种传输协议”，而是 **两种不同的 Host dispatch 方式**。

选择原则：

- Host 能可靠主动注入消息：Widget Listener 可用；
- Host 对 `ui/message` 有人工确认、限制或不支持：优先 Long-wait；
- 需要网页 / 桌面 / 手机多端统一：当前优先 Long-wait；
- 不论哪种路线，Queue、事件身份、ACK、reply route 和 backpressure 语义都不能绕开。
