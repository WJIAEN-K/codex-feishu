import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { ChatSession, SessionStatus } from "../types.js";
import type { SessionStore } from "./store.js";

interface SessionRow {
  chat_id: string;
  thread_id: string;
  cwd: string;
  status: SessionStatus;
  active_turn_id: string | null;
  created_at: number;
  updated_at: number;
}

export class SqliteSessionStore implements SessionStore {
  private readonly database: Database.Database;
  private readonly selectSession: Database.Statement<[string], SessionRow>;
  private readonly upsertSession: Database.Statement;
  private readonly deleteSession: Database.Statement<[string]>;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        chat_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'waiting_approval', 'error')),
        active_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.selectSession = this.database.prepare<[string], SessionRow>(
      "SELECT * FROM chat_sessions WHERE chat_id = ?",
    );
    this.upsertSession = this.database.prepare(`
      INSERT INTO chat_sessions (
        chat_id, thread_id, cwd, status, active_turn_id, created_at, updated_at
      ) VALUES (
        @chatId, @threadId, @cwd, @status, @activeTurnId, @createdAt, @updatedAt
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        cwd = excluded.cwd,
        status = excluded.status,
        active_turn_id = excluded.active_turn_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);
    this.deleteSession = this.database.prepare<[string]>("DELETE FROM chat_sessions WHERE chat_id = ?");
  }

  async get(chatId: string): Promise<ChatSession | null> {
    const row = this.selectSession.get(chatId);
    if (!row) return null;
    return {
      chatId: row.chat_id,
      threadId: row.thread_id,
      cwd: row.cwd,
      status: row.status,
      ...(row.active_turn_id ? { activeTurnId: row.active_turn_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async set(session: ChatSession): Promise<void> {
    this.upsertSession.run({
      chatId: session.chatId,
      threadId: session.threadId,
      cwd: session.cwd,
      status: session.status,
      activeTurnId: session.activeTurnId ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  }

  async delete(chatId: string): Promise<void> {
    this.deleteSession.run(chatId);
  }

  close(): void {
    this.database.close();
  }
}
