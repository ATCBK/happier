import { describe, expect, it } from 'vitest';

import { readSessionListGuardState } from './sessionListRenderable';

describe('the session row guard word (plan 50 G3-2)', () => {
    it('reads a coming stop and a guard stop from the session guard presentation, and nothing else', () => {
        expect(readSessionListGuardState({ v: 1, kind: 'stopping', stopAt: 1_000, rule: 'idle_sessions' })).toEqual({ kind: 'stopping', stopAt: 1_000, rule: 'idle_sessions' });
        expect(readSessionListGuardState({ v: 1, kind: 'stopped', at: 2_000, rule: 'memory_guard', freedBytes: 5 })).toEqual({ kind: 'stopped', at: 2_000, rule: 'memory_guard', freedBytes: 5 });
        // A configured ceiling says nothing on the row; an unreadable or absent presentation is no word.
        expect(readSessionListGuardState({ v: 1, kind: 'configured', ceilingBytes: 8 })).toBeNull();
        expect(readSessionListGuardState({ v: 2, kind: 'stopping' })).toBeNull();
        expect(readSessionListGuardState(undefined)).toBeNull();
    });
});
