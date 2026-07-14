import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

import type { Workspace, WorkspaceStore } from "./store.js";

export interface WorkspaceRegistryOptions {
  allowedRoots: string[];
  adminOpenIds: string[];
  defaultPath: string;
}

export class WorkspaceRegistry {
  private allowedRoots: string[] = [];
  private readonly adminOpenIds: Set<string>;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly options: WorkspaceRegistryOptions,
  ) {
    this.adminOpenIds = new Set(options.adminOpenIds);
  }

  async initialize(): Promise<void> {
    this.allowedRoots = await Promise.all(this.options.allowedRoots.map((root) => canonicalDirectory(root)));
    const defaultPath = await this.validatePath(this.options.defaultPath);
    await this.store.set({
      alias: "default",
      path: defaultPath,
      enabled: true,
      createdBy: "system",
      createdAt: Date.now(),
    });
  }

  list(): Promise<Workspace[]> {
    return this.store.list();
  }

  async findByPath(path: string): Promise<Workspace | null> {
    const canonicalPath = await this.validatePath(path);
    return (await this.store.list()).find((workspace) => workspace.path === canonicalPath) ?? null;
  }

  async get(alias: string): Promise<Workspace> {
    const normalized = normalizeAlias(alias);
    const workspace = await this.store.get(normalized);
    if (!workspace?.enabled) throw new Error(`未知项目：${alias}`);
    return workspace;
  }

  async add(alias: string, path: string, senderOpenId: string): Promise<Workspace> {
    this.requireAdmin(senderOpenId);
    const normalized = normalizeAlias(alias);
    if (normalized === "default") throw new Error("default 是保留项目名称");
    const canonicalPath = await this.validatePath(path);
    const workspace: Workspace = {
      alias: normalized,
      path: canonicalPath,
      enabled: true,
      createdBy: senderOpenId,
      createdAt: Date.now(),
    };
    await this.store.set(workspace);
    return workspace;
  }

  async remove(alias: string, senderOpenId: string): Promise<void> {
    this.requireAdmin(senderOpenId);
    const normalized = normalizeAlias(alias);
    if (normalized === "default") throw new Error("不能删除 default 项目");
    if (!await this.store.get(normalized)) throw new Error(`未知项目：${alias}`);
    await this.store.delete(normalized);
  }

  async validatePath(path: string): Promise<string> {
    const canonicalPath = await canonicalDirectory(path);
    if (this.allowedRoots.length === 0) throw new Error("工作区白名单尚未初始化");
    if (!this.allowedRoots.some((root) => isInside(canonicalPath, root))) {
      throw new Error("项目目录不在 workspace.allowedRoots 允许范围内");
    }
    return canonicalPath;
  }

  isAdmin(senderOpenId: string): boolean {
    return Boolean(senderOpenId) && this.adminOpenIds.has(senderOpenId);
  }

  private requireAdmin(senderOpenId: string): void {
    if (!this.isAdmin(senderOpenId)) throw new Error("只有配置的飞书管理员可以修改项目列表");
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonicalPath = await realpath(path);
  const metadata = await stat(canonicalPath);
  if (!metadata.isDirectory()) throw new Error(`不是目录：${path}`);
  return canonicalPath;
}

function normalizeAlias(alias: string): string {
  const normalized = alias.trim().toLocaleLowerCase("en-US");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,31}$/u.test(normalized)) {
    throw new Error("项目别名必须为 1～32 个字母、数字、点、下划线或连字符");
  }
  return normalized;
}

function isInside(path: string, root: string): boolean {
  const normalizedPath = platformPath(path);
  const normalizedRoot = platformPath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function platformPath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}
