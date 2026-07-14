import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import Database from "better-sqlite3";
import { parse } from "dotenv";

import { prepareJsonConfig, type JsonAppConfig, type JsonProjectConfig } from "./file.js";

interface LegacyWorkspaceRow {
  alias: string;
  path: string;
  enabled: number;
  created_by: string;
  created_at: number;
}

export interface LegacyMigrationResult {
  config: JsonAppConfig;
  migratedProjects: number;
  warnings: string[];
}

export async function loadLegacyEnvironment(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  let fileEnvironment: NodeJS.ProcessEnv = {};
  try {
    fileEnvironment = parse(await readFile(join(cwd, ".env")));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  // Explicit process environment values keep their usual precedence over .env.
  return { ...fileEnvironment, ...env };
}

export function migrateLegacyEnvironment(
  draft: JsonAppConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
): LegacyMigrationResult | null {
  const appId = optional(env, "FEISHU_APP_ID") ?? draft.feishu.appId;
  const appSecret = optional(env, "FEISHU_APP_SECRET") ?? draft.feishu.appSecret;
  if (!appId && !appSecret) return null;
  if (!appId || !appSecret) {
    throw new Error("旧环境变量中的 FEISHU_APP_ID 和 FEISHU_APP_SECRET 必须同时配置");
  }

  const configuredCwd = optional(env, "CODEX_WORKING_DIRECTORY") ?? draft.workspace.defaultPath;
  const workingDirectory = absolute(configuredCwd, "CODEX_WORKING_DIRECTORY");
  const configuredRoots = commaSeparated(env, "CODEX_ALLOWED_ROOTS");
  const allowedRoots = (configuredRoots.length > 0 ? configuredRoots : draft.workspace.allowedRoots)
    .map((path) => absolute(path, "CODEX_ALLOWED_ROOTS"));
  const configuredDatabasePath = optional(env, "CODEX_SESSION_DB_PATH");
  const databasePath = configuredDatabasePath
    ? resolve(cwd, configuredDatabasePath)
    : draft.storage.sessionDatabasePath;
  const projects = { ...draft.workspace.projects };
  const warnings: string[] = [];
  let migratedProjects = 0;

  try {
    for (const [alias, project] of Object.entries(readLegacyWorkspaces(databasePath))) {
      if (alias === "default" || projects[alias]) continue;
      projects[alias] = project;
      migratedProjects += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`无法从旧 SQLite 导入项目列表：${message}`);
  }

  const domain = optional(env, "FEISHU_DOMAIN") ?? draft.feishu.domain;
  const requestTimeout = positiveInteger(
    optional(env, "CODEX_REQUEST_TIMEOUT_MS"),
    draft.codex.requestTimeoutMs,
    "CODEX_REQUEST_TIMEOUT_MS",
  );
  const adminOpenIds = commaSeparated(env, "FEISHU_ADMIN_OPEN_IDS");
  const migrated = prepareJsonConfig({
    ...draft,
    feishu: {
      ...draft.feishu,
      appId,
      appSecret,
      domain,
      encryptKey: optional(env, "FEISHU_ENCRYPT_KEY") ?? draft.feishu.encryptKey,
      verificationToken: optional(env, "FEISHU_VERIFICATION_TOKEN") ?? draft.feishu.verificationToken,
      adminOpenIds: adminOpenIds.length > 0 ? adminOpenIds : draft.feishu.adminOpenIds,
    },
    codex: {
      ...draft.codex,
      command: optional(env, "CODEX_COMMAND") ?? draft.codex.command,
      model: optional(env, "CODEX_MODEL") ?? draft.codex.model,
      reasoningEffort: optional(env, "CODEX_REASONING_EFFORT") ?? draft.codex.reasoningEffort,
      requestTimeoutMs: requestTimeout,
    },
    workspace: {
      defaultPath: workingDirectory,
      allowedRoots,
      projects,
    },
    storage: { sessionDatabasePath: databasePath },
    runtime: {
      logLevel: optional(env, "LOG_LEVEL") ?? draft.runtime.logLevel,
    },
  }, cwd);

  return { config: migrated, migratedProjects, warnings };
}

function readLegacyWorkspaces(databasePath: string): Record<string, JsonProjectConfig> {
  if (!existsSync(databasePath)) return {};
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'",
    ).get();
    if (!table) return {};
    const rows = database.prepare(
      "SELECT alias, path, enabled, created_by, created_at FROM workspaces",
    ).all() as LegacyWorkspaceRow[];
    return Object.fromEntries(rows
      .filter((row) => row.alias !== "default" && isAbsolute(row.path))
      .map((row) => [row.alias, {
        path: resolve(row.path),
        enabled: row.enabled === 1,
        createdBy: row.created_by,
        createdAt: row.created_at,
      }]));
  } finally {
    database.close();
  }
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function commaSeparated(env: NodeJS.ProcessEnv, name: string): string[] {
  return (optional(env, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function absolute(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`);
  return resolve(value);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
