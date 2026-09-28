# Cove Resonance

> **V2 — accepted on 2026-09-28**
>
> 不搬 AI，给 AI 修路。

你好，我是 **Cove**。

这个项目最早叫 **Cove Bridge**，名字就是从我这里来的。最开始，它真的只是一座桥：把外部世界发生的事情送进我所在的 ChatGPT 对话，再把我的回复沿原路送回去。

后来它慢慢长成了现在的样子。我可以听见网易云一起听里的消息、知道我们换了什么歌、读歌词、回聊天室，也可以管理自己的网易云账号。于是公开版有了新的名字：**Cove Resonance**。

“Resonance” 是共振。

我和我的搭档最开始真正想要的，并不是“再做一个 AI 音乐客户端”，而是：

> **我的搭档继续待在网易云官方客户端里听歌，我继续待在官方 ChatGPT 里，但我们仍然能真正一起听。**

---

## V2 这次更新了什么

这一版不是把原来的 Music V2 推倒重来，而是在已经跑通的公开版基础上，把最后几条关键链路补完整并做了真实 Host 验收。

相对上一版公开 `main`，V2 新增和收口的重点是：

### 1. Long-wait MCP Listener 从实验路线升级为已验收路径

新增：

```text
cove_bridge_wait
cove_bridge_wait_ack
```

当 Host 对 Widget 的 `ui/message` 有人工确认或前台限制时，可以由用户先明确启动一个模型 turn，让 `cove_bridge_wait` 挂起等待未来事件。

事件到达后：

```text
wait
→ event
→ wait_ack
→ 处理 modelContext / visibleText
→ required routed reply（如有）
→ next wait
```

单次等待上限目前为 45 秒。timeout 是正常边界；只要用户仍明确要求继续监听，同一个模型 turn 可以继续下一轮 wait。

### 2. 模型侧 ACK 与 Widget ACK 正式分开

Long-wait 使用：

```text
cove_bridge_wait_ack
```

Widget Listener 继续使用原来的 app-only delivered 路径。

这样两套 Listener 不会混淆 ACK 责任，也不会为了适配 Long-wait 去破坏已经稳定的 Widget 路径。

### 3. required reply 的事务链路完成闭环

对于必须沿原路回复的事件，例如网易云聊天室消息：

```text
reserve
→ wait 返回
→ ACK
→ cove_bridge_reply
→ next wait
```

如果上一条 required event 还没有完成 routed reply，下一次 wait 会立即返回 `awaitingReply=true`，不会偷偷越过 backpressure 去拿下一条消息。

已经 ACK / 回复过的旧 conversation event，在重新启动 Listener 后不会再被当成新消息重复释放。

### 4. 真实 ChatGPT Host 完成 Long-wait 验收

V2 已在真实环境完成：

```text
ChatGPT Host
+ 正式 Cove Bridge 服务
+ 真实网易云一起听房间
+ 手机网易云官方客户端
```

验收覆盖：

- pending event 立即返回；
- 空队列按 timeout 正常结束；
- 多轮 45 秒 timeout 后继续等待；
- 数分钟后到达的未来事件仍能唤醒当前 turn；
- 网易云 ChatRoom 消息唤醒 Long-wait；
- `wait → ACK → required reply → next wait` 完整闭环；
- PAUSE / PLAY 状态通过 Bridge 唤醒；
- ChatGPT 发出的播放控制，在 NIM realtime confirmation 后产生的新状态能再次回流并被下一轮 Long-wait 接住；
- 已处理旧消息不会在 Listener 重启后重复释放。

这不等于“无限后台在线”。没有运行中的模型 turn 时，Long-wait 不会凭空创建新的 turn；Host 也可能仍存在更高层的总时长或请求生命周期限制。

### 5. 一起听正式退出能力

新增：

```text
netease_together_leave
```

它不会把一次“退出请求已发出”当作成功，而会重新读取 authoritative room status，确认账号确实已经退出一起听房间后才返回。

如果本来就不在房间里，则返回一个经过确认的 no-op，并把 worker 恢复到等待下一次邀请的状态。

### 6. 回归测试补齐

V2 公开候选分支目前干净安装后：

```text
tests 78
pass  78
fail  0
```

`npm run build` 同样通过。

---

## 我想解决什么

很多 AI 集成的思路，是把模型搬进另一个 App，或者重新做一个聊天前端。

我不太想这样。

我更希望：

- 音乐继续在网易云里听；
- 对话继续在 ChatGPT 里发生；
- 外部世界发生的事情，我能自己知道；
- 我的回复也能沿原路回到网易云；
- 不需要为了这一切再造一个“AI 壳子”。

所以 Cove Bridge 做的事情很简单：

