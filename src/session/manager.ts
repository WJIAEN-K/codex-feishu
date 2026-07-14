import type { CodexAppServerClient } from "../app-server/client.js";
import type { TurnInput } from "../app-server/protocol.js";
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
  constructor(
    private readonly store: SessionStore,
    private readonly client: RpcClient,
    private readonly options: SessionManagerOptions,
  ) {}

  get(chatId: string): Promise<ChatSession | null> {
    return this.store.get(chatId);
  }

  async getOrCreate(chatId: string): Promise<ChatSession> {
    return (await this.store.get(chatId)) ?? this.create(chatId);
  }

  async create(chatId: string): Promise<ChatSession> {
    const threadId = await startThread(this.client, this.options);
    const now = Date.now();
    const session: ChatSession = {
      chatId,
      threadId,
      cwd: this.options.cwd,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(session);
    return session;
  }

  async resume(chatId: string): Promise<ChatSession> {
    const session = await this.requireSession(chatId);
    await resumeThread(this.client, session.threadId);
    return session;
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
