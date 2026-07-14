import { describe, expect, it, vi } from "vitest";

import type { CodexAppServerClient } from "../src/app-server/client.js";
import { CommandRouter } from "../src/commands/index.js";
import { SessionManager } from "../src/session/manager.js";
import { MemorySessionStore } from "../src/session/memory-store.js";

function setup() {
  let thread = 0;
  let turn = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "thread/start") return { thread: { id: `thread-${++thread}` } };
    if (method === "thread/resume") return {};
    if (method === "turn/start") return { turn: { id: `turn-${++turn}` } };
    if (method === "turn/interrupt") return {};
    throw new Error(`Unexpected method ${method}`);
  });
  const client = { request } as unknown as Pick<CodexAppServerClient, "request">;
  const manager = new SessionManager(new MemorySessionStore(), client, { cwd: "/workspace" });
  return { request, manager };
}

describe("SessionManager", () => {
  it("maps one chat to one thread and reuses it for continuous turns", async () => {
    const { manager, request } = setup();
    const first = await manager.beginTurn("chat-1", [{ type: "text", text: "one" }]);
    await manager.updateStatus("chat-1", "idle");
    const second = await manager.beginTurn("chat-1", [{ type: "text", text: "two" }]);

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

  it("interrupts the active turn and rejects overlapping turns", async () => {
    const { manager, request } = setup();
    await manager.beginTurn("chat-1", [{ type: "text", text: "run" }]);
    await expect(manager.beginTurn("chat-1", [{ type: "text", text: "overlap" }])).rejects.toThrow("active");
    await expect(manager.interrupt("chat-1")).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });
});

describe("CommandRouter", () => {
  it("implements /new, /stop, /status, and /help", async () => {
    const { manager } = setup();
    const router = new CommandRouter(manager, { getStatus: () => "ready" });

    await expect(router.execute("chat-1", "/new")).resolves.toBe("已创建新的 Codex 会话。");
    await expect(router.execute("chat-1", "/status")).resolves.toContain("Codex App Server：已连接");
    await expect(router.execute("chat-1", "/stop")).resolves.toContain("当前没有");
    await expect(router.execute("chat-1", "/help")).resolves.toContain("/status");
  });
});
