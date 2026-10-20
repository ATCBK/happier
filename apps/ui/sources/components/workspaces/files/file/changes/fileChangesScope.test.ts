import { describe, expect, it } from 'vitest';
import { resolveFileChangesScope } from './fileChangesScope';

describe('File Changes selection policy', () => {
    it('uses session/project defaults and preserves an explicitly opened turn', () => {
        expect(resolveFileChangesScope({}).current).toEqual({ kind: 'workingTree' });
        expect(resolveFileChangesScope({ sessionId: 's' }).current).toEqual({ kind: 'session' });
        const initialChanges = { kind: 'turnCheckpoint' as const, turnId: 'turn-4', comparisonId: 'exact-evidence' };
        expect(resolveFileChangesScope({ sessionId: 's', initialChanges }))
            .toMatchObject({ current: { kind: 'turn', turnId: 'turn-4' }, selector: initialChanges, capture: true });
    });
    it('makes persisted per-tab scope authoritative and keeps Uncommitted outside captures', () => {
        expect(resolveFileChangesScope({ sessionId: 's', initialChanges: { kind: 'turnCheckpoint', turnId: 'turn-4' },
            storedScope: { kind: 'workingTree', futurePresentationField: true } }))
            .toMatchObject({ current: { kind: 'workingTree' }, selector: { kind: 'workingTree' }, capture: false });
        expect(resolveFileChangesScope({ storedScope: { kind: 'turn', turnId: 'turn-8' } }))
            .toMatchObject({ current: { kind: 'turn', turnId: 'turn-8' }, capture: true });
    });
});
