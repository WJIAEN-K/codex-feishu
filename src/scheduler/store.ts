export type ScheduleKind = "once" | "cron";
export type ScheduledTaskStatus = "active" | "paused" | "running" | "failed";

export interface ScheduledTask {
  id: string;
  chatId: string;
  conversationId: string;
  creatorOpenId: string;
  threadId?: string;
  chatType: "p2p" | "group";
  kind: ScheduleKind;
  schedule: string;
  prompt: string;
  nextRunAt: number;
  status: ScheduledTaskStatus;
  retryCount: number;
  lastRunAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SchedulerStore {
  add(task: ScheduledTask): Promise<void>;
  get(id: string): Promise<ScheduledTask | null>;
  list(conversationId?: string): Promise<ScheduledTask[]>;
  due(now: number, limit?: number): Promise<ScheduledTask[]>;
  claim(id: string, now: number): Promise<boolean>;
  update(task: ScheduledTask): Promise<void>;
  remove(id: string): Promise<void>;
  recoverRunning(now: number): Promise<void>;
  close?(): void | Promise<void>;
}
