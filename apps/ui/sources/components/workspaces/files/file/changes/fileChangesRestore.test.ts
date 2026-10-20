import { describe, expect, it } from 'vitest';
import { ScmChangeDiscardEntrySchema, ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { buildFileChangesRestoreEntry, resolveFileChangesRestoreIntent } from './fileChangesRestore';

describe('File Changes whole-file restore', () => {
    it('offers the before-turn menu only for a turn and retains each rendered request', () => {
        const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source: { kind: 'session', sessionId: 'session-a' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
        const session = resolveFileChangesRestoreIntent({ path: 'src/a.ts', selector: { kind: 'session' }, comparison });
        expect(session.entry).not.toBeNull();
        expect(session.restoreBeforeTurn).toBe(false);
        for (const selector of [{ kind: 'branch', head: 'HEAD', base: 'main' }, { kind: 'commit', commit: 'HEAD' }] as const) {
            const other = resolveFileChangesRestoreIntent({ path: 'src/a.ts', selector,
                comparison: ScmComparisonSchema.parse({ ...comparison, source: selector }) });
            expect(other.entry).not.toBeNull();
            expect(other.restoreBeforeTurn).toBe(false);
        }
        const turnComparison = ScmComparisonSchema.parse({ ...comparison, source: { kind: 'turnCheckpoint', turnId: 'turn-4' } });
        const turn = resolveFileChangesRestoreIntent({ path: 'src/b.ts', selector: { kind: 'turnCheckpoint', turnId: 'turn-4' },
            comparison: turnComparison, expectedHash: 'b'.repeat(64) });
        expect(turn.restoreBeforeTurn).toBe(true);
        expect(turn.entry).toMatchObject({ path: 'src/b.ts', expectedHash: 'b'.repeat(64) });
        expect(session.entry?.path).toBe('src/a.ts');
    });
    it('selects the reversible live arm without a capture or selected hunk keys', () => {
        const entry = buildFileChangesRestoreEntry({ path: 'src/a.ts', selector: { kind: 'workingTree' }, comparison: null });
        expect(ScmChangeDiscardEntrySchema.safeParse(entry).success).toBe(true);
        expect(entry).toEqual({ kind: 'comparison', path: 'src/a.ts', against: { source: { kind: 'workingTree' } } });
    });
    it('pins the admitted turn evidence and refuses a different turn or missing capture', () => {
        const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source: { kind: 'turnCheckpoint', turnId: 'turn-4' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
        const entry = buildFileChangesRestoreEntry({ path: 'src/a.ts', selector: { kind: 'turnCheckpoint', turnId: 'turn-4' }, comparison,
            sessionId: 'session-a', expectedHash: 'b'.repeat(64) });
        expect(ScmChangeDiscardEntrySchema.safeParse(entry).success).toBe(true);
        expect(entry).toMatchObject({ against: { comparisonId: comparison.id, sessionId: 'session-a', source: comparison.source }, expectedHash: 'b'.repeat(64) });
        expect(entry).not.toHaveProperty('changeKeys');
        expect(buildFileChangesRestoreEntry({ path: 'src/a.ts', selector: { kind: 'turnCheckpoint', turnId: 'turn-8' }, comparison })).toBeNull();
        expect(buildFileChangesRestoreEntry({ path: 'src/a.ts', selector: { kind: 'session' }, comparison: null })).toBeNull();
    });
});
