# Cove Resonance 技术实现说明（面向人类 + Agent）

> 这不是部署教程。  
> 这是一份“把底层思路讲清楚”的实现文档，目标是让不同客户端、不同宿主、不同消息源都能照着这套架构改，而不是死抄当前 NetEase + ChatGPT 版本。

如果你是人类开发者，可以把这份文件直接交给你的编码 Agent / 小机 / IDE Agent，让它先读懂约束，再按你的宿主环境做适配。

---

# 0. 一句话设计

Cove Resonance 不把 AI 搬进外部应用。

它做的是：

```text
外部应用事件
  ↓
Bridge 统一事件模型
  ↓
队列 / 去重 / 路由 / 唤醒
  ↓
官方 AI 客户端里的 Listener
  ↓
把事件变成“当前对话的一条真实消息”
  ↓
模型回复
  ↓
按原 replyRoute 回到外部应用
```

核心理念：

> 不搬 AI，给 AI 修路。

核心状态原则：

> 对话要记忆，状态要新鲜。

---

# 1. 先把系统拆成四层

不要一上来把 NetEase、MCP、SSE、Widget、Queue 全揉在一起。

正确拆法是：

```text
[Ingress Adapter]
      ↓
[Bridge Core]
      ↓
[Host Adapter / Listener]
      ↓
[Reply Egress Adapter]
```

当前实现对应关系：

```text
Ingress Adapter
  └─ NetEase Together Worker + NIM ChatRoom

Bridge Core
  ├─ BridgeEvent
  ├─ Conversation / State Queue
  ├─ replyRoute / replyPolicy
  ├─ reservation / delivered / release
  ├─ reply idempotency
  └─ SSE Wake Hub

Host Adapter
  ├─ MCP App Widget Listener
  │   ├─ tools/call
  │   ├─ ui/update-model-context
  │   └─ ui/message
  └─ Long-wait MCP
      ├─ cove_bridge_wait
      └─ cove_bridge_wait_ack

Reply Egress
  └─ NIM ChatRoom send
```

如果你要适配 Telegram、网页、Slack、Discord、Home App、别的 AI 客户端，只换对应 Adapter。

**Bridge Core 的不变量尽量不要改。**

---

# 2. 这套架构真正要保护的 10 个不变量

任何移植版 Agent 在改代码前都应该先记住这些。

## invariant-1：Wake 不是消息本体

SSE / WebSocket / push / polling 只负责：

```text
“有新东西了，来 sync”
```

不要把完整聊天正文直接塞进 wake channel。

原因：

- wake 可以重复；
- wake 可以丢；
- wake 可以重连；
- payload 如果直接走 wake，很容易绕过幂等与 reservation。

正确设计：

```text
Wake
  ↓
sync()
  ↓
Queue.reserveNext()
  ↓
取权威事件
```

---

## invariant-2：Bridge Queue 才是权威事件源

Host 不直接信外部 push。

外部事件先标准化成 BridgeEvent，再进 Queue。

Host 永远通过 sync 获取“现在允许处理的那一条”。

---

## invariant-3：eventId 必须稳定

一条逻辑事件只对应一个 eventId。

同 eventId：

```text
enqueue 第二次
→ 不创建第二条
```

这让：

- retry
- duplicate push
- host reconnect
- ack retry

都可以围绕同一个身份工作。

---

## invariant-4：Conversation 与 State 不能用同一种语义

聊天消息和播放状态不是一类东西。

### Conversation

```text
A
B
C
```

A/B/C 都有意义，不能因为 C 更新了就把 A/B 丢掉。

所以：

```text
FIFO
不 coalesce
```

### State

例如：

```text
PLAY 00:31
PLAY 00:35
PLAY 00:39
```

如果 Host 还没处理，通常只需要最新状态。

所以：

```text
latest-state-wins
```

当前实现按 `stateKey` 合并 pending state。

---

## invariant-5：required reply 是一个锁

如果某条 Conversation 事件要求回到外部应用：

```text
replyPolicy=required
```

那在它完成 routed reply 前，不应该继续放出下一条 required Conversation。

否则会出现：

```text
用户消息 A
用户消息 B
模型先看到 A 再看到 B
但回复 route / 上下文已经串了
```

当前 Queue 用 outstanding required reply 做 backpressure。

---

## invariant-6：Host 已经显示消息后，绝不能把它重新 release 回 pending

这是很关键的一条。

错误流程：

```text
ui/message 成功
↓
delivered ACK 失败
↓
release(event)
↓
event 再次 pending
↓
同一句又显示一遍
```

正确流程：

```text
ui/message 成功
↓
本地记住 eventId 已显示
↓
ACK 失败
↓
只重试 ACK
↓
绝不再次 ui/message
```

当前 Listener 用 localStorage 保存：

- recently dispatched eventIds
- pending ACK eventIds

---

## invariant-7：Ingress 也必须去重

Bridge eventId 去重只能防 Bridge 内部重复。

外部 SDK 本身可能把同一条消息 callback 多次。

所以 Adapter 入口还要用外部消息身份去重。

当前 NetEase：

