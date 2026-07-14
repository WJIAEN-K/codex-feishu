export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`JSON-RPC request ${method} timed out after ${timeoutMs}ms`);
    this.name = "JsonRpcTimeoutError";
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonRpcLine(line: string): JsonRpcMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new JsonRpcError(-32700, "Unable to parse App Server JSON", error);
  }

  if (!isObject(value)) {
    throw new JsonRpcError(-32600, "App Server message must be an object", value);
  }

  const hasId = typeof value.id === "number" || typeof value.id === "string";
  const hasMethod = typeof value.method === "string";
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = isObject(value.error)
    && typeof value.error.code === "number"
    && typeof value.error.message === "string";

  if (hasMethod && hasId) return value as unknown as JsonRpcRequest;
  if (hasMethod && !hasId) return value as unknown as JsonRpcNotification;
  if (hasId && hasResult && !hasError) return value as unknown as JsonRpcSuccessResponse;
  if (hasId && hasError && !hasResult) return value as unknown as JsonRpcErrorResponse;

  throw new JsonRpcError(-32600, "Invalid JSON-RPC message", value);
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isErrorResponse(message: JsonRpcResponse): message is JsonRpcErrorResponse {
  return "error" in message;
}
