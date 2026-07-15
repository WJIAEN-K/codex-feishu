import type { CodexAppServerClient } from "./client.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import { resultId, type TurnInput } from "./protocol.js";

export interface StartTurnOptions {
  threadId: string;
  input: TurnInput[];
  cwd: string;
  model?: string;
  reasoningEffort?: string;
}

type RpcClient = Pick<CodexAppServerClient, "request">;

export async function startTurn(client: RpcClient, options: StartTurnOptions): Promise<string> {
  const params: TurnStartParams = {
    threadId: options.threadId,
    input: options.input,
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
  };
  const result = await client.request<TurnStartResponse>("turn/start", params);
  return resultId(result, "turn");
}

export async function interruptTurn(
  client: RpcClient,
  threadId: string,
  turnId: string,
): Promise<void> {
  const params: TurnInterruptParams = { threadId, turnId };
  await client.request<TurnInterruptResponse>("turn/interrupt", params);
}
