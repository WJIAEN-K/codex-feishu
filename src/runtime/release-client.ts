import { RuntimeDownloadError } from "./errors.js";
import type { RuntimeUpdateChannel } from "./types.js";

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

export interface SelectedReleaseAsset {
  version: string;
  name: string;
  downloadUrl: string;
  size: number;
  sha256: string;
}

export interface ReleaseClientOptions {
  fetch?: typeof fetch;
  apiUrl?: string;
}

export class CodexReleaseClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly apiUrl: string;

  constructor(options: ReleaseClientOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.apiUrl = options.apiUrl ?? "https://api.github.com/repos/openai/codex/releases";
  }

  async latest(channel: RuntimeUpdateChannel, targetTriple: string): Promise<SelectedReleaseAsset> {
    assertOfficialApiUrl(this.apiUrl);
    const response = await this.fetchImplementation(`${this.apiUrl}?per_page=30`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "codex-feishu-runtime-manager",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new RuntimeDownloadError(`GitHub Releases API returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new RuntimeDownloadError("GitHub Releases API returned an invalid response");
    const releases = payload.filter(isGitHubRelease);
    const release = releases.find((candidate) => !candidate.draft
      && (channel === "preview" || !candidate.prerelease));
    if (!release) throw new RuntimeDownloadError(`No ${channel} Codex release is available`);
    return selectReleaseAsset(release, targetTriple);
  }
}

export function selectReleaseAsset(release: GitHubRelease, targetTriple: string): SelectedReleaseAsset {
  const extension = targetTriple.includes("windows") ? ".zip" : ".tar.gz";
  const expectedName = `codex-${targetTriple}${extension}`;
  const asset = release.assets.find((candidate) => candidate.name === expectedName);
  if (!asset) throw new RuntimeDownloadError(`Release ${release.tag_name} has no asset ${expectedName}`);
  assertOfficialDownloadUrl(asset.browser_download_url);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new RuntimeDownloadError(`Release asset ${asset.name} has an invalid size`);
  }
  const sha256 = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  if (!sha256) {
    throw new RuntimeDownloadError(`Release asset ${asset.name} does not provide a SHA-256 digest`);
  }
  return {
    version: normalizeVersion(release.tag_name),
    name: asset.name,
    downloadUrl: asset.browser_download_url,
    size: asset.size,
    sha256,
  };
}

export function assertOfficialDownloadUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com"
    || !url.pathname.startsWith("/openai/codex/releases/download/")) {
    throw new RuntimeDownloadError(`Refusing non-official Runtime download URL: ${url.origin}${url.pathname}`);
  }
}

export function isAllowedDownloadRedirect(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "https:" && (
    url.hostname === "github.com"
    || url.hostname === "release-assets.githubusercontent.com"
    || url.hostname.endsWith(".githubusercontent.com")
  );
}

function assertOfficialApiUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "api.github.com"
    || url.pathname !== "/repos/openai/codex/releases") {
    throw new RuntimeDownloadError(`Refusing non-official Releases API URL: ${value}`);
  }
}

function normalizeVersion(tag: string): string {
  const value = tag.replace(/^rust-v/, "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new RuntimeDownloadError(`Unsupported Codex release tag: ${tag}`);
  }
  return value;
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (!isRecord(value) || typeof value.tag_name !== "string"
    || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean"
    || !Array.isArray(value.assets)) return false;
  return value.assets.every((asset) => isRecord(asset)
    && typeof asset.name === "string"
    && typeof asset.browser_download_url === "string"
    && typeof asset.size === "number"
    && (asset.digest === undefined || asset.digest === null || typeof asset.digest === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
