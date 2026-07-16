import { describe, expect, it, vi } from "vitest";

import type { CodexAppServerClient } from "../src/app-server/client.js";
import { AttachmentDispatcher } from "../src/attachments/dispatcher.js";
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "../src/app-server/jsonrpc.js";
import { CodexFeishuBridge } from "../src/bridge/codex-feishu-bridge.js";
import { CommandRouter } from "../src/commands/index.js";
import type {
  CardActionHandler,
  FeishuCardAction,
  FeishuPort,
  InboundResource,
  MessageHandler,
} from "../src/feishu/types.js";
import { SessionManager } from "../src/session/manager.js";
import { MemorySessionStore } from "../src/session/memory-store.js";
import { Logger } from "../src/utils/logger.js";
import type { WorkspaceRegistry } from "../src/workspace/registry.js";

class FakeFeishu implements FeishuPort {
  handler?: MessageHandler;
  cardActionHandler?: CardActionHandler;
  messages: Array<{ chatId: string; text: string; replyTo?: string }> = [];
  cards: Array<{ id: string; card: Record<string, unknown>; replyTo?: string }> = [];
  updates: Array<{ id: string; card: Record<string, unknown> }> = [];
  typingStarts: string[] = [];
  typingStops: Array<{ chatId: string; success: boolean }> = [];
  cardReturnsNull = false;
  failCardUpdates = false;
  failMessages = false;

  async connect(): Promise<void> {}
  disconnect(): void {}
  getStatus() { return "connected" as const; }
  setOnMessage(handler: MessageHandler): void { this.handler = handler; }
  setOnStatusChange(): void {}
  setOnCardAction(handler: CardActionHandler): void { this.cardActionHandler = handler; }
  async sendMessage(chatId: string, text: string, replyTo?: string): Promise<void> {
    if (this.failMessages) throw new Error("message delivery failed");
    this.messages.push({ chatId, text, replyTo });
  }
  async sendCard(_chatId: string, card: Record<string, unknown>, replyTo?: string): Promise<string | null> {
    const id = `card-${this.cards.length + 1}`;
    this.cards.push({ id, card, replyTo });
    return this.cardReturnsNull ? null : id;
  }
  async updateCard(id: string, card: Record<string, unknown>): Promise<void> {
    if (this.failCardUpdates) throw new Error("card patch failed");
    this.updates.push({ id, card });
  }
  async downloadResource(
    _messageId: string,
    fileKey: string,
    _resourceType: string,
    fileName?: string,
  ): Promise<string> {
    return `/tmp/feishu-media/${fileName ?? fileKey}`;
  }
  async uploadImage(): Promise<string> { return "image-key"; }
  async uploadFile(): Promise<string> { return "file-key"; }
  async sendImage(): Promise<void> {}
  async sendFile(): Promise<void> {}
  async startTyping(chatId: string): Promise<void> { this.typingStarts.push(chatId); }
  async stopTyping(chatId: string, success = true): Promise<void> {
    this.typingStops.push({ chatId, success });
  }
  receive(
    chatId: string,
    messageId: string,
    text: string,
    resources: InboundResource[] = [],
    senderOpenId = "ou-test-user",
  ): void {
    this.handler?.(chatId, messageId, text, "p2p", resources, senderOpenId);
  }
  receiveGroup(
    chatId: string,
    messageId: string,
    text: string,
    senderOpenId: string,
  ): void {
    this.handler?.(chatId, messageId, text, "group", [], senderOpenId);
  }
  async click(
    requestId: string,
    action: FeishuCardAction["action"],
    operatorOpenId = "ou-test-user",
    details: Pick<FeishuCardAction, "questionId" | "answer"> = {},
  ): Promise<void> {
    await this.cardActionHandler?.({ requestId, action, operatorOpenId, ...details });
  }
}

class FakeAppServer {
  status = "stopped" as "stopped" | "ready";
  threadCount = 0;
  turnCount = 0;
  calls: Array<{ method: string; params: unknown }> = [];
  responses: Array<{ id: JsonRpcId; result?: unknown; error?: unknown }> = [];
  turnScenario: (threadId: string, turnId: string) => JsonRpcNotification[] = defaultScenario;
  private notifications = new Set<(message: JsonRpcNotification) => void>();
  private errors = new Set<(error: Error) => void>();
  private requests = new Set<(request: JsonRpcRequest) => void>();

