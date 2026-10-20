import { readFenceLayout } from '@/voice/output/codeFences';

function removeFencedCode(text: string): string {
  const { closed, openStart } = readFenceLayout(text);
  let out = '';
  let cursor = 0;
  for (const span of closed) {
    out += `${text.slice(cursor, span.start)}\n`;
    cursor = span.end;
  }
  return openStart === null ? out + text.slice(cursor) : `${out}${text.slice(cursor, openStart)}\n`;
}

/**
 * Converts assistant markdown into text suitable for a speech synthesizer. This is the single
 * spoken-text normalizer for every TTS provider; it runs at the canonical speech entry
 * (`speakAssistantText`).
 */
export function toSpeechText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, '\n');

  // Code is not read aloud; an unterminated fence drops the rest of the text.
  text = removeFencedCode(text);

  // Images and links keep their visible text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Bare URLs are read as their domain.
  text = text.replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#)]+)[^\s)]*/gi, '$1');

  // Inline code keeps its content.
  text = text.replace(/`([^`\n]*)`/g, '$1');

  // Block-level markers at the start of a line.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*>[ \t]?/gm, '');
  // Horizontal rules before list markers, so `- - -` is not read as a list item.
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '');

  // Emphasis markers wrapping words (keeps snake_case and arithmetic intact).
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  text = text.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');
  text = text.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
