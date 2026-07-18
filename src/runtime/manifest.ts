import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RuntimeManifest } from "./types.js";

export class RuntimeManifestStore {
  constructor(readonly rootDirectory: string) {}

  get currentPath(): string {
    return join(this.rootDirectory, "current.json");
  }

  versionDirectory(version: string): string {
    return join(this.rootDirectory, "versions", safeVersion(version));
  }

  manifestPath(version: string): string {
    return join(this.versionDirectory(version), "manifest.json");
  }

  async readCurrent(): Promise<RuntimeManifest | null> {
    return readManifestOptional(this.currentPath);
  }

  async readVersion(version: string): Promise<RuntimeManifest | null> {
    return readManifestOptional(this.manifestPath(version));
  }

  async writeVersion(manifest: RuntimeManifest): Promise<void> {
    await writeJsonAtomic(this.manifestPath(manifest.version), manifest);
  }

  async setCurrent(manifest: RuntimeManifest): Promise<void> {
    await writeJsonAtomic(this.currentPath, manifest);
  }
}

export function validateRuntimeManifest(value: unknown): RuntimeManifest {
  if (!isRecord(value)) throw new Error("Runtime manifest must be an object");
  const requiredStrings = [
    "version", "source", "executablePath", "platform", "arch", "targetTriple",
    "installedAt", "lastValidatedAt",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`Runtime manifest is missing ${key}`);
  }
  if (!(["configured", "path", "desktop-bundled", "managed", "downloaded"] as const)
    .includes(value.source as RuntimeManifest["source"])) {
    throw new Error(`Runtime manifest has invalid source: ${String(value.source)}`);
  }
  if (typeof value.appServerSupported !== "boolean") {
    throw new Error("Runtime manifest is missing appServerSupported");
  }
  if (value.sha256 !== undefined && typeof value.sha256 !== "string") {
    throw new Error("Runtime manifest sha256 must be a string");
  }
  return value as unknown as RuntimeManifest;
}

async function readManifestOptional(path: string): Promise<RuntimeManifest | null> {
  try {
    return validateRuntimeManifest(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

function safeVersion(version: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error(`Unsafe Runtime version: ${version}`);
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