```text
NIM client_msg_id_
→ RealtimeChatRoomMessage.messageId
→ handledChatMessageKeys
```

同一个 messageId 只进入 Bridge 一次。

---

## invariant-8：Reply 发送也必须可恢复

一个回复可能拆成多气泡：

```text
bubble 1
bubble 2
bubble 3
```

如果第二条后网络断了，不能重头发。

当前 reply state：

```text
fingerprint
sentCount
completed
inFlight
```

重试时从 sentCount 后继续。

---

## invariant-9：回复 route 属于事件，不属于“当前客户端猜测”

不要让模型凭感觉决定回复到哪里。

BridgeEvent 应明确带：

```text
replyRoute
replyPolicy
```

当前：

```text
netease.chatroom
→ replyRoute=netease.chatroom
→ replyPolicy=required
```

普通 NetEase 状态事件：

```text
replyRoute=netease.chatroom
replyPolicy=optional
```

---

## invariant-10：上下文和前台消息要分层

隐藏上下文：

- eventId
- route
- stream
- stateKey
- full lyrics
- 机器协议说明

前台消息：

- 用户真正发的文本
- 状态事件的自然语言描述

当前 Host 顺序：

```text
ui/update-model-context
↓
ui/message
```

不要把所有机器字段直接塞进用户可见消息。

---

# 3. BridgeEvent：统一中间层

当前事件模型的精神是：

```ts
type BridgeEvent = {
  id: string
  correlationId: string
  kind: "message"
  source: string

  stream: "conversation" | "state"
  stateKey?: string

  replyRoute?: string
  replyPolicy?: "required" | "optional"

  createdAt: string
  visibleText: string
  modelContext: string
}
```

这里最重要的不是字段名，而是职责分离。

## id

Bridge 内的稳定事件身份。

## correlationId

给未来多事件链路留的关联 ID。

当前通常：

```text
correlationId = eventId
```

以后可以出现：

```text
一个外部请求
→ 多个 BridgeEvent
→ 共用 correlationId
```

## source

不要只写业务文本。

它应该足够让路由层分类：

```text
netease.chatroom
netease.music_changed
netease.playback
telegram.message
home.sensor
...```

## stream / stateKey

这是 Queue 语义，不是 UI 分类。

## replyRoute / replyPolicy

这是返程契约。

---

# 4. Queue 状态机

核心文件：

```text
src/queue.ts
```

## 4.1 事件状态

```text
pending
  ↓ reserveNext()
reserved
  ├─ dispatch fail before host accepted → release() → pending
  └─ host accepted → markDelivered() → delivered
```

注意：

```text
delivered != reply completed
```

delivered 只表示：

> Host 已经接受了这条事件。

reply completed 表示：

> 返程消息也已经发完。

两者必须分开。

---

## 4.2 Conversation Queue

Conversation 使用 Map 保持插入顺序。

reserve：

```text
先找 conversation pending
再找 state pending
```

所以 Conversation 优先级高于 State。

---

## 4.3 State Queue

State 用：

```text
statePendingByKey
```

同一个 key 新事件到来：

```text
旧 pending
→ 删除

新 pending
→ 成为该 key 最新 pending
```

如果旧 state 已经 reserved，后来新 state 到了：

- 新 state 留在 pending
- 旧 state 如果 dispatch 失败再 release
- release 时发现存在更新的 pending
- 旧 state 直接删除，不复活

这是“状态要新鲜”的关键实现。

---

# 5. Listener：V2 有两种正式路线

正式部署时，从下面两种 Host dispatch 方式中 **二选一，不要同时运行**：

| 路线 | 工作方式 | 网页端 | 桌面端 | 手机端（iOS） |
| --- | --- | --- | --- | --- |
| Widget Listener | 外部事件到达后，通过 `ui/message` 主动投进对话 | 会出现人工确认 | 当前实测不可用 | 可用 |
| Long-wait MCP | 已经开始的模型 turn 通过 MCP tool 等待未来事件 | 可用 | 可用 | 可用 |

上表是截至 **2026-09-28** 的项目实测。

如果需要跨网页 / 桌面 / 手机保持统一行为，当前优先推荐 Long-wait；如果主要在手机端使用，并希望保留“外部事件主动敲门”的体验，可以选择 Widget Listener。

两者共用同一个 Bridge Queue，同时开启会形成 competing consumers。

## 5.1 Widget / Host-injection：最小纯轮询基线

核心文件：

```text
src/listener-html.ts
src/listenerWake.ts
```

Widget Listener 是 Host Adapter 的一种实现。

它不是业务逻辑中心，也**不要求必须支持 SSE**。

最小 Listener 只需要：

```text
定时 / 手动触发
→ cove_bridge_sync
→ 投递 context
→ 投递 visible message
→ ACK
```

也就是说，**纯轮询就是可移植基线**。SSE / WebSocket / Push 都只是后面的延迟优化。

Widget / Host-injection 路线的最小正确性协议就是：

```text
sync / reserve
→ hidden context
→ visible message
→ delivered / dismissed / release
```

Host 本地至少要记住两类 eventId：

```text
recentlyDispatched
pendingAcks
```

