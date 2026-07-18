import type { JsonRpcNotification } from "../app-server/jsonrpc.js";
import type { GetAccountResponse } from "../app-server/generated/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "../app-server/generated/v2/LoginAccountResponse.js";

export type LoginStrategy = "device-code" | "browser";

export interface AuthClient {
  request<T>(method: string, params?: unknown): Promise<T>;
  onNotification(handler: (message: JsonRpcNotification) => void): () => void;
}

export interface LoginPrompt {
  strategy: LoginStrategy;
  url: string;
  userCode?: string;
}

export interface AuthBootstrapOptions {
  strategy?: LoginStrategy;
  timeoutMs?: number;
  onLoginPrompt?: (prompt: LoginPrompt) => void | Promise<void>;
}

export class CodexAuthBootstrap {
  constructor(private readonly client: AuthClient) {}

  readAccount(): Promise<GetAccountResponse> {
    return this.client.request<GetAccountResponse>("account/read", { refreshToken: false });
  }

  async ensureAuthenticated(options: AuthBootstrapOptions = {}): Promise<GetAccountResponse> {
    const current = await this.readAccount();
    if (current.account || !current.requiresOpenaiAuth) return current;

    const strategy = options.strategy ?? "device-code";
    const completed = this.waitForLogin(options.timeoutMs ?? 10 * 60_000);
    try {
      const response = strategy === "device-code"
        ? await this.client.request<LoginAccountResponse>("account/login/start", { type: "chatgptDeviceCode" })
        : await this.client.request<LoginAccountResponse>("account/login/start", {
          type: "chatgpt",
          useHostedLoginSuccessPage: true,
          appBrand: "codex",
        });
      const prompt = loginPrompt(response);
      if (prompt) await options.onLoginPrompt?.(prompt);
      await completed.promise;
    } catch (error) {
      completed.cancel();
      throw error;
    }
    const account = await this.readAccount();
    if (!account.account && account.requiresOpenaiAuth) throw new Error("Codex login completed without an account");
    await this.client.request("account/rateLimits/read").catch(() => undefined);
    return account;
  }

  private waitForLogin(timeoutMs: number): { promise: Promise<void>; cancel(): void } {
    let cancel = (): void => {};
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      const unsubscribe = this.client.onNotification((message) => {
        if (message.method !== "account/login/completed") return;
        const params = isRecord(message.params) ? message.params : {};
        if (params.success === true) finish();
        else finish(new Error(typeof params.error === "string" ? params.error : "Codex login failed"));
      });
      const timer = setTimeout(() => finish(new Error("Codex login timed out")), timeoutMs);
      timer.unref();
      cancel = () => finish();
    });
    return { promise, cancel };
  }
}

export function formatAccount(account: GetAccountResponse["account"]): string {
  if (!account) return "未登录";
  if (account.type === "chatgpt") {
    return `${account.email ?? "ChatGPT"} (${account.planType})`;
  }
  if (account.type === "apiKey") return "OpenAI API Key";
  return "Amazon Bedrock";
}

function loginPrompt(response: LoginAccountResponse): LoginPrompt | null {
  if (response.type === "chatgptDeviceCode") {
    return { strategy: "device-code", url: response.verificationUrl, userCode: response.userCode };
  }
  if (response.type === "chatgpt") return { strategy: "browser", url: response.authUrl };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
