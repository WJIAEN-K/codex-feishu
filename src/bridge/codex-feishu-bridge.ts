import type { CodexAppServerClient } from "../app-server/client.js";
import { AppServerEventMapper, type AgentEvent } from "../app-server/events.js";
import {
  buildInteractiveResponse,
  parseInteractiveRequest,
  type InteractiveAnswers,
  type InteractiveRequest,
  type InteractiveResolution,
} from "../app-server/interactive-requests.js";
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "../app-server/jsonrpc.js";
import type { TurnInput } from "../app-server/protocol.js";
import type { AttachmentDispatcher } from "../attachments/dispatcher.js";
import type { CommandRouter } from "../commands/index.js";
import {
  finalCard,
  interactiveRequestCard,
  interactiveResolvedCard,
  progressCard,
  streamingCard,
  type ToolProgressEntry,
} from "../feishu/cards.js";
import { splitText } from "../feishu/messages.js";
import type { FeishuCardAction, FeishuPort, InboundResource } from "../feishu/types.js";
import type { SessionManager } from "../session/manager.js";
import type { Logger } from "../utils/logger.js";
import { unlink } from "node:fs/promises";

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
  conversationId: string;
  messageId: string;
  text: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  resources: InboundResource[];
  scheduled?: boolean;
  completion?: { resolve: () => void; reject: (error: Error) => void };
}

interface TurnRuntime {
  chatId: string;
  conversationId: string;
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
  done: Promise<boolean>;
  resolveDone: (success: boolean) => void;
  downloadedPaths: string[];
  attachmentToken?: string;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  deadlineGraceTimer?: ReturnType<typeof setTimeout>;
}

interface PendingInteractive {
  request: InteractiveRequest;
  chatId: string;
  conversationId: string;
  messageId: string | null;
  ownerOpenId: string;
  answers: InteractiveAnswers;
  questionIndex: number;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface CodexFeishuBridgeOptions {
  streamFlushMs?: number;
  maxQueuedPerChat?: number;
  attachmentDispatcher?: AttachmentDispatcher;
  attachmentEndpoint?: string;
  attachmentCommand?: string;
  groupSessionMode?: "per-user" | "shared";
  turnDeadlineMs?: number;
  turnInterruptGraceMs?: number;
  externalCardActionHandler?: (action: FeishuCardAction) => Promise<boolean>;
  onManagedTurnStart?: (threadId: string) => void;
  onManagedTurnFinished?: (threadId: string) => Promise<void>;
}

export class CodexFeishuBridge {
  private readonly mapper = new AppServerEventMapper();
  private readonly queues = new Map<string, InboundMessage[]>();
  private readonly processingChats = new Set<string>();
  private readonly runtimes = new Map<string, TurnRuntime>();
  private readonly eventChains = new Map<string, Promise<void>>();
  private readonly pendingInteractions = new Map<string, PendingInteractive>();
  private readonly pendingByChat = new Map<string, string>();
  private readonly streamFlushMs: number;
  private readonly maxQueuedPerChat: number;
  private readonly attachmentDispatcher?: AttachmentDispatcher;
  private readonly attachmentEndpoint?: string;
  private readonly attachmentCommand: string;
  private readonly groupSessionMode: "per-user" | "shared";
  private readonly turnDeadlineMs: number;
  private readonly turnInterruptGraceMs: number;
  private readonly externalCardActionHandler?: (action: FeishuCardAction) => Promise<boolean>;
  private readonly onManagedTurnStart?: (threadId: string) => void;
  private readonly onManagedTurnFinished?: (threadId: string) => Promise<void>;
  private unsubscribeNotification?: () => void;
  private unsubscribeError?: () => void;
  private unsubscribeStderr?: () => void;
  private unsubscribeRequest?: () => void;
  private stopping = false;

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
    this.attachmentDispatcher = options.attachmentDispatcher;
    this.attachmentEndpoint = options.attachmentEndpoint;
    this.attachmentCommand = options.attachmentCommand ?? defaultAttachmentCommand();
    this.groupSessionMode = options.groupSessionMode ?? "per-user";
    this.turnDeadlineMs = options.turnDeadlineMs ?? 0;
    this.turnInterruptGraceMs = options.turnInterruptGraceMs ?? 10_000;
    this.externalCardActionHandler = options.externalCardActionHandler;
    this.onManagedTurnStart = options.onManagedTurnStart;
    this.onManagedTurnFinished = options.onManagedTurnFinished;
  }

