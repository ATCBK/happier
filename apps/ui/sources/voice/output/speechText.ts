import { readFenceLayout } from '@/voice/output/codeFences';

/** Only the five emphasis delimiters can be retained; no assistant text is buffered. */
export type SpeechTextContext = { emphasis: string[]; previousCharacter?: string };

export function createSpeechTextContext(): SpeechTextContext {
  return { emphasis: [], previousCharacter: '' };
}

function removeSpeechEmphasis(text: string, context: SpeechTextContext): string {
  const normalized = text.replace(/\*{1,2}|_{1,2}|~~/g, (marker: string, offset: number) => {
    const before = text[offset - 1] ?? '';
    const after = text[offset + marker.length] ?? '';
    const active = context.emphasis.indexOf(marker);
    if (marker.startsWith('*')
      && /\d[ \t]*$/u.test(`${context.previousCharacter ?? ''}${text.slice(0, offset)}`)
      && /^[ \t]*[+-]?(?:\d|\.\d)/u.test(text.slice(offset + marker.length))) return marker;
    // Wildcard paths and identifier/operator punctuation are literal speech input.
    const token = text.slice(offset + marker.length).match(/^\S*/u)?.[0] ?? '';
    const closesInToken = token.replace(/[.,!?;:)]+$/u, '').endsWith(marker);
    const glob = marker.startsWith('*') && !closesInToken
      && (/^(?:[/\\]|\.[\p{L}\p{N}_?*\[])/u.test(token) || (marker === '*' && /\.[\p{L}\p{N}_]/u.test(token)));
    if (glob) return marker;
    if (active !== -1 && !/\s/u.test(before)) {
      context.emphasis.splice(active, 1);
      return '';
    }
    if (active === -1 && !/\w/u.test(before) && after && !/\s/u.test(after)) {
      context.emphasis.push(marker);
      return '';
    }
    return marker;
  });
  context.previousCharacter = text.at(-1) ?? context.previousCharacter;
  return normalized;
}

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
export function toSpeechText(markdown: string, context = createSpeechTextContext()): string {
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

  // Retain only delimiter context when one emphasis span crosses streamed chunks.
  text = removeSpeechEmphasis(text, context);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
