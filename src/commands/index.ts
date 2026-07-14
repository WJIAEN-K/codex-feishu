import type { CodexAppServerClient } from "../app-server/client.js";
import type { SessionManager } from "../session/manager.js";
import { helpCommand } from "./help.js";
import { newCommand } from "./new.js";
import { statusCommand } from "./status.js";
import { stopCommand } from "./stop.js";

export class CommandRouter {
  constructor(
    private readonly sessions: SessionManager,
    private readonly appServer: Pick<CodexAppServerClient, "getStatus">,
  ) {}

  isCommand(text: string): boolean {
    return text.trimStart().startsWith("/");
  }

  async execute(chatId: string, text: string): Promise<string> {
    const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
    switch (command) {
      case "/new": return newCommand(this.sessions, chatId);
      case "/stop": return stopCommand(this.sessions, chatId);
      case "/status": return statusCommand(this.sessions, chatId, this.appServer.getStatus());
      case "/help": return helpCommand();
      default: return `未知命令：${command ?? text}\n\n${helpCommand()}`;
    }
  }
}
