import { describe, expect, it } from 'vitest';

import { ReviewCommentsV1Schema, buildReviewCommentsV1MetaPayload, parseReviewCommentsV1 } from './reviewCommentMeta';
import type { ReviewCommentDraft } from './reviewCommentTypes';

describe('reviewCommentMeta', () => {
    it('builds a v1 payload from drafts', () => {
        const drafts: ReviewCommentDraft[] = [
            {
                id: 'c1',
                filePath: 'src/a.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 1, lineHash: 'lh1:1234567890abcdef' },
                snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                body: 'nit',
                includeInPrompt: false,
                createdAt: 1,
            },
        ];

        const payload = buildReviewCommentsV1MetaPayload({ sessionId: 's1', drafts });
        const parsed = ReviewCommentsV1Schema.parse(payload);
        expect(parsed.sessionId).toBe('s1');
        expect(parsed.comments).toHaveLength(1);
        expect(parsed.comments[0].filePath).toBe('src/a.ts');
        expect(parsed.comments[0].anchor).toMatchObject({ lineHash: 'lh1:1234567890abcdef' });
        expect(parsed.comments[0].includeInPrompt).toBe(false);
    });

    it('parses valid legacy payload and rejects invalid payload', () => {
        expect(parseReviewCommentsV1({ sessionId: 's1', comments: [] })).not.toBeNull();
        expect(parseReviewCommentsV1({ sessionId: 123 })).toBeNull();
    });

    it('rejects invalid line hashes', () => {
        expect(parseReviewCommentsV1({
            sessionId: 's1',
            comments: [{
                id: 'c1',
                filePath: 'src/a.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 1, lineHash: 'not-a-line-hash' },
                snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                body: 'nit',
                createdAt: 1,
            }],
        })).toBeNull();
    });

    it('reads retained review comments with unknown nested fields while fresh payloads stay strict', () => {
        const comment = {
            id: 'retained-comment', filePath: 'src/a.ts', source: 'file',
            anchor: { kind: 'fileLine', startLine: 1, lineHash: 'lh1:1234567890abcdef' },
            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
            body: 'retained review', createdAt: 1,
        };
        const payload = { sessionId: 'retained-session', retired: true, comments: [{
            ...comment, retired: true,
            anchor: { ...comment.anchor, retired: { enabled: true } },
            snapshot: { ...comment.snapshot, retired: true },
        }] };

        expect(ReviewCommentsV1Schema.safeParse(payload).success).toBe(false);
        expect(parseReviewCommentsV1(payload)).toEqual({ sessionId: 'retained-session', comments: [comment] });
    });
});