  async start(): Promise<void> { this.status = "ready"; }
  async stop(): Promise<void> { this.status = "stopped"; }
  getStatus() { return this.status; }
  onNotification(handler: (message: JsonRpcNotification) => void) {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }
  onError(handler: (error: Error) => void) {
    this.errors.add(handler);
    return () => this.errors.delete(handler);
  }
  onRequest(handler: (request: JsonRpcRequest) => void) {
    this.requests.add(handler);
    return () => this.requests.delete(handler);
  }
  onStderr() { return () => {}; }
  respond(id: JsonRpcId, result: unknown): void { this.responses.push({ id, result }); }
  respondError(id: JsonRpcId, code: number, message: string): void {
    this.responses.push({ id, error: { code, message } });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: `thread-${++this.threadCount}` } } as T;
    }
    if (method === "thread/resume" || method === "turn/interrupt") return {} as T;
    if (method === "turn/start") {
      const turnId = `turn-${++this.turnCount}`;
      const threadId = (params as { threadId: string }).threadId;
      const events = this.turnScenario(threadId, turnId);
      setTimeout(() => events.forEach((event) => this.emit(event)), 0);
      return { turn: { id: turnId } } as T;
    }
    throw new Error(`Unexpected method ${method}`);
  }

  emit(message: JsonRpcNotification): void {
    for (const handler of this.notifications) handler(message);
  }

  fail(error: Error): void {
    for (const handler of this.errors) handler(error);
  }

  emitRequest(request: JsonRpcRequest): void {
    for (const handler of this.requests) handler(request);
  }
}

function defaultScenario(threadId: string, turnId: string): JsonRpcNotification[] {
  return [
    { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "完成" } },
    { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
  ];
}

