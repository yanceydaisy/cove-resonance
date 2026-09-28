# Cove Resonance

> **V2 — accepted on 2026-09-28**
>
> 不搬 AI，给 AI 修路。

你好，我是 **Cove**。

Cove Resonance 让 AI 留在 ChatGPT、用户留在原本的应用里，中间用 Bridge 把外部事件、实时状态和回复真正接通。

我们最早从网易云「一起听」开始：听见聊天室消息、知道正在播什么、读歌词、控制播放，再把回复沿原路送回去。

## V2 更新

这里的 V2 是相对最初公开版本 **`v1-public-preview`** 而言。

这一版主要完成了：

- **NIM realtime 升级为播放状态主数据源**，HTTP 退回房间生命周期、低频 reconcile 和断线 fallback；
- 新增 **PAUSE / RESUME / GOTO / NEXT / ENQUEUE_NEXT** 控制；
- 播放控制必须等待 **NIM realtime confirmation**，队列修改会回读 playlist 确认；
- 增加 **GOTO displayList 假成功保护**；
- 新增独立 **`/mcp/music`** profile，同时保留 `/mcp` 兼容；
- 加固 Widget / Host 人工确认与事件终态处理；
- 新增并真实验收 **Long-wait MCP Listener**：`wait → ACK → reply → next wait`；
- 新增 authoritative **`netease_together_leave`**；
- 公开候选版 **78/78 tests passed，TypeScript build passed**。

完整 V2 变化、验收记录和 Roadmap：

**[docs/V2.zh-CN.md](docs/V2.zh-CN.md)**

Long-wait 细节：

**[docs/LONG_WAIT_MCP_EXPERIMENT.zh-CN.md](docs/LONG_WAIT_MCP_EXPERIMENT.zh-CN.md)**

## 已实现

### Bridge

- Conversation / State 事件；
- Queue、reserve / release / ACK；
- required reply backpressure；
- routed reply、去重；
- poll / SSE / Widget / Long-wait Listener。

### 网易云一起听

- 邀请识别与自动接受；
- 房间进入 / authoritative leave；
- ChatRoom 双向聊天；
- realtime 播放状态；
- PAUSE / RESUME / GOTO / NEXT / ENQUEUE_NEXT；
- realtime confirmation；
- displayList 假成功保护；
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

## 下一步

V2 已跑通。下一阶段优先建议：

**SQLite 持久化 Queue → 重启恢复 / reservation lease → Listener watchdog → multi-listener ownership → observability → 更简单的部署。**

详细见 **[V2 Roadmap](docs/V2.zh-CN.md#下一阶段建议优化)**。

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
