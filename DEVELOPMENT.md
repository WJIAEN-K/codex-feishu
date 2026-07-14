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
              CodexAppServerClient
                       │ JSON-RPC + JSONL over stdio
                       ▼
              codex app-server --stdio
```

模块边界：

- `src/feishu/` 只负责飞书 WebSocket、REST、媒体、Reaction 和卡片。
- `src/app-server/` 只负责 Codex 进程、JSON-RPC、协议调用和事件映射。
- `src/session/` 负责 `chatId → threadId`、Turn 状态和 SQLite 持久化。
- `src/commands/` 负责斜杠命令，不直接操作飞书 SDK。
- `src/bridge/codex-feishu-bridge.ts` 是唯一业务编排层。

飞书客户端和 App Server 客户端不会直接互相调用；所有交互都经由 Bridge。

## App Server 生命周期

1. `spawn(command, ["app-server", "--stdio"])`。
2. 逐行读取 stdout JSONL，stderr 仅作为日志流。
3. 发送 `initialize`，等待成功响应。
4. 发送 `initialized` 通知。
5. 初始化完成后才允许 Thread 和 Turn 请求。
6. 退出、超时或协议错误时拒绝相关 pending request。

每个飞书聊天第一次使用时调用 `thread/start`；SQLite 中已有映射时调用 `thread/resume`。用户消息使用 `turn/start`，`/stop` 使用 `turn/interrupt`。

## 事件与输出

所有 App Server 通知先在 `AppServerEventMapper` 中转换为 `AgentEvent`。Bridge 不读取原始 Codex 事件字段。

- `item/agentMessage/delta`：累积并按节流窗口刷新流式卡片。
- `item/started` / `item/completed`：更新同一张工具进度卡片。
- `turn/completed`：发送完整分块文本、清理 Typing 和 active Turn。
- `error`：发送明确错误并将 Session 置为 error，后续消息仍可继续。

## 审批

当前支持官方 v2 请求：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`

请求通过 JSON-RPC `id` 与飞书按钮绑定，响应为 `{ "decision": "accept" }` 或 `{ "decision": "decline" }`。Thread 默认使用：

```text
approvalPolicy = on-request
approvalsReviewer = user
sandbox = workspace-write
```

可用本机 Codex 生成协议类型进行核对：

```bash
codex app-server generate-ts --experimental --out /tmp/codex-app-server-schema
```

## 测试策略

- `jsonrpc.test.ts`：解析、错误响应和无效消息。
- `app-server-client.test.ts`：真实子进程握手、超时、退出和重复响应。
- `session-manager.test.ts`：Thread 复用、替换、并发保护和中断。
- `event-mapper.test.ts`：文本、工具、完成和错误事件映射。
- `bridge.test.ts`：完整消息链、排队、媒体、卡片、分块、审批和清理。
- `sqlite-store.test.ts`：数据库重开和 Thread 恢复。
- `verify-app-server.ts`：真实 Codex App Server 验收。

每个阶段至少运行：

```bash
npm run typecheck
npm test
npm run build
```

## 提交前检查

```bash
npm run build
npm run typecheck
npm test
npm audit --audit-level=low
git diff --check
```
