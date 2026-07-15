import type { ChatSession } from "../types.js";
import type { SessionStore } from "./store.js";

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ChatSession>();

  async get(chatId: string): Promise<ChatSession | null> {
    const session = this.sessions.get(chatId);
    return session ? { ...session } : null;
  }

  async getByThreadId(threadId: string): Promise<ChatSession | null> {
    const session = [...this.sessions.values()].find((candidate) => candidate.threadId === threadId);
    return session ? { ...session } : null;
  }

  async list(): Promise<ChatSession[]> {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  async set(session: ChatSession): Promise<void> {
    this.sessions.set(session.chatId, { ...session });
  }

  async delete(chatId: string): Promise<void> {
    this.sessions.delete(chatId);
  }
}
