import type { SessionManager } from "../session/manager.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";

export interface CommandContext {
  chatId: string;
  deliveryChatId?: string;
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
    case "discover": {
      requireLocalDiscoveryAdmin(workspaces, context.senderOpenId);
      const projects = await sessions.listLocalProjects();
      if (projects.length === 0) return "Codex 本地数据库中没有可用项目会话。";
      return [
        "Codex 本地项目：",
        ...projects.map((project, index) => (
          `${index + 1}. ${project.cwd}\n` +
          `   ${project.threadCount} 个会话 · ${formatUpdatedAt(project.updatedAt)}` +
          `${project.preview ? ` · ${project.preview.replace(/\s+/g, " ").slice(0, 50)}` : ""}`
        )),
        "使用 /project use-local <序号> 切换，再用 /session list 查看该项目会话。",
      ].join("\n");
    }
    case "use-local": {
      requireLocalDiscoveryAdmin(workspaces, context.senderOpenId);
      const selector = parts[0];
      if (!selector || !/^\d+$/.test(selector)) return "用法：/project use-local <序号>";
      const project = (await sessions.listLocalProjects())[Number(selector) - 1];
      if (!project) throw new Error("本地项目序号无效，请先执行 /project discover");
      const cwd = await workspaces.validatePath(project.cwd);
      const session = await sessions.switchWorkspace(context.chatId, cwd);
      return [
        `已切换到 Codex 本地项目：${cwd}`,
        `已创建新会话：${session.threadId}`,
        "使用 /session list 查看并绑定该项目的已有会话。",
      ].join("\n");
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
      return "用法：/project list|current|discover|use-local|add|remove|use";
  }
}

function requireLocalDiscoveryAdmin(workspaces: WorkspaceRegistry, senderOpenId: string): void {
  if (!workspaces.isAdmin(senderOpenId)) {
    throw new Error("只有配置的飞书管理员可以查看或切换 Codex 本地项目");
  }
}

function formatUpdatedAt(value: number): string {
  return value > 0
    ? new Date(value * 1_000).toLocaleString("zh-CN", { hour12: false })
    : "时间未知";
}
