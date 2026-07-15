import { describe, expect, it } from "vitest";

import { AppServerEventMapper } from "../src/app-server/events.js";

describe("AppServerEventMapper", () => {
  it("maps text and turn lifecycle events through the chat/thread correlation", () => {
    const mapper = new AppServerEventMapper();
    mapper.registerThread("chat-1", "thread-1");

    expect(mapper.map({ method: "turn/started", params: {
      threadId: "thread-1", turn: { id: "turn-1" },
    } })).toEqual([{ type: "turn_started", chatId: "chat-1", threadId: "thread-1", turnId: "turn-1" }]);
    expect(mapper.map({ method: "item/agentMessage/delta", params: {
      threadId: "thread-1", turnId: "turn-1", delta: "hello",
    } })).toEqual([{ type: "text_delta", chatId: "chat-1", threadId: "thread-1", turnId: "turn-1", text: "hello" }]);
    expect(mapper.map({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "completed" },
    } })).toEqual([{ type: "turn_completed", chatId: "chat-1", threadId: "thread-1", turnId: "turn-1", success: true, error: undefined }]);
  });

  it("maps shell and file-change tool progress", () => {
    const mapper = new AppServerEventMapper();
    mapper.registerThread("chat-1", "thread-1");
    const base = { threadId: "thread-1", turnId: "turn-1" };

    expect(mapper.map({ method: "item/started", params: {
      ...base, item: { id: "shell-1", type: "commandExecution", command: "npm test" },
    } })[0]).toMatchObject({ type: "tool_started", name: "Shell", detail: "npm test" });
    expect(mapper.map({ method: "item/started", params: {
      ...base, item: { id: "file-1", type: "fileChange", changes: [{ path: "src/a.ts" }] },
    } })[0]).toMatchObject({ type: "tool_started", name: "文件修改", detail: "src/a.ts" });
    expect(mapper.map({ method: "item/completed", params: {
      ...base, item: { id: "shell-1", type: "commandExecution", status: "failed" },
    } })[0]).toMatchObject({ type: "tool_completed", success: false });
  });

  it("uses the completed agent message when no delta is emitted", () => {
    const mapper = new AppServerEventMapper();
    mapper.registerThread("chat-1", "thread-1");
    expect(mapper.map({ method: "item/completed", params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-1", type: "agentMessage", text: "final answer" },
    } })).toEqual([{
      type: "text_completed",
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      text: "final answer",
    }]);
  });

  it("maps errors and ignores unknown threads or methods", () => {
    const mapper = new AppServerEventMapper();
    mapper.registerThread("chat-1", "thread-1");
    expect(mapper.map({ method: "turn/error", params: {
      threadId: "thread-1", turnId: "turn-1", error: { message: "boom" },
    } })[0]).toMatchObject({ type: "error", message: "boom" });
    expect(mapper.map({ method: "turn/started", params: { threadId: "unknown" } })).toEqual([]);
    expect(mapper.map({ method: "account/updated", params: { threadId: "thread-1" } })).toEqual([]);
  });
});
