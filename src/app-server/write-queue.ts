import type { Writable } from "node:stream";

/** Serializes JSON-RPC frames and waits for the stream to accept each write. */
export class JsonRpcWriteQueue {
  private tail = Promise.resolve();
  private closedError: Error | null = null;

  constructor(private readonly stream: Writable) {}

  enqueue(message: unknown): Promise<void> {
    const frame = `${JSON.stringify(message)}\n`;
    const write = this.tail.then(() => this.writeFrame(frame));
    this.tail = write.catch(() => undefined);
    return write;
  }

  close(error = new Error("Codex App Server stdin write queue closed")): void {
    this.closedError = error;
  }

  private writeFrame(frame: string): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.stream.destroyed || !this.stream.writable) {
      return Promise.reject(new Error("Codex App Server stdin is not writable"));
    }
    return new Promise<void>((resolve, reject) => {
      this.stream.write(frame, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
