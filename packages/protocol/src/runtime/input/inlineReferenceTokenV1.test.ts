import { describe, expect, it } from 'vitest';

import { MENTION_BOUNDS, MENTION_KIND_V1, buildMentionRefV1, MentionRefV1Schema } from './mentionRefV1.js';
import { formatInlineReferenceTokenV1, scanInlineReferenceTokensV1 } from './inlineReferenceTokenV1.js';

describe('inline reference tokens', () => {
  it('round trips escaped labels and encoded identities with composer-text offsets', () => {
    const label = 'a [b] \\ @ / % 😀\r\nnext';
    const ref = buildMentionRefV1('file', 'src/@a/(100%)/😀.ts');
    const token = formatInlineReferenceTokenV1({ label, ref });
    expect(token).toBe(`[a \\[b\\] \\\\ @ / % 😀 next](happier-ref:${ref})`);
    expect(scanInlineReferenceTokensV1(`😀 ${token} end`)).toEqual([
      { start: 3, end: 3 + token.length, label: 'a [b] \\ @ / % 😀 next', ref },
    ]);
  });

  it('scans only the exact grammar, left to right, without inventing a typed binding', () => {
    const text = '[x](happier-ref:file:a) [bad](happier-ref:file:a b) '
      + '[bad](happier-ref:file:%ZZ) [](happier-ref:file:a) '
      + '[bad\\q](happier-ref:file:a) [y](happier-ref:attachment:upload-2)';
    expect(scanInlineReferenceTokensV1(text).map(({ label, ref }) => ({ label, ref }))).toEqual([
      { label: 'x', ref: 'file:a' }, { label: 'y', ref: 'attachment:upload-2' },
    ]);
  });

  it('admits the worst-case label and ref at the re-derived existing bounds', () => {
    const label = '['.repeat(MENTION_BOUNDS.maxLabelChars);
    const ref = `file:${'a'.repeat(MENTION_BOUNDS.maxRefChars - 5)}`;
    const token = formatInlineReferenceTokenV1({ label, ref });
    expect(MENTION_BOUNDS.maxTokenChars).toBe(2 * MENTION_BOUNDS.maxLabelChars + MENTION_BOUNDS.maxRefChars + 16);
    expect(MentionRefV1Schema.safeParse({ kind: MENTION_KIND_V1.file, ref, label, token }).success).toBe(true);
  });
});
