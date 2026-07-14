import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { FeishuConfig } from "../types.js";
import type { LogLevel } from "../utils/logger.js";

export interface JsonProjectConfig {
  path: string;
  enabled?: boolean;
  createdBy?: string;
  createdAt?: number;
}

export interface JsonAppConfig {
  version: 1;
  feishu: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
    encryptKey?: string;
    verificationToken?: string;
    adminOpenIds: string[];
  };
  codex: {
    command: string;
    args: string[];
    model?: string;
    reasoningEffort?: string;
    requestTimeoutMs: number;
  };
  workspace: {
    defaultPath: string;
    allowedRoots: string[];
    projects: Record<string, JsonProjectConfig>;
  };
  storage: {
    sessionDatabasePath: string;
  };
  runtime: {
    logLevel: LogLevel;
  };
}

export interface AppConfig {
  feishu: FeishuConfig;
  adminOpenIds: string[];
  codex: {
    command: string;
    args: string[];
    workingDirectory: string;
    model?: string;
    reasoningEffort?: string;
    requestTimeoutMs: number;
    allowedRoots: string[];
  };
  sessionDatabasePath: string;
  logLevel: LogLevel;
  json: JsonAppConfig;
}

export class ConfigFile {
  private updateChain = Promise.resolve();
  private lastValid?: AppConfig;

  constructor(readonly path: string) {}

  async readOptional(): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw new Error(`配置文件不是有效 JSON：${this.path}`);
      throw error;
    }
  }

  async load(): Promise<AppConfig> {
    const raw = await this.readOptional();
    if (raw === null) throw new Error(`配置文件不存在：${this.path}`);
    const json = normalizeJsonConfig(raw, dirname(this.path), true);
    if (process.platform !== "win32") await chmod(this.path, 0o600);
    this.lastValid = toAppConfig(json);
    return this.lastValid;
  }

  async loadLatestOrLastValid(): Promise<AppConfig> {
    try {
      return await this.load();
    } catch (error) {
      if (this.lastValid) return this.lastValid;
      throw error;
    }
  }

  save(json: JsonAppConfig): Promise<void> {
    return this.enqueueUpdate(async () => {
      const normalized = normalizeJsonConfig(json, dirname(this.path), true);
      await writeJsonAtomic(this.path, normalized);
      this.lastValid = toAppConfig(normalized);
    });
  }

  update(mutator: (json: JsonAppConfig) => void): Promise<void> {
    return this.enqueueUpdate(async () => {
      const raw = await this.readOptional();
      if (raw === null) throw new Error(`配置文件不存在：${this.path}`);
      const json = normalizeJsonConfig(raw, dirname(this.path), true);
      const before = JSON.stringify(json);
      mutator(json);
      const normalized = normalizeJsonConfig(json, dirname(this.path), true);
      if (JSON.stringify(normalized) !== before) await writeJsonAtomic(this.path, normalized);
      this.lastValid = toAppConfig(normalized);
    });
  }

  watch(
    onConfig: (config: AppConfig) => void | Promise<void>,
    onError: (error: Error) => void,
    pollMs = 500,
  ): () => void {
    let closed = false;
    let checking = false;
    let previousContent = readFileSync(this.path, "utf8");
    const timer = setInterval(() => {
      if (closed || checking) return;
      checking = true;
      void readFile(this.path, "utf8").then(async (content) => {
        if (content === previousContent) return;
        previousContent = content;
        await onConfig(await this.load());
      }).catch((error: unknown) => {
        onError(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => { checking = false; });
    }, pollMs);
    timer.unref();
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }

  private enqueueUpdate(operation: () => Promise<void>): Promise<void> {
    const next = this.updateChain.then(operation, operation);
    this.updateChain = next.catch(() => {});
    return next;
  }
}

export function resolveConfigPath(args = process.argv.slice(2), cwd = process.cwd()): string {
  const index = args.findIndex((argument) => argument === "--config" || argument === "-c");
  if (index < 0) return join(cwd, ".codex-feishu", "config.json");
  const value = args[index + 1]?.trim();
  if (!value) throw new Error("--config requires a JSON file path");
  return resolve(cwd, value);
}

export function createDefaultJsonConfig(cwd = process.cwd()): JsonAppConfig {
  const defaultPath = resolve(cwd);
  return {
    version: 1,
    feishu: {
      appId: "",
      appSecret: "",
      domain: "feishu",
      adminOpenIds: [],
    },
    codex: {
      command: "codex",
      args: ["app-server", "--stdio"],
      requestTimeoutMs: 120_000,
    },
    workspace: {
      defaultPath,
      allowedRoots: [defaultPath],
      projects: {},
    },
    storage: {
      sessionDatabasePath: join(defaultPath, ".codex-feishu", "sessions.sqlite"),
    },
    runtime: { logLevel: "info" },
  };
}

export function mergeJsonConfigDraft(raw: unknown, cwd = process.cwd()): JsonAppConfig {
  const defaults = createDefaultJsonConfig(cwd);
  if (!isRecord(raw)) return defaults;
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`配置文件 version 目前只支持 1，收到：${String(raw.version)}`);
  }
  const feishu = isRecord(raw.feishu) ? raw.feishu : {};
  const codex = isRecord(raw.codex) ? raw.codex : {};
  const workspace = isRecord(raw.workspace) ? raw.workspace : {};
  const storage = isRecord(raw.storage) ? raw.storage : {};
  const runtime = isRecord(raw.runtime) ? raw.runtime : {};
  return {
    ...defaults,
    ...raw,
    version: 1,
    feishu: { ...defaults.feishu, ...feishu },
    codex: { ...defaults.codex, ...codex },
    workspace: { ...defaults.workspace, ...workspace },
    storage: { ...defaults.storage, ...storage },
    runtime: { ...defaults.runtime, ...runtime },
  } as JsonAppConfig;
}

