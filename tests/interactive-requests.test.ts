import { describe, expect, it } from "vitest";

import {
  buildInteractiveResponse,
  parseInteractiveRequest,
} from "../src/app-server/interactive-requests.js";

describe("interactive App Server requests", () => {
  it("normalizes request_user_input questions and builds the answer map", () => {
    const request = parseInteractiveRequest({
      id: 10,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        autoResolutionMs: 30_000,
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Where should this run?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Staging", description: "Use staging services" },
            { label: "Production", description: "Use production services" },
          ],
        }],
      },
    });

    expect(request).toMatchObject({
      kind: "user_input",
      requestId: 10,
      threadId: "thread-1",
      turnId: "turn-1",
      autoResolutionMs: 30_000,
      questions: [{
        id: "environment",
        header: "Environment",
        prompt: "Where should this run?",
        allowOther: true,
        secret: false,
      }],
    });
    expect(buildInteractiveResponse(request!, "accept", { environment: ["Staging"] })).toEqual({
      answers: { environment: { answers: ["Staging"] } },
    });
  });

  it("normalizes MCP form elicitation and returns structured content", () => {
    const request = parseInteractiveRequest({
      id: "mcp-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "deploy",
        mode: "form",
        message: "Deployment settings",
        requestedSchema: {
          type: "object",
          required: ["region"],
          properties: {
            region: { type: "string", title: "Region", enum: ["cn", "us"] },
            force: { type: "boolean", title: "Force" },
          },
        },
      },
    });

    expect(request).toMatchObject({
      kind: "mcp_elicitation",
      serverName: "deploy",
      questions: [
        { id: "region", required: true, options: [{ label: "cn" }, { label: "us" }] },
        { id: "force", required: false, options: [{ label: "是", value: "true" }, { label: "否", value: "false" }] },
      ],
    });
    expect(buildInteractiveResponse(request!, "accept", {
      region: ["cn"],
      force: ["true"],
    })).toEqual({
      action: "accept",
      content: { region: "cn", force: true },
      _meta: null,
    });
    expect(buildInteractiveResponse(request!, "decline", {})).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
  });

  it("normalizes URL elicitation", () => {
    const request = parseInteractiveRequest({
      id: "mcp-url",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: null,
        serverName: "oauth",
        mode: "url",
        message: "Authorize access",
        url: "https://example.com/oauth",
        elicitationId: "e-1",
      },
    });
    expect(request).toMatchObject({
      kind: "mcp_elicitation",
      mode: "url",
      url: "https://example.com/oauth",
      questions: [],
    });
  });

  it("keeps permission approval response shapes distinct from decision approvals", () => {
    const request = parseInteractiveRequest({
      id: 20,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        environmentId: null,
        startedAtMs: 1,
        cwd: "/workspace",
        reason: "Needs network access",
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ["/workspace/input"], write: null },
        },
      },
    });

    expect(request).toMatchObject({
      kind: "permission_approval",
      title: "Codex 请求扩展权限",
      detail: "Needs network access",
    });
    expect(buildInteractiveResponse(request!, "accept", {})).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/workspace/input"], write: null },
      },
      scope: "turn",
    });
    expect(buildInteractiveResponse(request!, "decline", {})).toEqual({
      permissions: {},
      scope: "turn",
    });
  });

  it("uses decision responses for command and file approvals", () => {
    const command = parseInteractiveRequest({
      id: 30,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "npm publish" },
    });
    const file = parseInteractiveRequest({
      id: 31,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", changes: [{ path: "a.ts" }] },
    });

    expect(command).toMatchObject({ kind: "approval", approvalType: "command" });
    expect(file).toMatchObject({ kind: "approval", approvalType: "file" });
    expect(buildInteractiveResponse(command!, "accept", {})).toEqual({ decision: "accept" });
    expect(buildInteractiveResponse(file!, "decline", {})).toEqual({ decision: "decline" });
  });

  it("rejects unrelated server requests", () => {
    expect(parseInteractiveRequest({ id: 40, method: "account/read", params: {} })).toBeNull();
  });
});
