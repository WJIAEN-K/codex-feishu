import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodexAppServerClient } from "../src/app-server/client.js";
import { CommandRouter } from "../src/commands/index.js";
import { SessionManager } from "../src/session/manager.js";
import { MemorySessionStore } from "../src/session/memory-store.js";
import { MemoryWorkspaceStore } from "../src/workspace/memory-store.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { LocalCodexCatalog } from "../src/codex-local/catalog.js";
import Database from "better-sqlite3";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(options: { localDiscovery?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codex-feishu-commands-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "projects");
  const defaultProject = join(root, "default-project");
  const backend = join(root, "backend");
  await Promise.all([mkdir(defaultProject, { recursive: true }), mkdir(backend, { recursive: true })]);
  const canonicalBackend = await realpath(backend);

  let threadCount = 0;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "thread/start") return { thread: { id: `thread-${++threadCount}` } };
    if (method === "thread/list") {
      return {
        data: [{
          id: "existing-thread",
          cwd: canonicalBackend,
          preview: "已有后端会话",
          name: null,
          updatedAt: 1_700_000_000,
          status: { type: "notLoaded" },
        }],
      };
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: (params as { threadId: string }).threadId,
          cwd: canonicalBackend,
          preview: "已有后端会话",
          name: null,
          updatedAt: 1_700_000_000,
          status: { type: "notLoaded" },
        },
      };
    }
    if (method === "thread/resume" || method === "turn/interrupt") return {};
    throw new Error(`Unexpected method ${method}`);
  });
  const client = { request } as unknown as Pick<CodexAppServerClient, "request">;
  let localCatalog: LocalCodexCatalog | undefined;
  if (options.localDiscovery) {
    const statePath = join(directory, "state_5.sqlite");
    const database = new Database(statePath);
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL,
        preview TEXT NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
      )
    `);
    database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0)")
      .run("local-thread", canonicalBackend, "本地后端会话", "直接读取", 1_700_000_001);
    database.close();
    localCatalog = new LocalCodexCatalog(statePath);
  }
  const sessions = new SessionManager(
    new MemorySessionStore(),
    client,
    { cwd: defaultProject },
    localCatalog,
  );
  const workspaces = new WorkspaceRegistry(new MemoryWorkspaceStore(), {
    allowedRoots: [root],
    adminOpenIds: ["ou-admin"],
    defaultPath: defaultProject,
  });
  await workspaces.initialize();
  const router = new CommandRouter(sessions, { getStatus: () => "ready" }, workspaces);
  return { backend, canonicalBackend, request, router, sessions };
}

const adminContext = { chatId: "chat-1", senderOpenId: "ou-admin", chatType: "group" as const };
const userContext = { chatId: "chat-1", senderOpenId: "ou-user", chatType: "group" as const };

describe("workspace and session commands", () => {
  it("lets an admin register and switch to an allowlisted project", async () => {
    const { backend, canonicalBackend, request, router, sessions } = await setup();

    await expect(router.execute(adminContext, `/project add backend ${backend}`)).resolves.toContain("已添加项目");
    await expect(router.execute(userContext, "/project list")).resolves.toContain("backend");
    await expect(router.execute(userContext, "/project use backend")).resolves.toContain("已切换项目");
    await expect(sessions.get("chat-1")).resolves.toMatchObject({
      cwd: canonicalBackend,
      bindingMode: "owned",
    });
    expect(request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ cwd: canonicalBackend }));
  });

  it("prevents non-admins from registering projects", async () => {
    const { backend, router } = await setup();
    await expect(router.execute(userContext, `/project add backend ${backend}`)).rejects.toThrow("管理员");
  });

  it("lists and binds an existing Codex thread by list index", async () => {
    const { backend, canonicalBackend, request, router, sessions } = await setup();
    await router.execute(adminContext, `/project add backend ${backend}`);

    await expect(router.execute(adminContext, "/session list backend")).resolves.toContain("existing-thread");
    await expect(router.execute(adminContext, "/session use 1")).resolves.toContain("已切换到已有会话");
    await expect(sessions.get("chat-1")).resolves.toMatchObject({
      threadId: "existing-thread",
      cwd: canonicalBackend,
      bindingMode: "attached",
    });
    expect(request).toHaveBeenCalledWith("thread/list", expect.objectContaining({
      cwd: canonicalBackend,
      sourceKinds: ["cli", "vscode", "appServer"],
    }));
    expect(request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({
      threadId: "existing-thread",
      cwd: canonicalBackend,
    }));
  });

  it("discovers local Codex projects and lists their sessions without thread/list", async () => {
    const { canonicalBackend, request, router, sessions } = await setup({ localDiscovery: true });

    await expect(router.execute(adminContext, "/project discover")).resolves.toContain(canonicalBackend);
    await expect(router.execute(adminContext, "/project use-local 1")).resolves.toContain("已切换");
    await expect(router.execute(adminContext, "/session list")).resolves.toContain("local-thread");
    expect(request.mock.calls.some(([method]) => method === "thread/list")).toBe(false);
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ cwd: canonicalBackend });
  });

  it("does not expose local Codex project paths to ordinary group users", async () => {
    const { router } = await setup({ localDiscovery: true });
    await expect(router.execute(userContext, "/project discover")).rejects.toThrow("管理员");
    await expect(router.execute(userContext, "/project use-local 1")).rejects.toThrow("管理员");
  });

  it("lists, renames, and switches saved Feishu sessions without admin access", async () => {
    const { router, sessions } = await setup();
    await sessions.create("chat-1", undefined, "会话一");
    await sessions.create("chat-1", undefined, "会话二");

    await expect(router.execute(userContext, "/session saved")).resolves.toContain("会话一");
    await expect(router.execute(userContext, "/session switch 会话一")).resolves.toContain("会话一");
    await expect(router.execute(userContext, "/session rename 主会话")).resolves.toContain("主会话");
    await expect(sessions.get("chat-1")).resolves.toMatchObject({ name: "主会话" });
  });

  it("prevents non-admins from listing or binding existing Codex threads", async () => {
    const { backend, request, router } = await setup();
    await router.execute(adminContext, `/project add backend ${backend}`);

    await expect(router.execute(userContext, "/session list backend")).rejects.toThrow("管理员");
    await expect(router.execute(userContext, "/session use existing-thread")).rejects.toThrow("管理员");
    expect(request).not.toHaveBeenCalledWith("thread/list", expect.anything());
    expect(request).not.toHaveBeenCalledWith("thread/read", expect.anything());
  });

  it("does not allow the same thread to be attached to two Feishu chats", async () => {
    const { canonicalBackend, sessions } = await setup();
    const thread = await sessions.readThread("existing-thread");
    thread.cwd = canonicalBackend;
    await sessions.bind("chat-1", thread);
    await expect(sessions.bind("chat-2", thread)).rejects.toThrow("另一个飞书聊天");
  });

  it("does not attach a thread that is active in another client", async () => {
    const { sessions } = await setup();
    const thread = await sessions.readThread("existing-thread");
    thread.status = { type: "active", activeFlags: [] };
    await expect(sessions.bind("chat-1", thread)).rejects.toThrow("其他客户端");
  });
});
