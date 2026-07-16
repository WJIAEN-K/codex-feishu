import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface AdminServerOptions {
  port?: number;
  token: string;
  status: () => Promise<unknown>;
  mutate?: (action: string, body: Record<string, unknown>) => Promise<unknown>;
}

export class AdminServer {
  private server?: ReturnType<typeof createServer>;
  constructor(private readonly options: AdminServerOptions) {
    if (!options.token) throw new Error("管理服务令牌不能为空");
  }

  async start(): Promise<{ endpoint: string; token: string }> {
    if (this.server) throw new Error("管理服务已启动");
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port ?? 0, "127.0.0.1", () => {
        this.server!.off("error", reject); resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("无法获取管理服务端口");
    return { endpoint: `http://127.0.0.1:${address.port}`, token: this.options.token };
  }
  async stop(): Promise<void> {
    const server = this.server; this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method ?? "GET";
      if (method === "GET" && request.url === "/") return html(response, managementPage());
      if (method === "GET" && request.url === "/api/status") {
        if (!authorized(request.headers.authorization, this.options.token)) return json(response, 401, { error: "unauthorized" });
        return json(response, 200, await this.options.status());
      }
      if (method === "POST" && request.url?.startsWith("/api/actions/")) {
        if (!authorized(request.headers.authorization, this.options.token)) return json(response, 401, { error: "unauthorized" });
        const action = decodeURIComponent(request.url.slice("/api/actions/".length));
        const body = await readJson(request);
        return json(response, 200, await this.options.mutate?.(action, body) ?? { ok: true });
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > 16_384) throw new Error("request_too_large"); chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_body");
  return parsed as Record<string, unknown>;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
function html(response: ServerResponse, value: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
  response.end(value);
}
function managementPage(): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>codex-feishu 管理</title><style>body{font:14px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#17202a}h1{font-size:24px}pre{background:#fff;border:1px solid #ddd;border-radius:10px;padding:18px;overflow:auto}button{padding:8px 12px}</style><h1>codex-feishu 本机管理</h1><p>状态、会话、项目和定时任务。敏感配置已脱敏。</p><button onclick="load()">刷新</button><pre id="out">加载中…</pre><script>const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';history.replaceState(null,'',location.pathname);async function load(){const r=await fetch('/api/status',{headers:{authorization:'Bearer '+token}});document.querySelector('#out').textContent=JSON.stringify(await r.json(),null,2)}load()</script></html>`;
}
