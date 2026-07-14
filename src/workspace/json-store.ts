import type { ConfigFile, JsonProjectConfig } from "../config/index.js";
import type { Workspace, WorkspaceStore } from "./store.js";

export class JsonWorkspaceStore implements WorkspaceStore {
  constructor(private readonly configFile: ConfigFile) {}

  async get(alias: string): Promise<Workspace | null> {
    return (await this.list()).find((workspace) => workspace.alias === alias) ?? null;
  }

  async list(): Promise<Workspace[]> {
    const config = await this.configFile.loadLatestOrLastValid();
    const workspaces: Workspace[] = [{
      alias: "default",
      path: config.json.workspace.defaultPath,
      enabled: true,
      createdBy: "system",
      createdAt: 0,
    }];
    for (const [alias, project] of Object.entries(config.json.workspace.projects)) {
      if (alias === "default" || project.enabled === false) continue;
      workspaces.push(fromProject(alias, project));
    }
    return workspaces.sort((left, right) => left.alias.localeCompare(right.alias));
  }

  async set(workspace: Workspace): Promise<void> {
    await this.configFile.update((config) => {
      if (workspace.alias === "default") {
        config.workspace.defaultPath = workspace.path;
        return;
      }
      config.workspace.projects[workspace.alias] = {
        path: workspace.path,
        enabled: workspace.enabled,
        createdBy: workspace.createdBy,
        createdAt: workspace.createdAt,
      };
    });
  }

  async delete(alias: string): Promise<void> {
    await this.configFile.update((config) => {
      delete config.workspace.projects[alias];
    });
  }
}

function fromProject(alias: string, project: JsonProjectConfig): Workspace {
  return {
    alias,
    path: project.path,
    enabled: project.enabled !== false,
    createdBy: project.createdBy ?? "config",
    createdAt: project.createdAt ?? 0,
  };
}
