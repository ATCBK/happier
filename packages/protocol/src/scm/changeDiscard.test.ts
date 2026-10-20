import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { ScmChangeDiscardEntrySchema, ScmChangeDiscardResponseSchema } from './index.js';
import { ScmEntryKindSchema } from './workingSnapshot.js';
import { ScmSelectedMutationPathSchema } from './selectedMutationPath.js';

const comparison = { path: 'src/app.ts', kind: 'comparison', against: { source: { kind: 'workingTree' } }, changeKeys: ['key'], includeUndo: true };

describe('comparison discard contract', () => {
  it('admits comparison selectors while refusing ambiguous or silently downgraded writes', () => {
    expect(ScmChangeDiscardEntrySchema.safeParse(comparison).success).toBe(true);
    expect(ScmChangeDiscardEntrySchema.safeParse({ ...comparison, changeRefs: ['occurrence'] }).success).toBe(false);
    expect(ScmChangeDiscardEntrySchema.safeParse({ ...comparison, changeKeys: ['key', 'key'] }).success).toBe(false);
    expect(ScmChangeDiscardEntrySchema.safeParse({ ...comparison, kind: 'modified' }).success).toBe(false);
    expect(ScmChangeDiscardEntrySchema.safeParse({ path: 'src/app.ts', kind: 'modified' }).success).toBe(true);
    // Predecessor shape from ../0.2's unchanged closed status vocabulary.
    const predecessor = z.object({ path: ScmSelectedMutationPathSchema, kind: ScmEntryKindSchema });
    expect(predecessor.safeParse(comparison).success).toBe(false);
  });

  it('retains inverse edits in the actual output consumer', () => {
    const result = ScmChangeDiscardResponseSchema.parse({ success: true, entries: [{ path: 'src/app.ts', status: 'reverted', hashBefore: 'a'.repeat(64), hashAfter: 'b'.repeat(64), inverseEdits: [{ startUtf16: 0, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] });
    expect(result).toHaveProperty('entries.0.inverseEdits.0.originalText', 'new');
  });

});
