import type { JsonAppConfig } from "../config/index.js";

export function redactConfig(config: JsonAppConfig): JsonAppConfig {
  const copy = structuredClone(config);
  copy.feishu.appSecret = "***";
  if (copy.feishu.encryptKey) copy.feishu.encryptKey = "***";
  if (copy.feishu.verificationToken) copy.feishu.verificationToken = "***";
  if (copy.admin.authToken) copy.admin.authToken = "***";
  return copy;
}
