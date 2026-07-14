import type { SessionManager } from "../session/manager.js";

export async function stopCommand(manager: SessionManager, chatId: string): Promise<string> {
  const interrupted = await manager.interrupt(chatId);
  return interrupted ? "已请求中断当前 Codex 任务。" : "当前没有正在执行的 Codex 任务。";
}
