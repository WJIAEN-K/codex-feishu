import type { CodexAppServerClient } from "./client.js";
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "./jsonrpc.js";

type RecoveryHandler = () => Promise<void> | void;

export interface AppServerSupervisorOptions {
  retryDelaysMs?: readonly number[];
}

/** Keeps a single App Server client alive and restores application state after a restart. */
export class CodexAppServerSupervisor {
  private readonly retryDelaysMs: readonly number[];
  private readonly recoveryHandlers = new Set<RecoveryHandler>();
  private restartTask: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveRetryWait: (() => void) | null = null;
  private stopping = true;

  constructor(
    private readonly client: CodexAppServerClient,
    options: AppServerSupervisorOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
    if (this.retryDelaysMs.length === 0 || this.retryDelaysMs.some((delay) => delay < 0)) {
      throw new Error("App Server retry delays must contain non-negative values");
    }
    this.client.onError(() => {
      if (!this.stopping && this.client.getStatus() === "error") this.scheduleRestart();
    });
  }

  async start(): Promise<void> {
    if (!this.stopping && this.client.getStatus() === "ready") return;
    this.stopping = false;
    await this.client.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.resolveRetryWait?.();
    this.resolveRetryWait = null;
    await this.client.stop();
    await this.restartTask?.catch(() => undefined);
    this.restartTask = null;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    return this.client.request<T>(method, params);
  }

  notify(method: string, params?: unknown): void {
    this.client.notify(method, params);
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.client.respond(id, result);
  }

  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.client.respondError(id, code, message, data);
  }

  onNotification(handler: (message: JsonRpcNotification) => void): () => void {
    return this.client.onNotification(handler);
  }

  onRequest(handler: (message: JsonRpcRequest) => void): () => void {
    return this.client.onRequest(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    return this.client.onError(handler);
  }

  onStderr(handler: (line: string) => void): () => void {
    return this.client.onStderr(handler);
  }

  onRecovered(handler: RecoveryHandler): () => void {
    this.recoveryHandlers.add(handler);
    return () => this.recoveryHandlers.delete(handler);
  }

  getStatus(): ReturnType<CodexAppServerClient["getStatus"]> {
    return this.client.getStatus();
  }

  private scheduleRestart(): void {
    if (this.restartTask || this.stopping) return;
    this.restartTask = this.restartLoop().finally(() => { this.restartTask = null; });
  }

  private async restartLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopping) {
      const delay = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] ?? 30_000;
      await this.wait(delay);
      if (this.stopping) return;
      try {
        await this.client.start();
        for (const handler of this.recoveryHandlers) await handler();
        return;
      } catch {
        attempt += 1;
      }
    }
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.resolveRetryWait = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.resolveRetryWait = null;
        resolve();
      }, delayMs);
      this.retryTimer.unref();
    });
  }
}