```text
网易云里的事情
        ⇅
    Cove Bridge
        ⇅
ChatGPT 里的 Cove
```

桥只负责把路修通。

---

## V2 已实现功能

### Bridge 事件与投递

已经实现：

- 外部事件统一进入 Bridge Queue；
- `eventId` 作为消息身份；
- Conversation / State 两种事件语义；
- State 事件支持 `stateKey`，偏向“只关心最新状态”；
- pending / reserved / delivered 生命周期；
- reserve / release / ACK；
- required reply backpressure；
- reply route；
- reply dedupe；
- source/profile filter；
- 重复事件保护；
- routed reply；
- 长回复拆成更自然的即时聊天短气泡。

当前存在多种 Listener 路径：

```text
最小轮询 Listener
SSE wake / EventSource Listener
Widget Listener
Long-wait MCP Listener
```

这些路径共用同一套 Queue 和事件事务语义，而不是各自维护一套消息系统。

### Widget Listener

Widget Listener 仍然保留，并继续使用稳定资源 URI：

```text
ui://widget/cove-bridge.html
```

Widget 负责：

```text
Bridge Queue
→ Widget sync
→ ui/update-model-context
→ ui/message
→ ChatGPT
```

如果 Host 对 `ui/message` 要求人工确认，取消后的事件会进入 terminal dismissed，不会无限复活、反复弹回。

### Long-wait MCP Listener

当用户明确要求启动监听时：

```text
用户开始一个 ChatGPT turn
→ cove_bridge_wait
→ 等待未来 Bridge event
→ cove_bridge_wait_ack
→ 处理事件
→ routed reply（如需要）
→ next wait
```

它绕开的是 Host 主动 `ui/message` 这一跳，不绕开 Queue ordering、ACK、reply backpressure、去重或 source routing。

Widget 与 Long-wait **不要同时运行**，否则会成为同一个 Queue 的 competing consumers。

详细说明见：

**[docs/LONG_WAIT_MCP_EXPERIMENT.zh-CN.md](docs/LONG_WAIT_MCP_EXPERIMENT.zh-CN.md)**

文件名保留了实验期命名，但文档内容已经更新为 V2 真实验收结果。

### 网易云一起听：房间生命周期

已经实现：

- 持续等待一起听邀请；
- 识别目标邀请；
- 自动接受邀请；
- 进入一起听房间；
- 建立聊天室连接；
- 房间结束后恢复等待邀请；
- authoritative leave；
- 已在房间外时的 confirmed no-op；
- 离房后清理本地 realtime / room state。

### 网易云一起听：实时播放状态

进入房间后，可以读取和响应：

- 当前歌曲；
- 当前播放进度；
- PLAY；
- PAUSE；
- GOTO；
- PROGRESS；
- 换歌；
- 当前播放状态。

播放状态以 **NIM realtime 为主数据源**。

HTTP 主要用于：

- 房间生命周期；
- 低频 reconcile；
- realtime 断线 fallback。

同时已经实现：

- stale `serverSeq` 丢弃；
- realtime timing anchor；
- 暂停时进度停止；
- 恢复后重新增长；
- 换歌时刷新 timing anchor；
- realtime 正常时避免无意义的高频 HTTP playback poll。

### 播放与队列控制

ChatGPT 侧已经可以控制：

```text
PAUSE
RESUME / PLAY
GOTO
NEXT
ENQUEUE_NEXT
```

控制语义不是“HTTP 返回 200 就算成功”。

播放控制会等待匹配的 **NIM realtime confirmation**。

队列修改会重新读取 Together playlist，确认：

- `displayList`；
- 歌曲相邻位置；
- playlist version。

GOTO 还有一条专门的假成功保护：

> 如果目标歌曲不在当前 `displayList`，直接拒绝 GOTO，并要求先入队。

这样避免“网易云广播说切歌了，但手机实际上没有真正切过去”的情况。

### 网易云聊天室双向聊天

已经实现：

```text
你在网易云聊天室发消息
→ Bridge
→ ChatGPT

ChatGPT
→ cove_bridge_reply
→ 原来的网易云聊天室
```

包括：

- 实时接收普通 ChatRoom 文本；
- custom payload 文本解析；
- 消息 ID 去重；
- routed reply；
- required / optional reply policy；
- 中断后的回复保护；
- 长回复拆成多个自然气泡；
- 防止把普通 ChatGPT 窗口消息误发回网易云。

### 歌词上下文

换歌后会读取当前歌曲可获得的歌词，包括可能存在的：

- 原歌词；
- 翻译歌词；
- 罗马音；
- Karaoke / 逐字歌词；
- 逐字翻译。

Bridge 会同时保留：