  async start(): Promise<void> {
    this.stopping = false;
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
      const conversationId = conversationIdentity(
        chatId,
        chatType,
        senderOpenId,
        this.groupSessionMode,
      );
      void this.receiveMessage({
        chatId,
        conversationId,
        messageId,
        text,
        chatType,
        senderOpenId,
        resources,
      }).catch((error: unknown) => {
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
    this.stopping = true;
    this.declineAllPending("shutdown");
    this.attachmentDispatcher?.revokeAll();
    for (const queue of this.queues.values()) {
      for (const message of queue) message.completion?.reject(new Error("codex-feishu 服务正在停止"));
    }
    this.queues.clear();
    await this.failAllActiveTurns("codex-feishu 服务正在停止");
    this.feishu.disconnect();
    await this.appServer.stop();
    this.unsubscribeNotification?.();
    this.unsubscribeError?.();
    this.unsubscribeStderr?.();
    this.unsubscribeRequest?.();
  }

  async enqueueScheduledPrompt(task: {
    id: string;
    chatId: string;
    conversationId: string;
    creatorOpenId: string;
    chatType: "p2p" | "group";
    prompt: string;
    threadId?: string;
  }): Promise<void> {
    const current = await this.sessions.getOrCreate(task.conversationId);
    if (task.threadId && current.threadId !== task.threadId) {
      throw new Error("定时任务创建时的 Codex 会话已不是当前会话，请切回后重试");
    }
    await new Promise<void>((resolve, reject) => {
      void this.receiveMessage({
        chatId: task.chatId,
        conversationId: task.conversationId,
        messageId: "",
        text: task.prompt,
        chatType: task.chatType,
        senderOpenId: task.creatorOpenId,
        resources: [],
        scheduled: true,
        completion: { resolve, reject },
      }).catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private async receiveMessage(message: InboundMessage): Promise<void> {
    if (this.stopping) {
      message.completion?.reject(new Error("codex-feishu 服务正在停止"));
      return;
    }
    const text = message.text.trim();
    if (text === "/stop") {
      const key = this.pendingByChat.get(message.conversationId);
      const pending = key ? this.pendingInteractions.get(key) : undefined;
      if (pending && pending.ownerOpenId === message.senderOpenId) {
        await this.resolveInteractive(pending, "cancel");
      }
    } else if (await this.tryHandleInteractiveText({ ...message, text })) return;
    if (this.commands.isCommand(text)) {
      const previous = await this.sessions.get(message.conversationId);
      try {
        const response = await this.commands.execute({
          chatId: message.conversationId,
          deliveryChatId: message.chatId,
          senderOpenId: message.senderOpenId,
          chatType: message.chatType,
        }, text);
        const session = await this.sessions.get(message.conversationId);
        if (previous && previous.threadId !== session?.threadId) {
          const runtime = this.runtimes.get(message.conversationId);
          if (!runtime || runtime.threadId !== previous.threadId) {
            this.mapper.unregisterThread(previous.threadId);
          }
        }
        if (session) this.mapper.registerThread(message.conversationId, session.threadId);
        await this.sendChunked(message.chatId, response, message.messageId);
      } catch (error) {
        const normalized = error instanceof Error ? error.message : String(error);
        await this.sendChunked(message.chatId, `命令执行失败：${normalized}`, message.messageId);
      }
      return;
    }
    if (!text && message.resources.length === 0) return;

    const queue = this.queues.get(message.conversationId) ?? [];
    if (queue.length >= this.maxQueuedPerChat) {
      await this.feishu.sendMessage(
        message.chatId,
        "当前任务排队数量达到限制。请等待完成或执行 /stop。",
        message.messageId,
      );
      message.completion?.reject(new Error("当前任务排队数量达到限制"));
      return;
    }
    queue.push({ ...message, text });
    this.queues.set(message.conversationId, queue);
    if (this.processingChats.has(message.conversationId)) {
      await this.feishu.sendMessage(
        message.chatId,
        `已排队（前面还有 ${Math.max(1, queue.length - 1)} 条）`,
        message.messageId,
      );
      return;
    }
    void this.processQueue(message.conversationId);
  }

  private async processQueue(conversationId: string): Promise<void> {
    if (this.processingChats.has(conversationId)) return;
    this.processingChats.add(conversationId);
    try {
      const queue = this.queues.get(conversationId);
      while (queue && queue.length > 0) {
        const message = queue.shift();
        if (!message) break;
        const success = await this.processTurn(message);
        if (success) message.completion?.resolve();
        else message.completion?.reject(new Error("Codex 定时任务执行失败"));
      }
    } finally {
      this.processingChats.delete(conversationId);
      if (this.queues.get(conversationId)?.length === 0) this.queues.delete(conversationId);
    }
  }

  private async processTurn(message: InboundMessage): Promise<boolean> {
    let runtime: TurnRuntime | undefined;
    let downloadedPaths: string[] = [];
    try {
      if (!message.scheduled) await this.feishu.startTyping(message.chatId, message.messageId);
      const built = await this.buildInput(message);
      const input = built.input;
      downloadedPaths = built.downloadedPaths;
      if (input.length === 0) throw new Error("消息中没有可发送给 Codex 的内容");

      const session = await this.sessions.getOrCreate(message.conversationId);
      this.mapper.registerThread(message.conversationId, session.threadId);
      runtime = this.createRuntime(message, session.threadId, downloadedPaths);
      this.runtimes.set(message.conversationId, runtime);
      this.onManagedTurnStart?.(session.threadId);

      let additionalContext;
      if (this.attachmentDispatcher && this.attachmentEndpoint) {
        const scope = this.attachmentDispatcher.createScope({
          chatId: message.chatId,
          replyToMessageId: message.messageId,
          cwd: session.cwd,
        });
        runtime.attachmentToken = scope.token;
        additionalContext = {
          "codex-feishu-attachments": {
            kind: "application" as const,
            value: attachmentInstructions(
              this.attachmentCommand,
              this.attachmentEndpoint,
              scope.token,
            ),
          },
        };
      }
      const updated = await this.sessions.beginTurn(message.conversationId, input, { additionalContext });
      runtime.turnId = updated.activeTurnId;
      this.armTurnDeadline(runtime);
      return await runtime.done;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (runtime) await this.finishRuntime(runtime, false, normalized.message);
      else {
        await this.cleanupDownloadedPaths(downloadedPaths);
        await this.sessions.updateStatus(message.conversationId, "error");
        await this.sendChunked(message.chatId, `Codex 任务启动失败：${normalized.message}`, message.messageId || undefined);
        if (!message.scheduled) await this.feishu.stopTyping(message.chatId, false, message.messageId);
      }
      return false;
    }
  }

  private async buildInput(message: InboundMessage): Promise<{ input: TurnInput[]; downloadedPaths: string[] }> {
    const images: TurnInput[] = [];
    const fileLines: string[] = [];
    const downloadedPaths: string[] = [];
    try {
      for (const resource of message.resources) {
        const localPath = await this.feishu.downloadResource(
          message.messageId,
          resource.fileKey,
          resource.type,
          resource.fileName,
        );
        if (!localPath) {
          fileLines.push(`无法下载用户上传的${resourceLabel(resource.type)}。`);
        } else {
          downloadedPaths.push(localPath);
          if (resource.type === "image") images.push({ type: "localImage", path: localPath });
          else fileLines.push(`用户上传${resourceLabel(resource.type)}：${localPath}`);
        }
      }
    } catch (error) {
      await this.cleanupDownloadedPaths(downloadedPaths);
      throw error;
    }

    const text = [message.text, ...fileLines].filter(Boolean).join("\n");
    return {
      input: [...(text ? [{ type: "text" as const, text, text_elements: [] }] : []), ...images],
      downloadedPaths,
    };
  }

  private createRuntime(message: InboundMessage, threadId: string, downloadedPaths: string[]): TurnRuntime {
    let resolveDone = (_success: boolean): void => {};
    const done = new Promise<boolean>((resolve) => { resolveDone = resolve; });
    return {
      chatId: message.chatId,
      conversationId: message.conversationId,
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
      downloadedPaths,
      done,
      resolveDone,
    };
  }

  private armTurnDeadline(runtime: TurnRuntime): void {
    if (this.turnDeadlineMs <= 0) return;
    runtime.deadlineTimer = setTimeout(() => {
      void (async () => {
        await this.feishu.sendMessage(
          runtime.chatId,
          "Codex 任务已达到最长运行时间，正在尝试中断。",
          runtime.messageId || undefined,
        ).catch((error: unknown) => this.logger.warn("Unable to notify expired Codex turn", error));
        await this.sessions.interrupt(runtime.conversationId).catch((error: unknown) => {
          this.logger.warn("Unable to interrupt expired Codex turn", error);
        });
        runtime.deadlineGraceTimer = setTimeout(() => {
          void this.finishRuntime(runtime, false, "任务超过最长运行时间，已终止等待");
        }, this.turnInterruptGraceMs);
        runtime.deadlineGraceTimer.unref();
      })();
    }, this.turnDeadlineMs);
    runtime.deadlineTimer.unref();
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
    const interactive = parseInteractiveRequest(request);
    if (!interactive) {
      this.appServer.respondError(request.id, -32601, `Unsupported App Server request ${request.method}`);
      return;
    }
    const conversationId = interactive.threadId ? this.mapper.chatIdForThread(interactive.threadId) : undefined;
    if (!conversationId) {
      this.appServer.respondError(request.id, -32001, "No Feishu chat mapped to interactive request thread");
      return;
    }

    const key = interactiveKey(request.id);
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) {
      this.appServer.respondError(request.id, -32002, "No active Feishu task owner for interactive request");
      return;
    }
    if (this.pendingByChat.has(conversationId)) {
      this.appServer.respondError(request.id, -32003, "Another interactive request is already pending for this chat");
      return;
    }
    await this.sessions.updateStatus(
      conversationId,
      "waiting_approval",
      interactive.turnId ?? runtime.turnId,
      interactive.threadId,
    );
    const pending: PendingInteractive = {
      request: interactive,
      chatId: runtime.chatId,
      conversationId,
      messageId: null,
      ownerOpenId: runtime.ownerOpenId,
      answers: {},
      questionIndex: 0,
    };
    this.pendingInteractions.set(key, pending);
    this.pendingByChat.set(conversationId, key);
    if (interactive.autoResolutionMs) {
      pending.timeout = setTimeout(() => {
        void this.resolveInteractive(pending, "cancel").catch((error: unknown) => {
          this.logger.warn("Unable to auto-resolve interactive request", error);
        });
      }, interactive.autoResolutionMs);
      pending.timeout.unref();
    }
    const messageId = await this.feishu.sendCard(runtime.chatId, interactiveRequestCard(interactive));
    pending.messageId = messageId;
    if (!messageId) {
      await this.resolveInteractive(pending, "decline", false);
    }
  }

  private async handleCardAction(action: FeishuCardAction): Promise<void> {
    const pending = this.pendingInteractions.get(action.requestId);
    if (!pending) {
      await this.externalCardActionHandler?.(action);
      return;
    }
    if (action.operatorOpenId !== pending.ownerOpenId) {
      await this.feishu.sendMessage(pending.chatId, "只有发起当前任务的用户可以处理该请求。");
      return;
    }
    if (action.action === "reject") {
      await this.resolveInteractive(pending, "decline");
      return;
    }
    if (action.action === "approve" || action.action === "complete") {
      await this.resolveInteractive(pending, "accept");
      return;
    }
    const question = pending.request.questions[pending.questionIndex];
    if (!question || (action.questionId && action.questionId !== question.id)) return;
    if (action.action === "answer" && typeof action.answer === "string") {
      pending.answers[question.id] = [action.answer];
      await this.advanceInteractive(pending);
      return;
    }
    if (action.action === "skip" && !question.required) {
      await this.advanceInteractive(pending);
    }
  }

  private async tryHandleInteractiveText(message: InboundMessage): Promise<boolean> {
    const key = this.pendingByChat.get(message.conversationId);
    const pending = key ? this.pendingInteractions.get(key) : undefined;
    if (!pending || message.senderOpenId !== pending.ownerOpenId) return false;
    const question = pending.request.questions[pending.questionIndex];
    if (!question) return false;
    if (question.options && !question.allowOther) {
      await this.feishu.sendMessage(message.chatId, "请使用交互卡片中的选项回答当前问题。", message.messageId);
      return true;
    }
    if (!message.text || message.resources.length > 0) {
      await this.feishu.sendMessage(message.chatId, "当前问题只接受文本答案。", message.messageId);
      return true;
    }
    if (question.valueType === "json") {
      try {
        const parsed: unknown = JSON.parse(message.text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      } catch {
        await this.feishu.sendMessage(message.chatId, "请输入有效的 JSON 对象。", message.messageId);
        return true;
      }
    }
    pending.answers[question.id] = [message.text];
    await this.advanceInteractive(pending);
    return true;
  }

  private async advanceInteractive(pending: PendingInteractive): Promise<void> {
    pending.questionIndex += 1;
    if (pending.questionIndex >= pending.request.questions.length) {
      await this.resolveInteractive(pending, "accept");
      return;
    }
    const nextCard = interactiveRequestCard(pending.request, pending.questionIndex);
    if (pending.messageId) await this.feishu.updateCard(pending.messageId, nextCard);
    else pending.messageId = await this.feishu.sendCard(pending.chatId, nextCard);
  }

  private async resolveInteractive(
    pending: PendingInteractive,
    resolution: InteractiveResolution,
    updateCard = true,
  ): Promise<void> {
    const key = interactiveKey(pending.request.requestId);
    if (this.pendingInteractions.get(key) !== pending) return;
    this.pendingInteractions.delete(key);
    if (this.pendingByChat.get(pending.conversationId) === key) {
      this.pendingByChat.delete(pending.conversationId);
    }
    if (pending.timeout) clearTimeout(pending.timeout);
    this.appServer.respond(
      pending.request.requestId,
      buildInteractiveResponse(pending.request, resolution, pending.answers),
    );
    const runtime = this.runtimes.get(pending.conversationId);
    await this.sessions.updateStatus(
      pending.conversationId,
      "running",
      pending.request.turnId ?? runtime?.turnId,
      pending.request.threadId,
    );
    if (updateCard && pending.messageId) {
      try {
        await this.feishu.updateCard(
          pending.messageId,
          interactiveResolvedCard(pending.request, resolution, pending.answers),
        );
      } catch (error) {
        this.logger.warn("Unable to update resolved interactive card", error);
        await this.feishu.sendMessage(
          pending.chatId,
          `${interactiveResolutionLabel(pending.request, resolution)}（卡片更新失败，审批结果已生效）`,
          pending.messageId,
        ).catch((sendError: unknown) => this.logger.warn("Unable to send interactive resolution fallback", sendError));
      }
    }
  }

  private declineAllPending(reason: "shutdown" | "failure"): void {
    for (const pending of this.pendingInteractions.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      try {
        this.appServer.respond(
          pending.request.requestId,
          buildInteractiveResponse(
            pending.request,
            reason === "shutdown" ? "decline" : "cancel",
            pending.answers,
          ),
        );
      } catch (error) {
        this.logger.warn("Unable to resolve pending interactive request", error);
      }
    }
    this.pendingInteractions.clear();
    this.pendingByChat.clear();
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
      void this.flushStream(runtime, false).catch((error: unknown) => {
        this.logger.warn("Unable to flush streaming Feishu output", error);
      });
    }, this.streamFlushMs);
    runtime.flushTimer.unref();
  }

  private flushStream(runtime: TurnRuntime, final: boolean): Promise<void> {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    runtime.flushChain = runtime.flushChain.catch(() => undefined).then(async () => {
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
    runtime.progressChain = runtime.progressChain.catch(() => undefined).then(async () => {
      const card = progressCard([...runtime.tools.values()], finished);
      if (runtime.progressMessageId) await this.feishu.updateCard(runtime.progressMessageId, card);
      else runtime.progressMessageId = await this.feishu.sendCard(runtime.chatId, card, runtime.messageId);
    });
    return runtime.progressChain;
  }

  private async finishRuntime(runtime: TurnRuntime, success: boolean, error?: string): Promise<void> {
    if (runtime.finishing) {
      await runtime.done;
      return;
    }
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
        runtime.conversationId,
        success ? "idle" : "error",
        undefined,
        runtime.threadId,
      );
    } catch (sessionError) {
      this.logger.error("Unable to update final session status", sessionError);
    }
    try {
      if (runtime.messageId) await this.feishu.stopTyping(runtime.chatId, success, runtime.messageId);
    } catch (reactionError) {
      this.logger.warn("Unable to clear Feishu Typing reaction", reactionError);
    } finally {
      if (runtime.attachmentToken) this.attachmentDispatcher?.revoke(runtime.attachmentToken);
      await this.cleanupDownloadedPaths(runtime.downloadedPaths);
      if (runtime.deadlineTimer) clearTimeout(runtime.deadlineTimer);
      if (runtime.deadlineGraceTimer) clearTimeout(runtime.deadlineGraceTimer);
      await this.onManagedTurnFinished?.(runtime.threadId).catch((error: unknown) => {
        this.logger.warn("Unable to advance local sync cursor after managed turn", error);
      });
      this.runtimes.delete(runtime.conversationId);
      try {
        const current = await this.sessions.get(runtime.conversationId);
        if (current?.threadId !== runtime.threadId) this.mapper.unregisterThread(runtime.threadId);
      } catch (sessionError) {
        this.logger.warn("Unable to clean up completed thread mapping", sessionError);
      }
      runtime.resolveDone(success);
    }
  }

  private async cleanupDownloadedPaths(paths: string[]): Promise<void> {
    await Promise.all(paths.map((path) => unlink(path).catch(() => {})));
  }

  private async failAllActiveTurns(message: string): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => this.finishRuntime(runtime, false, message)));
  }

