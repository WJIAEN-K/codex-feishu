import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export async function installUserService(configPath: string): Promise<{ path: string; next: string }> {
  const executable = process.execPath;
  const entry = process.argv[1];
  if (!entry) throw new Error("无法确定 codex-feishu 入口文件");
  if (process.platform === "darwin") {
    const path = join(homedir(), "Library/LaunchAgents/com.codex-feishu.plist");
    const log = join(homedir(), "Library/Logs/codex-feishu.log");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.codex-feishu</string><key>ProgramArguments</key><array><string>${escapeXml(executable)}</string><string>${escapeXml(entry)}</string><string>--config</string><string>${escapeXml(configPath)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${escapeXml(log)}</string><key>StandardErrorPath</key><string>${escapeXml(log)}</string></dict></plist>\n`;
    await write(path, xml);
    return { path, next: `launchctl bootstrap gui/$(id -u) ${JSON.stringify(path)}` };
  }
  if (process.platform === "linux") {
    const path = join(homedir(), ".config/systemd/user/codex-feishu.service");
    const unit = `[Unit]\nDescription=codex-feishu service\nAfter=network-online.target\n\n[Service]\nExecStart=${quoteSystemd(executable)} ${quoteSystemd(entry)} --config ${quoteSystemd(configPath)}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
    await write(path, unit);
    return { path, next: "systemctl --user daemon-reload && systemctl --user enable --now codex-feishu" };
  }
  throw new Error("install-service 当前支持 macOS 与 Linux");
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
const escapeXml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
const quoteSystemd = (value: string): string => `"${value.replace(/[\\"]/g, "\\$&")}"`;
