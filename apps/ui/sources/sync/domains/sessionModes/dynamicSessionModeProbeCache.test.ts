import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readDynamicSessionModeProbeCache,
    resetDynamicSessionModeProbeCacheForTests,
    writeDynamicSessionModeProbeCacheSuccess,
    writeDynamicSessionModeProbeCacheUnavailable,
    writeDynamicSessionModeProbeCacheError,
} from './dynamicSessionModeProbeCache';

describe('dynamic session mode probe cache', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('retains unresolved disposition and last-good modes after the ordinary cooldown', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicSessionModeProbeCacheForTests();
        const modes = { availableModes: [{ id: 'plan', name: 'Plan' }] };
        writeDynamicSessionModeProbeCacheSuccess('unknown', modes, 1_000);
        writeDynamicSessionModeProbeCacheError('unknown', 2_000, { reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' });
        vi.setSystemTime(100_000_000);
        expect(readDynamicSessionModeProbeCache('unknown')).toMatchObject({
            kind: 'success', updatedAt: 1_000, value: modes,
            reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown',
        });
    });

    it('lets explicit unavailable results override a previous successful mode list during cooldown', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicSessionModeProbeCacheForTests();

        writeDynamicSessionModeProbeCacheSuccess('key-1', {
            availableModes: [{ id: 'plan', name: 'Plan' }],
        }, 1_000);

        writeDynamicSessionModeProbeCacheUnavailable('key-1', {
            availableModes: [],
            unavailable: true,
        }, 2_000);

        expect(readDynamicSessionModeProbeCache('key-1')).toEqual({
            kind: 'success',
            updatedAt: 2_000,
            expiresAt: 62_000,
            value: {
                availableModes: [],
                unavailable: true,
            },
        });
    });
});
