export interface ToolProgressEntry {
  itemId: string;
  name: string;
  detail?: string;
  status: "running" | "done" | "error";
}

import type { ApprovalDecision, ApprovalRequest } from "../app-server/approvals.js";
import type {
  InteractiveAnswers,
  InteractiveRequest,
  InteractiveResolution,
} from "../app-server/interactive-requests.js";

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

export function localApprovalCard(request: {
  requestId: string;
  toolName: string;
  cwd: string;
  detail: string;
}): Record<string, unknown> {
  const callback = (label: string, action: "approve" | "reject" | "complete", type: "primary" | "danger" | "default") => ({
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{ type: "callback", value: { action, requestId: request.requestId } }],
  });
  return card([
    { tag: "markdown", content: [
      "**Codex 本地会话请求批准**",
      `工具：${request.toolName}`,
      `目录：${truncate(request.cwd, 500)}`,
      `\n\`\`\`\n${truncate(request.detail, 2_000)}\n\`\`\``,
    ].join("\n") },
    actionColumns([
      callback("批准", "approve", "primary"),
      callback("拒绝", "reject", "danger"),
      callback("转到 Codex", "complete", "default"),
    ]),
  ]);
}

export function localApprovalResolvedCard(request: {
  toolName: string;
  detail: string;
}, approved: boolean | null): Record<string, unknown> {
  const result = approved === true ? "✅ 已批准" : approved === false ? "❌ 已拒绝" : "↩️ 已转到 Codex 本地处理";
  return card([{ tag: "markdown", content:
    `**Codex 本地会话请求批准**\n\n${result}` +
    `\n\n工具：${request.toolName}\n\n${truncate(request.detail, 2_000)}`,
  }]);
}

export function interactiveRequestCard(
  request: InteractiveRequest,
  questionIndex = 0,
): Record<string, unknown> {
  if (request.kind === "approval" || request.kind === "permission_approval") {
    const details = [
      `**${request.title}**`,
      request.detail ? `\n\n${truncate(request.detail, 2_000)}` : "",
      request.kind === "approval" && request.risk ? `\n\n风险级别：${request.risk}` : "",
    ].join("");
    return card([
      { tag: "markdown", content: details },
      actionColumns([
        callbackButton("批准", "approve", request, "primary"),
        callbackButton("拒绝", "reject", request, "danger"),
      ]),
    ]);
  }

  if (request.kind === "mcp_elicitation" && request.mode === "url") {
    return card([
      { tag: "markdown", content: `**${request.title}**\n\n${truncate(request.detail ?? "请在浏览器中完成操作。", 2_000)}` },
      {
        tag: "button",
        text: { tag: "plain_text", content: "打开授权页面" },
        type: "primary",
        behaviors: [{ type: "open_url", default_url: request.url }],
      },
      actionColumns([
        callbackButton("已完成", "complete", request, "primary"),
        callbackButton("取消", "reject", request, "danger"),
      ]),
    ]);
  }

  const question = request.questions[questionIndex];
  if (!question) {
    return card([{ tag: "markdown", content: `**${request.title}**\n\n没有可填写的问题。` }]);
  }
  const total = request.questions.length;
  const elements: Record<string, unknown>[] = [{
    tag: "markdown",
    content: [
      `**${request.title} · ${question.header}（${questionIndex + 1}/${total}）**`,
      request.detail ? `\n\n${truncate(request.detail, 1_000)}` : "",
      `\n\n${question.prompt}`,
      question.secret ? "\n\n⚠️ 此回答会发送给当前 Codex 任务，请勿在群聊中填写长期密钥。" : "",
    ].join(""),
  }];

  if (question.options && question.options.length > 0) {
    for (const option of question.options) {
      elements.push({
        tag: "button",
        text: { tag: "plain_text", content: option.label },
        type: "default",
        behaviors: [{
          type: "callback",
          value: {
            action: "answer",
            requestId: String(request.requestId),
            questionId: question.id,
            answer: option.value,
          },
        }],
      });
      if (option.description) {
        elements.push({ tag: "markdown", content: truncate(option.description, 400) });
      }
    }
  }
  if (!question.options || question.allowOther) {
    elements.push({
      tag: "markdown",
      content: "请直接回复此消息输入答案。",
    });
  }
  elements.push(actionColumns([
    ...(!question.required ? [callbackButton("跳过", "skip", request, "default")] : []),
    callbackButton("取消任务", "reject", request, "danger"),
  ]));
  return card(elements);
}

export function interactiveResolvedCard(
  request: InteractiveRequest,
  resolution: InteractiveResolution,
  answers: InteractiveAnswers,
): Record<string, unknown> {
  const label = resolution === "accept"
    ? request.kind === "approval" || request.kind === "permission_approval" ? "✅ 已批准" : "✅ 已提交"
    : resolution === "decline" ? "❌ 已拒绝" : "⏱️ 已取消";
  const visibleAnswers = request.questions
    .map((question) => {
      const values = answers[question.id];
      if (!values || values.length === 0) return undefined;
      return `${question.header}：${question.secret ? "••••••" : values.join("、")}`;
    })
    .filter((value): value is string => Boolean(value));
  return card([{
    tag: "markdown",
    content: `**${request.title}**\n\n${label}${visibleAnswers.length > 0 ? `\n\n${visibleAnswers.join("\n")}` : ""}`,
  }]);
}

function callbackButton(
  label: string,
  action: "approve" | "reject" | "skip" | "complete",
  request: InteractiveRequest,
  type: "primary" | "danger" | "default",
): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{
      type: "callback",
      value: { action, requestId: String(request.requestId) },
    }],
  };
}

function actionColumns(buttons: Record<string, unknown>[]): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [button],
    })),
  };
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}
