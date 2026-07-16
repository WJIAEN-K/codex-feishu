import type { CodexAppServerClient } from "./client.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { AskForApproval } from "./generated/v2/AskForApproval.js";
import type { SandboxMode } from "./generated/v2/SandboxMode.js";
import { resultId } from "./protocol.js";

export interface StartThreadOptions {
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
}

type RpcClient = Pick<CodexAppServerClient, "request">;

export async function startThread(client: RpcClient, options: StartThreadOptions): Promise<string> {
  const params: ThreadStartParams = {
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    approvalPolicy: options.approvalPolicy ?? "on-request",
    approvalsReviewer: "user",
    sandbox: options.sandbox ?? "workspace-write",
  };
  const result = await client.request<ThreadStartResponse>("thread/start", params);
  return resultId(result, "thread");
}

export async function resumeThread(
  client: RpcClient,
  threadId: string,
  options?: StartThreadOptions,
): Promise<void> {
  const params: ThreadResumeParams = {
    threadId,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    ...(options?.model ? { model: options.model } : {}),
    approvalPolicy: options?.approvalPolicy ?? "on-request",
    approvalsReviewer: "user",
    sandbox: options?.sandbox ?? "workspace-write",
  };
  await client.request<ThreadResumeResponse>("thread/resume", params);
}
