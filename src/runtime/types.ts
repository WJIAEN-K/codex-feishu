export type RuntimeSource =
  | "configured"
  | "path"
  | "desktop-bundled"
  | "managed"
  | "downloaded";

export type RuntimeMode = "auto" | "configured" | "desktop" | "managed";
export type RuntimeUpdateChannel = "stable" | "preview";

export interface RuntimeCandidate {
  source: RuntimeSource;
  executablePath: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeProvider {
  readonly name: string;
  discover(): Promise<RuntimeCandidate[]>;
}

export interface RuntimeVerification {
  ok: boolean;
  version?: string;
  supportsAppServer: boolean;
  initializeSucceeded: boolean;
  accountReadSucceeded: boolean;
  reason?: string;
}

export interface ResolvedRuntime extends RuntimeCandidate {
  version: string;
  verification: RuntimeVerification;
}

export interface RuntimeManifest {
  version: string;
  source: RuntimeSource;
  executablePath: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  targetTriple: string;
  sha256?: string;
  installedAt: string;
  lastValidatedAt: string;
  appServerSupported: boolean;
}

export interface RuntimeManagerOptions {
  mode?: RuntimeMode;
  configuredPath?: string;
  autoDownload: boolean;
  allowDesktopRuntime: boolean;
  updateChannel: RuntimeUpdateChannel;
  managedRuntimeDir: string;
  preferManagedRuntimeOnWindows?: boolean;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export interface RuntimeUpdate {
  currentVersion?: string;
  latestVersion: string;
}
