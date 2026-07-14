import type { SessionManager } from "../session/manager.js";

export async function newCommand(manager: SessionManager, chatId: string): Promise<string> {
  const current = await manager.get(chatId);
  if (current?.status === "running") await manager.interrupt(chatId);
  await manager.create(chatId);
  return "已创建新的 Codex 会话。";
}
