import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { localApprovalCard, localApprovalResolvedCard } from "../feishu/cards.js";
import type { FeishuCardAction, FeishuPort } from "../feishu/types.js";
import type { Logger } from "../utils/logger.js";
import type { LocalCodexSyncService } from "./sync-service.js";

export interface PermissionHookInput {
  session_id: string;
  turn_id?: string;
  cwd: string;
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: unknown;
}

interface PendingApproval {
  id: string;
  input: PermissionHookInput;
  chatId: string;
  ownerOpenId: string;
  messageId: string | null;
  resolve: (approved: boolean | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LocalApprovalBroker {
  private server?: Server;
  private token = "";
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly feishu: Pick<FeishuPort, "sendCard" | "updateCard" | "sendMessage">,
    private readonly sync: LocalCodexSyncService,
    private readonly statePath: string,
    private readonly logger: Logger,
    private readonly timeoutMs = 300_000,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.token = randomBytes(32).toString("base64url");
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch((error: unknown) => {
        this.logger.warn("Local approval hook request failed", error);
        if (!response.headersSent) response.writeHead(500);
        response.end("{}");
      });
    });
    this.server.requestTimeout = this.timeoutMs + 10_000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("无法启动本地批准 broker");
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeFile(this.statePath, JSON.stringify({
      endpoint: `http://127.0.0.1:${address.port}/permission`,
      token: this.token,
      pid: process.pid,
    }), { mode: 0o600 });
    await chmod(this.statePath, 0o600);
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) pending.resolve(null);
    this.pending.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    await rm(this.statePath, { force: true });
  }

  async handleCardAction(action: FeishuCardAction): Promise<boolean> {
    const pending = this.pending.get(action.requestId);
    if (!pending) return false;
    if (action.operatorOpenId !== pending.ownerOpenId) {
      await this.feishu.sendMessage(pending.chatId, "只有绑定该 Codex 会话的用户可以处理批准请求。");
      return true;
    }
    if (action.action === "complete") {
      pending.resolve(null);
      return true;
    }
    if (action.action !== "approve" && action.action !== "reject") return true;
    pending.resolve(action.action === "approve");
    return true;
  }

  private async handleHttp(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/permission" || !authorized(request.headers.authorization, this.token)) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    const input = await readHookInput(request);
    const decision = await this.requestApproval(input);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(decision === null ? "{}" : permissionHookOutput(decision));
  }

  async requestApproval(input: PermissionHookInput): Promise<boolean | null> {
    const binding = this.sync.bindingForThread(input.session_id);
    if (!binding) return null;
    const id = `local:${randomUUID()}`;
    const detail = summarizeToolInput(input.tool_input);
    let settle!: (approved: boolean | null) => void;
    const result = new Promise<boolean | null>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => settle(null), this.timeoutMs);
    timer.unref();
    const pending: PendingApproval = {
      id,
      input,
      chatId: binding.deliveryChatId,
      ownerOpenId: binding.ownerOpenId,
      messageId: null,
      resolve: settle,
      timer,
    };
    this.pending.set(id, pending);
    try {
      pending.messageId = await this.feishu.sendCard(binding.deliveryChatId, localApprovalCard({
        requestId: id,
        toolName: input.tool_name,
        cwd: input.cwd,
        detail,
      }));
      if (!pending.messageId) settle(null);
      const approved = await result;
      if (pending.messageId) {
        try {
          await this.feishu.updateCard(pending.messageId, localApprovalResolvedCard({
            toolName: input.tool_name,
            detail,
          }, approved));
        } catch (error) {
          this.logger.warn("Unable to update local approval card", error);
          const label = approved === true ? "✅ 已批准" : approved === false ? "❌ 已拒绝" : "↩️ 已转到 Codex 本地处理";
          await this.feishu.sendMessage(
            pending.chatId,
            `${label}（卡片更新失败，结果已生效）`,
            pending.messageId,
          ).catch((sendError: unknown) => this.logger.warn("Unable to send local approval resolution fallback", sendError));
        }
      }
      return approved;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
}

export function permissionHookOutput(approved: boolean): string {
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: approved ? { behavior: "allow" } : {
        behavior: "deny",
        message: "用户已在飞书拒绝此操作",
      },
    },
  });
}

function authorized(header: string | undefined, token: string): boolean {
  const received = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(received);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readHookInput(request: import("node:http").IncomingMessage): Promise<PermissionHookInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Hook payload is too large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<PermissionHookInput>;
  if (!value.session_id || !value.cwd || !value.tool_name || value.hook_event_name !== "PermissionRequest") {
    throw new Error("Invalid PermissionRequest hook payload");
  }
  return value as PermissionHookInput;
}

function summarizeToolInput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
