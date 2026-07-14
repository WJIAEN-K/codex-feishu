import type { SessionManager } from "../session/manager.js";

export async function newCommand(manager: SessionManager, chatId: string): Promise<string> {
  await manager.create(chatId);
  return "已创建新的 Codex 会话。";
}
