import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

import Database from "better-sqlite3";

import type { AppConfig } from "../config/index.js";

export interface DoctorCheck { name: string; ok: boolean; detail: string }

export async function runDoctor(config: AppConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js", ok: major >= 20, detail: process.version });
  const version = await command(config.codex.command, ["--version"]);
  checks.push({ name: "Codex CLI", ok: version.ok, detail: version.output });
  const login = await command(config.codex.command, ["login", "status"]);
  checks.push({ name: "Codex 登录", ok: login.ok, detail: login.output });
  try {
    await access(config.codex.workingDirectory, constants.R_OK | constants.W_OK);
    checks.push({ name: "默认工作区", ok: true, detail: config.codex.workingDirectory });
  } catch (error) { checks.push({ name: "默认工作区", ok: false, detail: String(error) }); }
  try {
    await access(dirname(config.sessionDatabasePath), constants.R_OK | constants.W_OK);
    const database = new Database(config.sessionDatabasePath); database.prepare("SELECT 1").get(); database.close();
    checks.push({ name: "SQLite", ok: true, detail: config.sessionDatabasePath });
  } catch (error) { checks.push({ name: "SQLite", ok: false, detail: String(error) }); }
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

function command(executable: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill(), 10_000); timer.unref();
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: error.message }); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim().slice(0, 500) || `退出码 ${code}` }); });
  });
}
