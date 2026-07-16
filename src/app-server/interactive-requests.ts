import { mapApprovalRequest } from "./approvals.js";
import { isObject, type JsonRpcId, type JsonRpcRequest } from "./jsonrpc.js";

export interface InteractiveOption {
  label: string;
  description?: string;
  value: string;
}

export interface InteractiveQuestion {
  id: string;
  header: string;
  prompt: string;
  options?: InteractiveOption[];
  allowOther: boolean;
  secret: boolean;
  required: boolean;
  valueType: "string" | "boolean" | "number" | "array" | "json";
}

interface InteractiveBase {
  requestId: JsonRpcId;
  threadId?: string;
  turnId?: string;
  title: string;
  detail?: string;
  autoResolutionMs?: number;
}

export interface DecisionApprovalRequest extends InteractiveBase {
  kind: "approval";
  approvalType: "command" | "file";
  risk?: string;
  questions: [];
}

export interface PermissionApprovalRequest extends InteractiveBase {
  kind: "permission_approval";
  permissions: Record<string, unknown>;
  questions: [];
}

export interface UserInputRequest extends InteractiveBase {
  kind: "user_input";
  questions: InteractiveQuestion[];
}

export interface McpElicitationRequest extends InteractiveBase {
  kind: "mcp_elicitation";
  mode: "form" | "openai/form" | "url";
  serverName: string;
  url?: string;
  questions: InteractiveQuestion[];
}

export type InteractiveRequest =
  | DecisionApprovalRequest
  | PermissionApprovalRequest
  | UserInputRequest
  | McpElicitationRequest;

export type InteractiveResolution = "accept" | "decline" | "cancel";
export type InteractiveAnswers = Record<string, string[]>;

export function parseInteractiveRequest(request: JsonRpcRequest): InteractiveRequest | null {
  const params = isObject(request.params) ? request.params : {};
  const threadId = stringValue(params.threadId) ?? nestedId(params.thread) ?? undefined;
  const turnId = stringValue(params.turnId) ?? nestedId(params.turn) ?? undefined;

  if (request.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions)
      ? params.questions.map(parseUserInputQuestion).filter(isDefined)
      : [];
    if (questions.length === 0) return null;
    return {
      kind: "user_input",
      requestId: request.id,
      threadId,
      turnId,
      title: "Codex 需要你的输入",
      questions,
      ...(positiveNumber(params.autoResolutionMs)
        ? { autoResolutionMs: positiveNumber(params.autoResolutionMs) }
        : {}),
    };
  }

  if (request.method === "mcpServer/elicitation/request") {
    const mode = params.mode;
    if (mode !== "form" && mode !== "openai/form" && mode !== "url") return null;
    const serverName = stringValue(params.serverName) ?? "MCP";
    const message = stringValue(params.message) ?? "MCP 服务需要你的输入";
    if (mode === "url") {
      const url = stringValue(params.url);
      if (!url) return null;
      return {
        kind: "mcp_elicitation",
        requestId: request.id,
        threadId,
        turnId,
        title: `${serverName} 请求授权`,
        detail: message,
        mode,
        serverName,
        url,
        questions: [],
      };
    }
    return {
      kind: "mcp_elicitation",
      requestId: request.id,
      threadId,
      turnId,
      title: `${serverName} 请求输入`,
      detail: message,
      mode,
      serverName,
      questions: parseJsonSchema(params.requestedSchema),
    };
  }

  if (request.method === "item/permissions/requestApproval") {
    const permissions = isObject(params.permissions) ? params.permissions : {};
    return {
      kind: "permission_approval",
      requestId: request.id,
      threadId,
      turnId,
      title: "Codex 请求扩展权限",
      detail: stringValue(params.reason) ?? permissionSummary(permissions),
      permissions,
      questions: [],
    };
  }

  const approval = mapApprovalRequest(request);
  if (!approval) return null;
  return {
    ...approval,
    kind: "approval",
    approvalType: request.method.toLowerCase().includes("filechange")
      || request.method.toLowerCase().includes("file_change")
      || request.method.toLowerCase().includes("applypatch")
      ? "file"
      : "command",
    questions: [],
  };
}