已经显示过的事件如果 ACK 失败，只能重试 ACK，绝不能重新显示。

参考伪代码：

```ts
async function tick() {
  await flushPendingAcks()

  const result = await bridge.call("cove_bridge_sync", {})
  const event = result.meta?.event
  if (!event) return

  if (recentlyDispatched.has(event.id)) {
    pendingAcks.add(event.id)
    return flushPendingAcks()
  }

  try {
    await host.updateModelContext(event.modelContext)
    const handoff = await host.injectUserMessage(event.visibleText)

    if (handoff.outcome === "dismissed") {
      await bridge.call("cove_bridge_dismissed", { eventId: event.id })
      return
    }
  } catch (error) {
    // 只有在 Host 尚未接管消息时才允许 release。
    await bridge.call("cove_bridge_release", { eventId: event.id })
    throw error
  }

  recentlyDispatched.add(event.id)
  pendingAcks.add(event.id)
  await flushPendingAcks()
}
```

## 5.2 Level 0：手动 sync

能力最弱的 Host 甚至不需要 timer：

```text
用户点击“同步”
→ syncOnce()
```

只要这一层能跑通，就已经能验证 Queue、reservation、Host dispatch、ACK 和 routed reply。

## 5.3 Level 1：纯轮询 Listener

最基础实现：

```ts
await syncOnce()

setInterval(() => {
  void syncOnce()
}, 3000)
```

3 秒只是示例。

轮询间隔可以按客户端限制调整。它只影响延迟，不改变 Queue / reply / dedupe 的正确性。

## 5.4 Level 2：Wake + Pull

纯轮询跑通后，再加：

```text
SSE / WebSocket / native push
→ wake
→ syncOnce()
```

同时继续保留低频 fallback poll。

因此 Cove Resonance 的 Listener 设计不是：

```text
SSE 替代轮询
```

而是：

```text
Pull = 正确性基线
Wake = 低延迟加速
```

一句话：

> push for latency, pull for correctness.

---

## 5.5 Long-wait MCP：另一条正式 dispatch 路径

核心文件：

```text
src/bridge/registerWaitTool.ts
```

Long-wait 不调用 `ui/message`。它让一个已经开始的模型 turn 等待 Bridge Queue 的未来事件：

```text
用户明确开始监听
→ cove_bridge_wait
→ reserve event
→ tool result 返回
→ cove_bridge_wait_ack
→ 处理事件
→ required reply（如有）
→ next wait
```

它仍然保留 Queue ordering、eventId、ACK、reply route、reply dedupe 和 backpressure。

它解决的是 Host dispatch 限制，不是后台常驻问题。没有运行中的模型 turn 时，Long-wait 不会凭空启动新 turn。

单次 wait 当前最多 **45 秒**。timeout 是正常边界，不代表监听意图失败；用户仍明确要求继续监听时，可以继续下一轮。

事件到达后的完整事务：

```text
pending
→ reserve
→ cove_bridge_wait 返回 event
→ cove_bridge_wait_ack(eventId)
→ 处理 modelContext / visibleText
→ required cove_bridge_reply（如有）
→ next wait
```

模型侧 ACK 使用 `cove_bridge_wait_ack`。Widget Listener 仍使用 app-only delivered 路径，二者不要混用 ACK 责任。

如果上一条 required event 还没有完成 routed reply，下一次 wait 会立即返回 `awaitingReply=true`，不能绕过 backpressure 去取下一条。

取消中的 wait、timeout、Host 更高层总时长限制都不改变一个原则：Long-wait 只是替换 Host dispatch，不绕开 Queue、reservation、ACK、reply route、去重或 backpressure。

---

# 6. Listener 初始化协议

当前基于 MCP Apps。

Widget 启动：

```text
ui/initialize
↓
ui/notifications/initialized
```

随后保持 idle。

用户明确点击“开始监听”后才：

```text
立即 sync 一次
↓
启动 60 秒 fallback poll
↓
尝试建立 SSE wake channel
```

这里顺序很重要：即使 SSE 完全不可用，Listener 仍然可以靠纯轮询工作。

这是刻意设计的。

不要让“打开 Widget”自动等价于“开始长期监听”。

---

# 7. SSE 只是一种可选 Wake Adapter

先强调一次：

> **SSE 不是 Cove Resonance 的基础协议。基础协议是 sync / reserve / dispatch / ACK。**

如果目标 Host 不支持 EventSource，直接停留在 Level 1 纯轮询即可，不需要修改 Queue 或 reply routing。

当前参考实现：

```text
cove_bridge_listener_session
↓
返回短期单次 token
↓
EventSource(/listener/events?session=...)
↓
event: wake
↓
syncOnce()
```

## 为什么 session token 单次消费

EventSource 原生 API 不方便加 Authorization header。

所以 token 放 query。

为了降低泄露风险：

```text
创建 session
→ token 存 server memory
→ 第一次连接 consume
→ token 立刻删除
→ 已建立连接继续活到 expiresAt
```

当前 TTL：

```text
10 min
```

heartbeat：

```text
20 s
```

session expiry 后 Widget 自动申请新 session。

