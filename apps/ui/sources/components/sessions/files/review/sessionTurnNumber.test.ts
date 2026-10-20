import { describe, expect, it } from 'vitest';
import { resolveSessionTurnNumber } from './sessionTurnNumber';

describe('resolveSessionTurnNumber', () => {
    it('names a turn by its place in started order, independent of projection order', () => {
        const turns = [{ turnId: 't-c', startedAt: 30 }, { turnId: 't-a', startedAt: 10 }, { turnId: 't-b', startedAt: 20 }];
        expect(resolveSessionTurnNumber(turns, 't-b')).toBe(2);
        expect(resolveSessionTurnNumber(turns, 't-c')).toBe(3);
    });

    it('has no number for an unknown turn or a missing projection', () => {
        expect(resolveSessionTurnNumber([{ turnId: 't-a', startedAt: 1 }], 'other')).toBeNull();
        expect(resolveSessionTurnNumber(null, 't-a')).toBeNull();
    });
});
