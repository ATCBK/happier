import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { ScmChangeDiscardEntrySchema, ScmChangeDiscardResponseSchema } from './index.js';
import { getScmComparisonDiscardRestriction } from './comparisonDiscard.js';
import { ScmComparisonFileSchema } from './comparison.js';

const comparison = { path: 'src/app.ts', kind: 'comparison', against: { source: { kind: 'workingTree' } }, changeKeys: ['key'], includeUndo: true };

describe('comparison discard contract', () => {
  it('restricts only selected staged evidence and keeps whole-file added restore separate from hunk discard', () => {
    const file = ScmComparisonFileSchema.parse({ path: 'a.ts', changeKind: 'modified', beforeBlobId: 'before',
      binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: '' },
      occurrences: [
        { id: 'metadata', alias: 'metadata', path: 'a.ts', position: 0,
          before: { startLine: 0, lineCount: 0 }, after: { startLine: 0, lineCount: 0 } },
        ...(['staged', 'unstaged'] as const).map((layer, index) => ({ id: layer, alias: layer, path: 'a.ts', layer, position: index,
          before: { startLine: index + 1, lineCount: 1 }, after: { startLine: index + 1, lineCount: 1 } })),
      ] });
    expect(getScmComparisonDiscardRestriction({ kind: 'captured', file, hunkIndexes: [0] })?.reason).toBe('staged');
    expect(getScmComparisonDiscardRestriction({ kind: 'captured', file, hunkIndexes: [1] })).toBeNull();
    expect(getScmComparisonDiscardRestriction({ kind: 'captured', file })?.reason).toBe('staged');
    const added = { ...file, changeKind: 'added', beforeBlobId: undefined, occurrences: [] };
    expect(getScmComparisonDiscardRestriction({ kind: 'captured', file: added, hunkIndexes: [0] })?.reason).toBe('added_file');
    expect(getScmComparisonDiscardRestriction({ kind: 'captured', file: added })).toBeNull();
    expect(getScmComparisonDiscardRestriction({ kind: 'captured', file: { ...added, changeKind: 'deleted', beforeBlobId: 'before' }, hunkIndexes: [0] })).toBeNull();
    expect(getScmComparisonDiscardRestriction({ kind: 'live', entry: { kind: 'modified', hasIncludedDelta: false }, hunks: true })).toBeNull();
  });
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
