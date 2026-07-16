import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCodexCatalog } from "../src/codex-local/catalog.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("LocalCodexCatalog", () => {
  it("reads projects and unarchived threads without modifying the Codex database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-local-catalog-"));
    directories.push(directory);
    const path = join(directory, "state_5.sqlite");
    const database = new Database(path);
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL,
        preview TEXT NOT NULL, updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER, recency_at_ms INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO threads VALUES
        ('thread-new', '/projects/backend', '后端会话', '修复接口', 100, 100000, 300000, 0),
        ('thread-old', '/projects/backend', '', '旧会话', 200, 200000, 200000, 0),
        ('thread-web', '/projects/web', '前端', '页面开发', 150, 150000, 150000, 0),
        ('thread-archived', '/projects/web', '归档', '不显示', 999, 999000, 999000, 1);
    `);
    database.close();
    const before = await import("node:fs/promises").then(({ stat }) => stat(path));
    const catalog = new LocalCodexCatalog(path);

    await expect(catalog.listThreads("/projects/backend")).resolves.toEqual([
      expect.objectContaining({ id: "thread-new", name: "后端会话", updatedAt: 300 }),
      expect.objectContaining({ id: "thread-old", preview: "旧会话", updatedAt: 200 }),
    ]);
    await expect(catalog.listProjects()).resolves.toEqual([
      expect.objectContaining({ cwd: "/projects/backend", threadCount: 2, updatedAt: 300 }),
      expect.objectContaining({ cwd: "/projects/web", threadCount: 1, updatedAt: 150 }),
    ]);
    const after = await import("node:fs/promises").then(({ stat }) => stat(path));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("supports an older minimal threads schema and reports a missing database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-local-legacy-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const database = new Database(path);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    database.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("legacy", "/legacy", 123);
    database.close();

    await expect(new LocalCodexCatalog(path).listThreads()).resolves.toEqual([
      expect.objectContaining({ id: "legacy", cwd: "/legacy", updatedAt: 123 }),
    ]);
    await expect(new LocalCodexCatalog(join(directory, "missing.sqlite")).listThreads())
      .rejects.toThrow("无法只读 Codex 会话数据库");
  });
});
