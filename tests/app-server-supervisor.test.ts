import { describe, expect, it } from "vitest";

import type { CodexAppServerClient, AppServerStatus } from "../src/app-server/client.js";
import { CodexAppServerSupervisor } from "../src/app-server/supervisor.js";

class FakeClient {
  status: AppServerStatus = "stopped";
  starts = 0;
  failedStartsRemaining = 0;
  configuredCommand = "codex";
  private readonly errorHandlers = new Set<(error: Error) => void>();

  async start(): Promise<void> {
    this.starts += 1;
    if (this.failedStartsRemaining > 0) {
      this.failedStartsRemaining -= 1;
      this.status = "error";
      for (const handler of this.errorHandlers) handler(new Error("runtime failed"));
      throw new Error("runtime failed");
    }
    this.status = "ready";
  }
  async stop(): Promise<void> { this.status = "stopped"; }
  getStatus(): AppServerStatus { return this.status; }
  onError(handler: (error: Error) => void) {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }
  fail(): void {
    this.status = "error";
    for (const handler of this.errorHandlers) handler(new Error("process exited"));
  }
  request<T>(): Promise<T> { return Promise.reject(new Error("not used")); }
  notify(): void {}
  respond(): void {}
  respondError(): void {}
  onNotification() { return () => {}; }
  onRequest() { return () => {}; }
  onStderr() { return () => {}; }
  configureProcess(command: string): void { this.configuredCommand = command; }
}

describe("CodexAppServerSupervisor", () => {
  it("restarts an exited server and invokes thread recovery", async () => {
    const client = new FakeClient();
    const supervisor = new CodexAppServerSupervisor(
      client as unknown as CodexAppServerClient,
      { retryDelaysMs: [0] },
    );
    let recoveries = 0;
    supervisor.onRecovered(() => { recoveries += 1; });
    await supervisor.start();

    client.fail();
    await waitFor(() => client.starts === 2 && recoveries === 1);

    expect(supervisor.getStatus()).toBe("ready");
    await supervisor.stop();
  });

  it("switches Runtime after repeated restart failures", async () => {
    const client = new FakeClient();
    const supervisor = new CodexAppServerSupervisor(
      client as unknown as CodexAppServerClient,
      {
        retryDelaysMs: [0],
        runtimeFailureThreshold: 2,
        recoverRuntime: async () => ({ command: "/managed/codex" }),
      },
    );
    await supervisor.start();
    client.failedStartsRemaining = 2;
    client.fail();

    await waitFor(() => client.starts === 4 && client.status === "ready");
    expect(client.configuredCommand).toBe("/managed/codex");
    expect(supervisor.getSupervisorStatus()).toBe("ready");
    await supervisor.stop();
  });

  it("pauses automatic recovery while a planned Runtime switch fails and is rolled back", async () => {
    const client = new FakeClient();
    const supervisor = new CodexAppServerSupervisor(
      client as unknown as CodexAppServerClient,
      { retryDelaysMs: [0] },
    );
    await supervisor.start();
    client.failedStartsRemaining = 1;

    await expect(supervisor.switchRuntime("/bad/codex")).rejects.toThrow("runtime failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.starts).toBe(2);

    await supervisor.switchRuntime("/known-good/codex");
    expect(client.starts).toBe(3);
    expect(client.configuredCommand).toBe("/known-good/codex");
    await supervisor.stop();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for supervisor");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
