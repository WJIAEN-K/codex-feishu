import { registerApp } from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";

import {
  type AppConfig,
  ConfigFile,
  prepareJsonConfig,
} from "../config/index.js";
import { loadLegacyEnvironment, migrateLegacyEnvironment } from "../config/legacy.js";

type RegisterApp = typeof registerApp;

export interface EnsureJsonConfigOptions {
  interactive?: boolean;
  cwd?: string;
  register?: RegisterApp;
  renderQrCode?: (url: string) => string;
  writeLine?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function ensureJsonConfig(
  configFile: ConfigFile,
  options: EnsureJsonConfigOptions = {},
): Promise<AppConfig> {
  const raw = await configFile.readOptional();
  const draft = prepareJsonConfig(raw, options.cwd ?? process.cwd());
  const appId = typeof draft.feishu.appId === "string" ? draft.feishu.appId.trim() : "";
  const appSecret = typeof draft.feishu.appSecret === "string" ? draft.feishu.appSecret.trim() : "";
  if (appId && appSecret) return configFile.load();

  const writeLine = options.writeLine ?? ((message: string) => console.log(message));
  const cwd = options.cwd ?? process.cwd();
  const migration = migrateLegacyEnvironment(
    draft,
    cwd,
    await loadLegacyEnvironment(cwd, options.env ?? process.env),
  );
  if (migration) {
    await configFile.save(migration.config);
    writeLine(
      `已将旧环境变量迁移到 JSON 配置，并导入 ${migration.migratedProjects} 个项目；旧数据保持不变。`,
    );
    for (const warning of migration.warnings) writeLine(`警告：${warning}`);
    return configFile.load();
  }
  if (appId || appSecret) throw new Error("feishu.appId 和 feishu.appSecret 必须同时配置");

  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error(
      `配置文件缺少飞书凭证：${configFile.path}。请在交互式终端运行 codex-feishu 完成扫码配置。`,
    );
  }

  const renderQrCode = options.renderQrCode ?? renderTerminalQrCode;
  writeLine("未检测到飞书机器人凭证，正在启动扫码配置……");
  const initialDomain = draft.feishu.domain === "lark" ? "lark" : "feishu";
  const result = await (options.register ?? registerApp)({
    domain: initialDomain === "lark" ? "accounts.larksuite.com" : "accounts.feishu.cn",
    larkDomain: "accounts.larksuite.com",
    source: "codex-feishu",
    appPreset: {
      name: "Codex 飞书助手",
      desc: "在飞书中使用 Codex 完成软件开发任务",
    },
    onQRCodeReady({ url, expireIn }) {
      writeLine("");
      writeLine("请使用飞书扫描下面的二维码完成机器人创建和权限配置：");
      writeLine(renderQrCode(url));
      writeLine(`也可以在浏览器打开：${url}`);
      writeLine(`链接将在 ${expireIn} 秒后过期。`);
      writeLine("");
    },
    onStatusChange({ status }) {
      if (status === "slow_down") writeLine("仍在等待扫码确认……");
      if (status === "domain_switched") writeLine("已自动切换到 Lark 授权页面。");
    },
  });

  draft.feishu.appId = result.client_id;
  draft.feishu.appSecret = result.client_secret;
  draft.feishu.domain = result.user_info?.tenant_brand ?? initialDomain;
  if (draft.feishu.adminOpenIds.length === 0 && result.user_info?.open_id) {
    draft.feishu.adminOpenIds = [result.user_info.open_id];
  }
  await configFile.save(draft);
  writeLine(`飞书机器人配置完成，配置已安全保存到 ${configFile.path}`);
  return configFile.load();
}

export function renderTerminalQrCode(url: string): string {
  let rendered = "";
  qrcode.generate(url, { small: true }, (value) => { rendered = value; });
  return rendered;
}
