import { describe, expect, it } from "vitest";

import {
  buildAppServerSpawnSpec,
  buildWindowsTerminationSpec,
} from "../src/app-server/process.js";

describe("App Server process helpers", () => {
  it("keeps direct spawning on Unix", () => {
    expect(buildAppServerSpawnSpec("codex", ["app-server", "--stdio"], {
      platform: "linux",
    })).toEqual({
      command: "codex",
      args: ["app-server", "--stdio"],
      windowsHide: false,
    });
  });

  it("resolves the npm codex.cmd shim through ComSpec on Windows", () => {
    const existing = new Set(["C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.CMD"]);
    const spec = buildAppServerSpawnSpec("codex", ["app-server", "--stdio"], {
      platform: "win32",
      cwd: "C:\\work",
      env: {
        Path: "C:\\Users\\dev\\AppData\\Roaming\\npm",
        PATHEXT: ".EXE;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      isFile: (path) => existing.has(path),
    });

    expect(spec).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.CMD app-server --stdio",
      ],
      windowsHide: true,
    });
  });

  it("starts native Windows executables without cmd.exe", () => {
    const executable = "C:\\tools\\codex.exe";
    expect(buildAppServerSpawnSpec(executable, ["app-server"], {
      platform: "win32",
      cwd: "C:\\work",
      env: {},
      isFile: (path) => path === executable,
    })).toEqual({
      command: executable,
      args: ["app-server"],
      windowsHide: true,
    });
  });

  it("quotes Windows shim paths and arguments containing spaces", () => {
    const executable = "C:\\Users\\Test User\\npm\\codex.cmd";
    const spec = buildAppServerSpawnSpec(executable, ["app-server", "--label", "hello world"], {
      platform: "win32",
      cwd: "C:\\work",
      env: { ComSpec: "cmd.exe" },
      isFile: (path) => path === executable,
    });

    expect(spec.args.at(-1)).toBe(
      '"C:\\Users\\Test User\\npm\\codex.cmd" app-server --label "hello world"',
    );
  });

  it("terminates the whole Windows process tree and can force it", () => {
    expect(buildWindowsTerminationSpec(1234)).toEqual({
      command: "taskkill.exe",
      args: ["/pid", "1234", "/t"],
    });
    expect(buildWindowsTerminationSpec(1234, true).args).toEqual([
      "/pid",
      "1234",
      "/t",
      "/f",
    ]);
  });
});