---

# 8. 为什么还有 60 秒 fallback poll

SSE 不是权威。

它只是低延迟提示。

因此即使：

- wake 丢了
- EventSource 被 Host 暂停
- proxy 中断
- 浏览器后台节流

fallback 仍会周期性：

```text
syncOnce()
```

这叫：

```text
push for latency
pull for correctness
```

如果你移植到别的客户端：

- WebSocket
- APNs
- FCM
- webhook
- long polling

都可以替换 SSE。

只要保留：

```text
wake != payload
sync is authoritative
```

---

# 9. Host 投递事务

当前一次投递：

```text
sync
↓
reserve event
↓
ui/update-model-context
↓
ui/message handoff
├─ accepted  → rememberDispatched → cove_bridge_delivered
├─ dismissed → cove_bridge_dismissed
└─ pre-handoff failure → cove_bridge_release
```

不同 Host 对 `ui/message` 的交互可以不同，这个差异属于 Host adapter，不应该改写 Queue / reply 协议。

截至 2026-09-28，当前 ChatGPT 实测是：网页端会弹出人工确认；桌面端这条 Widget 投递路线不可用；手机端（iOS）可用。如果目标 Host 不适合这条路线，优先选择 Long-wait，而不是修改 Queue Core 去迎合 Host。

## handoff 前失败

例如 `ui/update-model-context` 失败，或者 `ui/message` 尚未真正交给 Host 就报错。

此时用户可见副作用还没发生，可以：

```text
release(eventId)
```

允许重试。

## Host 接受后 ACK 失败

不能 release，只进入：

```text
pendingAcks
```

后续优先 flush ACK，绝不重新 `ui/message`。

## Host / 用户明确取消

如果 Host 已经接管 `ui/message`，并且最终结果是 dismissed / cancelled：

```text
cove_bridge_dismissed(eventId)
```

这是 terminal outcome。不要 release，不要让事件复活；对于 required reply，该 terminal 状态也必须释放 backpressure。

---

# 10. Host 兼容层怎么改

新 Host 的推荐适配顺序：

```text
1. 手动 sync / wait
2. 确认 Queue reservation
3. hidden context 与 visible message 分层
4. delivered / dismissed / release 边界
5. eventId 去重
6. required reply backpressure
7. routed reply
8. 最后再加 SSE / WebSocket / native push
```

如果 Host 本身不支持可靠的主动消息注入，不要硬做 Widget 路线；直接选择 Long-wait 或实现新的 Host Adapter。


如果你的 AI 客户端不是当前 MCP Apps Host，不要硬抄 Widget。

把 Listener 抽象成下面这个接口：

```ts
interface HostAdapter {
  initialize(): Promise<void>

  updateModelContext(event: BridgeEvent): Promise<void>

  injectUserMessage(text: string): Promise<void>

  callBridgeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown>

  loadDedupeState(): Promise<string[]>
  saveDedupeState(ids: string[]): Promise<void>
}
```

不同 Host 只实现这几个动作。

### 如果 Host 支持隐藏上下文

映射：

```text
modelContext
→ hidden/system/context channel
```

### 如果 Host 不支持隐藏上下文

退化方案：

1. 优先使用 Host 的 structured metadata；
2. 再不行，把 routing metadata 放服务端，不交给模型；
3. 需要模型知道的最少协议，用 Host 能支持的非用户可见通道；
4. 最差情况才把必要机器信息与前台消息合并。

不要一上来把整个 modelContext 明文显示给用户。

---

# 11. Reply Routing

当前关键工具：

```text
cove_bridge_reply
```

模型不是直接调用外部 SDK。

模型调用的是 Bridge 的统一 reply API。

Bridge 再根据：

```text
event.replyRoute
```

分发到 egress adapter。

未来可以变成：

```text
replyRoute=telegram.chat
replyRoute=discord.channel
replyRoute=home.notification
replyRoute=netease.chatroom
```

---

# 12. 为什么 required event 可以修正模型传错的 eventId

模型可能在上下文复杂时带一个 stale eventId。

当前逻辑优先：

```text
getOutstandingRequiredReplyEvent()
```

如果存在 active required event：

```text
active event
优先于
模型传入的 stale eventId
```

这是一个“服务端路由锁”。

不要把正确性完全交给模型参数。

---

# 13. Reply fingerprint

同一 event 的回复：

```text
eventId
route
normalized messages[]
```

序列化后 SHA-256。

得到：

```text
fingerprint
```

用途：

- 同一回复并发调用 → suppress
- 已完成再次调用 → suppress
- 未完成重试 → 从 sentCount 继续
- 同一 event 突然换一套不同回复 → 拒绝

这防止模型或 Host 重试造成重复发言。

---

# 14. Natural Bubble 层为什么属于 Bridge

外部 IM 的聊天体验和 ChatGPT 长段落不同。

所以在 reply egress 前做一次：

```text
normalizeReplyBubbles()
```

当前规则：

- 模型本来给 2–5 段：尽量原样保留
- 真正很短的回复：允许 1 段
- 明显很长的单段：按句号 / 换行 / 逗号等自然边界拆
- 不为了数量硬塞 filler

