import { describe, expect, it, vi } from "vitest";

import type { CodexAppServerClient } from "../src/app-server/client.js";
import { CommandRouter } from "../src/commands/index.js";
import { MemorySessionStore } from "../src/session/memory-store.js";
import { SessionManager } from "../src/session/manager.js";
import type { WorkspaceRegistry } from "../src/workspace/registry.js";

const context = { chatId: "chat-1", senderOpenId: "ou-user", chatType: "p2p" as const };

function setup(admin = false) {
  let turn = 0;
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "thread/resume") return {};
    if (method === "turn/interrupt") return {};
    if (method === "turn/start") return { turn: { id: `turn-${++turn}` } };
    if (method === "model/list") return {
      data: [{
        id: "gpt-5.4",
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "",
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "medium",
        inputModalities: ["text"],
        supportsPersonality: true,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
      }],
      nextCursor: null,
    };
    if (method === "account/read") return {
      account: { type: "chatgpt", email: "demo@example.com", planType: "plus" },
      requiresOpenaiAuth: true,
    };
    throw new Error(`Unexpected method ${method}`);
  });
  const manager = new SessionManager(
    new MemorySessionStore(),
    { request } as unknown as Pick<CodexAppServerClient, "request">,
    { cwd: "/workspace" },
  );
  const workspaces = { isAdmin: () => admin } as unknown as WorkspaceRegistry;
  return {
    request,
    manager,
    router: new CommandRouter(
      manager,
      {
        getStatus: () => "ready",
        request: <T>(method: string, params?: unknown) => request(method, params) as Promise<T>,
      },
      workspaces,
      undefined,
      undefined,
      () => ({
        source: "desktop-bundled",
        version: "0.144.4",
        executablePath: "/Applications/Codex.app/Contents/Resources/codex",
        platform: "darwin",
        arch: "arm64",
      }),
    ),
  };
}

describe("runtime controls", () => {
  it("persists model and reasoning choices and sends them on the next turn", async () => {
    const { manager, request, router } = setup();
    await manager.create("chat-1");

    await expect(router.execute(context, "/model gpt-5.4")).resolves.toContain("gpt-5.4");
    await expect(router.execute(context, "/reasoning high")).resolves.toContain("high");
    await manager.beginTurn("chat-1", [{ type: "text", text: "run", text_elements: [] }]);

    expect(request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({
      model: "gpt-5.4",
      effort: "high",
      approvalPolicy: "on-request",
      sandboxPolicy: expect.objectContaining({ type: "workspaceWrite" }),
    }));
  });

  it("uses read-only sandbox and collaboration planning in plan mode", async () => {
    const { manager, request, router } = setup();
    await manager.create("chat-1");
    await router.execute(context, "/mode plan");
    await manager.beginTurn("chat-1", [{ type: "text", text: "plan", text_elements: [] }]);

    expect(request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      collaborationMode: expect.objectContaining({ mode: "plan" }),
      model: "gpt-5.4",
    }));
  });

  it("restricts full-auto to configured administrators", async () => {
    const ordinary = setup(false);
    await ordinary.manager.create("chat-1");
    await expect(ordinary.router.execute(context, "/mode full-auto")).rejects.toThrow("管理员");

    const privileged = setup(true);
    await privileged.manager.create("chat-1");
    await expect(privileged.router.execute(context, "/mode full-auto")).resolves.toContain("full-auto");
    await privileged.manager.beginTurn("chat-1", [{ type: "text", text: "run", text_elements: [] }]);
    expect(privileged.request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({
      approvalPolicy: "never",
      sandboxPolicy: expect.objectContaining({ type: "workspaceWrite" }),
    }));
  });

  it("can interrupt a turn while it is waiting for approval", async () => {
    const { manager, request } = setup();
    await manager.create("chat-1");
    const running = await manager.beginTurn("chat-1", [{ type: "text", text: "run", text_elements: [] }]);
    await manager.updateStatus("chat-1", "waiting_approval", running.activeTurnId, running.threadId);

    await expect(manager.interrupt("chat-1")).resolves.toBe(true);
    expect(request).toHaveBeenLastCalledWith("turn/interrupt", {
      threadId: running.threadId,
      turnId: running.activeTurnId,
    });
  });

  it("reports the selected Runtime and reused Codex account", async () => {
    const { router } = setup();
    await expect(router.execute(context, "/runtime")).resolves.toContain("桌面客户端");
    await expect(router.execute(context, "/account")).resolves.toContain("demo@example.com");
  });
});
