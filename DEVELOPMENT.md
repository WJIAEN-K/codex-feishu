# Development

## 架构

```text
飞书/Lark WebSocket
        │
        ▼
FeishuClient ──► CodexFeishuBridge ──► SessionManager
                       │                      │
                       ▼                      ▼
              AppServerEventMapper     SQLiteSessionStore
                       │
                       ▼
              CodexAppServerSupervisor
                       │
              CodexAppServerClient
                       │ JSON-RPC + JSONL over stdio
                       ▼
              codex app-server --stdio
```

模块边界：

- `src/feishu/` 负责扫码创建应用、凭证引导、飞书 WebSocket、REST、媒体、Reaction 和卡片。
- `src/app-server/` 只负责 Codex 进程、JSON-RPC、协议调用和事件映射。
- `src/session/` 负责 `chatId → threadId → cwd`、Turn 状态和 SQLite 持久化。
- `src/workspace/` 负责 JSON 项目注册、允许目录校验和管理员授权。
- `src/commands/` 负责斜杠命令，不直接操作飞书 SDK。
- `src/bridge/codex-feishu-bridge.ts` 是唯一业务编排层。

飞书客户端和 App Server 客户端不会直接互相调用；所有交互都经由 Bridge。

## JSON 配置与热更新

`src/config/file.ts` 是唯一配置入口。默认读取 `.codex-feishu/config.json`，也可通过 `--config` 指定文件。业务配置不读取环境变量。

1. 配置不存在或缺少飞书凭证时，交互式终端通过 SDK `registerApp()` 显示二维码。
2. 扫码结果、管理员、Codex 参数、存储路径、允许根目录和项目别名写入同一个 JSON。
3. `JsonWorkspaceStore` 让 `/project add/remove` 原子更新 `workspace.projects`。
4. 配置监听采用无常驻文件句柄的内容轮询；变化通过校验后重启内部 Bridge、Feishu 和 App Server。
5. 无效更新保持当前实例继续运行；新实例启动失败时回滚旧配置。
6. 非交互式进程缺少完整 JSON 时立即失败，不进入授权等待。

旧版本升级时，仅在 JSON 凭证不完整的情况下读取一次旧 `.env` 和进程环境变量，并从旧 Session SQLite 导入 `workspaces` 表。迁移只写新 JSON，不删除旧数据。

JSON 文件使用临时文件加原子 rename 写入，并设置为 `0600`。App Secret 不进入日志。扫码用户的 `open_id` 仅在没有显式管理员配置时作为默认管理员。

## App Server 生命周期

1. 解析并启动 `command app-server --stdio`；Windows 会从 `PATH`/`PATHEXT` 定位 npm 生成的 `codex.cmd`，经 `ComSpec` 启动。
2. 逐行读取 stdout JSONL，stderr 仅作为日志流。
3. 发送 `initialize`，等待成功响应。
4. 发送 `initialized` 通知。
5. 初始化完成后才允许 Thread 和 Turn 请求。
6. stdin 帧通过 `JsonRpcWriteQueue` 串行写入并等待回调，避免背压时交错或静默丢失。
7. App Server 异常退出时拒绝 pending request，并按 1s、2s、5s、10s、30s 退避重启。
8. 重启成功后重新执行 initialize/initialized，并 resume SQLite 中可恢复的 Thread。

停止服务时，macOS/Linux 使用进程信号；Windows 使用 `taskkill /T` 清理 `cmd.exe → codex.cmd → node/codex` 的完整进程树，等待实际退出，超时后追加 `/F` 强制退出。Windows CI 还会运行真实 `.cmd` fixture 验证启动、JSON-RPC 和停止链路。

每个飞书聊天第一次使用时调用 `thread/start`；SQLite 中已有映射时调用 `thread/resume`。用户消息使用 `turn/start`，`/stop` 使用 `turn/interrupt`。

`/project use` 使用所选工作目录创建新 Thread；仅管理员可通过 `/session list` 调用 `thread/list` 查询已有会话，或通过 `/session use` 在验证 Thread 工作目录后执行 `thread/read` 和 `thread/resume`。工作目录白名单使用规范化后的真实路径判断，防止 `..` 或符号链接越界。

## 事件与输出

所有 App Server 通知先在 `AppServerEventMapper` 中转换为 `AgentEvent`。Bridge 不读取原始 Codex 事件字段。

- `item/agentMessage/delta`：累积并按节流窗口刷新流式卡片。
- `item/completed` 中的 `agentMessage`：在没有 delta 或 delta 不完整时补齐最终文本。
- `item/started` / `item/completed`：更新同一张工具进度卡片。
- `turn/completed`：发送完整分块文本、清理 Typing 和 active Turn。
- `error`：发送明确错误并将 Session 置为 error，后续消息仍可继续。

## 审批

当前支持官方 v2 请求：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`

请求通过 JSON-RPC `id` 与飞书按钮绑定，同时记录发起当前任务的 Open ID。卡片回调中的操作者 Open ID 必须与任务发起人一致，响应才会发送给 App Server；群聊中的其他成员点击会被拒绝。响应为 `{ "decision": "accept" }` 或 `{ "decision": "decline" }`。Thread 默认使用：

```text
approvalPolicy = on-request
approvalsReviewer = user
sandbox = workspace-write
```

可用本机 Codex 生成协议类型进行核对：

```bash
npm run generate:app-server-types
```

## 测试策略

- `jsonrpc.test.ts`：解析、错误响应和无效消息。
- `app-server-client.test.ts`：真实子进程握手、超时、退出和重复响应。
- `app-server-supervisor.test.ts`：异常退出、自动重启和 Thread 恢复回调。
- `write-queue.test.ts`：异步背压下的 JSON-RPC 帧顺序。
- `session-manager.test.ts`：Thread 复用、替换、并发保护和中断。
- `event-mapper.test.ts`：文本、工具、完成和错误事件映射。
- `bridge.test.ts`：完整消息链、排队、媒体、卡片、分块、审批和清理。
- `config-file.test.ts`：JSON schema、路径解析、原子保存和热更新。
- `feishu-setup.test.ts`：已有 JSON、非交互失败和扫码安全保存。
- `sqlite-store.test.ts`：数据库重开和 Thread 恢复。
- `verify-app-server.ts`：真实 Codex App Server 验收。

每个阶段至少运行：

```bash
npm run typecheck
npm test
npm run build
```

GitHub Actions 会在 Ubuntu、macOS 和 Windows Server 上执行同一套 Node.js 20 构建与测试，防止 Windows 入口和原生 SQLite 依赖回归。

## 提交前检查

```bash
npm run build
npm run typecheck
npm test
npm audit --audit-level=low
git diff --check
```
