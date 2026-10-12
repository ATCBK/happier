import { describe, expect, it } from 'vitest';
import { backdropSettle } from './backdropResettle';

const fact = { id: 3, localId: 'builtin:dune-grass', reducedMotion: false };
const settle = (overrides: Partial<Parameters<typeof backdropSettle>[0]> = {}) => backdropSettle({
    fact, settled: 2, shown: { localId: 'builtin:white-rocks-open-sea', w: 2880, h: 1040 }, next: { localId: 'builtin:dune-grass', w: 2880, h: 1040 }, ...overrides,
});

describe('backdrop resettle admission', () => {
    it('settles in blue-noise order from the shown picture into the announced one, for 1.8 s', () => {
        expect(settle()).toEqual({ kind: 'resettle', durationMs: 1800, id: 3 });
    });
    it('cross-fades in the shared reduced-motion time under reduced motion', () => {
        expect(settle({ fact: { ...fact, reducedMotion: true } })).toEqual({ kind: 'crossfade', durationMs: 140, id: 3 });
    });
    it('swaps as before when the change is not the announced resettle', () => {
        expect(settle({ fact: null })).toBeNull();
        expect(settle({ settled: 3 })).toBeNull();
        expect(settle({ next: { localId: 'builtin:calm-sea', w: 2880, h: 1040 } })).toBeNull();
        expect(settle({ shown: null })).toBeNull();
        expect(settle({ shown: { localId: 'builtin:dune-grass', w: 2880, h: 1040 } })).toBeNull();
        expect(settle({ shown: { localId: 'builtin:white-rocks-open-sea', w: 2880, h: 1000 } })).toBeNull();
    });
});
