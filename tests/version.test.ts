import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { PACKAGE_VERSION, VERSION_OUTPUT } from "../src/version.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

describe("CLI version", () => {
  it("reads the published package version", () => {
    expect(PACKAGE_VERSION).toBe(packageJson.version);
    expect(VERSION_OUTPUT).toBe(`codex-feishu ${packageJson.version}`);
  });
});
