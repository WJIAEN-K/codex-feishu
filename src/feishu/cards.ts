export interface ToolProgressEntry {
  itemId: string;
  name: string;
  detail?: string;
  status: "running" | "done" | "error";
}

function card(elements: Record<string, unknown>[]): Record<string, unknown> {
  return { schema: "2.0", body: { elements } };
}

export function streamingCard(text: string, status = "Codex 正在回复…"): Record<string, unknown> {
  return card([
    { tag: "markdown", content: `**${status}**` },
    { tag: "markdown", content: text || "…" },
  ]);
}

export function finalCard(text: string): Record<string, unknown> {
  return card([{ tag: "markdown", content: text || "Codex 未返回文本。" }]);
}

export function progressCard(
  entries: ToolProgressEntry[],
  finished = false,
): Record<string, unknown> {
  const lines = entries.map((entry) => {
    const icon = entry.status === "running" ? "⏳" : entry.status === "done" ? "✅" : "❌";
    const detail = entry.detail ? ` — ${truncate(entry.detail, 240)}` : "";
    return `${icon} **${entry.name}**${detail}`;
  });
  const title = finished ? "Codex 执行进度（已完成）" : "Codex 执行进度";
  return card([{ tag: "markdown", content: `**${title}**\n\n${lines.join("\n") || "⏳ 正在分析…"}` }]);
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}
