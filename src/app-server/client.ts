import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import {
  isErrorResponse,
  isNotification,
  isRequest,
  JsonRpcError,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  JsonRpcTimeoutError,
  parseJsonRpcLine,
} from "./jsonrpc.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import { buildAppServerSpawnSpec, terminateAppServerProcess } from "./process.js";
import { JsonRpcWriteQueue } from "./write-queue.js";

export type AppServerStatus = "stopped" | "starting" | "ready" | "error";

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  requestTimeoutMs?: number;
  clientVersion?: string;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type NotificationHandler = (message: JsonRpcNotification) => void;
type RequestHandler = (message: JsonRpcRequest) => void;
type ErrorHandler = (error: Error) => void;
type LogHandler = (line: string) => void;

export class CodexAppServerClient {
  private readonly options: Required<Pick<CodexAppServerClientOptions,
    "command" | "args" | "env" | "requestTimeoutMs" | "clientVersion">>
    & Pick<CodexAppServerClientOptions, "cwd">;
  private child: ChildProcessWithoutNullStreams | null = null;
  private writeQueue: JsonRpcWriteQueue | null = null;
  private stdoutReader: ReadLineInterface | null = null;
  private stderrReader: ReadLineInterface | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly requestHandlers = new Set<RequestHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly logHandlers = new Set<LogHandler>();
  private status: AppServerStatus = "stopped";
  private stopping = false;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.options = {
      command: options.command ?? "codex",
      args: options.args ?? ["app-server", "--stdio"],
      env: options.env ?? process.env,
      cwd: options.cwd,
      requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
      clientVersion: options.clientVersion ?? "0.1.0",
    };
  }

  async start(): Promise<void> {
    if (this.status === "ready") return;
    if (this.status === "starting") throw new Error("Codex App Server is already starting");

    this.status = "starting";
    this.stopping = false;

    try {
      const spawnSpec = buildAppServerSpawnSpec(this.options.command, this.options.args, {
        env: this.options.env,
        cwd: this.options.cwd,
      });
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.options.env,
        cwd: this.options.cwd,
        windowsHide: spawnSpec.windowsHide,
      });
      this.child = child;
      this.writeQueue = new JsonRpcWriteQueue(child.stdin);
      this.attachProcess(child);
      await this.waitForSpawn(child);

      const params: InitializeParams = {
        clientInfo: {
          name: "codex_feishu",
          title: "Codex Feishu Bridge",
          version: this.options.clientVersion,
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      };
      await this.request("initialize", params);
      this.notify("initialized", {});
      this.status = "ready";
    } catch (error) {
      this.status = "error";
      const normalized = this.normalizeError(error);
      this.rejectPending(normalized);
      this.emitError(normalized);
      if (this.child && !this.child.killed) {
        await terminateAndWait(this.child, true, 2_000);
      }
      throw normalized;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    this.status = "stopped";
    this.rejectPending(new Error("Codex App Server stopped"));
    this.closeReaders();
    this.writeQueue?.close(new Error("Codex App Server stopped"));
    this.writeQueue = null;
    this.child = null;

    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (await terminateAndWait(child, false, 2_000)) return;
    await terminateAndWait(child, true, 2_000);
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.child || this.child.stdin.destroyed) {
      return Promise.reject(new Error("Codex App Server is not running"));
    }

    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcTimeoutError(method, this.options.requestTimeoutMs));
      }, this.options.requestTimeoutMs);
      timeout.unref();

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      void this.write({ id, method, ...(params === undefined ? {} : { params }) }).catch((error: unknown) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(this.normalizeError(error));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    void this.write({ method, ...(params === undefined ? {} : { params }) })
      .catch((error: unknown) => this.emitError(this.normalizeError(error)));
  }

  respond(id: JsonRpcId, result: unknown): void {
    void this.write({ id, result }).catch((error: unknown) => this.emitError(this.normalizeError(error)));
  }

  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    void this.write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } })
      .catch((error: unknown) => this.emitError(this.normalizeError(error)));
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onRequest(handler: RequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onStderr(handler: LogHandler): () => void {
    this.logHandlers.add(handler);
    return () => this.logHandlers.delete(handler);
  }

  getStatus(): AppServerStatus {
    return this.status;
  }

  private attachProcess(child: ChildProcessWithoutNullStreams): void {
    this.stdoutReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutReader.on("line", (line) => this.handleLine(line));
    this.stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.stderrReader.on("line", (line) => {
      for (const handler of this.logHandlers) handler(line);
    });
    child.once("error", (error) => this.handleProcessFailure(error));
    child.once("exit", (code, signal) => {
      if (child !== this.child) return;
      const expected = this.stopping;
      this.child = null;
      this.writeQueue?.close(new Error("Codex App Server exited"));
      this.writeQueue = null;
      this.closeReaders();
      if (expected) {
        this.status = "stopped";
        return;
      }
      const error = new Error(
        `Codex App Server exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})`,
      );
      this.status = "error";
      this.rejectPending(error);
      this.emitError(error);
    });
  }

  private waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    try {
      const message = parseJsonRpcLine(line);
      if (isRequest(message)) {
        if (this.requestHandlers.size === 0) {
          this.respondError(message.id, -32601, `No handler for server request ${message.method}`);
          return;
        }
        for (const handler of this.requestHandlers) handler(message);
        return;
      }
      if (isNotification(message)) {
        for (const handler of this.notificationHandlers) handler(message);
        return;
      }

      const numericId = typeof message.id === "number" ? message.id : Number.NaN;
      const pending = this.pending.get(numericId);
      if (!pending) {
        this.emitError(new JsonRpcError(-32600, `Unexpected or duplicate response id ${String(message.id)}`));
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(numericId);
      if (isErrorResponse(message)) {
        pending.reject(new JsonRpcError(message.error.code, message.error.message, message.error.data));
      } else {
        pending.resolve(message.result);
      }
    } catch (error) {
      this.emitError(this.normalizeError(error));
    }
  }

  private write(message: unknown): Promise<void> {
    if (!this.writeQueue) return Promise.reject(new Error("Codex App Server stdin is not writable"));
    return this.writeQueue.enqueue(message);
  }

  private handleProcessFailure(error: Error): void {
    if (this.stopping) return;
    this.status = "error";
    this.rejectPending(error);
    this.emitError(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }

  private closeReaders(): void {
    this.stdoutReader?.close();
    this.stderrReader?.close();
    this.stdoutReader = null;
    this.stderrReader = null;
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  private normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function terminateAndWait(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let onExit: (() => void) | undefined;
  const exited = new Promise<boolean>((resolve) => {
    onExit = () => resolve(true);
    child.once("exit", onExit);
  });
  await terminateAppServerProcess(child, force);
  if (child.exitCode !== null || child.signalCode !== null) {
    if (onExit) child.off("exit", onExit);
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([exited, timedOut]);
  if (timer) clearTimeout(timer);
  if (onExit) child.off("exit", onExit);
  return result;
}
