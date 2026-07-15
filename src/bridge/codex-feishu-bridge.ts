import {
  mapApprovalRequest,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../app-server/approvals.js";
import type { CodexAppServerClient } from "../app-server/client.js";
import { AppServerEventMapper, type AgentEvent } from "../app-server/events.js";
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "../app-server/jsonrpc.js";
import type { TurnInput } from "../app-server/protocol.js";
import type { CommandRouter } from "../commands/index.js";
import {
  approvalCard,
  approvalResolvedCard,
  finalCard,
  progressCard,
  streamingCard,
  type ToolProgressEntry,
} from "../feishu/cards.js";
import { splitText } from "../feishu/messages.js";
import type { FeishuCardAction, FeishuPort, InboundResource } from "../feishu/types.js";
import type { SessionManager } from "../session/manager.js";
import type { Logger } from "../utils/logger.js";

type AppServerPort = Pick<CodexAppServerClient,
  | "start"
  | "stop"
  | "getStatus"
  | "onNotification"
  | "onRequest"
  | "onError"
  | "onStderr"
  | "respond"
  | "respondError">;

interface InboundMessage {
  chatId: string;
  messageId: string;
  text: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  resources: InboundResource[];
}

interface TurnRuntime {
  chatId: string;
  messageId: string;
  threadId: string;
  turnId?: string;
  ownerOpenId: string;
  text: string;
  streamMessageId: string | null;
  progressMessageId: string | null;
  tools: Map<string, ToolProgressEntry>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushChain: Promise<void>;
  progressChain: Promise<void>;
  finishing: boolean;
  done: Promise<void>;
  resolveDone: () => void;
}

interface PendingApproval {
  request: ApprovalRequest;
  chatId: string;
  messageId: string | null;
  ownerOpenId: string;
}

export interface CodexFeishuBridgeOptions {
  streamFlushMs?: number;
  maxQueuedPerChat?: number;
}

export class CodexFeishuBridge {
  private readonly mapper = new AppServerEventMapper();
  private readonly queues = new Map<string, InboundMessage[]>();
  private readonly processingChats = new Set<string>();
  private readonly runtimes = new Map<string, TurnRuntime>();
  private readonly eventChains = new Map<string, Promise<void>>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly streamFlushMs: number;
  private readonly maxQueuedPerChat: number;
  private unsubscribeNotification?: () => void;
  private unsubscribeError?: () => void;
  private unsubscribeStderr?: () => void;
  private unsubscribeRequest?: () => void;

  constructor(
    private readonly feishu: FeishuPort,
    private readonly appServer: AppServerPort,
    private readonly sessions: SessionManager,
    private readonly commands: CommandRouter,
    private readonly logger: Logger,
    options: CodexFeishuBridgeOptions = {},
  ) {
    this.streamFlushMs = options.streamFlushMs ?? 750;
    this.maxQueuedPerChat = options.maxQueuedPerChat ?? 20;
  }

  async start(): Promise<void> {
    this.unsubscribeNotification = this.appServer.onNotification((message) => this.onNotification(message));
    this.unsubscribeRequest = this.appServer.onRequest((request) => {
      void this.handleServerRequest(request).catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.logger.error("Approval request handling failed", normalized);
        this.appServer.respondError(request.id, -32603, normalized.message);
      });
    });
    this.unsubscribeError = this.appServer.onError((error) => {
      this.logger.error("Codex App Server error", error);
      void this.handleAppServerFailure(error.message);
    });
    this.unsubscribeStderr = this.appServer.onStderr((line) => this.logger.debug(`Codex: ${line}`));
    this.feishu.setOnStatusChange((status) => this.logger.info(`Feishu status: ${status}`));
    this.feishu.setOnCardAction((action) => this.handleCardAction(action));
    this.feishu.setOnMessage((chatId, messageId, text, chatType, resources, senderOpenId) => {
      void this.receiveMessage({ chatId, messageId, text, chatType, senderOpenId, resources }).catch((error: unknown) => {
        this.logger.error("Unable to handle Feishu message", error);
      });
    });

    await this.appServer.start();
    try {
      await this.feishu.connect();
    } catch (error) {
      await this.appServer.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingApprovals.values()) {
      try {
        this.appServer.respond(pending.request.requestId, { decision: "decline" });
      } catch (error) {
        this.logger.warn("Unable to decline pending approval during shutdown", error);
      }
    }
    this.pendingApprovals.clear();
    await this.failAllActiveTurns("codex-feishu 服务正在停止");
    this.feishu.disconnect();
    await this.appServer.stop();
    this.unsubscribeNotification?.();
    this.unsubscribeError?.();
    this.unsubscribeStderr?.();
    this.unsubscribeRequest?.();
  }

  private async receiveMessage(message: InboundMessage): Promise<void> {
    const text = message.text.trim();
    if (this.commands.isCommand(text)) {
      const previous = await this.sessions.get(message.chatId);
      try {
        const response = await this.commands.execute({
          chatId: message.chatId,
          senderOpenId: message.senderOpenId,
          chatType: message.chatType,
        }, text);
        const session = await this.sessions.get(message.chatId);
        if (previous && previous.threadId !== session?.threadId) {
          const runtime = this.runtimes.get(message.chatId);
          if (!runtime || runtime.threadId !== previous.threadId) {
            this.mapper.unregisterThread(previous.threadId);
          }
        }
        if (session) this.mapper.registerThread(message.chatId, session.threadId);
        await this.sendChunked(message.chatId, response, message.messageId);
      } catch (error) {
        const normalized = error instanceof Error ? error.message : String(error);
        await this.sendChunked(message.chatId, `命令执行失败：${normalized}`, message.messageId);
      }
      return;
    }
    if (!text && message.resources.length === 0) return;

    const queue = this.queues.get(message.chatId) ?? [];
    if (queue.length >= this.maxQueuedPerChat) {
      await this.feishu.sendMessage(
        message.chatId,
        "当前任务排队数量达到限制。请等待完成或执行 /stop。",
        message.messageId,
      );
      return;
    }
    queue.push({ ...message, text });
    this.queues.set(message.chatId, queue);
    if (this.processingChats.has(message.chatId)) {
      await this.feishu.sendMessage(
        message.chatId,
        `已排队（前面还有 ${Math.max(1, queue.length - 1)} 条）`,
        message.messageId,
      );
      return;
    }
    void this.processQueue(message.chatId);
  }

  private async processQueue(chatId: string): Promise<void> {
    if (this.processingChats.has(chatId)) return;
    this.processingChats.add(chatId);
    try {
      const queue = this.queues.get(chatId);
      while (queue && queue.length > 0) {
        const message = queue.shift();
        if (!message) break;
        await this.processTurn(message);
      }
    } finally {
      this.processingChats.delete(chatId);
      if (this.queues.get(chatId)?.length === 0) this.queues.delete(chatId);
    }
  }

  private async processTurn(message: InboundMessage): Promise<void> {
    await this.feishu.startTyping(message.chatId, message.messageId);
    let runtime: TurnRuntime | undefined;
    try {
      const input = await this.buildInput(message);
      if (input.length === 0) throw new Error("消息中没有可发送给 Codex 的内容");

      const session = await this.sessions.getOrCreate(message.chatId);
      this.mapper.registerThread(message.chatId, session.threadId);
      runtime = this.createRuntime(message, session.threadId);
      this.runtimes.set(message.chatId, runtime);

      const updated = await this.sessions.beginTurn(message.chatId, input);
      runtime.turnId = updated.activeTurnId;
      await runtime.done;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (runtime) await this.finishRuntime(runtime, false, normalized.message);
      else {
        await this.sessions.updateStatus(message.chatId, "error");
        await this.sendChunked(message.chatId, `Codex 任务启动失败：${normalized.message}`, message.messageId);
        await this.feishu.stopTyping(message.chatId, false);
      }
    }
  }

  private async buildInput(message: InboundMessage): Promise<TurnInput[]> {
    const images: TurnInput[] = [];
    const fileLines: string[] = [];
    for (const resource of message.resources) {
      const localPath = await this.feishu.downloadResource(
        message.messageId,
        resource.fileKey,
        resource.type,
        resource.fileName,
      );
      if (!localPath) {
        fileLines.push(`无法下载用户上传的${resourceLabel(resource.type)}。`);
      } else if (resource.type === "image") {
        images.push({ type: "localImage", path: localPath });
      } else {
        fileLines.push(`用户上传${resourceLabel(resource.type)}：${localPath}`);
      }
    }

    const text = [message.text, ...fileLines].filter(Boolean).join("\n");
    return [...(text ? [{ type: "text" as const, text, text_elements: [] }] : []), ...images];
  }

  private createRuntime(message: InboundMessage, threadId: string): TurnRuntime {
    let resolveDone = (): void => {};
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    return {
      chatId: message.chatId,
      messageId: message.messageId,
      threadId,
      ownerOpenId: message.senderOpenId,
      text: "",
      streamMessageId: null,
      progressMessageId: null,
      tools: new Map(),
      flushTimer: null,
      flushChain: Promise.resolve(),
      progressChain: Promise.resolve(),
      finishing: false,
      done,
      resolveDone,
    };
  }

  private onNotification(notification: JsonRpcNotification): void {
    for (const event of this.mapper.map(notification)) {
      const previous = this.eventChains.get(event.chatId) ?? Promise.resolve();
      const next = previous
        .then(() => this.handleAgentEvent(event))
        .catch((error: unknown) => this.logger.error("Agent event handling failed", error));
      this.eventChains.set(event.chatId, next);
      void next.finally(() => {
        if (this.eventChains.get(event.chatId) === next) this.eventChains.delete(event.chatId);
      });
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const approval = mapApprovalRequest(request);
    if (!approval) {
      this.appServer.respondError(request.id, -32601, `Unsupported App Server request ${request.method}`);
      return;
    }
    const chatId = approval.threadId ? this.mapper.chatIdForThread(approval.threadId) : undefined;
    if (!chatId) {
      this.appServer.respondError(request.id, -32001, "No Feishu chat mapped to approval thread");
      return;
    }

    const key = approvalKey(request.id);
    const runtime = this.runtimes.get(chatId);
    if (!runtime) {
      this.appServer.respondError(request.id, -32002, "No active Feishu task owner for approval");
      return;
    }
    await this.sessions.updateStatus(
      chatId,
      "waiting_approval",
      approval.turnId ?? runtime?.turnId,
      approval.threadId,
    );
    const pending: PendingApproval = {
      request: approval,
      chatId,
      messageId: null,
      ownerOpenId: runtime.ownerOpenId,
    };
    this.pendingApprovals.set(key, pending);
    const messageId = await this.feishu.sendCard(chatId, approvalCard(approval));
    pending.messageId = messageId;
    if (!messageId) {
      this.pendingApprovals.delete(key);
      this.appServer.respond(request.id, { decision: "decline" });
      await this.sessions.updateStatus(
        chatId,
        "running",
        approval.turnId ?? runtime?.turnId,
        approval.threadId,
      );
    }
  }

  private async handleCardAction(action: FeishuCardAction): Promise<void> {
    const pending = this.pendingApprovals.get(action.requestId);
    if (!pending) return;
    if (action.operatorOpenId !== pending.ownerOpenId) {
      await this.feishu.sendMessage(pending.chatId, "只有发起当前任务的用户可以处理该审批。");
      return;
    }
    this.pendingApprovals.delete(action.requestId);
    const decision: ApprovalDecision = action.action === "approve" ? "accept" : "decline";
    this.appServer.respond(pending.request.requestId, { decision });
    if (pending.messageId) {
      await this.feishu.updateCard(
        pending.messageId,
        approvalResolvedCard(pending.request, decision),
      );
    }
    const runtime = this.runtimes.get(pending.chatId);
    await this.sessions.updateStatus(
      pending.chatId,
      "running",
      pending.request.turnId ?? runtime?.turnId,
      pending.request.threadId,
    );
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    const runtime = this.runtimes.get(event.chatId);
    if (!runtime || (event.threadId && runtime.threadId !== event.threadId)) return;

    switch (event.type) {
      case "thread_started":
        return;
      case "turn_started":
        runtime.turnId = event.turnId;
        await this.sessions.updateStatus(event.chatId, "running", event.turnId, runtime.threadId);
        return;
      case "text_delta":
        runtime.text += event.text;
        this.scheduleStreamFlush(runtime);
        return;
      case "text_completed":
        if (!runtime.text) runtime.text = event.text;
        else if (event.text.startsWith(runtime.text)) runtime.text += event.text.slice(runtime.text.length);
        this.scheduleStreamFlush(runtime);
        return;
      case "tool_started":
        runtime.tools.set(event.itemId, {
          itemId: event.itemId,
          name: event.name,
          detail: event.detail,
          status: "running",
        });
        await this.syncProgress(runtime);
        return;
      case "tool_completed": {
        const entry = runtime.tools.get(event.itemId);
        if (entry) entry.status = event.success ? "done" : "error";
        else runtime.tools.set(event.itemId, {
          itemId: event.itemId,
          name: "工具",
          status: event.success ? "done" : "error",
        });
        await this.syncProgress(runtime);
        return;
      }
      case "turn_completed":
        await this.finishRuntime(runtime, event.success, event.error);
        return;
      case "error":
        await this.finishRuntime(runtime, false, event.message);
    }
  }

  private scheduleStreamFlush(runtime: TurnRuntime): void {
    if (runtime.flushTimer || runtime.finishing) return;
    runtime.flushTimer = setTimeout(() => {
      runtime.flushTimer = null;
      void this.flushStream(runtime, false);
    }, this.streamFlushMs);
    runtime.flushTimer.unref();
  }

  private flushStream(runtime: TurnRuntime, final: boolean): Promise<void> {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    runtime.flushChain = runtime.flushChain.then(async () => {
      const text = splitText(runtime.text)[0] ?? "";
      const card = final ? finalCard(text) : streamingCard(text);
      if (runtime.streamMessageId) await this.feishu.updateCard(runtime.streamMessageId, card);
      else {
        runtime.streamMessageId = await this.feishu.sendCard(runtime.chatId, card, runtime.messageId);
        if (final && !runtime.streamMessageId) {
          await this.feishu.sendMessage(runtime.chatId, text, runtime.messageId);
        }
      }
    });
    return runtime.flushChain;
  }

  private syncProgress(runtime: TurnRuntime, finished = false): Promise<void> {
    runtime.progressChain = runtime.progressChain.then(async () => {
      const card = progressCard([...runtime.tools.values()], finished);
      if (runtime.progressMessageId) await this.feishu.updateCard(runtime.progressMessageId, card);
      else runtime.progressMessageId = await this.feishu.sendCard(runtime.chatId, card, runtime.messageId);
    });
    return runtime.progressChain;
  }

  private async finishRuntime(runtime: TurnRuntime, success: boolean, error?: string): Promise<void> {
    if (runtime.finishing) return runtime.done;
    runtime.finishing = true;
    if (!success) {
      const message = error ?? "Codex 任务执行失败";
      runtime.text = runtime.text
        ? `${runtime.text}\n\n---\nCodex 执行失败：${message}`
        : `Codex 执行失败：${message}`;
    } else if (!runtime.text) {
      runtime.text = "Codex 任务已完成，但没有返回文本。";
    }

    try {
      await this.flushStream(runtime, true);
      const chunks = splitText(runtime.text);
      for (const chunk of chunks.slice(1)) await this.feishu.sendMessage(runtime.chatId, chunk);
      if (runtime.tools.size > 0) {
        for (const entry of runtime.tools.values()) {
          if (entry.status === "running") entry.status = success ? "done" : "error";
        }
        await this.syncProgress(runtime, true);
      }
    } catch (deliveryError) {
      this.logger.error("Unable to deliver final Feishu output", deliveryError);
    }
    try {
      await this.sessions.updateStatus(
        runtime.chatId,
        success ? "idle" : "error",
        undefined,
        runtime.threadId,
      );
    } catch (sessionError) {
      this.logger.error("Unable to update final session status", sessionError);
    }
    try {
      await this.feishu.stopTyping(runtime.chatId, success);
    } catch (reactionError) {
      this.logger.warn("Unable to clear Feishu Typing reaction", reactionError);
    } finally {
      this.runtimes.delete(runtime.chatId);
      try {
        const current = await this.sessions.get(runtime.chatId);
        if (current?.threadId !== runtime.threadId) this.mapper.unregisterThread(runtime.threadId);
      } catch (sessionError) {
        this.logger.warn("Unable to clean up completed thread mapping", sessionError);
      }
      runtime.resolveDone();
    }
  }

  private async failAllActiveTurns(message: string): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => this.finishRuntime(runtime, false, message)));
  }

  private async handleAppServerFailure(message: string): Promise<void> {
    this.pendingApprovals.clear();
    await this.failAllActiveTurns(message);
  }

  private async sendChunked(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const chunks = splitText(text);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.feishu.sendMessage(chatId, chunks[index] ?? "", index === 0 ? replyToMessageId : undefined);
    }
  }
}

function resourceLabel(type: InboundResource["type"]): string {
  switch (type) {
    case "image": return "图片";
    case "audio": return "音频";
    case "video": return "视频";
    case "file": return "文件";
  }
}

function approvalKey(id: JsonRpcId): string {
  return String(id);
}
