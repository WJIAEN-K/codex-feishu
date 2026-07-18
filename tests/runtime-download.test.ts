import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { extractRuntimeArchive, safeArchivePath } from "../src/runtime/archive.js";
import { RuntimeChecksumError } from "../src/runtime/errors.js";
import { RuntimeManifestStore } from "../src/runtime/manifest.js";
import { RuntimeDownloader } from "../src/runtime/downloader.js";
import { selectReleaseAsset, type CodexReleaseClient } from "../src/runtime/release-client.js";
import type { RuntimeVerifier } from "../src/runtime/verifier.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-runtime-download-"));
  temporaryDirectories.push(path);
  return path;
}

describe("Codex release selection", () => {
  it("selects the exact target asset and requires its GitHub SHA-256 digest", () => {
    const selected = selectReleaseAsset({
      tag_name: "rust-v0.144.4",
      draft: false,
      prerelease: false,
      assets: [{
        name: "codex-aarch64-apple-darwin.tar.gz",
        browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.4/codex-aarch64-apple-darwin.tar.gz",
        size: 123,
        digest: `sha256:${"ab".repeat(32)}`,
      }],
    }, "aarch64-apple-darwin");

    expect(selected).toMatchObject({ version: "0.144.4", sha256: "ab".repeat(32), size: 123 });
  });

  it("rejects assets without a published digest", () => {
    expect(() => selectReleaseAsset({
      tag_name: "rust-v0.144.4",
      draft: false,
      prerelease: false,
      assets: [{
        name: "codex-aarch64-apple-darwin.tar.gz",
        browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.4/codex-aarch64-apple-darwin.tar.gz",
        size: 123,
      }],
    }, "aarch64-apple-darwin")).toThrow("SHA-256");
  });
});

describe("Runtime archive extraction", () => {
  it("extracts a bounded tar.gz archive", async () => {
    const directory = await temporaryDirectory();
    const archive = tarGzip("codex-aarch64-apple-darwin", Buffer.from("runtime"));
    await extractRuntimeArchive(archive, "codex-aarch64-apple-darwin.tar.gz", directory);
    await expect(readFile(join(directory, "codex-aarch64-apple-darwin"), "utf8")).resolves.toBe("runtime");
  });

  it("rejects traversal and absolute archive paths", () => {
    expect(() => safeArchivePath("/safe/root", "../escape")).toThrow("Unsafe");
    expect(() => safeArchivePath("/safe/root", "C:\\escape.exe")).toThrow("Unsafe");
    expect(() => safeArchivePath("/safe/root", "/escape")).toThrow("Unsafe");
  });

  it("extracts Windows zip assets and rejects ZIP Slip entries", async () => {
    const directory = await temporaryDirectory();
    await extractRuntimeArchive(
      zipStored("codex-x86_64-pc-windows-msvc.exe", Buffer.from("runtime")),
      "codex-x86_64-pc-windows-msvc.zip",
      directory,
    );
    await expect(readFile(join(directory, "codex-x86_64-pc-windows-msvc.exe"), "utf8"))
      .resolves.toBe("runtime");
    await expect(extractRuntimeArchive(
      zipStored("../escape.exe", Buffer.from("bad")),
      "codex-x86_64-pc-windows-msvc.zip",
      directory,
    )).rejects.toThrow("Unsafe");
  });
});

describe("RuntimeDownloader", () => {
  it("verifies, atomically installs and activates a downloaded Runtime", async () => {
    const root = await temporaryDirectory();
    const archive = tarGzipEntries([
      { name: "codex-aarch64-apple-darwin", contents: Buffer.from("#!/bin/sh\n") },
      { name: "resources/sidecar.txt", contents: Buffer.from("release sidecar") },
    ]);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const releaseClient = fixtureReleaseClient(archive.length, sha256);
    const verifier = {
      verify: vi.fn(async () => ({
        ok: true,
        version: "0.144.4",
        supportsAppServer: true,
        initializeSucceeded: true,
        accountReadSucceeded: true,
      })),
    } as unknown as RuntimeVerifier;
    const downloader = new RuntimeDownloader({
      managedRuntimeDir: root,
      platform: "darwin",
      arch: "arm64",
      releaseClient,
      verifier,
      fetch: vi.fn(async () => new Response(Uint8Array.from(archive), {
        status: 200,
        headers: { "content-length": String(archive.length) },
      })),
    });

    const runtime = await downloader.installLatest("stable");
    expect(runtime).toMatchObject({ source: "downloaded", version: "0.144.4" });
    await expect(access(runtime.executablePath)).resolves.toBeUndefined();
    await expect(readFile(join(root, "versions", "0.144.4", "resources", "sidecar.txt"), "utf8"))
      .resolves.toBe("release sidecar");
    await expect(new RuntimeManifestStore(root).readCurrent()).resolves.toMatchObject({
      version: "0.144.4",
      sha256,
      executablePath: runtime.executablePath,
    });
  });

  it("does not activate an archive whose digest does not match", async () => {
    const root = await temporaryDirectory();
    const archive = tarGzip("codex-aarch64-apple-darwin", Buffer.from("bad"));
    const downloader = new RuntimeDownloader({
      managedRuntimeDir: root,
      platform: "darwin",
      arch: "arm64",
      releaseClient: fixtureReleaseClient(archive.length, "00".repeat(32)),
      verifier: { verify: vi.fn() } as unknown as RuntimeVerifier,
      fetch: vi.fn(async () => new Response(Uint8Array.from(archive), { status: 200 })),
      maxAttempts: 1,
    });

    await expect(downloader.installLatest("stable")).rejects.toBeInstanceOf(RuntimeChecksumError);
    await expect(new RuntimeManifestStore(root).readCurrent()).resolves.toBeNull();
  });
});

function fixtureReleaseClient(size: number, sha256: string): CodexReleaseClient {
  return {
    latest: vi.fn(async () => ({
      version: "0.144.4",
      name: "codex-aarch64-apple-darwin.tar.gz",
      downloadUrl: "https://github.com/openai/codex/releases/download/rust-v0.144.4/codex-aarch64-apple-darwin.tar.gz",
      size,
      sha256,
    })),
  } as unknown as CodexReleaseClient;
}

function tarGzip(name: string, contents: Buffer): Buffer {
  return tarGzipEntries([{ name, contents }]);
}

function tarGzipEntries(entries: Array<{ name: string; contents: Buffer }>): Buffer {
  const tar = Buffer.concat([
    ...entries.map(({ name, contents }) => tarEntry(name, contents)),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar);
}

function tarEntry(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000755\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${contents.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  const checksum = [...header].reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function zipStored(name: string, contents: Buffer): Buffer {
  const fileName = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30 + fileName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  fileName.copy(local, 30);

  const central = Buffer.alloc(46 + fileName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);
  fileName.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + contents.length, 16);
  return Buffer.concat([local, contents, central, eocd]);
}
