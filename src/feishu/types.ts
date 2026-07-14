import type { BridgeStatus } from "../types.js";

export interface InboundResource {
  type: "image" | "file" | "audio" | "video";
  fileKey: string;
  fileName?: string;
}

export type MessageHandler = (
  chatId: string,
  messageId: string,
  text: string,
  chatType: "p2p" | "group",
  resources: InboundResource[],
) => void;

export interface FeishuCardAction {
  action: "approve" | "reject";
  requestId: string;
  messageId?: string;
}

export type CardActionHandler = (action: FeishuCardAction) => Promise<void> | void;

export interface FeishuPort {
  connect(): Promise<void>;
  disconnect(): void;
  getStatus(): BridgeStatus;
  setOnMessage(handler: MessageHandler): void;
  setOnStatusChange(handler: (status: BridgeStatus) => void): void;
  setOnCardAction(handler: CardActionHandler): void;
  sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void>;
  sendCard(chatId: string, card: Record<string, unknown>, replyToMessageId?: string): Promise<string | null>;
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
    fileName?: string,
  ): Promise<string | null>;
  startTyping(chatId: string, messageId: string): Promise<void>;
  stopTyping(chatId: string, success?: boolean): Promise<void>;
}
