import { parseMentionRefV1 } from './mentionRefV1.js';

export const INLINE_REFERENCE_HREF_PREFIX_V1 = 'happier-ref:';
export const INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 = 'attachment';

// This is the MentionRef destination alphabet, including complete percent escapes.
const DESTINATION = '[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9._~:@/-]|%[0-9A-Fa-f]{2})+';
const DESTINATION_PATTERN = new RegExp(`^(?:${DESTINATION})$`);

/** Labels are display text; only a separate typed record can bind this token. */
export function formatInlineReferenceTokenV1(params: Readonly<{ label: string; ref: string }>): string {
  const label = params.label.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  if (!label || !DESTINATION_PATTERN.test(params.ref) || !parseMentionRefV1(params.ref)) {
    throw new Error('An inline reference requires a label and an encoded MentionRef destination.');
  }
  return `[${label.replace(/[\\[\]]/g, '\\$&')}](${INLINE_REFERENCE_HREF_PREFIX_V1}${params.ref})`;
}

export type InlineReferenceTokenV1 = Readonly<{
  start: number;
  end: number;
  label: string;
  ref: string;
}>;

/** Grammar-only scan in UTF-16 composer-text offsets; it never creates identity. */
export function scanInlineReferenceTokensV1(text: string): InlineReferenceTokenV1[] {
  const pattern = new RegExp(`\\[((?:\\\\[\\\\\\[\\]]|[^\\[\\]\\\\\\r\\n\\u2028\\u2029])+)\\]\\(${INLINE_REFERENCE_HREF_PREFIX_V1}(${DESTINATION})\\)`, 'g');
  const tokens: InlineReferenceTokenV1[] = [];
  for (const match of text.matchAll(pattern)) {
    const ref = match[2]!;
    if (!parseMentionRefV1(ref)) continue;
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      label: match[1]!.replace(/\\([\\[\]])/g, '$1'),
      ref,
    });
  }
  return tokens;
}
