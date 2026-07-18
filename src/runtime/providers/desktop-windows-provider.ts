import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { getEnv } from "../paths.js";
import type { RuntimeCandidate, RuntimeProvider } from "../types.js";

const execFileAsync = promisify(execFile);

export class WindowsDesktopRuntimeProvider implements RuntimeProvider {
  readonly name = "desktop-windows";

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly options: { includeUserPaths?: boolean; includeStorePaths?: boolean } = {},
  ) {}

  async discover(): Promise<RuntimeCandidate[]> {
    const localAppData = getEnv(this.env, "LOCALAPPDATA");
    const paths = this.options.includeUserPaths !== false && localAppData ? [
      join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
      join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
      join(localAppData, "Programs", "ChatGPT", "resources", "codex.exe"),
    ] : [];
    if (this.options.includeStorePaths !== false) paths.push(...await this.discoverStorePaths());

    const candidates: RuntimeCandidate[] = [];
    for (const executablePath of new Set(paths)) {
      if (await isFile(executablePath)) {
        candidates.push({
          source: "desktop-bundled",
          executablePath,
          metadata: { windowsStore: executablePath.toLowerCase().includes("windowsapps") },
        });
      }
    }
    return candidates;
  }

  private async discoverStorePaths(): Promise<string[]> {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$packages = @(Get-AppxPackage OpenAI.Codex*) + @(Get-AppxPackage OpenAI.ChatGPT*)",
      "$packages | Select-Object -ExpandProperty InstallLocation | ConvertTo-Json -Compress",
    ].join("; ");
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
      ], { env: this.env, timeout: 8_000, windowsHide: true, maxBuffer: 256 * 1024 });
      const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : [];
      const locations = typeof parsed === "string" ? [parsed] : Array.isArray(parsed) ? parsed : [];
      return locations.filter((value): value is string => typeof value === "string" && Boolean(value))
        .flatMap((location) => [
          join(location, "app", "resources", "codex.exe"),
          join(location, "resources", "codex.exe"),
          join(location, "app", "resources", "bin", "codex.exe"),
        ]);
    } catch {
      return [];
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
