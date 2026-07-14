import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryWorkspaceStore } from "../src/workspace/memory-store.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { SqliteWorkspaceStore } from "../src/workspace/sqlite-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codex-feishu-workspaces-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "allowed");
  const project = join(root, "project");
  const outside = join(directory, "outside");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(outside)]);
  const store = new MemoryWorkspaceStore();
  const registry = new WorkspaceRegistry(store, {
    allowedRoots: [root],
    adminOpenIds: ["ou-admin"],
    defaultPath: project,
  });
  await registry.initialize();
  return { directory, root, project, outside, registry };
}

describe("WorkspaceRegistry", () => {
  it("seeds the default workspace and lets admins register allowed directories", async () => {
    const { root, project, registry } = await fixture();
    const second = join(root, "second");
    await mkdir(second);

    await expect(registry.get("default")).resolves.toMatchObject({
      path: await realpath(project),
      createdBy: "system",
    });
    await expect(registry.add("Backend", second, "ou-admin")).resolves.toMatchObject({
      alias: "backend",
      path: await realpath(second),
    });
    await expect(registry.list()).resolves.toHaveLength(2);
  });

  it("rejects non-admin mutations and paths outside the allowlist", async () => {
    const { outside, registry } = await fixture();

    await expect(registry.add("outside", outside, "ou-admin")).rejects.toThrow("CODEX_ALLOWED_ROOTS");
    await expect(registry.add("project", outside, "ou-user")).rejects.toThrow("管理员");
    await expect(registry.remove("default", "ou-admin")).rejects.toThrow("不能删除");
  });

  it("persists workspaces in SQLite", async () => {
    const { directory, root, project } = await fixture();
    const databasePath = join(directory, "sessions.sqlite");
    const extra = join(root, "extra");
    await mkdir(extra);

    const firstStore = new SqliteWorkspaceStore(databasePath);
    const first = new WorkspaceRegistry(firstStore, {
      allowedRoots: [root],
      adminOpenIds: ["ou-admin"],
      defaultPath: project,
    });
    await first.initialize();
    await first.add("extra", extra, "ou-admin");
    firstStore.close();

    const secondStore = new SqliteWorkspaceStore(databasePath);
    await expect(secondStore.get("extra")).resolves.toMatchObject({
      path: await realpath(extra),
      createdBy: "ou-admin",
    });
    secondStore.close();
  });
});
