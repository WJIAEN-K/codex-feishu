import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import type { CodexAppServerClient } from "../src/app-server/client.js";
import { SessionManager } from "../src/session/manager.js";
import { SqliteSessionStore } from "../src/session/sqlite-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("SqliteSessionStore", () => {
  it("migrates databases created before binding_mode was added", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "sessions.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE chat_sessions (
        chat_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        active_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO chat_sessions VALUES ('chat-1', 'thread-1', '/workspace', 'idle', NULL, 100, 200);
    `);
    legacy.close();

    const store = new SqliteSessionStore(databasePath);
    await expect(store.get("chat-1")).resolves.toMatchObject({ bindingMode: "owned" });
    store.close();
  });

  it("persists all session fields across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "sessions.sqlite");
    const first = new SqliteSessionStore(databasePath);
    await first.set({
      chatId: "chat-1",
      threadId: "thread-1",
      cwd: "/workspace",
      bindingMode: "owned",
      status: "running",
      activeTurnId: "turn-1",
      createdAt: 100,
      updatedAt: 200,
    });
    first.close();

    const second = new SqliteSessionStore(databasePath);
    await expect(second.get("chat-1")).resolves.toEqual({
      chatId: "chat-1",
      threadId: "thread-1",
      cwd: "/workspace",
      bindingMode: "owned",
      status: "running",
      activeTurnId: "turn-1",
      createdAt: 100,
      updatedAt: 200,
    });
    await second.delete("chat-1");
    await expect(second.get("chat-1")).resolves.toBeNull();
    second.close();
  });

  it("resumes a persisted thread after service restart and clears stale running state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-resume-"));
    temporaryDirectories.push(directory);
    const store = new SqliteSessionStore(join(directory, "sessions.sqlite"));
    await store.set({
      chatId: "chat-1",
      threadId: "thread-existing",
      cwd: "/workspace",
      bindingMode: "owned",
      status: "running",
      activeTurnId: "turn-stale",
      createdAt: 100,
      updatedAt: 200,
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/resume") return {};
      throw new Error(`Unexpected ${method}`);
    });
    const manager = new SessionManager(
      store,
      { request } as unknown as Pick<CodexAppServerClient, "request">,
      { cwd: "/workspace" },
    );

    await expect(manager.getOrCreate("chat-1")).resolves.toMatchObject({
      threadId: "thread-existing",
      status: "idle",
    });
    expect(request).toHaveBeenCalledWith("thread/resume", {
      threadId: "thread-existing",
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    expect(await store.get("chat-1")).not.toHaveProperty("activeTurnId");
    store.close();
  });

  it("recovers all persisted threads after the App Server process restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-recover-"));
    temporaryDirectories.push(directory);
    const store = new SqliteSessionStore(join(directory, "sessions.sqlite"));
    await store.set({
      chatId: "chat-1",
      threadId: "thread-1",
      cwd: "/workspace/one",
      bindingMode: "owned",
      status: "idle",
      createdAt: 100,
      updatedAt: 200,
    });
    await store.set({
      chatId: "chat-2",
      threadId: "thread-2",
      cwd: "/workspace/two",
      bindingMode: "attached",
      status: "running",
      activeTurnId: "stale-turn",
      createdAt: 100,
      updatedAt: 300,
    });
    const request = vi.fn(async () => ({}));
    const manager = new SessionManager(
      store,
      { request } as unknown as Pick<CodexAppServerClient, "request">,
      { cwd: "/workspace" },
    );

    await expect(manager.recoverAfterServerRestart()).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(store.get("chat-2")).resolves.toMatchObject({ status: "error" });
    expect(await store.get("chat-2")).not.toHaveProperty("activeTurnId");
    store.close();
  });
});
