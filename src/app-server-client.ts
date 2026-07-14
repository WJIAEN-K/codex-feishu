import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface AppServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
}

export interface StartTurnOptions {
  threadId: string;
  text: string;
  cwd?: string;
  model?: string;
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private notificationHandler?: (