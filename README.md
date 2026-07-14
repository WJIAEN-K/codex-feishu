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

如需在飞书中配置和切换项目，设置允许访问的根目录和管理员：

```bash
CODEX_ALLOWED_ROOTS=/absolute/path/to/projects,/another/allowed/root
FEISHU_ADMIN_OPEN_IDS=ou_xxxxxxxxx,ou_yyyyyyyyy
```

`CODEX_ALLOWED_ROOTS` 中只能使用绝对路径。飞书中注册的项目经过 `realpath` 校验，必须位于这些根目录内；只有 `FEISHU_ADMIN_OPEN_IDS` 中的用户可以添加或删除项目。未配置管理员时，项目列表只能读取和切换，不能从飞书修改。

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
- `/project list`：查看已注册项目。
- `/project current`：查看当前项目和目录。
- `/project use <别名>`：切换项目并创建新 Thread。
- `/project add <别名> <绝对路径>`：注册项目，仅管理员可用。
- `/project remove <别名>`：删除项目，仅管理员可用。
- `/session list [项目别名]`：列出项目最近的 CLI、VS Code 和 App Server 会话，仅管理员可用。
- `/session use <序号或Thread ID>`：绑定已有 Codex Thread，仅管理员可用。
- `/session new [项目别名]`：在指定或当前项目创建新 Thread。
- `/session current`：查看当前 Thread、目录和绑定方式。
- `/help`：显示命令说明。

切换项目会创建新的 Thread，避免把不同代码库的上下文混在一起。查看或绑定已有会话仅允许 `FEISHU_ADMIN_OPEN_IDS` 中的用户操作；绑定时还要求该 Thread 位于当前 App Server 可访问的本地 Codex 会话存储中，并且其工作目录位于 `CODEX_ALLOWED_ROOTS`。同一 Thread 同时只能绑定一个飞书聊天。

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
- 飞书项目目录受 `CODEX_ALLOWED_ROOTS` 白名单约束，项目增删受发送人 `open_id` 管理员列表控制。
- 单个飞书入站媒体文件上限为 25 MiB，超限文件会立即删除。
- 依赖通过 `npm audit` 审计；飞书 SDK 的易受攻击传递依赖被 overrides 固定到修复版本。

## License

MIT
