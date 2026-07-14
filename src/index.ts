#!/usr/bin/env node
import "dotenv/config";

import { loadConfig } from "./config/index.js";
import { FeishuClient } from "./feishu/client.js";
import { Logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
  }

  const feishu = new FeishuClient(config.feishu);
  feishu.setOnStatusChange((status) => logger.info(`Feishu status: ${status}`));
  feishu.setOnMessage((chatId, messageId, text) => {
    logger.info("Received Feishu message", { chatId, messageId, text });
  });

  const shutdown = (): void => {
    logger.info("Shutting down");
    feishu.disconnect();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await feishu.connect();
  logger.info("codex-feishu service started");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
