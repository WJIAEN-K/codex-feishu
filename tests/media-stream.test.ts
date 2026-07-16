import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeLimitedStream } from "../src/feishu/client.js";

describe("writeLimitedStream", () => {
  it("writes bounded streams and removes a partial file when the limit is exceeded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-feishu-media-test-"));
    const accepted = join(directory, "accepted.bin");
    const rejected = join(directory, "rejected.bin");
    try {
      await expect(writeLimitedStream(accepted, chunks("12", "34"), 4)).resolves.toBe(4);
      await expect(readFile(accepted, "utf8")).resolves.toBe("1234");
      await expect(writeLimitedStream(rejected, chunks("123", "45"), 4)).rejects.toThrow("exceeds");
      await expect(readFile(rejected)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function* chunks(...values: string[]): AsyncGenerator<Buffer> {
  for (const value of values) yield Buffer.from(value);
}
