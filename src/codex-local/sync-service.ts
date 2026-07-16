import { open, stat } from "node:fs/promises";

import type { FeishuPort } from "../feishu/types.js";
import { splitText } from "../feishu/messages.js";
import type { Logger } from "../utils/logger.js";
import type { LocalCodexCatalog } from "./catalog.js";
import { LocalSyncStore, type LocalSyncBinding } from "./sync-store.js";

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_ROLLOUT_LINE_BYTES = 4 * 1024 * 1024;

interface RolloutRecord {
  type?: string;
  payload?: {
    type?: string;
    message?: string;
    phase?: string;
  };
}

export class LocalCodexSyncService {
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private readonly managedThreads = new Set<string>();

  constructor(
    readonly store: LocalSyncStore,
    private readonly catalog: LocalCodexCatalog,
    private readonly feishu: Pick<FeishuPort, "sendMessage">,
    private readonly logger: Logger,
    private readonly pollIntervalMs = 750,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async enable(input: {
    threadId: string;
    conversationId: string;
    deliveryChatId: string;
    ownerOpenId: string;
  }): Promise<LocalSyncBinding> {
    const thread = await this.catalog.getThread(input.threadId);
    if (!thread?.rolloutPath) throw new Error("该 Codex 会话没有可读取的 rollout 日志");
    const info = await stat(thread.rolloutPath);
    this.store.disableConversation(input.conversationId);
    this.store.enable({ ...input, rolloutPath: thread.rolloutPath, byteOffset: info.size });
    return this.store.get(input.threadId)!;
  }

  disable(conversationId: string): void {
    this.store.disableConversation(conversationId);
  }

  status(conversationId: string): LocalSyncBinding | null {
    return this.store.getByConversation(conversationId);
  }

  bindingForThread(threadId: string): LocalSyncBinding | null {
    const binding = this.store.get(threadId);
    return binding?.enabled ? binding : null;
  }

  beginManagedTurn(threadId: string): void {
    if (this.bindingForThread(threadId)) this.managedThreads.add(threadId);
  }

  async endManagedTurn(threadId: string): Promise<void> {
    const binding = this.bindingForThread(threadId);
    if (binding) await this.skipToEnd(binding);
    this.managedThreads.delete(threadId);
  }

  async poll(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const binding of this.store.listEnabled()) {
        await this.pollBinding(binding).catch((error: unknown) => {
          this.logger.warn(`Unable to sync local Codex thread ${binding.threadId}`, error);
        });
      }
    } finally {
      this.checking = false;
    }
  }

  private async pollBinding(binding: LocalSyncBinding): Promise<void> {
    if (this.managedThreads.has(binding.threadId)) {
      await this.skipToEnd(binding);
      return;
    }
    const thread = await this.catalog.getThread(binding.threadId);
    const rolloutPath = thread?.rolloutPath ?? binding.rolloutPath;
    const info = await stat(rolloutPath);
    let offset = rolloutPath === binding.rolloutPath ? binding.byteOffset : 0;
    if (info.size < offset) offset = 0;
    if (info.size === offset) return;
    const handle = await open(rolloutPath, "r");
    try {
      let position = offset;
      let pending = Buffer.alloc(0);
      let pendingStart = offset;
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (position < info.size) {
        const requested = Math.min(chunk.length, info.size - position);
        const { bytesRead } = await handle.read(chunk, 0, requested, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        pending = pending.length === 0
          ? Buffer.from(chunk.subarray(0, bytesRead))
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

        let newline: number;
        while ((newline = pending.indexOf(0x0a)) >= 0) {
          const lineEnd = pendingStart + newline + 1;
          const message = rolloutMessage(pending.subarray(0, newline).toString("utf8"));
          if (message) await this.send(binding.deliveryChatId, message);
          this.store.updateCursor(binding.threadId, rolloutPath, lineEnd);
          pending = pending.subarray(newline + 1);
          pendingStart = lineEnd;
        }
        if (pending.length > MAX_ROLLOUT_LINE_BYTES) {
          throw new Error(`Codex rollout line exceeds ${MAX_ROLLOUT_LINE_BYTES} bytes`);
        }
      }
    } finally {
      await handle.close();
    }
  }

  private async skipToEnd(binding: LocalSyncBinding): Promise<void> {
    const thread = await this.catalog.getThread(binding.threadId);
    const rolloutPath = thread?.rolloutPath ?? binding.rolloutPath;
    const info = await stat(rolloutPath);
    this.store.updateCursor(binding.threadId, rolloutPath, info.size);
  }

  private async send(chatId: string, text: string): Promise<void> {
    for (const chunk of splitText(text)) await this.feishu.sendMessage(chatId, chunk);
  }
}

export function rolloutMessage(line: string): string | null {
  let record: RolloutRecord;
  try {
    record = JSON.parse(line) as RolloutRecord;
  } catch {
    return null;
  }
  if (record.type !== "event_msg" || typeof record.payload?.message !== "string") return null;
  if (record.payload.type === "user_message") return `**Codex 本地输入**\n\n${record.payload.message}`;
  if (record.payload.type === "agent_message" && record.payload.phase === "final_answer") {
    return `**Codex 本地回复**\n\n${record.payload.message}`;
  }
  return null;
}
