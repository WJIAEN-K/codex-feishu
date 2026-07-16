import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";

import type { FeishuPort } from "../feishu/types.js";

type AttachmentPort = Pick<FeishuPort,
  "uploadImage" | "uploadFile" | "sendImage" | "sendFile">;

export interface AttachmentScopeOptions {
  chatId: string;
  cwd: string;
  replyToMessageId?: string;
}

export interface AttachmentScope {
  token: string;
}

export interface SendAttachmentInput {
  token: string;
  path: string;
  kind: "image" | "file";
  name?: string;
}

interface StoredScope extends AttachmentScopeOptions {
}

export interface AttachmentDispatcherOptions {
  maxFileBytes?: number;
}

export class AttachmentDispatcher {
  private readonly scopes = new Map<string, StoredScope>();
  private readonly maxFileBytes: number;

  constructor(
    private readonly feishu: AttachmentPort,
    options: AttachmentDispatcherOptions = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 50 * 1024 * 1024;
  }

  createScope(options: AttachmentScopeOptions): AttachmentScope {
    const token = randomBytes(32).toString("base64url");
    this.scopes.set(token, { ...options });
    return { token };
  }

  revoke(token: string): void {
    this.scopes.delete(token);
  }

  revokeAll(): void {
    this.scopes.clear();
  }

  async send(input: SendAttachmentInput): Promise<{ ok: true; kind: "image" | "file"; name: string }> {
    const scope = this.scopes.get(input.token);
    if (!scope) throw new Error("附件发送凭证无效或已过期");
    if (!isAbsolute(input.path)) throw new Error("附件路径必须是绝对路径");
    const [canonicalCwd, canonicalPath] = await Promise.all([
      realpath(scope.cwd).catch(() => { throw new Error("当前 Codex 工作目录不存在"); }),
      realpath(input.path).catch(() => { throw new Error("附件文件不存在"); }),
    ]);
    if (!isContained(canonicalCwd, canonicalPath)) {
      throw new Error("附件必须位于当前 Codex 工作目录内");
    }
    const info = await stat(canonicalPath);
    if (!info.isFile()) throw new Error("附件路径必须指向普通文件");
    if (info.size > this.maxFileBytes) {
      throw new Error(`附件超过大小限制（${this.maxFileBytes} bytes）`);
    }
    const name = sanitizeName(input.name ?? basename(canonicalPath));
    if (input.kind === "image") {
      const key = await this.feishu.uploadImage(canonicalPath);
      if (!key) throw new Error("飞书图片上传失败");
      await this.feishu.sendImage(scope.chatId, key, scope.replyToMessageId);
    } else {
      const key = await this.feishu.uploadFile(canonicalPath, name);
      if (!key) throw new Error("飞书文件上传失败");
      await this.feishu.sendFile(scope.chatId, key, scope.replyToMessageId);
    }
    return { ok: true, kind: input.kind, name };
  }
}

function isContained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function sanitizeName(value: string): string {
  const sanitized = basename(value).replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return sanitized || "attachment";
}
