import { describe, expect, it } from 'vitest';

import {
  formatReviewCommentAnchorLabel,
  formatReviewCommentAnchorLines,
} from './reviewCommentPresentation';
import type { ReviewCommentDraft } from './reviewCommentTypes';

const draft = (anchor: ReviewCommentDraft['anchor']) =>
  ({ anchor }) as ReviewCommentDraft;

describe('a review comment anchor, as people read it', () => {
  it('names the lines and never shows the line hashes the agent prompt carries', () => {
    const range = draft({
      kind: 'range',
      filePath: 'src/backoff.ts',
      startLine: 9,
      endLine: 11,
      startLineHash: 'lh1:8d7e0e1f',
      endLineHash: 'lh1:aa01bb02',
    } as ReviewCommentDraft['anchor']);
    const label = formatReviewCommentAnchorLabel(range);
    expect(label).not.toMatch(/lh1:|L9|L11/);
    expect(label).toContain('9–11');
    expect(formatReviewCommentAnchorLines(range)).toBe('9–11');
  });

  it('reads one line, and marks the side of a change only when it is the old one', () => {
    const one = draft({
      kind: 'fileLine',
      startLine: 4,
      lineHash: 'lh1:8d7e0e1f',
    } as ReviewCommentDraft['anchor']);
    expect(formatReviewCommentAnchorLines(one)).toBe('4');
    expect(formatReviewCommentAnchorLabel(one)).not.toContain('lh1:');
    const before = draft({
      kind: 'diffLine',
      startLine: 4,
      side: 'before',
      oldLine: 4,
      newLine: null,
    } as ReviewCommentDraft['anchor']);
    const after = draft({
      kind: 'diffLine',
      startLine: 5,
      side: 'after',
      oldLine: null,
      newLine: 5,
    } as ReviewCommentDraft['anchor']);
    expect(formatReviewCommentAnchorLabel(before)).not.toBe(
      formatReviewCommentAnchorLabel(
        draft({
          kind: 'fileLine',
          startLine: 4,
        } as ReviewCommentDraft['anchor']),
      ),
    );
    expect(formatReviewCommentAnchorLabel(after)).toBe(
      formatReviewCommentAnchorLabel(
        draft({
          kind: 'fileLine',
          startLine: 5,
        } as ReviewCommentDraft['anchor']),
      ),
    );
  });
});
