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
  senderOpenId: string,
) => void;

export interface FeishuCardAction {
  action: "approve" | "reject" | "answer" | "skip" | "complete";
  requestId: string;
  operatorOpenId: string;
  messageId?: string;
  questionId?: string;
  answer?: string;
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
  uploadImage(filePath: string): Promise<string | null>;
  uploadFile(filePath: string, fileName: string, fileType?: string): Promise<string | null>;
  sendImage(chatId: string, imageKey: string, replyToMessageId?: string): Promise<void>;
  sendFile(chatId: string, fileKey: string, replyToMessageId?: string): Promise<void>;
  startTyping(chatId: string, messageId: string): Promise<void>;
  stopTyping(chatId: string, success?: boolean, messageId?: string): Promise<void>;
}
