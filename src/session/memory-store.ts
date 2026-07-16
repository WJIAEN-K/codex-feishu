import type { ChatSession } from "../types.js";
import type { SessionStore } from "./store.js";

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly activeSessions = new Map<string, string>();

  async get(chatId: string): Promise<ChatSession | null> {
    const id = this.activeSessions.get(chatId);
    const session = id ? this.sessions.get(id) : undefined;
    return session ? { ...session } : null;
  }

  async getByThreadId(threadId: string): Promise<ChatSession | null> {
    const session = [...this.sessions.values()].find((candidate) => candidate.threadId === threadId);
    return session ? { ...session } : null;
  }

  async list(chatId?: string): Promise<ChatSession[]> {
    return [...this.sessions.values()]
      .filter((session) => !chatId || session.chatId === chatId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({ ...session }));
  }

  async set(session: ChatSession, activate = true): Promise<void> {
    const normalized = normalizeSession(session);
    this.sessions.set(normalized.id!, normalized);
    if (activate) this.activeSessions.set(normalized.chatId, normalized.id!);
  }

  async setActive(chatId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.chatId !== chatId) throw new Error("会话不存在或不属于当前对话");
    this.activeSessions.set(chatId, sessionId);
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("会话不存在");
    if ([...this.sessions.values()].some((candidate) => (
      candidate.id !== sessionId && candidate.chatId === session.chatId && candidate.name === name
    ))) throw new Error("当前对话已存在同名会话");
    session.name = name;
  }

  async delete(chatId: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.chatId === chatId) this.sessions.delete(id);
    }
    this.activeSessions.delete(chatId);
  }
}

function normalizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    id: session.id ?? session.threadId,
    name: session.name ?? `会话 ${session.threadId.slice(0, 8)}`,
  };
}
