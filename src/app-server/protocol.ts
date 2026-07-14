export interface InitializeParams {
  clientInfo: {
    name: "codex_feishu";
    title: "Codex Feishu Bridge";
    version: string;
  };
  capabilities: {
    experimentalApi: true;
  };
}

export interface LocalImageInput {
  type: "localImage";
  path: string;
}

export interface TextInput {
  type: "text";
  text: string;
}

export type TurnInput = TextInput | LocalImageInput;

export interface ThreadResult {
  thread?: { id?: string };
  threadId?: string;
  id?: string;
  [key: string]: unknown;
}

export interface TurnResult {
  turn?: { id?: string };
  turnId?: string;
  id?: string;
  [key: string]: unknown;
}

export function resultId(result: ThreadResult | TurnResult, nested: "thread" | "turn"): string {
  const nestedValue = result[nested];
  const id =
    (typeof nestedValue === "object" && nestedValue !== null && "id" in nestedValue
      ? nestedValue.id
      : undefined)
    ?? result[`${nested}Id`]
    ?? result.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`${nested} response did not include an id`);
  }
  return id;
}