这应该被视为：

```text
transport presentation normalization
```

而不是模型人格逻辑。

---

# 15. NetEase Adapter：当前真实分层

NetEase 不是 Bridge Core。

它只是当前第一个完整 Adapter。

目录：

```text
src/netease/
```

大致拆成：

```text
client.ts
  HTTP API / room / song / lyrics / credentials

togetherWorker.ts
  room lifecycle / polling / adapter orchestration

realtimeTransport.ts
  node-nim native runtime / ChatRoom realtime

playbackState.ts
  cached state + progress extrapolation

lyrics.ts
  timed LRC parse

lyricsContext.ts
  full-song hidden context

accountTools.ts
  account-related MCP tools
```

---

# 16. NetEase 为什么同时有 HTTP 和 NIM

不要把它理解成“重复实现”。

两者职责不同。

## HTTP 更适合

- 当前是否在房间
- 房间 ID
- 邀请
- 当前歌曲 snapshot
- 歌曲详情
- 歌词
- NIM credentials
- reconcile

## NIM realtime 更适合

- ChatRoom 文本
- 播放命令事件
- 实时 link 状态
- 发送 ChatRoom 文本

当前实现：

```text
NIM = realtime primary
HTTP = room/session lifecycle + reconcile / fallback
```

当 realtime 连接正常且状态新鲜时，不再用高频 HTTP snapshot 覆盖 realtime anchor；realtime 断开时则立即允许 HTTP reconcile 接管。

---

# 17. NIM native runtime 的关键经验

当前依赖：

```text
node-nim
```

不是自己重写 WEAPI/EAPI 加密去模拟 realtime 协议。

原则：

> 如果官方/成熟 SDK 已经实现协议栈，不要为了“统一”重写底层加密和长连接。

当前 runtime 设计成：

```text
process 内初始化一次
↓
IM login
↓
ChatRoom requestEnter
↓
ChatRoom enter
↓
绑定 receiveMsg / sendMsg / exit / linkCondition
```

房间变化时尽量复用 native runtime，而不是整进程反复初始化。

---

# 18. ChatRoom 文本解码

当前：

```text
msg_type_ = 0
→ text
```

decode 后统一结构：

```ts
{
  category
  msgType
  senderId
  senderNick
  text
  messageId
  timetagMs
  receivedAtMs
}
```

然后 TogetherWorker：

1. 只处理 text；
2. 过滤自己账号；
3. 按 messageId 去重；
4. emit `netease.chatroom`。

---

# 19. ChatRoom 发送

发送不是调用一个普通 HTTP endpoint。

当前通过 NIM ChatRoom：

```text
buildRealtimeChatTextMessage()
↓
chatroom.sendMsg()
↓
sendMsg callback
↓
code=200
↓
resolve
```

pending send 按 messageId 跟踪。

超时后 reject。

---

# 20. Playback realtime 当前做到哪里

这一层现在已经从“只会 decode”推进到 TogetherWorker 的主播放状态链路。

## 已实现 / 已验证到的部分

`realtimeTransport.ts` 已能从 ChatRoom receiveMsg 中识别 playback envelope。

当前会识别：

```text
event_type = 20000
```

并解出：

```text
serverSeq
clientSeq
senderId
commandType
songId
formerSongId
progressMs
playStatus
receivedAtMs
```

运行日志已经能看到类似：

```text
NetEase realtime playback event:
command=GOTO
songId=...
progressMs=...
serverSeq=...
```

## 当前主链路

现在 playback event 会直接进入 TogetherWorker：

```text
decode
→ stale serverSeq guard
→ playback state update
→ song / pause / resume handling
→ heartbeat 从最新 realtime anchor 继续推进
```

realtime 连接正常且最近状态足够新时，会跳过重复的 HTTP playback reconcile；一旦 realtime 断开，HTTP reconcile 会立即恢复。

因此现在的原则已经不是“HTTP 为主、realtime 只记日志”，而是：

```text
realtime for authority and latency
HTTP for lifecycle, reconcile and fallback
```

---

# 21. Playback 当前调度与控制结构

当前结构：

```text
NIM realtime playback
→ primary state update
→ PLAY / PAUSE / GOTO / PROGRESS 立即生效

HTTP
→ low-frequency reconcile
→ room/session lifecycle
→ realtime gap fallback

Heartbeat
→ 独立 cadence
```

调度职责按三个概念分开处理：

```text
Room / reconcile
Heartbeat
Realtime event handler
```

TogetherWorker 仍负责统一编排，但 realtime 事件可以直接更新状态；HTTP snapshot 只有在需要 reconcile / fallback 时才重新校准；heartbeat 则从当前 anchor 推进进度。

## 播放控制的成功边界

PAUSE / RESUME / GOTO 会先向网易云上报控制命令，但 **HTTP report 成功不等于播放成功**。

控制请求会记录：

```text
commandType
clientSeq
baselineServerSeq
expected sender
expected songId
```

随后必须等匹配的 NIM realtime playback event。只有 sender、`clientSeq`、命令和目标歌曲符合预期，并且 `serverSeq` 比基线新，才完成 pending control。

