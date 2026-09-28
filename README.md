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

- **实时播放状态升级为主链路**：暂停、继续、切歌和播放进度优先由网易云实时消息驱动，HTTP 只负责房间状态、低频校准和断线兜底；
- 新增 **暂停、继续播放、切到指定歌曲、播放下一首、把歌曲插到下一首** 等一起听控制；
- 控制不会“请求发出去就算成功”，而是等待网易云实时回执；修改播放队列后也会重新读取一次，确认真的生效；
- **修复假切歌**：切到指定歌曲前先确认它确实在当前一起听队列里，避免出现“系统说切了，但手机其实没切”的情况；
- 新增独立 **`/mcp/music`** profile，同时保留 `/mcp` 兼容；
- 加固 Widget / Host 人工确认与事件终态处理；
- 新增并真实验收 **Long-wait MCP Listener**：`wait → ACK → reply → next wait`；
- 新增 **可靠退出一起听**：发出退出后再次确认房间状态，确保真的已经离开；
- 公开候选版 **78/78 tests passed，TypeScript build passed**。

完整 V2 变化、验收记录和 Roadmap：

**[docs/V2.zh-CN.md](docs/V2.zh-CN.md)**

Listener / Long-wait 的技术细节：

**[docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md](docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md)**

## 已实现

### Bridge

- Conversation / State 事件；
- Queue、reserve / release / ACK；
- required reply backpressure；
- routed reply、去重；
- poll / SSE / Widget / Long-wait Listener。

### 网易云一起听

- 邀请识别与自动接受；
- 自动进入房间，并能可靠退出一起听；
- ChatRoom 双向聊天；
- 实时感知暂停、继续、切歌和播放进度；
- 可以暂停、继续播放、切到指定歌曲、播放下一首、把歌曲插到下一首；
- 播放控制会等待网易云实时回执确认；
- 切歌前检查目标歌曲是否真的在当前队列里，避免假成功；
- 整首歌词 + 当前歌词上下文。

### 网易云账号

- 搜索歌曲；
- 歌单查看 / 创建 / 增删歌曲；
- 喜欢 / 取消喜欢；
- 听歌历史；
- 每日推荐；
- 账号基本信息。

### MCP

```text
/mcp
/mcp/music
```

公开版范围是 **Bridge + NetEase + default/music profiles**。

## 部署

V2 有两种正式监听方式，**二选一，不要同时开启**：

- **Widget Listener**：手机端可用；网页端实测会出现人工确认；桌面端当前不可用；
- **Long-wait MCP**：网页 / 桌面 / 手机均已实测可用，当前更适合多端使用。

完整教程：

**[docs/GETTING_STARTED.zh-CN.md](docs/GETTING_STARTED.zh-CN.md)**

架构与实现说明：

**[docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md](docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md)**

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
- [WenXiaoWendy/galatea-garden-wake-bridge](https://github.com/WenXiaoWendy/galatea-garden-wake-bridge)
- [Vael-KY/netease-music-mcp](https://github.com/Vael-KY/netease-music-mcp)

> **不搬 AI，给 AI 修路。**

Built by **Yancey × Cove**.
