import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

import { extractRuntimeArchive } from "./archive.js";
import { RuntimeChecksumError, RuntimeDownloadError, RuntimeNotFoundError } from "./errors.js";
import { RuntimeManifestStore } from "./manifest.js";
import type { RuntimeInstaller } from "./manager.js";
import { resolveTargetTriple, runtimeExecutableName } from "./paths.js";
import { CodexReleaseClient, isAllowedDownloadRedirect, type SelectedReleaseAsset } from "./release-client.js";
import type { ResolvedRuntime, RuntimeManifest, RuntimeUpdate, RuntimeUpdateChannel } from "./types.js";
import { RuntimeVerifier } from "./verifier.js";

export interface RuntimeDownloaderOptions {
  managedRuntimeDir: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  fetch?: typeof fetch;
  releaseClient?: CodexReleaseClient;
  verifier?: RuntimeVerifier;
  maxDownloadBytes?: number;
  maxAttempts?: number;
}

export class RuntimeDownloader implements RuntimeInstaller {
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly fetchImplementation: typeof fetch;
  private readonly releases: CodexReleaseClient;
  private readonly verifier: RuntimeVerifier;
  private readonly manifests: RuntimeManifestStore;
  private readonly maxDownloadBytes: number;
  private readonly maxAttempts: number;

