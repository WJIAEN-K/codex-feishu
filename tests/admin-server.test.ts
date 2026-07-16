import { describe, expect, it, vi } from "vitest";

import { AdminServer } from "../src/admin/server.js";
import { redactConfig } from "../src/admin/status.js";
import { createDefaultJsonConfig } from "../src/config/index.js";

describe("AdminServer", () => {
  it("binds loopback, redacts secrets, and protects mutations with a bearer token", async () => {
    const config = createDefaultJsonConfig(process.cwd());
    config.feishu.appSecret = "top-secret";
    config.feishu.encryptKey = "encrypt-secret";
    config.admin.authToken = "admin-secret";
    const mutate = vi.fn(async () => ({ ok: true }));
    const server = new AdminServer({
      token: "token-123",
      status: async () => ({ config: redactConfig(config) }),
      mutate,
    });
    const { endpoint } = await server.start();
    try {
      expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const deniedStatus = await fetch(`${endpoint}/api/status`);
      expect(deniedStatus.status).toBe(401);
      const status = await (await fetch(`${endpoint}/api/status`, {
        headers: { authorization: "Bearer token-123" },
      })).text();
      expect(status).not.toContain("top-secret");
      expect(status).not.toContain("encrypt-secret");
      expect(status).not.toContain("admin-secret");

      const denied = await fetch(`${endpoint}/api/actions/pause-task`, { method: "POST", body: "{}" });
      expect(denied.status).toBe(401);
      const allowed = await fetch(`${endpoint}/api/actions/pause-task`, {
        method: "POST",
        headers: { authorization: "Bearer token-123", "content-type": "application/json" },
        body: JSON.stringify({ id: "task-1" }),
      });
      expect(allowed.status).toBe(200);
      expect(mutate).toHaveBeenCalledWith("pause-task", { id: "task-1" });
    } finally { await server.stop(); }
  });
});
