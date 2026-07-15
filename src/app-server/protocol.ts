import type { UserInput } from "./generated/v2/UserInput.js";

export interface LocalImageInput {
  type: "localImage";
  path: string;
  detail?: "auto" | "low" | "high" | "original";
}

export interface TextInput {
  type: "text";
  text: string;
  text_elements: never[];
}

export type TurnInput = TextInput | LocalImageInput;

// Fails compilation when a regenerated official schema becomes incompatible.
type AssertTrue<Value extends true> = Value;
type _OfficialTurnInputCompatibility = AssertTrue<TurnInput extends UserInput ? true : false>;

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
