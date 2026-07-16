import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

interface HooksFile {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>>;
  [key: string]: unknown;
}

export async function installCodexPermissionHook(configPath: string, hooksPath = join(homedir(), ".codex", "hooks.json")): Promise<{ path: string; changed: boolean }> {
  let json: HooksFile = {};
  try {
    json = JSON.parse(await readFile(hooksPath, "utf8")) as HooksFile;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const entryPath = resolve(process.argv[1] ?? "dist/index.js");
  const command = `${shellQuote(process.execPath)} ${shellQuote(entryPath)} hook permission --config ${shellQuote(configPath)}`;
  json.hooks ??= {};
  const groups = json.hooks.PermissionRequest ??= [];
  const existing = groups.flatMap((group) => group.hooks ?? []).find((hook) => (
    typeof hook.command === "string" &&
    hook.command.includes(" hook permission ") &&
    hook.command.includes(shellQuote(configPath))
  ));
  if (existing?.command === command) return { path: hooksPath, changed: false };
  if (existing) {
    existing.command = command;
    existing.timeout = 86_400;
    await writeHooksFile(hooksPath, json);
    return { path: hooksPath, changed: true };
  }
  groups.push({
    matcher: "*",
    hooks: [{ type: "command", command, timeout: 86_400 }],
  });
  await writeHooksFile(hooksPath, json);
  return { path: hooksPath, changed: true };
}

export async function uninstallCodexPermissionHook(
  configPath: string,
  hooksPath = join(homedir(), ".codex", "hooks.json"),
): Promise<{ path: string; changed: boolean }> {
  let json: HooksFile;
  try {
    json = JSON.parse(await readFile(hooksPath, "utf8")) as HooksFile;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { path: hooksPath, changed: false };
    throw error;
  }
  const groups = json.hooks?.PermissionRequest;
  if (!groups) return { path: hooksPath, changed: false };
  let changed = false;
  const retainedGroups = groups.flatMap((group) => {
    const hooks = (group.hooks ?? []).filter((hook) => {
      const owned = typeof hook.command === "string"
        && hook.command.includes(" hook permission ")
        && hook.command.includes(shellQuote(configPath));
      if (owned) changed = true;
      return !owned;
    });
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
  if (!changed) return { path: hooksPath, changed: false };
  if (retainedGroups.length > 0) json.hooks!.PermissionRequest = retainedGroups;
  else delete json.hooks!.PermissionRequest;
  await writeHooksFile(hooksPath, json);
  return { path: hooksPath, changed: true };
}

async function writeHooksFile(hooksPath: string, json: HooksFile): Promise<void> {
  await mkdir(dirname(hooksPath), { recursive: true, mode: 0o700 });
  const temporary = `${hooksPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, hooksPath);
  await chmod(hooksPath, 0o600);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
