/** A consistent approximate context cost for tool definitions and skill text. */
export function estimateTokensV1(text: string): number {
  return Math.ceil(text.length / 4);
}
