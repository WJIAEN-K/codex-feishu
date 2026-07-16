import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatDoctor, runDoctor } from "../src/commands/doctor.js";
import { createDefaultJsonConfig, prepareJsonConfig } from "../src/config/index.js";

describe("doctor", () => {
  it("reports runtime, CLI, login, filesystem, SQLite, and Feishu checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-doctor-"));
    try {
      const json = createDefaultJsonConfig(directory);
      json.feishu.appId = "cli_test"; json.feishu.appSecret = "secret";
      json.codex.command = process.execPath;
      json.storage.sessionDatabasePath = join(directory, "sessions.sqlite");
      const config = prepareJsonConfig(json, directory);
      const checks = await runDoctor({
        feishu: { appId: config.feishu.appId, appSecret: config.feishu.appSecret, domain: config.feishu.domain },
        adminOpenIds: [], codex: { ...config.codex, workingDirectory: config.workspace.defaultPath, allowedRoots: config.workspace.allowedRoots },
        sessionDatabasePath: config.storage.sessionDatabasePath, maxQueuedPerChat: config.queue.maxPerChat,
        attachments: config.attachments, sessions: config.sessions, scheduler: config.scheduler,
        localSync: config.localSync,
        admin: config.admin, runtime: config.runtime, logLevel: config.runtime.logLevel, json: config,
      });
      expect(checks.map((check) => check.name)).toEqual([
        "Node.js", "Codex CLI", "Codex 登录", "默认工作区", "SQLite", "飞书配置",
      ]);
      expect(formatDoctor(checks)).toContain("Node.js");
      expect(checks.find((check) => check.name === "SQLite")?.ok).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
