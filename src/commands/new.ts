import type { SessionManager } from "../session/manager.js";

export async function newCommand(manager: SessionManager, chatId: string): Promise<string> {
  const current = await manager.get(chatId);
  if (current?.status === "waiting_approval") {
    throw new Error("当前会话正在等待审批，请先处理审批后再创建新会话");
  }
  if (current?.status === "running") await manager.interrupt(chatId);
  await manager.create(chatId, current?.cwd);
  return "已创建新的 Codex 会话。";
}
