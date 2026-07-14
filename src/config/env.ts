import { isAbsolute, join, resolve } from "node:path";

import type { FeishuConfig } from "../types.js";

export interface AppConfig {
  feishu: FeishuConfig;
  adminOpenIds: string[];
  codex: {
    command: string;
    args: string[];
    workingDirectory: string;
    model?: string;
    reasoningEffort?: string;
    requestTimeoutMs: number;
    allowedRoots: string[];
  };
  sessionDatabasePath: string;
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

function commaSeparated(name: string): string[] {
  return (optional(name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function absolutePaths(name: string, fallback: string[]): string[] {
  const values = commaSeparated(name);
  const paths = values.length > 0 ? values : fallback;
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`${name} must contain only absolute paths`);
  }
  return [...new Set(paths.map((path) => resolve(path)))];
}

export function loadConfig(): AppConfig {
  const domain = optional("FEISHU_DOMAIN") ?? "feishu";
  if (domain !== "feishu" && domain !== "lark") {
    throw new Error("FEISHU_DOMAIN must be either feishu or lark");
  }

  const configuredCwd = optional("CODEX_WORKING_DIRECTORY") ?? process.cwd();
  if (!isAbsolute(configuredCwd)) {
    throw new Error("CODEX_WORKING_DIRECTORY must be an absolute path");
  }
  const workingDirectory = resolve(configuredCwd);

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
    adminOpenIds: commaSeparated("FEISHU_ADMIN_OPEN_IDS"),
    codex: {
      command: optional("CODEX_COMMAND") ?? "codex",
      args: ["app-server", "--stdio"],
      workingDirectory,
      model: optional("CODEX_MODEL"),
      reasoningEffort: optional("CODEX_REASONING_EFFORT"),
      requestTimeoutMs: positiveInteger("CODEX_REQUEST_TIMEOUT_MS", 120_000),
      allowedRoots: absolutePaths("CODEX_ALLOWED_ROOTS", [workingDirectory]),
    },
    sessionDatabasePath: resolve(
      optional("CODEX_SESSION_DB_PATH") ?? join(process.cwd(), ".codex-feishu", "sessions.sqlite"),
    ),
    logLevel: logLevel as AppConfig["logLevel"],
  };
}
