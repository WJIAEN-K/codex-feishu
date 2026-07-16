import { readFile } from "node:fs/promises";

import type { AppConfig } from "../config/file.js";

interface BrokerState {
  endpoint: string;
  token: string;
  pid: number;
}

export function brokerStatePath(config: AppConfig): string {
  return `${config.sessionDatabasePath}.hook-broker.json`;
}

export async function runPermissionHook(config: AppConfig): Promise<void> {
  const input = await readStdin();
  let state: BrokerState;
  try {
    state = JSON.parse(await readFile(brokerStatePath(config), "utf8")) as BrokerState;
  } catch {
    process.stdout.write("{}");
    return;
  }
  if (!validBrokerState(state) || !processIsAlive(state.pid)) {
    process.stdout.write("{}");
    return;
  }
  try {
    const response = await fetch(state.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: input,
      signal: AbortSignal.timeout(Math.min(config.localSync.approvalTimeoutMs + 5_000, 310_000)),
    });
    process.stdout.write(response.ok ? await response.text() : "{}");
  } catch {
    process.stdout.write("{}");
  }
}

function validBrokerState(state: BrokerState): boolean {
  if (!state || typeof state.endpoint !== "string" || typeof state.token !== "string" || !Number.isInteger(state.pid)) {
    return false;
  }
  try {
    const endpoint = new URL(state.endpoint);
    return endpoint.protocol === "http:"
      && endpoint.hostname === "127.0.0.1"
      && endpoint.pathname === "/permission"
      && endpoint.username === ""
      && endpoint.password === "";
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("Permission hook input exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
