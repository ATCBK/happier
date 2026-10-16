import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useExactHomeArrival } from './useExactHomeDestination';

afterEach(() => {
    standardCleanup();
});

describe('useExactHomeArrival', () => {
    it('keeps the latest arrival pending when an earlier invocation of the same opener fails', async () => {
        const first = createDeferred<boolean>();
        const latest = createDeferred<boolean>();
        let invocation = 0;
        const open = () => ++invocation === 1 ? first.promise : latest.promise;
        const hook = await renderHook(() => useExactHomeArrival());
        let firstArrival!: Promise<void>;
        let latestArrival!: Promise<void>;
        act(() => {
            firstArrival = hook.getCurrent().continueThrough(open);
            latestArrival = hook.getCurrent().continueThrough(open);
        });

        await act(async () => {
            first.reject(new Error('The earlier focus failed'));
            await firstArrival;
        });
        expect(hook.getCurrent().state.kind).toBe('focusing');

        await act(async () => {
            latest.resolve(true);
            await latestArrival;
        });
        expect(hook.getCurrent().state.kind).toBe('idle');
    });

    it('turns a rejected arrival into the existing blocked retry without replaying anything else', async () => {
        const open = vi.fn<() => Promise<boolean>>()
            .mockRejectedValueOnce(new Error('refresh failed'))
            .mockResolvedValueOnce(true);
        const hook = await renderHook(() => useExactHomeArrival());

        await act(async () => {
            await hook.getCurrent().continueThrough(open);
        });

        expect(open).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().state.kind).toBe('blocked');

        const blockedState = hook.getCurrent().state;
        if (blockedState.kind !== 'blocked') throw new Error('Expected blocked arrival state');

        act(() => {
            blockedState.retry();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(open).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().state).toEqual({ kind: 'idle' });

        await hook.unmount();
    });
});
