import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, extname, join, win32 } from "node:path";

import { getEnv } from "../paths.js";
import type { RuntimeCandidate, RuntimeProvider } from "../types.js";

export class PathRuntimeProvider implements RuntimeProvider {
  readonly name = "path";

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async discover(): Promise<RuntimeCandidate[]> {
    const pathValue = getEnv(this.env, "PATH") ?? "";
    const extensions = this.platform === "win32" ? windowsExtensions(this.env) : [""];
    const candidates: RuntimeCandidate[] = [];
    const pathDelimiter = this.platform === "win32" ? win32.delimiter : delimiter;
    for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const executablePath = join(directory, `codex${extension}`);
        if (await isExecutableFile(executablePath, this.platform)) {
          candidates.push({ source: "path", executablePath });
        }
      }
    }
    return uniqueCandidates(candidates);
  }
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = getEnv(env, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM";
  return configured.split(";").map((value) => value.trim().toLowerCase()).filter(Boolean)
    .map((value) => extname(value) ? value : `.${value}`);
}

async function isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueCandidates(candidates: RuntimeCandidate[]): RuntimeCandidate[] {
  return [...new Map(candidates.map((candidate) => [candidate.executablePath, candidate])).values()];
}
