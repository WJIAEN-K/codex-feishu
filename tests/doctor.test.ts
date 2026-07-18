import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { formatDoctor, runDoctor } from "../src/commands/doctor.js";
import { createDefaultJsonConfig, prepareJsonConfig } from "../src/config/index.js";
import type { AppConfig } from "../src/config/index.js";

describe("doctor", () => {
  it("reports platform, Runtime, authentication, filesystem, SQLite, and Feishu checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-doctor-"));
    try {
      const json = createDefaultJsonConfig(directory);
      json.feishu.appId = "cli_test";
      json.feishu.appSecret = "secret";
      json.storage.sessionDatabasePath = join(directory, "sessions.sqlite");
      const prepared = prepareJsonConfig(json, directory);
      const config: AppConfig = {
        feishu: { appId: prepared.feishu.appId, appSecret: prepared.feishu.appSecret, domain: prepared.feishu.domain },
        adminOpenIds: [],
        codex: { ...prepared.codex, workingDirectory: prepared.workspace.defaultPath, allowedRoots: prepared.workspace.allowedRoots },
        sessionDatabasePath: prepared.storage.sessionDatabasePath,
        maxQueuedPerChat: prepared.queue.maxPerChat,
        attachments: prepared.attachments,
        sessions: prepared.sessions,
        scheduler: prepared.scheduler,
        localSync: prepared.localSync,
        admin: prepared.admin,
        runtime: prepared.runtime,
        logLevel: prepared.runtime.logLevel,
        json: prepared,
      };
      const runtime = {
        source: "desktop-bundled" as const,
        executablePath: "/Applications/Codex.app/Contents/Resources/codex",
        version: "0.144.4",
        verification: {
          ok: true,
          version: "0.144.4",
          supportsAppServer: true,
          initializeSucceeded: true,
          accountReadSucceeded: true,
        },
      };
      const checks = await runDoctor(config, {
        manager: {
          discoverCandidates: vi.fn(async () => [runtime]),
          resolve: vi.fn(async () => runtime),
        },
        inspectAccount: vi.fn(async () => ({
          account: { type: "chatgpt" as const, email: "demo@example.com", planType: "plus" as const },
          requiresOpenaiAuth: true,
        })),
        platform: "linux",
        arch: "x64",
      });

      expect(checks.map((check) => check.name)).toEqual([
        "Node.js", "操作系统", "架构", "Runtime 候选", "桌面客户端 Runtime",
        "已选 Runtime", "Runtime 版本", "App Server 握手", "CODEX_HOME", "Codex 认证",
        "默认工作区", "SQLite", "飞书配置",
      ]);
      expect(formatDoctor(checks)).toContain("0.144.4");
      expect(checks.find((check) => check.name === "操作系统")).toMatchObject({ ok: true, detail: "linux" });
      expect(checks.find((check) => check.name === "SQLite")?.ok).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
