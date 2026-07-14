import type { CodexAppServerClient } from "./client.js";
import { resultId, type TurnInput, type TurnResult } from "./protocol.js";

export interface StartTurnOptions {
  threadId: string;
  input: TurnInput[];
  cwd: string;
  model?: string;
  reasoningEffort?: string;
}

type RpcClient = Pick<CodexAppServerClient, "request">;

export async function startTurn(client: RpcClient, options: StartTurnOptions): Promise<string> {
  const result = await client.request<TurnResult>("turn/start", {
    threadId: options.threadId,
    input: options.input,
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
  });
  return resultId(result, "turn");
}

export async function interruptTurn(
  client: RpcClient,
  threadId: string,
  turnId: string,
): Promise<void> {
  await client.request("turn/interrupt", { threadId, turnId });
}
