import { homedir } from "node:os";

import { RuntimeNotFoundError } from "./errors.js";
import { ConfiguredRuntimeProvider } from "./providers/configured-provider.js";
import { MacDesktopRuntimeProvider } from "./providers/desktop-macos-provider.js";
import { WindowsDesktopRuntimeProvider } from "./providers/desktop-windows-provider.js";
import { ManagedRuntimeProvider } from "./providers/managed-provider.js";
import { PathRuntimeProvider } from "./providers/path-provider.js";
import { supportsRuntimeDownload } from "./paths.js";
import type {
  ResolvedRuntime,
  RuntimeCandidate,
  RuntimeManagerOptions,
  RuntimeProvider,
  RuntimeUpdate,
} from "./types.js";
import { RuntimeVerifier } from "./verifier.js";

export interface RuntimeInstaller {
  installLatest(channel: RuntimeManagerOptions["updateChannel"]): Promise<ResolvedRuntime>;
  checkForUpdates(channel: RuntimeManagerOptions["updateChannel"]): Promise<RuntimeUpdate | null>;
  rollback(): Promise<ResolvedRuntime>;
}

export interface RuntimeManagerDependencies {
  providers?: RuntimeProvider[];
  verifier?: RuntimeVerifier;
  installer?: RuntimeInstaller;
}

export class RuntimeManager {
  private readonly options: Required<Pick<RuntimeManagerOptions,
    "mode" | "autoDownload" | "allowDesktopRuntime" | "updateChannel" |
    "preferManagedRuntimeOnWindows" | "platform" | "arch" | "env" | "homeDirectory">>
    & Pick<RuntimeManagerOptions, "configuredPath" | "managedRuntimeDir">;
  private readonly providers: RuntimeProvider[];
  private readonly verifier: RuntimeVerifier;
  private readonly installer?: RuntimeInstaller;
  private rejectedPaths = new Set<string>();

  constructor(options: RuntimeManagerOptions, dependencies: RuntimeManagerDependencies = {}) {
    this.options = {
      mode: options.mode ?? "auto",
      configuredPath: options.configuredPath,
      autoDownload: options.autoDownload,
      allowDesktopRuntime: options.allowDesktopRuntime,
      updateChannel: options.updateChannel,
      managedRuntimeDir: options.managedRuntimeDir,
      preferManagedRuntimeOnWindows: options.preferManagedRuntimeOnWindows ?? true,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      env: options.env ?? process.env,
      homeDirectory: options.homeDirectory ?? homedir(),
    };
    this.providers = dependencies.providers ?? this.createProviders();
    this.verifier = dependencies.verifier ?? new RuntimeVerifier({ platform: this.options.platform });
    this.installer = dependencies.installer;
  }

  async discoverCandidates(): Promise<RuntimeCandidate[]> {
    const discovered: RuntimeCandidate[] = [];
    for (const provider of this.providers) {
      discovered.push(...await provider.discover());
    }
    return [...new Map(discovered
      .filter((candidate) => !this.rejectedPaths.has(candidate.executablePath))
      .map((candidate) => [candidate.executablePath, candidate])).values()];
  }

  async resolve(): Promise<ResolvedRuntime> {
    const failures: string[] = [];
    for (const candidate of await this.discoverCandidates()) {
      const verification = await this.verifier.verify(candidate);
      if (verification.ok && verification.version) {
        return { ...candidate, version: verification.version, verification };
      }
      failures.push(`${candidate.source}:${candidate.executablePath}: ${verification.reason ?? "verification failed"}`);
    }
    if (this.options.autoDownload && this.options.mode !== "configured" && this.options.mode !== "desktop") {
      if (!supportsRuntimeDownload(this.options.platform, this.options.arch)) {
        throw new RuntimeNotFoundError(
          `${formatFailures(failures)}; automatic Runtime downloads are unavailable on ${this.options.platform}/${this.options.arch}; configure Codex explicitly or add it to PATH`,
        );
      }
      if (!this.installer) throw new RuntimeNotFoundError(`${formatFailures(failures)}; automatic installer is unavailable`);
      return this.installLatestStable();
    }
    throw new RuntimeNotFoundError(formatFailures(failures));
  }

  verify(candidate: RuntimeCandidate) {
    return this.verifier.verify(candidate);
  }

  installLatestStable(): Promise<ResolvedRuntime> {
    if (!this.installer) throw new RuntimeNotFoundError("Automatic Runtime installer is unavailable");
    return this.installer.installLatest(this.options.updateChannel);
  }

  checkForUpdates(): Promise<RuntimeUpdate | null> {
    if (!this.installer) return Promise.resolve(null);
    return this.installer.checkForUpdates(this.options.updateChannel);
  }

  rollback(): Promise<ResolvedRuntime> {
    if (!this.installer) throw new RuntimeNotFoundError("Runtime rollback is unavailable");
    return this.installer.rollback();
  }

  reject(executablePath: string): void {
    this.rejectedPaths.add(executablePath);
  }

  clearRejected(): void {
    this.rejectedPaths = new Set();
  }

  private createProviders(): RuntimeProvider[] {
    const configured = new ConfiguredRuntimeProvider(this.options.configuredPath);
    const path = new PathRuntimeProvider(this.options.platform, this.options.env);
    const desktop = this.options.platform === "darwin"
      ? new MacDesktopRuntimeProvider(this.options.homeDirectory)
      : this.options.platform === "win32"
        ? new WindowsDesktopRuntimeProvider(this.options.env)
        : null;
    const managed = new ManagedRuntimeProvider(this.options.managedRuntimeDir);

    if (this.options.mode === "configured") return [configured];
    if (this.options.mode === "desktop") return desktop ? [desktop] : [];
    if (this.options.mode === "managed") return [managed];
    const ordered = [configured, path] as RuntimeProvider[];
    if (this.options.platform === "win32" && this.options.allowDesktopRuntime
      && this.options.preferManagedRuntimeOnWindows) {
      ordered.push(new WindowsDesktopRuntimeProvider(this.options.env, {
        includeUserPaths: true,
        includeStorePaths: false,
      }));
      ordered.push(managed);
      ordered.push(new WindowsDesktopRuntimeProvider(this.options.env, {
        includeUserPaths: false,
        includeStorePaths: true,
      }));
      return ordered;
    }
    if (desktop && this.options.allowDesktopRuntime) ordered.push(desktop);
    ordered.push(managed);
    return ordered;
  }
}

function formatFailures(failures: string[]): string {
  return failures.length ? `No usable Codex Runtime was found (${failures.join("; ")})` : "No Codex Runtime candidates were found";
}
