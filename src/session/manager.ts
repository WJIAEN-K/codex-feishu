import type { CodexAppServerClient } from "../app-server/client.js";
import type { TurnInput } from "../app-server/protocol.js";
import type { TurnStartParams } from "../app-server/generated/v2/TurnStartParams.js";
import type { ThreadTurnsListResponse } from "../app-server/generated/v2/ThreadTurnsListResponse.js";
import type { GetAccountTokenUsageResponse } from "../app-server/generated/v2/GetAccountTokenUsageResponse.js";
import type { GetAccountRateLimitsResponse } from "../app-server/generated/v2/GetAccountRateLimitsResponse.js";
import type { Model } from "../app-server/generated/v2/Model.js";
import type { ModelListResponse } from "../app-server/generated/v2/ModelListResponse.js";
import { ThreadCatalog, type ThreadSummary } from "../app-server/thread-catalog.js";
import { startThread, resumeThread } from "../app-server/thread.js";
import { interruptTurn, startTurn } from "../app-server/turn.js";
import type { ChatSession, RuntimeMode, SessionStatus } from "../types.js";
import type { LocalCodexCatalog, LocalCodexProject } from "../codex-local/catalog.js";
import type { SessionStore } from "./store.js";

export interface SessionManagerOptions {
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  idleResetMs?: number;
}

export interface BeginTurnOptions {
  additionalContext?: TurnStartParams["additionalContext"];
}

export interface ConversationHistoryEntry {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

type RpcClient = Pick<CodexAppServerClient, "request">;

export class SessionManager {
  private readonly attachedThreads = new Set<string>();
  private readonly bindingThreads = new Set<string>();
  private readonly threads: ThreadCatalog;

  constructor(
    private readonly store: SessionStore,
    private readonly client: RpcClient,
    private readonly options: SessionManagerOptions,
    private readonly localCatalog?: LocalCodexCatalog,
  ) {
    this.threads = new ThreadCatalog(client);
  }

  get(chatId: string): Promise<ChatSession | null> {
    return this.store.get(chatId);
  }

  async getOrCreate(chatId: string): Promise<ChatSession> {
    const existing = await this.store.get(chatId);
    if (!existing) return this.create(chatId);
    if (
      (this.options.idleResetMs ?? 0) > 0
      && existing.status === "idle"
      && Date.now() - existing.updatedAt >= (this.options.idleResetMs ?? 0)
    ) {
      return this.create(chatId, existing.cwd);
    }
    if (!this.attachedThreads.has(existing.threadId)) {
      await resumeThread(this.client, existing.threadId, this.threadOptions(existing));
      this.attachedThreads.add(existing.threadId);
      if (existing.status === "running" || existing.status === "waiting_approval") {
        existing.status = "idle";
        delete existing.activeTurnId;
        existing.updatedAt = Date.now();
        await this.store.set(existing);
      }
    }
    return existing;
  }

