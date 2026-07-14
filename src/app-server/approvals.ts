import { isObject, type JsonRpcId, type JsonRpcRequest } from "./jsonrpc.js";

export interface ApprovalRequest {
  requestId: JsonRpcId;
  threadId?: string;
  turnId?: string;
  title: string;
  detail?: string;
  risk?: string;
}

export type ApprovalDecision = "accept" | "decline";

export function mapApprovalRequest(request: JsonRpcRequest): ApprovalRequest | null {
  const method = request.method.toLowerCase();
  if (!method.includes("approval")) return null;
  const params = isObject(request.params) ? request.params : {};
  const threadId = stringValue(params.threadId)
    ?? nestedId(params.thread)
    ?? undefined;
  const turnId = stringValue(params.turnId)
    ?? nestedId(params.turn)
    ?? undefined;
  const command = printable(params.command);
  const detail = command
    ?? printable(params.reason)
    ?? printable(params.changes)
    ?? printable(params.detail);
  const isFileChange = method.includes("filechange") || method.includes("file_change");
  return {
    requestId: request.id,
    threadId,
    turnId,
    title: isFileChange ? "Codex 请求修改文件" : "Codex 请求执行高风险操作",
    detail,
    risk: stringValue(params.risk) ?? stringValue(params.riskLevel) ?? undefined,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nestedId(value: unknown): string | null {
  return isObject(value) ? stringValue(value.id) : null;
}

function printable(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n");
  }
  return undefined;
}
