import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskScheduler, nextCronRun } from "../src/scheduler/service.js";
import { SqliteSchedulerStore } from "../src/scheduler/sqlite-store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));

async function setup(run = vi.fn(async () => {})) {
  const directory = await mkdtemp(join(tmpdir(), "codex-feishu-scheduler-"));
  directories.push(directory);
  const path = join(directory, "tasks.sqlite");
  const store = new SqliteSchedulerStore(path);
  let now = Date.parse("2026-07-16T09:00:00+08:00");
  const scheduler = new TaskScheduler(store, run, { now: () => now, retryDelayMs: 1_000, maxRetries: 1 });
  const input = {
    chatId: "chat-1",
    conversationId: "chat-1",
    creatorOpenId: "ou-owner",
    threadId: "thread-1",
    chatType: "p2p" as const,
    prompt: "检查项目",
  };
  return { path, store, scheduler, run, input, setNow: (value: number) => { now = value; }, now: () => now };
}

describe("TaskScheduler", () => {
  it("runs a one-shot timer once and removes it", async () => {
    const state = await setup();
    const task = await state.scheduler.addTimer(state.input, 5_000);
    await expect(state.store.get(task.id)).resolves.toMatchObject({ threadId: "thread-1" });
    state.setNow(task.nextRunAt);
    await state.scheduler.tick();
    expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
    await expect(state.store.get(task.id)).resolves.toBeNull();
    state.store.close();
  });

  it("computes and reschedules standard five-field cron expressions", async () => {
    const state = await setup();
    const task = await state.scheduler.addCron(state.input, "*/15 9 * * 1-5");
    expect(task.nextRunAt).toBe(nextCronRun("*/15 9 * * 1-5", state.now()));
    state.setNow(task.nextRunAt);
    await state.scheduler.tick();
    await expect(state.store.get(task.id)).resolves.toMatchObject({ status: "active", retryCount: 0 });
    state.store.close();
  });

  it("retries failures, then marks the task failed without overlapping claims", async () => {
    const run = vi.fn(async () => { throw new Error("temporary"); });
    const state = await setup(run);
    const task = await state.scheduler.addTimer(state.input, 1_000);
    state.setNow(task.nextRunAt);
    await state.scheduler.tick();
    const retry = await state.store.get(task.id);
    expect(retry).toMatchObject({ status: "active", retryCount: 1, lastError: "temporary" });
    state.setNow(retry!.nextRunAt);
    await Promise.all([state.scheduler.tick(), state.scheduler.tick()]);
    await expect(state.store.get(task.id)).resolves.toMatchObject({ status: "failed", retryCount: 2 });
    expect(run).toHaveBeenCalledTimes(2);
    state.store.close();
  });

  it("recovers a claimed task after restart and enforces creator authorization", async () => {
    const state = await setup();
    const task = await state.scheduler.addTimer(state.input, 1_000);
    state.setNow(task.nextRunAt);
    await state.store.claim(task.id, state.now());
    await expect(state.scheduler.remove(task.id, "ou-other", false)).rejects.toThrow("自己创建");
    state.store.close();

    const recoveredStore = new SqliteSchedulerStore(state.path);
    const recovered = new TaskScheduler(recoveredStore, state.run, { now: state.now });
    await recovered.start();
    await recovered.stop();
    expect(state.run).toHaveBeenCalledTimes(1);
    await expect(recoveredStore.get(task.id)).resolves.toBeNull();
    recoveredStore.close();
  });
});
