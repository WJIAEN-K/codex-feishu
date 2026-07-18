import { homedir } from "node:os";
import { join } from "node:path";

import { RuntimeUnsupportedPlatformError } from "./errors.js";

export function resolveTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
  throw new RuntimeUnsupportedPlatformError(platform, arch);
}

/** Whether this host has a published, automatically downloadable Runtime build. */
export function supportsRuntimeDownload(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  return (platform === "darwin" || platform === "win32") && (arch === "arm64" || arch === "x64");
}

export function resolveManagedRuntimeDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "codex-feishu", "runtime");
  }
  if (platform === "win32") {
    const localAppData = getEnv(env, "LOCALAPPDATA");
    if (!localAppData) throw new Error("LOCALAPPDATA is unavailable");
    return join(localAppData, "codex-feishu", "runtime");
  }
  return join(homeDirectory, ".local", "share", "codex-feishu", "runtime");
}

export function runtimeExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "codex.exe" : "codex";
}

export function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}
