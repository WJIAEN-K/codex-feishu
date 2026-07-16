import { describe, expect, it, vi } from "vitest";

import type { CodexAppServerClient } from "../src/app-server/client.js";
import { CommandRouter } from "../src/commands/index.js";
import { SessionManager } from "../src/session/manager.js";
import { MemorySessionStore } from "../src/session/memory-store.js";
import type { WorkspaceRegistry } from "../src/workspace/registry.js";

const context = { chatId: "chat-1", senderOpenId: "ou-test-user", chatType: "p2p" as const };

function setup() {
  let thread = 0;
  let turn = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "thread/start") return { thread: { id: `thread-${++thread}` } };
    if (method === "thread/resume") return {};
    if (method === "turn/start") return { turn: { id: `turn-${++turn}` } };
    if (method === "turn/interrupt") return {};
    if (method === "thread/turns/list") return {
      data: [{
        id: "turn-history",
        items: [
          {
            type: "userMessage",
            id: "user-item",
            clientId: null,
            content: [{ type: "text", text: "检查发布配置", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "agent-item",
            text: "package.json 已通过检查。",
            phase: null,
            memoryCitation: null,
          },
        ],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1_700_000_000,
        completedAt: 1_700_000_005,
        durationMs: 5_000,
      }],
      nextCursor: null,
      backwardsCursor: null,
    };
    if (method === "account/usage/read") return {
      summary: {
        lifetimeTokens: 12_345n,
        peakDailyTokens: 2_345n,
        longestRunningTurnSec: 60n,
        currentStreakDays: 2n,
        longestStreakDays: 5n,
      },
      dailyUsageBuckets: null,
    };
    if (method === "account/rateLimits/read") return {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_900_000_000 },
        secondary: null,
        credits: null,
        individualLimit: null,
        planType: null,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    };
    throw new Error(`Unexpected method ${method}`);
  });
  const client = { request } as unknown as Pick<CodexAppServerClient, "request">;
  const manager = new SessionManager(new MemorySessionStore(), client, { cwd: "/workspace" });
  return { request, manager };
}

describe("SessionManager", () => {
  it("maps one chat to one thread and reuses it for continuous turns", async () => {
    const { manager, request } = setup();
    const first = await manager.beginTurn("chat-1", [{ type: "text", text: "one", text_elements: [] }]);
    await manager.updateStatus("chat-1", "idle");
    const second = await manager.beginTurn("chat-1", [{ type: "text", text: "two", text_elements: [] }]);

    expect(first.threadId).toBe("thread-1");
    expect(second.threadId).toBe("thread-1");
    expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(2);
  });

  it("creates a replacement thread for /new", async () => {
    const { manager } = setup();
    await manager.create("chat-1");
    const replacement = await manager.create("chat-1");
    expect(replacement.threadId).toBe("thread-2");
    await expect(manager.get("chat-1")).resolves.toMatchObject({ threadId: "thread-2" });
  });

  it("keeps named sessions and switches between them", async () => {
    const { manager } = setup();
    await manager.create("chat-1", "/workspace/backend", "后端");
    await manager.create("chat-1", "/workspace/frontend", "前端");

    await expect(manager.listSaved("chat-1")).resolves.toHaveLength(2);
    await expect(manager.switchSaved("chat-1", "后端")).resolves.toMatchObject({
      name: "后端",
      threadId: "thread-1",
    });
    await expect(manager.renameCurrent("chat-1", "后端 API")).resolves.toMatchObject({
      name: "后端 API",
    });
    await expect(manager.get("chat-1")).resolves.toMatchObject({ name: "后端 API" });
  });

  it("starts a new session after the configured idle duration", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: `thread-${request.mock.calls.length}` } };
      if (method === "thread/resume") return {};
      throw new Error(`Unexpected ${method}`);
    });
    const manager = new SessionManager(
      new MemorySessionStore(),
      { request } as unknown as Pick<CodexAppServerClient, "request">,
      { cwd: "/workspace", idleResetMs: 100 },
    );
    const first = await manager.create("chat-1");
    first.updatedAt = Date.now() - 101;
    await manager.updateStatus("chat-1", "idle");
    const stored = await manager.get("chat-1");
    stored!.updatedAt = Date.now() - 101;
    // Persist the simulated idle timestamp through the in-memory store by recreating the manager state.
    const store = new MemorySessionStore();
    await store.set(stored!);
    const idleManager = new SessionManager(
      store,
      { request } as unknown as Pick<CodexAppServerClient, "request">,
      { cwd: "/workspace", idleResetMs: 100 },
    );

    const replacement = await idleManager.getOrCreate("chat-1");
    expect(replacement.threadId).not.toBe(first.threadId);
    await expect(idleManager.listSaved("chat-1")).resolves.toHaveLength(2);
  });

  it("interrupts the active turn and rejects overlapping turns", async () => {
    const { manager, request } = setup();
    await manager.beginTurn("chat-1", [{ type: "text", text: "run", text_elements: [] }]);
    await expect(manager.beginTurn("chat-1", [{
      type: "text", text: "overlap", text_elements: [],
    }])).rejects.toThrow("active");
    await expect(manager.interrupt("chat-1")).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("reads full turn history and account usage", async () => {
    const { manager, request } = setup();
    await manager.create("chat-1");

    await expect(manager.history("chat-1", 5)).resolves.toEqual([
      { role: "user", text: "检查发布配置", timestamp: 1_700_000_000 },
      { role: "assistant", text: "package.json 已通过检查。", timestamp: 1_700_000_005 },
    ]);
    await expect(manager.usage()).resolves.toMatchObject({
      usage: { summary: { lifetimeTokens: 12_345n } },
      limits: { rateLimits: { primary: { usedPercent: 25 } } },
    });
    expect(request).toHaveBeenCalledWith("thread/turns/list", {
      threadId: "thread-1",
      limit: 5,
      sortDirection: "desc",
      itemsView: "full",
    });
  });
});

