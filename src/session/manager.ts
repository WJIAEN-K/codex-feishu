import type { CodexAppServerClient } from "../app-server/client.js";
import type { TurnInput } from "../app-server/protocol.js";
import { ThreadCatalog, type ThreadSummary } from "../app-server/thread-catalog.js";
import { startThread, resumeThread } from "../app-server/thread.js";
import { interruptTurn, startTurn } from "../app-server/turn.js";
import type { ChatSession, SessionStatus } from "../types.js";
import type { SessionStore } from "./store.js";

export interface SessionManagerOptions {
  cwd: string;
  model?: string;
  reasoningEffort?: string;
}

type RpcClient = Pick<CodexAppServerClient, "request">;

export class SessionManager {
  private readonly attachedThreads = new Set<string>();
  private readonly bindingThreads = new Set<string>();
  private readonly threads: ThreadCatalog;

  constructor(
    private readonly store: SessionStore,
    private readonly client: RpcClient,
    private readonly options: SessionManagerOptions,
  ) {
    this.threads = new ThreadCatalog(client);
  }

  get(chatId: string): Promise<ChatSession | null> {
    return this.store.get(chatId);
  }

  async getOrCreate(chatId: string): Promise<ChatSession> {
    const existing = await this.store.get(chatId);
    if (!existing) return this.create(chatId);
    if (!this.attachedThreads.has(existing.threadId)) {
      await resumeThread(this.client, existing.threadId, { cwd: existing.cwd });
      this.attachedThreads.add(existing.threadId);
      if (existing.status === "running" || existing.status === "waiting_approval") {
        existing.status = "idle";
        delete existing.activeTurnId;
        existing.updatedAt = Date.now();
        await this.store.set(existing);
      }
    }
    return existing;
  }

  async create(chatId: string, cwd = this.options.cwd): Promise<ChatSession> {
    const threadId = await startThread(this.client, { ...this.options, cwd });
    const now = Date.now();
    const session: ChatSession = {
      chatId,
      threadId,
      cwd,
      bindingMode: "owned",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(session);
    this.attachedThreads.add(threadId);
    return session;
  }

  async switchWorkspace(chatId: string, cwd: string): Promise<ChatSession> {
    const current = await this.store.get(chatId);
    if (current?.status === "running" || current?.status === "waiting_approval") {
      throw new Error("当前会话有正在执行或等待审批的任务，不能切换项目");
    }
    return this.create(chatId, cwd);
  }

  async resume(chatId: string): Promise<ChatSession> {
    const session = await this.requireSession(chatId);
    await resumeThread(this.client, session.threadId, { cwd: session.cwd });
    this.attachedThreads.add(session.threadId);
    return session;
  }

  listThreads(cwd?: string): Promise<ThreadSummary[]> {
    return this.threads.list(cwd);
  }

  async readThread(threadId: string): Promise<ThreadSummary> {
    return this.threads.read(threadId);
  }

  async bind(chatId: string, thread: ThreadSummary): Promise<ChatSession> {
    const current = await this.store.get(chatId);
    if (current?.status === "running" || current?.status === "waiting_approval") {
      throw new Error("当前会话有正在执行或等待审批的任务，不能切换");
    }
    if (thread.status.type === "active") throw new Error("该 Codex 会话当前正在其他客户端执行任务");
    if (this.bindingThreads.has(thread.id)) throw new Error("该 Codex 会话正在被另一个飞书聊天绑定");
    this.bindingThreads.add(thread.id);
    try {
      const bound = await this.store.getByThreadId(thread.id);
      if (bound && bound.chatId !== chatId) throw new Error("该 Codex 会话已绑定到另一个飞书聊天");

      await resumeThread(this.client, thread.id, { cwd: thread.cwd });
      const now = Date.now();
      const session: ChatSession = {
        chatId,
        threadId: thread.id,
        cwd: thread.cwd,
        bindingMode: "attached",
        status: "idle",
        createdAt: now,
        updatedAt: now,
      };
      await this.store.set(session);
      this.attachedThreads.add(thread.id);
      return session;
    } finally {
      this.bindingThreads.delete(thread.id);
    }
  }

  async beginTurn(chatId: string, input: TurnInput[]): Promise<ChatSession> {
    const session = await this.getOrCreate(chatId);
    if (session.status === "running" || session.status === "waiting_approval") {
      throw new Error("This Feishu chat already has an active Codex turn");
    }

    session.status = "running";
    session.updatedAt = Date.now();
    await this.store.set(session);
    try {
      const turnId = await startTurn(this.client, {
        threadId: session.threadId,
        input,
        cwd: session.cwd,
        model: this.options.model,
        reasoningEffort: this.options.reasoningEffort,
      });
      const latest = await this.store.get(chatId);
      if (!latest || latest.threadId !== session.threadId || latest.status !== "running") {
        return latest ?? session;
      }
      latest.activeTurnId = turnId;
      latest.updatedAt = Date.now();
      await this.store.set(latest);
      return latest;
    } catch (error) {
      session.status = "error";
      session.updatedAt = Date.now();
      await this.store.set(session);
      throw error;
    }
  }

  async interrupt(chatId: string): Promise<boolean> {
    const session = await this.store.get(chatId);
    if (!session?.activeTurnId || session.status !== "running") return false;
    await interruptTurn(this.client, session.threadId, session.activeTurnId);
    return true;
  }

  async updateStatus(
    chatId: string,
    status: SessionStatus,
    activeTurnId?: string,
    expectedThreadId?: string,
  ): Promise<ChatSession | null> {
    const session = await this.store.get(chatId);
    if (!session) return null;
    if (expectedThreadId && session.threadId !== expectedThreadId) return session;
    session.status = status;
    if (activeTurnId === undefined) delete session.activeTurnId;
    else session.activeTurnId = activeTurnId;
    session.updatedAt = Date.now();
    await this.store.set(session);
    return session;
  }

  private async requireSession(chatId: string): Promise<ChatSession> {
    const session = await this.store.get(chatId);
    if (!session) throw new Error(`No Codex session for Feishu chat ${chatId}`);
    return session;
  }
}
