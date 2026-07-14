import type { JsonRpcId } from "./jsonrpc.js";

export interface ApprovalRequest {
  requestId: JsonRpcId;
  threadId?: string;
  turnId?: string;
  title: string;
  detail?: string;
  risk?: string;
}

export type ApprovalDecision = "accept" | "decline";