export function buildInteractiveResponse(
  request: InteractiveRequest,
  resolution: InteractiveResolution,
  answers: InteractiveAnswers,
): unknown {
  switch (request.kind) {
    case "approval":
      return { decision: resolution };
    case "permission_approval":
      return {
        permissions: resolution === "accept" ? grantedPermissions(request.permissions) : {},
        scope: "turn",
      };
    case "user_input": {
      const mapped: Record<string, { answers: string[] }> = {};
      if (resolution === "accept") {
        for (const question of request.questions) {
          const values = answers[question.id];
          if (values) mapped[question.id] = { answers: values };
        }
      }
      return { answers: mapped };
    }
    case "mcp_elicitation":
      return {
        action: resolution,
        content: resolution === "accept" && request.mode !== "url"
          ? mcpContent(request.questions, answers)
          : null,
        _meta: null,
      };
  }
}

function parseUserInputQuestion(value: unknown): InteractiveQuestion | undefined {
  if (!isObject(value)) return undefined;
  const id = stringValue(value.id);
  const prompt = stringValue(value.question);
  if (!id || !prompt) return undefined;
  const options = Array.isArray(value.options)
    ? value.options.map((option) => {
      if (!isObject(option)) return undefined;
      const label = stringValue(option.label);
      if (!label) return undefined;
      const description = stringValue(option.description) ?? undefined;
      return { label, value: label, ...(description ? { description } : {}) };
    }).filter(isDefined)
    : undefined;
  return {
    id,
    header: stringValue(value.header) ?? id,
    prompt,
    ...(options && options.length > 0 ? { options } : {}),
    allowOther: value.isOther === true,
    secret: value.isSecret === true,
    required: true,
    valueType: "string",
  };
}

function parseJsonSchema(schema: unknown): InteractiveQuestion[] {
  if (!isObject(schema) || !isObject(schema.properties)) {
    return [{
      id: "__json__",
      header: "JSON",
      prompt: "请以 JSON 对象格式填写此请求。",
      allowOther: true,
      secret: false,
      required: true,
      valueType: "json",
    }];
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const questions: InteractiveQuestion[] = [];
  for (const [id, rawProperty] of Object.entries(schema.properties)) {
    if (!isObject(rawProperty)) continue;
    const type = schemaType(rawProperty.type);
    const options = schemaOptions(rawProperty, type);
    questions.push({
      id,
      header: stringValue(rawProperty.title) ?? id,
      prompt: stringValue(rawProperty.description) ?? stringValue(rawProperty.title) ?? id,
      ...(options.length > 0 ? { options } : {}),
      allowOther: options.length === 0,
      secret: rawProperty.format === "password",
      required: required.has(id),
      valueType: type,
    });
  }
  return questions;
}

function schemaType(value: unknown): InteractiveQuestion["valueType"] {
  if (value === "boolean" || value === "number" || value === "integer" || value === "array") {
    return value === "integer" ? "number" : value;
  }
  return "string";
}

function schemaOptions(
  property: Record<string, unknown>,
  type: InteractiveQuestion["valueType"],
): InteractiveOption[] {
  if (type === "boolean") {
    return [
      { label: "是", value: "true" },
      { label: "否", value: "false" },
    ];
  }
  const values = Array.isArray(property.enum)
    ? property.enum
    : isObject(property.items) && Array.isArray(property.items.enum)
      ? property.items.enum
      : [];
  return values
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map((value) => ({ label: String(value), value: String(value) }));
}

function mcpContent(
  questions: InteractiveQuestion[],
  answers: InteractiveAnswers,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const question of questions) {
    const values = answers[question.id];
    if (!values || values.length === 0) continue;
    if (question.valueType === "json") {
      const parsed: unknown = JSON.parse(values[0] ?? "{}");
      if (!isObject(parsed)) throw new Error("MCP elicitation JSON 回答必须是对象");
      Object.assign(content, parsed);
      continue;
    }
    if (question.valueType === "array") content[question.id] = values;
    else if (question.valueType === "boolean") content[question.id] = values[0] === "true";
    else if (question.valueType === "number") content[question.id] = Number(values[0]);
    else content[question.id] = values[0];
  }
  return content;
}

function grantedPermissions(permissions: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (isObject(permissions.network)) result.network = permissions.network;
  if (isObject(permissions.fileSystem)) result.fileSystem = permissions.fileSystem;
  return result;
}

function permissionSummary(permissions: Record<string, unknown>): string {
  const parts: string[] = [];
  if (isObject(permissions.network)) parts.push("网络访问");
  if (isObject(permissions.fileSystem)) parts.push("额外文件系统访问");
  return parts.length > 0 ? parts.join("、") : "额外运行权限";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nestedId(value: unknown): string | null {
  return isObject(value) ? stringValue(value.id) : null;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
