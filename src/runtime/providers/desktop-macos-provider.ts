import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeCandidate, RuntimeProvider } from "../types.js";

export class MacDesktopRuntimeProvider implements RuntimeProvider {
  readonly name = "desktop-macos";

  constructor(private readonly homeDirectory = homedir()) {}

  async discover(): Promise<RuntimeCandidate[]> {
    const applications = [
      "/Applications/Codex.app",
      "/Applications/ChatGPT.app",
      join(this.homeDirectory, "Applications", "Codex.app"),
      join(this.homeDirectory, "Applications", "ChatGPT.app"),
    ];
    const candidates: RuntimeCandidate[] = [];
    for (const applicationPath of applications) {
      for (const relativePath of [
        ["Contents", "Resources", "codex"],
        ["Contents", "Resources", "bin", "codex"],
      ]) {
        const executablePath = join(applicationPath, ...relativePath);
        if (await isExecutableFile(executablePath)) {
          candidates.push({
            source: "desktop-bundled",
            executablePath,
            metadata: { applicationPath },
          });
        }
      }
    }
    return candidates;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
