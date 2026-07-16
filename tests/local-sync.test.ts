import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LocalCodexCatalog } from "../src/codex-local/catalog.js";
import { permissionHookOutput } from "../src/codex-local/approval-broker.js";
import { installCodexPermissionHook, uninstallCodexPermissionHook } from "../src/codex-local/hook-installer.js";
import { LocalCodexSyncService, rolloutMessage } from "../src/codex-local/sync-service.js";
import { LocalApprovalBroker } from "../src/codex-local/approval-broker.js";
import { LocalSyncStore } from "../src/codex-local/sync-store.js";
import { Logger } from "../src/utils/logger.js";

describe("local Codex synchronization", () => {
  it("only maps user messages and final assistant answers", () => {
    expect(rolloutMessage(JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })))
      .toContain("hello");
    expect(rolloutMessage(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "draft", phase: "commentary" } })))
      .toBeNull();
    expect(rolloutMessage(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "done", phase: "final_answer" } })))
      .toContain("done");
    expect(rolloutMessage(JSON.stringify({ type: "response_item", payload: { type: "reasoning", message: "secret" } })))
      .toBeNull();
  });

  it("starts at EOF and incrementally persists the rollout cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-sync-"));
    const rolloutPath = join(directory, "rollout.jsonl");
    const databasePath = join(directory, "sessions.sqlite");
    await writeFile(rolloutPath, `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "old" } })}\n`);
    const store = new LocalSyncStore(databasePath);
    const sent: string[] = [];
    const catalog = { getThread: async () => ({ id: "thread-1", cwd: directory, rolloutPath }) } as unknown as LocalCodexCatalog;
    const service = new LocalCodexSyncService(store, catalog, {
      sendMessage: async (_chatId: string, text: string) => { sent.push(text); },
    }, new Logger("error"), 500);
    try {
      await service.enable({ threadId: "thread-1", conversationId: "conversation", deliveryChatId: "chat", ownerOpenId: "owner" });
      await appendFile(rolloutPath, [
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "new question" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "working", phase: "commentary" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "new answer", phase: "final_answer" } }),
        "",
      ].join("\n"));
      await service.poll();
      await service.poll();
      expect(sent.join("\n")).toContain("new question");
      expect(sent.join("\n")).toContain("new answer");
      expect(sent.join("\n")).not.toContain("old");
      expect(sent.join("\n")).not.toContain("working");
      expect(store.get("thread-1")!.byteOffset).toBeGreaterThan(0);
      const beforeManagedTurn = sent.length;
      service.beginManagedTurn("thread-1");
      await appendFile(rolloutPath, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "bridge duplicate", phase: "final_answer" } })}\n`);
      await service.poll();
      await service.endManagedTurn("thread-1");
      expect(sent).toHaveLength(beforeManagedTurn);
      await appendFile(rolloutPath, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "external answer", phase: "final_answer" } })}\n`);
      await service.poll();
      expect(sent.join("\n")).toContain("external answer");
      expect(sent.join("\n")).not.toContain("bridge duplicate");
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("advances the cursor per delivered line and retries only the failed message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-sync-retry-"));
    const rolloutPath = join(directory, "rollout.jsonl");
    const store = new LocalSyncStore(join(directory, "sessions.sqlite"));
    await writeFile(rolloutPath, "");
    const catalog = { getThread: async () => ({ id: "thread-1", cwd: directory, rolloutPath }) } as unknown as LocalCodexCatalog;
    const sent: string[] = [];
    let failSecond = true;
    const service = new LocalCodexSyncService(store, catalog, {
      sendMessage: async (_chatId: string, text: string) => {
        if (text.includes("second") && failSecond) throw new Error("temporary");
        sent.push(text);
      },
    }, new Logger("error"));
    try {
      await service.enable({ threadId: "thread-1", conversationId: "conversation", deliveryChatId: "chat", ownerOpenId: "owner" });
      await appendFile(rolloutPath, [
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "first" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "second", phase: "final_answer" } }),
        "",
      ].join("\n"));
      await service.poll();
      expect(sent.filter((text) => text.includes("first"))).toHaveLength(1);
      failSecond = false;
      await service.poll();
      expect(sent.filter((text) => text.includes("first"))).toHaveLength(1);
      expect(sent.filter((text) => text.includes("second"))).toHaveLength(1);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits the official PermissionRequest decision envelope", () => {
    expect(JSON.parse(permissionHookOutput(true))).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    expect(JSON.parse(permissionHookOutput(false))).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "deny" } },
    });
  });

  it("round-trips a bound local approval through a Feishu card", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-broker-"));
    const statePath = join(directory, "broker.json");
    let card: Record<string, unknown> | undefined;
    const broker = new LocalApprovalBroker({
      sendCard: async (_chatId, nextCard) => { card = nextCard; return "message-1"; },
      updateCard: async () => {},
      sendMessage: async () => {},
    }, {
      bindingForThread: () => ({ deliveryChatId: "chat", ownerOpenId: "owner" }),
    } as unknown as LocalCodexSyncService, statePath, new Logger("error"), 5_000);
    try {
      const pending = broker.requestApproval({
        session_id: "thread-1", cwd: directory, hook_event_name: "PermissionRequest",
        tool_name: "Bash", tool_input: { command: "npm test" },
      });
      for (let attempt = 0; !card && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const body = card as { body: { elements: Array<{ columns?: Array<{ elements: Array<{ behaviors: Array<{ value: { requestId: string } }> }> }> }> } };
      const requestId = body.body.elements.find((element) => element.columns)?.columns?.[0]?.elements[0]?.behaviors[0]?.value.requestId;
      expect(requestId).toMatch(/^local:/);
      await broker.handleCardAction({ action: "approve", requestId: requestId!, operatorOpenId: "owner" });
      expect(await pending).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes an authenticated loopback hook endpoint and falls through for unbound threads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-broker-http-"));
    const statePath = join(directory, "broker.json");
    const broker = new LocalApprovalBroker({
      sendCard: async () => null,
      updateCard: async () => {},
      sendMessage: async () => {},
    }, { bindingForThread: () => null } as unknown as LocalCodexSyncService, statePath, new Logger("error"), 1_000);
    try {
      await broker.start();
      const state = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
      const response = await fetch(state.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          session_id: "unbound", cwd: directory, hook_event_name: "PermissionRequest",
          tool_name: "Bash", tool_input: { command: "pwd" },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
    } finally {
      await broker.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("merges the Codex hook idempotently without replacing existing hooks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-hook-"));
    const hooksPath = join(directory, "hooks.json");
    await writeFile(hooksPath, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "existing" }] }] } }));
    try {
      expect((await installCodexPermissionHook("/tmp/config.json", hooksPath)).changed).toBe(true);
      expect((await installCodexPermissionHook("/tmp/config.json", hooksPath)).changed).toBe(false);
      const json = JSON.parse(await (await import("node:fs/promises")).readFile(hooksPath, "utf8"));
      expect(json.hooks.PermissionRequest).toHaveLength(2);
      expect(json.hooks.PermissionRequest[0].hooks[0].command).toBe("existing");
      expect((await uninstallCodexPermissionHook("/tmp/config.json", hooksPath)).changed).toBe(true);
      const uninstalled = JSON.parse(await (await import("node:fs/promises")).readFile(hooksPath, "utf8"));
      expect(uninstalled.hooks.PermissionRequest).toHaveLength(1);
      expect(uninstalled.hooks.PermissionRequest[0].hooks[0].command).toBe("existing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
