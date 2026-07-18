import { resolve } from "node:path";

import type { RuntimeCandidate, RuntimeProvider } from "../types.js";

export class ConfiguredRuntimeProvider implements RuntimeProvider {
  readonly name = "configured";

  constructor(private readonly executablePath?: string) {}

  async discover(): Promise<RuntimeCandidate[]> {
    if (!this.executablePath?.trim()) return [];
    return [{ source: "configured", executablePath: resolve(this.executablePath) }];
  }
}
