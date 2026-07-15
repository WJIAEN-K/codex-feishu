#!/usr/bin/env node

import { CodexAppServerClient } from "./app-server/client.js";
import { CodexAppServerSupervisor } from "./app-server/supervisor.js";
import { CodexFeishuBridge } from "./bridge/codex-feishu-bridge.js";
import { CommandRouter } from "./commands/index.js";
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
import { Logger } from "./utils/logger.js";
import { JsonWorkspaceStore } from "./workspace/json-store.js";
import { WorkspaceRegistry } from "./workspace/registry.js";

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
  try {
    const workspaceStore = new JsonWorkspaceStore(configFile);
    const workspaces = new WorkspaceRegistry(workspaceStore, {
      allowedRoots: config.codex.allowedRoots,
      adminOpenIds: config.adminOpenIds,
      defaultPath: config.codex.workingDirectory,
    });
    await workspaces.initialize();
    const sessions = new SessionManager(sessionStore, appServer, {
      cwd: config.codex.workingDirectory,
      model: config.codex.model,
      reasoningEffort: config.codex.reasoningEffort,
    });
    appServer.onRecovered(async () => {
      const recovered = await sessions.recoverAfterServerRestart();
      logger.info(`Codex App Server recovered ${recovered.length} persisted thread(s)`);
    });
    const commands = new CommandRouter(sessions, appServer, workspaces);
    const bridge = new CodexFeishuBridge(feishu, appServer, sessions, commands, logger, {
      maxQueuedPerChat: config.maxQueuedPerChat,
    });
    await bridge.start();
    let stopped = false;
    logger.info("codex-feishu service started");
    return {
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await bridge.stop();
        } finally {
          sessionStore.close();
        }
      },
    };
  } catch (error) {
    sessionStore.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const configFile = new ConfigFile(resolveConfigPath());
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
