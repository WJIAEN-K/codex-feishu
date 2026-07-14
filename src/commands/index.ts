import type { CodexAppServerClient } from "../app-server/client.js";
import type { ThreadSummary } from "../app-server/thread-catalog.js";
import type { SessionManager } from "../session/manager.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { helpCommand } from "./help.js";
import { newCommand } from "./new.js";
import { projectCommand, type CommandContext } from "./project.js";
import { sessionCommand } from "./session.js";
import { statusCommand } from "./status.js";
import { stopCommand } from "./stop.js";

export class CommandRouter {
  private readonly recentThreads = new Map<string, ThreadSummary[]>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly appServer: Pick<CodexAppServerClient, "getStatus">,
    private readonly workspaces: WorkspaceRegistry,
  ) {}

  isCommand(text: string): boolean {
    return text.trimStart().startsWith("/");
  }

  async execute(context: CommandContext, text: string): Promise<string> {
    const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
    const argumentsText = text.trim().slice(command?.length ?? 0).trim();
    switch (command) {
      case "/new": return newCommand(this.sessions, context.chatId);
      case "/stop": return stopCommand(this.sessions, context.chatId);
      case "/status": return statusCommand(this.sessions, context.chatId, this.appServer.getStatus());
      case "/project": return projectCommand(this.sessions, this.workspaces, context, argumentsText);
      case "/session": return sessionCommand(
        this.sessions,
        this.workspaces,
        this.recentThreads,
        context,
        argumentsText,
      );
      case "/help": return helpCommand();
      default: return `未知命令：${command ?? text}\n\n${helpCommand()}`;
    }
  }
}
