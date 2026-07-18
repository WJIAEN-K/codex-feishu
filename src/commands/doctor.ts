import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { CodexAppServerClient } from "../app-server/client.js";
import type { GetAccountResponse } from "../app-server/generated/v2/GetAccountResponse.js";
import { formatAccount } from "../auth/bootstrap.js";
import type { AppConfig } from "../config/index.js";
import { createRuntimeServices } from "../runtime/factory.js";
import type { ResolvedRuntime, RuntimeCandidate } from "../runtime/types.js";

export interface DoctorCheck { name: string; ok: boolean; detail: string }

interface DoctorRuntimeManager {
  discoverCandidates(): Promise<RuntimeCandidate[]>;
  resolve(): Promise<ResolvedRuntime>;
}

export interface DoctorDependencies {
  manager?: DoctorRuntimeManager;
  inspectAccount?: (runtime: ResolvedRuntime, config: AppConfig) => Promise<GetAccountResponse>;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

export async function runDoctor(
  config: AppConfig,
  dependencies: DoctorDependencies = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js", ok: major >= 20, detail: process.version });
  checks.push({ name: "操作系统", ok: platform === "darwin" || platform === "win32" || platform === "linux", detail: platform });
  checks.push({ name: "架构", ok: arch === "arm64" || arch === "x64", detail: arch });

  const manager = dependencies.manager ?? createRuntimeServices(config, { autoDownload: false }).manager;
  let candidates: RuntimeCandidate[] = [];
  try {
    candidates = await manager.discoverCandidates();
  } catch (error) {
    checks.push({ name: "Runtime 候选", ok: false, detail: errorMessage(error) });
  }
  if (!checks.some((check) => check.name === "Runtime 候选")) {
    checks.push({
      name: "Runtime 候选",
      ok: candidates.length > 0,
      detail: candidates.length ? candidates.map((candidate) => `${candidate.source}:${candidate.executablePath}`).join("; ") : "未发现",
    });
  }
  const desktop = candidates.filter((candidate) => candidate.source === "desktop-bundled");
  checks.push({ name: "桌面客户端 Runtime", ok: desktop.length > 0, detail: desktop[0]?.executablePath ?? "未发现" });

  let runtime: ResolvedRuntime | undefined;
  try {
    runtime = await manager.resolve();
    checks.push({ name: "已选 Runtime", ok: true, detail: `${runtime.source}:${runtime.executablePath}` });
    checks.push({ name: "Runtime 版本", ok: true, detail: runtime.version });
    checks.push({
      name: "App Server 握手",
      ok: runtime.verification.initializeSucceeded,
      detail: runtime.verification.initializeSucceeded ? "initialize/initialized 成功" : runtime.verification.reason ?? "失败",
    });
  } catch (error) {
    const detail = errorMessage(error);
    checks.push({ name: "已选 Runtime", ok: false, detail });
    checks.push({ name: "Runtime 版本", ok: false, detail: "不可用" });
    checks.push({ name: "App Server 握手", ok: false, detail });
  }

  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  checks.push({ name: "CODEX_HOME", ok: true, detail: codexHome });
  if (runtime) {
    try {
      const account = await (dependencies.inspectAccount ?? inspectAccount)(runtime, config);
      checks.push({ name: "Codex 认证", ok: Boolean(account.account) || !account.requiresOpenaiAuth, detail: formatAccount(account.account) });
    } catch (error) {
      checks.push({ name: "Codex 认证", ok: false, detail: errorMessage(error) });
    }
  } else {
    checks.push({ name: "Codex 认证", ok: false, detail: "Runtime 不可用" });
  }

  try {
    await access(config.codex.workingDirectory, constants.R_OK | constants.W_OK);
    checks.push({ name: "默认工作区", ok: true, detail: config.codex.workingDirectory });
  } catch (error) { checks.push({ name: "默认工作区", ok: false, detail: errorMessage(error) }); }
  try {
    await access(dirname(config.sessionDatabasePath), constants.R_OK | constants.W_OK);
    const database = new Database(config.sessionDatabasePath);
    database.prepare("SELECT 1").get();
    database.close();
    checks.push({ name: "SQLite", ok: true, detail: config.sessionDatabasePath });
  } catch (error) { checks.push({ name: "SQLite", ok: false, detail: errorMessage(error) }); }
  checks.push({
    name: "飞书配置",
    ok: Boolean(config.feishu.appId && config.feishu.appSecret),
    detail: config.feishu.appId ? `${config.feishu.domain}:${config.feishu.appId}` : "缺少凭据",
  });
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}：${check.detail}`).join("\n");
}

async function inspectAccount(runtime: ResolvedRuntime, config: AppConfig): Promise<GetAccountResponse> {
  const client = new CodexAppServerClient({
    command: runtime.executablePath,
    args: ["app-server", "--stdio"],
    cwd: config.codex.workingDirectory,
    requestTimeoutMs: Math.min(config.codex.requestTimeoutMs, 15_000),
  });
  try {
    await client.start();
    return await client.request<GetAccountResponse>("account/read", { refreshToken: false });
  } finally {
    await client.stop().catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
