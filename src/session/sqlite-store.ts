import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type {
  ChatSession,
  SessionBindingMode,
  SessionRuntimePreferences,
  SessionStatus,
} from "../types.js";
import type { SessionStore } from "./store.js";

interface SessionRow {
  session_id: string;
  conversation_id: string;
  name: string;
  thread_id: string;
  cwd: string;
  binding_mode: SessionBindingMode;
  status: SessionStatus;
  active_turn_id: string | null;
  preferences_json: string;
  created_at: number;
  updated_at: number;
}

export class SqliteSessionStore implements SessionStore {
  private readonly database: Database.Database;
  private readonly selectSession: Database.Statement<[string], SessionRow>;
  private readonly selectSessionByThread: Database.Statement<[string], SessionRow>;
  private readonly selectSessions: Database.Statement<[], SessionRow>;
  private readonly selectConversationSessions: Database.Statement<[string], SessionRow>;
  private readonly upsertSession: Database.Statement;
  private readonly activateSession: Database.Statement;
  private readonly renameSession: Database.Statement;
  private readonly deleteConversation: Database.Statement<[string]>;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    this.ensureLegacySchema();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        cwd TEXT NOT NULL,
        binding_mode TEXT NOT NULL DEFAULT 'owned' CHECK (binding_mode IN ('owned', 'attached')),
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'waiting_approval', 'error')),
        active_turn_id TEXT,
        preferences_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(conversation_id, name)
      );
      CREATE INDEX IF NOT EXISTS sessions_conversation_updated
        ON sessions(conversation_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS active_sessions (
        conversation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE
      );
    `);
    const sessionColumns = this.database.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "preferences_json")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN preferences_json TEXT NOT NULL DEFAULT '{}'");
    }
    this.migrateLegacySessions();
    this.selectSession = this.database.prepare<[string], SessionRow>(`
      SELECT s.* FROM active_sessions a
      JOIN sessions s ON s.session_id = a.session_id
      WHERE a.conversation_id = ?
    `);
    this.selectSessionByThread = this.database.prepare<[string], SessionRow>(
      "SELECT * FROM sessions WHERE thread_id = ? LIMIT 1",
    );
    this.selectSessions = this.database.prepare<[], SessionRow>(
      "SELECT * FROM sessions ORDER BY updated_at DESC",
    );
    this.selectConversationSessions = this.database.prepare<[string], SessionRow>(
      "SELECT * FROM sessions WHERE conversation_id = ? ORDER BY updated_at DESC",
    );
    this.upsertSession = this.database.prepare(`
      INSERT INTO sessions (
        session_id, conversation_id, name, thread_id, cwd, binding_mode,
        status, active_turn_id, preferences_json, created_at, updated_at
      ) VALUES (
        @id, @chatId, @name, @threadId, @cwd, @bindingMode,
        @status, @activeTurnId, @preferencesJson, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        name = excluded.name,
        thread_id = excluded.thread_id,
        cwd = excluded.cwd,
        binding_mode = excluded.binding_mode,
        status = excluded.status,
        active_turn_id = excluded.active_turn_id,
        preferences_json = excluded.preferences_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);
    this.activateSession = this.database.prepare(`
      INSERT INTO active_sessions (conversation_id, session_id) VALUES (?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET session_id = excluded.session_id
    `);
    this.renameSession = this.database.prepare(
      "UPDATE sessions SET name = ?, updated_at = ? WHERE session_id = ?",
    );
    this.deleteConversation = this.database.prepare<[string]>(
      "DELETE FROM sessions WHERE conversation_id = ?",
    );
  }

  async get(chatId: string): Promise<ChatSession | null> {
    const row = this.selectSession.get(chatId);
    return row ? fromRow(row) : null;
  }

  async getByThreadId(threadId: string): Promise<ChatSession | null> {
    const row = this.selectSessionByThread.get(threadId);
    return row ? fromRow(row) : null;
  }

  async list(chatId?: string): Promise<ChatSession[]> {
    const rows = chatId
      ? this.selectConversationSessions.all(chatId)
      : this.selectSessions.all();
    return rows.map(fromRow);
  }

  async set(session: ChatSession, activate = true): Promise<void> {
    const normalized = normalizeSession(session);
    const transaction = this.database.transaction(() => {
      this.upsertSession.run(toParams(normalized));
      if (activate) this.activateSession.run(normalized.chatId, normalized.id!);
    });
    transaction();
  }

  async setActive(chatId: string, sessionId: string): Promise<void> {
    const session = this.database.prepare<[string, string], { session_id: string }>(
      "SELECT session_id FROM sessions WHERE session_id = ? AND conversation_id = ?",
    ).get(sessionId, chatId);
    if (!session) throw new Error("会话不存在或不属于当前对话");
    this.activateSession.run(chatId, sessionId);
  }

  async rename(sessionId: string, name: string): Promise<void> {
    try {
      const result = this.renameSession.run(name, Date.now(), sessionId);
      if (result.changes === 0) throw new Error("会话不存在");
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
        throw new Error("当前对话已存在同名会话");
      }
      throw error;
    }
  }

  async delete(chatId: string): Promise<void> {
    this.deleteConversation.run(chatId);
  }

  close(): void {
    this.database.close();
  }

  private ensureLegacySchema(): void {
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
  }

  private migrateLegacySessions(): void {
    this.database.exec(`
      INSERT OR IGNORE INTO sessions (
        session_id, conversation_id, name, thread_id, cwd, binding_mode,
        status, active_turn_id, created_at, updated_at
      )
      SELECT
        thread_id, chat_id, '会话 ' || substr(thread_id, 1, 8), thread_id, cwd,
        binding_mode, status, active_turn_id, created_at, updated_at
      FROM chat_sessions;

      INSERT OR IGNORE INTO active_sessions (conversation_id, session_id)
      SELECT chat_id, thread_id FROM chat_sessions;
    `);
  }
}

function normalizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    id: session.id ?? session.threadId,
    name: normalizedName(session.name ?? `会话 ${session.threadId.slice(0, 8)}`),
  };
}

function normalizedName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("会话名称不能为空");
  if (normalized.length > 80) throw new Error("会话名称不能超过 80 个字符");
  return normalized;
}

function toParams(session: ChatSession): Record<string, unknown> {
  return {
    id: session.id,
    name: session.name,
    chatId: session.chatId,
    threadId: session.threadId,
    cwd: session.cwd,
    bindingMode: session.bindingMode,
    status: session.status,
    activeTurnId: session.activeTurnId ?? null,
    preferencesJson: JSON.stringify(session.runtime ?? {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function fromRow(row: SessionRow): ChatSession {
  return {
    id: row.session_id,
    name: row.name,
    chatId: row.conversation_id,
    threadId: row.thread_id,
    cwd: row.cwd,
    bindingMode: row.binding_mode,
    status: row.status,
    ...(row.active_turn_id ? { activeTurnId: row.active_turn_id } : {}),
    ...(parsePreferences(row.preferences_json) ? { runtime: parsePreferences(row.preferences_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePreferences(value: string): SessionRuntimePreferences | undefined {
  try {
    const parsed = JSON.parse(value) as SessionRuntimePreferences;
    return parsed && typeof parsed === "object" && Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
