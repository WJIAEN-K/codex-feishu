import type { ChatSession } from "../types.js";

export interface SessionStore {
  get(chatId: string): Promise<ChatSession | null>;
  getByThreadId(threadId: string): Promise<ChatSession | null>;
  list(): Promise<ChatSession[]>;
  set(session: ChatSession): Promise<void>;
  delete(chatId: string): Promise<void>;
  close?(): Promise<void> | void;
}
