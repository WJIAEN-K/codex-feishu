import { isAbsolute, resolve } from "node:path";

import type { FeishuConfig } from "../types.js";

export interface AppConfig {
  feishu: FeishuConfig;
  codex: {
    command: string;
    args: string[];
    workingDirectory: string;
    model?: string;
    reasoningEffort?: string;
    requestTimeoutMs: number;
  };
  logLevel: "debug" | "info" | "warn" | "error";
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function positiveInteger(name: string, fallback: number): number {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const domain = optional("FEISHU_DOMAIN") ?? "feishu";
  if (domain !== "feishu" && domain !== "lark") {
    throw new Error("FEISHU_DOMAIN must be either feishu or lark");
  }

  const configuredCwd = optional("CODEX_WORKING_DIRECTORY") ?? process.cwd();
  const workingDirectory = resolve(configuredCwd);
  if (!isAbsolute(workingDirectory)) {
    throw new Error("CODEX_WORKING_DIRECTORY must be an absolute path");
  }

  const logLevel = optional("LOG_LEVEL") ?? "info";
  if (!(["debug", "info", "warn", "error"] as const).includes(logLevel as never)) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }

  return {
    feishu: {
      appId: optional("FEISHU_APP_ID") ?? "",
      appSecret: optional("FEISHU_APP_SECRET") ?? "",
      domain,
      encryptKey: optional("FEISHU_ENCRYPT_KEY"),
      verificationToken: optional("FEISHU_VERIFICATION_TOKEN"),
    },
    codex: {
      command: optional("CODEX_COMMAND") ?? "codex",
      args: ["app-server", "--stdio"],
      workingDirectory,
      model: optional("CODEX_MODEL"),
      reasoningEffort: optional("CODEX_REASONING_EFFORT"),
      requestTimeoutMs: positiveInteger("CODEX_REQUEST_TIMEOUT_MS", 120_000),
    },
    logLevel: logLevel as AppConfig["logLevel"],
  };
}
