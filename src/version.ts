import { createRequire } from "node:module";

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
}

const require = createRequire(import.meta.url);
const metadata = require("../package.json") as PackageMetadata;

if (typeof metadata.version !== "string" || metadata.version.length === 0) {
  throw new Error("无法从 package.json 读取 codex-feishu 版本");
}

export const PACKAGE_VERSION = metadata.version;
export const VERSION_OUTPUT = `codex-feishu ${PACKAGE_VERSION}`;
