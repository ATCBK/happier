/** A line that already carries Markdown block syntax: the author structured the text themselves. */
const MARKDOWN_BLOCK_LINE = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|\|)/;

/**
 * Role instructions are written one rule per line. Read back, a plain line-per-rule text is a list
 * (lab `settings-R`), not a wall of paragraphs; text that already uses Markdown, or is too short to
 * be a list, is shown as written. The stored text is never rewritten: this is how it reads.
 */
export function readRoleInstructionsMarkdown(instructions: string): string {
  const lines = instructions.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 3 || lines.some((line) => MARKDOWN_BLOCK_LINE.test(line))) return instructions;
  return lines.map((line) => `- ${line}`).join('\n');
}
