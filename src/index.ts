#!/usr/bin/env node
import "dotenv/config";

import { CodexAppServerClient } from "./app-server/client.js";
import { CodexFeishuBridge } from "./bridge/codex-feishu-bridge.js";
import { CommandRouter } from "./commands/index.js";
import { loadConfig } from "./config/index.js";
import { FeishuClient } from "./feishu/client.js";
import { SessionManager } from "./session/manager.js";
import { SqliteSessionStore } from "./session/sqlite-store.js";
import { Logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
  }

  const feishu = new FeishuClient(config.feishu);
  const appServer = new CodexAppServerClient({
    command: config.codex.command,
    args: config.codex.args,
    cwd: config.codex.workingDirectory,
    requestTimeoutMs: config.codex.requestTimeoutMs,
  });
  const sessionStore = new SqliteSessionStore(config.sessionDatabasePath);
  const sessions = new SessionManager(sessionStore, appServer, {
    cwd: config.codex.workingDirectory,
    model: config.codex.model,
    reasoningEffort: config.codex.reasoningEffort,
  });
  const commands = new CommandRouter(sessions, appServer);
  const bridge = new CodexFeishuBridge(feishu, appServer, sessions, commands, logger);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutting down");
    try {
      await bridge.stop();
    } finally {
      sessionStore.close();
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await bridge.start();
  logger.info("codex-feishu service started");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
