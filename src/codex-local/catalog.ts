import Database from "better-sqlite3";

import type { ThreadSummary } from "../app-server/thread-catalog.js";

export interface LocalCodexProject {
  cwd: string;
  threadCount: number;
  updatedAt: number;
  preview: string;
}

interface ThreadRow {
  id: string;
  cwd: string;
  preview: string | null;
  name: string | null;
  updated_at: number;
  rollout_path: string | null;
}

export interface LocalCodexThread {
  id: string;
  cwd: string;
  rolloutPath: string | null;
}

/** Read-only view over Codex's internal thread index. Never writes or migrates that database. */
export class LocalCodexCatalog {
  constructor(readonly databasePath: string) {}

  async listThreads(cwd?: string, limit = 20): Promise<ThreadSummary[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("本地会话查询数量必须是正整数");
    return this.queryThreads(cwd, Math.min(limit, 200)).map(toThreadSummary);
  }

  async listProjects(limit = 50): Promise<LocalCodexProject[]> {
    const projects = new Map<string, LocalCodexProject>();
    for (const thread of this.queryThreads(undefined, 10_000)) {
      const current = projects.get(thread.cwd);
      if (current) {
        current.threadCount += 1;
      } else {
        projects.set(thread.cwd, {
          cwd: thread.cwd,
          threadCount: 1,
          updatedAt: timestampMsToSeconds(thread.updated_at),
          preview: thread.preview ?? thread.name ?? "",
        });
      }
    }
    return [...projects.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  async getThread(threadId: string): Promise<LocalCodexThread | null> {
    const row = this.queryThread(threadId);
    return row ? { id: row.id, cwd: row.cwd, rolloutPath: row.rollout_path } : null;
  }

  private queryThreads(cwd: string | undefined, limit: number): ThreadRow[] {
    let database: Database.Database | undefined;
    try {
      database = new Database(this.databasePath, { readonly: true, fileMustExist: true });
      database.pragma("query_only = ON");
      const columns = new Set(
        (database.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>)
          .map(({ name }) => name),
      );
      if (!columns.has("id") || !columns.has("cwd")) {
        throw new Error("threads 表缺少 id 或 cwd 字段");
      }
      const preview = firstColumn(columns, ["preview", "first_user_message", "title"], "''");
      const name = firstColumn(columns, ["title"], "NULL");
      const updated = timestampExpression(columns);
      const conditions = ["cwd <> ''"];
      if (columns.has("archived")) conditions.push("archived = 0");
      if (cwd) conditions.push("cwd = @cwd");
      const rolloutPath = columns.has("rollout_path") ? "rollout_path" : "NULL";
      const sql = `
        SELECT id, cwd, substr(${preview}, 1, 2000) AS preview,
               substr(${name}, 1, 500) AS name, ${updated} AS updated_at,
               ${rolloutPath} AS rollout_path
        FROM threads
        WHERE ${conditions.join(" AND ")}
        ORDER BY ${updated} DESC, id DESC
        LIMIT @limit
      `;
      return database.prepare(sql).all({ cwd: cwd ?? "", limit }) as ThreadRow[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`无法只读 Codex 会话数据库 ${this.databasePath}：${message}`);
    } finally {
      database?.close();
    }
  }


  private queryThread(threadId: string): ThreadRow | null {
    let database: Database.Database | undefined;
    try {
      database = new Database(this.databasePath, { readonly: true, fileMustExist: true });
      database.pragma("query_only = ON");
      const columns = new Set(
        (database.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map(({ name }) => name),
      );
      if (!columns.has("id") || !columns.has("cwd")) throw new Error("threads 表缺少 id 或 cwd 字段");
      const rolloutPath = columns.has("rollout_path") ? "rollout_path" : "NULL";
      const row = database.prepare(`
        SELECT id, cwd, '' AS preview, NULL AS name, 0 AS updated_at, ${rolloutPath} AS rollout_path
        FROM threads WHERE id = ? LIMIT 1
      `).get(threadId) as ThreadRow | undefined;
      return row ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`无法只读 Codex 会话数据库 ${this.databasePath}：${message}`);
    } finally {
      database?.close();
    }
  }
}

function firstColumn(columns: Set<string>, candidates: string[], fallback: string): string {
  const available = candidates.filter((column) => columns.has(column));
  if (available.length === 0) return fallback;
  return `COALESCE(${available.map((column) => `NULLIF(${column}, '')`).join(", ")}, '')`;
}

function timestampExpression(columns: Set<string>): string {
  const candidates = [
    columns.has("recency_at_ms") ? "NULLIF(recency_at_ms, 0)" : undefined,
    columns.has("updated_at_ms") ? "NULLIF(updated_at_ms, 0)" : undefined,
    columns.has("updated_at") ? "NULLIF(updated_at, 0) * 1000" : undefined,
    columns.has("created_at_ms") ? "NULLIF(created_at_ms, 0)" : undefined,
    columns.has("created_at") ? "NULLIF(created_at, 0) * 1000" : undefined,
  ].filter((value): value is string => Boolean(value));
  return candidates.length > 0 ? `COALESCE(${candidates.join(", ")}, 0)` : "0";
}

function timestampMsToSeconds(value: number): number {
  return Math.floor(value / 1_000);
}

function toThreadSummary(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    cwd: row.cwd,
    preview: row.preview ?? "",
    name: row.name || null,
    updatedAt: timestampMsToSeconds(row.updated_at),
    status: { type: "notLoaded" },
  };
}
