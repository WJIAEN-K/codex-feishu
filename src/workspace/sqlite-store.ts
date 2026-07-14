import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { Workspace, WorkspaceStore } from "./store.js";

interface WorkspaceRow {
  alias: string;
  path: string;
  enabled: number;
  created_by: string;
  created_at: number;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: Database.Database;
  private readonly selectWorkspace: Database.Statement<[string], WorkspaceRow>;
  private readonly listWorkspaces: Database.Statement<[], WorkspaceRow>;
  private readonly upsertWorkspace: Database.Statement;
  private readonly deleteWorkspace: Database.Statement<[string]>;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        alias TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.selectWorkspace = this.database.prepare<[string], WorkspaceRow>(
      "SELECT * FROM workspaces WHERE alias = ?",
    );
    this.listWorkspaces = this.database.prepare<[], WorkspaceRow>(
      "SELECT * FROM workspaces WHERE enabled = 1 ORDER BY alias",
    );
    this.upsertWorkspace = this.database.prepare(`
      INSERT INTO workspaces (alias, path, enabled, created_by, created_at)
      VALUES (@alias, @path, @enabled, @createdBy, @createdAt)
      ON CONFLICT(alias) DO UPDATE SET
        path = excluded.path,
        enabled = excluded.enabled,
        created_by = excluded.created_by,
        created_at = excluded.created_at
    `);
    this.deleteWorkspace = this.database.prepare<[string]>("DELETE FROM workspaces WHERE alias = ?");
  }

  async get(alias: string): Promise<Workspace | null> {
    const row = this.selectWorkspace.get(alias);
    return row ? fromRow(row) : null;
  }

  async list(): Promise<Workspace[]> {
    return this.listWorkspaces.all().map(fromRow);
  }

  async set(workspace: Workspace): Promise<void> {
    this.upsertWorkspace.run({
      ...workspace,
      enabled: workspace.enabled ? 1 : 0,
    });
  }

  async delete(alias: string): Promise<void> {
    this.deleteWorkspace.run(alias);
  }

  close(): void {
    this.database.close();
  }
}

function fromRow(row: WorkspaceRow): Workspace {
  return {
    alias: row.alias,
    path: row.path,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
