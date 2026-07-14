import { describe, expect, it } from "vitest";

import {
  isErrorResponse,
  isNotification,
  isRequest,
  JsonRpcError,
  parseJsonRpcLine,
} from "../src/app-server/jsonrpc.js";

describe("JSON-RPC parsing", () => {
  it("classifies requests, notifications, success, and error responses", () => {
    expect(isRequest(parseJsonRpcLine('{"id":1,"method":"approval","params":{}}'))).toBe(true);
    expect(isNotification(parseJsonRpcLine('{"method":"turn/started","params":{}}'))).toBe(true);
    expect(isErrorResponse(parseJsonRpcLine('{"id":2,"error":{"code":-1,"message":"no"}}') as never)).toBe(true);
    expect(parseJsonRpcLine('{"id":3,"result":{"ok":true}}')).toEqual({ id: 3, result: { ok: true } });
  });

  it("rejects malformed JSON and invalid message shapes", () => {
    expect(() => parseJsonRpcLine("not json")).toThrowError(JsonRpcError);
    expect(() => parseJsonRpcLine('{"hello":"world"}')).toThrowError("Invalid JSON-RPC message");
    expect(() => parseJsonRpcLine("[]")).toThrowError("must be an object");
  });
});
