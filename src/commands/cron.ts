import type { TaskScheduler } from "../scheduler/service.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { SessionManager } from "../session/manager.js";
import type { CommandContext } from "./project.js";
import { formatTasks, shortId } from "./timer.js";

export async function cronCommand(
  scheduler: TaskScheduler,
  sessions: SessionManager,
  workspaces: WorkspaceRegistry,
  context: CommandContext,
  argumentsText: string,
): Promise<string> {
  const [subcommand = "list", ...parts] = argumentsText.trim().split(/\s+/).filter(Boolean);
  if (subcommand === "list") return formatTasks((await scheduler.list(context.chatId)).filter((task) => task.kind === "cron"));
  if (["remove", "pause", "resume"].includes(subcommand)) {
    const id = parts[0]; if (!id) return `/cron ${subcommand} <任务ID>`;
    const task = await resolveTask(scheduler, context.chatId, id);
    const admin = workspaces.isAdmin(context.senderOpenId);
    if (subcommand === "remove") { await scheduler.remove(task.id, context.senderOpenId, admin); return "Cron 任务已删除。"; }
    if (subcommand === "pause") { await scheduler.pause(task.id, context.senderOpenId, admin); return "Cron 任务已暂停。"; }
    await scheduler.resume(task.id, context.senderOpenId, admin); return "Cron 任务已恢复。";
  }
  if (subcommand === "add") {
    if (parts.length < 6) return "用法：/cron add <分 时 日 月 周> <任务内容>";
    const expression = parts.slice(0, 5).join(" ");
    const prompt = parts.slice(5).join(" ");
    const session = await sessions.getOrCreate(context.chatId);
    const task = await scheduler.addCron({
      chatId: context.deliveryChatId ?? context.chatId,
      conversationId: context.chatId,
      creatorOpenId: context.senderOpenId,
      threadId: session.threadId,
      chatType: context.chatType,
      prompt,
    }, expression);
    return `Cron 任务已创建：${shortId(task.id)}\n表达式：${task.schedule}\n下次执行：${new Date(task.nextRunAt).toLocaleString("zh-CN", { hour12: false })}`;
  }
  return "用法：/cron add|list|remove|pause|resume";
}

async function resolveTask(scheduler: TaskScheduler, conversationId: string, selector: string) {
  const matches = (await scheduler.list(conversationId)).filter((task) => task.id === selector || task.id.startsWith(selector));
  if (matches.length === 0) throw new Error("定时任务不存在");
  if (matches.length > 1) throw new Error("任务 ID 不唯一，请输入更多字符");
  return matches[0]!;
}
