import { describe, expect, it } from 'vitest';
import { FileReviewNoteV1Schema, readFileReviewNoteV1, formatFileReviewNoteV1 } from './fileReviewNoteV1.js';

describe('file review notes', () => {
  it('round trips one action covering multiple paths through its transcript reader', () => {
    const payload = FileReviewNoteV1Schema.parse({ action: 'discard', paths: ['src/a.ts', 'src/b.ts'], changeCount: 3, turnId: 'turn-4' });
    expect(readFileReviewNoteV1({ happier: { kind: 'file_review_note.v1', payload } })).toEqual(payload);
    expect(formatFileReviewNoteV1(payload)).toContain('src/b.ts');
    expect(readFileReviewNoteV1({ happier: { kind: 'file_review_note.v1', payload: { action: 'keep', paths: ['src/a.ts'] } } })).toBeNull();
    expect(FileReviewNoteV1Schema.safeParse({ action: 'undo', paths: [] }).success).toBe(false);
  });
});
