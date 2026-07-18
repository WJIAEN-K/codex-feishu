import type { AppConfig } from "../config/index.js";
import { RuntimeDownloader } from "./downloader.js";
import { RuntimeManager } from "./manager.js";
import { resolveManagedRuntimeDir } from "./paths.js";
import { RuntimeVerifier } from "./verifier.js";

export interface RuntimeServices {
  manager: RuntimeManager;
  downloader: RuntimeDownloader;
  managedRuntimeDir: string;
}

export function createRuntimeServices(
  config: AppConfig,
  overrides: { autoDownload?: boolean } = {},
): RuntimeServices {
  const managedRuntimeDir = config.runtime.managedRuntimeDirectory ?? resolveManagedRuntimeDir();
  const verifier = new RuntimeVerifier();
  const downloader = new RuntimeDownloader({ managedRuntimeDir, verifier });
  const legacyConfiguredPath = config.codex.command !== "codex" ? config.codex.command : undefined;
  const manager = new RuntimeManager({
    mode: config.runtime.mode,
    configuredPath: config.runtime.executablePath ?? legacyConfiguredPath,
    autoDownload: overrides.autoDownload ?? config.runtime.autoDownload,
    allowDesktopRuntime: config.runtime.allowDesktopRuntime,
    updateChannel: config.runtime.updateChannel,
    managedRuntimeDir,
    preferManagedRuntimeOnWindows: config.runtime.preferManagedRuntimeOnWindows,
  }, { verifier, installer: downloader });
  return { manager, downloader, managedRuntimeDir };
}
