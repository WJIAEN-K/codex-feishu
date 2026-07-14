import type { SessionManager } from "../session/manager.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";

export interface CommandContext {
  chatId: string;
  senderOpenId: string;
  chatType: "p2p" | "group";
}

export async function projectCommand(
  sessions: SessionManager,
  workspaces: WorkspaceRegistry,
  context: CommandContext,
  argumentsText: string,
): Promise<string> {
  const [subcommand = "list", ...parts] = argumentsText.trim().split(/\s+/).filter(Boolean);
  switch (subcommand.toLowerCase()) {
    case "list": {
      const current = await sessions.get(context.chatId);
      const entries = await workspaces.list();
      if (entries.length === 0) return "尚未配置项目。";
      return [
        "可用项目：",
        ...entries.map((workspace) =>
          `${current?.cwd === workspace.path ? "●" : "○"} ${workspace.alias} — ${workspace.path}`),
      ].join("\n");
    }
    case "current": {
      const current = await sessions.get(context.chatId);
      if (!current) return "当前聊天尚未创建 Codex 会话。";
      const workspace = await workspaces.findByPath(current.cwd);
      return `当前项目：${workspace?.alias ?? "未命名"}\n工作目录：${current.cwd}`;
    }
    case "add": {
      const match = argumentsText.trim().match(/^add\s+(\S+)\s+(.+)$/i);
      if (!match) return "用法：/project add <别名> <绝对路径>";
      const workspace = await workspaces.add(match[1] ?? "", match[2] ?? "", context.senderOpenId);
      return `已添加项目：${workspace.alias}\n${workspace.path}`;
    }
    case "remove": {
      const alias = parts[0];
      if (!alias) return "用法：/project remove <别名>";
      await workspaces.remove(alias, context.senderOpenId);
      return `已删除项目：${alias}`;
    }
    case "use": {
      const alias = parts[0];
      if (!alias) return "用法：/project use <别名>";
      const workspace = await workspaces.get(alias);
      const session = await sessions.switchWorkspace(context.chatId, workspace.path);
      return `已切换项目：${workspace.alias}\n已创建新会话：${session.threadId}`;
    }
    default:
      return "用法：/project list|current|add|remove|use";
  }
}
