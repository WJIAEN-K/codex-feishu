export const FEISHU_TEXT_CHUNK_SIZE = 3_500;

export function splitText(text: string, limit = FEISHU_TEXT_CHUNK_SIZE): string[] {
  if (limit <= 0) throw new Error("Text chunk limit must be positive");
  if (!text) return [""];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("\n", limit);
    if (boundary < Math.floor(limit * 0.5)) boundary = limit;
    else boundary += 1;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining || chunks.length === 0) chunks.push(remaining);
  return chunks;
}
