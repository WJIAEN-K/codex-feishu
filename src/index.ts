#!/usr/bin/env node

import { randomBytes } from "node:crypto";

import { AdminServer } from "./admin/server.js";
import { redactConfig } from "./admin/status.js";
import { CodexAppServerClient } from "./app-server/client.js";
import { CodexAppServerSupervisor } from "./app-server/supervisor.js";
import { AttachmentDispatcher } from "./attachments/dispatcher.js";
import { AttachmentServer } from "./attachments/server.js";
import { CodexFeishuBridge } from "./bridge/codex-feishu-bridge.js";
import { CommandRouter } from "./commands/index.js";
import { runSendCommand } from "./commands/send.js";
import { formatDoctor, runDoctor } from "./commands/doctor.js";
import { installUserService } from "./commands/install-service.js";
import {
  type AppConfig,
  ConfigFile,
  resolveConfigPath,
  ServiceHotReloader,
} from "./config/index.js";
import { FeishuClient } from "./feishu/client.js";
import { ensureJsonConfig } from "./feishu/setup.js";
import { SessionManager } from "./session/manager.js";
import { SqliteSessionStore } from "./session/sqlite-store.js";
import { SqliteSchedulerStore } from "./scheduler/sqlite-store.js";
import { TaskScheduler } from "./scheduler/service.js";
import { Logger } from "./utils/logger.js";
import { VERSION_OUTPUT } from "./version.js";
import { JsonWorkspaceStore } from "./workspace/json-store.js";
import { WorkspaceRegistry } from "./workspace/registry.js";
import { LocalCodexCatalog } from "./codex-local/catalog.js";
import { LocalSyncStore } from "./codex-local/sync-store.js";
import { LocalCodexSyncService } from "./codex-local/sync-service.js";
import { LocalApprovalBroker } from "./codex-local/approval-broker.js";
import { brokerStatePath, runPermissionHook } from "./codex-local/hook-cli.js";
import { installCodexPermissionHook, uninstallCodexPermissionHook } from "./codex-local/hook-installer.js";

interface RunningService {
  stop(): Promise<void>;
}