如果 realtime 当前未连接，Bridge 会拒绝执行这种无法确认的播放控制，而不是返回一个无法验证的成功。

## GOTO / NEXT / ENQUEUE_NEXT

`GOTO` 在上报前先读取 Together playlist。目标歌曲不在当前 `displayList` 时直接拒绝，要求先 enqueue。

`NEXT` 从当前 `ORDER_LOOP displayList` 解析真正的下一首，再复用 realtime-confirmed GOTO。

`ENQUEUE_NEXT` 使用 Together playlist 的队列修改接口更新 `displayList`，随后重新读取 playlist；只有目标歌曲确实紧跟当前歌曲、并且队列版本符合预期，才算成功。

---

# 22. PlaybackStateStore 的 anchor 模型

播放进度不是每秒都去服务器问。

Store 保存一个 anchor：

```text
progressMs at observedAtMs
playStatus
songId
serverSeq
```

读取当前状态时：

如果 PLAY：

```text
estimated =
anchor.progressMs
+ (now - anchor.observedAtMs)
```

如果 PAUSE：

```text
estimated = anchor.progressMs
```

最后 clamp 到 duration。

这让低频 snapshot 也能提供连续进度。

---

# 23. serverSeq 的意义

重复 HTTP poll 很可能返回同一个逻辑 playback command。

如果每次 poll 都把：

```text
observedAtMs = now
```

重新设 anchor，会导致时间基准不断漂移。

因此当前 Store 只有在这些情况替换 anchor：

- songId 变化
- playStatus 变化
- serverSeq 变化
- 没 serverSeq 时 progress 明确变化

这是为了避免“重复 snapshot 让播放时间越来越不准”。

---

# 24. 歌词有两层，不要混

## timed lyrics

`playbackState.ts` 用普通 lrc：

```text
progressMs
→ previous / current / next
```

用于“现在唱到哪”。

## full lyrics context

`lyricsContext.ts` 收集可用：

- lrc
- tlyric
- romalrc
- klyric
- yrc
- ytlrc
- yromalrc

整首作为隐藏上下文。

用途：

- 理解主题
- 理解后文
- 理解前后呼应
- 允许模型知道完整歌曲语义

但文档明确提醒模型：

```text
full lyrics != current playback position
```

当前位置仍以 realtime / playback state 为准。

---

# 25. 为什么 Full Lyrics 在换歌时加载

因为歌词是“song-scoped context”。

最佳生命周期：

```text
song change
↓
load lyrics once
↓
cache currentLyricsModelContext
↓
本歌曲后续 chat / pause / resume event 复用
↓
下一首歌清空
```

不要每条聊天都重新拉一次歌词。

---

# 26. Source Routing：把业务含义集中在一处

当前 `server.ts` 有两类 routing：

```text
replyRoutingFor(source)
streamRoutingFor(source)
```

这是一个很好的 Adapter 边界。

以后新增 source，不要到 Queue / Widget 到处写 if。

集中声明：

```text
source
→ stream
→ stateKey
→ replyRoute
→ replyPolicy
```

---

# 27. 新接一个外部平台时怎么做

假设要接 Telegram。

## Step 1：写 Ingress Adapter

输入：

```text
Telegram update
```

输出：

```text
source=telegram.chat
visibleText=<message text>
externalMessageId=<telegram message id>
modelContext=<optional>
```

## Step 2：入口去重

用：

```text
chatId + messageId
```

作为 external dedupe key。

## Step 3：定义 routing

例如：

```text
telegram.chat
→ stream=conversation
→ replyRoute=telegram.chat
→ replyPolicy=required
```

## Step 4：写 Egress Adapter

统一接口概念：

```ts
send(routeContext, text): Promise<SendResult>
```

## Step 5：不要动 Listener Core

只要事件最终进同一个 Bridge Queue，Host 侧不需要知道 Telegram API。

---

# 28. 如果换 AI 客户端，优先改 Host Adapter，不要改 Bridge Core

不同 AI 客户端可能：

- 没 MCP Apps
- 有插件 Widget 但 API 不同
- 有原生 push
- 有 background task
- 不允许主动 ui/message
- 只允许 tool result
- 需要用户确认

先列能力矩阵：

```text
Can inject hidden context?
Can inject foreground user message?
Can call remote tools?
Can keep a long-lived UI?
Can keep SSE/WebSocket?
Can persist local dedupe IDs?
Can trigger model turn automatically?
```

然后只替换 Host Adapter。

---

# 29. Host 如果不能主动触发模型怎么办

Bridge 仍然有用。

退化为：

```text
外部事件
→ Queue
→ wake UI / notification
→ 用户进入客户端
→ Listener sync
→ 注入消息
```

或者：

```text
外部事件
→ Queue
→ Host 原生 background trigger
→ sync
```

“是否能自动唤醒模型”是 Host capability。

不是 Bridge Event / Queue 的责任。

---

# 30. 不要把客户端兼容写死在服务端

错误做法：

```text
if ChatGPT...
if Client B...
if Client C...
```

全写在 Queue / business worker。

