import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { ScmChangeDiscardEntrySchema, ScmChangeDiscardResponseSchema } from './index.js';

const comparison = { path: 'src/app.ts', kind: 'comparison', against: { source: { kind: 'workingTree' } }, changeKeys: ['key'], includeUndo: true };

describe('comparison discard contract', () => {
  it('admits comparison selectors while refusing ambiguous or silently downgraded writes', () => {
    expect(ScmChangeDiscardEntrySchema.safeParse(comparison).success).toBe(true);
    expect(ScmChangeDiscardEntrySchema.safeParse({ ...comparison, changeRefs: ['occurrence'] }).success).toBe(false);
    expect(ScmChangeDiscardEntrySchema.safeParse({ ...comparison, changeKeys: ['key', 'key'] }).success).toBe(false);
    expect(ScmChangeDiscardEntrySchema.safeParse({ ...comparison, kind: 'modified' }).success).toBe(false);
    expect(ScmChangeDiscardEntrySchema.safeParse({ path: 'src/app.ts', kind: 'modified' }).success).toBe(true);
    // ../0.2 HEAD 715e6bbfdabdd7c24b18ceb8904ab2e80370cb05,
    // packages/protocol/src/scm.ts:118,375 (clean relevant paths).
    const predecessor = z.object({ path: z.string(), kind: z.enum([
      'modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted',
    ]) });
    expect(predecessor.safeParse(comparison).success).toBe(false);
  });

  it('retains inverse edits in the actual output consumer', () => {
    const result = ScmChangeDiscardResponseSchema.parse({ success: true, entries: [{ path: 'src/app.ts', status: 'reverted', hashBefore: 'a'.repeat(64), hashAfter: 'b'.repeat(64), inverseEdits: [{ startUtf16: 0, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] });
    expect(result).toHaveProperty('entries.0.inverseEdits.0.originalText', 'new');
  });

});
