# Long-wait MCP Listener 实验

> 状态：experimental。  
> 这是一条 **替代 Host Listener** 路线，不取代默认的 MCP App Widget + `ui/message` 方案。

## 为什么有这一版

默认 Listener 的最后一跳是：

```text
Bridge Queue
→ Widget sync
→ ui/update-model-context
→ ui/message
→ ChatGPT turn
```

这条路线的优点是：外部事件可以在当前没有模型 turn 的时候主动敲进对话。

但 `ui/message` 的实际交互由 Host 决定。某些 Host 可能直接接受，也可能要求人工确认。

Long-wait MCP 实验绕开最后这一跳：

```text
用户先启动一个 ChatGPT turn
→ 模型调用 cove_bridge_wait
→ MCP 请求保持等待
→ Bridge 外部事件进入 Queue
→ cove_bridge_wait 返回 tool result
→ 同一个模型 turn 继续执行
```

事件不是新的 `ui/message`，而是 **当前正在执行的 MCP tool call 的结果**。

## 当前工具

```text
cove_bridge_wait
```

默认最长等待：

```text
45 s
```

可传：

```json
{
  "timeoutSeconds": 45
}
```

当前上限也是 45 秒。第一版故意不做无限等待，因为不同 Host / proxy / MCP client 可能有自己的请求生命周期。

## 事件到达后的事务

`cove_bridge_wait` 会沿用原 Queue：

```text
pending
→ reserve
→ tool result
```

模型拿到 `hasEvent=true` 后应立即：

```text
cove_bridge_delivered(eventId)
```

然后再按返回的 `modelContext`、`visibleText`、`replyRoute`、`replyPolicy` 处理事件。

如果 `replyPolicy=required`，必须先完成 `cove_bridge_reply`，之后才能再次调用 `cove_bridge_wait`。

因此 long-wait 不绕开 Queue ordering、reservation、delivered ACK、required-reply backpressure、reply dedupe 和 source routing。它只替换 Host dispatch 这一层。

## timeout 不是错误

没有事件时：

```json
{
  "hasEvent": false,
  "timedOut": true,
  "awaitingReply": false
}
```

如果用户明确要求继续监听，模型可以再次调用 `cove_bridge_wait`。

不要把 timeout 当失败，也不要未经用户要求创建永久 tool loop。

## required reply backpressure

如果上一条 required event 还没完成回复，工具会立即返回 `awaitingReply=true` 和当前 `eventId`。此时不要等待下一条，先完成当前 `cove_bridge_reply`。

## 与 Widget Listener 的关系

**不要同时运行。** 两者都会从同一个 Queue reserve event，同时运行会形成 competing consumers。一次实验只选一种 Listener。

## 它能解决什么，不能解决什么

它可能绕开 `ui/message` Host confirmation、Widget renderer 不支持、Widget 后台 suspend，以及 SSE → Widget 最后一跳差异，因为它根本不依赖主动 `ui/message`。

但它不能让“完全没有运行中的模型 turn”凭空启动一个新 turn。

所以它更像：

> **把一个已经开始的 turn 挂成等待外部事件的值班窗口。**

默认 Widget 方案则更像：

> **外部事件到来以后，再主动敲门启动新 turn。**

两条路线解决的是不同 Host 能力边界。

## 当前验证边界

服务器侧已经验证：pending event 会立即返回；空队列会按 timeout 返回；required reply backpressure 不会被绕过；公网 HTTPS MCP 请求可以真实挂起，并在另一条请求 enqueue event 后提前返回；默认 V2 测试与 build 继续通过。

仍需真实 Host 验证：ChatGPT 是否允许该 MCP tool call 持续等待；45 秒等待期间是否被 Host 提前取消；tool result 到达后是否能自然继续同一模型 turn；连续多轮 wait → event → reply → wait 的实际 tool-loop 上限。

在这些验证完成前，不把它标成默认 Listener。
