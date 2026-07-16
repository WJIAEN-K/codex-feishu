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
export type RuntimeMode = "default" | "plan" | "full-auto";

export interface SessionRuntimePreferences {
  model?: string;
  reasoningEffort?: string;
  mode?: RuntimeMode;
}

export interface ChatSession {
  id?: string;
  name?: string;
  chatId: string;
  threadId: string;
  cwd: string;
  bindingMode: SessionBindingMode;
  status: SessionStatus;
  activeTurnId?: string;
  runtime?: SessionRuntimePreferences;
  createdAt: number;
  updatedAt: number;
}