describe("CommandRouter", () => {
  it("implements /new, /stop, /status, and /help", async () => {
    const { manager } = setup();
    const router = new CommandRouter(manager, { getStatus: () => "ready" }, {} as WorkspaceRegistry);

    await expect(router.execute(context, "/new")).resolves.toBe("已创建新的 Codex 会话。");
    await expect(router.execute(context, "/status")).resolves.toContain("Codex App Server：已连接");
    await expect(router.execute(context, "/stop")).resolves.toContain("当前没有");
    await expect(router.execute(context, "/help")).resolves.toContain("/status");
  });

  it("interrupts an active turn before /new replaces its thread", async () => {
    const { manager, request } = setup();
    const router = new CommandRouter(manager, { getStatus: () => "ready" }, {} as WorkspaceRegistry);
    await manager.beginTurn("chat-1", [{ type: "text", text: "running", text_elements: [] }]);

    await expect(router.execute(context, "/new")).resolves.toBe("已创建新的 Codex 会话。");
    expect(request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await expect(manager.get("chat-1")).resolves.toMatchObject({ threadId: "thread-2", status: "idle" });
  });

  it("keeps the current working directory when /new replaces a thread", async () => {
    const { manager, request } = setup();
    const router = new CommandRouter(manager, { getStatus: () => "ready" }, {} as WorkspaceRegistry);
    await manager.create("chat-1", "/workspace/backend");

    await router.execute(context, "/new");

    expect(request).toHaveBeenLastCalledWith("thread/start", expect.objectContaining({
      cwd: "/workspace/backend",
    }));
    await expect(manager.get("chat-1")).resolves.toMatchObject({
      threadId: "thread-2",
      cwd: "/workspace/backend",
    });
  });

  it("exposes /history and /usage as top-level commands", async () => {
    const { manager } = setup();
    const router = new CommandRouter(manager, { getStatus: () => "ready" }, {} as WorkspaceRegistry);
    await manager.create("chat-1");

    await expect(router.execute(context, "/history 5")).resolves.toContain("检查发布配置");
    await expect(router.execute(context, "/usage")).resolves.toContain("12,345");
  });
});
