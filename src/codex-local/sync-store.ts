import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export interface LocalSyncBinding {
  threadId: string;
  conversationId: string;
  deliveryChatId: string;
  ownerOpenId: string;
  rolloutPath: string;
  byteOffset: number;
  enabled: boolean;
  updatedAt: number;
}

interface BindingRow {
  thread_id: string;
  conversation_id: string;
  delivery_chat_id: string;
  owner_open_id: string;
  rollout_path: string;
  byte_offset: number;
  enabled: number;
  updated_at: number;
}

export class LocalSyncStore {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_sync_bindings (
        thread_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        delivery_chat_id TEXT NOT NULL,
        owner_open_id TEXT NOT NULL,
        rollout_path TEXT NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_sync_conversation
        ON local_sync_bindings(conversation_id, enabled);
    `);
  }

  get(threadId: string): LocalSyncBinding | null {
    const row = this.database.prepare("SELECT * FROM local_sync_bindings WHERE thread_id = ?").get(threadId) as BindingRow | undefined;
    return row ? fromRow(row) : null;
  }

  getByConversation(conversationId: string): LocalSyncBinding | null {
    const row = this.database.prepare(`
      SELECT * FROM local_sync_bindings WHERE conversation_id = ? AND enabled = 1
      ORDER BY updated_at DESC LIMIT 1
    `).get(conversationId) as BindingRow | undefined;
    return row ? fromRow(row) : null;
  }

  listEnabled(): LocalSyncBinding[] {
    return (this.database.prepare("SELECT * FROM local_sync_bindings WHERE enabled = 1").all() as BindingRow[]).map(fromRow);
  }

  enable(binding: Omit<LocalSyncBinding, "enabled" | "updatedAt">): void {
    this.database.prepare(`
      INSERT INTO local_sync_bindings (
        thread_id, conversation_id, delivery_chat_id, owner_open_id,
        rollout_path, byte_offset, enabled, updated_at
      ) VALUES (@threadId, @conversationId, @deliveryChatId, @ownerOpenId,
        @rolloutPath, @byteOffset, 1, @updatedAt)
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        delivery_chat_id = excluded.delivery_chat_id,
        owner_open_id = excluded.owner_open_id,
        rollout_path = excluded.rollout_path,
        byte_offset = excluded.byte_offset,
        enabled = 1,
        updated_at = excluded.updated_at
    `).run({ ...binding, updatedAt: Date.now() });
  }

  disableConversation(conversationId: string): void {
    this.database.prepare(
      "UPDATE local_sync_bindings SET enabled = 0, updated_at = ? WHERE conversation_id = ?",
    ).run(Date.now(), conversationId);
  }

  updateCursor(threadId: string, rolloutPath: string, byteOffset: number): void {
    this.database.prepare(`
      UPDATE local_sync_bindings SET rollout_path = ?, byte_offset = ?, updated_at = ? WHERE thread_id = ?
    `).run(rolloutPath, byteOffset, Date.now(), threadId);
  }

  close(): void {
    this.database.close();
  }
}

function fromRow(row: BindingRow): LocalSyncBinding {
  return {
    threadId: row.thread_id,
    conversationId: row.conversation_id,
    deliveryChatId: row.delivery_chat_id,
    ownerOpenId: row.owner_open_id,
    rolloutPath: row.rollout_path,
    byteOffset: row.byte_offset,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}
