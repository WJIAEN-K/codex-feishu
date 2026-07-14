import { describe, expect, it } from "vitest";

import { mapApprovalRequest } from "../src/app-server/approvals.js";
import { approvalCard } from "../src/feishu/cards.js";

describe("approval mapping", () => {
  it("maps command and file approval requests", () => {
    expect(mapApprovalRequest({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "rm file", risk: "high" },
    })).toEqual({
      requestId: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      title: "Codex 请求执行高风险操作",
      detail: "rm file",
      risk: "high",
    });
    expect(mapApprovalRequest({
      id: "request-2",
      method: "item/fileChange/requestApproval",
      params: { thread: { id: "thread-1" }, changes: [{ path: "src/a.ts" }] },
    })).toMatchObject({ title: "Codex 请求修改文件", threadId: "thread-1" });
    expect(mapApprovalRequest({ id: 3, method: "account/read" })).toBeNull();
  });

  it("embeds the request id in both approval card callbacks", () => {
    const card = approvalCard({
      requestId: 42,
      title: "Approve",
      detail: "command",
    });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('"requestId":"42"');
    expect(serialized).toContain('"action":"approve"');
    expect(serialized).toContain('"action":"reject"');
  });
});
