export interface FeishuConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  encryptKey?: string;
  verificationToken?: string;
}

export type BridgeStatus = "disconnected" | "connecting" | "connected" | "error";

export type SessionStatus = "idle" | "running" | "waiting_approval" | "error";
export type SessionBindingMode = "owned" | "attached";

export interface ChatSession {
  chatId: string;
  threadId: string;
  cwd: string;
  bindingMode: SessionBindingMode;
  status: SessionStatus;
  activeTurnId?: string;
  createdAt: number;
  updatedAt: number;
}
