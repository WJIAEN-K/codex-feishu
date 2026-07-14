import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/app-server/client.js";
import { JsonRpcError, JsonRpcTimeoutError } from "../src/app-server/jsonrpc.js";

const clients: CodexAppServerClient[] = [];

function fakeServer(handlerSource: string, timeoutMs = 250): CodexAppServerClient {
  const script = `
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ id: message.id, result: { serverInfo: { name: "fake" } } });
        return;
      }
      ${handlerSource}
    });
  `;
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: ["-e", script],
    requestTimeoutMs: timeoutMs,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe("CodexAppServerClient", () => {
  it("performs initialize/initialized and exchanges requests and notifications", async () => {
    const notifications: string[] = [];
    const client = fakeServer(`
      if (message.method === "initialized") {
        send({ method: "server/ready", params: { ok: true } });
      } else if (message.method === "echo") {
        send({ id: message.id, result: message.params });
      }
    `);
    client.onNotification((message) => notifications.push(message.method));

    await client.start();
    const result = await client.request<{ value: number }>("echo", { value: 42 });

    expect(client.getStatus()).toBe("ready");
    expect(result).toEqual({ value: 42 });
    expect(notifications).toContain("server/ready");
  });

  it("rejects JSON-RPC error responses", async () => {
    const client = fakeServer(`
      if (message.method === "fail") {
        send({ id: message.id, error: { code: 123, message: "denied", data: { reason: "test" } } });
      }
    `);
    await client.start();

    const error = await client.request("fail").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JsonRpcError);
    expect(error).toMatchObject({ code: 123, message: "denied", data: { reason: "test" } });
  });

  it("times out unanswered requests", async () => {
    const client = fakeServer("", 30);
    await client.start();
    await expect(client.request("ignored")).rejects.toBeInstanceOf(JsonRpcTimeoutError);
  });

  it("rejects pending requests when App Server exits", async () => {
    const errors: Error[] = [];
    const client = fakeServer(`
      if (message.method === "exit-now") setTimeout(() => process.exit(7), 5);
    `);
    client.onError((error) => errors.push(error));
    await client.start();

    await expect(client.request("exit-now")).rejects.toThrow("exited unexpectedly");
    expect(client.getStatus()).toBe("error");
    expect(errors.some((error) => error.message.includes("code 7"))).toBe(true);
  });

  it("reports malformed JSON and duplicate responses without crashing", async () => {
    const errors: Error[] = [];
    const client = fakeServer(`
      if (message.method === "initialized") {
        process.stdout.write("not-json\\n");
      } else if (message.method === "twice") {
        send({ id: message.id, result: "first" });
        send({ id: message.id, result: "second" });
      }
    `);
    client.onError((error) => errors.push(error));
    await client.start();
    await expect(client.request("twice")).resolves.toBe("first");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors.some((error) => error.message.includes("Unable to parse"))).toBe(true);
    expect(errors.some((error) => error.message.includes("duplicate response"))).toBe(true);
  });
});
