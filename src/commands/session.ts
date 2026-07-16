import type { ThreadSummary } from "../app-server/thread-catalog.js";
import type { SessionManager } from "../session/manager.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { LocalCodexSyncService } from "../codex-local/sync-service.js";
import type { CommandContext } from "./project.js";

export async function sessionCommand(
  sessions: SessionManager,
  workspaces: WorkspaceRegistry,
  recentThreads: Map<string, ThreadSummary[]>,
  context: CommandContext,
  argumentsText: string,
  localSync?: LocalCodexSyncService,
): Promise<string> {
  const [subcommand = "current", ...parts] = argumentsText.trim().split(/\s+/).filter(Boolean);
  switch (subcommand.toLowerCase()) {
    case "current": {
      const session = await sessions.get(context.chatId);
      if (!session) return "当前聊天尚未创建 Codex 会话。";
      return [
        `会话名称：${session.name ?? "未命名"}`,
        `Thread ID：${session.threadId}`,
        `工作目录：${session.cwd}`,
        `绑定方式：${session.bindingMode === "attached" ? "已有会话" : "飞书创建"}`,
        `状态：${session.status}`,
        `模型：${session.runtime?.model ?? "Codex 默认"}`,
        `推理强度：${session.runtime?.reasoningEffort ?? "Codex 默认"}`,
        `运行模式：${session.runtime?.mode ?? "default"}`,
      ].join("\n");
    }
    case "saved": {
      const current = await sessions.get(context.chatId);
      const saved = await sessions.listSaved(context.chatId);
      if (saved.length === 0) return "当前对话还没有已保存会话。";
      return [
        "当前对话的已保存会话：",
        ...saved.map((session, index) => (
          `${session.threadId === current?.threadId ? "●" : "○"} ${index + 1}. ${session.name ?? "未命名"}` +
          `\n   ${session.threadId} · ${session.cwd}`
        )),
        "使用 /session switch <名称或Thread ID> 切换。",
      ].join("\n");
    }
    case "switch": {
      const selector = parts.join(" ").trim();
      if (!selector) return "用法：/session switch <名称或Thread ID>";
      const session = await sessions.switchSaved(context.chatId, selector);
      return `已切换会话：${session.name ?? session.threadId}\nThread ID：${session.threadId}`;
    }
    case "rename": {
      const name = parts.join(" ").trim();
      if (!name) return "用法：/session rename <新名称>";
      const session = await sessions.renameCurrent(context.chatId, name);
      return `会话已重命名为：${session.name}`;
    }
    case "history": {
      const requested = Number(parts[0] ?? "10");
      const limit = Number.isSafeInteger(requested) && requested > 0 ? requested : 10;
      const history = await sessions.history(context.chatId, limit);
      if (history.length === 0) return "当前会话还没有可显示的消息历史。";
      return history.map((entry) => (
        `**${entry.role === "user" ? "用户" : "Codex"}**：${entry.text.slice(0, 1_500)}`
      )).join("\n\n");
    }
    case "usage": {
      const { usage, limits } = await sessions.usage();
      const primary = limits.rateLimits.primary;
      return [
        `累计 Token：${formatBigInt(usage.summary.lifetimeTokens)}`,
        `单日峰值：${formatBigInt(usage.summary.peakDailyTokens)}`,
        primary ? `主要额度已使用：${primary.usedPercent.toFixed(1)}%` : "主要额度：暂无数据",
        primary?.resetsAt ? `重置时间：${new Date(primary.resetsAt * 1_000).toLocaleString("zh-CN", { hour12: false })}` : undefined,
      ].filter((value): value is string => Boolean(value)).join("\n");
    }
    case "list": {
      requireSessionAdmin(workspaces, context.senderOpenId);
      const alias = parts[0];
      const current = await sessions.get(context.chatId);
      const workspace = alias ? await workspaces.get(alias) : undefined;
      const cwd = workspace?.path
        ?? (current ? await workspaces.validatePath(current.cwd) : (await workspaces.get("default")).path);
      const projectLabel = workspace?.alias ?? (await workspaces.findByPath(cwd))?.alias ?? "Codex 本地项目";
      const threads = await sessions.listThreads(cwd);
      recentThreads.set(context.chatId, threads);
      if (threads.length === 0) return `项目 ${projectLabel} 暂无可恢复会话。`;
      return [
        `项目 ${projectLabel} 的最近会话：`,
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
      const nameIndex = parts.indexOf("--name");
      const alias = parts[0] && parts[0] !== "--name" ? parts[0] : undefined;
      const name = nameIndex >= 0 ? parts.slice(nameIndex + 1).join(" ").trim() : undefined;
      const workspace = alias
        ? await workspaces.get(alias)
        : await currentWorkspace(sessions, workspaces, context.chatId);
      const current = await sessions.get(context.chatId);
      if (current?.status === "waiting_approval") {
        throw new Error("当前会话正在等待审批，请先处理审批后再创建新会话");
      }
      if (current?.status === "running") await sessions.interrupt(context.chatId);
      const session = await sessions.create(context.chatId, workspace.path, name || undefined);
      return `已创建新会话：${session.name}\nThread ID：${session.threadId}\n项目：${workspace.alias}`;
    }
    case "sync": {
      requireSessionAdmin(workspaces, context.senderOpenId);
      if (!localSync) throw new Error("本地 Codex 会话同步未启用");
      const action = parts[0]?.toLowerCase() ?? "status";
      if (action === "off") {
        localSync.disable(context.chatId);
        return "已停止将本地 Codex 会话同步到当前飞书对话。";
      }
      if (action === "status") {
        const binding = localSync.status(context.chatId);
        return binding
          ? `本地会话同步：已开启\nThread ID：${binding.threadId}\n批准请求：可在飞书处理，或转回 Codex 原生界面`
          : "本地会话同步：未开启。使用 /session sync on 开启。";
      }
      if (action !== "on") return "用法：/session sync on|off|status";
      const session = await sessions.get(context.chatId);
      if (!session) throw new Error("请先用 /session use 绑定一个 Codex 本地会话");
      if (session.bindingMode !== "attached") {
        throw new Error("飞书创建的会话已自动回传消息；sync 仅用于绑定的本地 Codex 会话");
      }
      await localSync.enable({
        threadId: session.threadId,
        conversationId: context.chatId,
        deliveryChatId: context.deliveryChatId ?? context.chatId,
        ownerOpenId: context.senderOpenId,
      });
      return [
        "已开启本地 Codex 会话实时同步。",
        "从现在开始同步用户输入和 Codex 最终回答（不推送推理与工具原始输出）。",
        "安装 PermissionRequest hook 后，批准请求也会发送到飞书。",
      ].join("\n");
    }
    default:
      return "用法：/session saved|switch|rename|history|usage|list|use|new|sync|current";
  }
}

function formatBigInt(value: bigint | null): string {
  return value === null ? "暂无数据" : value.toLocaleString("zh-CN");
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
