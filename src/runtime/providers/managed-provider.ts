import { readdir } from "node:fs/promises";

import { RuntimeManifestStore } from "../manifest.js";
import type { RuntimeCandidate, RuntimeManifest, RuntimeProvider } from "../types.js";

export class ManagedRuntimeProvider implements RuntimeProvider {
  readonly name = "managed";
  private readonly manifests: RuntimeManifestStore;

  constructor(managedRuntimeDir: string) {
    this.manifests = new RuntimeManifestStore(managedRuntimeDir);
  }

  async discover(): Promise<RuntimeCandidate[]> {
    const manifests: RuntimeManifest[] = [];
    const current = await this.manifests.readCurrent();
    if (current) manifests.push(current);
    try {
      const versions = await readdir(`${this.manifests.rootDirectory}/versions`, { withFileTypes: true });
      for (const entry of versions.filter((candidate) => candidate.isDirectory())) {
        const manifest = await this.manifests.readVersion(entry.name).catch(() => null);
        if (manifest && manifest.executablePath !== current?.executablePath) manifests.push(manifest);
      }
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    }
    return manifests.map((manifest) => ({
      source: manifest.source === "downloaded" ? "managed" : manifest.source,
      executablePath: manifest.executablePath,
      version: manifest.version,
      metadata: { manifest },
    }));
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
