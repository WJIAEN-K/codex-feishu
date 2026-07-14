import { describe, expect, it, vi } from "vitest";

import { ServiceHotReloader } from "../src/config/index.js";

interface TestService {
  name: string;
  stop(): Promise<void>;
}

function service(name: string): TestService {
  return { name, stop: vi.fn(async () => {}) };
}

describe("ServiceHotReloader", () => {
  it("restarts for a changed config and skips identical content", async () => {
    const initial = service("initial");
    const start = vi.fn(async (config: { version: number }) => service(`v${config.version}`));
    const reloader = new ServiceHotReloader(
      { version: 1 },
      initial,
      start,
      JSON.stringify,
    );

    await expect(reloader.reload({ version: 1 })).resolves.toEqual({ status: "unchanged" });
    await expect(reloader.reload({ version: 2 })).resolves.toEqual({ status: "reloaded" });
    expect(initial.stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith({ version: 2 });
    await reloader.stop();
  });

  it("restarts the previous config when the new service cannot start", async () => {
    const initial = service("initial");
    const start = vi.fn(async (config: { version: number }) => {
      if (config.version === 2) throw new Error("bad config");
      return service(`v${config.version}`);
    });
    const reloader = new ServiceHotReloader(
      { version: 1 },
      initial,
      start,
      JSON.stringify,
    );

    await expect(reloader.reload({ version: 2 })).resolves.toMatchObject({
      status: "rolled_back",
      error: { message: "bad config" },
      config: { version: 1 },
    });
    expect(start.mock.calls).toEqual([[{ version: 2 }], [{ version: 1 }]]);
    await reloader.stop();
  });

  it("keeps live-only changes in the rollback snapshot", async () => {
    interface Config { version: number; projects: string[] }
    const initial = service("initial");
    const start = vi.fn(async (config: Config) => {
      if (config.version === 2) throw new Error("bad config");
      return service(`v${config.version}`);
    });
    const reloader = new ServiceHotReloader<Config, TestService>(
      { version: 1, projects: [] },
      initial,
      start,
      (config) => String(config.version),
    );

    await expect(reloader.reload({ version: 1, projects: ["backend"] }))
      .resolves.toEqual({ status: "unchanged" });
    await expect(reloader.reload({ version: 2, projects: ["backend"] }))
      .resolves.toMatchObject({
        status: "rolled_back",
        config: { version: 1, projects: ["backend"] },
      });
    expect(start.mock.calls.at(-1)?.[0]).toEqual({ version: 1, projects: ["backend"] });
    await reloader.stop();
  });
});
