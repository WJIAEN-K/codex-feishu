import { describe, expect, it, vi } from "vitest";

import { CodexAuthBootstrap, type AuthClient } from "../src/auth/bootstrap.js";
import type { JsonRpcNotification } from "../src/app-server/jsonrpc.js";

class FakeAuthClient {
  account: { type: "chatgpt"; email: string; planType: "plus" } | null = null;
  readonly request = vi.fn(async <T>(method: string): Promise<T> => {
    if (method === "account/read") return { account: this.account, requiresOpenaiAuth: true } as T;
    if (method === "account/login/start") {
      queueMicrotask(() => {
        this.account = { type: "chatgpt", email: "demo@example.com", planType: "plus" };
        this.emit({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } });
      });
      return {
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      } as T;
    }
    if (method === "account/rateLimits/read") return {} as T;
    throw new Error(`Unexpected method ${method}`);
  });
  private readonly handlers = new Set<(message: JsonRpcNotification) => void>();
  onNotification(handler: (message: JsonRpcNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(message: JsonRpcNotification): void {
    for (const handler of this.handlers) handler(message);
  }
}

describe("CodexAuthBootstrap", () => {
  it("reuses an existing account without starting login", async () => {
    const client = new FakeAuthClient();
    client.account = { type: "chatgpt", email: "ready@example.com", planType: "plus" };
    const result = await new CodexAuthBootstrap(client as unknown as AuthClient).ensureAuthenticated();

    expect(result.account).toMatchObject({ email: "ready@example.com" });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("starts device-code login and waits for completion when authentication is absent", async () => {
    const client = new FakeAuthClient();
    const onLoginPrompt = vi.fn();
    const result = await new CodexAuthBootstrap(client as unknown as AuthClient)
      .ensureAuthenticated({ onLoginPrompt, timeoutMs: 1_000 });

    expect(onLoginPrompt).toHaveBeenCalledWith({
      strategy: "device-code",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    });
    expect(result.account).toMatchObject({ email: "demo@example.com" });
    expect(client.request).toHaveBeenCalledWith("account/login/start", { type: "chatgptDeviceCode" });
  });
});