  private async handleAppServerFailure(message: string): Promise<void> {
    this.declineAllPending("failure");
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

function interactiveKey(id: JsonRpcId): string {
  return String(id);
}

function interactiveResolutionLabel(request: InteractiveRequest, resolution: InteractiveResolution): string {
  if (resolution === "accept") {
    return request.kind === "approval" || request.kind === "permission_approval" ? "✅ 已批准" : "✅ 已提交";
  }
  return resolution === "decline" ? "❌ 已拒绝" : "⏱️ 已取消";
}

function conversationIdentity(
  chatId: string,
  chatType: "p2p" | "group",
  senderOpenId: string,
  groupMode: "per-user" | "shared",
): string {
  if (chatType === "p2p" || groupMode === "shared") return chatId;
  return `${chatId}:user:${senderOpenId}`;
}

function defaultAttachmentCommand(): string {
  const entry = process.argv[1];
  return entry
    ? `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} send`
    : "codex-feishu send";
}

function attachmentInstructions(command: string, endpoint: string, token: string): string {
  const common = `${command} --endpoint ${endpoint} --token ${token}`;
  return [
    "You can return files generated during this turn to the originating Feishu chat.",
    "Only send a file when the user asks for it or when the file is a direct deliverable.",
    `For an image run: ${common} --image \"/absolute/path/to/image.png\"`,
    `For another file run: ${common} --file \"/absolute/path/to/file\"`,
    "The path must be an existing regular file inside the current workspace. This capability expires when the turn ends.",
  ].join("\n");
}