正确做法：

```text
Bridge Core
    ↑↓
Host Adapter interface
    ↑↓
具体客户端
```

---

# 31. 资源 URI 为什么稳定

当前：

```text
ui://widget/cove-bridge.html
```

不把版本号塞进 URI。

原因：

某些 Host 会缓存：

- discovery
- template
- conversation binding
- resource metadata

如果每后端版本都换 URI，容易让同一个 Listener 逻辑出现多个 Host identity。

所以：

```text
resource identity 稳定
implementation 内容升级
```

开发期遇到 Host cache 时，再通过重新连接 / 新会话等方式刷新。

---

# 32. CSP / PUBLIC_ORIGIN

Widget 发网络请求需要 Host 允许。

所以 resource metadata 里：

```text
ui.csp.connectDomains
```

必须包含公开 Bridge origin。

PUBLIC_ORIGIN 是部署参数，不应该硬编码某一台 VPS。

公开版本要求：

```text
BRIDGE_PUBLIC_ORIGIN=https://bridge.example.com
```

---

# 33. 安全边界

## 外部账号凭据只留服务端

例如：

```text
NETEASE_COOKIE
NIM credentials
```

不要：

- 放 Widget
- 放 modelContext
- 返回给模型
- 写 README
- 打完整日志

## status 工具只返回非密钥状态

例如：

```text
connected
roomId
last event
last error
```

不返回 token/password。

## Listener session token

- random 32 bytes
- short-lived
- single-use
- 建连即 consume

---

# 34. 为什么 Queue 现在还是内存

当前优先证明：

```text
routing correctness
host delivery correctness
reply correctness
realtime path correctness
```

持久化还没加。

已知限制：

```text
Bridge process restart
→ pending / reserved / reply state 丢失
```

正式长期运行建议 SQLite。

---

# 35. SQLite 应该持久化什么

Conversation 建议：

```text
eventId
correlationId
source
visibleText / modelContext
createdAt
status
replyRoute
replyPolicy
reservedAt
deliveredAt

replyFingerprint
replySentCount
replyCompleted
replyCompletedAt
```

State 不一定要完整历史。

更合理：

```text
按 stateKey 保存 latest snapshot
+ 少量审计 history
```

不要把陈旧 PLAY/PROGRESS 事件全 replay 回模型。

---

# 36. Crash consistency 要注意的点

SQLite 版要避免：

```text
外部 send 成功
↓
进程 crash
↓
sentCount 还没 commit
↓
重启后重复发
```

更严格版本需要：

- egress provider idempotency key（如果支持）
- send journal
- transaction
- provider receipt

当前内存版只能做到进程内幂等。

---

# 37. 多 Listener 是未来需要显式设计的

当前系统主要按“一个目标 Conversation / 一个活跃 Listener”思路工作。

如果以后允许多 Listener：

必须决定：

```text
fan-out?
competing consumers?
per-conversation queue?
per-listener lease?
```

不要直接让两个 Listener 同时抢同一个 Conversation Queue。

---

# 38. 当前代码地图

Agent 改代码前先读：

```text
src/server.ts
  HTTP ingress + MCP transport composition

src/types.ts
  Bridge event/reply types

src/queue.ts
  queue semantics + reply state

src/bridge/events.ts
  BridgeEvent construction + source / stream / reply routing

src/bridge/registerApp.ts
  stable Widget resource + open tool + listener session

src/bridge/registerTools.ts
  shared sync / delivered / dismissed / release / routed reply tools

src/profiles.ts
  backward-compatible `/mcp` + Music-scoped `/mcp/music`

src/mcp.ts
  thin MCP composition layer

src/listener-html.ts
  Host Widget + SSE + dispatch + client dedupe

src/listenerWake.ts
  SSE session + wake hub

src/replyBubbles.ts
  outbound bubble normalization

src/netease/registerTogetherTools.ts
  Together Music V2 MCP tool surface

src/netease/togetherWorker.ts
  NetEase orchestration + realtime-primary playback + confirmed controls

src/netease/realtimeTransport.ts
  node-nim native realtime

src/netease/nimTicketBootstrap.ts
  isolated NIM ticket bootstrap child

src/netease/playbackState.ts
  current playback cache + progress anchor

src/netease/lyricsContext.ts
  full-song hidden context
```

---

# 39. Agent 修改规则

如果你把这份文档交给编码 Agent，建议同时给它下面这些规则。

## Rule A：先定位层，不要全局重写

问题属于：

- Adapter
- Queue
- Listener
- Reply
- Playback

先定位，再改。

## Rule B：最小 diff

已经跑通的 NIM ChatRoom / Bridge / Widget 不要因为增加一个功能被整体重构。

## Rule C：每个 retry 都问一句

> 这个 retry 会不会造成用户可见副作用重复？

尤其：

- ui/message
- ChatRoom send
- notification
- payment-like action

## Rule D：每个 push 都问一句

> push 是权威数据，还是只应该当 wake？

默认后者。

## Rule E：状态和对话永远分开想

不要为了“统一事件系统”把所有东西都做 FIFO。

## Rule F：未验证功能必须标 experimental / roadmap

