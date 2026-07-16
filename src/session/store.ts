import type { ChatSession } from "../types.js";

export interface SessionStore {
  get(chatId: string): Promise<ChatSession | null>;
  getByThreadId(threadId: string): Promise<ChatSession | null>;
  list(chatId?: string): Promise<ChatSession[]>;
  set(session: ChatSession, activate?: boolean): Promise<void>;
  setActive(chatId: string, sessionId: string): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  delete(chatId: string): Promise<void>;
  close?(): Promise<void> | void;
}