async function startService(config: AppConfig, configFile: ConfigFile): Promise<RunningService> {
  const logger = new Logger(config.logLevel);
  const feishu = new FeishuClient(config.feishu);
  const appServerClient = new CodexAppServerClient({
    command: config.codex.command,
    args: config.codex.args,
    cwd: config.codex.workingDirectory,
    requestTimeoutMs: config.codex.requestTimeoutMs,
  });
  const appServer = new CodexAppServerSupervisor(appServerClient);
  const sessionStore = new SqliteSessionStore(config.sessionDatabasePath);
  const schedulerStore = config.scheduler.enabled ? new SqliteSchedulerStore(config.sessionDatabasePath) : undefined;
  const attachmentDispatcher = config.attachments.enabled
    ? new AttachmentDispatcher(feishu, { maxFileBytes: config.attachments.maxFileBytes })
    : undefined;
  const attachmentServer = attachmentDispatcher ? new AttachmentServer(attachmentDispatcher) : undefined;
  let localSyncStore: LocalSyncStore | undefined;
  let localSync: LocalCodexSyncService | undefined;
  let approvalBroker: LocalApprovalBroker | undefined;
  let bridge: CodexFeishuBridge | undefined;
  try {
    const attachmentEndpoint = await attachmentServer?.start();
    const workspaceStore = new JsonWorkspaceStore(configFile);
    const workspaces = new WorkspaceRegistry(workspaceStore, {
      allowedRoots: config.codex.allowedRoots,
      adminOpenIds: config.adminOpenIds,
      defaultPath: config.codex.workingDirectory,
    });
    await workspaces.initialize();
    const localCatalog = config.codex.localDiscoveryEnabled
      ? new LocalCodexCatalog(config.codex.localStateDatabasePath)
      : undefined;
    localSyncStore = config.localSync.enabled && localCatalog
      ? new LocalSyncStore(config.sessionDatabasePath)
      : undefined;
    localSync = localSyncStore && localCatalog
      ? new LocalCodexSyncService(
        localSyncStore,
        localCatalog,
        feishu,
        logger,
        config.localSync.pollIntervalMs,
      )
      : undefined;
    const sessions = new SessionManager(sessionStore, appServer, {
      cwd: config.codex.workingDirectory,
      model: config.codex.model,
      reasoningEffort: config.codex.reasoningEffort,
      idleResetMs: config.sessions.idleResetMs,
    }, localCatalog);
    appServer.onRecovered(async () => {
      const recovered = await sessions.recoverAfterServerRestart();
      logger.info(`Codex App Server recovered ${recovered.length} persisted thread(s)`);
    });
    const scheduler = schedulerStore ? new TaskScheduler(
      schedulerStore,
      (task) => bridge!.enqueueScheduledPrompt(task),
      config.scheduler,
    ) : undefined;
    const commands = new CommandRouter(sessions, appServer, workspaces, scheduler, localSync);
    approvalBroker = localSync ? new LocalApprovalBroker(
      feishu,
      localSync,
      brokerStatePath(config),
      logger,
      config.localSync.approvalTimeoutMs,
    ) : undefined;
    bridge = new CodexFeishuBridge(feishu, appServer, sessions, commands, logger, {
      maxQueuedPerChat: config.maxQueuedPerChat,
      attachmentDispatcher,
      attachmentEndpoint,
      groupSessionMode: config.sessions.groupMode,
      turnDeadlineMs: config.runtime.turnDeadlineMs,
      turnInterruptGraceMs: config.runtime.turnInterruptGraceMs,
      externalCardActionHandler: (action) => approvalBroker?.handleCardAction(action) ?? Promise.resolve(false),
      onManagedTurnStart: (threadId) => localSync?.beginManagedTurn(threadId),
      onManagedTurnFinished: (threadId) => localSync?.endManagedTurn(threadId) ?? Promise.resolve(),
    });
    await bridge.start();
    localSync?.start();
    await approvalBroker?.start();
    await scheduler?.start();
    const adminServer = config.admin.enabled ? new AdminServer({
      port: config.admin.port,
      token: config.admin.authToken ?? randomBytes(24).toString("base64url"),
      status: async () => ({
        appServer: appServer.getStatus(),
        feishu: feishu.getStatus(),
        projects: await workspaces.list(),
        sessions: await sessions.listAll(),
        scheduledTasks: await scheduler?.list() ?? [],
        config: redactConfig(config.json),
      }),
      mutate: async (action, body) => {
        const id = typeof body.id === "string" ? body.id : "";
        if (action === "pause-task") return scheduler?.pause(id, "web-admin", true);
        if (action === "resume-task") return scheduler?.resume(id, "web-admin", true);
        if (action === "remove-task") { await scheduler?.remove(id, "web-admin", true); return { ok: true }; }
        if (action === "switch-session") {
          const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
          const selector = typeof body.selector === "string" ? body.selector : "";
          return sessions.switchSaved(conversationId, selector);
        }
        throw new Error("unknown_action");
      },
    }) : undefined;
    let admin;
    try {
      admin = await adminServer?.start();
    } catch (error) {
      await scheduler?.stop();
      localSync?.stop();
      await approvalBroker?.stop();
      await bridge?.stop();
      throw error;
    }
    if (admin) logger.info(`Local admin: ${admin.endpoint}/#token=${admin.token}`);
    let stopped = false;
    logger.info("codex-feishu service started");
    return {
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await scheduler?.stop();
          localSync?.stop();
          await approvalBroker?.stop();
          await adminServer?.stop();
          await bridge?.stop();
        } finally {
          try {
            await attachmentServer?.stop();
          } finally {
            sessionStore.close();
            schedulerStore?.close();
            localSyncStore?.close();
          }
        }
      },
    };
  } catch (error) {
    attachmentDispatcher?.revokeAll();
    localSync?.stop();
    await approvalBroker?.stop().catch(() => {});
    await bridge?.stop().catch(() => {});
    await attachmentServer?.stop().catch(() => {});
    sessionStore.close();
    schedulerStore?.close();
    localSyncStore?.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION_OUTPUT);
    return;
  }
  if (args[0] === "send") {
    await runSendCommand(args.slice(1));
    return;
  }
  const configFile = new ConfigFile(resolveConfigPath());
  if (args[0] === "hook" && args[1] === "permission") {
    await runPermissionHook(await configFile.load());
    return;
  }
  if (args[0] === "install-codex-hook") {
    await configFile.load();
    const result = await installCodexPermissionHook(configFile.path);
    console.log(result.changed
      ? `Codex PermissionRequest hook 已安装：${result.path}`
      : `Codex PermissionRequest hook 已存在：${result.path}`);
    return;
  }
  if (args[0] === "uninstall-codex-hook") {
    await configFile.load();
    const result = await uninstallCodexPermissionHook(configFile.path);
    console.log(result.changed
      ? `Codex PermissionRequest hook 已移除：${result.path}`
      : `未找到当前配置对应的 Codex PermissionRequest hook：${result.path}`);
    return;
  }
  if (args[0] === "doctor") {
    const checks = await runDoctor(await configFile.load());
    console.log(formatDoctor(checks));
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }
  if (args[0] === "install-service") {
    await configFile.load();
    const result = await installUserService(configFile.path);
    console.log(`服务文件已写入：${result.path}\n启用命令：${result.next}`);
    return;
  }
  const initialConfig = await ensureJsonConfig(configFile);
  const initialService = await startService(initialConfig, configFile);
  const reloader = new ServiceHotReloader(
    initialConfig,
    initialService,
    (config) => startService(config, configFile),
    fingerprint,
  );
  let shuttingDown = false;

  const stopWatching = configFile.watch((nextConfig) => {
    if (shuttingDown) return;
    void reloader.reload(nextConfig).then(async (result) => {
      if (result.status === "reloaded") {
        console.log(`${new Date().toISOString()} INFO Configuration hot reload completed`);
      }
      if (result.status === "rolled_back") {
        console.error(`${new Date().toISOString()} ERROR New configuration failed; rolled back`, result.error);
        await configFile.save(result.config.json);
      }
    }).catch((error: unknown) => {
      console.error(`${new Date().toISOString()} ERROR Configuration reload failed`, error);
    });
  }, (error) => {
    console.error(`${new Date().toISOString()} ERROR Ignoring invalid configuration update`, error.message);
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWatching();
    await reloader.stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function fingerprint(config: AppConfig): string {
  const { projects: _projects, ...workspace } = config.json.workspace;
  return JSON.stringify({ ...config.json, workspace });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
