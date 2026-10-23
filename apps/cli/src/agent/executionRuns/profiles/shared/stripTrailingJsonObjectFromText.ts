import { parseTrailingJsonObject } from './parseTrailingJsonObject';

function findTrailingJsonObjectSpan(text: string): Readonly<{ startIndex: number; endIndex: number }> | null {
  const endIndex = text.lastIndexOf('}');
  if (endIndex < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = endIndex; index >= 0; index -= 1) {
    const ch = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '}') {
      depth += 1;
      continue;
    }

    if (ch === '{') {
      depth -= 1;
      if (depth === 0) {
        return { startIndex: index, endIndex };
      }
    }
  }

  return null;
}

export function stripTrailingJsonObjectFromText(text: string, outputKeys?: readonly string[]): string {
  const trimmed = String(text ?? '');
  if (!trimmed.trim()) return '';

  if (outputKeys) {
    // Hold possible structured-output prefixes until their first key is known.
    // Unlike the complete-object fallback, this preserves unrelated JSON in prose.
    const fenceStart = trimmed.trimStart().startsWith('`') ? trimmed.indexOf('`') : trimmed.lastIndexOf('\n`');
    if (fenceStart >= 0) {
      const fencePrefix = trimmed.slice(fenceStart).trim();
      if (fencePrefix && '```json'.startsWith(fencePrefix)) return trimmed.slice(0, fenceStart).trimEnd();
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < trimmed.length; index += 1) {
      const ch = trimmed[index]!;
      if (depth > 0 && inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (depth > 0 && ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{' && depth === 0) {
        const root = /^\{\s*(?:"([^"]*)|$)/u.exec(trimmed.slice(index));
        const firstKey = root?.[1];
        if (root && (firstKey === undefined || outputKeys.some(key => key.startsWith(firstKey)))) {
          return trimmed.slice(0, index).replace(/(?:^|\n)[ \t]*```(?:json)?\s*$/u, '').trimEnd();
        }
      }
      // Skip whole unrelated JSON containers, including nested output-like keys.
      if (ch === '{' || ch === '[') depth += 1;
      else if (depth > 0 && (ch === '}' || ch === ']')) depth -= 1;
    }
    return trimmed;
  }

  const t = trimmed.trimEnd();
  const fencedTailPattern = /^(?<prefix>[\s\S]*?)(?:\r?\n)?```(?:json)?\s*\r?\n(?<body>[\s\S]*?)\r?\n```\s*$/u;
  const fencedMatch = fencedTailPattern.exec(t);
  if (fencedMatch?.groups) {
    const body = String(fencedMatch.groups.body ?? '').trim();
    if (parseTrailingJsonObject(body) !== null) {
      return String(fencedMatch.groups.prefix ?? '').trimEnd();
    }
  }

  const span = findTrailingJsonObjectSpan(t);
  if (span) {
    const candidate = t.slice(span.startIndex, span.endIndex + 1);
    if (parseTrailingJsonObject(candidate) !== null) {
      return t.slice(0, span.startIndex).trimEnd();
    }
  }

  return trimmed;
}
