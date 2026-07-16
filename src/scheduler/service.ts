import { randomUUID } from "node:crypto";

import type { ScheduledTask, SchedulerStore } from "./store.js";

export interface CreateScheduledTask {
  chatId: string;
  conversationId: string;
  creatorOpenId: string;
  threadId?: string;
  chatType: "p2p" | "group";
  prompt: string;
}

export interface TaskSchedulerOptions {
  pollIntervalMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  now?: () => number;
}

export class TaskScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly now: () => number;

  constructor(
    private readonly store: SchedulerStore,
    private readonly run: (task: ScheduledTask) => Promise<void>,
    private readonly options: TaskSchedulerOptions = {},
  ) { this.now = options.now ?? Date.now; }

  async start(): Promise<void> {
    await this.store.recoverRunning(this.now());
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs ?? 1_000);
    this.timer.unref();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async addTimer(input: CreateScheduledTask, delayMs: number): Promise<ScheduledTask> {
    if (!Number.isSafeInteger(delayMs) || delayMs <= 0) throw new Error("定时时长必须大于 0");
    return this.create(input, "once", String(delayMs), this.now() + delayMs);
  }
  async addCron(input: CreateScheduledTask, expression: string): Promise<ScheduledTask> {
    const next = nextCronRun(expression, this.now());
    return this.create(input, "cron", normalizeCron(expression), next);
  }
  list(conversationId?: string): Promise<ScheduledTask[]> { return this.store.list(conversationId); }
  async remove(id: string, actor: string, isAdmin: boolean): Promise<void> {
    await this.authorize(id, actor, isAdmin); await this.store.remove(id);
  }
  async pause(id: string, actor: string, isAdmin: boolean): Promise<ScheduledTask> {
    const task = await this.authorize(id, actor, isAdmin); task.status = "paused"; task.updatedAt = this.now();
    await this.store.update(task); return task;
  }
  async resume(id: string, actor: string, isAdmin: boolean): Promise<ScheduledTask> {
    const task = await this.authorize(id, actor, isAdmin);
    task.status = "active"; task.retryCount = 0; delete task.lastError;
    task.nextRunAt = task.kind === "cron" ? nextCronRun(task.schedule, this.now()) : Math.max(this.now(), task.nextRunAt);
    task.updatedAt = this.now(); await this.store.update(task); return task;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const due of await this.store.due(now)) {
        if (!await this.store.claim(due.id, now)) continue;
        const task = await this.store.get(due.id);
        if (task) await this.execute(task);
      }
    } finally { this.ticking = false; }
  }

  private async execute(task: ScheduledTask): Promise<void> {
    const now = this.now();
    try {
      await this.run(task);
      task.retryCount = 0; task.lastRunAt = now; delete task.lastError;
      if (task.kind === "once") { await this.store.remove(task.id); return; }
      task.status = "active"; task.nextRunAt = nextCronRun(task.schedule, now);
    } catch (error) {
      task.retryCount += 1;
      task.lastError = error instanceof Error ? error.message : String(error);
      if (task.retryCount > (this.options.maxRetries ?? 3)) task.status = "failed";
      else { task.status = "active"; task.nextRunAt = now + (this.options.retryDelayMs ?? 60_000); }
    }
    task.updatedAt = now;
    await this.store.update(task);
  }

  private async create(input: CreateScheduledTask, kind: "once" | "cron", schedule: string, nextRunAt: number) {
    const now = this.now();
    const task: ScheduledTask = { id: randomUUID(), ...input, kind, schedule, prompt: input.prompt.trim(), nextRunAt,
      status: "active", retryCount: 0, createdAt: now, updatedAt: now };
    if (!task.prompt) throw new Error("任务内容不能为空");
    await this.store.add(task); return task;
  }
  private async authorize(id: string, actor: string, isAdmin: boolean): Promise<ScheduledTask> {
    const task = await this.store.get(id); if (!task) throw new Error("定时任务不存在");
    if (!isAdmin && task.creatorOpenId !== actor) throw new Error("只能管理自己创建的定时任务");
    return task;
  }
}

export function nextCronRun(expression: string, after: number): number {
  const fields = normalizeCron(expression).split(" ");
  const start = new Date(after); start.setSeconds(0, 0); start.setMinutes(start.getMinutes() + 1);
  const limit = 366 * 24 * 60 * 2;
  for (let offset = 0; offset < limit; offset += 1) {
    const date = new Date(start.getTime() + offset * 60_000);
    if (matches(fields[0]!, date.getMinutes(), 0, 59)
      && matches(fields[1]!, date.getHours(), 0, 23)
      && matches(fields[2]!, date.getDate(), 1, 31)
      && matches(fields[3]!, date.getMonth() + 1, 1, 12)
      && matches(fields[4]!, date.getDay(), 0, 6)) return date.getTime();
  }
  throw new Error("未来两年内找不到符合条件的执行时间");
}

function normalizeCron(expression: string): string {
  const value = expression.trim().replace(/\s+/g, " ");
  const fields = value.split(" ");
  if (fields.length !== 5) throw new Error("Cron 表达式必须包含 5 个字段：分 时 日 月 周");
  fields.forEach((field, index) => { matches(field!, index === 2 || index === 3 ? 1 : 0, index === 0 ? 0 : index === 1 ? 0 : index === 2 ? 1 : index === 3 ? 1 : 0, index === 0 ? 59 : index === 1 ? 23 : index === 2 ? 31 : index === 3 ? 12 : 6); });
  return value;
}

function matches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`无效 Cron 步长：${part}`);
    let start: number; let end: number;
    if (range === "*") { start = min; end = max; }
    else if (range?.includes("-")) { [start, end] = range.split("-").map(Number) as [number, number]; }
    else { start = Number(range); end = start; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`无效 Cron 字段：${part}`);
    }
    return value >= start && value <= end && (value - start) % step === 0;
  });
}