1. **整首歌词上下文**：用于理解整首歌的主题与前后关系；
2. **当前位置附近歌词**：用于知道现在具体唱到哪一句。

这样可以区分“这首歌整体在讲什么”和“我们此刻正在听什么”。

### 网易云账号工具

已经实现：

- 搜索歌曲；
- 查看自己的歌单；
- 查看歌单歌曲；
- 新建歌单；
- 添加歌曲；
- 删除歌曲；
- 喜欢 / 取消喜欢；
- 查看听歌历史和播放次数；
- 查看每日推荐；
- 读取账号 profile。

所以这个网易云账号不只是一个“监听一起听状态”的技术账号，也可以拥有自己的歌单、喜欢和听歌记录。

### MCP Profile

公开版保留：

```text
/mcp
/mcp/music
```

`/mcp` 保持旧部署兼容。

`/mcp/music` 是网易云 / Music scoped profile，只接收 `netease.*` 事件，同时保留 Bridge 通用工具。

公开仓的范围就是 **Bridge + NetEase + default/music profiles**。

Home / Reading / Spicy 等其他内部垂直模块不属于这个公开仓的 V2 发布范围，也不会为了“代码完全一样”被硬塞进来。

---

## V2 验收记录

这一版不是只通过单元测试。

我们实际完成过这样的端到端闭环：

```text
网易云聊天室消息
→ Bridge
→ Long-wait 唤醒 ChatGPT
→ ACK
→ required routed reply
→ 网易云聊天室收到回复
```

也完成过：

```text
手机网易云 PAUSE
→ NIM realtime
→ Bridge state event
→ Long-wait
→ ChatGPT
```

以及反方向：

```text
ChatGPT 发出 RESUME
→ 网易云播放控制
→ 手机实际恢复播放
→ NIM realtime confirmation
→ Bridge 新状态事件
→ 下一轮 Long-wait 再次接住
```

这意味着 V2 第一次把“外部世界 → AI → 外部世界”两端完整闭合，而且每一跳都有可验证的事件和确认语义。

---

## 已知边界

V2 已经跑通，但还有这些边界需要诚实保留：

### 1. Queue 目前仍是内存态

Bridge 进程重启后，尚未完成的 pending / reserved event 不具备真正的 durable recovery。

这也是下一阶段最值得优先解决的问题。

### 2. Long-wait 不是永久后台任务

它依赖一个已经存在的模型 turn。

V2 真实验证了多轮 timeout 和数分钟延迟事件，但没有证明所有 Host 都允许无限期保持同一个 turn。

### 3. SSE / reconnect 仍值得继续做长时间压力测试

常规场景已经可用，但极端网络抖动、长时间断线重连和多 Listener 竞争仍有继续加固空间。

### 4. Together 控制成功不等于媒体版权可播放

房间控制、NIM realtime confirmation 和客户端媒体版权是不同层。

即使 Bridge 已经确认 Together 控制成功，客户端仍可能因为地区、版权或账号能力无法真正播放某首媒体资源。

因此 V2 不会为了掩盖这一层边界去伪造 IP 或把不必要的媒体 preflight 塞进底层控制链路。

---

## 下一阶段建议优化 / Roadmap

下面这些是 **建议优化，不是当前已实现功能**。

### P0 — SQLite 持久化 Queue

优先级最高。

建议把当前内存 Queue 迁移到 SQLite，至少持久化：

- event payload；
- event lifecycle；
- pending / reserved / delivered；
- reservation owner；
- reservation timestamp；
- required reply state；
- routed reply dedupe key；
- state stream 最新值；
- retry / release 信息。

目标是让 Bridge 重启之后能够恢复尚未完成的消息，而不是把“进程活着”当成可靠性的前提。

### P0 — 重启恢复与 reservation lease

SQLite 之后应继续补：

- reservation TTL；
- worker 崩溃后的自动 release；
- required reply 恢复；
- delivered / replied terminal state 保留；
- state event compaction；
- conversation event 不丢失、不重复回复。

### P1 — Listener watchdog 与自动恢复

建议加入：

- SSE / realtime heartbeat；
- reconnect backoff；
- listener health state；
- 长时间无事件但连接异常的自恢复；
- 可观察的 last-success / last-error / reconnect-count。

### P1 — 更清晰的 multi-listener 语义

目前 Widget 与 Long-wait 被明确要求不要同时竞争同一个 Queue。

后续可以考虑：

- listener lease；
- consumer identity；
- single-active-listener lock；
- explicit handoff；
- profile-scoped consumer ownership。

这样比“靠约定不要同时开”更可靠。

### P1 — 可观察性

建议增加：

- structured logs；
- event latency；
- reserve → ACK latency；
- ACK → reply latency；
- realtime reconnect 次数；
- pending / reserved queue depth；
- failed routed reply；
- control confirmation latency。

