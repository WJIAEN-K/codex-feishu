export function helpCommand(): string {
  return [
    "可用命令：",
    "/new - 创建新的 Codex 会话",
    "/stop - 中断当前 Codex 任务",
    "/status - 查看连接和会话状态",
    "/project list|current|use - 查看或切换项目",
    "/project add|remove - 管理项目（仅管理员）",
    "/session list|use|new|current - 查看或切换 Codex 会话（list/use 仅管理员）",
    "/help - 显示本帮助",
  ].join("\n");
}
