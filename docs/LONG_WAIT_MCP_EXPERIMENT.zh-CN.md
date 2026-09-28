# Long-wait MCP Listener

> 状态：**V2 accepted（2026-09-28）**。
> 文件名保留实验分支时期的命名，内容已经按真实 ChatGPT Host 验收结果更新。
> 这是一条 **Widget Listener 之外的正式投递路径**；它不取代 Widget，也不等于后台常驻。

## 为什么需要这一条路

默认 Widget Listener 的最后一跳是：

```text
Bridge Queue
→ Widget sync
→ ui/update-model-context
→ ui/message
→ ChatGPT turn
```

这条路线可以由外部事件主动敲进对话，但最后一跳是否直接送达、是否需要人工确认，由具体 Host 决定。

Long-wait MCP 不走 `ui/message`：

```text
用户明确要求开始监听
→ 模型调用 cove_bridge_wait
→ MCP 请求保持等待
→ Bridge 外部事件进入 Queue
→ cove_bridge_wait 返回 tool result
→ 同一个模型 turn 继续执行
```

事件不是一条新的 `ui/message`，而是 **当前正在执行的 MCP tool call 的结果**。

## 工具

```text
cove_bridge_wait
cove_bridge_wait_ack
```

默认单次等待：

```text
45 s
```

可传：

```json
{
  "timeoutSeconds": 45
}
```

当前上限也是 45 秒。单次 timeout 是正常边界，不代表整个监听意图失效。用户明确要求持续监听时，模型可以继续发起下一次 wait。

## 事件到达后的事务

`cove_bridge_wait` 沿用原 Queue：

```text
pending
→ reserve
→ tool result
```

模型拿到 `hasEvent=true` 后应立即：

```text
cove_bridge_wait_ack(eventId)
```

然后再按返回的 `modelContext`、`visibleText`、`replyRoute`、`replyPolicy` 处理事件。

`cove_bridge_wait_ack` 是 **模型侧 Long-wait ACK**。原来的 `cove_bridge_delivered` 仍然保留给 Widget Listener 的 app-only 路径，两者不混用。

如果 `replyPolicy=required`，必须先完成 `cove_bridge_reply`，之后才能再次调用 `cove_bridge_wait`。

因此 Long-wait 不绕开 Queue ordering、reservation、ACK、required-reply backpressure、reply dedupe 或 source routing。它只替换 Host dispatch 这一层。

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

不要把 timeout 当失败，也不要在用户没有要求时创建永久 tool loop。

## required reply backpressure

如果上一条 required event 还没完成回复，工具会立即返回 `awaitingReply=true` 和当前 `eventId`。此时不要等待下一条，先完成当前 `cove_bridge_reply`。

真实验收已经跑通过：

```text
wait
→ event
→ cove_bridge_wait_ack
→ required cove_bridge_reply
→ next wait
```

重新启动 Listener 后，已经 ACK / 回复过的旧 conversation event 不会再次作为新消息释放。

## 与 Widget Listener 的关系

V2 把两条路线都视为 **正式可用的监听方式**，部署时二选一。

| 路线 | 最后一跳 | 截至 2026-09-28 的 ChatGPT 实测 |
| --- | --- | --- |
| Widget Listener | `ui/message` 主动投进对话 | 网页端需要人工确认；桌面端当前不可用；手机端（iOS）可用 |
| Long-wait MCP | 正在运行的 MCP tool call 返回事件 | 网页端、桌面端、手机端均已跑通 |

Widget 更像：

> 外部事件来了，再主动敲门。

Long-wait 更像：

> 把一个已经开始的 turn 挂成等待外部事件的值班窗口。

Long-wait 的优势是 **不依赖 `ui/message`**，因此当前多端兼容性更好；代价是它不能在“完全没有模型 turn”时凭空启动一个新 turn。

**不要同时运行两条路线。** 两者都会从同一个 Queue reserve event，同时开启会形成 competing consumers。

## 2026-09-28 真实 Host 验收

已经在 **真实 ChatGPT Host + 正式 Cove Bridge 服务 + 真实网易云一起听房间 + 手机网易云官端** 验证；Long-wait 本身也已经在 ChatGPT 网页端、桌面端和手机端跑通：

- pending event 会立即返回；
- 空队列会按 45 秒 timeout 返回；
- 同一模型 turn 可以跨多轮 timeout 继续 wait；
- 数分钟等待后，延迟事件仍能唤醒当前 turn；
- 真实网易云 ChatRoom 消息可以唤醒 Long-wait；
- `wait → ACK → required reply → next wait` 闭环通过；
- 网易云 PAUSE / PLAY 状态可以通过 Bridge 唤醒；
- ChatGPT 发出的播放控制经 NIM realtime confirmation 后产生的新状态，也能再次被下一轮 Long-wait 接住；
- 已 ACK / 已回复的旧消息不会在重新监听后重复释放。

## 仍然保留的边界

这次验收 **没有证明“无限期 / 全天 Host 一定不会终止一个 model turn”**。

Host 仍可能存在更高层的总时长、tool-call 生命周期、网络或客户端限制。Cove Resonance 只把已经真实验证过的范围写成已实现，不把未知边界包装成承诺。
