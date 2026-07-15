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
- App Server 异常退出后按 1s、2s、5s、10s、30s 指数退避自动重启，并恢复持久化 Thread。
- JSON-RPC stdin 使用串行写入队列处理背压；单聊天等待队列默认最多 20 条。
- 审批按钮仅允许当前任务发起人操作，群聊中的其他成员不能代为批准。

唯一 Agent 接口是 `codex app-server --stdio`。项目不依赖 Pi Agent、不使用 `codex exec`，也不控制 Codex Desktop UI。

## 环境要求

- Node.js 20 或更高版本
- 已安装并登录的 Codex CLI
- 可创建自建应用的飞书或 Lark 账号；也可以使用已有机器人凭证

支持 macOS、Linux 和 Windows。Windows 上建议使用 PowerShell，并确保 `codex --version` 可以正常运行；程序会自动解析 npm 安装产生的 `codex.cmd`，停止时会清理其完整子进程树。

## 安装与配置

```bash
git clone https://github.com/WJIAEN-K/codex-feishu.git
cd codex-feishu
npm install
```

项目只使用 JSON 配置，不读取 `.env` 或业务环境变量。默认配置文件为启动目录下的 `.codex-feishu/config.json`。第一次在交互式终端启动且文件不存在时，程序会生成默认配置并显示飞书配置链接和二维码；扫码后自动写入 App ID、App Secret 和扫码人的管理员 Open ID，然后继续启动。

从旧版本升级时，如果 JSON 尚未包含凭证，程序会一次性读取原有 `.env` 文件以及 `FEISHU_*`、`CODEX_*`、`LOG_LEVEL` 进程环境变量并生成 JSON，同时从旧 Session SQLite 的 `workspaces` 表导入项目列表。进程环境变量优先于 `.env`。迁移不会修改或删除旧文件、环境变量和数据库；JSON 生成后以 JSON 为准。

最小配置结构如下，首次扫码时会自动生成，不需要手工创建：

```json
{
  "version": 1,
  "feishu": {
    "appId": "cli_xxxxxxxxx",
    "appSecret": "xxxxxxxxx",
    "domain": "feishu",
    "adminOpenIds": ["ou_xxxxxxxxx"]
  },
  "codex": {
    "command": "codex",
    "args": ["app-server", "--stdio"],
    "requestTimeoutMs": 120000
  },
  "workspace": {
    "defaultPath": "/absolute/path/to/project",
    "allowedRoots": ["/absolute/path/to/projects"],
    "projects": {
      "backend": {
        "path": "/absolute/path/to/projects/backend",
        "enabled": true,
        "createdBy": "config",
        "createdAt": 0
      }
    }
  },
  "storage": {
    "sessionDatabasePath": "/absolute/path/to/project/.codex-feishu/sessions.sqlite"
  },
  "queue": {
    "maxPerChat": 20
  },
  "runtime": {
    "logLevel": "info"
  }
}
```

完整模板见 [codex-feishu.config.example.json](codex-feishu.config.example.json)。所有路径必须是绝对路径，`workspace.allowedRoots` 和 `workspace.projects` 中的目录必须已存在。项目别名会去除首尾空格并转换为小写，规范化后不能重复，且不能使用保留名称 `default`。`workspace.projects` 保存飞书 `/project add/remove` 管理的项目别名和路径；`workspace.allowedRoots` 是项目目录安全白名单，项目真实路径（包括符号链接解析结果）必须位于其中。`queue.maxPerChat` 控制单个聊天可等待的消息数，达到上限后新消息会被拒绝并提示等待或执行 `/stop`。

使用其他配置文件：

```bash
codex-feishu --config /absolute/path/to/config.json
# 或源码运行
npm start -- --config /absolute/path/to/config.json
```

配置文件使用原子写入并设置为 `0600`。运行期间每 500ms 检查内容变化：`workspace.projects` 变更会直接生效，其他有效配置变化会自动断开并重建 Feishu/Codex 内部服务，无需重启 Node 进程。无效 JSON 或不合法路径不会替换当前运行配置；新配置启动失败时自动恢复上一份有效 JSON 和运行实例。

Docker、systemd、CI 等非交互环境不会等待扫码，必须预先挂载包含飞书凭证的 JSON 配置文件。

## 启动

从 npm 包一键启动：

```bash
cd /absolute/path/to/project
npx --yes codex-feishu-app-server@latest
```

第一次运行会显示二维码，后续运行会复用本地凭证。

Windows PowerShell：

```powershell
cd C:\absolute\path\to\project
codex --version
npx --yes codex-feishu-app-server@latest
```

这里启动的是与 ChatGPT 账号登录状态兼容的本机 Codex App Server，不会通过 UI 自动化接管 ChatGPT 桌面端。Windows 新版 ChatGPT 中的 Codex 与 CLI 可以使用同一账号和本机会话存储，但飞书端仍通过官方 `codex app-server --stdio` 协议通信。

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

切换项目会创建新的 Thread，避免把不同代码库的上下文混在一起。查看或绑定已有会话仅允许 `feishu.adminOpenIds` 中的用户操作；绑定时还要求该 Thread 位于当前 App Server 可访问的本地 Codex 会话存储中，并且其工作目录位于 `workspace.allowedRoots`。同一 Thread 同时只能绑定一个飞书聊天。

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

Codex 升级后可按已安装版本重新生成官方 App Server TypeScript schema，用于协议差异核对：

```bash
npm run generate:app-server-types
```

额外启动一个只回复 `PONG`、不调用工具的真实 Turn：

```bash
npm run verify:app-server -- --turn
```

如果 Codex 不在 `PATH`，可以把可执行文件路径作为最后一个参数传入。

更多架构和测试说明见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 安全边界

- Codex 以普通用户、`workspace-write` sandbox 和 `on-request` 审批策略运行。
- App Server stdin/stdout 不暴露到网络，也不使用实验性 WebSocket 传输。
- JSON 配置、SQLite 数据库和媒体临时文件不进入 Git。
- 扫码取得的 App Secret 只写入权限为 `0600` 的 JSON 配置文件，不在终端输出。
- 飞书项目目录受 `workspace.allowedRoots` 白名单约束，项目增删受 `feishu.adminOpenIds` 控制。
- 单个飞书入站媒体文件上限为 25 MiB，超限文件会立即删除。
- 依赖通过 `npm audit` 审计；飞书 SDK 的易受攻击传递依赖被 overrides 固定到修复版本。

## License

MIT
