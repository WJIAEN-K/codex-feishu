import type { AppServerStatus } from "../app-server/client.js";
import type { SessionManager } from "../session/manager.js";

const appServerLabels: Record<AppServerStatus, string> = {
  stopped: "未连接",
  starting: "连接中",
  ready: "已连接",
  error: "错误",
};

const sessionLabels = {
  idle: "空闲",
  running: "执行中",
  waiting_approval: "等待审批",
  error: "错误",
} as const;

export async function statusCommand(
  manager: SessionManager,
  chatId: string,
  appServerStatus: AppServerStatus,
): Promise<string> {
  const session = await manager.get(chatId);
  return [
    `Codex App Server：${appServerLabels[appServerStatus]}`,
    `会话状态：${session ? sessionLabels[session.status] : "未创建"}`,
    `Thread ID：${session?.threadId ?? "-"}`,
    `工作目录：${session?.cwd ?? "-"}`,
    `绑定方式：${session ? (session.bindingMode === "attached" ? "已有会话" : "飞书创建") : "-"}`,
  ].join("\n");
}
