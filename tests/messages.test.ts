import { describe, expect, it } from "vitest";

import { splitText } from "../src/feishu/messages.js";

describe("splitText", () => {
  it("preserves the complete text while respecting the limit", () => {
    const source = `${"a".repeat(12)}\n${"b".repeat(12)}\n${"c".repeat(12)}`;
    const chunks = splitText(source, 16);
    expect(chunks.every((chunk) => chunk.length <= 16)).toBe(true);
    expect(chunks.join("")).toBe(source);
  });

  it("rejects invalid limits and handles empty text", () => {
    expect(splitText("")).toEqual([""]);
    expect(() => splitText("text", 0)).toThrow("positive");
  });
});
