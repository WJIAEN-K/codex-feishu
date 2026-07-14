export function helpCommand(): string {
  return [
    "可用命令：",
    "/new - 创建新的 Codex 会话",
    "/stop - 中断当前 Codex 任务",
    "/status - 查看连接和会话状态",
    "/help - 显示本帮助",
  ].join("\n");
}