  constructor(options: RuntimeDownloaderOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetchImplementation = options.fetch ?? fetch;
    this.releases = options.releaseClient ?? new CodexReleaseClient({ fetch: this.fetchImplementation });
    this.verifier = options.verifier ?? new RuntimeVerifier({ platform: this.platform });
    this.manifests = new RuntimeManifestStore(options.managedRuntimeDir);
    this.maxDownloadBytes = options.maxDownloadBytes ?? 200 * 1024 * 1024;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async installLatest(channel: RuntimeUpdateChannel): Promise<ResolvedRuntime> {
    const targetTriple = resolveTargetTriple(this.platform, this.arch);
    const asset = await this.releases.latest(channel, targetTriple);
    if (asset.size > this.maxDownloadBytes) {
      throw new RuntimeDownloadError(`Runtime asset exceeds ${this.maxDownloadBytes} bytes`);
    }
    const existing = await this.manifests.readVersion(asset.version);
    if (existing) {
      try {
        const resolved = await this.verifyInstalled(existing);
        await this.manifests.setCurrent(existing);
        return resolved;
      } catch {
        await rename(
          this.manifests.versionDirectory(asset.version),
          `${this.manifests.versionDirectory(asset.version)}.invalid-${Date.now()}`,
        );
      }
    }

    const downloads = join(this.manifests.rootDirectory, "downloads");
    await mkdir(downloads, { recursive: true });
    const temporaryDirectory = await mkdtemp(join(downloads, "install-"));
    try {
      const archive = await this.download(asset);
      const actualHash = createHash("sha256").update(archive).digest("hex");
      if (actualHash !== asset.sha256) {
        throw new RuntimeChecksumError(`Runtime SHA-256 mismatch: expected ${asset.sha256}, received ${actualHash}`);
      }
      const extracted = join(temporaryDirectory, "extracted");
      await extractRuntimeArchive(archive, asset.name, extracted);
      const discoveredExecutable = await findRuntimeExecutable(extracted, this.platform);
      if (this.platform !== "win32") await chmod(discoveredExecutable, 0o755);
      const verification = await this.verifier.verify({
        source: "downloaded",
        executablePath: discoveredExecutable,
        version: asset.version,
      });
      if (!verification.ok || !verification.version) {
        throw new RuntimeDownloadError(`Downloaded Runtime verification failed: ${verification.reason ?? "unknown error"}`);
      }

      const executableRelativePath = relative(extracted, discoveredExecutable);
      if (!executableRelativePath || executableRelativePath.startsWith("..") || isAbsolute(executableRelativePath)) {
        throw new RuntimeDownloadError("Runtime executable is outside the extracted release directory");
      }
      const executablePath = join(this.manifests.versionDirectory(asset.version), executableRelativePath);
      const now = new Date().toISOString();
      const manifest: RuntimeManifest = {
        version: verification.version,
        source: "downloaded",
        executablePath,
        platform: this.platform,
        arch: this.arch,
        targetTriple,
        sha256: asset.sha256,
        installedAt: now,
        lastValidatedAt: now,
        appServerSupported: verification.supportsAppServer,
      };
      await writeStageManifest(extracted, manifest);
      await mkdir(join(this.manifests.rootDirectory, "versions"), { recursive: true });
      await rename(extracted, this.manifests.versionDirectory(asset.version));
      await this.manifests.setCurrent(manifest);
      return { source: "downloaded", executablePath, version: manifest.version, verification };
    } catch (error) {
      throw error instanceof RuntimeDownloadError || error instanceof RuntimeChecksumError
        ? error
        : new RuntimeDownloadError("Unable to install Codex Runtime", { cause: error });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async checkForUpdates(channel: RuntimeUpdateChannel): Promise<RuntimeUpdate | null> {
    const latest = await this.releases.latest(channel, resolveTargetTriple(this.platform, this.arch));
    const current = await this.manifests.readCurrent();
    if (current?.version === latest.version) return null;
    return { ...(current?.version ? { currentVersion: current.version } : {}), latestVersion: latest.version };
  }

  async rollback(): Promise<ResolvedRuntime> {
    const current = await this.manifests.readCurrent();
    let directories: string[];
    try {
      directories = await readdir(join(this.manifests.rootDirectory, "versions"));
    } catch {
      throw new RuntimeNotFoundError("No managed Runtime is available for rollback");
    }
    const manifests = (await Promise.all(directories.map((version) => this.manifests.readVersion(version).catch(() => null))))
      .filter((manifest): manifest is RuntimeManifest => Boolean(manifest))
      .filter((manifest) => manifest.executablePath !== current?.executablePath)
      .sort((left, right) => right.installedAt.localeCompare(left.installedAt));
    for (const manifest of manifests) {
      try {
        const resolved = await this.verifyInstalled(manifest);
        await this.manifests.setCurrent(manifest);
        return resolved;
      } catch {
        continue;
      }
    }
    throw new RuntimeNotFoundError("No previous healthy managed Runtime is available for rollback");
  }

  private async download(asset: SelectedReleaseAsset): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImplementation(asset.downloadUrl, {
          redirect: "follow",
          signal: AbortSignal.timeout(60_000),
          headers: { "User-Agent": "codex-feishu-runtime-manager" },
        });
        if (!response.ok) throw new RuntimeDownloadError(`Runtime download returned HTTP ${response.status}`);
        if (!isAllowedDownloadRedirect(response.url || asset.downloadUrl)) {
          throw new RuntimeDownloadError(`Runtime download redirected to a non-official host: ${response.url}`);
        }
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (contentLength > this.maxDownloadBytes) throw new RuntimeDownloadError("Runtime download is too large");
        const buffer = await readResponseBody(response, this.maxDownloadBytes);
        if (buffer.length !== asset.size) {
          throw new RuntimeDownloadError(`Runtime download size mismatch: expected ${asset.size}, received ${buffer.length}`);
        }
        return buffer;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < this.maxAttempts) await delay(250 * (2 ** attempt));
      }
    }
    throw new RuntimeDownloadError(`Runtime download failed after ${this.maxAttempts} attempts`, { cause: lastError });
  }

  private async verifyInstalled(manifest: RuntimeManifest): Promise<ResolvedRuntime> {
    await access(manifest.executablePath, this.platform === "win32" ? constants.F_OK : constants.X_OK);
    const verification = await this.verifier.verify({
      source: "managed",
      executablePath: manifest.executablePath,
      version: manifest.version,
      metadata: { manifest },
    });
    if (!verification.ok || !verification.version) {
      throw new RuntimeDownloadError(`Managed Runtime ${manifest.version} is invalid: ${verification.reason ?? "unknown error"}`);
    }
    return {
      source: "managed",
      executablePath: manifest.executablePath,
      version: verification.version,
      metadata: { manifest },
      verification,
    };
  }
}

async function findRuntimeExecutable(root: string, platform: NodeJS.Platform): Promise<string> {
  const expectedExtension = platform === "win32" ? ".exe" : "";
  const pending = [root];
  while (pending.length) {
    const directory = pending.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && (basename(entry.name).startsWith("codex-")
        || basename(entry.name) === runtimeExecutableName(platform))
        && (platform !== "win32" || entry.name.toLowerCase().endsWith(expectedExtension))) return path;
    }
  }
  throw new RuntimeDownloadError("Runtime archive did not contain a Codex executable");
}

async function writeStageManifest(stage: string, manifest: RuntimeManifest): Promise<void> {
  await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readResponseBody(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) throw new RuntimeDownloadError("Runtime download is too large");
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
