import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeManifestStore } from "../src/runtime/manifest.js";
import { RuntimeManager } from "../src/runtime/manager.js";
import { resolveManagedRuntimeDir, resolveTargetTriple, supportsRuntimeDownload } from "../src/runtime/paths.js";
import { ConfiguredRuntimeProvider } from "../src/runtime/providers/configured-provider.js";
import { MacDesktopRuntimeProvider } from "../src/runtime/providers/desktop-macos-provider.js";
import { ManagedRuntimeProvider } from "../src/runtime/providers/managed-provider.js";
import { PathRuntimeProvider } from "../src/runtime/providers/path-provider.js";
import type { RuntimeManifest, RuntimeProvider } from "../src/runtime/types.js";
import { RuntimeVerifier } from "../src/runtime/verifier.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function executable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n", "utf8");
  await chmod(path, 0o755);
}

describe("Runtime paths", () => {
  it("maps supported macOS and Windows targets", () => {
    expect(resolveTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(resolveTargetTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(resolveTargetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(resolveTargetTriple("win32", "arm64")).toBe("aarch64-pc-windows-msvc");
    expect(() => resolveTargetTriple("linux", "x64")).toThrow("Unsupported");
    expect(supportsRuntimeDownload("darwin", "arm64")).toBe(true);
    expect(supportsRuntimeDownload("win32", "x64")).toBe(true);
    expect(supportsRuntimeDownload("linux", "x64")).toBe(false);
  });

  it("uses per-user managed Runtime directories", () => {
    expect(resolveManagedRuntimeDir("darwin", {}, "/Users/demo"))
      .toBe("/Users/demo/Library/Application Support/codex-feishu/runtime");
    expect(resolveManagedRuntimeDir("win32", { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" }, "unused"))
      .toContain("codex-feishu");
  });
});

describe("Runtime providers", () => {
  it("discovers an explicit executable and PATH candidates", async () => {
    const directory = await temporaryDirectory("codex-runtime-provider-");
    const path = join(directory, "codex");
    await executable(path);

    await expect(new ConfiguredRuntimeProvider(path).discover()).resolves.toEqual([
      { source: "configured", executablePath: path },
    ]);
    await expect(new PathRuntimeProvider("darwin", { PATH: directory }).discover()).resolves.toEqual([
      { source: "path", executablePath: path },
    ]);
  });

  it("scans both standard macOS desktop Runtime locations", async () => {
    const home = await temporaryDirectory("codex-runtime-home-");
    const bundled = join(home, "Applications", "Codex.app", "Contents", "Resources", "codex");
    await executable(bundled);
    const candidates = await new MacDesktopRuntimeProvider(home).discover();

    expect(candidates).toContainEqual(expect.objectContaining({
      source: "desktop-bundled",
      executablePath: bundled,
    }));
  });

  it("reads current managed manifest first and keeps rollback candidates", async () => {
    const root = await temporaryDirectory("codex-managed-runtime-");
    const store = new RuntimeManifestStore(root);
    const first = manifest(root, "1.0.0");
    const second = manifest(root, "2.0.0");
    await store.writeVersion(first);
    await store.writeVersion(second);
    await store.setCurrent(second);

    const candidates = await new ManagedRuntimeProvider(root).discover();
    expect(candidates.map((candidate) => candidate.version)).toEqual(["2.0.0", "1.0.0"]);
  });
});

describe("RuntimeVerifier", () => {
  it("checks version, app-server help, initialize and account/read", async () => {
    const directory = await temporaryDirectory("codex-runtime-verifier-");
    const path = join(directory, "codex");
    await executable(path);
    const commandRunner = vi.fn(async (_path: string, args: string[]) => ({
      stdout: args[0] === "--version" ? "codex-cli 0.144.4" : "app-server help",
      stderr: "",
    }));
    const deepVerifier = vi.fn(async () => true);
    const verifier = new RuntimeVerifier({ commandRunner, deepVerifier, platform: "darwin" });

    await expect(verifier.verify({ source: "configured", executablePath: path })).resolves.toMatchObject({
      ok: true,
      version: "0.144.4",
      supportsAppServer: true,
      initializeSucceeded: true,
      accountReadSucceeded: true,
    });
    expect(commandRunner).toHaveBeenCalledWith(path, ["app-server", "--help"], 10_000);
  });

  it.runIf(process.platform === "win32")("verifies a real Windows .cmd Runtime shim", async () => {
    const directory = await temporaryDirectory("codex-runtime-verifier-cmd-");
    const path = join(directory, "codex.cmd");
    await writeFile(path, [
      "@echo off",
      "if \"%~1\"==\"--version\" (echo codex-cli 0.144.4 & exit /b 0)",
      "if \"%~1\"==\"app-server\" (echo app-server help & exit /b 0)",
      "exit /b 1",
    ].join("\r\n"), "utf8");
    const verifier = new RuntimeVerifier({ platform: "win32", deepVerifier: async () => true });

    await expect(verifier.verify({ source: "path", executablePath: path })).resolves.toMatchObject({
      ok: true,
      version: "0.144.4",
      supportsAppServer: true,
    });
  });
});

describe("RuntimeManager", () => {
  it("selects the first verified candidate and records failed candidates", async () => {
    const provider: RuntimeProvider = {
      name: "fixture",
      discover: async () => [
        { source: "path", executablePath: "/bad" },
        { source: "desktop-bundled", executablePath: "/good" },
        { source: "managed", executablePath: "/managed" },
      ],
    };
    const verifier = {
      verify: vi.fn(async (candidate: { executablePath: string }) => candidate.executablePath === "/good"
        ? { ok: true, version: "2.0.0", supportsAppServer: true, initializeSucceeded: true, accountReadSucceeded: true }
        : { ok: false, supportsAppServer: false, initializeSucceeded: false, accountReadSucceeded: false, reason: "bad" }),
    } as unknown as RuntimeVerifier;
    const manager = new RuntimeManager({
      autoDownload: false,
      allowDesktopRuntime: true,
      updateChannel: "stable",
      managedRuntimeDir: "/managed",
    }, { providers: [provider], verifier });

    await expect(manager.resolve()).resolves.toMatchObject({
      source: "desktop-bundled",
      executablePath: "/good",
      version: "2.0.0",
    });
    expect(verifier.verify).toHaveBeenCalledTimes(2);
  });

  it("does not attempt unsupported automatic downloads on Linux", async () => {
    const installer = {
      installLatest: vi.fn(),
      checkForUpdates: vi.fn(),
      rollback: vi.fn(),
    };
    const manager = new RuntimeManager({
      autoDownload: true,
      allowDesktopRuntime: false,
      updateChannel: "stable",
      managedRuntimeDir: "/managed",
      platform: "linux",
      arch: "x64",
    }, {
      providers: [{ name: "empty", discover: async () => [] }],
      verifier: { verify: vi.fn() } as unknown as RuntimeVerifier,
      installer,
    });

    await expect(manager.resolve()).rejects.toThrow("automatic Runtime downloads are unavailable on linux/x64");
    expect(installer.installLatest).not.toHaveBeenCalled();
  });
});

function manifest(root: string, version: string): RuntimeManifest {
  return {
    version,
    source: "downloaded",
    executablePath: join(root, "versions", version, "codex"),
    platform: "darwin",
    arch: "arm64",
    targetTriple: "aarch64-apple-darwin",
    sha256: version.repeat(8).slice(0, 64),
    installedAt: "2026-07-18T00:00:00.000Z",
    lastValidatedAt: "2026-07-18T00:00:01.000Z",
    appServerSupported: true,
  };
}