async function setup(options: {
  maxQueuedPerChat?: number;
  attachments?: boolean;
  groupSessionMode?: "per-user" | "shared";
  turnDeadlineMs?: number;
  turnInterruptGraceMs?: number;
} = {}) {
  const feishu = new FakeFeishu();
  const appServer = new FakeAppServer();
  const sessions = new SessionManager(
    new MemorySessionStore(),
    appServer as unknown as Pick<CodexAppServerClient, "request">,
    { cwd: "/workspace" },
  );
  const commands = new CommandRouter(
    sessions,
    appServer as unknown as CodexAppServerClient,
    {} as WorkspaceRegistry,
  );
  const attachmentDispatcher = options.attachments
    ? new AttachmentDispatcher(feishu, { maxFileBytes: 1024 })
    : undefined;
  const bridge = new CodexFeishuBridge(
    feishu,
    appServer as unknown as CodexAppServerClient,
    sessions,
    commands,
    new Logger("error"),
    {
      streamFlushMs: 1,
      maxQueuedPerChat: options.maxQueuedPerChat,
      attachmentDispatcher,
      attachmentEndpoint: attachmentDispatcher ? "http://127.0.0.1:12345" : undefined,
      attachmentCommand: "codex-feishu send",
      groupSessionMode: options.groupSessionMode,
      turnDeadlineMs: options.turnDeadlineMs,
      turnInterruptGraceMs: options.turnInterruptGraceMs,
    },
  );
  await bridge.start();
  return { feishu, appServer, sessions, bridge, attachmentDispatcher };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for bridge state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function cardText(card: Record<string, unknown>): string {
  return JSON.stringify(card);
}

function allRenderedCardText(feishu: FakeFeishu): string {
  return [
    ...feishu.cards.map(({ card }) => cardText(card)),
    ...feishu.updates.map(({ card }) => cardText(card)),
  ].join("\n");
}

describe("CodexFeishuBridge", () => {
  it("interrupts a turn at its wall-clock deadline and recovers the queue", async () => {
    const { feishu, appServer, sessions, bridge } = await setup({
      turnDeadlineMs: 10,
      turnInterruptGraceMs: 10,
    });
    appServer.turnScenario = () => [];
    feishu.receive("chat-1", "message-1", "无限等待任务");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/interrupt"));
    await waitFor(() => feishu.typingStops.length === 1);

    expect(feishu.messages.some(({ text }) => text.includes("最长运行时间"))).toBe(true);
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ status: "error" });
    appServer.turnScenario = defaultScenario;
    feishu.receive("chat-1", "message-2", "恢复执行");
    await waitFor(() => feishu.typingStops.length === 2);
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ status: "idle" });
    await bridge.stop();
  });

  it("still interrupts an expired turn when the warning message cannot be delivered", async () => {
    const { feishu, appServer, bridge } = await setup({ turnDeadlineMs: 10, turnInterruptGraceMs: 10 });
    appServer.turnScenario = () => [];
    feishu.failMessages = true;
    feishu.receive("chat-1", "message-1", "无限等待任务");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/interrupt"));
    feishu.failMessages = false;
    await waitFor(() => feishu.typingStops.length === 1);
    await bridge.stop();
  });
  it("streams text, updates tool progress, and cleans up a completed turn", async () => {
    const { feishu, appServer, sessions, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "item/started", params: {
        threadId, turnId, item: { id: "tool-1", type: "commandExecution", command: "npm test" },
      } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: "测试通过" } },
      { method: "item/completed", params: {
        threadId, turnId, item: { id: "tool-1", type: "commandExecution", status: "completed" },
      } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ];

    feishu.receive("chat-1", "message-1", "运行测试");
    await waitFor(() => feishu.typingStops.length === 1);

    expect(appServer.calls.map((call) => call.method)).toEqual(["thread/start", "turn/start"]);
    expect(feishu.cards.some(({ card }) => cardText(card).includes("Shell"))).toBe(true);
    expect(allRenderedCardText(feishu)).toContain("测试通过");
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ status: "idle", threadId: "thread-1" });
    expect(feishu.typingStops).toEqual([{ chatId: "chat-1", success: true }]);
    await bridge.stop();
  });

  it("delivers the completed agent message when the server emits no deltas", async () => {
    const { feishu, appServer, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "item/completed", params: {
        threadId,
        turnId,
        item: { id: "message-1", type: "agentMessage", text: "仅最终消息" },
      } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ];

    feishu.receive("chat-1", "message-1", "只返回最终文本");
    await waitFor(() => feishu.typingStops.length === 1);

    expect(allRenderedCardText(feishu)).toContain("仅最终消息");
    expect(allRenderedCardText(feishu)).not.toContain("没有返回文本");
    await bridge.stop();
  });

  it("queues messages and reuses the same thread for multiple turns", async () => {
    const { feishu, appServer, bridge } = await setup();
    feishu.receive("chat-1", "message-1", "第一条");
    feishu.receive("chat-1", "message-2", "第二条");
    await waitFor(() => feishu.typingStops.length === 2);

    expect(appServer.calls.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    expect(appServer.calls.filter(({ method }) => method === "turn/start")).toHaveLength(2);
    expect(feishu.messages.some(({ text }) => text.includes("已排队"))).toBe(true);
    await bridge.stop();
  });

  it("reports scheduled turns as failed and refuses to run them in a different saved thread", async () => {
    const { appServer, sessions, bridge } = await setup();
    const original = await sessions.getOrCreate("chat-1");
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "turn/error", params: { threadId, turnId, error: { message: "scheduled failed" } } },
    ];
    const task = {
      id: "task-1",
      chatId: "chat-1",
      conversationId: "chat-1",
      creatorOpenId: "ou-owner",
      chatType: "p2p" as const,
      prompt: "scheduled prompt",
      threadId: original.threadId,
    };
    await expect(bridge.enqueueScheduledPrompt(task)).rejects.toThrow("执行失败");

    await sessions.create("chat-1");
    await expect(bridge.enqueueScheduledPrompt(task)).rejects.toThrow("已不是当前会话");
    await bridge.stop();
  });

  it("isolates group conversations by sender by default", async () => {
    const { feishu, appServer, sessions, bridge } = await setup();
    feishu.receiveGroup("group-1", "message-1", "用户一", "ou-user-1");
    feishu.receiveGroup("group-1", "message-2", "用户二", "ou-user-2");
    await waitFor(() => feishu.typingStops.length === 2);

    expect(appServer.calls.filter(({ method }) => method === "thread/start")).toHaveLength(2);
    await expect(sessions.get("group-1:user:ou-user-1")).resolves.toMatchObject({ threadId: "thread-1" });
    await expect(sessions.get("group-1:user:ou-user-2")).resolves.toMatchObject({ threadId: "thread-2" });
    expect(feishu.cards.every(({ replyTo }) => replyTo === "message-1" || replyTo === "message-2")).toBe(true);
    await bridge.stop();
  });

  it("can explicitly share one session across group users", async () => {
    const { feishu, appServer, sessions, bridge } = await setup({ groupSessionMode: "shared" });
    feishu.receiveGroup("group-1", "message-1", "用户一", "ou-user-1");
    feishu.receiveGroup("group-1", "message-2", "用户二", "ou-user-2");
    await waitFor(() => feishu.typingStops.length === 2);

    expect(appServer.calls.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    await expect(sessions.get("group-1")).resolves.toMatchObject({ threadId: "thread-1" });
    await bridge.stop();
  });

  it("rejects messages beyond the per-chat queue limit", async () => {
    const { feishu, appServer, bridge } = await setup({ maxQueuedPerChat: 1 });
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];
    feishu.receive("chat-1", "message-1", "执行中");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    feishu.receive("chat-1", "message-2", "进入队列");
    feishu.receive("chat-1", "message-3", "超出限制");
    await waitFor(() => feishu.messages.some(({ text }) => text.includes("达到限制")));

    expect(feishu.messages.some(({ text }) => text.includes("达到限制"))).toBe(true);
    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
    } });
    await waitFor(() => appServer.calls.filter(({ method }) => method === "turn/start").length === 2);
    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-2", status: "completed" },
    } });
    await waitFor(() => feishu.typingStops.length === 2);
    await bridge.stop();
  });

  it("converts images to localImage and files to local-path text", async () => {
    const { feishu, appServer, bridge } = await setup();
    const resources: InboundResource[] = [
      { type: "image", fileKey: "image-key" },
      { type: "file", fileKey: "file-key", fileName: "report.xlsx" },
    ];
    feishu.receive("chat-1", "message-1", "分析附件", resources);
    await waitFor(() => feishu.typingStops.length === 1);

    const call = appServer.calls.find(({ method }) => method === "turn/start");
    const input = (call?.params as { input: unknown[] }).input;
    expect(input).toContainEqual({ type: "localImage", path: "/tmp/feishu-media/image-key" });
    expect(input).toContainEqual({
      type: "text",
      text: "分析附件\n用户上传文件：/tmp/feishu-media/report.xlsx",
      text_elements: [],
    });
    await bridge.stop();
  });

  it("injects a turn-scoped attachment capability and revokes it on completion", async () => {
    const { feishu, appServer, bridge, attachmentDispatcher } = await setup({ attachments: true });
    feishu.receive("chat-1", "message-1", "生成报告");
    await waitFor(() => feishu.typingStops.length === 1);

    const call = appServer.calls.find(({ method }) => method === "turn/start");
    const context = (call?.params as {
      additionalContext?: Record<string, { value: string }>;
    }).additionalContext?.["codex-feishu-attachments"]?.value ?? "";
    expect(context).toContain("codex-feishu send");
    expect(context).toContain("http://127.0.0.1:12345");
    const token = context.match(/--token ([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    await expect(attachmentDispatcher!.send({
      token: token!,
      path: "/workspace/report.pdf",
      kind: "file",
    })).rejects.toThrow("无效或已过期");
    await bridge.stop();
  });

  it("cleans up typing and session state when Codex reports an error", async () => {
    const { feishu, appServer, sessions, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
      { method: "turn/error", params: { threadId, turnId, error: { message: "sandbox failed" } } },
    ];
    feishu.receive("chat-1", "message-1", "失败任务");
    await waitFor(() => feishu.typingStops.length === 1);

    expect(feishu.typingStops[0]).toEqual({ chatId: "chat-1", success: false });
    expect(allRenderedCardText(feishu)).toContain("sandbox failed");
    const failedSession = await sessions.get("chat-1");
    expect(failedSession).toMatchObject({ status: "error" });
    expect(failedSession).not.toHaveProperty("activeTurnId");
    await bridge.stop();
  });

  it("chunks final replies that exceed the Feishu card limit", async () => {
    const { feishu, appServer, bridge } = await setup();
    const longText = "x".repeat(8_000);
    appServer.turnScenario = (threadId, turnId) => [
      { method: "item/agentMessage/delta", params: { threadId, turnId, delta: longText } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ];
    feishu.receive("chat-1", "message-1", "长回复");
    await waitFor(() => feishu.typingStops.length === 1);

    expect(feishu.messages.filter(({ text }) => text.startsWith("x"))).toHaveLength(2);
    expect(feishu.messages.filter(({ text }) => text.startsWith("x")).every(({ text }) => text.length <= 3_500)).toBe(true);
    await bridge.stop();
  });

  it("throttles multiple text deltas into one streaming card", async () => {
    const { feishu, appServer, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];
    feishu.receive("chat-1", "message-1", "流式回复");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    appServer.emit({ method: "item/agentMessage/delta", params: {
      threadId: "thread-1", turnId: "turn-1", delta: "A",
    } });
    appServer.emit({ method: "item/agentMessage/delta", params: {
      threadId: "thread-1", turnId: "turn-1", delta: "B",
    } });
    await waitFor(() => feishu.cards.length === 1);
    expect(feishu.cards).toHaveLength(1);
    expect(allRenderedCardText(feishu)).toContain("AB");

    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
    } });
    await waitFor(() => feishu.typingStops.length === 1);
    await bridge.stop();
  });

  it("routes slash commands without starting a turn", async () => {
    const { feishu, appServer, bridge } = await setup();
    feishu.receive("chat-1", "message-1", "/new");
    await waitFor(() => feishu.messages.length === 1);
    feishu.receive("chat-1", "message-2", "/status");
    await waitFor(() => feishu.messages.length === 2);

    expect(feishu.messages[0]?.text).toBe("已创建新的 Codex 会话。");
    expect(feishu.messages[1]?.text).toContain("Codex App Server：已连接");
    expect(appServer.calls.some(({ method }) => method === "turn/start")).toBe(false);
    await bridge.stop();
  });

  it("keeps the active thread mapped until an interrupted turn completes after /new", async () => {
    const { feishu, appServer, sessions, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];

    feishu.receive("chat-1", "message-1", "长任务");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    feishu.receive("chat-1", "message-2", "/new");
    await waitFor(() => feishu.messages.some(({ text }) => text === "已创建新的 Codex 会话。"));
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ threadId: "thread-2" });

    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "cancelled" },
    } });
    await waitFor(() => feishu.typingStops.length === 1);
    expect(feishu.typingStops).toEqual([{ chatId: "chat-1", success: false }]);
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ threadId: "thread-2", status: "idle" });
    await bridge.stop();
  });

  it("sends approval cards and returns the user's decision to App Server", async () => {
    const { feishu, appServer, sessions, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];
    feishu.receive("chat-1", "message-1", "执行高风险操作");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    appServer.emitRequest({
      id: 900,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        command: "docker compose down",
        risk: "high",
      },
    });
    await waitFor(() => allRenderedCardText(feishu).includes("docker compose down"));
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ status: "waiting_approval" });

    await feishu.click("900", "approve");
    expect(appServer.responses).toContainEqual({ id: 900, result: { decision: "accept" } });
    expect(allRenderedCardText(feishu)).toContain("已批准");
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ status: "running" });

    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
    } });
    await waitFor(() => feishu.typingStops.length === 1);
    await bridge.stop();
  });

  it("only allows the task creator to resolve an approval", async () => {
    const { feishu, appServer, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];
    feishu.receive("chat-1", "message-1", "需要审批", [], "ou-owner");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    appServer.emitRequest({
      id: 901,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "dangerous" },
    });
    await waitFor(() => feishu.cards.length === 1);

    await feishu.click("901", "approve", "ou-other");
    expect(appServer.responses).not.toContainEqual({ id: 901, result: { decision: "accept" } });
    expect(feishu.messages.some(({ text }) => text.includes("只有发起当前任务"))).toBe(true);

    await feishu.click("901", "approve", "ou-owner");
    expect(appServer.responses).toContainEqual({ id: 901, result: { decision: "accept" } });
    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
    } });
    await waitFor(() => feishu.typingStops.length === 1);
    await bridge.stop();
  });

  it("lets the task owner use /stop while an approval is pending", async () => {
    const { feishu, appServer, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];
    feishu.receive("chat-1", "message-1", "需要审批", [], "ou-owner");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    appServer.emitRequest({
      id: 905,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "dangerous" },
    });
    await waitFor(() => feishu.cards.length === 1);

    feishu.receive("chat-1", "message-stop", "/stop", [], "ou-owner");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/interrupt"));
    expect(appServer.responses.some(({ id }) => id === 905)).toBe(true);
    expect(feishu.messages.some(({ text }) => text.includes("已请求中断"))).toBe(true);

    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "cancelled" },
    } });
    await waitFor(() => feishu.typingStops.length === 1);
    await bridge.stop();
  });

  it("collects request_user_input choices and responds with typed answers", async () => {
    const { feishu, appServer, sessions, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];
    feishu.receive("chat-1", "message-1", "部署项目", [], "ou-owner");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    appServer.emitRequest({
      id: 902,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "input-1",
        autoResolutionMs: null,
        questions: [{
          id: "environment",
          header: "环境",
          question: "部署到哪个环境？",
          isOther: false,
          isSecret: false,
          options: [
            { label: "测试环境", description: "内部验证" },
            { label: "生产环境", description: "正式发布" },
          ],
        }],
      },
    });
    await waitFor(() => allRenderedCardText(feishu).includes("部署到哪个环境"));
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ status: "waiting_approval" });

    await feishu.click("902", "answer", "ou-owner", {
      questionId: "environment",
      answer: "测试环境",
    });
    expect(appServer.responses).toContainEqual({
      id: 902,
      result: { answers: { environment: { answers: ["测试环境"] } } },
    });
    expect(allRenderedCardText(feishu)).toContain("已提交");
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ status: "running" });

    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
    } });
    await waitFor(() => feishu.typingStops.length === 1);
    await bridge.stop();
  });

  it("collects free-text interactive answers from the task owner", async () => {
    const { feishu, appServer, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];
    feishu.receive("chat-1", "message-1", "需要说明", [], "ou-owner");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    appServer.emitRequest({
      id: 903,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "input-2",
        autoResolutionMs: null,
        questions: [{
          id: "note",
          header: "说明",
          question: "请输入发布说明",
          isOther: true,
          isSecret: false,
          options: null,
        }],
      },
    });
    await waitFor(() => allRenderedCardText(feishu).includes("请输入发布说明"));

    feishu.receive("chat-1", "message-answer", "修复登录问题", [], "ou-owner");
    await waitFor(() => appServer.responses.some(({ id }) => id === 903));
    expect(appServer.responses).toContainEqual({
      id: 903,
      result: { answers: { note: { answers: ["修复登录问题"] } } },
    });

    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
    } });
    await waitFor(() => feishu.typingStops.length === 1);
    await bridge.stop();
  });

  it("returns the requested permission profile only to the active turn", async () => {
    const { feishu, appServer, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];
    feishu.receive("chat-1", "message-1", "访问网络");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    appServer.emitRequest({
      id: 904,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permission-1",
        cwd: "/workspace",
        reason: "下载依赖",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });
    await waitFor(() => allRenderedCardText(feishu).includes("扩展权限"));
    await feishu.click("904", "approve");
    expect(appServer.responses).toContainEqual({
      id: 904,
      result: { permissions: { network: { enabled: true } }, scope: "turn" },
    });

    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
    } });
    await waitFor(() => feishu.typingStops.length === 1);
    await bridge.stop();
  });

  it("falls back to a text message when the final card cannot be created", async () => {
    const { feishu, bridge } = await setup();
    feishu.cardReturnsNull = true;
    feishu.receive("chat-1", "message-1", "fallback");
    await waitFor(() => feishu.typingStops.length === 1);
    expect(feishu.messages.some(({ text }) => text === "完成")).toBe(true);
    await bridge.stop();
  });

  it("cleans session and Typing even when final card update fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { feishu, appServer, sessions, bridge } = await setup();
    appServer.turnScenario = (threadId, turnId) => [
      { method: "turn/started", params: { threadId, turn: { id: turnId } } },
    ];
    feishu.receive("chat-1", "message-1", "delivery failure");
    await waitFor(() => appServer.calls.some(({ method }) => method === "turn/start"));
    appServer.emit({ method: "item/agentMessage/delta", params: {
      threadId: "thread-1", turnId: "turn-1", delta: "partial",
    } });
    await waitFor(() => feishu.cards.length === 1);
    feishu.failCardUpdates = true;
    appServer.emit({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
    } });
    await waitFor(() => feishu.typingStops.length === 1);
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ status: "idle" });
    expect(feishu.typingStops).toEqual([{ chatId: "chat-1", success: true }]);
    consoleError.mockRestore();
    await bridge.stop();
  });
});

describe("split behavior", () => {
  it("keeps the bridge test timer deterministic", () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});