  async create(chatId: string, cwd = this.options.cwd, name?: string): Promise<ChatSession> {
    const threadId = await startThread(this.client, { ...this.options, cwd });
    const now = Date.now();
    const session: ChatSession = {
      id: threadId,
      name: normalizeSessionName(name ?? `会话 ${threadId.slice(0, 8)}`),
      chatId,
      threadId,
      cwd,
      bindingMode: "owned",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(session);
    this.attachedThreads.add(threadId);
    return session;
  }

  async switchWorkspace(chatId: string, cwd: string): Promise<ChatSession> {
    const current = await this.store.get(chatId);
    if (current?.status === "running" || current?.status === "waiting_approval") {
      throw new Error("当前会话有正在执行或等待审批的任务，不能切换项目");
    }
    return this.create(chatId, cwd);
  }

  async resume(chatId: string): Promise<ChatSession> {
    const session = await this.requireSession(chatId);
      await resumeThread(this.client, session.threadId, this.threadOptions(session));
    this.attachedThreads.add(session.threadId);
    return session;
  }

  async recoverAfterServerRestart(): Promise<ChatSession[]> {
    this.attachedThreads.clear();
    const sessions = await this.store.list();
    const recovered = await Promise.all(sessions.map(async (session) => {
      try {
        await resumeThread(this.client, session.threadId, this.threadOptions(session));
        this.attachedThreads.add(session.threadId);
        if (session.status === "running" || session.status === "waiting_approval") {
          session.status = "error";
          delete session.activeTurnId;
          session.updatedAt = Date.now();
          await this.store.set(session, false);
        }
        return session;
      } catch {
        return null;
      }
    }));
    return recovered.filter((session): session is ChatSession => session !== null);
  }

  async listThreads(cwd?: string): Promise<ThreadSummary[]> {
    if (this.localCatalog) {
      try {
        return await this.localCatalog.listThreads(cwd);
      } catch {
        // The App Server remains the compatibility fallback if the internal DB is absent or changed.
      }
    }
    return this.threads.list(cwd);
  }

  async listLocalProjects(): Promise<LocalCodexProject[]> {
    if (!this.localCatalog) throw new Error("Codex 本地数据库发现功能未启用");
    return this.localCatalog.listProjects();
  }

  async readThread(threadId: string): Promise<ThreadSummary> {
    return this.threads.read(threadId);
  }

  async bind(chatId: string, thread: ThreadSummary): Promise<ChatSession> {
    const current = await this.store.get(chatId);
    if (current?.status === "running" || current?.status === "waiting_approval") {
      throw new Error("当前会话有正在执行或等待审批的任务，不能切换");
    }
    if (thread.status.type === "active") throw new Error("该 Codex 会话当前正在其他客户端执行任务");
    if (this.bindingThreads.has(thread.id)) throw new Error("该 Codex 会话正在被另一个飞书聊天绑定");
    this.bindingThreads.add(thread.id);
    try {
      const bound = await this.store.getByThreadId(thread.id);
      if (bound && bound.chatId !== chatId) throw new Error("该 Codex 会话已绑定到另一个飞书聊天");

      await resumeThread(this.client, thread.id, { cwd: thread.cwd });
      const now = Date.now();
      const session: ChatSession = {
        id: thread.id,
        name: normalizeSessionName(thread.name ?? thread.preview ?? `会话 ${thread.id.slice(0, 8)}`),
        chatId,
        threadId: thread.id,
        cwd: thread.cwd,
        bindingMode: "attached",
        status: "idle",
        createdAt: now,
        updatedAt: now,
      };
      await this.store.set(session);
      this.attachedThreads.add(thread.id);
      return session;
    } finally {
      this.bindingThreads.delete(thread.id);
    }
  }

  async beginTurn(
    chatId: string,
    input: TurnInput[],
    options: BeginTurnOptions = {},
  ): Promise<ChatSession> {
    const session = await this.getOrCreate(chatId);
    if (session.status === "running" || session.status === "waiting_approval") {
      throw new Error("This Feishu chat already has an active Codex turn");
    }

    session.status = "running";
    session.updatedAt = Date.now();
    await this.store.set(session);
    try {
      const turnId = await startTurn(this.client, {
        threadId: session.threadId,
        input,
        cwd: session.cwd,
        model: session.runtime?.model ?? this.options.model,
        reasoningEffort: session.runtime?.reasoningEffort ?? this.options.reasoningEffort,
        additionalContext: options.additionalContext,
        ...turnRuntimeOptions(session.runtime?.mode ?? "default", session.cwd, session.runtime?.model ?? this.options.model),
      });
      const latest = await this.store.get(chatId);
      if (!latest || latest.threadId !== session.threadId || latest.status !== "running") {
        return latest ?? session;
      }
      latest.activeTurnId = turnId;
      latest.updatedAt = Date.now();
      await this.store.set(latest);
      return latest;
    } catch (error) {
      session.status = "error";
      session.updatedAt = Date.now();
      await this.store.set(session);
      throw error;
    }
  }

  listSaved(chatId: string): Promise<ChatSession[]> {
    return this.store.list(chatId);
  }

  listAll(): Promise<ChatSession[]> { return this.store.list(); }

  async switchSaved(chatId: string, selector: string): Promise<ChatSession> {
    const current = await this.store.get(chatId);
    if (current?.status === "running" || current?.status === "waiting_approval") {
      throw new Error("当前会话有正在执行或等待处理的任务，不能切换");
    }
    const candidates = await this.store.list(chatId);
    const normalized = selector.trim().toLowerCase();
    const matches = candidates.filter((session) => (
      session.id === selector
      || session.threadId === selector
      || session.id?.startsWith(selector)
      || session.threadId.startsWith(selector)
      || session.name?.toLowerCase() === normalized
    ));
    if (matches.length === 0) throw new Error("未找到指定的已保存会话");
    if (matches.length > 1) throw new Error("会话选择不唯一，请使用完整名称或 Thread ID");
    const session = matches[0]!;
    await resumeThread(this.client, session.threadId, this.threadOptions(session));
    session.status = "idle";
    delete session.activeTurnId;
    session.updatedAt = Date.now();
    await this.store.set(session);
    this.attachedThreads.add(session.threadId);
    return session;
  }

  async renameCurrent(chatId: string, name: string): Promise<ChatSession> {
    const session = await this.requireSession(chatId);
    const normalized = normalizeSessionName(name);
    await this.store.rename(session.id ?? session.threadId, normalized);
    session.name = normalized;
    session.updatedAt = Date.now();
    return session;
  }

  async history(chatId: string, limit = 10): Promise<ConversationHistoryEntry[]> {
    const session = await this.requireSession(chatId);
    const result = await this.client.request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId: session.threadId,
      limit: Math.max(1, Math.min(50, limit)),
      sortDirection: "desc",
      itemsView: "full",
    });
    const entries: ConversationHistoryEntry[] = [];
    for (const turn of [...result.data].reverse()) {
      for (const item of turn.items) {
        if (item.type === "userMessage") {
          const text = item.content
            .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
            .map((content) => content.text)
            .join("\n");
          if (text) entries.push({ role: "user", text, ...(turn.startedAt ? { timestamp: turn.startedAt } : {}) });
        } else if (item.type === "agentMessage" && item.text) {
          entries.push({
            role: "assistant",
            text: item.text,
            ...(turn.completedAt ?? turn.startedAt ? { timestamp: turn.completedAt ?? turn.startedAt! } : {}),
          });
        }
      }
    }
    return entries;
  }

