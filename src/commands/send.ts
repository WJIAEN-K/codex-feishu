export interface SendAttachmentRequest {
  endpoint: string;
  token: string;
  path: string;
  kind: "image" | "file";
  name?: string;
}

export async function sendAttachmentRequest(
  request: SendAttachmentRequest,
): Promise<{ ok: true; kind: "image" | "file"; name: string }> {
  const response = await fetch(`${request.endpoint.replace(/\/$/, "")}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: request.token,
      path: request.path,
      kind: request.kind,
      ...(request.name ? { name: request.name } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    throw new Error(typeof payload.error === "string" ? payload.error : `附件发送失败：HTTP ${response.status}`);
  }
  return payload as { ok: true; kind: "image" | "file"; name: string };
}

export async function runSendCommand(args: string[]): Promise<void> {
  const endpoint = option(args, "--endpoint");
  const token = option(args, "--token");
  const image = option(args, "--image");
  const file = option(args, "--file");
  const name = option(args, "--name") ?? undefined;
  if (!endpoint || !token || (!image && !file) || (image && file)) {
    throw new Error(
      "用法：codex-feishu send --endpoint <url> --token <token> (--image <绝对路径>|--file <绝对路径>) [--name <文件名>]",
    );
  }
  const result = await sendAttachmentRequest({
    endpoint,
    token,
    path: image ?? file!,
    kind: image ? "image" : "file",
    ...(name ? { name } : {}),
  });
  console.log(`附件已发送：${result.name}`);
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}
