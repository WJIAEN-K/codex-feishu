import type { ThreadSummary } from "../app-server/thread-catalog.js";
import type { SessionManager } from "../session/manager.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { CommandContext } from "./project.js";

export async function sessionCommand(
  sessions: SessionManager,
  workspaces: WorkspaceRegistry,
  recentThreads: Map<string, ThreadSummary[]>,
  context: CommandContext,
  argumentsText: string,
): Promise<string> {
  const [subcommand = "current", ...parts] = argumentsText.trim().split(/\s+/).filter(Boolean);
  switch (subcommand.toLowerCase()) {
    case "current": {
      const session = await sessions.get(context.chatId);
      if (!session) return "当前聊天尚未创建 Codex 会话。";
      return [
        `Thread ID：${session.threadId}`,
        `工作目录：${session.cwd}`,
        `绑定方式：${session.bindingMode === "attached" ? "已有会话" : "飞书创建"}`,
        `状态：${session.status}`,
      ].join("\n");
    }
    case "list": {
      requireSessionAdmin(workspaces, context.senderOpenId);
      const alias = parts[0];
      const current = await sessions.get(context.chatId);
      const workspace = alias
        ? await workspaces.get(alias)
        : current
          ? await workspaces.findByPath(current.cwd)
          : await workspaces.get("default");
      if (!workspace) throw new Error("当前会话目录未注册为可用项目，请指定项目别名");
      const threads = await sessions.listThreads(workspace.path);
      recentThreads.set(context.chatId, threads);
      if (threads.length === 0) return `项目 ${workspace.alias} 暂无可恢复会话。`;
      return [
        `项目 ${workspace.alias} 的最近会话：`,
        ...threads.map((thread, index) => formatThread(thread, index + 1)),
        "使用 /session use <序号或Thread ID> 切换。",
      ].join("\n");
    }
    case "use": {
      requireSessionAdmin(workspaces, context.senderOpenId);
      const selector = parts[0];
      if (!selector) return "用法：/session use <序号或Thread ID>";
      const threadId = resolveThreadId(recentThreads.get(context.chatId), selector);
      const thread = await sessions.readThread(threadId);
      thread.cwd = await workspaces.validatePath(thread.cwd);
      const session = await sessions.bind(context.chatId, thread);
      return `已切换到已有会话：${session.threadId}\n工作目录：${session.cwd}`;
    }
    case "new": {
      const alias = parts[0];
      const workspace = alias
        ? await workspaces.get(alias)
        : await currentWorkspace(sessions, workspaces, context.chatId);
      const current = await sessions.get(context.chatId);
      if (current?.status === "waiting_approval") {
        throw new Error("当前会话正在等待审批，请先处理审批后再创建新会话");
      }
      if (current?.status === "running") await sessions.interrupt(context.chatId);
      const session = await sessions.create(context.chatId, workspace.path);
      return `已创建新会话：${session.threadId}\n项目：${workspace.alias}`;
    }
    default:
      return "用法：/session list|use|new|current";
  }
}

function requireSessionAdmin(workspaces: WorkspaceRegistry, senderOpenId: string): void {
  if (!workspaces.isAdmin(senderOpenId)) {
    throw new Error("只有配置的飞书管理员可以查看或绑定已有 Codex 会话");
  }
}

async function currentWorkspace(
  sessions: SessionManager,
  workspaces: WorkspaceRegistry,
  chatId: string,
) {
  const current = await sessions.get(chatId);
  if (!current) return workspaces.get("default");
  const workspace = await workspaces.findByPath(current.cwd);
  if (!workspace) throw new Error("当前会话目录未注册为可用项目");
  return workspace;
}

function resolveThreadId(threads: ThreadSummary[] | undefined, selector: string): string {
  if (/^\d+$/.test(selector)) {
    const index = Number(selector) - 1;
    const thread = threads?.[index];
    if (!thread) throw new Error("会话序号无效，请先执行 /session list");
    return thread.id;
  }
  return selector;
}

function formatThread(thread: ThreadSummary, index: number): string {
  const title = thread.name || thread.preview || "无标题会话";
  const compactTitle = title.replace(/\s+/g, " ").slice(0, 60);
  const updated = thread.updatedAt > 0
    ? new Date(thread.updatedAt * 1000).toLocaleString("zh-CN", { hour12: false })
    : "时间未知";
  return `${index}. ${compactTitle}\n   ${thread.id} · ${updated}`;
}