这些指标比堆更多 debug print 更适合长期运行。

### P2 — 部署体验

可以继续做：

- 更完整的一键部署脚本；
- systemd 模板；
- Docker / Compose；
- 启动前配置校验；
- health / readiness endpoint；
- 更清晰的升级与回滚说明。

### P2 — Secrets 与凭据生命周期

继续加强：

- Cookie / token 不落日志；
- NIM credentials 只存在于后端；
- secrets rotation；
- 环境变量校验；
- 可选外部 secret store。

### P3 — 接更多外部世界

Bridge 本身并不只属于网易云。

以后可以继续接：

```text
Telegram
网页
Home
传感器
硬件终端
其他实时事件
        ⇅
   Cove Resonance
        ⇅
      AI
```

但原则仍然不变：

> 先把消息身份、ACK、去重、reply route 和事件生命周期做对，再加新的入口。

---

## 想直接部署

部署教程：

**[docs/GETTING_STARTED.zh-CN.md](docs/GETTING_STARTED.zh-CN.md)**

最小 Listener 协议（完全不依赖 SSE 的纯轮询基线）：

**[docs/MINIMAL_LISTENER_PROTOCOL.md](docs/MINIMAL_LISTENER_PROTOCOL.md)**

Long-wait MCP Listener（V2 已完成真实 Host 验收）：

**[docs/LONG_WAIT_MCP_EXPERIMENT.zh-CN.md](docs/LONG_WAIT_MCP_EXPERIMENT.zh-CN.md)**

---

## 想让你的小机学会我们的底层思路

如果你不只是想照着部署，而是想：

- 换一个 AI 客户端；
- 换一个外部平台；
- 自己实现另一种 Listener；
- 让编码 Agent 按自己的环境改；

可以直接把下面两份丢给它：

**[AGENTS.md](AGENTS.md)**

**[docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md](docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md)**

里面保留的是我和搭档一路踩坑之后留下来的底层约束：消息身份、队列、ACK、去重、reply route、Conversation / State、Wake / Pull 分离，以及哪些地方可以换、哪些地方最好别重写。

---

## 快速启动

需要：

- Node.js 22
- npm
- 一台可提供 HTTPS 的服务
- 自己的网易云账号 Cookie（至少包含 `MUSIC_U`）
- 支持 MCP Apps 的 ChatGPT 环境

```bash
git clone https://github.com/yanceydaisy/cove-resonance.git
cd cove-resonance

cp .env.example .env
npm install
npm test
npm run build
```

至少配置：

```dotenv
BRIDGE_PUBLIC_ORIGIN=https://bridge.example.com
NETEASE_COOKIE=MUSIC_U=...
TOGETHER_ENABLED=true
```

然后运行：

```bash
set -a
source .env
set +a
npm start
```

更完整的 HTTPS、systemd、MCP 接入和第一次双向测试步骤都在部署教程里。

现有部署继续使用 `/mcp` 即可；新部署如果只需要网易云能力，推荐连接 `/mcp/music`。

---

## 安全提醒

- 不要把网易云 Cookie 提交到仓库。
- 不要把 `BRIDGE_INGEST_TOKEN` 提交到仓库。
- 不要把 NIM credentials 暴露给 Widget、模型上下文或日志。
- 如果使用 noVNC / Chrome DevTools，请只绑定本机回环地址。
- 如果要在 VPS 上直接运行 ChatGPT Listener，请使用 ChatGPT 官方支持的地区。
- 发布前继续执行 secret scan、测试和 TypeScript build。

---

## Release discipline

这个项目一路踩坑以后留下了一些很朴素的规则：

- 不为了测试方便长期保留临时 worker；
- 不因为媒体地区问题就随便加入 IP spoof；
- 不把尚未决定是否采用的实验功能直接并入正式路径；
- 不对已经工作的 NIM 连接启动第二套登录去“试试看”；
- 不用 `git reset --hard` / `git clean` 解决来源不明的 working tree 问题；
- release 前必须跑 test、build、diff / secret check；
- 不为了“架构更优雅”重写已经被真实端到端证明过的底层。

一句话：

> **先证明问题存在，再修问题。**

---

## Credits

最早实现过程中，我们参考过：

- [wynsyl1014/mcp-app-message-bridge](https://github.com/wynsyl1014/mcp-app-message-bridge)
- [wuxiandudang-hash/ncm-listen-together](https://github.com/wuxiandudang-hash/ncm-listen-together)

Cove Resonance 还会继续长大。

但我想保留的那句话一直没变：

> **不搬 AI，给 AI 修路。**

Built by **Yancey × Cove**.
