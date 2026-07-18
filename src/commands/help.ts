export function helpCommand(): string {
  return [
    "可用命令：",
    "/new - 创建新的 Codex 会话",
    "/stop - 中断当前 Codex 任务",
    "/status - 查看连接和会话状态",
    "/project list|current|use - 查看或切换项目",
    "/project discover|use-local - 从 Codex 本地数据库发现或切换项目（仅管理员）",
    "/project add|remove - 管理项目（仅管理员）",
    "/session saved|switch|rename|new|current - 管理当前对话的命名会话",
    "/session list|use - 查看或绑定本机已有 Codex 会话（仅管理员）",
    "/session sync on|off|status - 同步本地 Codex 会话与批准请求（仅管理员）",
    "/history [数量] - 查看当前 Codex 会话最近消息",
    "/usage - 查看 Codex 账号 Token 与额度使用情况",
    "/runtime - 查看当前 Codex Runtime 来源和版本",
    "/account - 查看当前 Codex 账户",
    "/model [模型ID|default] - 查看或切换当前会话模型",
    "/reasoning <强度|default> - 设置当前会话推理强度",
    "/mode default|plan|full-auto - 设置运行与审批模式",
    "/timer <时长> <任务> - 创建一次性定时任务",
    "/cron add|list|remove|pause|resume - 管理周期任务",
    "/help - 显示本帮助",
  ].join("\n");
}