不能因为代码“看起来写了”就写成“已经跑通”。

---

# 40. 当前 verified / experimental 边界

## 已经实际跑通过

- MCP Bridge 基础挂载
- Listener 手动开始/停止
- 通用事件 sync
- NetEase room/session HTTP path
- NIM native runtime 初始化
- NIM ChatRoom enter
- NIM ChatRoom 文本 realtime receive
- NIM ChatRoom 文本 send
- NetEase ChatRoom → ChatGPT
- ChatGPT → NetEase ChatRoom routed reply
- required reply backpressure
- reply bubble send resume / dedupe
- Conversation / State split
- full lyrics hidden context
- playback event decoder
- NIM playback realtime 驱动 TogetherWorker 主状态，HTTP reconcile / fallback
- realtime-confirmed PAUSE / RESUME / GOTO / NEXT
- playlist-confirmed `ENQUEUE_NEXT`
- GOTO 对 `displayList` 外目标的拒绝保护
- SSE endpoint public streaming
- short-lived single-use listener token
- EventSource Listener implementation
- human-confirmed `ui/message` dismissed terminal handling
- NIM messageId duplicate suppression
- Widget eventId duplicate suppression
- `/mcp` 向后兼容 + `/mcp/music` Music profile

## 已实现但仍在继续做端到端稳定性验收

- SSE wake 在实际长时间 Listener 中的稳定性
- reconnect + ACK 边界下的重复投递保护

## 还没有宣称完成

- SQLite persistence
- crash-safe reply journal
- multi-listener semantics
- unattended Listener watchdog
- 一键部署
- 多外部平台 adapter

---

# 41. 推荐的开发验证顺序

永远从底往上。

```text
1. npm test
2. npm run build
3. health
4. MCP discovery
5. Widget mount
6. POST /events
7. sync
8. ui/message
9. delivered ACK
10. SSE wake
11. external Adapter receive
12. routed reply
13. reconnect
14. duplicate injection
15. process restart
```

如果第 6 层都没通，不要去 debug NIM。

---

# 42. 最小测试事件比真实平台更重要

保留：

```text
POST /events
```

是为了能把 Bridge Core 和 NetEase 分开验收。

一个适配器出问题时：

```text
/manual event 正常
NetEase event 不正常
```

立刻知道问题在 Adapter，不在 Host / Queue。

---

# 43. Debug 日志应该围绕身份打印

排重复、串线问题最有用的不是打印全文。

建议打印：

```text
eventId
external messageId suffix
source
stream
stateKey
replyPolicy
queue status
fingerprint prefix
sentCount
serverSeq
songId
```

敏感内容只打印长度或短 preview。

---

# 44. 为什么我们没把所有功能塞到 MCP tool 里

MCP tool 很适合：

- pull state
- send command
- sync event
- reply

但“外部世界主动发生了一件事”仍然需要一个 wake mechanism。

所以完整链路是：

```text
external event
→ server state
→ wake
→ Host calls MCP tool
```

MCP 是控制/取数通道。

SSE 是低延迟唤醒通道。

Queue 是一致性通道。

三者不是同一个东西。

---

# 45. 为什么这套东西能推广到别的客户端

因为真正不可替代的不是 SSE，也不是 MCP。

不可替代的是这些协议语义：

```text
stable identity
authoritative queue
reservation
ack
dedupe
reply route
backpressure
conversation/state distinction
```

只要新客户端能实现一个 Host Adapter，这套 Bridge Core 就能继续用。

---

# 46. 给 Agent 的移植任务模板

可以直接复制下面这段给任何编码 Agent。

```text
你正在把 Cove Resonance 适配到一个新的 AI Host / 外部平台。

先阅读：
- AGENTS.md
- docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md
- src/types.ts
- src/queue.ts
- src/server.ts
- src/mcp.ts
- src/listener-html.ts

必须保留这些不变量：
1. wake 只做提示，真实 payload 必须通过权威 sync/queue 获取；
2. Conversation FIFO，State latest-state-wins；
3. eventId 稳定且幂等；
4. required reply 未完成时继续 backpressure；
5. Host 已经显示事件后，ACK 失败只能重试 ACK，不能重新显示；
6. ingress 必须按外部 message id 去重；
7. reply 必须有 fingerprint/sentCount/completed 语义；
8. reply route 由事件决定，不由模型猜；
9. 未验证能力标 experimental，不得假装已跑通。

先给出适配层设计和最小 diff 方案，再改代码。
不要重写已经跑通的底层协议层，除非有明确证据证明必须改。
```

---

# 47. 最后：我们真正想开源的不是“网易云脚本”

NetEase Together 是第一个验证场景。

真正想留下来的东西是：

```text
External world
   ⇅
Adapters
   ⇅
Cove Bridge Core
   ⇅
Host Adapter
   ⇅
Official AI client
```

如果未来某个平台协议全部变了，只要：

- BridgeEvent
- Queue semantics
- Wake/pull split
- Host delivery transaction
- Reply route
- idempotency

还在，这个项目就没有推倒重来。

这就是 Cove Resonance 的底层架构。
