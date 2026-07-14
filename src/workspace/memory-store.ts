import type { Workspace, WorkspaceStore } from "./store.js";

export class MemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<string, Workspace>();

  async get(alias: string): Promise<Workspace | null> {
    return this.workspaces.get(alias) ?? null;
  }

  async list(): Promise<Workspace[]> {
    return [...this.workspaces.values()].sort((left, right) => left.alias.localeCompare(right.alias));
  }

  async set(workspace: Workspace): Promise<void> {
    this.workspaces.set(workspace.alias, { ...workspace });
  }

  async delete(alias: string): Promise<void> {
    this.workspaces.delete(alias);
  }
}
