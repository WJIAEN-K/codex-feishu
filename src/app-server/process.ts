import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { win32 } from "node:path";

export interface AppServerSpawnSpec {
  command: string;
  args: string[];
  windowsHide: boolean;
}

export interface WindowsTerminationSpec {
  command: "taskkill.exe";
  args: string[];
}

interface SpawnSpecOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  isFile?: (path: string) => boolean;
}

export function buildAppServerSpawnSpec(
  command: string,
  args: string[],
  options: SpawnSpecOptions = {},
): AppServerSpawnSpec {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args: [...args], windowsHide: false };

  const env = options.env ?? process.env;
  const executable = resolveWindowsExecutable(
    command,
    options.cwd ?? process.cwd(),
    env,
    options.isFile ?? fileExists,
  );
  if (!/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [...args], windowsHide: true };
  }

  const comspec = getEnv(env, "ComSpec") || "cmd.exe";
  const commandLine = [executable, ...args].map(quoteCmdArgument).join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", commandLine],
    windowsHide: true,
  };
}

export function terminateAppServerProcess(
  child: ChildProcessWithoutNullStreams,
  force = false,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32" || typeof child.pid !== "number") {
    child.kill(force ? "SIGKILL" : "SIGTERM");
    return Promise.resolve();
  }

  const spec = buildWindowsTerminationSpec(child.pid, force);
  return new Promise<void>((resolveTermination) => {
    const killer = spawn(
      spec.command,
      spec.args,
      { stdio: "ignore", windowsHide: true },
    );
    let settled = false;
    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!succeeded && child.exitCode === null && child.signalCode === null) {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      }
      resolveTermination();
    };
    const timeout = setTimeout(() => {
      killer.kill();
      finish(false);
    }, 2_000);
    killer.once("error", () => finish(false));
    killer.once("exit", (code) => finish(code === 0));
  });
}

export function buildWindowsTerminationSpec(pid: number, force = false): WindowsTerminationSpec {
  return {
    command: "taskkill.exe",
    args: ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
  };
}

function resolveWindowsExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean,
): string {
  const hasDirectory = win32.isAbsolute(command)
    || command.includes("/")
    || command.includes("\\");
  const directories = hasDirectory
    ? [""]
    : [cwd, ...getEnv(env, "Path").split(win32.delimiter).filter(Boolean)];
  const extensions = win32.extname(command)
    ? [""]
    : getWindowsExtensions(env);

  for (const directory of directories) {
    const base = directory ? win32.resolve(directory, command) : win32.resolve(cwd, command);
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      if (isFile(candidate)) return candidate;
    }
  }
  return command;
}

function getWindowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = getEnv(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD";
  return configured
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
}

function getEnv(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] ?? "" : "";
}

function quoteCmdArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(value)) return value;
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
