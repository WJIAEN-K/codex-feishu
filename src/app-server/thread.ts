import type { CodexAppServerClient } from "./client.js";
import { resultId, type ThreadResult } from "./protocol.js";

export interface StartThreadOptions {
  cwd: string;
  model?: string;
  reasoningEffort?: string;
}

type RpcClient = Pick<CodexAppServerClient, "request">;

export async function startThread(client: RpcClient, options: StartThreadOptions): Promise<string> {
  const result = await client.request<ThreadResult>("thread/start", {
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
  });
  return resultId(result, "thread");
}

export async function resumeThread(client: RpcClient, threadId: string): Promise<void> {
  await client.request("thread/resume", { threadId });
}
