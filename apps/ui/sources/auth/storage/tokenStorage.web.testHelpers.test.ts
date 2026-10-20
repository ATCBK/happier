import { setImmediate as hostTask } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWebLockManagerMock } from './tokenStorage.web.testHelpers';

describe('browser Web Lock boundary', () => {
    let boundary: ReturnType<typeof installWebLockManagerMock>;
    beforeEach(() => { boundary = installWebLockManagerMock(); });
    afterEach(() => {
        boundary.restore();
        vi.useRealTimers();
    });

    it('admits callbacks on a native host task, not in the requesting microtask', async () => {
        vi.useFakeTimers();
        const callback = vi.fn(() => 'result');
        const pending = navigator.locks.request('task-admission', callback);
        await Promise.resolve();
        expect(callback).not.toHaveBeenCalled();
        await hostTask();
        await expect(pending).resolves.toBe('result');
        expect(callback).toHaveBeenCalledOnce();
        expect(boundary.isHeld()).toBe(false);
    });

    it('releases a rejected callback before admitting the next same-name request', async () => {
        const failure = new Error('lock callback failed');
        const events: string[] = [];
        const first = navigator.locks.request('fifo', async () => {
            events.push('first');
            throw failure;
        });
        const firstRejected = expect(first).rejects.toBe(failure);
        const second = navigator.locks.request('fifo', () => { events.push('second'); });
        await firstRejected;
        await second;
        expect(events).toEqual(['first', 'second']);
        expect(boundary.isHeld()).toBe(false);
    });

    it('keeps unrelated names usable while a lock is held', async () => {
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const first = navigator.locks.request('held', async () => {
            enter();
            await held;
        });
        await entered;
        try {
            await expect(navigator.locks.request('independent', () => 'available')).resolves.toBe('available');
            expect(boundary.isHeld('held')).toBe(true);
        } finally {
            release();
            await first;
        }
        expect(boundary.isHeld()).toBe(false);
    });
});
