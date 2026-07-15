import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { ChatSession, SessionBindingMode, SessionStatus } from "../types.js";
import type { SessionStore } from "./store.js";

interface SessionRow {
  chat_id: string;
  thread_id: string;
  cwd: string;
  binding_mode: SessionBindingMode;
  status: SessionStatus;
  active_turn_id: string | null;
  created_at: number;
  updated_at: number;
}

export class SqliteSessionStore implements SessionStore {
  private readonly database: Database.Database;
  private readonly selectSession: Database.Statement<[string], SessionRow>;
  private readonly selectSessionByThread: Database.Statement<[string], SessionRow>;
  private readonly selectSessions: Database.Statement<[], SessionRow>;
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
        binding_mode TEXT NOT NULL DEFAULT 'owned' CHECK (binding_mode IN ('owned', 'attached')),
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'waiting_approval', 'error')),
        active_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const columns = this.database.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "binding_mode")) {
      this.database.exec(
        "ALTER TABLE chat_sessions ADD COLUMN binding_mode TEXT NOT NULL DEFAULT 'owned' " +
        "CHECK (binding_mode IN ('owned', 'attached'))",
      );
    }
    this.selectSession = this.database.prepare<[string], SessionRow>(
      "SELECT * FROM chat_sessions WHERE chat_id = ?",
    );
    this.selectSessionByThread = this.database.prepare<[string], SessionRow>(
      "SELECT * FROM chat_sessions WHERE thread_id = ? LIMIT 1",
    );
    this.selectSessions = this.database.prepare<[], SessionRow>(
      "SELECT * FROM chat_sessions ORDER BY updated_at DESC",
    );
    this.upsertSession = this.database.prepare(`
      INSERT INTO chat_sessions (
        chat_id, thread_id, cwd, binding_mode, status, active_turn_id, created_at, updated_at
      ) VALUES (
        @chatId, @threadId, @cwd, @bindingMode, @status, @activeTurnId, @createdAt, @updatedAt
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        cwd = excluded.cwd,
        binding_mode = excluded.binding_mode,
        status = excluded.status,
        active_turn_id = excluded.active_turn_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);
    this.deleteSession = this.database.prepare<[string]>("DELETE FROM chat_sessions WHERE chat_id = ?");
  }

  async get(chatId: string): Promise<ChatSession | null> {
    const row = this.selectSession.get(chatId);
    return row ? fromRow(row) : null;
  }

  async getByThreadId(threadId: string): Promise<ChatSession | null> {
    const row = this.selectSessionByThread.get(threadId);
    return row ? fromRow(row) : null;
  }

  async list(): Promise<ChatSession[]> {
    return this.selectSessions.all().map(fromRow);
  }

  async set(session: ChatSession): Promise<void> {
    this.upsertSession.run({
      chatId: session.chatId,
      threadId: session.threadId,
      cwd: session.cwd,
      bindingMode: session.bindingMode,
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

function fromRow(row: SessionRow): ChatSession {
  return {
    chatId: row.chat_id,
    threadId: row.thread_id,
    cwd: row.cwd,
    bindingMode: row.binding_mode,
    status: row.status,
    ...(row.active_turn_id ? { activeTurnId: row.active_turn_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
