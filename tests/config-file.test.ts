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
    expect(resolveConfigPath(["--config", "custom.json"], directory)).toBe(join(directory, "custom.json"));
  });

  it("rejects unsupported configuration versions instead of coercing them", async () => {
    const { file, json } = await fixture();
    await writeFile(file.path, JSON.stringify({ ...json, version: 2 }), "utf8");
    await expect(file.load()).rejects.toThrow("只支持 1");
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
