import { describe, expect, it, vi } from 'vitest';

import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';

describe('scoped pending read ownership', () => {
    it('detaches a cancelled borrower without cancelling a surviving reader', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const caller = new AbortController();
        let finish!: (value: number) => void;
        let transportSignal: AbortSignal | undefined;
        const request = vi.fn((signal: AbortSignal) => {
            transportSignal = signal;
            return new Promise<number>(resolve => { finish = resolve; });
        });
        const first = reads.run('row', request, { signal: caller.signal });
        const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        const second = reads.run('row', request);
        await Promise.resolve();
        caller.abort();
        finish(42);
        await cancelled;
        expect(request).toHaveBeenCalledTimes(1);
        expect(transportSignal?.aborted).toBe(false);
        expect(await second).toBe(42);
    });

    it('cancels the last departed read and does not let a replacement join it', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const caller = new AbortController();
        let oldSignal: AbortSignal | undefined;
        let finishOld!: (value: number) => void;
        const first = reads.run('row', signal => {
            oldSignal = signal;
            return new Promise<number>(resolve => { finishOld = resolve; });
        }, { signal: caller.signal });
        const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await Promise.resolve();
        caller.abort();
        finishOld(1);
        await cancelled;
        expect(oldSignal?.aborted).toBe(true);
        expect(await reads.run('row', async () => 2)).toBe(2);
        await Promise.resolve();
        expect(await reads.run('row', async () => 3)).toBe(3);
    });

    it('does not dispatch already-cancelled demand and isolates exact authority objects', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const cancelled = new AbortController();
        cancelled.abort();
        const request = vi.fn(async () => 1);
        await expect(reads.run('row', request, { signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(request).not.toHaveBeenCalled();
        const authorityA = {};
        const authorityB = {};
        let finish!: (value: number) => void;
        const a = reads.run('row', () => new Promise<number>(resolve => { finish = resolve; }), { scope: authorityA });
        const b = reads.run('row', async () => 2, { scope: authorityB });
        expect(await b).toBe(2);
        finish(1);
        expect(await a).toBe(1);
    });

    it('forgets failures and settled values rather than caching them', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const error = new Error('unavailable');
        const request = vi.fn(async () => { throw error; });
        const results = await Promise.allSettled([reads.run('row', request), reads.run('row', request)]);
        expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(await reads.run('row', async () => 2)).toBe(2);
        expect(await reads.run('row', async () => 3)).toBe(3);
    });
});
