import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodexAppServerClient } from "../src/app-server/client.js";
import { SessionManager } from "../src/session/manager.js";
import { SqliteSessionStore } from "../src/session/sqlite-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("SqliteSessionStore", () => {
  it("persists all session fields across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "sessions.sqlite");
    const first = new SqliteSessionStore(databasePath);
    await first.set({
      chatId: "chat-1",
      threadId: "thread-1",
      cwd: "/workspace",
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
});
