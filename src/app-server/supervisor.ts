import type { CodexAppServerClient } from "./client.js";
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "./jsonrpc.js";

type RecoveryHandler = () => Promise<void> | void;

export interface AppServerSupervisorOptions {
  retryDelaysMs?: readonly number[];
  runtimeFailureThreshold?: number;
  recoverRuntime?: () => Promise<{ command: string; args?: string[] }>;
}

export type SupervisorStatus =
  | "resolving_runtime"
  | "starting"
  | "ready"
  | "restarting"
  | "error"
  | "stopped";

/** Keeps a single App Server client alive and restores application state after a restart. */
export class CodexAppServerSupervisor {
  private readonly retryDelaysMs: readonly number[];
  private readonly recoveryHandlers = new Set<RecoveryHandler>();
  private restartTask: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveRetryWait: (() => void) | null = null;
  private stopping = true;
  private status: SupervisorStatus = "stopped";
  private readonly runtimeFailureThreshold: number;
  private readonly recoverRuntime?: AppServerSupervisorOptions["recoverRuntime"];
  /** Serializes all process mutations so recovery cannot race an explicit Runtime switch. */
  private lifecycleTask: Promise<void> = Promise.resolve();
  /** Covers queued switches too, so automatic recovery remains paused through a caller rollback. */
  private plannedRuntimeSwitches = 0;

  constructor(
    private readonly client: CodexAppServerClient,
    options: AppServerSupervisorOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
    this.runtimeFailureThreshold = options.runtimeFailureThreshold ?? 2;
    this.recoverRuntime = options.recoverRuntime;
    if (this.retryDelaysMs.length === 0 || this.retryDelaysMs.some((delay) => delay < 0)) {
      throw new Error("App Server retry delays must contain non-negative values");
    }
    if (!Number.isSafeInteger(this.runtimeFailureThreshold) || this.runtimeFailureThreshold <= 0) {
      throw new Error("Runtime failure threshold must be a positive integer");
    }
    this.client.onError(() => {
      if (!this.stopping && !this.isRuntimeSwitchPlanned && this.client.getStatus() === "error") {
        this.scheduleRestart();
      }
    });
  }

  async start(): Promise<void> {
    if (!this.stopping && this.client.getStatus() === "ready") return;
    this.stopping = false;
    await this.runLifecycleOperation(async () => {
      this.status = "starting";
      try {
        await this.client.start();
        this.status = "ready";
      } catch (error) {
        this.status = "error";
        throw error;
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.status = "stopped";
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.resolveRetryWait?.();
    this.resolveRetryWait = null;
    await this.lifecycleTask.catch(() => undefined);
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

  getSupervisorStatus(): SupervisorStatus {
    return this.status;
  }

  async switchRuntime(command: string, args: string[] = ["app-server", "--stdio"]): Promise<void> {
    if (this.stopping) throw new Error("Cannot switch Runtime while App Server is stopped");
    this.plannedRuntimeSwitches += 1;
    try {
      await this.runLifecycleOperation(async () => {
        if (this.stopping) throw new Error("Cannot switch Runtime while App Server is stopped");
        this.status = "restarting";
        await this.client.stop();
        this.client.configureProcess(command, args);
        try {
          await this.client.start();
          for (const handler of this.recoveryHandlers) await handler();
          this.status = "ready";
        } catch (error) {
          this.status = "error";
          throw error;
        }
      });
    } finally {
      this.plannedRuntimeSwitches -= 1;
    }
  }

  private scheduleRestart(): void {
    if (this.restartTask || this.stopping || this.isRuntimeSwitchPlanned) return;
    this.status = "restarting";
    this.restartTask = this.restartLoop().finally(() => { this.restartTask = null; });
  }

  private async restartLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopping) {
      if (this.isRuntimeSwitchPlanned) {
        await this.wait(25);
        continue;
      }
      const delay = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] ?? 30_000;
      await this.wait(delay);
      if (this.stopping) return;
      const recovered = await this.runLifecycleOperation(async () => {
        if (this.stopping || this.isRuntimeSwitchPlanned) return false;
        try {
          await this.client.start();
          this.status = "ready";
          for (const handler of this.recoveryHandlers) await handler();
          return true;
        } catch {
          attempt += 1;
          if (this.recoverRuntime && attempt % this.runtimeFailureThreshold === 0) {
            try {
              this.status = "resolving_runtime";
              const runtime = await this.recoverRuntime();
              this.client.configureProcess(runtime.command, runtime.args);
              this.status = "restarting";
            } catch {
              this.status = "error";
            }
          }
          return false;
        }
      });
      if (recovered) return;
    }
  }

  private get isRuntimeSwitchPlanned(): boolean {
    return this.plannedRuntimeSwitches > 0;
  }

  private runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lifecycleTask.then(operation, operation);
    this.lifecycleTask = task.then(() => undefined, () => undefined);
    return task;
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
