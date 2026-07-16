import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { AttachmentDispatcher } from "../src/attachments/dispatcher.js";
import { AttachmentServer } from "../src/attachments/server.js";
import { sendAttachmentRequest } from "../src/commands/send.js";
import type { FeishuPort } from "../src/feishu/types.js";

class AttachmentFeishu implements Pick<FeishuPort,
  "uploadImage" | "uploadFile" | "sendImage" | "sendFile"> {
  uploads: Array<{ kind: "image" | "file"; path: string; name?: string }> = [];
  sends: Array<{ kind: "image" | "file"; chatId: string; key: string; replyTo?: string }> = [];

  async uploadImage(path: string): Promise<string> {
    this.uploads.push({ kind: "image", path });
    return "image-key";
  }

  async uploadFile(path: string, name: string): Promise<string> {
    this.uploads.push({ kind: "file", path, name });
    return "file-key";
  }

  async sendImage(chatId: string, key: string, replyTo?: string): Promise<void> {
    this.sends.push({ kind: "image", chatId, key, replyTo });
  }

  async sendFile(chatId: string, key: string, replyTo?: string): Promise<void> {
    this.sends.push({ kind: "file", chatId, key, replyTo });
  }
}

async function fixture(maxFileBytes = 1024) {
  const root = join(tmpdir(), `codex-feishu-attachments-${process.pid}-${Date.now()}-${Math.random()}`);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  const feishu = new AttachmentFeishu();
  const dispatcher = new AttachmentDispatcher(feishu, { maxFileBytes });
  return { root, workspace, outside, feishu, dispatcher };
}

describe("AttachmentDispatcher", () => {
  it("uploads and sends a workspace image for an active capability", async () => {
    const { workspace, feishu, dispatcher } = await fixture();
    const image = join(workspace, "chart.png");
    await writeFile(image, "png");
    const scope = dispatcher.createScope({
      chatId: "chat-1",
      replyToMessageId: "message-1",
      cwd: workspace,
    });

    await dispatcher.send({ token: scope.token, path: image, kind: "image" });

    expect(feishu.uploads).toEqual([{ kind: "image", path: await realpath(image) }]);
    expect(feishu.sends).toEqual([{
      kind: "image",
      chatId: "chat-1",
      key: "image-key",
      replyTo: "message-1",
    }]);
  });

  it("uploads files with a sanitized basename", async () => {
    const { workspace, feishu, dispatcher } = await fixture();
    const file = join(workspace, "report.pdf");
    await writeFile(file, "pdf");
    const { token } = dispatcher.createScope({ chatId: "chat-1", cwd: workspace });

    await dispatcher.send({ token, path: file, kind: "file", name: "../final report.pdf" });

    expect(feishu.uploads).toEqual([{
      kind: "file",
      path: await realpath(file),
      name: "final_report.pdf",
    }]);
    expect(feishu.sends[0]).toMatchObject({ kind: "file", chatId: "chat-1", key: "file-key" });
  });

  it("rejects paths outside the workspace and symlink escapes", async () => {
    const { workspace, outside, dispatcher } = await fixture();
    const secret = join(outside, "secret.txt");
    const link = join(workspace, "secret-link.txt");
    await writeFile(secret, "secret");
    await symlink(secret, link);
    const { token } = dispatcher.createScope({ chatId: "chat-1", cwd: workspace });

    await expect(dispatcher.send({ token, path: secret, kind: "file" }))
      .rejects.toThrow("工作目录");
    await expect(dispatcher.send({ token, path: link, kind: "file" }))
      .rejects.toThrow("工作目录");
  });

  it("rejects oversized, missing, and revoked files", async () => {
    const { workspace, dispatcher } = await fixture(3);
    const file = join(workspace, "large.bin");
    await writeFile(file, "1234");
    const { token } = dispatcher.createScope({ chatId: "chat-1", cwd: workspace });

    await expect(dispatcher.send({ token, path: file, kind: "file" })).rejects.toThrow("大小限制");
    dispatcher.revoke(token);
    await expect(dispatcher.send({ token, path: file, kind: "file" })).rejects.toThrow("无效或已过期");
  });
});

describe("AttachmentServer", () => {
  it("accepts a scoped loopback request and rejects a bad token", async () => {
    const { workspace, feishu, dispatcher } = await fixture();
    const file = join(workspace, "result.txt");
    await writeFile(file, "done");
    const { token } = dispatcher.createScope({ chatId: "chat-1", cwd: workspace });
    const server = new AttachmentServer(dispatcher);
    const endpoint = await server.start();
    try {
      await expect(sendAttachmentRequest({ endpoint, token: "bad", path: file, kind: "file" }))
        .rejects.toThrow("无效或已过期");
      await expect(sendAttachmentRequest({ endpoint, token, path: file, kind: "file" }))
        .resolves.toMatchObject({ ok: true });
      expect(feishu.sends).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});
