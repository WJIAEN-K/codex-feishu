# codex-feishu

Codex 官方 App Server 的飞书/Lark 客户端。服务通过飞书 Bot WebSocket 接收消息，使用 `stdio` 上的 JSON-RPC/JSONL 长连接驱动 `codex app-server`，并把会话、流式文本、工具进度、审批请求和最终结果同步回飞书。

## 核心能力

- 飞书与 Lark WebSocket 长连接，支持文本、富文本、图片、文件、音频和视频。
- 每个飞书 `chatId` 持久映射到一个 Codex `threadId`，服务重启后通过 `thread/resume` 恢复。
- 支持 `thread/start`、`thread/resume`、`turn/start` 和 `turn/interrupt`。
- 500～1000ms 窗口内合并流式 delta，长回复按飞书限制自动分块。
- 同一张进度卡片原地展示 Shell、文件修改、MCP 等工具状态。
- 高风险命令和文件修改可通过飞书审批卡片批准或拒绝。
- Typing Reaction 在任务开始时添加，在完成或失败时可靠清理。
- 同一聊天的消息顺序排队，不同聊天可并行执行。

唯一 Agent 接口是 `codex app-server --stdio`。项目不依赖 Pi Agent、不使用 `codex exec`，也不控制 Codex Desktop UI。

## 环境要求

- Node.js 20 或更高版本
- 已安装并登录的 Codex CLI
- 已创建并启用机器人的飞书或 Lark 自建应用

## 安装与配置

```bash
git clone https://github.com/WJIAEN-K/codex-feishu.git
cd codex-feishu
npm install
cp .env.example .env
```

至少配置：

```bash
FEISHU_APP_ID=cli_xxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxx
FEISHU_DOMAIN=feishu
CODEX_WORKING_DIRECTORY=/absolute/path/to/project
```

常用可选项：

```bash
CODEX_COMMAND=codex
CODEX_MODEL=
CODEX_REASONING_EFFORT=
CODEX_REQUEST_TIMEOUT_MS=120000
CODEX_SESSION_DB_PATH=/absolute/path/to/sessions.sqlite
LOG_LEVEL=info
```

`CODEX_WORKING_DIRECTORY` 必须是绝对路径。默认 Session 数据库存放在当前目录的 `.codex-feishu/sessions.sqlite`，该目录已被 Git 忽略。

## 启动

开发模式：

```bash
npm run dev
```

生产构建：

```bash
npm run build
npm start
```

## 飞书命令

- `/new`：创建并切换到新的 Codex Thread。
- `/stop`：通过 `turn/interrupt` 中断当前 Turn。
- `/status`：查看 App Server、Session、Thread ID 和工作目录。
- `/help`：显示命令说明。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm audit
```

验证真实 App Server 的初始化和 `thread/start`：

```bash
npm run verify:app-server
```

额外启动一个只回复 `PONG`、不调用工具的真实 Turn：

```bash
VERIFY_TURN=1 npm run verify:app-server
```

如果 Codex 不在 `PATH`，可以把可执行文件路径作为最后一个参数传入。

更多架构和测试说明见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 安全边界

- Codex 以普通用户、`workspace-write` sandbox 和 `on-request` 审批策略运行。
- App Server stdin/stdout 不暴露到网络，也不使用实验性 WebSocket 传输。
- `.env`、SQLite 数据库和媒体临时文件不进入 Git。
- 单个飞书入站媒体文件上限为 25 MiB，超限文件会立即删除。
- 依赖通过 `npm audit` 审计；飞书 SDK 的易受攻击传递依赖被 overrides 固定到修复版本。

## License

MIT
