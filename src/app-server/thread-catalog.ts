import type { CodexAppServerClient } from "./client.js";

export interface ThreadSummary {
  id: string;
  cwd: string;
  preview: string;
  name: string | null;
  updatedAt: number;
  status: ThreadStatus;
}

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags?: unknown[] };

interface ThreadListResult {
  data?: unknown;
}

interface ThreadReadResult {
  thread?: unknown;
}

type RpcClient = Pick<CodexAppServerClient, "request">;

export class ThreadCatalog {
  constructor(private readonly client: RpcClient) {}

  async list(cwd?: string, limit = 20): Promise<ThreadSummary[]> {
    const result = await this.client.request<ThreadListResult>("thread/list", {
      ...(cwd ? { cwd } : {}),
      sourceKinds: ["cli", "vscode", "appServer"],
      archived: false,
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    if (!Array.isArray(result.data)) throw new Error("thread/list response did not include data");
    return result.data.map(parseThread);
  }

  async read(threadId: string): Promise<ThreadSummary> {
    const result = await this.client.request<ThreadReadResult>("thread/read", {
      threadId,
      includeTurns: false,
    });
    return parseThread(result.thread);
  }
}

function parseThread(value: unknown): ThreadSummary {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.cwd !== "string") {
    throw new Error("App Server returned an invalid thread");
  }
  return {
    id: value.id,
    cwd: value.cwd,
    preview: typeof value.preview === "string" ? value.preview : "",
    name: typeof value.name === "string" ? value.name : null,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    status: parseStatus(value.status),
  };
}

function parseStatus(value: unknown): ThreadStatus {
  if (!isObject(value) || typeof value.type !== "string") return { type: "notLoaded" };
  if (value.type === "idle" || value.type === "systemError" || value.type === "notLoaded") {
    return { type: value.type };
  }
  if (value.type === "active") {
    return { type: "active", activeFlags: Array.isArray(value.activeFlags) ? value.activeFlags : [] };
  }
  return { type: "notLoaded" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