  async usage(): Promise<{ usage: GetAccountTokenUsageResponse; limits: GetAccountRateLimitsResponse }> {
    const [usage, limits] = await Promise.all([
      this.client.request<GetAccountTokenUsageResponse>("account/usage/read"),
      this.client.request<GetAccountRateLimitsResponse>("account/rateLimits/read"),
    ]);
    return { usage, limits };
  }

  async listModels(): Promise<Model[]> {
    const result = await this.client.request<ModelListResponse>("model/list", {
      limit: 100,
      includeHidden: false,
    });
    return result.data.filter((model) => !model.hidden);
  }

  async setModel(chatId: string, selector?: string): Promise<ChatSession> {
    const session = await this.requireIdleSession(chatId);
    if (!selector || selector === "default") {
      session.runtime = { ...session.runtime };
      delete session.runtime.model;
    } else {
      const normalized = selector.trim().toLowerCase();
      const models = await this.listModels();
      const matches = models.filter((model) => (
        model.id.toLowerCase() === normalized
        || model.model.toLowerCase() === normalized
        || model.displayName.toLowerCase() === normalized
      ));
      if (matches.length === 0) throw new Error("未找到指定模型，请先执行 /model list");
      if (matches.length > 1) throw new Error("模型名称不唯一，请使用模型 ID");
      session.runtime = { ...session.runtime, model: matches[0]!.model };
    }
    return this.persistRuntime(session);
  }

