import { createServer, type IncomingMessage, type Server } from "node:http";

import type { AttachmentDispatcher, SendAttachmentInput } from "./dispatcher.js";

const MAX_REQUEST_BYTES = 16 * 1024;

export class AttachmentServer {
  private server: Server | null = null;
  private endpoint: string | null = null;

  constructor(private readonly dispatcher: AttachmentDispatcher) {}

  async start(): Promise<string> {
    if (this.endpoint) return this.endpoint;
    const server = createServer((request, response) => {
      void this.handle(request).then((result) => {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(result));
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: message }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("无法确定附件服务监听地址");
    }
    this.server = server;
    this.endpoint = `http://127.0.0.1:${address.port}`;
    return this.endpoint;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage): Promise<unknown> {
    if (request.method !== "POST" || request.url !== "/send") {
      throw new Error("不支持的附件服务请求");
    }
    const body = await readBody(request);
    const parsed: unknown = JSON.parse(body);
    if (!isSendInput(parsed)) throw new Error("附件请求参数无效");
    return this.dispatcher.send(parsed);
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("附件请求体过大");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isSendInput(value: unknown): value is SendAttachmentInput {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return typeof input.token === "string"
    && typeof input.path === "string"
    && (input.kind === "image" || input.kind === "file")
    && (input.name === undefined || typeof input.name === "string");
}
