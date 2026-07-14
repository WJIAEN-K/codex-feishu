export interface Workspace {
  alias: string;
  path: string;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
}

export interface WorkspaceStore {
  get(alias: string): Promise<Workspace | null>;
  list(): Promise<Workspace[]>;
  set(workspace: Workspace): Promise<void>;
  delete(alias: string): Promise<void>;
  close?(): Promise<void> | void;
}
