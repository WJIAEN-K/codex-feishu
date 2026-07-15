import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { JsonRpcWriteQueue } from "../src/app-server/write-queue.js";

describe("JsonRpcWriteQueue", () => {
  it("serializes frames even when the writable completes asynchronously", async () => {
    const frames: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        const frame = chunk.toString();
        setTimeout(() => { frames.push(frame); callback(); }, frame.includes("first") ? 10 : 0);
      },
    });
    const queue = new JsonRpcWriteQueue(stream);

    await Promise.all([
      queue.enqueue({ method: "first" }),
      queue.enqueue({ method: "second" }),
    ]);

    expect(frames).toEqual([
      '{"method":"first"}\n',
      '{"method":"second"}\n',
    ]);
  });
});
