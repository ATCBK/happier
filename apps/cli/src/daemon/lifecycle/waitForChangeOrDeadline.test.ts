import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForChangeOrDeadline } from './waitForChangeOrDeadline';

describe('waitForChangeOrDeadline', () => {
    afterEach(() => vi.useRealTimers());

    it('cancels the losing wait on the signed-32-bit recheck boundary', async () => {
        vi.useFakeTimers();
        let waitingSignal: AbortSignal | undefined;
        const pending = waitForChangeOrDeadline({
            waitForChange(signal) {
                waitingSignal = signal;
                return new Promise<void>(() => {});
            },
            remainingMs: 2_147_483_647 + 60_000,
        });
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(2_147_483_646);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toBe('deadline');
        expect(waitingSignal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('settles cancellation even when the underlying wait ignores it', async () => {
        const controller = new AbortController();
        let waitingSignal: AbortSignal | undefined;
        const pending = waitForChangeOrDeadline({
            waitForChange(signal) {
                waitingSignal = signal;
                return new Promise<void>(() => {});
            },
            signal: controller.signal,
        });
        controller.abort();
        expect(await pending).toBe('aborted');
        expect(waitingSignal?.aborted).toBe(true);
    });

    it('preserves producer failures and clears the pending deadline', async () => {
        vi.useFakeTimers();
        const failure = new Error('transport disconnected');
        await expect(waitForChangeOrDeadline({
            waitForChange: async () => { throw failure; },
            remainingMs: 25_000,
        })).rejects.toBe(failure);
        expect(vi.getTimerCount()).toBe(0);
    });
});
