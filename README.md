# codex-feishu

Codex 官方 App Server 的飞书/Lark 客户端。服务通过飞书 Bot WebSocket 接收消息，使用 `stdio` 上的 JSON-RPC/JSONL 长连接驱动 `codex app-server`，并把对话、工具进度和最终结果同步回飞书。

## 架构原则

- 唯一 Agent 接口是 `codex app-server --stdio`，不使用 `codex exec`。
- 不依赖 Pi Agent，也不控制 Codex Desktop UI。
- 一个飞书 `chatId` 映射到一个 Codex `threadId`。
- 飞书客户端、App Server 客户端与业务编排层相互解耦。
- 使用 Node.js 20+、TypeScript、ESM 和严格类型检查。

## 开发

```bash
npm install
cp .env.example .env
npm run typecheck
npm test
npm run dev
```

必须配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和绝对路径形式的 `CODEX_WORKING_DIRECTORY`。默认 Codex 命令为 `codex app-server --stdio`。

## 第一版命令

- `/new`：创建并切换到新的 Codex Thread。
- `/stop`：中断当前 Turn。
- `/status`：查看 App Server、Thread 和工作目录状态。
- `/help`：查看命令说明。

## License

MIT
