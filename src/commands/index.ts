import type { CodexAppServerClient } from "../app-server/client.js";
import type { ThreadSummary } from "../app-server/thread-catalog.js";
import type { SessionManager } from "../session/manager.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { helpCommand } from "./help.js";
import { newCommand } from "./new.js";
import { projectCommand, type CommandContext } from "./project.js";
import { sessionCommand } from "./session.js";
import { statusCommand } from "./status.js";
import { stopCommand } from "./stop.js";
import type { TaskScheduler } from "../scheduler/service.js";
import { timerCommand } from "./timer.js";
import { cronCommand } from "./cron.js";
import type { LocalCodexSyncService } from "../codex-local/sync-service.js";
import { formatAccount } from "../auth/bootstrap.js";
import type { GetAccountResponse } from "../app-server/generated/v2/GetAccountResponse.js";

export interface RuntimeStatusView {
  source: string;
  version: string;
  executablePath: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}

interface CommandAppServer {
  getStatus(): ReturnType<CodexAppServerClient["getStatus"]>;
  request?<T>(method: string, params?: unknown): Promise<T>;
}

export class CommandRouter {
  private readonly recentThreads = new Map<string, ThreadSummary[]>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly appServer: CommandAppServer,
    private readonly workspaces: WorkspaceRegistry,
    private readonly scheduler?: TaskScheduler,
    private readonly localSync?: LocalCodexSyncService,
    private readonly runtimeStatus?: () => RuntimeStatusView,
  ) {}

  isCommand(text: string): boolean {
    return text.trimStart().startsWith("/");
  }

  async execute(context: CommandContext, text: string): Promise<string> {
    const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
    const argumentsText = text.trim().slice(command?.length ?? 0).trim();
    switch (command) {
      case "/new": return newCommand(this.sessions, context.chatId);
      case "/stop": return stopCommand(this.sessions, context.chatId);
      case "/status": return statusCommand(this.sessions, context.chatId, this.appServer.getStatus());
      case "/project": return projectCommand(this.sessions, this.workspaces, context, argumentsText);
      case "/session": return sessionCommand(
        this.sessions,
        this.workspaces,
        this.recentThreads,
        context,
        argumentsText,
        this.localSync,
      );
      case "/history": return sessionCommand(
        this.sessions,
        this.workspaces,
        this.recentThreads,
        context,
        `history ${argumentsText}`,
        this.localSync,
      );
      case "/usage": return sessionCommand(
        this.sessions,
        this.workspaces,
        this.recentThreads,
        context,
        "usage",
        this.localSync,
      );
      case "/runtime": return this.runtimeCommand();
      case "/account": return this.accountCommand();
      case "/model": return this.modelCommand(context, argumentsText);
      case "/reasoning": return this.reasoningCommand(context, argumentsText);
      case "/mode": return this.modeCommand(context, argumentsText);
      case "/timer": return timerCommand(this.requireScheduler(), this.sessions, this.workspaces, context, argumentsText);
      case "/cron": return cronCommand(this.requireScheduler(), this.sessions, this.workspaces, context, argumentsText);
      case "/help": return helpCommand();
      default: return `未知命令：${command ?? text}\n\n${helpCommand()}`;
    }
  }

  private runtimeCommand(): string {
    if (!this.runtimeStatus) return "Codex Runtime 状态不可用";
    const runtime = this.runtimeStatus();
    const source = {
      configured: "显式配置",
      path: "系统 PATH",
      "desktop-bundled": "桌面客户端",
      managed: "托管 Runtime",
      downloaded: "自动下载",
    }[runtime.source] ?? runtime.source;
    return [
      "Codex Runtime",
      "",
      `来源：${source}`,
      `版本：${runtime.version}`,
      `平台：${runtime.platform} ${runtime.arch}`,
      `App Server：${this.appServer.getStatus() === "ready" ? "已连接" : this.appServer.getStatus()}`,
      `路径：${runtime.executablePath}`,
    ].join("\n");
  }

  private async accountCommand(): Promise<string> {
    if (!this.appServer.request) return "Codex 账户状态不可用";
    const result = await this.appServer.request<GetAccountResponse>("account/read", { refreshToken: false });
    return `Codex 账户：${formatAccount(result.account)}`;
  }

  private async modelCommand(context: CommandContext, argumentsText: string): Promise<string> {
    const selector = argumentsText.trim();
    if (!selector || selector === "list") {
      const [current, models] = await Promise.all([
        this.sessions.get(context.chatId),
        this.sessions.listModels(),
      ]);
      return [
        `当前模型：${current?.runtime?.model ?? "Codex 默认"}`,
        "可用模型：",
        ...models.map((model) => `${model.model === current?.runtime?.model ? "●" : "○"} ${model.displayName} (${model.model})`),
        "使用 /model <模型ID> 切换，/model default 恢复默认。",
      ].join("\n");
    }
    const session = await this.sessions.setModel(context.chatId, selector);
    return `当前会话模型已设为：${session.runtime?.model ?? "Codex 默认"}`;
  }

  private async reasoningCommand(context: CommandContext, argumentsText: string): Promise<string> {
    const effort = argumentsText.trim();
    if (!effort) {
      const session = await this.sessions.get(context.chatId);
      return `当前推理强度：${session?.runtime?.reasoningEffort ?? "Codex 默认"}\n` +
        "用法：/reasoning none|minimal|low|medium|high|xhigh|ultra|default";
    }
    const session = await this.sessions.setReasoningEffort(context.chatId, effort);
    return `当前会话推理强度已设为：${session.runtime?.reasoningEffort ?? "Codex 默认"}`;
  }

  private async modeCommand(context: CommandContext, argumentsText: string): Promise<string> {
    const requested = argumentsText.trim().toLowerCase();
    if (!requested) {
      const session = await this.sessions.get(context.chatId);
      return `当前运行模式：${session?.runtime?.mode ?? "default"}\n` +
        "可用模式：default、plan、full-auto（仅管理员）";
    }
    if (requested !== "default" && requested !== "plan" && requested !== "full-auto") {
      return "用法：/mode default|plan|full-auto";
    }
    if (requested === "full-auto" && !this.workspaces.isAdmin(context.senderOpenId)) {
      throw new Error("full-auto 会关闭逐项审批，仅允许配置的飞书管理员启用");
    }
    const session = await this.sessions.setRuntimeMode(context.chatId, requested);
    return `当前会话运行模式已设为：${session.runtime?.mode}`;
  }

  private requireScheduler(): TaskScheduler {
    if (!this.scheduler) throw new Error("定时任务服务未启用");
    return this.scheduler;
  }
}
