import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { ScheduledTask, SchedulerStore } from "./store.js";

type TaskRow = {
  id: string; chat_id: string; conversation_id: string; creator_open_id: string;
  thread_id: string | null;
  chat_type: "p2p" | "group"; kind: "once" | "cron"; schedule: string; prompt: string;
  next_run_at: number; status: ScheduledTask["status"]; retry_count: number;
  last_run_at: number | null; last_error: string | null; created_at: number; updated_at: number;
};

export class SqliteSchedulerStore implements SchedulerStore {
  private readonly database: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        creator_open_id TEXT NOT NULL, thread_id TEXT, chat_type TEXT NOT NULL CHECK(chat_type IN ('p2p','group')),
        kind TEXT NOT NULL CHECK(kind IN ('once','cron')), schedule TEXT NOT NULL, prompt TEXT NOT NULL,
        next_run_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused','running','failed')),
        retry_count INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks(status, next_run_at);
      CREATE INDEX IF NOT EXISTS scheduled_tasks_conversation ON scheduled_tasks(conversation_id, created_at DESC);
    `);
    const columns = this.database.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE scheduled_tasks ADD COLUMN thread_id TEXT");
    }
  }

  async add(task: ScheduledTask): Promise<void> { this.write(task); }
  async get(id: string): Promise<ScheduledTask | null> {
    const row = this.database.prepare<[string], TaskRow>("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
    return row ? fromRow(row) : null;
  }
  async list(conversationId?: string): Promise<ScheduledTask[]> {
    const rows = conversationId
      ? this.database.prepare<[string], TaskRow>("SELECT * FROM scheduled_tasks WHERE conversation_id = ? ORDER BY created_at DESC").all(conversationId)
      : this.database.prepare<[], TaskRow>("SELECT * FROM scheduled_tasks ORDER BY created_at DESC").all();
    return rows.map(fromRow);
  }
  async due(now: number, limit = 20): Promise<ScheduledTask[]> {
    return this.database.prepare<[number, number], TaskRow>(
      "SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT ?",
    ).all(now, limit).map(fromRow);
  }
  async claim(id: string, now: number): Promise<boolean> {
    return this.database.prepare(
      "UPDATE scheduled_tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'active' AND next_run_at <= ?",
    ).run(now, id, now).changes === 1;
  }
  async update(task: ScheduledTask): Promise<void> { this.write(task); }
  async remove(id: string): Promise<void> { this.database.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id); }
  async recoverRunning(now: number): Promise<void> {
    this.database.prepare("UPDATE scheduled_tasks SET status = 'active', next_run_at = MIN(next_run_at, ?), updated_at = ? WHERE status = 'running'").run(now, now);
  }
  close(): void { this.database.close(); }

  private write(task: ScheduledTask): void {
    this.database.prepare(`
      INSERT INTO scheduled_tasks (
        id,chat_id,conversation_id,creator_open_id,thread_id,chat_type,kind,schedule,prompt,
        next_run_at,status,retry_count,last_run_at,last_error,created_at,updated_at
      ) VALUES (
        @id,@chatId,@conversationId,@creatorOpenId,@threadId,@chatType,@kind,@schedule,@prompt,
        @nextRunAt,@status,@retryCount,@lastRunAt,@lastError,@createdAt,@updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        chat_id=@chatId, conversation_id=@conversationId, creator_open_id=@creatorOpenId,
        thread_id=@threadId, chat_type=@chatType, kind=@kind, schedule=@schedule, prompt=@prompt,
        next_run_at=@nextRunAt, status=@status, retry_count=@retryCount,
        last_run_at=@lastRunAt, last_error=@lastError, updated_at=@updatedAt
    `).run({ ...task, threadId: task.threadId ?? null, lastRunAt: task.lastRunAt ?? null, lastError: task.lastError ?? null });
  }
}

function fromRow(row: TaskRow): ScheduledTask {
  return {
    id: row.id, chatId: row.chat_id, conversationId: row.conversation_id,
    creatorOpenId: row.creator_open_id, ...(row.thread_id ? { threadId: row.thread_id } : {}),
    chatType: row.chat_type, kind: row.kind,
    schedule: row.schedule, prompt: row.prompt, nextRunAt: row.next_run_at,
    status: row.status, retryCount: row.retry_count,
    ...(row.last_run_at === null ? {} : { lastRunAt: row.last_run_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
