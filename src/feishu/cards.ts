export interface ToolProgressEntry {
  itemId: string;
  name: string;
  detail?: string;
  status: "running" | "done" | "error";
}

import type { ApprovalDecision, ApprovalRequest } from "../app-server/approvals.js";

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

export function approvalCard(request: ApprovalRequest): Record<string, unknown> {
  const details = [
    `**${request.title}**`,
    request.detail ? `\n\`\`\`\n${truncate(request.detail, 2_000)}\n\`\`\`` : "",
    request.risk ? `\n风险级别：${request.risk}` : "",
  ].join("");
  const button = (label: string, action: "approve" | "reject", type: "primary" | "danger") => ({
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{
      type: "callback",
      value: { action, requestId: String(request.requestId) },
    }],
  });
  return card([
    { tag: "markdown", content: details },
    {
      tag: "column_set",
      horizontal_spacing: "8px",
      columns: [
        { tag: "column", width: "weighted", weight: 1, elements: [button("批准", "approve", "primary")] },
        { tag: "column", width: "weighted", weight: 1, elements: [button("拒绝", "reject", "danger")] },
      ],
    },
  ]);
}

export function approvalResolvedCard(
  request: ApprovalRequest,
  decision: ApprovalDecision,
): Record<string, unknown> {
  const label = decision === "accept" ? "✅ 已批准" : "❌ 已拒绝";
  return card([{
    tag: "markdown",
    content: `**${request.title}**\n\n${label}${request.detail ? `\n\n${truncate(request.detail, 2_000)}` : ""}`,
  }]);
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}
