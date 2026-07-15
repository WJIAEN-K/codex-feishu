import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigFile, createDefaultJsonConfig, resolveConfigPath } from "../src/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codex-feishu-config-"));
  temporaryDirectories.push(directory);
  const project = join(directory, "project");
  await mkdir(project);
  const file = new ConfigFile(join(directory, "config.json"));
  const json = createDefaultJsonConfig(project);
  json.feishu.appId = "cli_test";
  json.feishu.appSecret = "secret";
  await file.save(json);
  return { directory, file, json, project };
}

describe("ConfigFile", () => {
  it("loads the unified JSON schema and resolves --config", async () => {
    const { directory, file, project } = await fixture();
    const config = await file.load();
    expect(config.codex.workingDirectory).toBe(project);
    expect(config.codex.allowedRoots).toEqual([project]);
    expect(config.maxQueuedPerChat).toBe(20);
    expect(resolveConfigPath(["--config", "custom.json"], directory)).toBe(join(directory, "custom.json"));
  });

  it("validates the per-chat queue limit", async () => {
    const { file, json } = await fixture();
    json.queue.maxPerChat = 0;
    await expect(file.save(json)).rejects.toThrow("queue.maxPerChat");
  });

  it("rejects unsupported configuration versions instead of coercing them", async () => {
    const { file, json } = await fixture();
    await writeFile(file.path, JSON.stringify({ ...json, version: 2 }), "utf8");
    await expect(file.load()).rejects.toThrow("只支持 1");
  });

  it("normalizes project aliases and rejects normalized duplicates or reserved aliases", async () => {
    const { file, json, project } = await fixture();
    json.workspace.projects = { " Backend ": { path: project } };
    await file.save(json);
    await expect(file.load()).resolves.toMatchObject({
      json: { workspace: { projects: { backend: { path: project } } } },
    });

    json.workspace.projects = {
      Backend: { path: project },
      backend: { path: project },
    };
    await expect(file.save(json)).rejects.toThrow("规范化后重复");

    json.workspace.projects = { default: { path: project } };
    await expect(file.save(json)).rejects.toThrow("保留项目名称");
  });

  it("rejects configured project paths outside workspace.allowedRoots", async () => {
    const { directory, file, json } = await fixture();
    const outside = join(directory, "outside");
    await mkdir(outside);
    json.workspace.projects = { outside: { path: outside } };

    await expect(file.save(json)).rejects.toThrow("workspace.allowedRoots");
  });

  it("hot-watches valid updates and reports invalid JSON without replacing the last runtime", async () => {
    const { file, json } = await fixture();
    let resolveReload: ((level: string) => void) | undefined;
    let resolveError: ((message: string) => void) | undefined;
    const reloaded = new Promise<string>((resolve) => { resolveReload = resolve; });
    const failed = new Promise<string>((resolve) => { resolveError = resolve; });
    const stop = file.watch(
      (config) => resolveReload?.(config.logLevel),
      (error) => resolveError?.(error.message),
      10,
    );
    try {
      json.runtime.logLevel = "warn";
      await file.save(json);
      await expect(reloaded).resolves.toBe("warn");

      await writeFile(file.path, "{invalid", "utf8");
      await expect(failed).resolves.toContain("有效 JSON");
      await expect(file.loadLatestOrLastValid()).resolves.toMatchObject({ logLevel: "warn" });
    } finally {
      stop();
    }
  });
});
