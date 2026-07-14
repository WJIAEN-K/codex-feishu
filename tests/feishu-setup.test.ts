import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import type { registerApp } from "@larksuiteoapi/node-sdk";
import { ConfigFile, createDefaultJsonConfig } from "../src/config/index.js";
import { ensureJsonConfig, renderTerminalQrCode } from "../src/feishu/setup.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codex-feishu-setup-"));
  temporaryDirectories.push(directory);
  const project = join(directory, "project");
  await mkdir(project);
  const configFile = new ConfigFile(join(directory, "config.json"));
  return { configFile, directory, project };
}

describe("ensureJsonConfig", () => {
  it("renders a real terminal QR code through the CommonJS default export", () => {
    const rendered = renderTerminalQrCode("https://open.feishu.cn/page/launcher?user_code=test");
    expect(rendered.length).toBeGreaterThan(100);
    expect(rendered).toContain("\n");
  });

  it("uses a complete JSON configuration without starting scan setup", async () => {
    const { configFile, project } = await fixture();
    const json = createDefaultJsonConfig(project);
    json.feishu.appId = "cli_configured";
    json.feishu.appSecret = "configured-secret";
    await configFile.save(json);
    const register = vi.fn();

    const config = await ensureJsonConfig(configFile, {
      interactive: false,
      register: register as typeof import("@larksuiteoapi/node-sdk").registerApp,
    });

    expect(config.feishu).toMatchObject({ appId: "cli_configured", appSecret: "configured-secret" });
    expect(config.codex.workingDirectory).toBe(project);
    expect(register).not.toHaveBeenCalled();
  });

  it("fails clearly when JSON credentials are missing in a non-interactive process", async () => {
    const { configFile, project } = await fixture();
    await expect(ensureJsonConfig(configFile, {
      cwd: project,
      interactive: false,
    })).rejects.toThrow("交互式终端");
  });

  it("migrates legacy environment variables and SQLite projects non-interactively", async () => {
    const { configFile, directory, project } = await fixture();
    const databasePath = join(directory, "legacy.sqlite");
    const extraProject = join(directory, "extra");
    await mkdir(extraProject);
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE workspaces (
        alias TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    database.prepare(
      "INSERT INTO workspaces (alias, path, enabled, created_by, created_at) VALUES (?, ?, 1, ?, ?)",
    ).run("extra", extraProject, "ou-admin", 123);
    database.close();
    const output: string[] = [];

    const config = await ensureJsonConfig(configFile, {
      cwd: project,
      interactive: false,
      env: {
        FEISHU_APP_ID: "cli_legacy",
        FEISHU_APP_SECRET: "legacy-secret",
        FEISHU_ADMIN_OPEN_IDS: "ou-admin",
        CODEX_WORKING_DIRECTORY: project,
        CODEX_ALLOWED_ROOTS: directory,
        CODEX_SESSION_DB_PATH: databasePath,
      },
      writeLine: (message) => output.push(message),
    });

    expect(config.feishu).toMatchObject({ appId: "cli_legacy", appSecret: "legacy-secret" });
    expect(config.adminOpenIds).toEqual(["ou-admin"]);
    expect(config.sessionDatabasePath).toBe(databasePath);
    expect(config.json.workspace.projects.extra).toMatchObject({
      path: extraProject,
      createdBy: "ou-admin",
      createdAt: 123,
    });
    expect(output.join("\n")).toContain("导入 1 个项目");
  });

  it("migrates credentials from an old .env file", async () => {
    const { configFile, project } = await fixture();
    await writeFile(join(project, ".env"), [
      "FEISHU_APP_ID=cli_dotenv",
      "FEISHU_APP_SECRET=dotenv-secret",
      `CODEX_WORKING_DIRECTORY=${project}`,
    ].join("\n"), "utf8");

    const config = await ensureJsonConfig(configFile, {
      cwd: project,
      interactive: false,
      env: {},
      writeLine: () => {},
    });

    expect(config.feishu).toMatchObject({ appId: "cli_dotenv", appSecret: "dotenv-secret" });
    expect(config.codex.workingDirectory).toBe(project);
  });

  it("registers by QR code and saves the unified JSON securely", async () => {
    const { configFile, project } = await fixture();
    const output: string[] = [];
    const register = vi.fn(async (options: Parameters<typeof registerApp>[0]) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/page/launcher?user_code=test", expireIn: 600 });
      return {
        client_id: "cli_scanned",
        client_secret: "super-secret-value",
        user_info: { open_id: "ou-scanner", tenant_brand: "feishu" as const },
      };
    });

    const config = await ensureJsonConfig(configFile, {
      cwd: project,
      interactive: true,
      register: register as typeof import("@larksuiteoapi/node-sdk").registerApp,
      renderQrCode: (url: string) => `QR:${url}`,
      writeLine: (message: string) => output.push(message),
    });

    expect(output.join("\n")).toContain("QR:https://open.feishu.cn/page/launcher?user_code=test");
    expect(output.join("\n")).not.toContain("super-secret-value");
    expect(config.feishu).toMatchObject({ appId: "cli_scanned", appSecret: "super-secret-value" });
    expect(config.adminOpenIds).toEqual(["ou-scanner"]);
    expect(config.codex.workingDirectory).toBe(project);
    await expect(readFile(configFile.path, "utf8")).resolves.toContain("workspace");
    if (process.platform !== "win32") {
      expect((await stat(configFile.path)).mode & 0o777).toBe(0o600);
    }
  });
});
