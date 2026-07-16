import type { TaskScheduler } from "../scheduler/service.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { SessionManager } from "../session/manager.js";
import type { CommandContext } from "./project.js";

export async function timerCommand(
  scheduler: TaskScheduler,
  sessions: SessionManager,
  workspaces: WorkspaceRegistry,
  context: CommandContext,
  argumentsText: string,
): Promise<string> {
  const text = argumentsText.trim();
  if (text === "list") return formatTasks(await scheduler.list(context.chatId));
  const remove = text.match(/^remove\s+(\S+)$/i);
  if (remove) {
    await scheduler.remove(remove[1]!, context.senderOpenId, workspaces.isAdmin(context.senderOpenId));
    return "定时任务已删除。";
  }
  const match = text.match(/^(\d+(?:\.\d+)?(?:s|m|h|d))\s+([\s\S]+)$/i);
  if (!match) return "用法：/timer <10s|5m|2h|1d> <任务内容>，或 /timer list|remove <ID>";
  const session = await sessions.getOrCreate(context.chatId);
  const task = await scheduler.addTimer({
    chatId: context.deliveryChatId ?? context.chatId,
    conversationId: context.chatId,
    creatorOpenId: context.senderOpenId,
    threadId: session.threadId,
    chatType: context.chatType,
    prompt: match[2]!,
  }, parseDuration(match[1]!));
  return `定时任务已创建：${shortId(task.id)}\n执行时间：${formatTime(task.nextRunAt)}`;
}

export function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!match) throw new Error("无效时长");
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("时长超出支持范围");
  return result;
}

export function formatTasks(tasks: Awaited<ReturnType<TaskScheduler["list"]>>): string {
  if (tasks.length === 0) return "当前对话没有定时任务。";
  return ["当前对话的定时任务：", ...tasks.map((task) => (
    `${task.status === "active" ? "●" : "○"} ${shortId(task.id)} · ${task.kind === "cron" ? task.schedule : formatTime(task.nextRunAt)}` +
    `\n   ${task.prompt.slice(0, 80)}${task.lastError ? `\n   错误：${task.lastError}` : ""}`
  ))].join("\n");
}

export const shortId = (id: string): string => id.slice(0, 8);
const formatTime = (value: number): string => new Date(value).toLocaleString("zh-CN", { hour12: false });
