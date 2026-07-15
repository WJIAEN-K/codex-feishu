import type { JsonRpcNotification } from "./jsonrpc.js";
import { isObject } from "./jsonrpc.js";
import type { ServerNotification } from "./generated/ServerNotification.js";

type ParamsFor<Method extends ServerNotification["method"]> =
  Extract<ServerNotification, { method: Method }>["params"];

interface EventBase {
  chatId: string;
  threadId?: string;
}

export type AgentEvent =
  | (EventBase & { type: "thread_started"; threadId: string })
  | (EventBase & { type: "turn_started"; turnId: string })
  | (EventBase & { type: "text_delta"; turnId?: string; text: string })
  | (EventBase & { type: "text_completed"; turnId?: string; text: string })
  | (EventBase & {
      type: "tool_started";
      turnId?: string;
      itemId: string;
      name: string;
      detail?: string;
    })
  | (EventBase & {
      type: "tool_completed";
      turnId?: string;
      itemId: string;
      success: boolean;
    })
  | (EventBase & { type: "turn_completed"; turnId: string; success: boolean; error?: string })
  | (EventBase & { type: "error"; turnId?: string; message: string });

export class AppServerEventMapper {
  private readonly threadToChat = new Map<string, string>();

  registerThread(chatId: string, threadId: string): void {
    this.threadToChat.set(threadId, chatId);
  }

  unregisterThread(threadId: string): void {
    this.threadToChat.delete(threadId);
  }

  chatIdForThread(threadId: string): string | undefined {
    return this.threadToChat.get(threadId);
  }

  map(notification: JsonRpcNotification): AgentEvent[] {
    const params = isObject(notification.params) ? notification.params : {};
    const threadId = extractId(params, "threadId", "thread");
    const turnId = extractId(params, "turnId", "turn");
    const chatId = threadId ? this.threadToChat.get(threadId) : undefined;
    if (!chatId) return [];

    switch (notification.method) {
      case "thread/started":
        return threadId ? [{ type: "thread_started", chatId, threadId }] : [];
      case "turn/started":
        return turnId ? [{ type: "turn_started", chatId, threadId, turnId }] : [];
      case "item/agentMessage/delta": {
        const typed = params as Partial<ParamsFor<"item/agentMessage/delta">>;
        const text = firstString(typed.delta, params.text);
        return text ? [{ type: "text_delta", chatId, threadId, turnId, text }] : [];
      }
      case "item/started": {
        const typed = params as Partial<ParamsFor<"item/started">>;
        const item = isObject(typed.item) ? typed.item : params;
        if (isAgentMessage(item)) return [];
        const itemId = extractId(item, "itemId", "item") ?? firstString(item.id);
        if (!itemId) return [];
        const display = describeTool(item);
        return [{
          type: "tool_started",
          chatId,
          threadId,
          turnId,
          itemId,
          name: display.name,
          detail: display.detail,
        }];
      }
      case "item/completed": {
        const typed = params as Partial<ParamsFor<"item/completed">>;
        const item = isObject(typed.item) ? typed.item : params;
        if (isAgentMessage(item)) {
          const text = agentMessageText(item);
          return text ? [{ type: "text_completed", chatId, threadId, turnId, text }] : [];
        }
        const itemId = extractId(item, "itemId", "item") ?? firstString(item.id);
        if (!itemId) return [];
        const status = firstString((item as Record<string, unknown>).status, params.status)?.toLowerCase();
        const success = status !== "failed" && status !== "error" && status !== "cancelled";
        return [{ type: "tool_completed", chatId, threadId, turnId, itemId, success }];
      }
      case "turn/completed": {
        if (!turnId) return [];
        const typed = params as Partial<ParamsFor<"turn/completed">>;
        const turn = isObject(typed.turn) ? typed.turn : params;
        const status = firstString(turn.status, params.status)?.toLowerCase();
        const error = errorMessage(turn.error ?? params.error);
        const success = !error && status !== "failed" && status !== "error" && status !== "cancelled";
        return [{ type: "turn_completed", chatId, threadId, turnId, success, error }];
      }
      case "error":
      case "turn/error": {
        const message = errorMessage(params.error) ?? firstString(params.message) ?? "Codex App Server error";
        return [{ type: "error", chatId, threadId, turnId, message }];
      }
      case "thread/status/changed": {
        const status = firstString(params.status)?.toLowerCase();
        if (status !== "error") return [];
        return [{
          type: "error",
          chatId,
          threadId,
          turnId,
          message: errorMessage(params.error) ?? "Codex thread entered error state",
        }];
      }
      default:
        return [];
    }
  }
}

function agentMessageText(item: Record<string, unknown>): string | undefined {
  const direct = firstString(item.text, item.message, item.content);
  if (direct) return direct;
  if (!Array.isArray(item.content)) return undefined;
  const parts = item.content
    .map((part) => isObject(part) ? firstString(part.text, part.content) : undefined)
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("") : undefined;
}

function extractId(value: Record<string, unknown>, directKey: string, nestedKey: string): string | undefined {
  const direct = value[directKey];
  if (typeof direct === "string" && direct) return direct;
  const nested = value[nestedKey];
  if (isObject(nested) && typeof nested.id === "string" && nested.id) return nested.id;
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function isAgentMessage(item: Record<string, unknown>): boolean {
  const type = firstString(item.type, item.kind)?.toLowerCase();
  return type === "agentmessage" || type === "agent_message" || type === "message";
}

function describeTool(item: Record<string, unknown>): { name: string; detail?: string } {
  const type = firstString(item.type, item.kind, item.name) ?? "tool";
  const normalized = type.toLowerCase();
  if (normalized.includes("command") || normalized === "shell" || normalized === "bash") {
    return { name: "Shell", detail: firstString(item.command, item.cmd) };
  }
  if (normalized.includes("filechange") || normalized.includes("file_change") || normalized === "edit") {
    return { name: "文件修改", detail: fileChangeDetail(item) };
  }
  if (normalized.includes("mcp")) {
    return { name: "MCP 工具", detail: firstString(item.tool, item.name, item.server) };
  }
  if (normalized.includes("websearch") || normalized.includes("web_search")) {
    return { name: "网络搜索", detail: firstString(item.query) };
  }
  return { name: type, detail: firstString(item.detail, item.description) };
}

function fileChangeDetail(item: Record<string, unknown>): string | undefined {
  const changes = item.changes;
  if (Array.isArray(changes)) {
    const paths = changes
      .map((change) => isObject(change) ? firstString(change.path, change.file) : undefined)
      .filter((path): path is string => Boolean(path));
    if (paths.length > 0) return paths.join(", ");
  }
  return firstString(item.path, item.file);
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string" && error) return error;
  if (isObject(error)) return firstString(error.message, error.detail);
  return undefined;
}