export function prepareJsonConfig(raw: unknown, cwd = process.cwd()): JsonAppConfig {
  return normalizeJsonConfig(raw ?? {}, cwd, false);
}

function normalizeJsonConfig(raw: unknown, baseDirectory: string, requireCredentials: boolean): JsonAppConfig {
  if (!isRecord(raw)) throw new Error("配置文件根节点必须是 JSON 对象");
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`配置文件 version 目前只支持 1，收到：${String(raw.version)}`);
  }
  const draft = mergeJsonConfigDraft(raw, baseDirectory);
  if (requireCredentials && (!nonEmpty(draft.feishu.appId) || !nonEmpty(draft.feishu.appSecret))) {
    throw new Error("配置文件必须包含 feishu.appId 和 feishu.appSecret");
  }
  if (draft.feishu.domain !== "feishu" && draft.feishu.domain !== "lark") {
    throw new Error("feishu.domain 必须是 feishu 或 lark");
  }
  if (!Array.isArray(draft.feishu.adminOpenIds)
    || !draft.feishu.adminOpenIds.every((value) => typeof value === "string")) {
    throw new Error("feishu.adminOpenIds 必须是字符串数组");
  }
  if (!nonEmpty(draft.codex.command)) throw new Error("codex.command 不能为空");
  if (!Array.isArray(draft.codex.args) || !draft.codex.args.every((value) => typeof value === "string")) {
    throw new Error("codex.args 必须是字符串数组");
  }
  if (!Number.isSafeInteger(draft.codex.requestTimeoutMs) || draft.codex.requestTimeoutMs <= 0) {
    throw new Error("codex.requestTimeoutMs 必须是正整数");
  }
  const defaultPath = absolutePath(draft.workspace.defaultPath, "workspace.defaultPath");
  if (!Array.isArray(draft.workspace.allowedRoots) || draft.workspace.allowedRoots.length === 0) {
    throw new Error("workspace.allowedRoots 至少需要一个路径");
  }
  const allowedRoots = draft.workspace.allowedRoots.map((path) => absolutePath(path, "workspace.allowedRoots"));
  if (!isRecord(draft.workspace.projects)) throw new Error("workspace.projects 必须是 JSON 对象");
  const projects: Record<string, JsonProjectConfig> = {};
  for (const [alias, project] of Object.entries(draft.workspace.projects)) {
    if (!isRecord(project) || !nonEmpty(project.path)) throw new Error(`项目 ${alias} 缺少 path`);
    projects[alias] = {
      path: absolutePath(project.path, `workspace.projects.${alias}.path`),
      enabled: project.enabled !== false,
      createdBy: typeof project.createdBy === "string" ? project.createdBy : "config",
      createdAt: typeof project.createdAt === "number" ? project.createdAt : 0,
    };
  }
  const sessionDatabasePath = absolutePath(draft.storage.sessionDatabasePath, "storage.sessionDatabasePath");
  if (!(["debug", "info", "warn", "error"] as const).includes(draft.runtime.logLevel)) {
    throw new Error("runtime.logLevel 必须是 debug、info、warn 或 error");
  }
  return {
    version: 1,
    feishu: {
      appId: draft.feishu.appId.trim(),
      appSecret: draft.feishu.appSecret.trim(),
      domain: draft.feishu.domain,
      ...(nonEmpty(draft.feishu.encryptKey) ? { encryptKey: draft.feishu.encryptKey.trim() } : {}),
      ...(nonEmpty(draft.feishu.verificationToken)
        ? { verificationToken: draft.feishu.verificationToken.trim() }
        : {}),
      adminOpenIds: [...new Set(draft.feishu.adminOpenIds.map((value) => value.trim()).filter(Boolean))],
    },
    codex: {
      command: draft.codex.command.trim(),
      args: [...draft.codex.args],
      ...(nonEmpty(draft.codex.model) ? { model: draft.codex.model.trim() } : {}),
      ...(nonEmpty(draft.codex.reasoningEffort)
        ? { reasoningEffort: draft.codex.reasoningEffort.trim() }
        : {}),
      requestTimeoutMs: draft.codex.requestTimeoutMs,
    },
    workspace: {
      defaultPath,
      allowedRoots: [...new Set(allowedRoots)],
      projects,
    },
    storage: { sessionDatabasePath },
    runtime: { logLevel: draft.runtime.logLevel },
  };
}

function toAppConfig(json: JsonAppConfig): AppConfig {
  return {
    feishu: {
      appId: json.feishu.appId,
      appSecret: json.feishu.appSecret,
      domain: json.feishu.domain,
      encryptKey: json.feishu.encryptKey,
      verificationToken: json.feishu.verificationToken,
    },
    adminOpenIds: [...json.feishu.adminOpenIds],
    codex: {
      command: json.codex.command,
      args: [...json.codex.args],
      workingDirectory: json.workspace.defaultPath,
      model: json.codex.model,
      reasoningEffort: json.codex.reasoningEffort,
      requestTimeoutMs: json.codex.requestTimeoutMs,
      allowedRoots: [...json.workspace.allowedRoots],
    },
    sessionDatabasePath: json.storage.sessionDatabasePath,
    logLevel: json.runtime.logLevel,
    json,
  };
}

async function writeJsonAtomic(path: string, json: JsonAppConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(json, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} 必须是绝对路径`);
  return resolve(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
