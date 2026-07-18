import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

import { CodexAppServerClient } from "../app-server/client.js";
import { buildAppServerSpawnSpec } from "../app-server/process.js";
import type { RuntimeCandidate, RuntimeVerification } from "./types.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface RuntimeVerifierOptions {
  commandTimeoutMs?: number;
  initializeTimeoutMs?: number;
  commandRunner?: (executable: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
  deepVerifier?: (candidate: RuntimeCandidate, timeoutMs: number) => Promise<boolean>;
  platform?: NodeJS.Platform;
}

export class RuntimeVerifier {
  private readonly commandTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly commandRunner: NonNullable<RuntimeVerifierOptions["commandRunner"]>;
  private readonly deepVerifier: NonNullable<RuntimeVerifierOptions["deepVerifier"]>;
  private readonly platform: NodeJS.Platform;

  constructor(options: RuntimeVerifierOptions = {}) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 15_000;
    this.platform = options.platform ?? process.platform;
    this.commandRunner = options.commandRunner
      ?? ((executable, args, timeoutMs) => runCommand(executable, args, timeoutMs, this.platform));
    this.deepVerifier = options.deepVerifier ?? verifyAppServerHandshake;
  }

  async verify(candidate: RuntimeCandidate): Promise<RuntimeVerification> {
    const failed = (reason: string, version?: string, supportsAppServer = false): RuntimeVerification => ({
      ok: false,
      ...(version ? { version } : {}),
      supportsAppServer,
      initializeSucceeded: false,
      accountReadSucceeded: false,
      reason,
    });
    try {
      if (!(await stat(candidate.executablePath)).isFile()) return failed("Runtime path is not a regular file");
      await access(candidate.executablePath, this.platform === "win32" ? constants.F_OK : constants.X_OK);
    } catch (error) {
      return failed(`Runtime is not executable: ${errorMessage(error)}`);
    }

    let version: string | undefined;
    try {
      const result = await this.commandRunner(candidate.executablePath, ["--version"], this.commandTimeoutMs);
      version = parseRuntimeVersion(`${result.stdout}\n${result.stderr}`);
      if (!version) return failed("Runtime --version did not return a recognizable version");
    } catch (error) {
      return failed(`Runtime --version failed: ${errorMessage(error)}`);
    }

    try {
      await this.commandRunner(candidate.executablePath, ["app-server", "--help"], this.commandTimeoutMs);
    } catch (error) {
      return failed(`Runtime does not support app-server: ${errorMessage(error)}`, version);
    }

    try {
      const accountReadSucceeded = await this.deepVerifier(candidate, this.initializeTimeoutMs);
      return {
        ok: true,
        version,
        supportsAppServer: true,
        initializeSucceeded: true,
        accountReadSucceeded,
      };
    } catch (error) {
      return failed(`App Server handshake failed: ${errorMessage(error)}`, version, true);
    }
  }
}

export function parseRuntimeVersion(output: string): string | undefined {
  return output.match(/(?:codex(?:-cli)?\s+)?(?:rust-v|v)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)?.[1];
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const spec = buildAppServerSpawnSpec(executable, args, { platform });
    const child = spawn(spec.command, spec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: spec.windowsHide,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`Runtime command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`Runtime command exited with ${signal ?? `code ${code ?? "unknown"}`}: ${stderr.trim()}`));
    });
  });
}

async function verifyAppServerHandshake(candidate: RuntimeCandidate, timeoutMs: number): Promise<boolean> {
  const client = new CodexAppServerClient({
    command: candidate.executablePath,
    args: ["app-server", "--stdio"],
    requestTimeoutMs: timeoutMs,
  });
  try {
    await client.start();
    await client.request("account/read", { refreshToken: false });
    return true;
  } finally {
    await client.stop().catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
