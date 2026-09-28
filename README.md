# Cove Resonance

> **V2 — accepted on 2026-09-28**
>
> 不搬 AI，给 AI 修路。

你好，我是 **Cove**。

Cove Resonance 让 AI 留在 ChatGPT、用户留在原本的应用里，中间用 Bridge 把事件、状态和回复真正接通。

我们最早从网易云「一起听」开始：听见聊天室消息、知道正在播什么、读歌词、控制播放，再把回复沿原路送回去。

## V2 更新

V2 在上一版公开 Music V2 基础上，完成了最后几条关键链路：

- **Long-wait MCP Listener** 正式通过真实 ChatGPT Host 验收；
- 新增 `cove_bridge_wait_ack`，把模型侧 ACK 与 Widget ACK 分开；
- required reply 完成 `wait → ACK → reply → next wait` 闭环；
- 新增 authoritative `netease_together_leave`；
- 已处理事件不会在重新监听后重复释放；
- 公开候选分支 **78/78 tests passed，TypeScript build passed**。

详细更新、验收记录与 Roadmap：

**[docs/V2.zh-CN.md](docs/V2.zh-CN.md)**

Long-wait 机制：

**[docs/LONG_WAIT_MCP_EXPERIMENT.zh-CN.md](docs/LONG_WAIT_MCP_EXPERIMENT.zh-CN.md)**

## 已实现

### Bridge

- Conversation / State 事件；
- Queue、reserve / release / ACK；
- required reply backpressure；
- source/profile filter；
- routed reply、去重；
- Widget / SSE / poll / Long-wait Listener。

### 网易云一起听

- 邀请识别与自动接受；
- 房间进入 / 退出；
- ChatRoom 双向聊天；
- PLAY / PAUSE / GOTO / PROGRESS 实时状态；
- PAUSE / RESUME / GOTO / NEXT / ENQUEUE_NEXT 控制；
- NIM realtime confirmation；
- GOTO displayList 假成功保护；
- 整首歌词 + 当前歌词上下文。

### 网易云账号

- 搜索歌曲；
- 歌单查看 / 创建 / 增删歌曲；
- 喜欢 / 取消喜欢；
- 听歌历史；
- 每日推荐；
- 账号 profile。

### MCP

```text
/mcp
/mcp/music
```

公开版范围是 **Bridge + NetEase + default/music profiles**。

## 部署

完整教程：

**[docs/GETTING_STARTED.zh-CN.md](docs/GETTING_STARTED.zh-CN.md)**

最小 Listener 协议：

**[docs/MINIMAL_LISTENER_PROTOCOL.md](docs/MINIMAL_LISTENER_PROTOCOL.md)**

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

## 下一步

V2 已跑通，下一阶段优先建议：

**SQLite 持久化 Queue → 重启恢复 / reservation lease → Listener watchdog → multi-listener ownership → observability → 更简单的部署。**

详细设计见 **[V2 Roadmap](docs/V2.zh-CN.md#下一阶段建议优化)**。

## 安全

- 不要提交网易云 Cookie 或 `BRIDGE_INGEST_TOKEN`；
- NIM credentials 不进入 Widget、模型上下文或日志；
- 发布前继续跑 test、build、diff / secret check。

## Credits

参考过：

- [wynsyl1014/mcp-app-message-bridge](https://github.com/wynsyl1014/mcp-app-message-bridge)
- [wuxiandudang-hash/ncm-listen-together](https://github.com/wuxiandudang-hash/ncm-listen-together)

> **不搬 AI，给 AI 修路。**

Built by **Yancey × Cove**.
