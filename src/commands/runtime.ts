import type { AppConfig, ConfigFile } from "../config/index.js";
import { createRuntimeServices } from "../runtime/factory.js";
import type { ResolvedRuntime } from "../runtime/types.js";

export async function runRuntimeCommand(
  configFile: ConfigFile,
  config: AppConfig,
  args: string[],
): Promise<string> {
  const action = args[0]?.toLowerCase() ?? "status";
  if (action === "use") {
    const mode = args[1]?.toLowerCase();
    if (mode !== "desktop" && mode !== "managed" && mode !== "auto") {
      throw new Error("用法：codex-feishu runtime use desktop|managed|auto");
    }
    await configFile.update((json) => { json.runtime.mode = mode; });
    return `Runtime 模式已切换为：${mode}`;
  }

  const services = createRuntimeServices(config);
  if (action === "status") return formatResolvedRuntime(await services.manager.resolve());
  if (action === "install") return formatResolvedRuntime(await services.downloader.installLatest(config.runtime.updateChannel));
  if (action === "update") {
    const update = await services.downloader.checkForUpdates(config.runtime.updateChannel);
    if (!update) return "Managed Runtime 已是最新版本";
    return formatResolvedRuntime(await services.downloader.installLatest(config.runtime.updateChannel));
  }
  if (action === "rollback") return formatResolvedRuntime(await services.downloader.rollback());
  throw new Error("用法：codex-feishu runtime status|install|update|rollback|use");
}

export function formatResolvedRuntime(runtime: ResolvedRuntime): string {
  return [
    "Codex Runtime",
    `来源：${runtime.source}`,
    `版本：${runtime.version}`,
    `路径：${runtime.executablePath}`,
    `App Server：${runtime.verification.initializeSucceeded ? "可用" : "不可用"}`,
    `账户 API：${runtime.verification.accountReadSucceeded ? "可用" : "不可用"}`,
  ].join("\n");
}