  async setReasoningEffort(chatId: string, effort?: string): Promise<ChatSession> {
    const session = await this.requireIdleSession(chatId);
    const normalized = effort?.trim().toLowerCase();
    if (!normalized || normalized === "default") {
      session.runtime = { ...session.runtime };
      delete session.runtime.reasoningEffort;
    } else {
      const allowed = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "ultra"]);
      if (!allowed.has(normalized)) {
        throw new Error("推理强度应为 none、minimal、low、medium、high、xhigh、ultra 或 default");
      }
      session.runtime = { ...session.runtime, reasoningEffort: normalized };
    }
    return this.persistRuntime(session);
  }

  async setRuntimeMode(chatId: string, mode: RuntimeMode): Promise<ChatSession> {
    const session = await this.requireIdleSession(chatId);
    if (mode === "plan" && !session.runtime?.model && !this.options.model) {
      const models = await this.listModels();
      const defaultModel = models.find((model) => model.isDefault) ?? models[0];
      if (!defaultModel) throw new Error("Codex 未返回可用于 plan 模式的模型");
      session.runtime = { ...session.runtime, model: defaultModel.model };
    }
    session.runtime = { ...session.runtime, mode };
    return this.persistRuntime(session);
  }

  async interrupt(chatId: string): Promise<boolean> {
    const session = await this.store.get(chatId);
    if (!session?.activeTurnId || !["running", "waiting_approval"].includes(session.status)) return false;
    await interruptTurn(this.client, session.threadId, session.activeTurnId);
    return true;
  }

  async updateStatus(
    chatId: string,
    status: SessionStatus,
    activeTurnId?: string,
    expectedThreadId?: string,
  ): Promise<ChatSession | null> {
    const session = await this.store.get(chatId);
    if (!session) return null;
    if (expectedThreadId && session.threadId !== expectedThreadId) return session;
    session.status = status;
    if (activeTurnId === undefined) delete session.activeTurnId;
    else session.activeTurnId = activeTurnId;
    session.updatedAt = Date.now();
    await this.store.set(session);
    return session;
  }

  private async requireSession(chatId: string): Promise<ChatSession> {
    const session = await this.store.get(chatId);
    if (!session) throw new Error(`No Codex session for Feishu chat ${chatId}`);
    return session;
  }

  private async requireIdleSession(chatId: string): Promise<ChatSession> {
    const session = await this.requireSession(chatId);
    if (session.status === "running" || session.status === "waiting_approval") {
      throw new Error("当前任务结束后才能修改运行设置");
    }
    return session;
  }

  private async persistRuntime(session: ChatSession): Promise<ChatSession> {
    session.updatedAt = Date.now();
    await this.store.set(session);
    return session;
  }

  private threadOptions(session: ChatSession) {
    const mode = session.runtime?.mode ?? "default";
    return {
      cwd: session.cwd,
      model: session.runtime?.model ?? this.options.model,
      reasoningEffort: session.runtime?.reasoningEffort ?? this.options.reasoningEffort,
      approvalPolicy: mode === "full-auto" ? "never" as const : "on-request" as const,
      sandbox: mode === "plan" ? "read-only" as const : "workspace-write" as const,
    };
  }
}

function turnRuntimeOptions(mode: RuntimeMode, cwd: string, model?: string) {
  const sandboxPolicy = mode === "plan"
    ? { type: "readOnly" as const, networkAccess: false }
    : {
        type: "workspaceWrite" as const,
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  return {
    approvalPolicy: mode === "full-auto" ? "never" as const : "on-request" as const,
    sandboxPolicy,
    ...(mode === "plan" && model ? {
      collaborationMode: {
        mode: "plan" as const,
        settings: { model, reasoning_effort: null, developer_instructions: null },
      },
    } : {}),
  };
}

function normalizeSessionName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("会话名称不能为空");
  if (normalized.length > 80) throw new Error("会话名称不能超过 80 个字符");
  return normalized;
}
